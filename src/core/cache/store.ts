import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, statSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { BODIES_DIR, DB_PATH, ensureDataDirs } from '../util/paths.js';
import { normalizeUrl } from '../util/url.js';
import { log } from '../util/log.js';
import type { FetchedPage, RenderMode } from '../types.js';

let db: DatabaseSync | null = null;

function handle(): DatabaseSync {
  if (db) return db;
  ensureDataDirs();
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    -- The MCP server, CLI scripts and crawl workers all open this file. WAL
    -- allows one writer plus many readers; busy_timeout makes a blocked writer
    -- wait its turn instead of failing instantly with SQLITE_BUSY.
    PRAGMA busy_timeout = 10000;

    CREATE TABLE IF NOT EXISTS raw (
      key           TEXT PRIMARY KEY,
      url           TEXT NOT NULL,
      final_url     TEXT NOT NULL,
      status        INTEGER NOT NULL,
      content_type  TEXT,
      rendered_with TEXT NOT NULL,
      body_sha      TEXT NOT NULL,
      bytes         INTEGER NOT NULL,
      fetched_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS raw_url_idx ON raw(url);
    CREATE INDEX IF NOT EXISTS raw_fetched_idx ON raw(fetched_at);
  `);

  // Validators arrived after the first release, so add them to existing
  // databases. CREATE TABLE IF NOT EXISTS never alters an existing table.
  const columns = (db.prepare('PRAGMA table_info(raw)').all() as Record<string, unknown>[]).map(
    (row) => String(row.name),
  );
  if (!columns.includes('etag')) db.exec('ALTER TABLE raw ADD COLUMN etag TEXT');
  if (!columns.includes('last_modified')) db.exec('ALTER TABLE raw ADD COLUMN last_modified TEXT');

  return db;
}

/**
 * Cache key deliberately ignores output formats: we cache the RAW fetch, so
 * re-scraping the same URL for different formats costs nothing but CPU.
 */
function cacheKey(url: string, render: RenderMode): string {
  const bucket = render === 'browser' ? 'browser' : 'http';
  return createHash('sha1').update(`${bucket}\n${normalizeUrl(url)}`).digest('hex');
}

function bodyPath(sha: string): string {
  return join(BODIES_DIR, `${sha.slice(0, 2)}`, `${sha}.bin`);
}

export interface CachedRaw extends FetchedPage {
  fetchedAt: number;
  ageMs: number;
  etag?: string;
  lastModified?: string;
}

/**
 * HTTP validators for a stored copy, regardless of how old it is.
 *
 * This is what makes a re-crawl cheap: with an ETag we can ask the server
 * "has this changed?" and a 304 answer costs a few hundred bytes instead of
 * re-downloading and re-parsing the whole page.
 */
export interface CachedValidators {
  etag?: string;
  lastModified?: string;
  ageMs: number;
  bodySha: string;
}

export function getValidators(url: string, render: RenderMode): CachedValidators | null {
  const row = handle()
    .prepare('SELECT etag, last_modified, fetched_at, body_sha FROM raw WHERE key = ?')
    .get(cacheKey(url, render)) as Record<string, unknown> | undefined;
  if (!row) return null;

  const etag = row.etag ? String(row.etag) : undefined;
  const lastModified = row.last_modified ? String(row.last_modified) : undefined;
  if (!etag && !lastModified) return null;
  if (!existsSync(bodyPath(String(row.body_sha)))) return null;

  return {
    etag,
    lastModified,
    ageMs: Date.now() - Number(row.fetched_at),
    bodySha: String(row.body_sha),
  };
}

/** Loads a stored body by hash, for serving a revalidated (304) response. */
export function loadBody(bodySha: string): Buffer | null {
  const path = bodyPath(bodySha);
  return existsSync(path) ? readFileSync(path) : null;
}

/** A 304 means the stored copy is current, so only its timestamp changes. */
export function markRevalidated(url: string, render: RenderMode): void {
  try {
    handle()
      .prepare('UPDATE raw SET fetched_at = ? WHERE key = ?')
      .run(Date.now(), cacheKey(url, render));
  } catch (err) {
    log.warn('cache revalidate touch failed', String(err));
  }
}

/** Returns a cached fetch when one exists and is younger than maxAge. */
export function getRaw(url: string, render: RenderMode, maxAgeMs: number): CachedRaw | null {
  if (maxAgeMs <= 0) return null;
  const row = handle()
    .prepare('SELECT * FROM raw WHERE key = ?')
    .get(cacheKey(url, render)) as Record<string, any> | undefined;
  if (!row) return null;

  const ageMs = Date.now() - Number(row.fetched_at);
  if (ageMs > maxAgeMs) return null;

  const path = bodyPath(String(row.body_sha));
  if (!existsSync(path)) return null;

  return {
    url: String(row.url),
    finalUrl: String(row.final_url),
    status: Number(row.status),
    contentType: String(row.content_type ?? ''),
    body: readFileSync(path),
    renderedWith: String(row.rendered_with) as FetchedPage['renderedWith'],
    fetchedAt: Number(row.fetched_at),
    ageMs,
    etag: row.etag ? String(row.etag) : undefined,
    lastModified: row.last_modified ? String(row.last_modified) : undefined,
  };
}

/** Stores a fetch. Bodies are de-duplicated by content hash. */
export function putRaw(page: FetchedPage, render: RenderMode): void {
  try {
    ensureDataDirs();
    const sha = createHash('sha256').update(page.body).digest('hex');
    const path = bodyPath(sha);
    if (!existsSync(path)) {
      mkdirSync(join(BODIES_DIR, sha.slice(0, 2)), { recursive: true });
      writeFileSync(path, page.body);
    }
    handle()
      .prepare(
        `INSERT INTO raw (key, url, final_url, status, content_type, rendered_with, body_sha, bytes, fetched_at, etag, last_modified)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           final_url=excluded.final_url, status=excluded.status,
           content_type=excluded.content_type, rendered_with=excluded.rendered_with,
           body_sha=excluded.body_sha, bytes=excluded.bytes, fetched_at=excluded.fetched_at,
           etag=excluded.etag, last_modified=excluded.last_modified`,
      )
      .run(
        cacheKey(page.url, render),
        normalizeUrl(page.url),
        page.finalUrl,
        page.status,
        page.contentType,
        page.renderedWith,
        sha,
        page.body.byteLength,
        Date.now(),
        page.etag ?? null,
        page.lastModified ?? null,
      );
  } catch (err) {
    log.warn('cache write failed', String(err));
  }
}

/* ------------------------------------------------------------------ */
/* Extraction cache                                                    */
/* ------------------------------------------------------------------ */

/**
 * Caches the *result* of converting a page, not just the bytes.
 *
 * Revalidating a large page with a 304 saves the download but not the parse,
 * and for something like a 239 KB Wikipedia article the parse is most of the
 * time. The key is content-addressed — the body's hash plus the options that
 * affect extraction — so a changed page can never hit a stale entry.
 */
let extractTableReady = false;

function extractTable() {
  const h = handle();
  if (!extractTableReady) {
    h.exec(`
      CREATE TABLE IF NOT EXISTS extract_cache (
        key        TEXT PRIMARY KEY,
        body_sha   TEXT NOT NULL,
        payload    TEXT NOT NULL,
        bytes      INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS extract_created_idx ON extract_cache(created_at);
    `);
    extractTableReady = true;
  }
  return h;
}

function extractKey(bodySha: string, optsFingerprint: string): string {
  return createHash('sha1').update(bodySha).update('\n').update(optsFingerprint).digest('hex');
}

/** Only worth caching when parsing actually cost something. */
export const EXTRACT_CACHE_MIN_BYTES = 40_000;

export function getExtract<T>(bodySha: string, optsFingerprint: string): T | null {
  try {
    const row = extractTable()
      .prepare('SELECT payload FROM extract_cache WHERE key = ?')
      .get(extractKey(bodySha, optsFingerprint)) as Record<string, unknown> | undefined;
    if (!row) return null;
    return JSON.parse(String(row.payload)) as T;
  } catch (err) {
    log.debug('extract cache read failed', String(err));
    return null;
  }
}

export function putExtract(bodySha: string, optsFingerprint: string, value: unknown): void {
  try {
    const payload = JSON.stringify(value);
    extractTable()
      .prepare(
        `INSERT INTO extract_cache (key, body_sha, payload, bytes, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET payload=excluded.payload, created_at=excluded.created_at`,
      )
      .run(
        extractKey(bodySha, optsFingerprint),
        bodySha,
        payload,
        Buffer.byteLength(payload),
        Date.now(),
      );
  } catch (err) {
    log.debug('extract cache write failed', String(err));
  }
}

/** Hash of a body, so callers can key the extraction cache the same way. */
export function bodyHash(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

export function cacheStats(): { entries: number; bytes: number; oldest: number | null } {
  const row = handle()
    .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS b, MIN(fetched_at) AS o FROM raw')
    .get() as Record<string, any>;
  return { entries: Number(row.n), bytes: Number(row.b), oldest: row.o ? Number(row.o) : null };
}

/** Drops entries older than the given age and deletes orphaned bodies. */
export function pruneCache(olderThanMs: number): number {
  const cutoff = Date.now() - olderThanMs;
  const victims = handle()
    .prepare('SELECT key, body_sha FROM raw WHERE fetched_at < ?')
    .all(cutoff) as Record<string, any>[];
  const del = handle().prepare('DELETE FROM raw WHERE key = ?');
  for (const v of victims) del.run(String(v.key));
  for (const v of victims) {
    const sha = String(v.body_sha);
    const stillUsed = handle().prepare('SELECT 1 FROM raw WHERE body_sha = ? LIMIT 1').get(sha);
    if (!stillUsed) {
      const p = bodyPath(sha);
      try { if (existsSync(p) && statSync(p).isFile()) unlinkSync(p); } catch { /* ignore */ }
    }
  }
  return victims.length;
}

export function rawDb(): DatabaseSync {
  return handle();
}
