/**
 * Proxy rotation pool with per-proxy health.
 *
 * Why this exists: the one real advantage a paid scraping API has over a local
 * fetcher is a large pool of egress IPs. We cannot reproduce that, but plenty of
 * people already have proxies — their own boxes, or a provider they pay for —
 * and today this project accepts exactly one static `proxy` string per request.
 * Spreading your own traffic across your own egress IPs, and backing off from a
 * host that pushes back, is the difference between "I have ten proxies" and
 * actually surviving a rate limit.
 *
 * This is for proxies you are authorised to use, against sites you are
 * authorised to scrape. It does not defeat, bypass or solve any bot check or
 * CAPTCHA: a site-level block is recorded and backed off from, never retried
 * harder.
 *
 * ## Credentials
 * A proxy URL normally carries `user:password@`. Those characters must never
 * reach a log line, a tool result, an error message or a state file — an MCP
 * transcript is a place credentials leak from. Everything this module emits is
 * identified by `host:port#hash` (see `proxyId`), and every string that could
 * have come from elsewhere goes through `scrub()` first.
 *
 * ## Health signal
 * The block classification comes from `detectBlock()` in `./http.js` — the same
 * strings the fetcher already reports. A proxy's own failure (refused, timed
 * out, proxy auth rejected) is tracked separately from a site's block, because
 * benching a perfectly good proxy over one site's 429 wastes it.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetch as undiciFetch, ProxyAgent } from 'undici';
import { log } from '../util/log.js';
import { DATA_DIR, ensureDataDirs } from '../util/paths.js';

export type RotationStrategy =
  | 'round-robin'
  | 'least-recently-used'
  | 'lowest-latency'
  | 'sticky-per-host';

const STRATEGIES: RotationStrategy[] = [
  'round-robin',
  'least-recently-used',
  'lowest-latency',
  'sticky-per-host',
];

export function isRotationStrategy(value: unknown): value is RotationStrategy {
  return typeof value === 'string' && (STRATEGIES as string[]).includes(value);
}

/** What happened on a request that used a proxy. */
export type ProxyOutcome =
  /** The page came back. */
  | { ok: true; host?: string; latencyMs?: number }
  /** The proxy itself is at fault: refused, timed out, DNS, proxy auth rejected. */
  | { ok: false; kind: 'proxy-error'; host?: string; error?: string; latencyMs?: number }
  /** The site pushed back (a `detectBlock` classification). Affects this host only. */
  | { ok: false; kind: 'blocked'; host?: string; blockReason: string; latencyMs?: number };

export interface ProxyPoolOptions {
  /** Explicit list. Overrides the environment when given. */
  proxies?: string[];
  /** Environment variable holding a comma-separated list. Default OPENSCRAPE_PROXIES. */
  envVar?: string;
  /** File with one proxy per line (`#` comments allowed). Default $OPENSCRAPE_PROXY_FILE. */
  file?: string;
  /** Default rotation strategy. Default round-robin, or $OPENSCRAPE_PROXY_STRATEGY. */
  strategy?: RotationStrategy;
  /** Consecutive proxy-level failures before the breaker opens. Default 3. */
  maxConsecutiveFailures?: number;
  /** First bench duration; doubles with each repeat bench. Default 30s. */
  cooldownMs?: number;
  /** Cap on the grown bench duration. Default 15 min. */
  maxCooldownMs?: number;
  /** How long one host's block keeps one proxy off that host. Default 2 min, doubles. */
  blockCooldownMs?: number;
  /** Cap on the grown per-host block cooldown. Default 30 min. */
  maxBlockCooldownMs?: number;
  /** Endpoint that echoes the caller's IP, for health checks. */
  checkUrl?: string;
  /** Persist counters to DATA_DIR/proxy-state.json. Never stores credentials. */
  persist?: boolean;
  /** Injectable clock, for tests. */
  now?: () => number;
}

