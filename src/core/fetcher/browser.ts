import type { Browser, BrowserContext, Page } from 'playwright';
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../util/log.js';
import { DATA_DIR, ensureDataDirs } from '../util/paths.js';
import type { FetchedPage, PageAction, ScrapeOptions } from '../types.js';
import { detectBlock } from './http.js';

/**
 * A single shared Chromium instance with pooled contexts. Launching a browser
 * costs ~300ms and ~80MB, so we launch once and reuse it for the process
 * lifetime; each page gets a fresh context so cookies never leak between sites.
 *
 * Named *profiles* are the exception: a profile is a persistent `userDataDir`
 * launched with `chromium.launchPersistentContext`, so its cookies and
 * localStorage survive restarts. That is how you scrape pages you are logged
 * into. Chromium locks a userDataDir, so each profile has at most one live
 * context, cached here and shared by every fetch and session that asks for it.
 */
let browserPromise: Promise<Browser> | null = null;

const BLOCKED_RESOURCES = new Set(['image', 'media', 'font']);
const ANALYTICS_HOSTS = [
  'google-analytics.com',
  'googletagmanager.com',
  'doubleclick.net',
  'facebook.net',
  'hotjar.com',
  'segment.io',
  'intercom.io',
  'mixpanel.com',
  'clarity.ms',
];

const LAUNCH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-dev-shm-usage',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
];

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = (async () => {
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
      log.debug('chromium launched');
      return browser;
    })();
  }
  return browserPromise;
}

export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  try {
    const browser = await browserPromise;
    await browser.close();
  } catch {
    /* already gone */
  }
  browserPromise = null;
}

/** Strips the obvious automation tells that bot detectors look for. */
const STEALTH_INIT = `
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
window.chrome = window.chrome || { runtime: {} };
const origQuery = window.navigator.permissions && window.navigator.permissions.query;
if (origQuery) {
  window.navigator.permissions.query = (params) =>
    params && params.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission })
      : origQuery(params);
}
`;

/** Skip the bytes we never use, but never break screenshots or logged-in UIs. */
async function applyRouting(context: BrowserContext, blockResources: boolean): Promise<void> {
  await context.route('**/*', (route) => {
    const req = route.request();
    const type = req.resourceType();
    const url = req.url();
    if (ANALYTICS_HOSTS.some((h) => url.includes(h))) return route.abort();
    if (blockResources && BLOCKED_RESOURCES.has(type)) return route.abort();
    return route.continue();
  });
}

/** Extra knobs this module understands on top of `ScrapeOptions`. */
export interface BrowserExtraOptions {
  /** Use a persistent, logged-in profile (see `PROFILES_DIR`) instead of a throwaway context. */
  profile?: string;
  /** Launch the profile in a visible window so a human can sign in. Profiles only. */
  headful?: boolean;
  /** Override the default resource blocking (images/media/fonts). */
  blockResources?: boolean;
  /** Scroll to the bottom in steps after load, to trigger infinite scroll and lazy images. */
  scanFullPage?: boolean | ScanFullPageOptions;
}

async function newContext(opts: ScrapeOptions & BrowserExtraOptions): Promise<BrowserContext> {
  const browser = await getBrowser();
  const viewport = opts.screenshot?.viewport ??
    (opts.mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });

  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    isMobile: Boolean(opts.mobile),
    hasTouch: Boolean(opts.mobile),
    locale: 'en-US',
    timezoneId: 'Asia/Kolkata',
    userAgent: opts.mobile ? MOBILE_UA : DESKTOP_UA,
    extraHTTPHeaders: opts.headers,
    ignoreHTTPSErrors: opts.skipTlsVerification === true,
    proxy: opts.proxy ? { server: opts.proxy } : undefined,
  });

  await context.addInitScript(STEALTH_INIT);

  // Skip the bytes we never use. Screenshots obviously still need images.
  const wantsImages = Boolean(opts.screenshot) || opts.formats?.includes('screenshot');
  await applyRouting(context, opts.blockResources ?? !wantsImages);

  return context;
}

