import { randomUUID } from 'node:crypto';
import { rawDb } from '../cache/store.js';
import { normalizeUrl } from '../util/url.js';
import { log } from '../util/log.js';
import type { ScrapeOptions } from '../types.js';

/**
 * Monitor storage.
 *
 * Monitors live in SQLite next to the cache so a restart does not lose the
 * schedule: `next_check_at` is persisted on every check, and the engine reads
 * it back at startup. Tables are all prefixed `monitor_`.
 *
 * Disk growth is the thing to watch. A monitor checked every ten minutes
 * produces 4,300 rows a month, so history is capped per monitor
 * (`history_limit`, default 20) and the page snapshot — the only big column —
 * is kept on just the newest few checks, which is all a diff needs. Older rows
 * keep their counts, summary and diff, and drop the snapshot.
 */

export type MonitorStatus = 'active' | 'paused';
export type MonitorEvent = 'checked' | 'changed' | 'error';

export interface MonitorWebhook {
  url: string;
  secret?: string;
  events?: MonitorEvent[];
}

export interface MonitorOptions {
  /** Passed through to `scrape` on every check. */
  scrapeOptions?: ScrapeOptions;
  /** POST on change. Signed with HMAC-SHA256 when `secret` is set. */
  webhook?: MonitorWebhook;
  /** Cap on the rendered diff per check. Default 2000. */
  maxDiffChars?: number;
  /** Cap on the stored snapshot used as the next diff baseline. Default 60000. */
  maxSnapshotChars?: number;
}

export interface MonitorRecord {
  id: string;
  url: string;
  label?: string;
  status: MonitorStatus;
  intervalMs: number;
  historyLimit: number;
  options: MonitorOptions;
  createdAt: number;
  updatedAt: number;
  nextCheckAt?: number;
  lastCheckAt?: number;
  lastHash?: string;
  lastChangeAt?: number;
  checkCount: number;
  changeCount: number;
  error?: string;
}

export interface CheckRecord {
  id: string;
  monitorId: string;
  checkedAt: number;
  status?: number;
  changed: boolean;
  /** True for the first check, which has nothing to compare against. */
  baseline: boolean;
  contentHash?: string;
  previousHash?: string;
  chars?: number;
  addedLines: number;
  removedLines: number;
  summary?: string;
  characterization?: string;
  diff?: string;
  diffTruncatedChars?: number;
  error?: string;
}

export interface CreateMonitorInput {
  url: string;
  label?: string;
  intervalMs?: number;
  historyLimit?: number;
  status?: MonitorStatus;
  options?: MonitorOptions;
}

export interface UpdateMonitorInput {
  label?: string;
  intervalMs?: number;
  historyLimit?: number;
  status?: MonitorStatus;
  options?: MonitorOptions;
  /** Replace `options` wholesale instead of merging. */
  replaceOptions?: boolean;
}

export const DEFAULT_INTERVAL_MS = 3_600_000; // 1 hour
export const MIN_INTERVAL_MS = 30_000;
export const DEFAULT_HISTORY_LIMIT = 20;
export const DEFAULT_MAX_DIFF_CHARS = 2000;
export const DEFAULT_MAX_SNAPSHOT_CHARS = 60_000;
/** How many of the newest checks keep their page snapshot. */
export const SNAPSHOT_RETAIN = 2;

let migrated = false;

