import * as cheerio from 'cheerio';
import { httpFetch } from '../fetcher/http.js';
import { log } from '../util/log.js';
import type { ProviderRequest, ProviderStatus, SearchResult } from './index.js';

/**
 * DuckDuckGo, scraped from its own no-JavaScript HTML endpoints.
 *
 * This is the floor of the provider chain: no key, no quota, no configuration,
 * so `search()` always has something to fall back to. DDG publishes two
 * JS-free front ends intended for old browsers and text clients, and both are
 * plain server-rendered HTML:
 *
 *   https://html.duckduckgo.com/html/?q=...   (rich, ~30 results/page)
 *   https://lite.duckduckgo.com/lite/?q=...   (table layout, lighter)
 *
 * We try the first, fall back to the second, and as a last resort scan for the
 * redirect anchors directly in case the markup gets reshuffled again.
 *
 * Caveat we state honestly rather than paper over: these endpoints only serve
 * general web results. News and image search need SearxNG or Brave.
 */

const HTML_ENDPOINT = 'https://html.duckduckgo.com/html/';
const LITE_ENDPOINT = 'https://lite.duckduckgo.com/lite/';

const DF: Record<string, string> = { day: 'd', week: 'w', month: 'm', year: 'y' };

/** Always available — that is the whole point of this provider. */
export function duckduckgoStatus(): ProviderStatus {
  return { ready: true, detail: 'no key required' };
}

/**
 * Turn DDG's redirect wrapper back into the destination.
 *
 * Links come through as `//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=…`
 * (and occasionally as a bare absolute URL). Anything that is not http(s), or
 * that is still a DDG redirect after unwrapping, is dropped.
 */
