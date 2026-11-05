/**
 * Persistent browser sessions — our free replacement for Firecrawl's
 * `interact` endpoint (which bills 2 credits per browser minute).
 *
 * A session is one real Chromium page kept alive across tool calls, so a model
 * can log in, navigate, fill a form, click through a wizard and then read the
 * result with all the state in between preserved. Because the MCP server is
 * long-lived, every session carries an idle deadline and closes itself; a
 * leaked session is a leaked Chromium process.
 *
 * Concurrency: calls against one session are serialised through a promise
 * chain, because two interleaved `page.click()` sequences on the same page are
 * never what the caller meant.
 */
import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright';
import { log } from '../util/log.js';
import { extractFromHtml } from '../extract/pipeline.js';
import {
  acquireContext,
  closeProfileContexts,
  runPageActions,
  scanFullPage,
  settlePage,
  type AcquiredContext,
  type ScanFullPageOptions,
  type ScanFullPageReport,
} from '../fetcher/browser.js';
import type { PageAction } from '../types.js';

/** `PageAction` plus the session-only full-page scan. */
export type SessionAction =
  | PageAction
  | ({ type: 'scanFullPage' } & ScanFullPageOptions);

export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;
const MIN_IDLE_TIMEOUT_MS = 5_000;
const MAX_IDLE_TIMEOUT_MS = 2 * 60 * 60_000;
const MAX_SESSIONS = 8;
const GRAVEYARD_SIZE = 40;

export interface OpenSessionOptions {
  /** Navigate here right after opening. */
  url?: string;
  /** Use a persistent, possibly logged-in profile. */
  profile?: string;
  /** Show the window (profiles only) so a human can sign in by hand. */
  headful?: boolean;
  mobile?: boolean;
  viewport?: { width: number; height: number };
  proxy?: string;
  headers?: Record<string, string>;
  /** Close the session after this long with no calls. Default 10 minutes. */
  idleTimeoutMs?: number;
  /** Drop images/media/fonts. Default false: sessions usually want to see the page. */
  blockResources?: boolean;
  /** Wait for this selector after the initial navigation. */
  waitForSelector?: string;
  /** Extra settle time after the initial navigation, in ms. */
  waitFor?: number;
  /** Scan to the bottom right after the initial navigation. */
  scanFullPage?: boolean | ScanFullPageOptions;
  /** Free-text note echoed back by `listSessions`, to tell sessions apart. */
  label?: string;
  /** Navigation timeout in ms. Default 45000. */
  timeout?: number;
}

interface SessionRecord {
  id: string;
  page: Page;
  ctx: AcquiredContext;
  createdAt: number;
  lastUsedAt: number;
  calls: number;
  idleTimeoutMs: number;
  timer: NodeJS.Timeout | null;
  queue: Promise<unknown>;
  /** In-flight calls. The idle timer never closes a session that is mid-action. */
  busy: number;
  closing: boolean;
  label?: string;
}

export interface SessionInfo {
  id: string;
  url: string;
  title?: string;
  profile?: string;
  /** False when a visible window is on screen. */
  headless: boolean;
  label?: string;
  createdAt: string;
  ageMs: number;
  idleMs: number;
  idleTimeoutMs: number;
  /** ms until the idle deadline closes this session. */
  closesInMs: number;
  calls: number;
}

export interface ClosedSessionNote {
  id: string;
  reason: string;
  at: string;
  lastUrl: string;
  calls: number;
}

const sessions = new Map<string, SessionRecord>();
/** Why recently-closed sessions went away, so tool output can say so instead of "unknown id". */
const graveyard = new Map<string, ClosedSessionNote>();

function remember(note: ClosedSessionNote): void {
  graveyard.set(note.id, note);
  while (graveyard.size > GRAVEYARD_SIZE) {
    const oldest = graveyard.keys().next();
    if (oldest.done) break;
    graveyard.delete(oldest.value);
  }
}

export function closedSessionNote(id: string): ClosedSessionNote | undefined {
  return graveyard.get(id);
}

