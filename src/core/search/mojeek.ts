import * as cheerio from 'cheerio';
import { httpFetch } from '../fetcher/http.js';
import { log } from '../util/log.js';
import { createPacer } from './pacing.js';
import type { ProviderRequest, ProviderStatus, SearchResult } from './index.js';

/**
 * Mojeek, scraped from its plain HTML results page.
 *
 * This exists because the chain had a hole: SearxNG needs an instance you host,
 * Brave needs an API key, and DuckDuckGo is the only keyless option — so the
 * moment DDG throttles an IP, `search` has nothing left and the whole tool
 * reports itself blocked. One keyless provider is a single point of failure
 * dressed up as a fallback chain.
 *
 * Mojeek is a good second because it is genuinely independent: its own crawler
 * and index rather than a reseller of Bing or Google, so its rate limits are
 * its own and a DDG block says nothing about it. It is also markedly more
 * tolerant of plain HTTP clients, which is the whole point here.
 *
 * Honest about what it is not: a smaller index than DDG, so for long-tail
 * queries it returns fewer and sometimes worse results. It sits *after*
 * DuckDuckGo in the chain for that reason — it is the backup, not the default.
 */

const ENDPOINT = 'https://www.mojeek.com/search';

/** Mojeek's freshness filter, as its own query parameter values. */
const SINCE: Record<string, string> = { day: 'd', week: 'w', month: 'm', year: 'y' };

/** Always available: no key, no configuration. */
export function mojeekStatus(): ProviderStatus {
  return { ready: true, detail: 'no key required, independent index' };
}

/**
 * Pacing, shared across concurrent callers for the same reason DuckDuckGo's is.
 *
 * Mojeek is more tolerant, so the gap is shorter — but "more tolerant" is not
 * "unlimited", and the failure this whole module exists to fix was three
 * queries fired simultaneously.
 */
const pacer = createPacer(700);

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Mojeek answers a suspected bot with a CAPTCHA page, served as a normal 200.
 *
 * Worth detecting separately: without this the parser simply finds no results
 * and reports "the markup changed", which sends whoever reads it to go fix a
 * scraper that is working fine. "You are being asked for a CAPTCHA" is a
 * different problem with a different fix, and it is not one this tool tries to
 * get around.
 */
function isCaptcha(html: string): boolean {
  const head = html.slice(0, 4000).toLowerCase();
  return (
    /<title>\s*captcha/.test(head) ||
    head.includes('id="captcha"') ||
    head.includes('name="captcha"') ||
    head.includes('please prove you')
  );
}

/**
 * Results are `<li>` blocks inside `ul.results-standard`, each with an `<a>`
 * title and a `<p class="s">` snippet. The fallback selector below catches the
 * case where Mojeek reshuffles its markup, which is the usual way a scraper
 * like this dies quietly.
 */
function parseResults(html: string, limit: number): SearchResult[] {
  const $ = cheerio.load(html);
  const out: SearchResult[] = [];
  const seen = new Set<string>();

  const blocks = $('ul.results-standard > li').length
    ? $('ul.results-standard > li')
    : $('li:has(a.ob), li:has(h2 a)');

  blocks.each((_i, el) => {
    if (out.length >= limit) return;
    const $el = $(el);

    const $link = $el.find('h2 a, a.ob').first();
    const href = $link.attr('href');
    if (!href) return;

    let url: string;
    try {
      url = new URL(href, 'https://www.mojeek.com').toString();
    } catch {
      return;
    }
    // Mojeek links out directly, so anything still on mojeek.com is chrome
    // (pagination, settings) rather than a result.
    if (/^https?:\/\/(www\.)?mojeek\.com/i.test(url)) return;
    if (!/^https?:/i.test(url)) return;
    if (seen.has(url)) return;
    seen.add(url);

    const title = clean($link.text());
    if (!title) return;

    out.push({
      title,
      url,
      description: clean($el.find('p.s, p.result-desc').first().text()),
      provider: 'mojeek',
      source: 'web',
    });
  });

  return out;
}

export async function mojeekSearch(req: ProviderRequest): Promise<SearchResult[]> {
  if (req.source !== 'web') {
    throw new Error(
      `Mojeek is used here for web results only, not ${req.source}. ` +
        'Configure OPENSCRAPE_SEARXNG_URL or BRAVE_SEARCH_API_KEY for news and images.',
    );
  }

  const collected: SearchResult[] = [];
  const problems: string[] = [];

  // 10 results per page; walk pages only when more were asked for.
  for (let page = 0; page < 3 && collected.length < req.limit; page++) {
    const url = new URL(ENDPOINT);
    url.searchParams.set('q', req.query);
    if (page > 0) url.searchParams.set('s', String(page * 10));
    if (req.time && SINCE[req.time]) url.searchParams.set('since', SINCE[req.time]);
    if (req.country) url.searchParams.set('reg', req.country.toLowerCase());

    await pacer.wait();

    let html: string;
    let status: number;
    try {
      const res = await httpFetch(url.toString(), {
        timeout: req.timeout,
        headers: { referer: 'https://www.mojeek.com/' },
      });
      html = res.body.toString('utf8');
      status = res.status;
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
      break;
    }

    if (status >= 400) {
      problems.push(`HTTP ${status}`);
      break;
    }

    if (isCaptcha(html)) {
      // Reported, not solved. Getting around a CAPTCHA is not something this
      // tool does, so the honest outcome is to say the source is closed to us.
      problems.push('served a CAPTCHA — this IP is being treated as a bot');
      break;
    }

    const batch = parseResults(html, req.limit - collected.length);
    if (batch.length === 0) {
      // Distinguishing "no matches" from "markup changed" is not possible from
      // the page alone, so the message names both rather than picking one.
      if (page === 0) {
        problems.push('no results parsed — either the query has no matches, or the markup changed');
      }
      break;
    }

    collected.push(...batch);
  }

  if (collected.length === 0) {
    throw new Error(`Mojeek returned no results (${problems.join('; ') || 'empty page'})`);
  }

  log.debug('mojeek results', { query: req.query, count: collected.length });
  return collected;
}