function db() {
  const handle = rawDb();
  if (migrated) return handle;

  handle.exec(`
    CREATE TABLE IF NOT EXISTS monitor_monitors (
      id             TEXT PRIMARY KEY,
      url            TEXT NOT NULL,
      label          TEXT,
      status         TEXT NOT NULL,
      interval_ms    INTEGER NOT NULL,
      history_limit  INTEGER NOT NULL,
      options        TEXT NOT NULL,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
      next_check_at  INTEGER,
      last_check_at  INTEGER,
      last_hash      TEXT,
      last_change_at INTEGER,
      check_count    INTEGER NOT NULL DEFAULT 0,
      change_count   INTEGER NOT NULL DEFAULT 0,
      error          TEXT
    );
    CREATE INDEX IF NOT EXISTS monitor_monitors_due
      ON monitor_monitors(status, next_check_at);

    CREATE TABLE IF NOT EXISTS monitor_checks (
      id              TEXT PRIMARY KEY,
      monitor_id      TEXT NOT NULL,
      checked_at      INTEGER NOT NULL,
      status          INTEGER,
      changed         INTEGER NOT NULL DEFAULT 0,
      baseline        INTEGER NOT NULL DEFAULT 0,
      content_hash    TEXT,
      previous_hash   TEXT,
      chars           INTEGER,
      added_lines     INTEGER NOT NULL DEFAULT 0,
      removed_lines   INTEGER NOT NULL DEFAULT 0,
      summary         TEXT,
      characterization TEXT,
      diff            TEXT,
      diff_truncated  INTEGER,
      snapshot        TEXT,
      error           TEXT
    );
    CREATE INDEX IF NOT EXISTS monitor_checks_recent
      ON monitor_checks(monitor_id, checked_at DESC);

    CREATE TABLE IF NOT EXISTS monitor_snapshots (
      key          TEXT PRIMARY KEY,
      url          TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      content      TEXT NOT NULL,
      chars        INTEGER NOT NULL,
      captured_at  INTEGER NOT NULL
    );
  `);

  migrated = true;
  return handle;
}

function parseOptions(raw: unknown): MonitorOptions {
  try {
    return JSON.parse(String(raw)) as MonitorOptions;
  } catch {
    return {};
  }
}

function toMonitor(row: Record<string, unknown>): MonitorRecord {
  return {
    id: String(row.id),
    url: String(row.url),
    label: row.label ? String(row.label) : undefined,
    status: String(row.status) as MonitorStatus,
    intervalMs: Number(row.interval_ms),
    historyLimit: Number(row.history_limit),
    options: parseOptions(row.options),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    nextCheckAt: row.next_check_at == null ? undefined : Number(row.next_check_at),
    lastCheckAt: row.last_check_at == null ? undefined : Number(row.last_check_at),
    lastHash: row.last_hash ? String(row.last_hash) : undefined,
    lastChangeAt: row.last_change_at == null ? undefined : Number(row.last_change_at),
    checkCount: Number(row.check_count ?? 0),
    changeCount: Number(row.change_count ?? 0),
    error: row.error ? String(row.error) : undefined,
  };
}