export function recentlyClosedSessions(): ClosedSessionNote[] {
  return [...graveyard.values()].reverse();
}

function clampIdle(ms: number | undefined): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return DEFAULT_IDLE_TIMEOUT_MS;
  return Math.min(MAX_IDLE_TIMEOUT_MS, Math.max(MIN_IDLE_TIMEOUT_MS, Math.trunc(ms)));
}

function armIdleTimer(rec: SessionRecord): void {
  if (rec.timer) clearTimeout(rec.timer);
  rec.timer = setTimeout(() => {
    rec.timer = null;
    if (rec.busy > 0) {
      // A call is still running, so the session is not idle. Check again later.
      armIdleTimer(rec);
      return;
    }
    void closeSession(rec.id, `idle for ${Math.round(rec.idleTimeoutMs / 1000)}s (idle timeout)`);
  }, rec.idleTimeoutMs);
  // Never let a parked session hold the process open.
  rec.timer.unref?.();
}

function touch(rec: SessionRecord): void {
  rec.lastUsedAt = Date.now();
  rec.calls++;
  armIdleTimer(rec);
}

/** Thrown when a session id is not live; carries the closure reason when we know it. */
export class NoSuchSessionError extends Error {
  readonly note?: ClosedSessionNote;
  constructor(id: string) {
    const note = graveyard.get(id);
    super(
      note
        ? `Session ${id} was closed at ${note.at}: ${note.reason}. Open a new one with interact_open.`
        : `No session ${id}. It never existed, or the server restarted. Use interact_sessions to list live sessions.`,
    );
    this.name = 'NoSuchSessionError';
    this.note = note;
  }
}

function require_(id: string): SessionRecord {
  const rec = sessions.get(id);
  if (!rec || rec.closing) throw new NoSuchSessionError(id);
  return rec;
}

/** Serialises work on one session and keeps its idle deadline fresh. */
async function withSession<T>(id: string, fn: (rec: SessionRecord) => Promise<T>): Promise<T> {
  const rec = require_(id);
  // Count the call up front so anything the call reports includes itself, and
  // so a long-running action cannot be killed by the idle timer mid-flight.
  touch(rec);
  rec.busy++;
  const run = rec.queue.then(
    () => fn(rec),
    () => fn(rec),
  );
  // Keep the chain alive even when this call rejects, so later calls still run.
  rec.queue = run.catch(() => undefined);
  const rearm = () => {
    rec.busy = Math.max(0, rec.busy - 1);
    if (sessions.get(id) === rec && !rec.closing) {
      rec.lastUsedAt = Date.now();
      armIdleTimer(rec);
    }
  };
  try {
    const out = await run;
    rearm();
    return out;
  } catch (err) {
    rearm();
    throw err;
  }
}

/** Pages already handed to a session, so a reused profile window is never double-claimed. */
const claimedPages = new WeakSet<Page>();

export interface OpenedSession {
  id: string;
  info: SessionInfo;
  /** Set when the initial navigation ran. */
  status?: number;
  scan?: ScanFullPageReport;
}

