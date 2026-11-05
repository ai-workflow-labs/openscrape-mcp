import { createHmac } from 'node:crypto';
import { scrape } from '../scrape.js';
import { log } from '../util/log.js';
import type { ScrapeOptions } from '../types.js';
import {
  DEFAULT_MAX_DIFF_CHARS,
  DEFAULT_MAX_SNAPSHOT_CHARS,
  createMonitor,
  dueMonitors,
  earliestNextCheck,
  getMonitor,
  latestBaseline,
  listMonitors,
  recordCheck,
  repairSchedules,
  seedBaseline,
  setNextCheck,
  getSnapshot,
  putSnapshot,
  type CheckRecord,
  type CreateMonitorInput,
  type MonitorEvent,
  type MonitorRecord,
  type MonitorWebhook,
} from './store.js';
import { diffContent, hashContent, type ContentDiff, type DiffOptions } from './diff.js';

/**
 * Running and scheduling monitor checks.
 *
 * Firecrawl bills 1–7 credits per page per check, which makes a ten-minute
 * monitor an expensive subscription. Here a check is one local fetch plus a
 * SHA-256 compare, so the only cost is bandwidth.
 *
 * Scheduling is a single `setTimeout` that always points at the earliest
 * `next_check_at` in SQLite — no cron library, and no in-memory timer per
 * monitor to lose on restart. The wake-up is also capped at a minute so a
 * monitor created while the timer is armed is picked up promptly.
 */

/** Never sleep longer than this, so newly added monitors are noticed. */
const MAX_SLEEP_MS = 60_000;

let timer: NodeJS.Timeout | null = null;
let ticking = false;
const inFlight = new Set<string>();

/* ------------------------------------------------------------------ */
/* Webhooks                                                            */
/* ------------------------------------------------------------------ */

/**
 * Same convention as the crawler's webhook: JSON body, `x-openscrape-event`,
 * and `x-openscrape-signature: sha256=<hex>` over the exact body bytes.
 */
async function fireWebhook(
  hook: MonitorWebhook | undefined,
  event: MonitorEvent,
  payload: Record<string, unknown>,
): Promise<void> {
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
    log.debug('monitor webhook failed', { event, error: String(err) });
  }
}

/* ------------------------------------------------------------------ */
/* changeTracking                                                      */
/* ------------------------------------------------------------------ */

export interface ChangeTrackingOptions extends DiffOptions {
  /** Separate baseline lane for the same URL (e.g. one per scrape preset). */
  tag?: string;
  /** Store this content as the new baseline. Default true. */
  store?: boolean;
  /** Cap on the stored baseline. Default 60000. */
  maxSnapshotChars?: number;
}

export interface ChangeTracking {
  url: string;
  changed: boolean;
  /** True when there was no stored version to compare against. */
  first: boolean;
  /** Hash of the content passed in. */
  hash: string;
  previousHash?: string;
  previousAt?: number;
  diff?: ContentDiff;
}

/**
 * Firecrawl's `changeTracking` scrape format, as a standalone function: give
 * it a URL and the content you just fetched, and it tells you whether that
 * URL changed since the last time it was seen. Independent of monitors, so
 * `scrape` can call it directly once wired up.
 */
export function changeTracking(
  url: string,
  content: string,
  options: ChangeTrackingOptions = {},
): ChangeTracking {
  const hash = hashContent(content);
  const previous = getSnapshot(url, options.tag);
  const maxSnapshotChars = options.maxSnapshotChars ?? DEFAULT_MAX_SNAPSHOT_CHARS;

  const result: ChangeTracking = {
    url,
    changed: false,
    first: previous === null,
    hash,
    previousHash: previous?.hash,
    previousAt: previous?.capturedAt,
  };

  if (previous && previous.hash !== hash) {
    result.changed = true;
    result.diff = diffContent(previous.content, content, options);
  }

  if (options.store !== false && (!previous || previous.hash !== hash)) {
    putSnapshot(url, content.slice(0, maxSnapshotChars), hash, options.tag);
  }

  return result;
}

/* ------------------------------------------------------------------ */
/* Checks                                                              */
/* ------------------------------------------------------------------ */

export interface CheckOutcome {
  monitor: MonitorRecord;
  check: CheckRecord;
  diff?: ContentDiff;
}

function scrapeOptionsFor(monitor: MonitorRecord): ScrapeOptions {
  const base = monitor.options.scrapeOptions ?? {};
  return {
    ...base,
    formats: base.formats?.length ? base.formats : ['markdown'],
    // A monitor that reads its own cache would never see a change.
    maxAge: base.maxAge ?? 0,
  };
}

/** Pulls the comparable text out of a scrape result. */
function contentOf(result: { markdown?: string; text?: string; html?: string }): string {
  return result.markdown ?? result.text ?? result.html ?? '';
}

/**
 * Fetches the page, compares it with the stored baseline, writes the check
 * and re-arms the schedule. Returns null when the monitor does not exist or a
 * check for it is already running.
 */
