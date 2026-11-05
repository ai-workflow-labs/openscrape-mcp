import { httpFetch, isTextual } from './http.js';
import { needsJavaScript, type JsVerdict } from './needsJs.js';
import { getRaw, putRaw, getValidators, loadBody, markRevalidated } from '../cache/store.js';
import { log } from '../util/log.js';
import type { FetchedPage, RenderMode, ScrapeOptions } from '../types.js';
import type { ArchivedContent } from '../discover/archive.js';
import { assertUrlAllowed, archiveAllowed, browserAllowed } from '../policy/lockdown.js';

export interface FetchOutcome {
  page: FetchedPage;
  fromCache: boolean;
  cacheAgeMs?: number;
  /** Why we escalated to a browser, when we did. */
  escalation?: JsVerdict;
  /** The server answered 304 and the stored body was served. */
  revalidated?: boolean;
  warning?: string;
  /**
   * Set only when the live page could not be read and a public archive copy
   * was served instead. The caller must surface its staleness notice: this is
   * an old copy of the page, not the page.
   */
  archived?: ArchivedContent;
  /** The ladder rungs that were tried, in order. Only when more than one was. */
  ladder?: string[];
}

/** Cheap text probe used only to decide whether the HTTP body is good enough. */
function probeText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function loadBrowserFetcher() {
  // A lockdown that forbids the browser must stop it here too, not only in the
  // options: the ladder escalates on its own, and this is where it would.
  if (!browserAllowed()) {
    log.debug('browser fetcher disabled by lockdown');
    return null;
  }
  try {
    const mod = await import('./browser.js');
    return mod;
  } catch (err) {
    log.debug('browser fetcher unavailable', String(err));
    return null;
  }
}

/** Loaded lazily, so the archive module costs nothing until a fetch actually fails. */
async function loadArchive() {
  try {
    return await import('../discover/archive.js');
  } catch (err) {
    log.debug('archive module unavailable', String(err));
    return null;
  }
}

/**
 * Is this result unreadable, meaning the archive rung is worth trying?
 *
 * Returns the reason in words, or null when the page is fine. A 3xx never
 * reaches here (undici follows redirects), and a 404 counts: the page is gone
 * from the live web, which is exactly when an archived copy earns its keep.
 */
function unreadableReason(page: FetchedPage): string | null {
  if (page.blocked) return `bot wall (${page.blockReason})`;
  if (page.status >= 400) return `HTTP ${page.status}`;
  if (page.body.byteLength === 0) return 'empty response body';
  return null;
}

/**
 * The last rung, shared by every exit from the live fetch.
 *
 * Anything that comes back unreadable gets one more chance from a public web
 * archive before the caller is handed a failure. Readable results pass
 * straight through untouched, so the normal path pays nothing for this.
 *
 * What this deliberately does NOT do: retry a bot wall through a different
 * proxy, or reach for a login the caller did not name. Rotating IPs until a
 * site stops saying no is working around its refusal, not reading the web.
 * An archive copy is a different public source that is allowed to serve us.
 */
async function finish(
  url: string,
  opts: ScrapeOptions,
  outcome: FetchOutcome,
  rungs: string[],
): Promise<FetchOutcome> {
  const withLadder = (o: FetchOutcome): FetchOutcome =>
    rungs.length > 1 ? { ...o, ladder: [...rungs] } : o;

  const unreadable = unreadableReason(outcome.page);
  if (!unreadable) return withLadder(outcome);

  if (opts.archiveFallback === false) {
    rungs.push(`archive: skipped (archiveFallback:false), live ${unreadable}`);
    return withLadder(outcome);
  }
  if (!archiveAllowed()) {
    rungs.push(`archive: disabled by lockdown, live ${unreadable}`);
    return withLadder(outcome);
  }

  rungs.push(`live page unreadable: ${unreadable}`);
  const archive = await loadArchive();
  if (!archive) return withLadder(outcome);

  const content = await archive.tryArchiveFallback(url, {
    onlyMainContent: opts.onlyMainContent,
    maxChars: opts.maxChars,
    timeout: opts.timeout,
  });

  if (!content) {
    rungs.push('archive: no usable capture');
    return withLadder(outcome);
  }

  rungs.push(`archive: ${content.archive} capture from ${content.staleness.capturedOn}`);
  log.info('archive fallback served', { url, captured: content.staleness.capturedOn });
  return withLadder({ ...outcome, archived: content });
}

/**
 * The fetch ladder.
 *
 *   cache -> plain HTTP -> (only when needed) real browser
 *
 * Skipping the browser whenever possible is what makes this fast and lets it
 * run on a laptop: a browser page costs ~100x the CPU and memory of an HTTP GET.
 */
