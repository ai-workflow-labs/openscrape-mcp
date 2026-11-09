import { createHash, createHmac } from 'node:crypto';
import { scrape } from '../scrape.js';
import { saveSeo } from '../seo/store.js';
import { clampCrawlLimit, robotsRequired } from '../policy/lockdown.js';
import { AdaptiveTracker } from './adaptive.js';
import { getRobots } from '../discover/robots.js';
import { makeScope, queryTerms, scoreUrl, type ScopeOptions } from '../discover/scope.js';
import { AdaptiveLimiter, HostGate, defaultConcurrency } from '../util/pool.js';
import { normalizeUrl } from '../util/url.js';
import { log } from '../util/log.js';
import type { ScrapeFormat, ScrapeOptions } from '../types.js';
import {
  claim,
  createJob,
  enqueue,
  getJob,
  jobCounts,
  listJobs,
  markState,
  resetActive,
  savePage,
  hasContentHash,
  getPageHash,
  resetDoneForRecrawl,
  setJobStatus,
  setJobNote,
  touchJob,
  type CrawlStrategy,
  type FrontierItem,
} from './store.js';

export interface CrawlOptions extends Omit<ScopeOptions, 'root'> {
  /** Maximum pages to fetch. Default 100. */
  limit?: number;
  /** How many links deep to follow. 0 means the given URLs only. Default 3. */
  maxDepth?: number;
  /** Frontier order. "best-first" needs `query`. Default "bfs". */
  strategy?: CrawlStrategy;
  /** Max pages in flight overall. Defaults to CPU-derived value, adapts to memory. */
  concurrency?: number;
  /** Max pages in flight per host. Default 3. */
  perHostConcurrency?: number;
  /** Minimum gap between requests to one host, in ms. robots Crawl-delay wins if larger. */
  delayMs?: number;
  /** Obey robots.txt. Default true. */
  respectRobots?: boolean;
  /** Skip pages whose content is byte-identical to a page already stored. Default true. */
  deduplicateContent?: boolean;
  /** Steers best-first ordering, and filters each page's markdown when set. */
  query?: string;
  /** Passed through to `scrape` for every page. */
  scrapeOptions?: ScrapeOptions;
  /** POST progress events here. Signed with HMAC-SHA256 when `secret` is set. */
  webhook?: { url: string; secret?: string; events?: WebhookEvent[] };
  /** Stop as soon as `query` looks answered, instead of running to `limit`.
   *  Needs `query`. Reports why it stopped. */
  adaptive?: boolean;
  /** Pages without improvement before adaptive gives up. Default 6. */
  adaptivePatience?: number;
  /** Collect per-page SEO signals and the internal link graph, so `seo_audit`,
   *  `link_graph` and `broken_links` can run over this crawl afterwards.
   *  Default true: it reuses the parse the extractor already does, and without
   *  it those tools have nothing to read. */
  seo?: boolean;
}

export type WebhookEvent = 'started' | 'page' | 'completed' | 'failed';

interface RunHandle {
  cancelled: boolean;
  promise: Promise<void>;
}

const running = new Map<string, RunHandle>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The crawler needs links to walk; make sure they are always collected. */
function scrapeOptionsFor(options: CrawlOptions): ScrapeOptions {
  const base = options.scrapeOptions ?? {};
  const formats = new Set<ScrapeFormat>(base.formats ?? ['markdown']);
  if ((options.maxDepth ?? 3) > 0) formats.add('links');
  return {
    ...base,
    formats: [...formats],
    query: base.query ?? options.query,
    collectSeo: options.seo !== false,
  };
}

async function fireWebhook(
  options: CrawlOptions,
  event: WebhookEvent,
  payload: Record<string, unknown>,
): Promise<void> {
  const hook = options.webhook;
  if (!hook?.url) return;
  if (hook.events && !hook.events.includes(event)) return;

  const body = JSON.stringify({ event, at: new Date().toISOString(), ...payload });
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-openscrape-event': event,
  };
  if (hook.secret) {
    headers['x-openscrape-signature'] =
      'sha256=' + createHmac('sha256', hook.secret).update(body).digest('hex');
  }

  try {
    await fetch(hook.url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    log.debug('webhook failed', { event, error: String(err) });
  }
}

/* ------------------------------------------------------------------ */
/* Starting jobs                                                       */
/* ------------------------------------------------------------------ */

export function startCrawl(rootUrl: string, options: CrawlOptions = {}): string {
  const root = normalizeUrl(rootUrl);
  const jobId = createJob('crawl', root, options as unknown as Record<string, unknown>);
  enqueue(jobId, [{ url: root, depth: 0, score: 0 }]);
  launch(jobId, root, options);
  return jobId;
}