// ---------------------------------------------------------------------------
// Persistent profiles
// ---------------------------------------------------------------------------

/** Logged-in browser profiles: `<DATA_DIR>/profiles/<name>`, one Chromium userDataDir each. */
export const PROFILES_DIR = join(DATA_DIR, 'profiles');

const SAFE_PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function ensureProfilesDir(): void {
  ensureDataDirs();
  mkdirSync(PROFILES_DIR, { recursive: true });
}

/** Resolves a profile name to its userDataDir, rejecting anything that could escape the folder. */
export function profilePath(name: string): string {
  if (!SAFE_PROFILE_NAME.test(name)) {
    throw new Error(
      `Invalid profile name ${JSON.stringify(name)}: use 1-64 characters from A-Z a-z 0-9 . _ - starting with a letter or digit.`,
    );
  }
  return join(PROFILES_DIR, name);
}

export interface ProfileInfo {
  name: string;
  path: string;
  /** Last time Chromium wrote to the profile, ISO 8601. */
  modified?: string;
  /** True when this process currently holds the profile open. */
  open: boolean;
  visible: boolean;
}

export function listProfiles(): ProfileInfo[] {
  ensureProfilesDir();
  let names: string[] = [];
  try {
    names = readdirSync(PROFILES_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    names = [];
  }
  return names.sort().map((name) => {
    const path = join(PROFILES_DIR, name);
    let modified: string | undefined;
    try {
      modified = statSync(path).mtime.toISOString();
    } catch {
      /* unreadable; report it as unknown rather than guessing */
    }
    const live = liveProfiles.get(name);
    return { name, path, modified, open: Boolean(live), visible: live ? !live.headless : false };
  });
}

interface ProfileEntry {
  name: string;
  context: BrowserContext;
  headless: boolean;
  closed: boolean;
}

const profileContexts = new Map<string, Promise<ProfileEntry>>();
/** Resolved view of `profileContexts`, for synchronous reporting. */
const liveProfiles = new Map<string, ProfileEntry>();

/**
 * Opens (or reuses) the persistent context for a named profile. Chromium locks
 * the userDataDir, so the first caller decides headless vs visible and later
 * callers share that window — we log loudly rather than silently disagreeing.
 */
export async function getProfileContext(
  name: string,
  opts: ScrapeOptions & BrowserExtraOptions = {},
): Promise<ProfileEntry> {
  const headless = opts.headful !== true;
  const cached = profileContexts.get(name);
  if (cached) {
    const entry = await cached.catch(() => null);
    if (entry && !entry.closed) {
      if (entry.headless !== headless) {
        log.warn(
          `profile "${name}" is already open ${entry.headless ? 'headless' : 'visible'}; reusing that window (Chromium locks the profile directory)`,
        );
      }
      return entry;
    }
    profileContexts.delete(name);
    liveProfiles.delete(name);
  }

  const dir = profilePath(name);
  const promise = (async (): Promise<ProfileEntry> => {
    ensureProfilesDir();
    mkdirSync(dir, { recursive: true });
    const { chromium } = await import('playwright');
    const viewport = opts.screenshot?.viewport ??
      (opts.mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });

    const context = await chromium.launchPersistentContext(dir, {
      headless,
      args: LAUNCH_ARGS,
      viewport,
      deviceScaleFactor: 1,
      isMobile: Boolean(opts.mobile),
      hasTouch: Boolean(opts.mobile),
      locale: 'en-US',
      timezoneId: 'Asia/Kolkata',
      userAgent: opts.mobile ? MOBILE_UA : DESKTOP_UA,
      extraHTTPHeaders: opts.headers,
      ignoreHTTPSErrors: opts.skipTlsVerification === true,
      acceptDownloads: false,
      proxy: opts.proxy ? { server: opts.proxy } : undefined,
    });

    await context.addInitScript(STEALTH_INIT);
    // A logged-in profile is for looking at real pages, so keep images unless told otherwise.
    await applyRouting(context, opts.blockResources ?? false);

    const entry: ProfileEntry = { name, context, headless, closed: false };
    context.once('close', () => {
      entry.closed = true;
      if (profileContexts.get(name) === promise) profileContexts.delete(name);
      if (liveProfiles.get(name) === entry) liveProfiles.delete(name);
      log.debug(`profile "${name}" context closed`);
    });
    liveProfiles.set(name, entry);
    log.info(`profile "${name}" opened ${headless ? 'headless' : 'visible'} (${dir})`);
    return entry;
  })();

  profileContexts.set(name, promise);
  try {
    return await promise;
  } catch (err) {
    profileContexts.delete(name);
    liveProfiles.delete(name);
    throw err;
  }
}