function toCheck(row: Record<string, unknown>): CheckRecord {
  return {
    id: String(row.id),
    monitorId: String(row.monitor_id),
    checkedAt: Number(row.checked_at),
    status: row.status == null ? undefined : Number(row.status),
    changed: Number(row.changed ?? 0) === 1,
    baseline: Number(row.baseline ?? 0) === 1,
    contentHash: row.content_hash ? String(row.content_hash) : undefined,
    previousHash: row.previous_hash ? String(row.previous_hash) : undefined,
    chars: row.chars == null ? undefined : Number(row.chars),
    addedLines: Number(row.added_lines ?? 0),
    removedLines: Number(row.removed_lines ?? 0),
    summary: row.summary ? String(row.summary) : undefined,
    characterization: row.characterization ? String(row.characterization) : undefined,
    diff: row.diff ? String(row.diff) : undefined,
    diffTruncatedChars: row.diff_truncated == null ? undefined : Number(row.diff_truncated),
    error: row.error ? String(row.error) : undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Monitors                                                            */
/* ------------------------------------------------------------------ */

export function createMonitor(input: CreateMonitorInput): MonitorRecord {
  const url = normalizeUrl(input.url);
  const id = `mon_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const now = Date.now();
  const intervalMs = Math.max(MIN_INTERVAL_MS, input.intervalMs ?? DEFAULT_INTERVAL_MS);
  const historyLimit = Math.max(1, input.historyLimit ?? DEFAULT_HISTORY_LIMIT);
  const status: MonitorStatus = input.status ?? 'active';

  db()
    .prepare(
      `INSERT INTO monitor_monitors
         (id, url, label, status, interval_ms, history_limit, options,
          created_at, updated_at, next_check_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      url,
      input.label ?? null,
      status,
      intervalMs,
      historyLimit,
      JSON.stringify(input.options ?? {}),
      now,
      now,
      status === 'active' ? now : null,
    );

  return getMonitor(id)!;
}

export function getMonitor(id: string): MonitorRecord | null {
  const row = db().prepare('SELECT * FROM monitor_monitors WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? toMonitor(row) : null;
}

export function listMonitors(limit = 50): MonitorRecord[] {
  const rows = db()
    .prepare('SELECT * FROM monitor_monitors ORDER BY created_at DESC LIMIT ?')
    .all(limit) as Record<string, unknown>[];
  return rows.map(toMonitor);
}

export function updateMonitor(id: string, patch: UpdateMonitorInput): MonitorRecord | null {
  const current = getMonitor(id);
  if (!current) return null;

  const intervalMs =
    patch.intervalMs === undefined
      ? current.intervalMs
      : Math.max(MIN_INTERVAL_MS, patch.intervalMs);
  const historyLimit =
    patch.historyLimit === undefined ? current.historyLimit : Math.max(1, patch.historyLimit);
  const status = patch.status ?? current.status;
  const options = patch.replaceOptions
    ? (patch.options ?? {})
    : { ...current.options, ...(patch.options ?? {}) };

  // Re-anchor the schedule when the interval changes or the monitor resumes.
  let nextCheckAt = current.nextCheckAt ?? null;
  if (status === 'paused') nextCheckAt = null;
  else if (current.status === 'paused') nextCheckAt = Date.now();
  else if (patch.intervalMs !== undefined) {
    nextCheckAt = (current.lastCheckAt ?? Date.now()) + intervalMs;
  }

  db()
    .prepare(
      `UPDATE monitor_monitors
         SET label = ?, status = ?, interval_ms = ?, history_limit = ?, options = ?,
             updated_at = ?, next_check_at = ?
       WHERE id = ?`,
    )
    .run(
      patch.label === undefined ? (current.label ?? null) : patch.label,
      status,
      intervalMs,
      historyLimit,
      JSON.stringify(options),
      Date.now(),
      nextCheckAt,
      id,
    );

  pruneChecks(id, historyLimit);
  return getMonitor(id);
}

export function deleteMonitor(id: string): boolean {
  const handle = db();
  handle.prepare('DELETE FROM monitor_checks WHERE monitor_id = ?').run(id);
  const result = handle.prepare('DELETE FROM monitor_monitors WHERE id = ?').run(id);
  return Number(result.changes) > 0;
}

export function setNextCheck(id: string, at: number | null): void {
  db()
    .prepare('UPDATE monitor_monitors SET next_check_at = ?, updated_at = ? WHERE id = ?')
    .run(at, Date.now(), id);
}

/** Active monitors whose next check is due. */
export function dueMonitors(now = Date.now(), limit = 50): MonitorRecord[] {
  const rows = db()
    .prepare(
      `SELECT * FROM monitor_monitors
       WHERE status = 'active' AND next_check_at IS NOT NULL AND next_check_at <= ?
       ORDER BY next_check_at ASC LIMIT ?`,
    )
    .all(now, limit) as Record<string, unknown>[];
  return rows.map(toMonitor);
}

/** When the next active monitor falls due, or null when nothing is scheduled. */
export function earliestNextCheck(): number | null {
  const row = db()
    .prepare(
      `SELECT MIN(next_check_at) AS at FROM monitor_monitors
       WHERE status = 'active' AND next_check_at IS NOT NULL`,
    )
    .get() as Record<string, unknown> | undefined;
  return row?.at == null ? null : Number(row.at);
}

/**
 * Gives active monitors that lost their schedule (a crash between check and
 * write, or a row created while paused) a due time of now. Returns how many
 * were repaired.
 */
export function repairSchedules(): number {
  const result = db()
    .prepare(
      `UPDATE monitor_monitors SET next_check_at = ?, updated_at = ?
       WHERE status = 'active' AND next_check_at IS NULL`,
    )
    .run(Date.now(), Date.now());
  return Number(result.changes);
}

/* ------------------------------------------------------------------ */
/* Checks                                                              */
/* ------------------------------------------------------------------ */

export interface RecordCheckInput {
  monitorId: string;
  checkedAt?: number;
  status?: number;
  changed: boolean;
  baseline?: boolean;
  contentHash?: string;
  previousHash?: string;
  chars?: number;
  addedLines?: number;
  removedLines?: number;
  summary?: string;
  characterization?: string;
  diff?: string;
  diffTruncatedChars?: number;
  /** Content to keep as the next diff baseline. Truncated by the caller's cap. */
  snapshot?: string;
  error?: string;
  /** False for rows that are not a fetch of the page (a hand-seeded baseline). */
  countsAsCheck?: boolean;
}

export function recordCheck(input: RecordCheckInput): CheckRecord {
  const id = `chk_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const checkedAt = input.checkedAt ?? Date.now();
  const handle = db();

  handle
    .prepare(
      `INSERT INTO monitor_checks
         (id, monitor_id, checked_at, status, changed, baseline, content_hash, previous_hash,
          chars, added_lines, removed_lines, summary, characterization, diff, diff_truncated,
          snapshot, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.monitorId,
      checkedAt,
      input.status ?? null,
      input.changed ? 1 : 0,
      input.baseline ? 1 : 0,
      input.contentHash ?? null,
      input.previousHash ?? null,
      input.chars ?? null,
      input.addedLines ?? 0,
      input.removedLines ?? 0,
      input.summary ?? null,
      input.characterization ?? null,
      input.diff ?? null,
      input.diffTruncatedChars ?? null,
      input.snapshot ?? null,
      input.error ?? null,
    );

  const monitor = getMonitor(input.monitorId);
  if (monitor) {
    handle
      .prepare(
        `UPDATE monitor_monitors
           SET last_check_at = CASE WHEN ? = 1 THEN ? ELSE last_check_at END,
               check_count = check_count + ?,
               change_count = change_count + ?,
               last_hash = COALESCE(?, last_hash),
               last_change_at = CASE WHEN ? = 1 THEN ? ELSE last_change_at END,
               error = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.countsAsCheck === false ? 0 : 1,
        checkedAt,
        input.countsAsCheck === false ? 0 : 1,
        input.changed ? 1 : 0,
        input.contentHash ?? null,
        input.changed ? 1 : 0,
        checkedAt,
        input.error ?? null,
        Date.now(),
        input.monitorId,
      );
    pruneChecks(input.monitorId, monitor.historyLimit);
  }

  const row = handle.prepare('SELECT * FROM monitor_checks WHERE id = ?').get(id) as Record<
    string,
    unknown
  >;
  return toCheck(row);
}

export function listChecks(monitorId: string, limit = 10): CheckRecord[] {
  const rows = db()
    .prepare(
      'SELECT * FROM monitor_checks WHERE monitor_id = ? ORDER BY checked_at DESC LIMIT ?',
    )
    .all(monitorId, limit) as Record<string, unknown>[];
  return rows.map(toCheck);
}

export function getCheck(checkId: string): CheckRecord | null {
  const row = db().prepare('SELECT * FROM monitor_checks WHERE id = ?').get(checkId) as
    | Record<string, unknown>
    | undefined;
  return row ? toCheck(row) : null;
}

export interface Baseline {
  content: string;
  hash: string;
  at: number;
}

/** The newest stored snapshot for a monitor: what the next check diffs against. */
export function latestBaseline(monitorId: string): Baseline | null {
  const row = db()
    .prepare(
      `SELECT snapshot, content_hash, checked_at FROM monitor_checks
       WHERE monitor_id = ? AND snapshot IS NOT NULL
       ORDER BY checked_at DESC LIMIT 1`,
    )
    .get(monitorId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    content: String(row.snapshot),
    hash: String(row.content_hash ?? ''),
    at: Number(row.checked_at),
  };
}

/**
 * Writes a baseline by hand, as a check row with `baseline` set. Useful to
 * start monitoring from content you already have (and to exercise the diff
 * path in tests without waiting for a site to change).
 */
export function seedBaseline(monitorId: string, content: string, hash: string): CheckRecord {
  return recordCheck({
    monitorId,
    changed: false,
    baseline: true,
    contentHash: hash,
    chars: content.length,
    summary: 'baseline seeded',
    snapshot: content,
    countsAsCheck: false,
  });
}

/**
 * Enforces the per-monitor history cap, then drops snapshots from all but the
 * newest few rows. The snapshot is the only large column, so this is what
 * keeps a long-running monitor from growing without bound.
 */
export function pruneChecks(monitorId: string, historyLimit: number): void {
  const handle = db();
  try {
    handle
      .prepare(
        `DELETE FROM monitor_checks
         WHERE monitor_id = ? AND id NOT IN (
           SELECT id FROM monitor_checks WHERE monitor_id = ?
           ORDER BY checked_at DESC LIMIT ?
         )`,
      )
      .run(monitorId, monitorId, Math.max(1, historyLimit));

    handle
      .prepare(
        `UPDATE monitor_checks SET snapshot = NULL
         WHERE monitor_id = ? AND snapshot IS NOT NULL AND id NOT IN (
           SELECT id FROM monitor_checks
           WHERE monitor_id = ? AND snapshot IS NOT NULL
           ORDER BY checked_at DESC LIMIT ?
         )`,
      )
      .run(monitorId, monitorId, SNAPSHOT_RETAIN);
  } catch (err) {
    log.warn('monitor history prune failed', String(err));
  }
}

/* ------------------------------------------------------------------ */
/* Standalone snapshots (changeTracking)                               */
/* ------------------------------------------------------------------ */

export interface StoredSnapshot {
  url: string;
  hash: string;
  content: string;
  chars: number;
  capturedAt: number;
}

function snapshotKey(url: string, tag?: string): string {
  return `${tag ?? 'default'}\n${normalizeUrl(url)}`;
}

export function getSnapshot(url: string, tag?: string): StoredSnapshot | null {
  const row = db()
    .prepare('SELECT * FROM monitor_snapshots WHERE key = ?')
    .get(snapshotKey(url, tag)) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    url: String(row.url),
    hash: String(row.content_hash),
    content: String(row.content),
    chars: Number(row.chars),
    capturedAt: Number(row.captured_at),
  };
}

export function putSnapshot(
  url: string,
  content: string,
  hash: string,
  tag?: string,
): void {
  db()
    .prepare(
      `INSERT INTO monitor_snapshots (key, url, content_hash, content, chars, captured_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         content_hash = excluded.content_hash, content = excluded.content,
         chars = excluded.chars, captured_at = excluded.captured_at`,
    )
    .run(snapshotKey(url, tag), normalizeUrl(url), hash, content, content.length, Date.now());
}

export function deleteSnapshot(url: string, tag?: string): boolean {
  const result = db()
    .prepare('DELETE FROM monitor_snapshots WHERE key = ?')
    .run(snapshotKey(url, tag));
  return Number(result.changes) > 0;
}

/* ------------------------------------------------------------------ */
/* Housekeeping                                                        */
/* ------------------------------------------------------------------ */

export interface MonitorStats {
  monitors: number;
  active: number;
  checks: number;
  snapshots: number;
  snapshotBytes: number;
}

export function monitorStats(): MonitorStats {
  const handle = db();
  const m = handle
    .prepare(
      "SELECT COUNT(*) AS n, SUM(status = 'active') AS a FROM monitor_monitors",
    )
    .get() as Record<string, unknown>;
  const c = handle
    .prepare(
      "SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(COALESCE(snapshot, ''))), 0) AS b FROM monitor_checks",
    )
    .get() as Record<string, unknown>;
  const s = handle
    .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(chars), 0) AS b FROM monitor_snapshots')
    .get() as Record<string, unknown>;

  return {
    monitors: Number(m?.n ?? 0),
    active: Number(m?.a ?? 0),
    checks: Number(c?.n ?? 0),
    snapshots: Number(s?.n ?? 0),
    snapshotBytes: Number(c?.b ?? 0) + Number(s?.b ?? 0),
  };
}
