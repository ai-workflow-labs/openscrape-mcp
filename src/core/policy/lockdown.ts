/**
 * Lockdown: a config file that pins what this server is allowed to do.
 *
 * Firecrawl sells this as an Enterprise key-scoping feature. Locally the same
 * need is real for a different reason: an MCP server is driven by a model, and
 * a model can be talked into things by the pages it reads. A lockdown file is
 * the operator's answer — limits the model cannot argue with, because they are
 * checked below the tool layer and are not parameters any tool accepts.
 *
 * Two deliberate design choices:
 *
 * 1. **No file means no lockdown.** The normal case costs nothing and nobody
 *    has to configure anything.
 *
 * 2. **A broken file refuses everything.** If the file exists but cannot be
 *    read or parsed, this fails closed. A security control that silently
 *    disables itself on a typo is worse than no control, because the operator
 *    believes they are protected. The refusal says exactly what is wrong.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../util/paths.js';
import { log } from '../util/log.js';
import type { ScrapeFormat, ScrapeOptions } from '../types.js';

export class LockdownError extends Error {
  readonly rule: string;
  constructor(rule: string, message: string) {
    super(message);
    this.name = 'LockdownError';
    this.rule = rule;
  }
}

export interface LockdownConfig {
  /** Only these hosts may be fetched. Suffix match: "example.com" allows
   *  "www.example.com" and "a.b.example.com", but not "notexample.com". */
  allowedDomains?: string[];
  /** Hosts that may never be fetched, checked after allowedDomains. */
  blockedDomains?: string[];
  /** Only these output formats may be requested. */
  allowedFormats?: ScrapeFormat[];
  /** Hard cap on characters returned per text format, whatever the caller asks. */
  maxChars?: number;
  /** Hard cap on pages per crawl or batch. */
  maxCrawlPages?: number;
  /** Allow launching a real browser at all. Default true. */
  allowBrowser?: boolean;
  /** Allow page interactions (click, write, press...). Default true. */
  allowActions?: boolean;
  /** Allow the `executeJavascript` action. Default true locally; the riskiest
   *  thing here, since it runs arbitrary script in the page. */
  allowExecuteJavascript?: boolean;
  /** Allow reading local files through `parse_file`. Default true. */
  allowFileParse?: boolean;
  /** Allow fetching private, loopback and link-local addresses. Default false
   *  when a lockdown file is present. */
  allowPrivateTargets?: boolean;
  /** Allow routing through a proxy. Default true. */
  allowProxies?: boolean;
  /** Force `respectRobots` on for every crawl, whatever the caller passes. */
  requireRobots?: boolean;
  /** Allow the web-archive fallback and the archive tools. Default true. */
  allowArchive?: boolean;
  /** Shown in every refusal, so whoever hits the wall knows who built it. */
  note?: string;
}

/** Keys we understand. Anything else is a typo in a security rule — loud. */
const KNOWN_KEYS = new Set<keyof LockdownConfig | string>([
  'allowedDomains',
  'blockedDomains',
  'allowedFormats',
  'maxChars',
  'maxCrawlPages',
  'allowBrowser',
  'allowActions',
  'allowExecuteJavascript',
  'allowFileParse',
  'allowPrivateTargets',
  'allowProxies',
  'requireRobots',
  'allowArchive',
  'note',
]);

interface LoadedState {
  /** Where the config came from, for messages. */
  path: string | null;
  config: LockdownConfig | null;
  /** Set when a file exists but is unusable. Everything is refused. */
  fatal: string | null;
}

let state: LoadedState | null = null;

function configPath(): string {
  return process.env.OPENSCRAPE_LOCKDOWN?.trim() || join(DATA_DIR, 'lockdown.json');
}

