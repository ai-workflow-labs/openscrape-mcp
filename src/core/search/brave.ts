import { httpFetch } from '../fetcher/http.js';
import { log } from '../util/log.js';
import type { ProviderRequest, ProviderStatus, SearchResult, SearchSource } from './index.js';

/**
 * Brave Search API.
 *
 * Brave runs its own index, so this is a genuinely independent second opinion
 * rather than another Google scraper. The free tier is 2000 queries a month at
 * one query per second, which is plenty for a local tool; get a key at
 * https://api-dashboard.search.brave.com and set BRAVE_SEARCH_API_KEY.
 */

const ENDPOINT: Record<SearchSource, string> = {
  web: 'https://api.search.brave.com/res/v1/web/search',
  news: 'https://api.search.brave.com/res/v1/news/search',
  images: 'https://api.search.brave.com/res/v1/images/search',
};

/** Brave caps `count` per endpoint; asking for more is a 422. */
const MAX_COUNT: Record<SearchSource, number> = { web: 20, news: 50, images: 100 };

const FRESHNESS: Record<string, string> = { day: 'pd', week: 'pw', month: 'pm', year: 'py' };

export function braveStatus(): ProviderStatus {
  const key = process.env.BRAVE_SEARCH_API_KEY?.trim();
  if (!key) {
    return {
      ready: false,
      reason:
        'Brave not configured; set BRAVE_SEARCH_API_KEY (free 2000 queries/month at api-dashboard.search.brave.com)',
    };
  }
  return { ready: true, detail: `key …${key.slice(-4)}` };
}

function stripTags(value: string): string {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = stripTags(value);
  return clean || undefined;
}

interface BraveItem {
  title?: unknown;
  url?: unknown;
  description?: unknown;
  page_age?: unknown;
  age?: unknown;
  thumbnail?: { src?: unknown } | unknown;
  properties?: { url?: unknown } | unknown;
}

function nested(value: unknown, key: string): unknown {
  if (value && typeof value === 'object' && key in (value as Record<string, unknown>)) {
    return (value as Record<string, unknown>)[key];
  }
  return undefined;
}

function toResult(item: BraveItem, source: SearchSource): SearchResult | null {
  const link = typeof item.url === 'string' ? item.url.trim() : '';
  if (!link) return null;
  return {
    title: str(item.title) ?? link,
    url: link,
    description: str(item.description) ?? '',
    publishedDate: str(item.page_age) ?? str(item.age),
    provider: 'brave',
    source,
    imageUrl: source === 'images' ? str(nested(item.properties, 'url')) : undefined,
    thumbnail: str(nested(item.thumbnail, 'src')),
  };
}

/**
 * Map one Brave payload to our results.
 *
 * Brave nests web hits under `web.results` but puts news and image hits at
 * `results`, and decorates web descriptions with `<strong>` tags. Exported so
 * the mapping can be checked against a recorded payload without burning a
 * query from the monthly quota.
 */
export function parseBraveResults(payload: unknown, source: SearchSource): SearchResult[] {
  const parsed = (payload ?? {}) as Record<string, unknown>;
  const bucket = source === 'web' ? nested(parsed.web, 'results') : parsed.results;
  const items = Array.isArray(bucket) ? (bucket as BraveItem[]) : [];

  const out: SearchResult[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const mapped = toResult(item, source);
    if (!mapped || seen.has(mapped.url)) continue;
    seen.add(mapped.url);
    out.push(mapped);
  }
  return out;
}

export async function braveSearch(req: ProviderRequest): Promise<SearchResult[]> {
  const key = process.env.BRAVE_SEARCH_API_KEY?.trim();
  if (!key) throw new Error('BRAVE_SEARCH_API_KEY is not set');

  const out: SearchResult[] = [];
  const seen = new Set<string>();
  const perPage = Math.min(req.limit, MAX_COUNT[req.source]);

  // Only the web endpoint paginates in a way worth using.
  const maxPages = req.source === 'web' ? 3 : 1;

  for (let page = 0; page < maxPages && out.length < req.limit; page++) {
    // The free plan allows one query per second, so paginating back-to-back
    // would earn a 429 on the second page. Space them out instead.
    if (page > 0) await new Promise((resolve) => setTimeout(resolve, 1100));

    const url = new URL(ENDPOINT[req.source]);
    url.searchParams.set('q', req.query);
    url.searchParams.set('count', String(perPage));
    if (page > 0) url.searchParams.set('offset', String(page));
    if (req.country && /^[A-Za-z]{2}$/.test(req.country)) {
      url.searchParams.set('country', req.country.toUpperCase());
    }
    if (req.lang) url.searchParams.set('search_lang', req.lang.slice(0, 5).toLowerCase());
    if (req.time && FRESHNESS[req.time]) url.searchParams.set('freshness', FRESHNESS[req.time]);
    if (req.source === 'web') url.searchParams.set('text_decorations', '0');

    const res = await httpFetch(url.toString(), {
      timeout: req.timeout,
      headers: {
        accept: 'application/json',
        'accept-encoding': 'gzip',
        'x-subscription-token': key,
      },
    });

    const body = res.body.toString('utf8');

    // Brave reports a bad key as 422 SUBSCRIPTION_TOKEN_INVALID, not 401.
    if (res.status === 401 || res.status === 403 || body.includes('SUBSCRIPTION_TOKEN_INVALID')) {
      throw new Error(
        `Brave rejected BRAVE_SEARCH_API_KEY (${res.status} subscription token invalid). ` +
          'Check the key and that its plan covers this endpoint.',
      );
    }
    if (res.status === 429) {
      throw new Error('Brave rate-limited the request (429). The free tier allows 1 query/second.');
    }
    if (res.status >= 400) {
      throw new Error(`Brave answered ${res.status}: ${body.slice(0, 200)}`);
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
      throw new Error(`Brave returned an unparseable body (${body.slice(0, 120)})`);
    }

    const items = parseBraveResults(parsed, req.source);
    if (items.length === 0) break;

    for (const item of items) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      out.push(item);
      if (out.length >= req.limit) break;
    }
  }

  log.debug('brave results', { query: req.query, source: req.source, count: out.length });
  return out;
}