/**
 * Closes every persistent profile context. Chromium flushes cookies to disk on
 * close, so this is also what makes a hand-done sign-in durable. Call it
 * alongside `closeBrowser()` on shutdown.
 */
export async function closeProfileContexts(): Promise<number> {
  const entries = [...profileContexts.values()];
  profileContexts.clear();
  let closed = 0;
  for (const pending of entries) {
    try {
      const entry = await pending;
      liveProfiles.delete(entry.name);
      if (!entry.closed) {
        await entry.context.close();
        closed++;
      }
    } catch {
      /* never launched, or already gone */
    }
  }
  liveProfiles.clear();
  if (closed) log.info(`closed ${closed} persistent profile context(s)`);
  return closed;
}

/** A context plus the knowledge of whether closing it is our business. */
export interface AcquiredContext {
  context: BrowserContext;
  /** True when this is a shared persistent profile that must outlive the caller. */
  persistent: boolean;
  profile?: string;
  headless: boolean;
  /** Closes an ephemeral context; a no-op for a shared profile. */
  release(): Promise<void>;
}

export async function acquireContext(
  opts: ScrapeOptions & BrowserExtraOptions = {},
): Promise<AcquiredContext> {
  if (opts.profile) {
    const entry = await getProfileContext(opts.profile, opts);
    return {
      context: entry.context,
      persistent: true,
      profile: entry.name,
      headless: entry.headless,
      release: async () => {},
    };
  }
  const context = await newContext(opts);
  return {
    context,
    persistent: false,
    headless: true,
    release: async () => {
      await context.close().catch(() => {});
    },
  };
}

// ---------------------------------------------------------------------------
// Full-page scan
// ---------------------------------------------------------------------------

export interface ScanFullPageOptions {
  /** Hard cap on scroll steps. Default 20. */
  maxScrolls?: number;
  /** Pause after each step, in ms. Default 450. */
  scrollDelay?: number;
  /** Step size as a fraction of the viewport height. Default 0.9. */
  stepRatio?: number;
  /** Stop after this many consecutive steps that add no height, at the bottom. Default 2. */
  stableRounds?: number;
  /** Final settle wait after the last step, in ms. Default 400. */
  settleAfter?: number;
  /** Return to the top when finished (nicer full-page screenshots). Default false. */
  scrollBackToTop?: boolean;
}

export interface ScanFullPageReport {
  scrolls: number;
  startHeight: number;
  endHeight: number;
  /** Pixels of document height gained by scrolling. */
  grewBy: number;
  stoppedBecause: 'height-stable' | 'max-scrolls';
  /** <img> elements present before/after, and how many carry a real (non data:) src. */
  imagesBefore: number;
  imagesAfter: number;
  imagesWithSrcBefore: number;
  imagesWithSrcAfter: number;
  /**
   * Images the browser actually decoded. Native `loading="lazy"` images keep
   * their src but stay undecoded until they near the viewport, so growth here
   * is the signal that scrolling pulled in lazy images. 0 when image loading
   * is blocked (the default for a plain fetch without a screenshot).
   */
  imagesDecodedBefore: number;
  imagesDecodedAfter: number;
}

interface ScanMeasurement {
  height: number;
  viewport: number;
  scrollY: number;
  images: number;
  imagesWithSrc: number;
  imagesDecoded: number;
}