export async function runCheck(monitorId: string): Promise<CheckOutcome | null> {
  const monitor = getMonitor(monitorId);
  if (!monitor) return null;
  if (inFlight.has(monitorId)) {
    log.debug('monitor check already running', monitorId);
    return null;
  }
  inFlight.add(monitorId);

  const maxDiffChars = monitor.options.maxDiffChars ?? DEFAULT_MAX_DIFF_CHARS;
  const maxSnapshotChars = monitor.options.maxSnapshotChars ?? DEFAULT_MAX_SNAPSHOT_CHARS;
  const hook = monitor.options.webhook;

  try {
    const result = await scrape(monitor.url, scrapeOptionsFor(monitor));

    if (!result.success) {
      const check = recordCheck({
        monitorId,
        status: result.metadata?.statusCode,
        changed: false,
        summary: 'check failed',
        error: result.error ?? 'scrape failed',
      });
      setNextCheck(monitorId, Date.now() + monitor.intervalMs);
      await fireWebhook(hook, 'error', {
        monitorId,
        url: monitor.url,
        checkId: check.id,
        error: check.error,
      });
      arm();
      return { monitor: getMonitor(monitorId)!, check };
    }

    const content = contentOf(result);
    const hash = hashContent(content);
    const baseline = latestBaseline(monitorId);
    const changed = baseline !== null && baseline.hash !== hash;
    const diff = changed ? diffContent(baseline.content, content, { maxDiffChars }) : undefined;

    const check = recordCheck({
      monitorId,
      status: result.metadata?.statusCode,
      changed,
      baseline: baseline === null,
      contentHash: hash,
      previousHash: baseline?.hash,
      chars: content.length,
      addedLines: diff?.addedLines ?? 0,
      removedLines: diff?.removedLines ?? 0,
      summary: baseline === null ? 'baseline captured' : (diff?.summary ?? 'no change'),
      characterization: diff?.characterization,
      diff: diff?.diff,
      diffTruncatedChars: diff?.truncated ? diff.truncatedChars : undefined,
      // Only keep a new snapshot when the content actually moved: an unchanged
      // check can keep diffing against the baseline it already has.
      snapshot:
        baseline === null || changed ? content.slice(0, maxSnapshotChars) : undefined,
    });

    setNextCheck(monitorId, Date.now() + monitor.intervalMs);

    if (changed) {
      await fireWebhook(hook, 'changed', {
        monitorId,
        url: monitor.url,
        checkId: check.id,
        hash,
        previousHash: baseline?.hash,
        addedLines: check.addedLines,
        removedLines: check.removedLines,
        summary: check.summary,
        characterization: check.characterization,
        diff: check.diff,
      });
    }
    await fireWebhook(hook, 'checked', {
      monitorId,
      url: monitor.url,
      checkId: check.id,
      changed,
      hash,
      summary: check.summary,
    });

    arm();
    return { monitor: getMonitor(monitorId)!, check, diff };
  } catch (err) {
    const check = recordCheck({
      monitorId,
      changed: false,
      summary: 'check failed',
      error: String(err),
    });
    setNextCheck(monitorId, Date.now() + monitor.intervalMs);
    await fireWebhook(hook, 'error', {
      monitorId,
      url: monitor.url,
      checkId: check.id,
      error: String(err),
    });
    arm();
    return { monitor: getMonitor(monitorId)!, check };
  } finally {
    inFlight.delete(monitorId);
  }
}

/**
 * Runs every monitor that is currently due, one at a time so a batch of them
 * does not open a dozen browsers at once. Safe to call from a cron job, a
 * test, or the in-process timer.
 */
export async function runDueMonitors(now = Date.now()): Promise<CheckOutcome[]> {
  const due = dueMonitors(now);
  const outcomes: CheckOutcome[] = [];
  for (const monitor of due) {
    const outcome = await runCheck(monitor.id);
    if (outcome) outcomes.push(outcome);
  }
  return outcomes;
}

/* ------------------------------------------------------------------ */
/* Scheduling                                                          */
/* ------------------------------------------------------------------ */

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await runDueMonitors();
  } catch (err) {
    log.warn('monitor tick failed', String(err));
  } finally {
    ticking = false;
    arm();
  }
}

/** Points the single timer at the earliest due monitor. */
function arm(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const next = earliestNextCheck();
  if (next === null) return;

  const delay = Math.min(MAX_SLEEP_MS, Math.max(0, next - Date.now()));
  timer = setTimeout(() => void tick(), delay);
  // Monitoring should not be the reason the process stays alive.
  timer.unref?.();
}

export interface ResumeReport {
  active: number;
  due: number;
  repaired: number;
  nextCheckAt: number | null;
}

/**
 * Call this once at startup. It repairs any active monitor that lost its
 * `next_check_at`, arms the timer, and reports what is pending. Monitors that
 * fell due while the server was down are picked up by the first tick.
 */
export function resumeMonitors(): ResumeReport {
  const repaired = repairSchedules();
  const due = dueMonitors().length;
  const active = listMonitors(1000).filter((m) => m.status === 'active').length;
  arm();
  const report: ResumeReport = { active, due, repaired, nextCheckAt: earliestNextCheck() };
  if (active > 0) {
    log.info(
      `monitors resumed: ${active} active, ${due} due now` +
        (repaired ? `, ${repaired} rescheduled` : ''),
    );
  }
  return report;
}

/** Stops the in-process timer. Monitors stay in SQLite and resume on restart. */
export function stopMonitorScheduler(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/* ------------------------------------------------------------------ */
/* Convenience                                                         */
/* ------------------------------------------------------------------ */

/** Creates a monitor and arms the scheduler for it. */
export function startMonitor(input: CreateMonitorInput): MonitorRecord {
  const monitor = createMonitor(input);
  arm();
  return monitor;
}

/**
 * Stores `content` as a monitor's baseline without fetching anything. Lets a
 * caller start from content it already has — and lets a test prove the diff
 * path by seeding a deliberately modified previous version.
 */
export function setMonitorBaseline(monitorId: string, content: string): CheckRecord | null {
  const monitor = getMonitor(monitorId);
  if (!monitor) return null;
  const maxSnapshotChars = monitor.options.maxSnapshotChars ?? DEFAULT_MAX_SNAPSHOT_CHARS;
  return seedBaseline(monitorId, content.slice(0, maxSnapshotChars), hashContent(content));
}
