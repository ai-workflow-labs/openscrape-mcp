import { gunzipSync } from 'node:zlib';
import { XMLParser } from 'fast-xml-parser';
import { httpFetch } from '../fetcher/http.js';
import { getRobots } from './robots.js';
import { absolutize, normalizeUrl, originOf } from '../util/url.js';
import { log } from '../util/log.js';

/**
 * Sitemap discovery and parsing.
 *
 * This is the cheapest URL discovery there is: one or two requests can reveal
 * every page a site wants found, with no crawling at all. Firecrawl charges a
 * credit per `map` call for the same thing.
 */
export interface SitemapEntry {
  url: string;
  lastModified?: string;
  changeFrequency?: string;
  priority?: number;
}

export interface SitemapHarvest {
  entries: SitemapEntry[];
  /** Sitemap documents actually fetched. */
  sitemapsFetched: string[];
  /** Sitemaps we found but did not open, because a limit was reached. */
  skipped: string[];
  robotsMissing: boolean;
}

/** Conventional locations to try when robots.txt advertises nothing. */
const GUESSES = [
  '/sitemap.xml',
  '/sitemap_index.xml',
  '/sitemap-index.xml',
  '/sitemap/sitemap.xml',
  '/wp-sitemap.xml',
  '/sitemap.xml.gz',
];

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  trimValues: true,
  parseTagValue: false,
});

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (value && typeof value === 'object' && '#text' in value) {
    const t = (value as { '#text': unknown })['#text'];
    return typeof t === 'string' ? t.trim() || undefined : undefined;
  }
  return undefined;
}

function maybeGunzip(body: Buffer, url: string, contentType: string): Buffer {
  const looksGzipped =
    url.endsWith('.gz') ||
    contentType.includes('gzip') ||
    (body.length > 2 && body[0] === 0x1f && body[1] === 0x8b);
  if (!looksGzipped) return body;
  try {
    return gunzipSync(body);
  } catch {
    return body;
  }
}

interface ParsedSitemap {
  entries: SitemapEntry[];
  children: string[];
}

function parseSitemapXml(xml: string, baseUrl: string): ParsedSitemap {
  const entries: SitemapEntry[] = [];
  const children: string[] = [];

  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch (err) {
    log.debug('sitemap parse failed', { baseUrl, error: String(err) });
    return { entries, children };
  }

  const index = doc.sitemapindex as Record<string, unknown> | undefined;
  if (index) {
    for (const node of asArray(index.sitemap as Record<string, unknown>[])) {
      const loc = absolutize(textOf(node?.loc), baseUrl);
      if (loc) children.push(loc);
    }
  }

  const urlset = doc.urlset as Record<string, unknown> | undefined;
  if (urlset) {
    for (const node of asArray(urlset.url as Record<string, unknown>[])) {
      const loc = absolutize(textOf(node?.loc), baseUrl);
      if (!loc) continue;
      const priorityText = textOf(node?.priority);
      entries.push({
        url: loc,
        lastModified: textOf(node?.lastmod),
        changeFrequency: textOf(node?.changefreq),
        priority: priorityText ? Number(priorityText) : undefined,
      });
    }
  }

  // Some sites serve a plain-text sitemap despite the .xml name.
  if (entries.length === 0 && children.length === 0 && !/^\s*</.test(xml)) {
    for (const line of xml.split('\n')) {
      const candidate = absolutize(line.trim(), baseUrl);
      if (candidate) entries.push({ url: candidate });
    }
  }

  return { entries, children };
}

export interface HarvestOptions {
  /** Stop after this many URLs. Default 5000. */
  limit?: number;
  /** Stop after opening this many sitemap documents. Default 50. */
  maxSitemaps?: number;
  /** Per-request timeout. */
  timeout?: number;
  /** Try the conventional paths even when robots.txt lists sitemaps. Default true. */
  tryGuesses?: boolean;
}

/** Walks a site's sitemaps, following sitemap indexes, and returns every URL. */
export async function harvestSitemaps(
  siteUrl: string,
  opts: HarvestOptions = {},
): Promise<SitemapHarvest> {
  const limit = opts.limit ?? 5000;
  const maxSitemaps = opts.maxSitemaps ?? 50;
  const timeout = opts.timeout ?? 15_000;

  const origin = originOf(siteUrl);
  const robots = await getRobots(siteUrl, timeout);

  const queue: string[] = [...robots.sitemaps];
  if (opts.tryGuesses !== false) {
    for (const path of GUESSES) {
      const guess = origin + path;
      if (!queue.includes(guess)) queue.push(guess);
    }
  }

  const seenSitemaps = new Set<string>();
  const seenUrls = new Set<string>();
  const entries: SitemapEntry[] = [];
  const fetched: string[] = [];
  const skipped: string[] = [];

  while (queue.length > 0) {
    if (entries.length >= limit || fetched.length >= maxSitemaps) {
      skipped.push(...queue.splice(0));
      break;
    }

    const next = queue.shift();
    if (!next) break;
    let key: string;
    try {
      key = normalizeUrl(next);
    } catch {
      continue;
    }
    if (seenSitemaps.has(key)) continue;
    seenSitemaps.add(key);

    let page;
    try {
      page = await httpFetch(next, { timeout });
    } catch (err) {
      log.debug('sitemap fetch failed', { url: next, error: String(err) });
      continue;
    }
    if (page.status >= 400 || page.body.byteLength === 0) continue;

    const xml = maybeGunzip(page.body, next, page.contentType).toString('utf8');
    const parsed = parseSitemapXml(xml, page.finalUrl || next);
    if (parsed.entries.length === 0 && parsed.children.length === 0) continue;

    fetched.push(next);

    for (const entry of parsed.entries) {
      let norm: string;
      try {
        norm = normalizeUrl(entry.url);
      } catch {
        continue;
      }
      if (seenUrls.has(norm)) continue;
      seenUrls.add(norm);
      entries.push({ ...entry, url: norm });
      if (entries.length >= limit) break;
    }

    for (const child of parsed.children) {
      if (!seenSitemaps.has(child)) queue.push(child);
    }
  }

  log.debug('sitemap harvest', {
    siteUrl,
    urls: entries.length,
    sitemaps: fetched.length,
    skipped: skipped.length,
  });

  return { entries, sitemapsFetched: fetched, skipped, robotsMissing: robots.missing };
}
