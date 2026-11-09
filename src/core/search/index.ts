import { scrape } from '../scrape.js';
import { normalizeUrl } from '../util/url.js';
import { runPool, defaultConcurrency } from '../util/pool.js';
import { log } from '../util/log.js';
import type { ScrapeOptions, ScrapeResult } from '../types.js';
import { searxngSearch, searxngStatus } from './searxng.js';
import { braveSearch, braveStatus } from './brave.js';
import { duckduckgoSearch, duckduckgoStatus } from './duckduckgo.js';
import { mojeekSearch, mojeekStatus } from './mojeek.js';

/**
 * `search`: a web search endpoint that costs nothing.
 *
 * Firecrawl bills 2 credits per 10 results. The same answer is available for
 * free three different ways, so instead of one provider we keep a chain and
 * walk it in quality order:
 *
 *   1. SearxNG   — self-hosted meta-search. Aggregates Google/Bing/Brave/DDG,
 *                  unlimited, best ranking. Needs OPENSCRAPE_SEARXNG_URL.
 *   2. Brave API — independent index, metered: $5/1000 requests with $5 of
 *                  credit a month, card required. Needs BRAVE_SEARCH_API_KEY.
 *   3. DuckDuckGo — scraped from its JS-free HTML front end. Zero config, so
 *                  the chain always ends somewhere that works.
 *
 * Every provider that is skipped or fails records *why* in `attempts`, which
 * the MCP tool prints. Silent degradation is how a search tool quietly starts
 * returning worse answers than the user thinks they are getting.
 */

export type SearchSource = 'web' | 'news' | 'images';
export type SearchTime = 'day' | 'week' | 'month' | 'year';
export type SearchProviderName = 'searxng' | 'brave' | 'duckduckgo' | 'mojeek';

export interface SearchOptions {
  /** Results per source. Default 10. */
  limit?: number;
  /** Which indexes to query. Default ["web"]. */
  sources?: SearchSource[];
  /** Free-text locale hint, e.g. "Germany". A 2-letter code is used as `country`. */
  location?: string;
  /** 2-letter country code, e.g. "us". */
  country?: string;
  /** Language code, e.g. "en" or "de". */
  lang?: string;
  /** Only results published within the last day/week/month/year. */
  time?: SearchTime;
  /** Keep only results on these hostnames (suffix match, `www.` ignored). */
  includeDomains?: string[];
  /** Drop results on these hostnames. */
  excludeDomains?: string[];
  /** Fetch each result's full content with `scrape()`. */
  scrapeOptions?: ScrapeOptions;
  /** Per-request timeout in ms for provider calls. */
  timeout?: number;
  /** Parallel scrapes when `scrapeOptions` is set. */
  concurrency?: number;
  /** Force one provider instead of walking the chain. */
  provider?: SearchProviderName;
}

export interface SearchResult {
  title: string;
  url: string;
  /** Snippet as the provider wrote it. */
  description: string;
  publishedDate?: string;
  provider: SearchProviderName;
  source: SearchSource;
  /** Upstream engine inside a meta-search provider, when it tells us. */
  engine?: string;
  /** Direct image URL, for `sources: ["images"]`. */
  imageUrl?: string;
  thumbnail?: string;
  /** Present when `scrapeOptions` was given. */
  scrape?: ScrapeResult;
}

/** What a provider reports about its own configuration. */
export interface ProviderStatus {
  ready: boolean;
  /** Why it cannot run. Shown to the user verbatim. */
  reason?: string;
  /** Harmless detail for logs, e.g. the resolved base URL. */
  detail?: string;
}

/** One normalized provider call. */
export interface ProviderRequest {
  query: string;
  limit: number;
  source: SearchSource;
  country?: string;
  lang?: string;
  location?: string;
  time?: SearchTime;
  timeout?: number;
}

export interface ProviderAttempt {
  provider: SearchProviderName;
  source: SearchSource;
  status: 'ok' | 'skipped' | 'failed';
  /** Why it was skipped or how it failed. */
  reason?: string;
  /** Results the provider handed us, before dedupe and domain filters. */
  received?: number;
  /** Results we kept. */
  results?: number;
  elapsedMs?: number;
}

export interface SearchResponse {
  query: string;
  /** The provider that answered, per source. */
  answeredBy: Partial<Record<SearchSource, SearchProviderName>>;
  results: SearchResult[];
  attempts: ProviderAttempt[];
  /** Results dropped as duplicates or by the domain filters. */
  dropped: number;
  scraped?: number;
  elapsedMs: number;
  warnings: string[];
}