export function decodeDdgUrl(href: string | undefined): string | null {
  if (!href) return null;
  let candidate = href.trim();
  if (!candidate) return null;
  if (candidate.startsWith('//')) candidate = `https:${candidate}`;

  for (let hop = 0; hop < 3; hop++) {
    let u: URL;
    try {
      u = new URL(candidate, 'https://duckduckgo.com');
    } catch {
      return null;
    }
    const wrapped = u.searchParams.get('uddg');
    if (wrapped) {
      candidate = wrapped.startsWith('//') ? `https:${wrapped}` : wrapped;
      continue;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    // Still inside DDG's own redirector or an ad click-through: not a real result.
    if (/(^|\.)duckduckgo\.com$/i.test(u.hostname)) return null;
    return u.toString();
  }
  return null;
}

/** DDG's region code, e.g. `us-en`. Built only when we can do it honestly. */
function regionCode(req: ProviderRequest): string | undefined {
  const country = (req.country ?? (/^[A-Za-z]{2}$/.test(req.location ?? '') ? req.location : undefined))
    ?.trim()
    .toLowerCase();
  if (!country || !/^[a-z]{2}$/.test(country)) return undefined;
  const lang = (req.lang ?? 'en').trim().toLowerCase().slice(0, 2);
  return `${country}-${lang}`;
}

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The rich HTML front end: `div.result` blocks with a title anchor and a snippet. */
function parseHtmlPage(html: string, limit: number): SearchResult[] {
  const $ = cheerio.load(html);
  const out: SearchResult[] = [];

  $('div.result, div.web-result').each((_, el) => {
    if (out.length >= limit) return;
    const node = $(el);
    const cls = node.attr('class') ?? '';
    if (/result--ad|result--sponsored/.test(cls)) return;

    const anchor = node.find('a.result__a').first();
    const url = decodeDdgUrl(anchor.attr('href'));
    if (!url) return;
    const title = clean(anchor.text());
    if (!title) return;

    out.push({
      title,
      url,
      description: clean(node.find('.result__snippet').first().text()),
      provider: 'duckduckgo',
      source: 'web',
    });
  });

  return out;
}

/** The lite front end: a flat table, one row for the link and the next for the snippet. */
function parseLitePage(html: string, limit: number): SearchResult[] {
  const $ = cheerio.load(html);
  const out: SearchResult[] = [];

  $('a.result-link').each((_, el) => {
    if (out.length >= limit) return;
    const anchor = $(el);
    const url = decodeDdgUrl(anchor.attr('href'));
    if (!url) return;
    const title = clean(anchor.text());
    if (!title) return;

    const row = anchor.closest('tr');
    const snippet =
      clean(row.nextAll('tr').find('td.result-snippet').first().text()) ||
      clean(row.next('tr').text());

    out.push({ title, url, description: snippet, provider: 'duckduckgo', source: 'web' });
  });

  return out;
}

/** Markup-agnostic rescue: every redirect anchor on the page, in document order. */
function parseAnyRedirects(html: string, limit: number): SearchResult[] {
  const $ = cheerio.load(html);
  const out: SearchResult[] = [];
  const seen = new Set<string>();

  $('a[href*="uddg="]').each((_, el) => {
    if (out.length >= limit) return;
    const anchor = $(el);
    const url = decodeDdgUrl(anchor.attr('href'));
    if (!url || seen.has(url)) return;
    const title = clean(anchor.text());
    if (!title || title.length < 2) return;
    seen.add(url);
    out.push({ title, url, description: '', provider: 'duckduckgo', source: 'web' });
  });

  return out;
}

/**
 * DDG's rate-limit page: HTTP 202 carrying `anomaly.js` and an apology about
 * bots. It is not an HTTP error, so nothing but the body gives it away.
 */
function isAnomaly(html: string): boolean {
  const head = html.slice(0, 6000).toLowerCase();
  return (
    head.includes('anomaly.js') ||
    head.includes('bots use duckduckgo too') ||
    head.includes('unfortunately, bots use duckduckgo')
  );
}

const MIN_GAP_MS = 1100;
const RETRY_BACKOFF_MS = [2500];

/**
 * Self-imposed pacing. Hammering the HTML endpoint in a tight loop is the one
 * reliable way to get the bot wall, and once it appears it sticks around for
 * minutes. A second between requests costs nothing and avoids the cliff.
 */
let nextAllowedAt = 0;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function pace(): Promise<void> {
  const wait = nextAllowedAt - Date.now();
  if (wait > 0) await sleep(wait);
  nextAllowedAt = Date.now() + MIN_GAP_MS;
}

async function fetchPage(
  endpoint: string,
  req: ProviderRequest,
  offset: number,
): Promise<{ html: string; status: number; anomaly: boolean }> {
  const url = new URL(endpoint);
  url.searchParams.set('q', req.query);
  const kl = regionCode(req);
  if (kl) url.searchParams.set('kl', kl);
  if (req.time && DF[req.time]) url.searchParams.set('df', DF[req.time]);
  if (offset > 0) {
    url.searchParams.set('s', String(offset));
    url.searchParams.set('dc', String(offset + 1));
  }

  // One retry pass per backoff step, but only for the bot wall: a real HTTP
  // error or an empty page will not fix itself by being asked again.
  for (let attempt = 0; ; attempt++) {
    await pace();
    const page = await httpFetch(url.toString(), {
      timeout: req.timeout,
      headers: { referer: 'https://duckduckgo.com/' },
    });
    const html = page.body.toString('utf8');
    const anomaly = isAnomaly(html);

    if (!anomaly || attempt >= RETRY_BACKOFF_MS.length) {
      return { html, status: page.status, anomaly };
    }
    log.debug('duckduckgo bot wall, backing off', { attempt, ms: RETRY_BACKOFF_MS[attempt] });
    await sleep(RETRY_BACKOFF_MS[attempt]);
  }
}

export async function duckduckgoSearch(req: ProviderRequest): Promise<SearchResult[]> {
  if (req.source !== 'web') {
    throw new Error(
      `DuckDuckGo's JS-free endpoints only serve web results, not ${req.source}. ` +
        'Configure OPENSCRAPE_SEARXNG_URL or BRAVE_SEARCH_API_KEY for that.',
    );
  }

  const collected: SearchResult[] = [];
  const seen = new Set<string>();
  const problems: string[] = [];

  for (const endpoint of [HTML_ENDPOINT, LITE_ENDPOINT]) {
    // ~30 results per page on the HTML endpoint; walk pages only if asked for more.
    for (let page = 0; page < 3 && collected.length < req.limit; page++) {
      let html: string;
      let status: number;
      let anomaly: boolean;
      try {
        ({ html, status, anomaly } = await fetchPage(endpoint, req, page * 30));
      } catch (err) {
        problems.push(`${new URL(endpoint).host}: ${err instanceof Error ? err.message : String(err)}`);
        break;
      }

      if (status >= 400) {
        problems.push(`${new URL(endpoint).host}: HTTP ${status}`);
        break;
      }
      if (anomaly) {
        problems.push(`${new URL(endpoint).host}: rate-limited (bot check) after retries`);
        break;
      }

      const want = req.limit - collected.length;
      const parsed = endpoint === HTML_ENDPOINT ? parseHtmlPage(html, want) : parseLitePage(html, want);
      const batch = parsed.length ? parsed : parseAnyRedirects(html, want);

      if (batch.length === 0) {
        if (page === 0) {
          // DDG also soft-throttles by serving the search chrome with an empty
          // result area and a 200. Indistinguishable from a genuinely empty
          // result set from the markup alone, so say both out loud.
          problems.push(
            `${new URL(endpoint).host}: empty results page — either the query has no matches, ` +
              'or DDG is throttling this IP',
          );
        }
        break;
      }

      for (const item of batch) {
        if (seen.has(item.url)) continue;
        seen.add(item.url);
        collected.push(item);
        if (collected.length >= req.limit) break;
      }
    }
    if (collected.length > 0) break;
  }

  if (collected.length === 0) {
    const throttled = problems.some((p) => /rate-limited|throttling/.test(p));
    throw new Error(
      `DuckDuckGo returned no results (${problems.join('; ') || 'empty page'})` +
        (throttled
          ? '. DDG throttles repeated queries from one IP; wait a few minutes, or set ' +
            'OPENSCRAPE_SEARXNG_URL / BRAVE_SEARCH_API_KEY for a provider with a real quota.'
          : ''),
    );
  }

  log.debug('duckduckgo results', { query: req.query, count: collected.length });
  return collected;
}