function measurePage(page: Page): Promise<ScanMeasurement> {
  return page.evaluate(() => {
    const doc = document.scrollingElement ?? document.documentElement;
    const imgs = Array.from(document.images);
    let withSrc = 0;
    let decoded = 0;
    for (const img of imgs) {
      const src = img.getAttribute('src');
      if (src && !src.startsWith('data:')) withSrc++;
      if (img.complete && img.naturalWidth > 0) decoded++;
    }
    return {
      height: doc.scrollHeight,
      viewport: window.innerHeight,
      scrollY: Math.round(window.scrollY),
      images: imgs.length,
      imagesWithSrc: withSrc,
      imagesDecoded: decoded,
    };
  });
}

/**
 * crawl4ai's `scan_full_page`: walk the page to the bottom in viewport-sized
 * steps so infinite feeds append their next batch and lazy `<img>` elements
 * enter the viewport and swap in their real `src`. Stops early once the
 * document height has stopped growing and we are actually at the bottom.
 */
export async function scanFullPage(
  page: Page,
  opts: ScanFullPageOptions = {},
): Promise<ScanFullPageReport> {
  const maxScrolls = Math.max(1, Math.trunc(opts.maxScrolls ?? 20));
  const delay = Math.max(0, opts.scrollDelay ?? 450);
  const stepRatio = opts.stepRatio && opts.stepRatio > 0 ? opts.stepRatio : 0.9;
  const stableRounds = Math.max(1, Math.trunc(opts.stableRounds ?? 2));

  const start = await measurePage(page);
  const step = Math.max(200, Math.round(start.viewport * stepRatio));

  let lastHeight = start.height;
  let stable = 0;
  let scrolls = 0;
  let stoppedBecause: ScanFullPageReport['stoppedBecause'] = 'max-scrolls';

  while (scrolls < maxScrolls) {
    await page.evaluate((px: number) => {
      window.scrollBy(0, px);
      // Some lazy-loaders listen on scroll rather than using IntersectionObserver.
      window.dispatchEvent(new Event('scroll'));
    }, step);
    scrolls++;

    if (delay) await page.waitForTimeout(delay);
    await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {});

    const now = await measurePage(page);
    if (now.height > lastHeight + 4) stable = 0;
    else stable++;
    lastHeight = now.height;

    const atBottom = now.scrollY + now.viewport >= now.height - 4;
    if (atBottom && stable >= stableRounds) {
      stoppedBecause = 'height-stable';
      break;
    }
  }

  const settle = opts.settleAfter ?? 400;
  if (settle > 0) await page.waitForTimeout(settle);
  const end = await measurePage(page);
  if (opts.scrollBackToTop) {
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  }

  const report: ScanFullPageReport = {
    scrolls,
    startHeight: start.height,
    endHeight: end.height,
    grewBy: end.height - start.height,
    stoppedBecause,
    imagesBefore: start.images,
    imagesAfter: end.images,
    imagesWithSrcBefore: start.imagesWithSrc,
    imagesWithSrcAfter: end.imagesWithSrc,
    imagesDecodedBefore: start.imagesDecoded,
    imagesDecodedAfter: end.imagesDecoded,
  };
  log.debug('scanFullPage', report);
  return report;
}

/** Normalises the `scanFullPage` option (`true` means "defaults"). */
export function scanOptionsFrom(
  value: boolean | ScanFullPageOptions | undefined,
): ScanFullPageOptions | null {
  if (!value) return null;
  return value === true ? {} : value;
}