/** Per-proxy health, safe to print: no credentials anywhere in it. */
export interface ProxyHealth {
  /** Stable redacted identifier: host:port#hash. */
  id: string;
  /** host:port alone. */
  label: string;
  state: 'ok' | 'probation' | 'benched';
  successes: number;
  /** Proxy-level failures only. */
  failures: number;
  consecutiveFailures: number;
  /** Site-level blocks, across all hosts. */
  blocks: number;
  medianLatencyMs: number | null;
  lastUsedAt: number | null;
  benchedUntil: number | null;
  benchCount: number;
  /** Already redacted. */
  lastError?: string;
  lastErrorAt?: number;
  egressIp?: string;
  /** Set when another proxy was seen on the same egress IP. */
  duplicateOf?: string;
  hostBlocks: Array<{ host: string; count: number; lastAt: number; lastReason: string }>;
}

export interface ProxyPoolStatus {
  configured: number;
  available: number;
  benched: number;
  strategy: RotationStrategy;
  /** Where the list came from, e.g. ["env:OPENSCRAPE_PROXIES"]. Never the URLs. */
  sources: string[];
  proxies: ProxyHealth[];
  stickyAssignments: Array<{ host: string; proxy: string }>;
}

export interface ProxyCheckResult {
  /** Redacted identifier. */
  proxy: string;
  label: string;
  ok: boolean;
  latencyMs?: number;
  egressIp?: string;
  /** Already redacted. */
  error?: string;
  /** Id of the earlier proxy sharing this egress IP — no rotation benefit. */
  duplicateOf?: string;
}

const LATENCY_SAMPLES = 32;
const DEFAULT_CHECK_URL = 'https://api.ipify.org?format=json';

/** Strips `user:pass@` out of any URL-shaped text. */
export function redactProxyUrl(text: string): string {
  return text.replace(/([a-zA-Z][\w+.-]*:\/\/)[^/\s@]+@/g, '$1***@');
}

/**
 * Stable, printable identity for a proxy: `host:port#hash`.
 *
 * The hash covers the whole URL including credentials, so two entries that
 * differ only by password still get distinct ids, while the id itself discloses
 * nothing beyond the endpoint the user already told us about.
 */
export function proxyId(proxyUrl: string): string {
  const hash = createHash('sha256').update(proxyUrl).digest('hex').slice(0, 8);
  return `${proxyLabel(proxyUrl)}#${hash}`;
}

function proxyLabel(proxyUrl: string): string {
  try {
    const u = new URL(proxyUrl);
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    return `${u.hostname}:${port}`;
  } catch {
    return 'invalid';
  }
}

