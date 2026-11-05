import type { CheerioAPI } from 'cheerio';
import { absolutize } from '../util/url.js';

/**
 * Free structured extraction. Before spending a single LLM token we mine what
 * the page already declares about itself: JSON-LD, microdata, OpenGraph,
 * Twitter cards and plain meta tags. For products, articles, jobs, recipes,
 * events and reviews this is both cheaper and more accurate than an LLM.
 */
export interface StructuredData {
  jsonLd: unknown[];
  microdata: Record<string, unknown>[];
  openGraph: Record<string, string>;
  twitter: Record<string, string>;
  meta: Record<string, string>;
  /** Best-effort merged view, keyed by the most useful fields. */
  merged: Record<string, unknown>;
}

function parseJsonLd($: CheerioAPI): unknown[] {
  const out: unknown[] = [];
  $('script[type="application/ld+json"]').each((_i, el) => {
    const raw = $(el).text().trim();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) out.push(...parsed);
      else if (parsed && typeof parsed === 'object' && '@graph' in parsed) {
        const graph = (parsed as { '@graph': unknown })['@graph'];
        if (Array.isArray(graph)) out.push(...graph);
        else out.push(parsed);
      } else out.push(parsed);
    } catch {
      // Some sites emit JSON-LD with trailing commas or HTML comments.
      try {
        const cleaned = raw
          .replace(/<!--[\s\S]*?-->/g, '')
          .replace(/,\s*([}\]])/g, '$1');
        out.push(JSON.parse(cleaned));
      } catch {
        /* give up on this block */
      }
    }
  });
  return out;
}

function parseMicrodata($: CheerioAPI, baseUrl: string): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  $('[itemscope]').each((_i, scope) => {
    const $scope = $(scope);
    // Only top-level scopes; nested ones are picked up as properties.
    if ($scope.parents('[itemscope]').length > 0) return;
    const item: Record<string, unknown> = {};
    const type = $scope.attr('itemtype');
    if (type) item['@type'] = type.split('/').pop();

    $scope.find('[itemprop]').each((_j, prop) => {
      const $prop = $(prop);
      const name = $prop.attr('itemprop');
      if (!name) return;
      const tag = (prop as { tagName?: string }).tagName?.toLowerCase();
      let value: string | null | undefined;
      if (tag === 'meta') value = $prop.attr('content');
      else if (tag === 'img') value = absolutize($prop.attr('src'), baseUrl);
      else if (tag === 'a' || tag === 'link') value = absolutize($prop.attr('href'), baseUrl);
      else if (tag === 'time') value = $prop.attr('datetime') ?? $prop.text().trim();
      else value = $prop.attr('content') ?? $prop.text().trim();
      if (!value) return;
      if (name in item) {
        const existing = item[name];
        item[name] = Array.isArray(existing) ? [...existing, value] : [existing, value];
      } else {
        item[name] = value;
      }
    });

    if (Object.keys(item).length > 1) items.push(item);
  });
  return items;
}

function firstJsonLdOfType(jsonLd: unknown[], types: string[]): Record<string, unknown> | null {
  for (const node of jsonLd) {
    if (!node || typeof node !== 'object') continue;
    const rec = node as Record<string, unknown>;
    const t = rec['@type'];
    const list = Array.isArray(t) ? t.map(String) : [String(t ?? '')];
    if (list.some((x) => types.includes(x))) return rec;
  }
  return null;
}

export function extractStructured($: CheerioAPI, baseUrl: string): StructuredData {
  const openGraph: Record<string, string> = {};
  const twitter: Record<string, string> = {};
  const meta: Record<string, string> = {};

  $('meta').each((_i, el) => {
    const $el = $(el);
    const content = $el.attr('content');
    if (!content) return;
    const property = $el.attr('property')?.toLowerCase();
    const name = $el.attr('name')?.toLowerCase();

    if (property?.startsWith('og:')) openGraph[property.slice(3)] = content;
    else if (property?.startsWith('article:')) openGraph[property] = content;
    else if (name?.startsWith('twitter:')) twitter[name.slice(8)] = content;
    else if (name) meta[name] = content;
    else if (property) meta[property] = content;
  });

  const jsonLd = parseJsonLd($);
  const microdata = parseMicrodata($, baseUrl);

  const article = firstJsonLdOfType(jsonLd, [
    'Article',
    'NewsArticle',
    'BlogPosting',
    'TechArticle',
    'Report',
  ]);
  const product = firstJsonLdOfType(jsonLd, ['Product', 'ProductGroup']);
  const org = firstJsonLdOfType(jsonLd, ['Organization', 'LocalBusiness', 'Corporation']);

  const merged: Record<string, unknown> = {};
  const put = (key: string, value: unknown) => {
    if (value === undefined || value === null || value === '') return;
    if (merged[key] === undefined) merged[key] = value;
  };

  put(
    'title',
    openGraph.title ||
      twitter.title ||
      $('title').first().text().trim() ||
      article?.headline ||
      product?.name,
  );
  put(
    'description',
    openGraph.description ||
      twitter.description ||
      meta.description ||
      article?.description ||
      product?.description,
  );
  put('type', openGraph.type ?? (article ? 'article' : product ? 'product' : undefined));
  put('image', absolutize(String(openGraph.image ?? twitter.image ?? ''), baseUrl) ?? undefined);
  put('siteName', openGraph.site_name ?? org?.name);
  put('publishedTime', article?.datePublished ?? openGraph['article:published_time'] ?? meta['date']);
  put('modifiedTime', article?.dateModified ?? openGraph['article:modified_time']);
  put('author', authorName(article?.author) ?? meta.author ?? openGraph['article:author']);

  if (product) {
    const offers = Array.isArray(product.offers) ? product.offers[0] : product.offers;
    const offer = (offers ?? {}) as Record<string, unknown>;
    put('price', offer.price ?? offer.lowPrice);
    put('currency', offer.priceCurrency);
    put('availability', typeof offer.availability === 'string' ? offer.availability.split('/').pop() : undefined);
    put('sku', product.sku ?? product.gtin13 ?? product.mpn);
    put('brand', typeof product.brand === 'object' ? (product.brand as Record<string, unknown>)?.name : product.brand);
    const rating = product.aggregateRating as Record<string, unknown> | undefined;
    put('rating', rating?.ratingValue);
    put('reviewCount', rating?.reviewCount ?? rating?.ratingCount);
  }

  return { jsonLd, microdata, openGraph, twitter, meta, merged };
}

function authorName(author: unknown): string | undefined {
  if (!author) return undefined;
  if (typeof author === 'string') return author;
  if (Array.isArray(author)) return author.map(authorName).filter(Boolean).join(', ') || undefined;
  if (typeof author === 'object') {
    const name = (author as Record<string, unknown>).name;
    return typeof name === 'string' ? name : undefined;
  }
  return undefined;
}
