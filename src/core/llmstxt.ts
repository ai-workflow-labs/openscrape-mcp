import { map } from './map.js';
import { scrape } from './scrape.js';
import { runPool, defaultConcurrency } from './util/pool.js';
import { log } from './util/log.js';

/**
 * `llms.txt` generation.
 *
 * The convention (llmstxt.org) is a single markdown file at a site's root that
 * tells a model what the site is and where its useful pages are: an H1 with the
 * site name, a blockquote summary, then sections of `- [title](url): notes`.
 *
 * We build it the free way: `map()` for the URL list, then a concurrent
 * `scrape()` of the top pages for their real titles and descriptions. No model
 * writes a word of it, which also means nothing in it is invented.
 */

export interface LlmsTxtOptions {
  /** Pages to include. Default 20. */
  limit?: number;
  /** Also build the expanded llms-full.txt (whole page text inline). */
  full?: boolean;
  /** Parallel scrapes. Defaults to the shared pool default. */
  concurrency?: number;
  /** Serve fetches from cache when younger than this (ms). Default 1 hour. */
  maxAge?: number;
  /** Bias URL selection toward this topic (passed to map's ranking). */
  search?: string;
  /** Per-page character cap inside llms-full.txt. Default 6000. */
  maxCharsPerPage?: number;
  /** Per-request timeout (ms). */
  timeout?: number;
  /** Override the H1 site name. */
  siteName?: string;
  /** Override the blockquote summary. */
  summary?: string;
  /**
   * Use sitemaps only. Without this, a site that publishes no sitemap is
   * discovered by crawling links, which costs dozens of extra requests.
   */
  sitemapOnly?: boolean;
}

export interface LlmsTxtPage {
  url: string;
  title: string;
  description: string;
  /** Section heading this page was filed under. */
  section: string;
  chars: number;
}

export interface LlmsTxtResult {
  url: string;
  siteName: string;
  summary: string;
  /** The short file. */
  llmstxt: string;
  /** The expanded file, when `full` was set. */
  llmsfull?: string;
  pages: LlmsTxtPage[];
  /** URLs map() found, before trimming to `limit`. */
  mapped: number;
  scraped: number;
  failed: { url: string; error: string }[];
  elapsedMs: number;
  warning?: string;
}

/** Paths that are never documentation: feeds, assets, pagination, auth. */
const NOISE = [
  /\.(?:xml|json|rss|atom|txt|css|js|png|jpe?g|gif|svg|webp|ico|pdf|zip|gz|mp4|woff2?)$/i,
  /\/(?:feed|rss|atom|sitemap[^/]*|wp-json|wp-admin|wp-content|cdn-cgi)\b/i,
  /\/(?:login|signin|signup|register|logout|cart|checkout|account|admin)\b/i,
  /\/(?:tag|tags|author|authors|category|categories)\//i,
  /[?&](?:page|p|paged)=\d+/i,
  /\/page\/\d+\/?$/i,
];

function isNoise(url: string): boolean {
  return NOISE.some((re) => re.test(url));
}

function depthOf(url: string): number {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, '');
    return path === '' ? 0 : path.split('/').filter(Boolean).length;
  } catch {
    return 9;
  }
}

const SECTION_LABELS: Record<string, string> = {
  docs: 'Documentation',
  doc: 'Documentation',
  documentation: 'Documentation',
  guide: 'Guides',
  guides: 'Guides',
  blog: 'Blog',
  news: 'News',
  posts: 'Blog',
  api: 'API reference',
  reference: 'Reference',
  pricing: 'Pricing',
  about: 'About',
  product: 'Product',
  products: 'Product',
  features: 'Product',
  support: 'Support',
  help: 'Support',
  faq: 'Support',
  legal: 'Legal',
  privacy: 'Legal',
  terms: 'Legal',
  changelog: 'Changelog',
  release: 'Changelog',
  releases: 'Changelog',
  examples: 'Examples',
  tutorial: 'Guides',
  tutorials: 'Guides',
};

function sectionFor(url: string, homeOrigin: string): string {
  try {
    const u = new URL(url);
    const segments = u.pathname.split('/').filter(Boolean);
    if (segments.length === 0) return 'Overview';
    if (segments.length === 1 && /^index\.html?$/i.test(segments[0])) return 'Overview';
    if (u.origin !== homeOrigin) return u.hostname;
    const first = segments[0].toLowerCase();
    const known = SECTION_LABELS[first];
    if (known) return known;
    if (segments.length === 1) return 'Pages';
    return first.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  } catch {
    return 'Pages';
  }
}

function oneLine(value: string, max = 200): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  return (lastStop > max * 0.5 ? cut.slice(0, lastStop + 1) : cut.trimEnd() + '…').trim();
}

/** First sentences of the page body, used when a page declares no description. */
function leadFromMarkdown(markdown: string): string {
  const prose = markdown
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return t && !t.startsWith('#') && !t.startsWith('|') && !t.startsWith('>') && !t.startsWith('- ') && !t.startsWith('```');
    })
    .join(' ');
  return oneLine(prose, 200);
}