/** Accepts `host:port`, `http://host:port`, `http://user:pass@host:port`. */
function normalizeProxy(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const withScheme = /^[a-zA-Z][\w+.-]*:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const u = new URL(withScheme);
    if (!u.hostname) return null;
    if (!/^(https?|socks[45]?):$/.test(u.protocol)) return null;
    return u.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function splitList(value: string): string[] {
  return value.split(/[,\n;]/);
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** Pulls the host out of a bare host or a full URL. */
export function hostOf(target: string): string {
  if (!target) return '';
  try {
    return new URL(/^[a-zA-Z][\w+.-]*:\/\//.test(target) ? target : `http://${target}`).hostname;
  } catch {
    return target;
  }
}

interface Entry {
  /** The real URL, with credentials. Never leaves this object. */
  url: string;
  id: string;
  label: string;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  blocks: number;
  latencies: number[];
  lastUsedAt: number | null;
  benchedUntil: number | null;
  benchCount: number;
  /** True while this proxy is out on a post-cooldown trial run. */
  probing: boolean;
  lastError?: string;
  lastErrorAt?: number;
  egressIp?: string;
  duplicateOf?: string;
  hostBlocks: Map<string, { count: number; lastAt: number; lastReason: string }>;
}

interface PersistedEntry {
  id: string;
  successes: number;
  failures: number;
  blocks: number;
  latencies: number[];
  benchedUntil: number | null;
  benchCount: number;
  lastError?: string;
  lastErrorAt?: number;
}

export class ProxyPool {
  private readonly entries: Entry[] = [];
  private readonly byUrl = new Map<string, Entry>();
  private readonly byId = new Map<string, Entry>();
  /** Credential substrings to scrub out of any text we emit. */
  private readonly secrets = new Set<string>();
  private readonly sticky = new Map<string, string>();
  private readonly sources: string[] = [];
  private cursor = 0;

  readonly strategy: RotationStrategy;
  private readonly maxConsecutiveFailures: number;
  private readonly cooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly blockCooldownMs: number;
  private readonly maxBlockCooldownMs: number;
  private readonly checkUrl: string;
  private readonly persist: boolean;
  private readonly now: () => number;

  constructor(opts: ProxyPoolOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.maxConsecutiveFailures = Math.max(1, opts.maxConsecutiveFailures ?? 3);
    this.cooldownMs = Math.max(1, opts.cooldownMs ?? 30_000);
    this.maxCooldownMs = Math.max(this.cooldownMs, opts.maxCooldownMs ?? 900_000);
    this.blockCooldownMs = Math.max(1, opts.blockCooldownMs ?? 120_000);
    this.maxBlockCooldownMs = Math.max(this.blockCooldownMs, opts.maxBlockCooldownMs ?? 1_800_000);
    this.checkUrl = opts.checkUrl ?? process.env.OPENSCRAPE_PROXY_CHECK_URL ?? DEFAULT_CHECK_URL;
    this.persist = opts.persist ?? process.env.OPENSCRAPE_PROXY_PERSIST === '1';

    const envStrategy = process.env.OPENSCRAPE_PROXY_STRATEGY;
    this.strategy = opts.strategy ?? (isRotationStrategy(envStrategy) ? envStrategy : 'round-robin');

    if (opts.proxies) {
      this.load(opts.proxies, 'explicit');
    } else {
      const envVar = opts.envVar ?? 'OPENSCRAPE_PROXIES';
      const fromEnv = process.env[envVar];
      if (fromEnv) this.load(splitList(fromEnv), `env:${envVar}`);

      const file = opts.file ?? process.env.OPENSCRAPE_PROXY_FILE;
      if (file) {
        try {
          this.load(readFileSync(file, 'utf8').split(/\r?\n/), 'file');
        } catch (err) {
          // The path, not the contents: a proxy file's lines are credentials.
          log.warn('could not read proxy file', { path: file, error: String(err) });
        }
      }
    }

    if (this.persist && this.entries.length) this.restore();

    log.debug('proxy pool ready', {
      configured: this.entries.length,
      strategy: this.strategy,
      sources: this.sources,
    });
  }

  private load(raw: string[], source: string): void {
    let added = 0;
    let rejected = 0;
    for (const item of raw) {
      const url = normalizeProxy(item);
      // Never echo the offending line: it is probably a malformed credential.
      if (!url) {
        if (item.trim() && !item.trim().startsWith('#')) rejected++;
        continue;
      }
      if (this.byUrl.has(url)) continue;

      const entry: Entry = {
        url,
        id: proxyId(url),
        label: proxyLabel(url),
        successes: 0,
        failures: 0,
        consecutiveFailures: 0,
        blocks: 0,
        latencies: [],
        lastUsedAt: null,
        benchedUntil: null,
        benchCount: 0,
        probing: false,
        hostBlocks: new Map(),
      };
      this.entries.push(entry);
      this.byUrl.set(url, entry);
      this.byId.set(entry.id, entry);
      this.rememberSecrets(url);
      added++;
    }
    if (added) this.sources.push(source);
    if (rejected) log.warn(`proxy pool: ignored ${rejected} unparseable entr(ies)`, { source });
  }

  /** Records the credential strings so `scrub` can remove them from any text. */
  private rememberSecrets(url: string): void {
    try {
      const u = new URL(url);
      for (const part of [u.password, u.username]) {
        if (!part) continue;
        this.secrets.add(part);
        const decoded = safeDecode(part);
        if (decoded !== part) this.secrets.add(decoded);
      }
      if (u.username || u.password) this.secrets.add(`${u.username}:${u.password}`);
    } catch {
      /* already validated on the way in */
    }
  }

  /**
   * Removes credentials from arbitrary text. Belt and braces: the generic
   * userinfo pattern, plus every credential substring this pool knows about, so
   * an error message that quotes a password in some other shape is still safe.
   */
  scrub(text: string): string {
    let out = redactProxyUrl(text);
    for (const secret of this.secrets) {
      if (secret.length < 3) continue;
      out = out.split(secret).join('***');
    }
    return out;
  }

  get size(): number {
    return this.entries.length;
  }

  /** True when nobody configured any proxies — the normal case. */
  get empty(): boolean {
    return this.entries.length === 0;
  }

  private state(entry: Entry, now: number): 'ok' | 'probation' | 'benched' {
    if (entry.benchedUntil === null) return 'ok';
    return now >= entry.benchedUntil ? 'probation' : 'benched';
  }

  /** Is this proxy still inside its cooldown for this specific host? */
  private hostBlocked(entry: Entry, host: string, now: number): boolean {
    if (!host) return false;
    const record = entry.hostBlocks.get(host);
    if (!record) return false;
    const wait = Math.min(
      this.maxBlockCooldownMs,
      this.blockCooldownMs * 2 ** Math.max(0, record.count - 1),
    );
    return now - record.lastAt < wait;
  }

  /**
   * The healthiest proxy for `host`, or null when nothing is usable.
   *
   * Benched proxies are skipped until their cooldown expires, at which point one
   * trial request is allowed through. Proxies that this host recently blocked
   * are skipped too — but only for this host, and if that would empty the pool
   * we hand back the least-recently-blocked one rather than refusing to work.
   */
  pick(host = '', strategy: RotationStrategy = this.strategy): string | null {
    if (this.empty) return null;
    const now = this.now();

    const live = this.entries.filter((e) => this.state(e, now) !== 'benched');
    if (!live.length) return null;

    const unblocked = live.filter((e) => !this.hostBlocked(e, host, now));
    const candidates = unblocked.length
      ? unblocked
      : [...live].sort(
          (a, b) =>
            (a.hostBlocks.get(host)?.lastAt ?? 0) - (b.hostBlocks.get(host)?.lastAt ?? 0),
        );

    const chosen = this.select(candidates, host, strategy);
    if (!chosen) return null;

    chosen.lastUsedAt = now;
    if (this.state(chosen, now) === 'probation') {
      chosen.probing = true;
      log.debug('proxy probe', { proxy: chosen.id });
    }
    if (strategy === 'sticky-per-host' && host) this.sticky.set(host, chosen.id);
    return chosen.url;
  }

  private select(candidates: Entry[], host: string, strategy: RotationStrategy): Entry | null {
    if (!candidates.length) return null;

    switch (strategy) {
      case 'round-robin': {
        // Walk the configured order so rotation is even across the whole list,
        // not just the candidate subset.
        const allowed = new Set(candidates);
        for (let i = 0; i < this.entries.length; i++) {
          const entry = this.entries[(this.cursor + i) % this.entries.length];
          if (allowed.has(entry)) {
            this.cursor = (this.cursor + i + 1) % this.entries.length;
            return entry;
          }
        }
        return candidates[0];
      }

      case 'least-recently-used':
        return candidates.reduce((best, e) =>
          (e.lastUsedAt ?? 0) < (best.lastUsedAt ?? 0) ? e : best,
        );

      case 'lowest-latency':
        // An unmeasured proxy goes first: it needs a sample before it can
        // compete, and otherwise the first fast proxy would starve the rest.
        return candidates.reduce((best, e) => {
          const em = median(e.latencies);
          const bm = median(best.latencies);
          if (em === null && bm === null) return best;
          if (em === null) return e;
          if (bm === null) return best;
          return em < bm ? e : best;
        });

      case 'sticky-per-host': {
        // One proxy per host keeps cookies and sessions coherent; rotating
        // mid-session is what logs you out.
        const pinned = host ? this.sticky.get(host) : undefined;
        if (pinned) {
          const entry = candidates.find((e) => e.id === pinned);
          if (entry) return entry;
        }
        // A host with no pin prefers a proxy no other host is sitting on, so
        // separate sessions land on separate IPs where there are enough to go
        // round; past that, fall back to the fastest.
        const taken = new Set(this.sticky.values());
        const free = candidates.filter((e) => !taken.has(e.id));
        return this.select(free.length ? free : candidates, host, 'lowest-latency');
      }
    }
  }

  /** Feeds a request's result back into the pool. */
  report(proxy: string, outcome: ProxyOutcome): void {
    const entry = this.find(proxy);
    if (!entry) {
      log.debug('proxy report for unknown proxy ignored', { proxy: proxyId(proxy) });
      return;
    }
    const now = this.now();
    const host = outcome.host ? hostOf(outcome.host) : '';

    if (typeof outcome.latencyMs === 'number' && outcome.latencyMs >= 0) {
      entry.latencies.push(outcome.latencyMs);
      if (entry.latencies.length > LATENCY_SAMPLES) entry.latencies.shift();
    }

    if (outcome.ok) {
      entry.successes++;
      entry.consecutiveFailures = 0;
      entry.probing = false;
      if (entry.benchedUntil !== null) {
        log.info('proxy back in service', { proxy: entry.id });
        entry.benchedUntil = null;
        entry.benchCount = 0;
      }
      if (host) entry.hostBlocks.delete(host);
    } else if (outcome.kind === 'blocked') {
      // The site's call, not the proxy's. Tracked per host so one hostile site
      // cannot bench an otherwise healthy egress IP.
      entry.blocks++;
      entry.probing = false;
      if (host) {
        const record = entry.hostBlocks.get(host) ?? { count: 0, lastAt: 0, lastReason: '' };
        record.count++;
        record.lastAt = now;
        record.lastReason = outcome.blockReason;
        entry.hostBlocks.set(host, record);
        // Sticky sessions are pointless once this host is pushing back.
        if (this.sticky.get(host) === entry.id) this.sticky.delete(host);
      }
      log.debug('proxy saw a site block', {
        proxy: entry.id,
        host,
        reason: outcome.blockReason,
      });
    } else {
      entry.failures++;
      entry.consecutiveFailures++;
      entry.lastError = this.scrub(outcome.error ?? 'proxy error');
      entry.lastErrorAt = now;

      // A failed trial run means the breaker re-opens immediately, longer.
      if (entry.probing || entry.consecutiveFailures >= this.maxConsecutiveFailures) {
        this.bench(entry, now);
      }
    }

    if (this.persist) this.save();
  }

  private bench(entry: Entry, now: number): void {
    entry.probing = false;
    entry.benchCount++;
    const wait = Math.min(this.maxCooldownMs, this.cooldownMs * 2 ** (entry.benchCount - 1));
    entry.benchedUntil = now + wait;
    for (const [host, id] of this.sticky) {
      if (id === entry.id) this.sticky.delete(host);
    }
    log.warn('proxy benched', {
      proxy: entry.id,
      forMs: wait,
      consecutiveFailures: entry.consecutiveFailures,
      lastError: entry.lastError,
    });
  }

  private find(proxy: string): Entry | undefined {
    const direct = this.byUrl.get(proxy);
    if (direct) return direct;
    const byId = this.byId.get(proxy);
    if (byId) return byId;
    const normalized = normalizeProxy(proxy);
    return normalized ? this.byUrl.get(normalized) : undefined;
  }

  /** Marks `entry` as a duplicate when an earlier proxy shares its egress IP. */
  private noteEgress(entry: Entry, ip: string): void {
    entry.egressIp = ip;
    entry.duplicateOf = undefined;
    for (const other of this.entries) {
      if (other === entry) break;
      if (other.egressIp === ip) {
        entry.duplicateOf = other.id;
        break;
      }
    }
  }

  /**
   * Probes every configured proxy against a neutral IP-echo endpoint.
   *
   * Never throws: an unreachable proxy is a result, not an exception. Results
   * feed back into health, so a check also un-benches a proxy that recovered.
   */
  async check(timeoutMs = 10_000): Promise<ProxyCheckResult[]> {
    const results: ProxyCheckResult[] = [];

    for (const entry of this.entries) {
      const started = this.now();
      let agent: ProxyAgent | undefined;
      try {
        agent = new ProxyAgent({ uri: entry.url, connect: { rejectUnauthorized: true } });
        const res = await undiciFetch(this.checkUrl, {
          method: 'GET',
          headers: { accept: 'application/json, text/plain' },
          signal: AbortSignal.timeout(timeoutMs),
          dispatcher: agent,
        } as Parameters<typeof undiciFetch>[1]);
        const body = await res.text();

        if (res.status >= 400) {
          throw new Error(`check endpoint returned ${res.status}`);
        }
        const latencyMs = Math.max(0, this.now() - started);
        const ip = parseEgressIp(body);
        if (ip) this.noteEgress(entry, ip);
        this.report(entry.url, { ok: true, latencyMs });
        results.push({
          proxy: entry.id,
          label: entry.label,
          ok: true,
          latencyMs,
          egressIp: ip ?? undefined,
          duplicateOf: entry.duplicateOf,
        });
      } catch (err) {
        const latencyMs = Math.max(0, this.now() - started);
        const error = this.scrub(describeError(err));
        this.report(entry.url, { ok: false, kind: 'proxy-error', error, latencyMs });
        results.push({ proxy: entry.id, label: entry.label, ok: false, latencyMs, error });
      } finally {
        try {
          await agent?.close();
        } catch {
          /* already gone */
        }
      }
    }

    return results;
  }

  status(): ProxyPoolStatus {
    const now = this.now();
    const proxies = this.entries.map<ProxyHealth>((e) => ({
      id: e.id,
      label: e.label,
      state: this.state(e, now),
      successes: e.successes,
      failures: e.failures,
      consecutiveFailures: e.consecutiveFailures,
      blocks: e.blocks,
      medianLatencyMs: median(e.latencies),
      lastUsedAt: e.lastUsedAt,
      benchedUntil: e.benchedUntil,
      benchCount: e.benchCount,
      lastError: e.lastError,
      lastErrorAt: e.lastErrorAt,
      egressIp: e.egressIp,
      duplicateOf: e.duplicateOf,
      hostBlocks: [...e.hostBlocks.entries()].map(([host, r]) => ({ host, ...r })),
    }));

    return {
      configured: proxies.length,
      available: proxies.filter((p) => p.state !== 'benched').length,
      benched: proxies.filter((p) => p.state === 'benched').length,
      strategy: this.strategy,
      sources: [...this.sources],
      proxies,
      stickyAssignments: [...this.sticky.entries()].map(([host, proxy]) => ({ host, proxy })),
    };
  }

  // --- optional persistence -------------------------------------------------
  // Keyed by the redacted id, so the state file never holds a credential.

  private statePath(): string {
    return join(DATA_DIR, 'proxy-state.json');
  }

  private save(): void {
    try {
      ensureDataDirs();
      const rows: PersistedEntry[] = this.entries.map((e) => ({
        id: e.id,
        successes: e.successes,
        failures: e.failures,
        blocks: e.blocks,
        latencies: e.latencies,
        benchedUntil: e.benchedUntil,
        benchCount: e.benchCount,
        lastError: e.lastError,
        lastErrorAt: e.lastErrorAt,
      }));
      writeFileSync(this.statePath(), JSON.stringify(rows), 'utf8');
    } catch (err) {
      log.debug('could not persist proxy state', String(err));
    }
  }

  private restore(): void {
    try {
      const rows = JSON.parse(readFileSync(this.statePath(), 'utf8')) as PersistedEntry[];
      if (!Array.isArray(rows)) return;
      for (const row of rows) {
        const entry = this.byId.get(row.id);
        if (!entry) continue;
        entry.successes = row.successes ?? 0;
        entry.failures = row.failures ?? 0;
        entry.blocks = row.blocks ?? 0;
        entry.latencies = Array.isArray(row.latencies) ? row.latencies.slice(-LATENCY_SAMPLES) : [];
        entry.benchedUntil = row.benchedUntil ?? null;
        entry.benchCount = row.benchCount ?? 0;
        entry.lastError = row.lastError;
        entry.lastErrorAt = row.lastErrorAt;
      }
    } catch {
      /* no state yet */
    }
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseEgressIp(body: string): string | null {
  const text = body.trim().slice(0, 2000);
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    for (const key of ['ip', 'origin', 'query', 'ip_addr']) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim()) return value.trim().split(/,\s*/)[0];
    }
  } catch {
    /* plain text endpoint */
  }
  const match = /\b(\d{1,3}(?:\.\d{1,3}){3})\b|\b([0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7})\b/i.exec(
    text,
  );
  return match ? (match[1] ?? match[2]) : null;
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    const cause = (err as { cause?: unknown }).cause;
    const causeCode =
      cause && typeof cause === 'object' ? (cause as { code?: string }).code : undefined;
    const bits = [err.name === 'Error' ? '' : err.name, err.message, code ?? causeCode]
      .filter(Boolean)
      .join(': ');
    return bits || 'proxy error';
  }
  return String(err);
}

/**
 * Was this a failure of the proxy, or of the site?
 *
 * Transport-level errors (refused, reset, DNS, timeout, 407 proxy auth) are the
 * proxy's fault and count toward the circuit breaker. Anything the site chose
 * to send us is not.
 */
const PROXY_ERROR_CODES = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPROTO',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED',
];

