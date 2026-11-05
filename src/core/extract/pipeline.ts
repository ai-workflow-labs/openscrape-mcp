import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import { htmlToMarkdown, markdownToText, tidy } from './markdown.js';
import { extractStructured, type StructuredData } from './structured.js';
import { absolutize } from '../util/url.js';
import { collectSeoSignals, simhash, type SeoSignals } from '../seo/signals.js';
import { log } from '../util/log.js';
import type { PageMetadata, ScrapeOptions } from '../types.js';

/** Elements that are never page content. Removed before anything else runs. */
const ALWAYS_DROP = [
  'script',
  'style',
  'noscript',
  'template',
  'iframe',
  'object',
  'embed',
  'link',
  'svg use',
];

/** Chrome that Readability sometimes keeps. Dropped only for onlyMainContent. */
const BOILERPLATE = [
  'nav',
  'header',
  'footer',
  'aside',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[role="complementary"]',
  '[aria-hidden="true"]',
  '.advertisement',
  '.ad-container',
  '[id*="cookie" i]',
  '[class*="cookie-banner" i]',
  '[class*="cookie-consent" i]',
  '[class*="newsletter-signup" i]',
  '[class*="social-share" i]',
  '[class*="breadcrumb" i]',
  '[class*="sidebar" i]',
  '[class*="related-post" i]',
  '[class*="skip-link" i]',
];

export interface ExtractedPage {
  markdown: string;
  text: string;
  /** Cleaned HTML of the content we kept. */
  html: string;
  links: string[];
  images: string[];
  summary: string;
  structured: StructuredData;
  metadataPatch: Partial<PageMetadata>;
  /** Readability's own title/byline/excerpt, when it found an article. */
  articleTitle?: string;
  /** Raw SEO signals, only when `collectSeo` was asked for. */
  seo?: SeoSignals;
}

export function extractFromHtml(
  rawHtml: string,
  baseUrl: string,
  opts: ScrapeOptions = {},
): ExtractedPage {
  const onlyMain = opts.onlyMainContent !== false;
  const $ = cheerio.load(rawHtml);

  // A <base href> changes what every relative URL on the page means.
  const declaredBase = $('base[href]').first().attr('href');
  const effectiveBase = declaredBase ? (absolutize(declaredBase, baseUrl) ?? baseUrl) : baseUrl;

  // Collect links and images from the FULL document before we narrow anything.
  const links = collectLinks($, effectiveBase);
  const images = collectImages($, effectiveBase);
  const structured = extractStructured($, effectiveBase);
  const metadataPatch = buildMetadata($, structured, effectiveBase);

  // Read off the FULL document, before boilerplate is stripped: a canonical
  // tag or an hreflang set lives in <head>, which onlyMainContent removes.
  const seo = opts.collectSeo ? collectSeoSignals($, effectiveBase, '') : undefined;

  // Make every surviving URL absolute so the markdown is portable.
  absolutizeInPlace($, effectiveBase);

  $(ALWAYS_DROP.join(',')).remove();
  $('*')
    .contents()
    .filter((_i, node) => node.type === 'comment')
    .remove();

  normalizeTables($);

  if (opts.includeTags?.length) {
    const kept = $(opts.includeTags.join(',')).toArray();
    const wrapper = cheerio.load('<div id="openscrape-root"></div>');
    for (const el of kept) wrapper('#openscrape-root').append($.html(el));
    return finish(wrapper.html('#openscrape-root') ?? '', {
      links,
      images,
      structured,
      metadataPatch,
      opts,
      seo,
    });
  }

  if (opts.excludeTags?.length) {
    for (const sel of opts.excludeTags) {
      try {
        $(sel).remove();
      } catch {
        log.warn('bad excludeTags selector', sel);
      }
    }
  }

  if (!onlyMain) {
    return finish($('body').html() ?? $.html(), {
      links,
      images,
      structured,
      metadataPatch,
      opts,
      seo,
    });
  }

  // Readability first: it is the best general-purpose article extractor.
  const readable = runReadability($.html(), effectiveBase);
  if (readable && countText(readable.content) > 180) {
    return finish(readable.content, {
      links,
      images,
      structured,
      metadataPatch,
      opts,
      seo,
      articleTitle: readable.title,
    });
  }

  // Fallback: strip known boilerplate and keep the densest container.
  for (const sel of BOILERPLATE) {
    try {
      $(sel).remove();
    } catch {
      /* selector unsupported by cheerio, skip */
    }
  }
  const candidate =
    pickDensest($, ['main', 'article', '[role="main"]', '#content', '.content', '#main']) ??
    $('body').html() ??
    $.html();

  return finish(candidate, { links, images, structured, metadataPatch, opts, seo });
}

