import { httpFetch } from '../fetcher/http.js';
import { log } from '../util/log.js';
import type { ProviderRequest, ProviderStatus, SearchResult, SearchSource } from './index.js';

/**
 * SearxNG: a self-hosted meta-search engine.
 *
 * This is the best of the three providers by a wide margin, because it is not a
 * search engine at all — it forwards the query to Google, Bing, Brave, DDG,
 * Qwant and friends, then merges and re-ranks what comes back. No API key, no
 * quota, no per-result billing. The only cost is running the container:
 *
 *   docker run -d -p 8080:8080 searxng/searxng
 *
 * One catch worth knowing: SearxNG ships with the JSON API *disabled*. If the
 * instance answers 403 or hands back HTML, add `json` to `search.formats` in
 * its settings.yml. We detect both cases and say so rather than failing blind.
 */

const CATEGORY: Record<SearchSource, string> = {
  web: 'general',
  news: 'news',
  images: 'images',
};

/** Trailing-slash-free base URL, tolerating a bare `localhost:8080`. */
function baseUrl(raw: string): string {
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  const u = new URL(withScheme);
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.origin}${path}`;
}

export function searxngStatus(): ProviderStatus {
  const raw = process.env.OPENSCRAPE_SEARXNG_URL?.trim();
  if (!raw) {
    return {
      ready: false,
      reason: 'SearxNG not configured; set OPENSCRAPE_SEARXNG_URL (e.g. http://localhost:8080)',
    };
  }
  try {
    return { ready: true, detail: baseUrl(raw) };
  } catch {
    return { ready: false, reason: `OPENSCRAPE_SEARXNG_URL is not a usable URL: ${raw}` };
  }
}

interface SearxItem {
  url?: unknown;
  title?: unknown;
  content?: unknown;
  publishedDate?: unknown;
  pubdate?: unknown;
  engine?: unknown;
  engines?: unknown;
  img_src?: unknown;
  thumbnail_src?: unknown;
  thumbnail?: unknown;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export async function searxngSearch(req: ProviderRequest): Promise<SearchResult[]> {
  const status = searxngStatus();
  if (!status.ready || !status.detail) throw new Error(status.reason ?? 'SearxNG not configured');
  const base = status.detail;

  const out: SearchResult[] = [];
  const seen = new Set<string>();

  // SearxNG pages hold ~10 merged results each; walk pages until we have enough.
  for (let page = 1; page <= 5 && out.length < req.limit; page++) {
    const url = new URL(`${base}/search`);
    url.searchParams.set('q', req.query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('categories', CATEGORY[req.source]);
    url.searchParams.set('pageno', String(page));
    url.searchParams.set('safesearch', '0');
    if (req.lang) url.searchParams.set('language', req.lang);
    if (req.time) url.searchParams.set('time_range', req.time);

    const page_ = await httpFetch(url.toString(), {
      timeout: req.timeout,
      headers: { accept: 'application/json' },
    });

    const body = page_.body.toString('utf8');

    if (page_.status === 403 || page_.status === 404) {
      throw new Error(
        `SearxNG answered ${page_.status} at ${base}/search. Its JSON API is probably off — ` +
          'add "json" to search.formats in settings.yml and restart the instance.',
      );
    }
    if (page_.status >= 400) {
      throw new Error(`SearxNG answered ${page_.status} at ${base}/search`);
    }

    let parsed: { results?: SearxItem[] };
    try {
      parsed = JSON.parse(body) as { results?: SearxItem[] };
    } catch {
      const looksHtml = /^\s*<(?:!doctype|html)/i.test(body);
      throw new Error(
        looksHtml
          ? `SearxNG returned HTML instead of JSON. Add "json" to search.formats in settings.yml (${base}).`
          : `SearxNG returned an unparseable body (${body.slice(0, 120)})`,
      );
    }

    const items = Array.isArray(parsed.results) ? parsed.results : [];
    if (items.length === 0) break;

    for (const item of items) {
      const link = str(item.url);
      if (!link) continue;
      if (seen.has(link)) continue;
      seen.add(link);

      const engines = Array.isArray(item.engines)
        ? item.engines.filter((e): e is string => typeof e === 'string').join(',')
        : undefined;

      out.push({
        title: str(item.title) ?? link,
        url: link,
        description: str(item.content) ?? '',
        publishedDate: str(item.publishedDate) ?? str(item.pubdate),
        provider: 'searxng',
        source: req.source,
        engine: engines ?? str(item.engine),
        imageUrl: str(item.img_src),
        thumbnail: str(item.thumbnail_src) ?? str(item.thumbnail),
      });
      if (out.length >= req.limit) break;
    }
  }

  log.debug('searxng results', { query: req.query, source: req.source, count: out.length });
  return out;
}