/**
 * The preset for a shared deployment.
 *
 * Hosting this for a team changes which defaults are safe. On a laptop,
 * reading a local file or running a page script is the user acting on their own
 * machine. On a shared host those same capabilities let anyone with a token
 * read the server's filesystem and run code in its browser.
 *
 * `OPENSCRAPE_MODE=hosted` turns the dangerous ones off in one switch, because
 * getting six environment variables individually right is a thing people do
 * not reliably do. A lockdown file still wins over this, key by key, so an
 * operator can hand one capability back deliberately.
 */
const HOSTED_DEFAULTS: LockdownConfig = {
  allowFileParse: false,
  allowExecuteJavascript: false,
  allowPrivateTargets: false,
  requireRobots: true,
  note: 'Shared deployment (OPENSCRAPE_MODE=hosted). Local file reads and page scripts are off.',
};

function hostedMode(): boolean {
  return (process.env.OPENSCRAPE_MODE ?? '').trim().toLowerCase() === 'hosted';
}

function load(): LoadedState {
  if (state) return state;

  /**
   * Inline policy, for platforms where mounting a file is awkward.
   *
   * On Render, Fly or Railway the config would otherwise have to be baked into
   * the image or committed — and a policy naming your internal hosts is not
   * something to commit. An env var keeps it out of the repo and out of the
   * image. Checked before the file so a platform override is unambiguous.
   */
  const inline = process.env.OPENSCRAPE_LOCKDOWN_JSON?.trim();
  if (inline) {
    try {
      const parsed: unknown = JSON.parse(inline);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('expected a JSON object');
      }
      const config = hostedMode()
        ? { ...HOSTED_DEFAULTS, ...(parsed as LockdownConfig) }
        : (parsed as LockdownConfig);
      log.info('lockdown from OPENSCRAPE_LOCKDOWN_JSON', { rules: Object.keys(config).length });
      state = { path: 'OPENSCRAPE_LOCKDOWN_JSON', config, fatal: null };
    } catch (err) {
      // Same fail-closed rule as the file: a policy that will not parse must
      // not quietly become no policy.
      state = {
        path: 'OPENSCRAPE_LOCKDOWN_JSON',
        config: null,
        fatal: `OPENSCRAPE_LOCKDOWN_JSON is not valid JSON: ${String(err)}. Refusing everything until it is fixed.`,
      };
      log.warn('inline lockdown unusable, failing closed', String(err));
    }
    return state;
  }

  const path = configPath();
  const explicit = Boolean(process.env.OPENSCRAPE_LOCKDOWN?.trim());

  if (!existsSync(path)) {
    // An explicitly named file that is not there is a misconfiguration, not an
    // absence: the operator meant to lock this down and the lock is missing.
    if (explicit) {
      state = {
        path,
        config: null,
        fatal: `OPENSCRAPE_LOCKDOWN points at ${path}, which does not exist. Refusing everything until the file is present or the variable is unset.`,
      };
      return state;
    }
    if (hostedMode()) {
      log.info('hosted mode: applying shared-deployment defaults', HOSTED_DEFAULTS);
      state = { path: 'OPENSCRAPE_MODE=hosted', config: { ...HOSTED_DEFAULTS }, fatal: null };
      return state;
    }
    state = { path: null, config: null, fatal: null };
    return state;
  }

  try {
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error('not a regular file');
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected a JSON object');
    }

    const unknown = Object.keys(parsed as object).filter((k) => !KNOWN_KEYS.has(k));
    if (unknown.length) {
      // Not fatal — but a misspelled rule is a rule that is not enforced, so
      // it must be impossible to miss.
      log.warn('lockdown: unknown keys ignored', { path, keys: unknown });
    }

    // Hosted defaults underneath, the file's own keys on top: the operator can
    // hand a capability back deliberately, but cannot lose one by forgetting
    // to mention it.
    const fromFile = parsed as LockdownConfig;
    const config = hostedMode() ? { ...HOSTED_DEFAULTS, ...fromFile } : fromFile;
    log.info('lockdown active', {
      path,
      rules: Object.keys(fromFile).length,
      hostedDefaults: hostedMode(),
    });
    state = { path, config, fatal: null };
  } catch (err) {
    state = {
      path,
      config: null,
      fatal: `Lockdown file ${path} could not be read: ${String(err)}. Refusing everything until it is valid JSON.`,
    };
    log.warn('lockdown file unusable, failing closed', { path, error: String(err) });
  }

  return state;
}