function pickUrls(
  links: { url: string; title?: string }[],
  home: string,
  limit: number,
): { url: string; title?: string }[] {
  const kept: { url: string; title?: string; rank: number }[] = [];
  for (const link of links) {
    if (isNoise(link.url)) continue;
    // Shallow pages describe a site; deep ones are long-tail detail.
    kept.push({ ...link, rank: depthOf(link.url) });
  }

  kept.sort((a, b) => a.rank - b.rank || a.url.length - b.url.length);

  // Sites that serve `/core.html` and `/core.html.md` are offering one page in
  // two formats, and `/index.html` is the homepage again. Listing either twice
  // doubles the file and tells a reader nothing.
  const canonical = (url: string): string =>
    url
      .replace(/#.*$/, '')
      .replace(/\.md$/i, '')
      .replace(/(?:\/index)?\.html?$/i, '')
      .replace(/\/+$/, '');

  const seen = new Set<string>();
  const unique = kept.filter((link) => {
    const key = canonical(link.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const homeKey = canonical(home);
  const index = unique.findIndex((k) => canonical(k.url) === homeKey);
  if (index > 0) unique.unshift(...unique.splice(index, 1));
  else if (index === -1) unique.unshift({ url: home, rank: 0 });

  return unique.slice(0, limit).map(({ url, title }) => ({ url, title }));
}

export async function generateLlmsTxt(
  siteUrl: string,
  options: LlmsTxtOptions = {},
): Promise<LlmsTxtResult> {
  const started = Date.now();
  const limit = Math.max(1, options.limit ?? 20);
  const maxAge = options.maxAge ?? 3_600_000;
  const concurrency = options.concurrency ?? defaultConcurrency();
  const perPageChars = options.maxCharsPerPage ?? 6000;

  const home = new URL(siteUrl).toString();
  const homeOrigin = new URL(home).origin;

  const mapped = await map(home, {
    limit: Math.max(limit * 4, 40),
    search: options.search,
    maxAge,
    timeout: options.timeout,
    sitemapOnly: options.sitemapOnly,
  });

  const targets = pickUrls(mapped.links, home, limit);
  log.debug('llmstxt targets', { mapped: mapped.total, selected: targets.length });

  const failed: { url: string; error: string }[] = [];
  const fetched = await runPool(targets, concurrency, async (target) => {
    try {
      const result = await scrape(target.url, {
        formats: options.full ? ['markdown'] : ['markdown', 'summary'],
        onlyMainContent: true,
        maxAge,
        timeout: options.timeout,
        fitMarkdown: true,
      });
      if (!result.success) {
        failed.push({ url: target.url, error: result.error ?? `status ${result.metadata.statusCode}` });
        return null;
      }
      return { target, result };
    } catch (err) {
      failed.push({ url: target.url, error: String(err) });
      return null;
    }
  });

  const live = fetched.filter((f): f is NonNullable<typeof f> => f !== null);

  // `pickUrls` puts the homepage first, whatever it is actually called.
  const homePage =
    live.find((f) => f.target.url.replace(/\/+$/, '') === home.replace(/\/+$/, '')) ?? live[0];
  const siteName =
    options.siteName ??
    homePage?.result.metadata.siteName ??
    homePage?.result.metadata.title?.split(/\s+[|·—–-]\s+/).pop()?.trim() ??
    homePage?.result.metadata.title ??
    new URL(home).hostname;

  const summary =
    options.summary ??
    homePage?.result.metadata.description ??
    (homePage?.result.summary ? oneLine(homePage.result.summary, 300) : '') ??
    '';

  const pages: LlmsTxtPage[] = live.map(({ target, result }) => {
    const title =
      result.metadata.title?.replace(/\s+[|·—–-]\s+[^|·—–-]{0,40}$/, '').trim() ||
      target.title ||
      new URL(result.metadata.url).pathname;
    const description =
      result.metadata.description?.trim() ||
      (result.summary ? oneLine(result.summary) : '') ||
      (result.markdown ? leadFromMarkdown(result.markdown) : '');
    return {
      url: result.metadata.url,
      title: oneLine(title, 120),
      description: oneLine(description),
      section: sectionFor(result.metadata.url, homeOrigin),
      chars: result.markdown?.length ?? 0,
    };
  });

  // Overview first, then alphabetical; it reads like a table of contents.
  const bySection = new Map<string, LlmsTxtPage[]>();
  for (const page of pages) {
    const list = bySection.get(page.section);
    if (list) list.push(page);
    else bySection.set(page.section, [page]);
  }
  const sectionNames = [...bySection.keys()].sort((a, b) => {
    if (a === 'Overview') return -1;
    if (b === 'Overview') return 1;
    return a.localeCompare(b);
  });

  const head = [`# ${siteName}`, '', summary ? `> ${oneLine(summary, 400)}` : '> (no site description declared)'];

  const short: string[] = [...head];
  for (const name of sectionNames) {
    short.push('', `## ${name}`, '');
    for (const page of bySection.get(name) ?? []) {
      short.push(`- [${page.title}](${page.url})${page.description ? `: ${page.description}` : ''}`);
    }
  }
  short.push('');

  let llmsfull: string | undefined;
  if (options.full) {
    const chunks: string[] = [...head, ''];
    for (const name of sectionNames) {
      chunks.push(`## ${name}`, '');
      for (const page of bySection.get(name) ?? []) {
        const entry = live.find((l) => l.result.metadata.url === page.url);
        let body = entry?.result.markdown ?? '';
        if (body.length > perPageChars) {
          body = body.slice(0, perPageChars).trimEnd() + `\n\n_[truncated ${body.length - perPageChars} chars]_`;
        }
        chunks.push(`### ${page.title}`, '', `Source: <${page.url}>`, '', body.trim(), '');
      }
    }
    llmsfull = chunks.join('\n');
  }

  const warnings: string[] = [];
  if (mapped.warning) warnings.push(mapped.warning);
  if (failed.length) warnings.push(`${failed.length} of ${targets.length} page(s) could not be fetched.`);
  if (!summary) warnings.push('The homepage declares no description, so the summary line is empty.');

  return {
    url: home,
    siteName,
    summary,
    llmstxt: short.join('\n'),
    llmsfull,
    pages,
    mapped: mapped.total,
    scraped: live.length,
    failed,
    elapsedMs: Date.now() - started,
    warning: warnings.length ? warnings.join(' ') : undefined,
  };
}