interface ProviderDef {
  name: SearchProviderName;
  status: () => ProviderStatus;
  run: (req: ProviderRequest) => Promise<SearchResult[]>;
  sources: SearchSource[];
}

/** Order matters: best quality first, zero-config last. */
const PROVIDERS: ProviderDef[] = [
  { name: 'searxng', status: searxngStatus, run: searxngSearch, sources: ['web', 'news', 'images'] },
  { name: 'brave', status: braveStatus, run: braveSearch, sources: ['web', 'news', 'images'] },
  { name: 'duckduckgo', status: duckduckgoStatus, run: duckduckgoSearch, sources: ['web'] },
  // Last, and keyless like DuckDuckGo. Its index is smaller, so it is the
  // backup rather than the default — but it is an independent crawler, so a
  // DDG rate limit does not apply to it. Without this the chain had exactly
  // one keyless provider, which is a single point of failure, not a fallback.
  { name: 'mojeek', status: mojeekStatus, run: mojeekSearch, sources: ['web'] },
];

/** Provider configuration as it stands right now. Handy for a status line. */
export function providerStatuses(): { provider: SearchProviderName; status: ProviderStatus }[] {
  return PROVIDERS.map((p) => ({ provider: p.name, status: p.status() }));
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function matchesDomain(url: string, domains: string[]): boolean {
  const host = hostOf(url);
  if (!host) return false;
  return domains.some((raw) => {
    const d = raw.trim().toLowerCase().replace(/^www\./, '').replace(/^\.+|\/.*$/g, '');
    if (!d) return false;
    return host === d || host.endsWith(`.${d}`);
  });
}

/** Cache/dedupe key. Falls back to the raw string for URLs `normalizeUrl` rejects. */
function dedupeKey(url: string): string {
  try {
    return normalizeUrl(url);
  } catch {
    return url;
  }
}

function message(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export async function search(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
  const started = Date.now();
  const trimmed = query.trim();
  const limit = Math.max(1, options.limit ?? 10);
  const sources: SearchSource[] = options.sources?.length ? [...new Set(options.sources)] : ['web'];

  const include = options.includeDomains?.filter(Boolean) ?? [];
  const exclude = options.excludeDomains?.filter(Boolean) ?? [];
  const filtering = include.length > 0 || exclude.length > 0;

  const attempts: ProviderAttempt[] = [];
  const answeredBy: Partial<Record<SearchSource, SearchProviderName>> = {};
  const warnings: string[] = [];
  const results: SearchResult[] = [];
  let dropped = 0;

  if (!trimmed) {
    return {
      query,
      answeredBy,
      results,
      attempts,
      dropped,
      elapsedMs: Date.now() - started,
      warnings: ['Empty query: nothing to search for.'],
    };
  }

  // Domain filters are applied after the fact, so ask for extra to filter from.
  const fetchLimit = filtering ? Math.min(limit * 4 + 10, 100) : limit;

  const country =
    options.country?.trim() ||
    (/^[A-Za-z]{2}$/.test(options.location?.trim() ?? '') ? options.location?.trim() : undefined);

  for (const source of sources) {
    const kept: SearchResult[] = [];
    // Deduped per source, not globally: a page can legitimately be both a web
    // hit and a news hit, and asking for both sources should show both.
    const seen = new Set<string>();

    for (const provider of PROVIDERS) {
      if (options.provider && provider.name !== options.provider) continue;

      if (!provider.sources.includes(source)) {
        attempts.push({
          provider: provider.name,
          source,
          status: 'skipped',
          reason: `no ${source} endpoint on this provider`,
        });
        continue;
      }

      const status = provider.status();
      if (!status.ready) {
        attempts.push({
          provider: provider.name,
          source,
          status: 'skipped',
          reason: status.reason ?? 'not configured',
        });
        continue;
      }

      const req: ProviderRequest = {
        query: trimmed,
        limit: fetchLimit,
        source,
        country,
        lang: options.lang,
        location: options.location,
        time: options.time,
        timeout: options.timeout,
      };

      const t0 = Date.now();
      try {
        const batch = await provider.run(req);
        const elapsedMs = Date.now() - t0;

        if (batch.length === 0) {
          attempts.push({
            provider: provider.name,
            source,
            status: 'failed',
            reason: 'returned 0 results',
            results: 0,
            elapsedMs,
          });
          continue;
        }

        for (const item of batch) {
          const key = dedupeKey(item.url);
          if (seen.has(key)) {
            dropped++;
            continue;
          }
          if (include.length && !matchesDomain(item.url, include)) {
            dropped++;
            continue;
          }
          if (exclude.length && matchesDomain(item.url, exclude)) {
            dropped++;
            continue;
          }
          seen.add(key);
          kept.push(item);
          if (kept.length >= limit) break;
        }

        attempts.push({
          provider: provider.name,
          source,
          status: 'ok',
          received: batch.length,
          results: kept.length,
          elapsedMs,
        });
        answeredBy[source] = provider.name;
        break;
      } catch (err) {
        attempts.push({
          provider: provider.name,
          source,
          status: 'failed',
          reason: message(err),
          elapsedMs: Date.now() - t0,
        });
        log.warn(`search provider ${provider.name} failed`, message(err));
      }
    }

    if (kept.length === 0) {
      const tried = attempts.filter((a) => a.source === source);
      const answered = tried.find((a) => a.status === 'ok');
      if (answered?.received) {
        // The provider worked; our own filters emptied the list. Say which.
        warnings.push(
          `No ${source} results kept: ${answered.provider} returned ${answered.received}, ` +
            `but all of them were removed by includeDomains/excludeDomains.`,
        );
      } else {
        const detail = tried.length
          ? tried.map((a) => `${a.provider} ${a.status}${a.reason ? ` (${a.reason})` : ''}`).join('; ')
          : 'no provider in the chain handles it';

        // When every keyless provider is bot-walled, the useful thing to say is
        // not "search failed" but "search cannot work from this IP until you
        // configure a provider with a real quota". Without this the caller
        // retries the same blocked path and concludes the tool is broken.
        const walled = tried.filter(
          (a) =>
            a.status === 'failed' &&
            /rate.?limit|bot check|CAPTCHA|throttl|anomaly/i.test(a.reason ?? ''),
        );
        const keyedReady = PROVIDERS.filter(
          (p) => p.name !== 'duckduckgo' && p.name !== 'mojeek' && p.status().ready,
        );

        if (walled.length > 0 && keyedReady.length === 0) {
          warnings.push(
            `No ${source} results: ${detail}.\n\n` +
              `Every keyless provider (${walled.map((a) => a.provider).join(', ')}) is showing a bot ` +
              `check for this IP. That is not a bug and retrying will not clear it — free search ` +
              `endpoints throttle by IP and the block lasts minutes to hours.\n\n` +
              `To make search dependable, configure one provider with a real quota:\n` +
              `  OPENSCRAPE_SEARXNG_URL=http://localhost:8080   self-hosted, no limit, no card\n` +
              `                                  docker run -d -p 8080:8080 searxng/searxng\n` +
              `  BRAVE_SEARCH_API_KEY=...        $5/1000 requests, $5 free credit a month\n` +
              `                                  (~1000 requests); needs a card on file\n\n` +
              `Until then: other discovery routes still work without search — \`map\` for a known ` +
              `site, \`feed_discover\`, \`archive_discover\`, and \`corpus_search\` over what is ` +
              `already crawled.`,
          );
        } else {
          warnings.push(`No ${source} results: ${detail}`);
        }
      }
    }
    results.push(...kept);
  }

  let scraped: number | undefined;
  if (options.scrapeOptions && results.length) {
    const width = Math.max(1, Math.min(options.concurrency ?? 5, defaultConcurrency()));
    const pages = await runPool(results, width, async (item) => {
      try {
        return await scrape(item.url, options.scrapeOptions as ScrapeOptions);
      } catch (err) {
        log.warn('search scrape failed', { url: item.url, err: message(err) });
        return undefined;
      }
    });
    let ok = 0;
    pages.forEach((page, i) => {
      if (!page) return;
      const target = results[i];
      if (!target) return;
      target.scrape = page;
      if (page.success) ok++;
    });
    scraped = ok;
    const failed = results.length - ok;
    if (failed > 0) warnings.push(`${failed} of ${results.length} result page(s) could not be scraped.`);
  }

  log.debug('search done', {
    query: trimmed,
    sources,
    results: results.length,
    answeredBy,
    ms: Date.now() - started,
  });

  return {
    query: trimmed,
    answeredBy,
    results,
    attempts,
    dropped,
    scraped,
    elapsedMs: Date.now() - started,
    warnings,
  };
}
