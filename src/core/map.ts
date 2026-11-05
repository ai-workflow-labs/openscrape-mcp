import * as cheerio from 'cheerio';
import { harvestSitemaps, type SitemapEntry } from './discover/sitemap.js';
import { getRobots } from './discover/robots.js';
import { makeScope, queryTerms, scoreUrl, type ScopeOptions } from './discover/scope.js';
import { fetchPage } from './fetcher/index.js';
import { absolutize, normalizeUrl } from './util/url.js';
import { runPool, defaultConcurrency } from './util/pool.js';
import { log } from './util/log.js';

/**
 * `map`: list a site's URLs fast.
 *
 * Sitemaps first, because one request can reveal thousands of pages. Only when
 * that comes back thin do we actually crawl links, and then only a couple of
 * levels deep. Firecrawl bills a credit per call for this; here it is two or
 * three HTTP requests.
 */
export interface MapOptions extends Omit<ScopeOptions, 'root'> {
  /** Maximum URLs to return. Default 2000. */
  limit?: number;
  /** Rank and filter results by relevance to this text. */
  search?: string;
  /** Skip sitemaps and discover by following links instead. */
  ignoreSitemap?: boolean;
  /** Use sitemaps only; never follow links. */
  sitemapOnly?: boolean;
  /** How deep to follow links when crawling for discovery. Default 2. */
  maxDepth?: number;
  /** Pages to fetch per level while discovering. Default 25. */
  pagesPerLevel?: number;
  concurrency?: number;
  timeout?: number;
  /** Respect robots.txt. Default true. */
  respectRobots?: boolean;
  /** Serve discovery fetches from cache when younger than this (ms). */
  maxAge?: number;
}

export interface MappedLink {
  url: string;
  title?: string;
  lastModified?: string;
  /** Relevance score when `search` was given. */
  score?: number;
  source: 'sitemap' | 'links';
}

export interface MapResult {
  url: string;
  links: MappedLink[];
  total: number;
  /** Where the URLs came from. */
  sources: {
    sitemapUrls: number;
    sitemapsFetched: number;
    crawledPages: number;
    linkUrls: number;
  };
  robotsMissing: boolean;
  elapsedMs: number;
  warning?: string;
}

interface Discovered {
  url: string;
  title?: string;
  lastModified?: string;
  source: 'sitemap' | 'links';
}

/** Pull links and the page title out of raw HTML without the full extraction pass. */
function linksFromHtml(html: string, baseUrl: string): { links: { url: string; text: string }[]; title?: string } {
  const $ = cheerio.load(html);
  const declaredBase = $('base[href]').first().attr('href');
  const base = declaredBase ? (absolutize(declaredBase, baseUrl) ?? baseUrl) : baseUrl;

  const seen = new Map<string, string>();
  $('a[href]').each((_i, el) => {
    const abs = absolutize($(el).attr('href'), base);
    if (!abs) return;
    const text = $(el).text().replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!seen.has(abs) || (!seen.get(abs) && text)) seen.set(abs, text);
  });

  return {
    links: [...seen].map(([url, text]) => ({ url, text })),
    title: $('title').first().text().trim() || undefined,
  };
}