export function startBatch(urls: string[], options: CrawlOptions = {}): string {
  const cleaned: FrontierItem[] = [];
  for (const url of urls) {
    try {
      cleaned.push({ url: normalizeUrl(url), depth: 0 });
    } catch {
      /* skip unparseable input */
    }
  }
  if (cleaned.length === 0) throw new Error('No valid http(s) URLs were given.');

  // A batch is a crawl that never follows links.
  const batchOptions: CrawlOptions = {
    ...options,
    maxDepth: 0,
    limit: options.limit ?? cleaned.length,
    allowExternal: true,
  };
  const jobId = createJob('batch', cleaned[0].url, batchOptions as unknown as Record<string, unknown>);
  enqueue(jobId, cleaned);
  launch(jobId, cleaned[0].url, batchOptions);
  return jobId;
}

/** Puts an interrupted job back to work, e.g. after the server restarted. */
export function resumeJob(jobId: string): boolean {
  const job = getJob(jobId);
  if (!job) return false;
  if (running.has(jobId)) return true;
  if (job.status === 'completed' || job.status === 'cancelled') return false;

  resetActive(jobId);
  launch(jobId, job.rootUrl, job.options as CrawlOptions);
  return true;
}


/**
 * Re-runs a finished job over the URLs it already found.
 *
 * Only the pages that actually changed are re-stored; the rest answer 304 and
 * cost a few hundred bytes each. `discover` re-enables link following if you
 * also want pages added since the original crawl.
 */
export function startRecrawl(jobId: string, opts: { discover?: boolean } = {}): number | null {
  const job = getJob(jobId);
  if (!job) return null;
  if (running.has(jobId)) return null;

  const requeued = resetDoneForRecrawl(jobId);
  if (requeued === 0) return 0;

  const previous = job.options as CrawlOptions;
  const options: CrawlOptions = {
    ...previous,
    maxDepth: opts.discover ? (previous.maxDepth ?? 3) : 0,
    limit: Math.max(previous.limit ?? 100, requeued),
    deduplicateContent: false, // we compare against the stored page instead
    scrapeOptions: { ...(previous.scrapeOptions ?? {}), maxAge: 0, revalidate: true },
  };

  launch(jobId, job.rootUrl, options);
  return requeued;
}

export function cancelJob(jobId: string): boolean {
  const handle = running.get(jobId);
  if (handle) handle.cancelled = true;
  const job = getJob(jobId);
  if (!job) return false;
  if (job.status === 'running' || job.status === 'queued') {
    setJobStatus(jobId, 'cancelled');
    resetActive(jobId);
  }
  return true;
}

export function isRunning(jobId: string): boolean {
  return running.has(jobId);
}

/** Marks jobs left mid-flight by a previous process, so status is never a lie. */
export function reconcileInterruptedJobs(): number {
  let touched = 0;
  for (const job of listJobs(100)) {
    if ((job.status === 'running' || job.status === 'queued') && !running.has(job.id)) {
      setJobStatus(job.id, 'interrupted');
      resetActive(job.id);
      touched++;
    }
  }
  return touched;
}

function launch(jobId: string, rootUrl: string, options: CrawlOptions): void {
  const handle: RunHandle = { cancelled: false, promise: Promise.resolve() };
  running.set(jobId, handle);
  handle.promise = runLoop(jobId, rootUrl, options, handle)
    .catch((err) => {
      log.error('crawl loop crashed', { jobId, error: String(err) });
      setJobStatus(jobId, 'failed', String(err));
    })
    .finally(() => {
      running.delete(jobId);
    });
}

/* ------------------------------------------------------------------ */
/* The loop                                                            */
/* ------------------------------------------------------------------ */