async function runActions(page: Page, actions: PageAction[]): Promise<unknown[]> {
  const results: unknown[] = [];
  for (const action of actions) {
    switch (action.type) {
      case 'wait':
        if (action.selector) await page.waitForSelector(action.selector, { timeout: 15_000 });
        else await page.waitForTimeout(action.milliseconds ?? 1000);
        break;
      case 'click':
        if (action.all) {
          const all = page.locator(action.selector);
          const count = await all.count();
          for (let i = 0; i < count; i++) await all.nth(i).click({ timeout: 10_000 }).catch(() => {});
        } else {
          await page.click(action.selector, { timeout: 15_000 });
        }
        break;
      case 'write':
        if (action.selector) await page.fill(action.selector, action.text, { timeout: 15_000 });
        else await page.keyboard.type(action.text, { delay: 20 });
        break;
      case 'press':
        await page.keyboard.press(action.key);
        break;
      case 'scroll': {
        const amount = action.amount ?? 1;
        const sign = action.direction === 'up' ? -1 : 1;
        for (let i = 0; i < amount; i++) {
          await page.mouse.wheel(0, sign * 800);
          await page.waitForTimeout(250);
        }
        break;
      }
      case 'navigate':
        await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        break;
      case 'executeJavascript':
        results.push(await page.evaluate(action.script));
        break;
      case 'screenshot': {
        const buf = await page.screenshot({ fullPage: Boolean(action.fullPage), type: 'png' });
        results.push({ type: 'screenshot', dataUrl: 'data:image/png;base64,' + buf.toString('base64') });
        break;
      }
      case 'scrape':
        results.push({ type: 'scrape', html: await page.content(), url: page.url() });
        break;
    }
  }
  return results;
}

/** The shared action runner, for callers that drive a long-lived page (sessions). */
export const runPageActions = runActions;

/**
 * Waits for the page to actually settle, which is what "smart wait" means:
 * DOM ready, then network quiet, then a short grace period for hydration.
 */
async function smartWait(page: Page, opts: ScrapeOptions): Promise<void> {
  if (opts.waitForSelector) {
    await page.waitForSelector(opts.waitForSelector, { timeout: 20_000 }).catch(() => {});
  }
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
  if (opts.waitFor) await page.waitForTimeout(opts.waitFor);
  else await page.waitForTimeout(350);
}

/** Same settle logic, exported for session callers. */
export const settlePage = smartWait;

export interface BrowserFetchExtras {
  screenshot?: string;
  actionResults?: unknown[];
  /** Present when `scanFullPage` ran. */
  scan?: ScanFullPageReport;
}

const extras = new WeakMap<FetchedPage, BrowserFetchExtras>();

export function getBrowserExtras(page: FetchedPage): BrowserFetchExtras | undefined {
  return extras.get(page);
}

export async function browserFetch(
  url: string,
  opts: ScrapeOptions & BrowserExtraOptions = {},
): Promise<FetchedPage> {
  const acquired = await acquireContext(opts);
  const page = await acquired.context.newPage();
  const timeout = opts.timeout ?? 45_000;

  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    await smartWait(page, opts);

    const scanOpts = scanOptionsFrom(opts.scanFullPage);
    const scan = scanOpts ? await scanFullPage(page, scanOpts) : undefined;

    const actionResults = opts.actions?.length ? await runActions(page, opts.actions) : undefined;
    if (actionResults) await smartWait(page, { waitFor: 300 });

    const html = await page.content();
    const body = Buffer.from(html, 'utf8');
    const status = response?.status() ?? 200;
    const headers = response ? await response.allHeaders() : {};
    const blockReason = detectBlock(status, headers, body);

    let screenshot: string | undefined;
    if (opts.formats?.includes('screenshot') || opts.screenshot) {
      const shot = await page.screenshot({
        fullPage: opts.screenshot?.fullPage ?? false,
        type: opts.screenshot?.quality ? 'jpeg' : 'png',
        quality: opts.screenshot?.quality,
      });
      const mime = opts.screenshot?.quality ? 'image/jpeg' : 'image/png';
      screenshot = `data:${mime};base64,` + shot.toString('base64');
    }

    const result: FetchedPage = {
      url,
      finalUrl: page.url(),
      status,
      contentType: String(headers['content-type'] ?? 'text/html; charset=utf-8'),
      body,
      renderedWith: 'browser',
      blocked: Boolean(blockReason),
      blockReason: blockReason ?? undefined,
    };

    if (screenshot || actionResults || scan) extras.set(result, { screenshot, actionResults, scan });
    return result;
  } finally {
    await page.close().catch(() => {});
    await acquired.release();
  }
}