export async function map(siteUrl: string, options: MapOptions = {}): Promise<MapResult> {
  const started = Date.now();
  const limit = options.limit ?? 2000;
  const maxDepth = options.maxDepth ?? 2;
  const pagesPerLevel = options.pagesPerLevel ?? 25;
  const concurrency = options.concurrency ?? defaultConcurrency();
  const timeout = options.timeout ?? 20_000;
  const respectRobots = options.respectRobots !== false;

  const scope = makeScope({ ...options, root: siteUrl });
  const robots = respectRobots ? await getRobots(siteUrl, timeout) : null;

  const found = new Map<string, Discovered>();
  const warnings: string[] = [];
  let sitemapsFetched = 0;
  let sitemapUrls = 0;
  let crawledPages = 0;

  // Discovery is capped independently of `limit`: we want a large pool to rank
  // against even when the caller only wants the top 15 URLs back.
  const discoveryCap = Math.max(limit * 5, 10_000);
  let capHit = false;

  const add = (entry: Discovered): void => {
    if (found.size >= discoveryCap) {
      capHit = true;
      return;
    }
    let norm: string;
    try {
      norm = normalizeUrl(entry.url);
    } catch {
      return;
    }
    if (found.has(norm)) return;
    if (!scope.inScope(norm).ok) return;
    if (robots && !robots.isAllowed(norm)) return;
    found.set(norm, { ...entry, url: norm });
  };

  // ---- 1. Sitemaps -------------------------------------------------
  if (!options.ignoreSitemap) {
    try {
      const harvest = await harvestSitemaps(siteUrl, {
        limit: Math.max(limit * 5, 5000),
        timeout,
      });
      sitemapsFetched = harvest.sitemapsFetched.length;
      sitemapUrls = harvest.entries.length;
      for (const entry of harvest.entries as SitemapEntry[]) {
        add({ url: entry.url, lastModified: entry.lastModified, source: 'sitemap' });
      }
      if (harvest.skipped.length) {
        warnings.push(`${harvest.skipped.length} sitemap(s) were not opened because a limit was reached.`);
      }
    } catch (err) {
      warnings.push(`Sitemap discovery failed: ${String(err)}`);
    }
  }

  // ---- 2. Link discovery ------------------------------------------
  const needsCrawl = !options.sitemapOnly && (options.ignoreSitemap || found.size < 10);
  if (needsCrawl) {
    const terms = options.search ? queryTerms(options.search) : [];
    let frontier: { url: string; text: string }[] = [{ url: siteUrl, text: '' }];
    const visited = new Set<string>();

    for (let depth = 0; depth <= maxDepth && frontier.length > 0; depth++) {
      // Prefer the most promising links when a search term narrows the intent.
      const batch = (
        terms.length
          ? [...frontier].sort((a, b) => scoreUrl(b.url, terms, b.text) - scoreUrl(a.url, terms, a.text))
          : frontier
      ).slice(0, pagesPerLevel);

      const nextFrontier: { url: string; text: string }[] = [];

      await runPool(batch, concurrency, async (item) => {
        let norm: string;
        try {
          norm = normalizeUrl(item.url);
        } catch {
          return;
        }
        if (visited.has(norm)) return;
        visited.add(norm);
        if (robots && !robots.isAllowed(norm)) return;

        try {
          const outcome = await fetchPage(item.url, {
            render: 'auto',
            timeout,
            maxAge: options.maxAge ?? 0,
            formats: ['links'],
          });
          crawledPages++;
          if (outcome.page.status >= 400) return;
          if (!/html|xml|^$/i.test(outcome.page.contentType)) return;

          const html = outcome.page.body.toString('utf8');
          const { links, title } = linksFromHtml(html, outcome.page.finalUrl || item.url);

          add({ url: outcome.page.finalUrl || item.url, title, source: 'links' });
          for (const link of links) {
            add({ url: link.url, title: link.text || undefined, source: 'links' });
            if (depth < maxDepth) nextFrontier.push(link);
          }
        } catch (err) {
          log.debug('map fetch failed', { url: item.url, error: String(err) });
        }
      });

      frontier = nextFrontier.filter((l) => {
        try {
          return !visited.has(normalizeUrl(l.url)) && scope.inScope(l.url).ok;
        } catch {
          return false;
        }
      });
    }
  }

  // ---- 3. Rank and cut --------------------------------------------
  let links: MappedLink[] = [...found.values()].map((d) => ({
    url: d.url,
    title: d.title,
    lastModified: d.lastModified,
    source: d.source,
  }));

  if (options.search) {
    const terms = queryTerms(options.search);
    links = links
      .map((l) => ({ ...l, score: scoreUrl(l.url, terms, l.title) }))
      .filter((l) => (l.score ?? 0) > 0)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  } else {
    // Shortest paths first: a stable, useful default ordering.
    links.sort((a, b) => a.url.length - b.url.length || a.url.localeCompare(b.url));
  }

  const total = links.length;
  links = links.slice(0, limit);

  if (capHit) {
    warnings.push(
      `Discovery stopped at ${discoveryCap} URLs. Raise "limit" to widen the pool.`,
    );
  }

  if (total === 0) {
    warnings.push(
      'No URLs were discovered. The site may block automated requests, or require JavaScript for navigation (try ignoreSitemap:false and a higher maxDepth).',
    );
  }

  return {
    url: siteUrl,
    links,
    total,
    sources: {
      sitemapUrls,
      sitemapsFetched,
      crawledPages,
      linkUrls: [...found.values()].filter((d) => d.source === 'links').length,
    },
    robotsMissing: robots?.missing ?? true,
    elapsedMs: Date.now() - started,
    warning: warnings.length ? warnings.join(' ') : undefined,
  };
}