export async function openSession(opts: OpenSessionOptions = {}): Promise<OpenedSession> {
  if (sessions.size >= MAX_SESSIONS) {
    throw new Error(
      `Too many open sessions (${sessions.size}/${MAX_SESSIONS}). Close one with interact_stop first.`,
    );
  }
  if (opts.headful && !opts.profile) {
    throw new Error('A visible window needs a `profile`: it is the persistent profile that keeps the sign-in.');
  }

  const ctx = await acquireContext({
    profile: opts.profile,
    headful: opts.headful,
    mobile: opts.mobile,
    proxy: opts.proxy,
    headers: opts.headers,
    blockResources: opts.blockResources ?? false,
    screenshot: opts.viewport ? { viewport: opts.viewport } : undefined,
  });

  let page: Page | undefined;
  try {
    // A fresh persistent context already owns one blank page; reuse it so a
    // visible profile window does not open a second tab in the user's face.
    const spare = ctx.persistent
      ? ctx.context.pages().find((p) => !claimedPages.has(p) && p.url() === 'about:blank')
      : undefined;
    page = spare ?? (await ctx.context.newPage());
    claimedPages.add(page);
    if (opts.viewport) await page.setViewportSize(opts.viewport).catch(() => {});

    const id = `s_${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const rec: SessionRecord = {
      id,
      page,
      ctx,
      createdAt: now,
      lastUsedAt: now,
      calls: 0,
      idleTimeoutMs: clampIdle(opts.idleTimeoutMs),
      timer: null,
      queue: Promise.resolve(),
      busy: 0,
      closing: false,
      label: opts.label,
    };
    sessions.set(id, rec);
    armIdleTimer(rec);

    // The page dying under us (crash, user closing the window) must not leave a ghost.
    page.once('close', () => {
      if (sessions.get(id) === rec && !rec.closing) {
        void closeSession(id, 'the browser page was closed (crash, or the window was closed by hand)');
      }
    });

    let status: number | undefined;
    let scan: ScanFullPageReport | undefined;
    if (opts.url) {
      const response = await page.goto(opts.url, {
        waitUntil: 'domcontentloaded',
        timeout: opts.timeout ?? 45_000,
      });
      status = response?.status();
      await settlePage(page, { waitForSelector: opts.waitForSelector, waitFor: opts.waitFor });
      const scanOpts = opts.scanFullPage === true ? {} : opts.scanFullPage || null;
      if (scanOpts) scan = await scanFullPage(page, scanOpts);
    }

    rec.lastUsedAt = Date.now();
    armIdleTimer(rec);
    log.info(
      `session ${id} open${opts.profile ? ` (profile "${opts.profile}"${ctx.headless ? '' : ', visible'})` : ''} → ${page.url()}`,
    );
    return { id, info: await describe(rec), status, scan };
  } catch (err) {
    // Error paths must not leak a page or a throwaway context.
    if (page) {
      claimedPages.delete(page);
      await page.close().catch(() => {});
    }
    await ctx.release();
    throw err;
  }
}


async function describe(rec: SessionRecord): Promise<SessionInfo> {
  const now = Date.now();
  let title: string | undefined;
  let url = '';
  try {
    url = rec.page.url();
    title = await rec.page.title();
  } catch {
    /* page is going away; report what we have */
  }
  return {
    id: rec.id,
    url,
    title: title || undefined,
    profile: rec.ctx.profile,
    headless: rec.ctx.headless,
    label: rec.label,
    createdAt: new Date(rec.createdAt).toISOString(),
    ageMs: now - rec.createdAt,
    idleMs: now - rec.lastUsedAt,
    idleTimeoutMs: rec.idleTimeoutMs,
    closesInMs: Math.max(0, rec.lastUsedAt + rec.idleTimeoutMs - now),
    calls: rec.calls,
  };
}

export function listSessions(): Promise<SessionInfo[]> {
  return Promise.all([...sessions.values()].filter((r) => !r.closing).map(describe));
}

export function sessionCount(): number {
  return [...sessions.values()].filter((r) => !r.closing).length;
}

export function sessionInfo(id: string): Promise<SessionInfo> {
  return withSession(id, (rec) => describe(rec));
}

export async function closeSession(id: string, reason = 'closed by request'): Promise<boolean> {
  const rec = sessions.get(id);
  if (!rec || rec.closing) return false;
  rec.closing = true;
  if (rec.timer) {
    clearTimeout(rec.timer);
    rec.timer = null;
  }
  sessions.delete(id);

  let lastUrl = '';
  try {
    lastUrl = rec.page.url();
  } catch {
    /* already gone */
  }
  claimedPages.delete(rec.page);
  await rec.page.close().catch(() => {});
  await rec.ctx.release();

  remember({ id, reason, at: new Date().toISOString(), lastUrl, calls: rec.calls });
  log.info(`session ${id} closed: ${reason}`);
  return true;
}

export async function closeAllSessions(reason = 'closed by request'): Promise<number> {
  const ids = [...sessions.keys()];
  let closed = 0;
  for (const id of ids) {
    if (await closeSession(id, reason)) closed++;
  }
  return closed;
}

/**
 * Shutdown hook for the parent process: kills every session, then releases the
 * persistent profile contexts (which is what flushes their cookies to disk).
 * Call it alongside `closeBrowser()`.
 */
export async function shutdownSessions(reason = 'server shutting down'): Promise<void> {
  const sessionsClosed = await closeAllSessions(reason);
  const profilesClosed = await closeProfileContexts();
  if (sessionsClosed || profilesClosed) {
    log.info(`interact shutdown: ${sessionsClosed} session(s), ${profilesClosed} profile context(s)`);
  }
}

// ---------------------------------------------------------------------------
// Acting on a session
// ---------------------------------------------------------------------------

export interface ActionOutcome {
  index: number;
  type: string;
  ok: boolean;
  /** One-line human summary of what happened. */
  detail?: string;
  error?: string;
  /** `data:image/png;base64,...` for a screenshot action. */
  screenshot?: string;
  /** Return value of an executeJavascript action. */
  value?: unknown;
  /** Markdown for a `scrape` action. */
  markdown?: string;
  scan?: ScanFullPageReport;
}

export interface ActResult {
  outcomes: ActionOutcome[];
  /** Index of the action that failed, when one did; everything after it was skipped. */
  failedAt?: number;
  info: SessionInfo;
}

export interface ActOptions {
  /** Cap markdown produced by `scrape` actions. Default 4000. */
  maxChars?: number;
  onlyMainContent?: boolean;
}

function describeAction(a: SessionAction): string {
  switch (a.type) {
    case 'click':
      return `click ${a.selector}${a.all ? ' (all matches)' : ''}`;
    case 'write':
      return a.selector ? `write ${a.text.length} chars into ${a.selector}` : `type ${a.text.length} chars`;
    case 'press':
      return `press ${a.key}`;
    case 'scroll':
      return `scroll ${a.direction ?? 'down'} x${a.amount ?? 1}`;
    case 'wait':
      return a.selector ? `wait for ${a.selector}` : `wait ${a.milliseconds ?? 1000}ms`;
    case 'navigate':
      return `navigate ${a.url}`;
    case 'executeJavascript':
      return 'executeJavascript';
    case 'screenshot':
      return a.fullPage ? 'screenshot (full page)' : 'screenshot (viewport)';
    case 'scrape':
      return 'scrape page';
    case 'scanFullPage':
      return 'scan full page';
    default:
      return 'unknown action';
  }
}

/**
 * Runs actions in order against a live session, stopping at the first failure
 * and reporting exactly which steps ran. Each action delegates to the same
 * runner the one-shot scrape path uses, so the vocabulary cannot drift.
 */
export function actOnSession(
  id: string,
  actions: SessionAction[],
  opts: ActOptions = {},
): Promise<ActResult> {
  return withSession(id, async (rec) => {
    const outcomes: ActionOutcome[] = [];
    let failedAt: number | undefined;
    const maxChars = opts.maxChars ?? 4000;

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i]!;
      const outcome: ActionOutcome = { index: i, type: action.type, ok: false, detail: describeAction(action) };
      try {
        if (action.type === 'scanFullPage') {
          const { type: _type, ...scanOpts } = action;
          outcome.scan = await scanFullPage(rec.page, scanOpts);
          outcome.detail =
            `scanned ${outcome.scan.scrolls} step(s), height ${outcome.scan.startHeight}→${outcome.scan.endHeight}px ` +
            `(${outcome.scan.stoppedBecause})`;
        } else {
          const results = await runPageActions(rec.page, [action]);
          for (const r of results) {
            if (isScreenshotResult(r)) outcome.screenshot = r.dataUrl;
            else if (isScrapeResult(r)) {
              const extracted = extractFromHtml(r.html, r.url, {
                onlyMainContent: opts.onlyMainContent !== false,
              });
              outcome.markdown = cap(extracted.markdown, maxChars);
            } else outcome.value = r;
          }
          if (action.type === 'navigate') {
            await settlePage(rec.page, {});
            outcome.detail = `navigated to ${rec.page.url()}`;
          }
        }
        outcome.ok = true;
      } catch (err) {
        outcome.ok = false;
        outcome.error = errText(err);
        failedAt = i;
        outcomes.push(outcome);
        break;
      }
      outcomes.push(outcome);
    }

    return { outcomes, failedAt, info: await describe(rec) };
  });
}

export type ReadFormat = 'markdown' | 'text' | 'html' | 'rawHtml' | 'links';

export interface ReadOptions {
  formats?: ReadFormat[];
  maxChars?: number;
  onlyMainContent?: boolean;
  /** Also grab a PNG. */
  screenshot?: boolean;
  screenshotFullPage?: boolean;
  /** Max links listed. Default 100. */
  maxLinks?: number;
}

export interface ReadResult {
  info: SessionInfo;
  markdown?: string;
  text?: string;
  html?: string;
  rawHtml?: string;
  links?: string[];
  linkCount?: number;
  screenshot?: string;
  /** Characters dropped by the cap, per format. */
  truncated?: Record<string, number>;
}

/**
 * Reads the live page through the normal extraction pipeline, so a session
 * returns the same clean markdown as `scrape` rather than raw HTML.
 */
export function readSession(id: string, opts: ReadOptions = {}): Promise<ReadResult> {
  return withSession(id, async (rec) => {
    const formats: ReadFormat[] = opts.formats?.length ? opts.formats : ['markdown'];
    const maxChars = opts.maxChars ?? 8000;
    const truncated: Record<string, number> = {};
    const out: ReadResult = { info: await describe(rec) };

    const rawHtml = await rec.page.content();
    const extracted = extractFromHtml(rawHtml, rec.page.url(), {
      onlyMainContent: opts.onlyMainContent !== false,
    });

    const put = (key: 'markdown' | 'text' | 'html' | 'rawHtml', value: string): void => {
      if (value.length > maxChars) truncated[key] = value.length - maxChars;
      out[key] = cap(value, maxChars);
    };

    if (formats.includes('markdown')) put('markdown', extracted.markdown);
    if (formats.includes('text')) put('text', extracted.text);
    if (formats.includes('html')) put('html', extracted.html);
    if (formats.includes('rawHtml')) put('rawHtml', rawHtml);
    if (formats.includes('links')) {
      out.linkCount = extracted.links.length;
      out.links = extracted.links.slice(0, opts.maxLinks ?? 100);
    }
    if (Object.keys(truncated).length) out.truncated = truncated;

    if (opts.screenshot) {
      const buf = await rec.page.screenshot({
        fullPage: Boolean(opts.screenshotFullPage),
        type: 'png',
      });
      out.screenshot = 'data:image/png;base64,' + buf.toString('base64');
    }
    return out;
  });
}

/** Full-page scan as a standalone call, for callers that only want the scroll. */
export function scanSession(id: string, opts: ScanFullPageOptions = {}): Promise<ScanFullPageReport> {
  return withSession(id, (rec) => scanFullPage(rec.page, opts));
}

function cap(value: string, max: number): string {
  if (!max || value.length <= max) return value;
  return value.slice(0, max).trimEnd() + `\n\n---\n_[truncated ${value.length - max} chars]_`;
}

function isScreenshotResult(r: unknown): r is { type: 'screenshot'; dataUrl: string } {
  return typeof r === 'object' && r !== null && (r as { type?: unknown }).type === 'screenshot';
}

function isScrapeResult(r: unknown): r is { type: 'scrape'; html: string; url: string } {
  return typeof r === 'object' && r !== null && (r as { type?: unknown }).type === 'scrape';
}

export function errText(err: unknown): string {
  const raw =
    err instanceof Error
      // Playwright errors carry a long "call log"; the first lines are the useful part.
      ? err.message.split('\n').slice(0, 4).join(' ')
      : String(err);
  // Playwright colourises its call log, and escape codes are noise in tool output.
  return raw.replace(/\u001b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim();
}