async function runLoop(
  jobId: string,
  rootUrl: string,
  options: CrawlOptions,
  handle: RunHandle,
): Promise<void> {
  // Operator policy first: a lockdown cap on pages, and robots.txt made
  // non-negotiable, both override whatever the caller asked for.
  const requested = options.limit ?? 100;
  const capped = clampCrawlLimit(requested);
  if (capped.clamped) log.warn('crawl limit clamped by lockdown', { jobId, note: capped.clamped });
  const limit = capped.limit;

  const maxDepth = options.maxDepth ?? 3;
  const strategy: CrawlStrategy = options.strategy ?? (options.query ? 'best-first' : 'bfs');
  const respectRobots = robotsRequired() || options.respectRobots !== false;
  const dedupe = options.deduplicateContent !== false;
  const terms = options.query ? queryTerms(options.query) : [];
  const scrapeOpts = scrapeOptionsFor(options);

  const scope = makeScope({ ...options, root: rootUrl });
  const limiter = new AdaptiveLimiter(options.concurrency ?? defaultConcurrency());
  const gate = new HostGate(options.perHostConcurrency ?? 3, options.delayMs ?? 0);

  const robotsFor = async (url: string) =>
    respectRobots ? await getRobots(url, scrapeOpts.timeout ?? 15_000) : null;

  setJobStatus(jobId, 'running');

  // Tell the operator up front when politeness will dominate the runtime:
  // a site declaring Crawl-delay: 30 makes 10 pages take five minutes.
  const rootRobots = await robotsFor(rootUrl);
  const rootDelay = Math.max(options.delayMs ?? 0, rootRobots?.crawlDelayMs ?? 0);
  if (rootDelay > 0) {
    log.info('crawl is rate-limited by politeness', {
      jobId,
      host: hostOf(rootUrl),
      delayMs: rootDelay,
      estimatedSeconds: Math.round((rootDelay * limit) / 1000),
    });
  }

  // Adaptive crawling needs a query to be adaptive about. Asking for it
  // without one is a mistake worth naming rather than silently ignoring.
  let adaptive: AdaptiveTracker | undefined;
  if (options.adaptive) {
    if (!options.query) {
      log.warn('adaptive crawling needs a query; running to the page limit instead', { jobId });
    } else {
      const tracker = new AdaptiveTracker(options.query, { patience: options.adaptivePatience });
      if (tracker.usable()) {
        adaptive = tracker;
        log.info('adaptive crawl', { jobId, query: options.query, limit });
      } else {
        log.warn('adaptive crawling: the query has no usable terms', { jobId, query: options.query });
      }
    }
  }

  await fireWebhook(options, 'started', { jobId, rootUrl, limit, crawlDelayMs: rootDelay });

  let completed = jobCounts(jobId).completed;
  let inFlight = 0;
  const active = new Set<Promise<void>>();

  let adaptiveStop: string | null = null;

  while (!handle.cancelled) {
    const counts = jobCounts(jobId);
    if (completed + inFlight >= limit) {
      if (inFlight === 0) break;
    } else if (counts.pending === 0 && inFlight === 0) {
      break;
    }

    // Checked between batches rather than mid-page: pages already in flight
    // are allowed to finish, so the corpus never has a half-stored page in it.
    if (adaptive) {
      const verdict = adaptive.done();
      if (verdict.stop) {
        adaptiveStop = verdict.reason;
        if (inFlight === 0) break;
        await Promise.race([...active, sleep(50)]);
        continue;
      }
    }

    const budget = Math.min(
      Math.max(0, limiter.limit() - inFlight),
      Math.max(0, limit - completed - inFlight),
    );

    const batch = budget > 0 ? claim(jobId, budget, strategy) : [];

    if (batch.length === 0) {
      if (inFlight === 0 && jobCounts(jobId).pending === 0) break;
      await Promise.race([...active, sleep(120)]);
      continue;
    }

    let started = 0;
    let gated = 0;

    for (const item of batch) {
      const host = hostOf(item.url);
      const robots = await robotsFor(item.url);
      const delay = Math.max(options.delayMs ?? 0, robots?.crawlDelayMs ?? 0);

      if (robots && !robots.isAllowed(item.url)) {
        markState(jobId, item.url, 'skipped', 'robots-disallow');
        continue;
      }
      if (!gate.canStart(host, delay)) {
        // Put it back and let another host go first.
        markState(jobId, item.url, 'pending');
        gated++;
        continue;
      }

      gate.start(host, delay);
      started++;
      inFlight++;

      const task = (async () => {
        try {
          await visit(jobId, item, {
            scope,
            maxDepth,
            terms,
            strategy,
            scrapeOpts,
            dedupe,
            options,
            adaptive,
          });
          completed++;
        } catch (err) {
          markState(jobId, item.url, 'failed', String(err));
          log.debug('crawl page failed', { url: item.url, error: String(err) });
        } finally {
          gate.finish(host);
          inFlight--;
          touchJob(jobId);
        }
      })();

      active.add(task);
      void task.finally(() => active.delete(task));
    }

    // If the per-host gate turned everything away we must not immediately
    // re-claim the same URLs: that is a hot spin that pins a CPU core while
    // the pages already in flight do the real work.
    if (started === 0 && gated > 0) {
      await Promise.race([...active, sleep(150)]);
      continue;
    }

    if (active.size > 0 && inFlight >= limiter.limit()) {
      await Promise.race([...active]);
    }
  }

  await Promise.allSettled([...active]);

  const finalCounts = jobCounts(jobId);
  if (handle.cancelled) {
    setJobStatus(jobId, 'cancelled');
    await fireWebhook(options, 'failed', { jobId, reason: 'cancelled', counts: finalCounts });
  } else {
    setJobStatus(jobId, 'completed');
    await fireWebhook(options, 'completed', {
      jobId,
      counts: finalCounts,
      ...(adaptiveStop ? { adaptive: adaptive?.state() } : {}),
    });
  }

  // An adaptive crawl that stops at page 12 of a 500-page budget looks like a
  // failure unless it says why. The reason is stored on the job, so it shows up
  // in crawl_status long after the log line has scrolled away.
  if (adaptiveStop) {
    // The decision was made after N observed pages, but pages already in
    // flight were allowed to finish, so the stored count can be higher. Saying
    // so stops that gap from looking like an off-by-one bug.
    const observed = adaptive?.state().pages ?? 0;
    const extra = Math.max(0, finalCounts.completed - observed);
    const tail = extra > 0 ? ` (${extra} more page(s) already in flight finished too)` : '';
    setJobNote(jobId, `Adaptive: ${adaptiveStop}${tail}`);
    log.info('adaptive crawl stopped early', { jobId, reason: adaptiveStop, ...adaptive?.state() });
  } else if (adaptive) {
    const s = adaptive.state();
    setJobNote(
      jobId,
      `Adaptive: ran to the end without being satisfied. ` +
        `Covered ${s.covered.length}/${s.covered.length + s.missing.length} query terms` +
        (s.missing.length ? ` (missing: ${s.missing.join(', ')})` : '') +
        `, best passage scored ${s.bestScore}.`,
    );
  }

  log.info('crawl finished', { jobId, ...finalCounts });
}