/** Re-reads the config. For tests, and after the operator edits the file. */
export function reloadLockdown(): void {
  state = null;
}

export function lockdownActive(): boolean {
  const s = load();
  return Boolean(s.config || s.fatal);
}

export function lockdownPath(): string | null {
  return load().path;
}

export function lockdownConfig(): LockdownConfig | null {
  return load().config;
}

/** Throws if the config file exists but is unusable. Called by every check. */
function assertUsable(): LockdownConfig | null {
  const s = load();
  if (s.fatal) throw new LockdownError('config', s.fatal);
  return s.config;
}

function withNote(config: LockdownConfig, message: string): string {
  const where = load().path;
  const parts = [message];
  if (config.note) parts.push(`Note from the lockdown file: ${config.note}`);
  if (where) parts.push(`(set in ${where})`);
  return parts.join(' ');
}

/** Suffix match on the host: "example.com" covers any subdomain of it. */
function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  const p = pattern.toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
  return h === p || h.endsWith(`.${p}`);
}

/**
 * The domain gate. Called for every outbound fetch, including the archive.
 *
 * `allowedDomains` is a whitelist: when it is set, anything not on it is
 * refused, which is the behaviour an operator expects from the name.
 */
export function assertUrlAllowed(url: string): void {
  const config = assertUsable();
  if (!config) return;

  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new LockdownError('allowedDomains', `Refusing to fetch an unparseable URL: ${url}`);
  }

  if (config.allowedDomains?.length) {
    if (!config.allowedDomains.some((d) => hostMatches(host, d))) {
      throw new LockdownError(
        'allowedDomains',
        withNote(
          config,
          `Lockdown: ${host} is not in allowedDomains (${config.allowedDomains.join(', ')}).`,
        ),
      );
    }
  }

  if (config.blockedDomains?.some((d) => hostMatches(host, d))) {
    throw new LockdownError(
      'blockedDomains',
      withNote(config, `Lockdown: ${host} is in blockedDomains.`),
    );
  }
}

/** True when private/loopback targets are permitted under the current config. */
export function privateTargetsAllowed(): boolean {
  const config = load().config;
  if (!config) return process.env.OPENSCRAPE_ALLOW_PRIVATE_TARGETS === '1';
  // A lockdown file in place flips the default to deny: an operator who wrote
  // one is not expecting the server to reach into their network.
  return config.allowPrivateTargets === true;
}

export function fileParseAllowed(): boolean {
  const config = assertUsable();
  return config?.allowFileParse !== false;
}

export function archiveAllowed(): boolean {
  const config = load().config;
  return config?.allowArchive !== false;
}

export function browserAllowed(): boolean {
  const config = load().config;
  return config?.allowBrowser !== false;
}

export function robotsRequired(): boolean {
  return load().config?.requireRobots === true;
}

/** Clamps a crawl or batch page limit, and says so when it bites. */
export function clampCrawlLimit(limit: number): { limit: number; clamped?: string } {
  const config = assertUsable();
  const max = config?.maxCrawlPages;
  if (!config || max === undefined || limit <= max) return { limit };
  return {
    limit: max,
    clamped: withNote(config, `Lockdown: page limit reduced from ${limit} to ${max} (maxCrawlPages).`),
  };
}

export interface LockdownApplied {
  options: ScrapeOptions;
  /** Non-fatal adjustments, to be surfaced as warnings. */
  notices: string[];
}

/**
 * Applies the config to one request.
 *
 * Violations that the caller asked for explicitly throw — silently returning
 * something other than what was requested is how a caller ends up trusting a
 * result it should not. Caps that merely tighten a value are applied and
 * reported as notices.
 */