export async function fetchPage(url: string, opts: ScrapeOptions = {}): Promise<FetchOutcome> {
  // The domain gate, before anything is sent. Every caller that fetches a page
  // comes through here — scrape, crawl, map, monitor — so this is the one place
  // the check has to be, and it throws rather than returning a soft failure.
  assertUrlAllowed(url);

  const render: RenderMode = opts.render ?? 'auto';
  const maxAge = opts.maxAge ?? 0;
  const store = opts.storeInCache !== false;
  const rungs: string[] = [];

  // 1. Cache. A fresh local copy ends the ladder before it starts.
  if (maxAge > 0) {
    const hit = getRaw(url, render === 'browser' ? 'browser' : 'http', maxAge);
    if (hit) {
      log.debug('cache hit', { url, ageMs: hit.ageMs });
      return { page: { ...hit, renderedWith: hit.renderedWith }, fromCache: true, cacheAgeMs: hit.ageMs };
    }
  }

  // 2. Forced browser.
  if (render === 'browser') {
    const browser = await loadBrowserFetcher();
    if (!browser) {
      const why = browserAllowed()
        ? 'Playwright is not installed. Run: npm i playwright && npx playwright install chromium'
        : 'the lockdown file disables browser rendering (allowBrowser:false)';
      rungs.push(`browser: requested but unavailable — ${why}`);
      return finish(
        url,
        opts,
        {
          page: await httpFetch(url, opts),
          fromCache: false,
          warning: `render="browser" was requested but ${why}. Fell back to HTTP.`,
        },
        rungs,
      );
    }
    rungs.push(opts.profile ? `browser (profile "${opts.profile}")` : 'browser (forced)');
    const page = await browser.browserFetch(url, opts);
    if (store && page.status < 400) putRaw(page, 'browser');
    return finish(url, opts, { page, fromCache: false }, rungs);
  }

  // 3. Plain HTTP — conditional when we hold a validator for this URL.
  //
  // This is what makes re-crawling cheap. A stale cache entry is not useless:
  // if the server says 304 Not Modified we serve the stored body and the whole
  // exchange costs a few hundred bytes instead of the page plus re-parsing.
  let httpPage: FetchedPage;
  let revalidated = false;

  const validators = opts.revalidate === false ? null : getValidators(url, 'http');
  if (validators) {
    const probe = await httpFetch(url, opts, {
      etag: validators.etag,
      lastModified: validators.lastModified,
    });

    if (probe.status === 304) {
      const body = loadBody(validators.bodySha);
      if (body) {
        markRevalidated(url, 'http');
        const cached = getRaw(url, 'http', Number.MAX_SAFE_INTEGER);
        httpPage = {
          ...probe,
          status: cached?.status ?? 200,
          contentType: cached?.contentType ?? probe.contentType,
          body,
          revalidated: true,
        };
        revalidated = true;
        log.debug('revalidated from cache', { url, savedBytes: body.byteLength });
      } else {
        // The body file vanished under us; fetch it properly.
        httpPage = await httpFetch(url, opts);
      }
    } else {
      httpPage = probe;
    }
  } else {
    httpPage = await httpFetch(url, opts);
  }

  rungs.push(revalidated ? 'http (304, stored body reused)' : `http (${httpPage.status})`);

  if (render === 'http') {
    if (store && !revalidated && httpPage.status < 400) putRaw(httpPage, 'http');
    return finish(url, opts, { page: httpPage, fromCache: false, revalidated }, rungs);
  }

  // 4. Decide whether HTTP was enough.
  const textual = isTextual(httpPage.contentType) && /html|xml|^$/i.test(httpPage.contentType);
  if (!textual) {
    if (store && !revalidated && httpPage.status < 400) putRaw(httpPage, 'http');
    return finish(url, opts, { page: httpPage, fromCache: false, revalidated }, rungs);
  }

  const html = httpPage.body.toString('utf8');
  const verdict = needsJavaScript(html, probeText(html));
  const mustEscalate = httpPage.blocked || verdict.needsJs;

  if (!mustEscalate) {
    if (store && !revalidated && httpPage.status < 400) putRaw(httpPage, 'http');
    return finish(url, opts, { page: httpPage, fromCache: false, revalidated }, rungs);
  }

  const reason = httpPage.blocked ? `bot-wall:${httpPage.blockReason}` : verdict.reason;
  log.debug('escalating to browser', { url, reason });

  const browser = await loadBrowserFetcher();
  if (!browser) {
    const why = browserAllowed()
      ? 'Playwright is not installed. Run: npm i playwright && npx playwright install chromium'
      : 'the lockdown file disables browser rendering (allowBrowser:false)';
    rungs.push(`browser: needed (${reason}) but unavailable — ${why}`);
    return finish(
      url,
      opts,
      {
        page: httpPage,
        fromCache: false,
        escalation: verdict,
        warning: `This page looks JavaScript-rendered (${reason}) but ${why}, so only the server HTML was captured.`,
      },
      rungs,
    );
  }

  // 5. Real browser.
  let browserPage: FetchedPage | null = null;
  let browserError: string | null = null;
  try {
    browserPage = await browser.browserFetch(url, { ...opts, profile: undefined });
    rungs.push(`browser (${reason}) -> ${browserPage.status}`);
  } catch (err) {
    browserError = String(err);
    rungs.push(`browser failed: ${browserError}`);
    log.warn('browser fetch failed', browserError);
  }

  // 6. The caller's own logged-in profile, when they named one and the
  //    anonymous browser was not enough. Only ever the session they chose:
  //    we never go looking for credentials of our own.
  if (opts.profile && (!browserPage || unreadableReason(browserPage))) {
    const why = browserPage ? unreadableReason(browserPage) : browserError;
    log.debug('retrying through profile', { url, profile: opts.profile, why });
    try {
      const signedIn = await browser.browserFetch(url, opts);
      rungs.push(`browser with profile "${opts.profile}" -> ${signedIn.status}`);
      if (!unreadableReason(signedIn)) {
        if (store && signedIn.status < 400) putRaw(signedIn, 'browser');
        return finish(url, opts, { page: signedIn, fromCache: false, escalation: verdict }, rungs);
      }
      browserPage = signedIn;
    } catch (err) {
      rungs.push(`profile "${opts.profile}" failed: ${String(err)}`);
      log.warn('profile fetch failed', String(err));
    }
  }

  if (!browserPage) {
    return finish(
      url,
      opts,
      {
        page: httpPage,
        fromCache: false,
        escalation: verdict,
        warning: `Browser rendering failed (${browserError}); returning the server HTML instead.`,
      },
      rungs,
    );
  }

  if (store && browserPage.status < 400) putRaw(browserPage, 'browser');
  return finish(url, opts, { page: browserPage, fromCache: false, escalation: verdict }, rungs);
}