interface FinishCtx {
  links: string[];
  images: string[];
  structured: StructuredData;
  metadataPatch: Partial<PageMetadata>;
  opts: ScrapeOptions;
  articleTitle?: string;
  seo?: SeoSignals;
}

function finish(contentHtml: string, ctx: FinishCtx): ExtractedPage {
  const markdown = htmlToMarkdown(contentHtml);
  const text = markdownToText(markdown);

  // The head signals were read off the full document before anything was
  // stripped; word count and the duplicate fingerprint can only be known once
  // the content has actually been narrowed, so they are filled in here.
  if (ctx.seo) {
    ctx.seo.wordCount = (text.match(/[^\s]+/g) ?? []).length;
    ctx.seo.simhash = simhash(text);
  }

  return {
    markdown,
    text,
    html: tidyHtml(contentHtml),
    links: ctx.links,
    images: ctx.images,
    summary: buildSummary(text, ctx.structured, ctx.metadataPatch),
    structured: ctx.structured,
    metadataPatch: ctx.metadataPatch,
    articleTitle: ctx.articleTitle,
    seo: ctx.seo,
  };
}

function runReadability(
  html: string,
  baseUrl: string,
): { title: string; content: string; excerpt: string; byline: string } | null {
  try {
    const { document } = parseHTML(html);
    // Readability resolves relative URLs against documentURI.
    try {
      Object.defineProperty(document, 'documentURI', { value: baseUrl, configurable: true });
      Object.defineProperty(document, 'baseURI', { value: baseUrl, configurable: true });
    } catch {
      /* linkedom version without configurable URI; links are already absolute */
    }
    const reader = new Readability(document as unknown as Document, {
      charThreshold: 180,
      keepClasses: false,
      nbTopCandidates: 8,
    });
    const article = reader.parse();
    if (!article?.content) return null;
    return {
      title: article.title ?? '',
      content: article.content,
      excerpt: article.excerpt ?? '',
      byline: article.byline ?? '',
    };
  } catch (err) {
    log.debug('readability failed', String(err));
    return null;
  }
}

function collectLinks($: cheerio.CheerioAPI, baseUrl: string): string[] {
  const seen = new Set<string>();
  $('a[href]').each((_i, el) => {
    const abs = absolutize($(el).attr('href'), baseUrl);
    if (abs) seen.add(abs);
  });
  return [...seen];
}

function collectImages($: cheerio.CheerioAPI, baseUrl: string): string[] {
  const seen = new Set<string>();
  $('img').each((_i, el) => {
    const $el = $(el);
    const direct = $el.attr('src') ?? $el.attr('data-src') ?? $el.attr('data-lazy-src');
    const abs = absolutize(direct, baseUrl);
    if (abs && !abs.startsWith('data:')) seen.add(abs);

    const srcset = $el.attr('srcset') ?? $el.attr('data-srcset');
    if (srcset) {
      for (const part of srcset.split(',')) {
        const candidate = absolutize(part.trim().split(/\s+/)[0], baseUrl);
        if (candidate && !candidate.startsWith('data:')) seen.add(candidate);
      }
    }
  });
  $('source[srcset]').each((_i, el) => {
    for (const part of ($(el).attr('srcset') ?? '').split(',')) {
      const candidate = absolutize(part.trim().split(/\s+/)[0], baseUrl);
      if (candidate) seen.add(candidate);
    }
  });
  return [...seen];
}

function absolutizeInPlace($: cheerio.CheerioAPI, baseUrl: string): void {
  $('a[href]').each((_i, el) => {
    const abs = absolutize($(el).attr('href'), baseUrl);
    if (abs) $(el).attr('href', abs);
  });
  $('img[src]').each((_i, el) => {
    const abs = absolutize($(el).attr('src'), baseUrl);
    if (abs) $(el).attr('src', abs);
  });
  $('img[data-src]').each((_i, el) => {
    const $el = $(el);
    if (!$el.attr('src')) {
      const abs = absolutize($el.attr('data-src'), baseUrl);
      if (abs) $el.attr('src', abs);
    }
  });
}

function buildMetadata(
  $: cheerio.CheerioAPI,
  structured: StructuredData,
  baseUrl: string,
): Partial<PageMetadata> {
  const m = structured.merged;
  const keywords = structured.meta.keywords
    ?.split(',')
    .map((k) => k.trim())
    .filter(Boolean);

  return {
    title: (m.title as string) || $('title').first().text().trim() || undefined,
    description: (m.description as string) || undefined,
    language:
      $('html').attr('lang')?.trim() ||
      structured.meta['content-language'] ||
      structured.openGraph.locale ||
      undefined,
    canonical: absolutize($('link[rel="canonical"]').attr('href'), baseUrl) ?? undefined,
    author: (m.author as string) || undefined,
    publishedTime: (m.publishedTime as string) || undefined,
    modifiedTime: (m.modifiedTime as string) || undefined,
    siteName: (m.siteName as string) || undefined,
    favicon:
      absolutize(
        $('link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]')
          .first()
          .attr('href'),
        baseUrl,
      ) ?? absolutize('/favicon.ico', baseUrl) ?? undefined,
    ogImage: (m.image as string) || undefined,
    keywords: keywords?.length ? keywords : undefined,
  };
}