export function isProxyTransportError(err: unknown): boolean {
  const text = describeError(err).toUpperCase();
  if (PROXY_ERROR_CODES.some((code) => text.includes(code))) return true;
  return /\b(TIMEOUTERROR|ABORTERROR|PROXY|TUNNEL|SOCKET HANG UP)\b/.test(text);
}

/** Turns a thrown fetch error into an outcome for `report`. */
export function outcomeFromError(
  err: unknown,
  host?: string,
  latencyMs?: number,
): ProxyOutcome {
  return {
    ok: false,
    kind: 'proxy-error',
    host,
    error: redactProxyUrl(describeError(err)),
    latencyMs,
  };
}

/**
 * Turns a completed response into an outcome.
 *
 * `blockReason` is whatever `detectBlock()` in ./http.js returned, so the pool's
 * notion of "blocked" is exactly the fetcher's — one classifier, not two. A 407
 * is the exception: that is the proxy rejecting our credentials, not the site.
 */
export function outcomeFromResponse(
  status: number,
  blockReason: string | null | undefined,
  host?: string,
  latencyMs?: number,
): ProxyOutcome {
  if (status === 407) {
    return {
      ok: false,
      kind: 'proxy-error',
      host,
      error: 'proxy authentication required (407)',
      latencyMs,
    };
  }
  if (blockReason) return { ok: false, kind: 'blocked', host, blockReason, latencyMs };
  return { ok: true, host, latencyMs };
}