interface VisitContext {
  scope: ReturnType<typeof makeScope>;
  maxDepth: number;
  terms: string[];
  strategy: CrawlStrategy;
  scrapeOpts: ScrapeOptions;
  dedupe: boolean;
  options: CrawlOptions;
  /** Present only for an adaptive crawl; watches what each page contributes. */
  adaptive?: AdaptiveTracker;
}

async function visit(jobId: string, item: FrontierItem, ctx: VisitContext): Promise<void> {
  const result = await scrape(item.url, ctx.scrapeOpts);

  if (!result.success && result.error) {
    markState(jobId, item.url, 'failed', result.error);
    return;
  }

  const body = result.markdown ?? result.text ?? '';
  const hash = createHash('sha1').update(body).digest('hex');

  // Scored before the dedupe and unchanged shortcuts below: a page that is a
  // duplicate still tells us whether the question is answered, and skipping
  // the observation would make the crawl look like it had stalled.
  ctx.adaptive?.observe(result.url, body);

  if (ctx.dedupe && body.length > 200) {
    const twin = hasContentHash(jobId, hash);
    if (twin && twin !== item.url) {
      markState(jobId, item.url, 'skipped', `duplicate-of:${twin}`);
      return;
    }
  }

  const previousHash = getPageHash(jobId, item.url);
  if (previousHash === hash) {
    // Byte-identical to what we already hold: nothing to rewrite.
    markState(jobId, item.url, 'done', 'unchanged');
    return;
  }

  savePage(jobId, {
    url: result.url,
    status: result.metadata.statusCode,
    title: result.metadata.title,
    description: result.metadata.description,
    markdown: body,
    chars: body.length,
    depth: item.depth,
    contentHash: hash,
    renderedWith: result.metadata.renderedWith,
    // Carry the capture date through, so the corpus knows this body is old and
    // whose copy it is. `status` above is already the live one, which for an
    // archive-served page is the failure that sent us there.
    archivedOn: result.metadata.archive?.capturedOn,
  });

  // The SEO row and the page's outbound edges. Stored against the URL the page
  // was *reached* at, so the link graph lines up with what links point to.
  if (result.seo) {
    try {
      saveSeo(jobId, {
        url: result.url,
        status: result.metadata.statusCode,
        depth: item.depth,
        signals: result.seo,
        redirectChain: result.metadata.redirectChain,
      });
    } catch (err) {
      // An audit row is worth less than the crawl: never fail a page over it.
      log.warn('could not store seo row', { url: result.url, error: String(err) });
    }
  }
  markState(jobId, item.url, 'done', previousHash ? 'changed' : undefined);

  await fireWebhook(ctx.options, 'page', {
    jobId,
    url: result.url,
    title: result.metadata.title,
    chars: body.length,
    depth: item.depth,
  });

  // Follow links.
  if (item.depth >= ctx.maxDepth || !result.links?.length) return;

  const next: FrontierItem[] = [];
  for (const link of result.links) {
    if (!ctx.scope.inScope(link).ok) continue;
    next.push({
      url: link,
      depth: item.depth + 1,
      score: ctx.strategy === 'best-first' ? scoreUrl(link, ctx.terms) : 0,
      parent: item.url,
    });
  }
  if (next.length) enqueue(jobId, next);
}