/**
 * Extractive summary built with term-frequency scoring. Not an LLM, costs
 * nothing, and reliably beats "first 200 characters".
 */
function buildSummary(
  text: string,
  structured: StructuredData,
  meta: Partial<PageMetadata>,
): string {
  const description = (meta.description ?? '').trim();
  const body = text.trim();
  if (!body) return description;

  const sentences = body
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 40 && s.length <= 400);

  if (sentences.length === 0) {
    return description || body.slice(0, 400);
  }

  const stop = new Set(
    'the a an and or but if then than that this these those of to in on at for with by from as is are was were be been being it its their his her our your you we they he she i not no so such also may can will would could should about into over under more most other some any each'.split(
      ' ',
    ),
  );
  const freq = new Map<string, number>();
  for (const word of body.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? []) {
    if (stop.has(word)) continue;
    freq.set(word, (freq.get(word) ?? 0) + 1);
  }

  const scored = sentences.map((sentence, index) => {
    const words = sentence.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? [];
    const score = words.reduce((sum, w) => sum + (freq.get(w) ?? 0), 0) / Math.max(words.length, 1);
    // Mild bias toward the opening, where the thesis usually lives.
    const positionBoost = index < 3 ? 1.25 : 1;
    return { sentence, index, score: score * positionBoost };
  });

  const picked = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .sort((a, b) => a.index - b.index)
    .map((s) => s.sentence);

  const summary = picked.join(' ');
  const prefix = description && !summary.startsWith(description) ? description + ' ' : '';
  return tidy((prefix + summary).slice(0, 1200));
}

function pickDensest($: cheerio.CheerioAPI, selectors: string[]): string | null {
  const candidates: { html: string; score: number }[] = [];
  for (const sel of selectors) {
    $(sel).each((_i, el) => {
      const html = $.html(el);
      candidates.push({ html, score: countText(html) });
    });
  }
  if (candidates.length === 0) return null;
  const best = candidates.reduce((a, b) => (b.score > a.score ? b : a));
  return best.score > 120 ? best.html : null;
}


/**
 * Turndown's GFM plugin only converts tables that have a real header row.
 * Everything else falls through and lands in the markdown as raw HTML, which
 * is exactly what happens on sites that still use tables for layout (Hacker
 * News, older forums, most email-style pages). We flatten those into plain
 * blocks here and leave genuine data tables for the GFM converter.
 */
function normalizeTables($: cheerio.CheerioAPI): void {
  for (let pass = 0; pass < 10; pass++) {
    const leaves = $('table')
      .toArray()
      .filter((el) => $(el).find('table').length === 0 && isLayoutTable($, el));
    if (leaves.length === 0) break;
    for (const el of leaves) flattenTable($, el);
  }
}

function isLayoutTable($: cheerio.CheerioAPI, el: Element): boolean {
  const $t = $(el);
  if (($t.attr('role') ?? '').toLowerCase() === 'presentation') return true;
  if ($t.find('th').length > 0) return false;

  const rows = $t.find('tr').toArray();
  if (rows.length < 3) return true;

  const counts = rows.map((tr) => $(tr).children('td,th').length);
  const widest = Math.max(...counts);
  if (widest < 2) return true;

  // A real data table keeps a steady number of columns.
  const consistent = counts.filter((c) => c === widest).length >= Math.ceil(rows.length * 0.7);
  return !consistent;
}

function flattenTable($: cheerio.CheerioAPI, el: Element): void {
  const $t = $(el);
  const blocks: string[] = [];

  $t.find('tr').each((_i, tr) => {
    const cells = $(tr)
      .children('td,th')
      .toArray()
      .map((td) => ($(td).html() ?? '').trim())
      .filter((html) => html && html.replace(/<[^>]*>/g, '').trim() !== '');
    if (cells.length) blocks.push('<p>' + cells.join(' ') + '</p>');
  });

  if (blocks.length === 0) {
    const inner = ($t.html() ?? '').trim();
    $t.replaceWith(inner ? '<div>' + inner + '</div>' : '');
    return;
  }
  $t.replaceWith('<div>' + blocks.join('') + '</div>');
}

function countText(html: string): number {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().length;
}

function tidyHtml(html: string): string {
  return html.replace(/\n{3,}/g, '\n\n').trim();
}