// --- the seam the fetch path uses -------------------------------------------

let singleton: ProxyPool | null = null;

/** The process-wide pool, built from the environment on first use. */
export function getProxyPool(): ProxyPool {
  if (!singleton) singleton = new ProxyPool();
  return singleton;
}

/** Replaces the process-wide pool (tests, or a reload after config changes). */
export function setProxyPool(pool: ProxyPool | null): void {
  singleton = pool;
}

/**
 * A proxy URL to use for `target`, or null.
 *
 * Null is the normal answer: with no proxies configured the caller should fetch
 * directly, exactly as it does today.
 */
export function nextProxy(target = '', strategy?: RotationStrategy): string | null {
  const pool = getProxyPool();
  if (pool.empty) return null;
  return pool.pick(hostOf(target), strategy ?? pool.strategy);
}

/** Feeds a request's result back to the pool. No-op when the proxy is unknown. */
export function reportProxyOutcome(
  proxy: string | null | undefined,
  target: string,
  result: ProxyOutcome,
): void {
  if (!proxy) return;
  const pool = getProxyPool();
  if (pool.empty) return;
  pool.report(proxy, { ...result, host: hostOf(target || result.host || '') } as ProxyOutcome);
}

export function proxyPoolStatus(): ProxyPoolStatus {
  return getProxyPool().status();
}

export function checkProxyPool(timeoutMs?: number): Promise<ProxyCheckResult[]> {
  return getProxyPool().check(timeoutMs);
}