export function applyLockdown(opts: ScrapeOptions): LockdownApplied {
  const config = assertUsable();
  if (!config) return { options: opts, notices: [] };

  const notices: string[] = [];
  const next: ScrapeOptions = { ...opts };

  if (config.allowedFormats?.length && opts.formats?.length) {
    const banned = opts.formats.filter((f) => !config.allowedFormats?.includes(f));
    if (banned.length) {
      throw new LockdownError(
        'allowedFormats',
        withNote(
          config,
          `Lockdown: format(s) ${banned.join(', ')} are not allowed. Permitted: ${config.allowedFormats.join(', ')}.`,
        ),
      );
    }
  }

  if (config.allowActions === false && opts.actions?.length) {
    throw new LockdownError(
      'allowActions',
      withNote(config, 'Lockdown: page interactions are disabled.'),
    );
  }

  if (config.allowExecuteJavascript === false) {
    const hasJs = opts.actions?.some((a) => a.type === 'executeJavascript');
    if (hasJs) {
      throw new LockdownError(
        'allowExecuteJavascript',
        withNote(config, 'Lockdown: the executeJavascript action is disabled.'),
      );
    }
  }

  if (config.allowBrowser === false) {
    if (opts.render === 'browser') {
      throw new LockdownError(
        'allowBrowser',
        withNote(config, 'Lockdown: launching a browser is disabled, so render:"browser" cannot be honoured.'),
      );
    }
    if (opts.formats?.includes('screenshot')) {
      throw new LockdownError(
        'allowBrowser',
        withNote(config, 'Lockdown: launching a browser is disabled, so a screenshot cannot be taken.'),
      );
    }
    // Pin it down so the ladder cannot escalate into a browser on its own.
    next.render = 'http';
    notices.push('Lockdown: browser rendering is disabled; only server HTML was fetched.');
  }

  if (config.allowProxies === false && opts.proxy) {
    throw new LockdownError('allowProxies', withNote(config, 'Lockdown: proxies are disabled.'));
  }

  if (config.allowArchive === false && opts.archiveFallback !== false) {
    next.archiveFallback = false;
  }

  if (config.maxChars !== undefined) {
    if (next.maxChars === undefined || next.maxChars > config.maxChars) {
      if (next.maxChars !== undefined) {
        notices.push(`Lockdown: maxChars reduced from ${next.maxChars} to ${config.maxChars}.`);
      }
      next.maxChars = config.maxChars;
    }
  }

  return { options: next, notices };
}

/** One-line description for status output. */
export function lockdownSummary(): string {
  const s = load();
  if (s.fatal) return `LOCKED DOWN (config error): ${s.fatal}`;
  if (!s.config) return 'No lockdown file; nothing is restricted.';

  const c = s.config;
  const bits: string[] = [];
  if (c.allowedDomains?.length) bits.push(`domains: only ${c.allowedDomains.join(', ')}`);
  if (c.blockedDomains?.length) bits.push(`blocked: ${c.blockedDomains.join(', ')}`);
  if (c.allowedFormats?.length) bits.push(`formats: only ${c.allowedFormats.join(', ')}`);
  if (c.maxChars !== undefined) bits.push(`maxChars <= ${c.maxChars}`);
  if (c.maxCrawlPages !== undefined) bits.push(`crawl <= ${c.maxCrawlPages} pages`);
  if (c.allowBrowser === false) bits.push('no browser');
  if (c.allowActions === false) bits.push('no page actions');
  if (c.allowExecuteJavascript === false) bits.push('no executeJavascript');
  if (c.allowFileParse === false) bits.push('no local file parsing');
  if (c.allowProxies === false) bits.push('no proxies');
  if (c.allowArchive === false) bits.push('no archive');
  if (c.requireRobots) bits.push('robots.txt enforced');
  bits.push(c.allowPrivateTargets === true ? 'private targets ALLOWED' : 'private targets denied');

  return `Lockdown active from ${s.path}: ${bits.join(' · ')}`;
}
