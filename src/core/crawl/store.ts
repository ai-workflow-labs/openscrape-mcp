import { randomUUID } from 'node:crypto';
import { rawDb } from '../cache/store.js';
import { normalizeUrl } from '../util/url.js';
import { log } from '../util/log.js';

/**
 * Crawl job storage.
 *
 * Everything lives in SQLite rather than in memory, for two reasons: a long
 * crawl survives a restart (Firecrawl calls this crash recovery), and the
 * crawled corpus stays queryable afterwards through FTS5 instead of being
 * thrown away once the job finishes.
 */
export type JobKind = 'crawl' | 'batch';
export type JobStatus = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
export type FrontierState = 'pending' | 'active' | 'done' | 'failed' | 'skipped';

let migrated = false;

function db() {
  const handle = rawDb();
  if (migrated) return handle;

  handle.exec(`
    CREATE TABLE IF NOT EXISTS crawl_jobs (
      id          TEXT PRIMARY KEY,
      kind        TEXT NOT NULL,
      root_url    TEXT NOT NULL,
      status      TEXT NOT NULL,
      options     TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      finished_at INTEGER,
      error       TEXT
    );

    CREATE TABLE IF NOT EXISTS crawl_frontier (
      job_id    TEXT NOT NULL,
      url       TEXT NOT NULL,
      depth     INTEGER NOT NULL,
      score     REAL NOT NULL DEFAULT 0,
      state     TEXT NOT NULL,
      parent    TEXT,
      link_text TEXT,
      reason    TEXT,
      PRIMARY KEY (job_id, url)
    );
    CREATE INDEX IF NOT EXISTS crawl_frontier_pick
      ON crawl_frontier(job_id, state, depth, score DESC);

    CREATE TABLE IF NOT EXISTS crawl_pages (
      job_id        TEXT NOT NULL,
      url           TEXT NOT NULL,
      status        INTEGER,
      title         TEXT,
      description   TEXT,
      markdown      TEXT,
      chars         INTEGER,
      depth         INTEGER,
      content_hash  TEXT,
      rendered_with TEXT,
      fetched_at    INTEGER NOT NULL,
      PRIMARY KEY (job_id, url)
    );
    CREATE INDEX IF NOT EXISTS crawl_pages_hash ON crawl_pages(job_id, content_hash);
  `);

  // FTS5 is optional at the SQLite build level, so never let it break a crawl.
  try {
    handle.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS crawl_fts USING fts5(url, title, body, job_id UNINDEXED, tokenize='porter')",
    );
  } catch (err) {
    log.warn('FTS5 unavailable; corpus search disabled', String(err));
  }

  // Added after the first release: a human-readable outcome note, used by
  // adaptive crawling to say why it stopped early. ALTER rather than a schema
  // bump so existing databases keep working.
  try {
    const columns = (handle.prepare('PRAGMA table_info(crawl_jobs)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    if (!columns.includes('note')) handle.exec('ALTER TABLE crawl_jobs ADD COLUMN note TEXT');
  } catch (err) {
    log.debug('could not add crawl_jobs.note', String(err));
  }

  // archived_on: the capture date, when a page's body came from a web archive
  // because the live URL could not be read. Without it the corpus holds
  // years-old text with nothing saying so, and `corpus_search` hands it back as
  // though it were current.
  try {
    const columns = (handle.prepare('PRAGMA table_info(crawl_pages)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    if (!columns.includes('archived_on')) {
      handle.exec('ALTER TABLE crawl_pages ADD COLUMN archived_on TEXT');
    }
  } catch (err) {
    log.debug('could not add crawl_pages.archived_on', String(err));
  }

  migrated = true;
  return handle;
}

/**
 * Retries a write that lost a race for the database lock.
 *
 * `busy_timeout` handles most contention, but a long-running transaction in
 * another process can still surface SQLITE_BUSY. A crawl must not die because
 * a CLI script happened to be writing at the same moment.
 */
function withRetry<T>(label: string, fn: () => T, attempts = 4): T {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return fn();
    } catch (err) {
      lastError = err;
      if (!/database is locked|SQLITE_BUSY/i.test(String(err))) throw err;
      // Short synchronous backoff: node:sqlite is synchronous anyway.
      const until = Date.now() + 40 * (i + 1);
      while (Date.now() < until) {
        /* spin briefly */
      }
      log.debug('sqlite busy, retrying', { label, attempt: i + 1 });
    }
  }
  throw lastError;
}

export function ftsAvailable(): boolean {
  try {
    db().prepare('SELECT count(*) FROM crawl_fts').get();
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Jobs                                                                */
/* ------------------------------------------------------------------ */

export interface JobCounts {
  discovered: number;
  pending: number;
  active: number;
  completed: number;
  failed: number;
  skipped: number;
}

export interface JobRecord {
  id: string;
  kind: JobKind;
  rootUrl: string;
  status: JobStatus;
  options: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  error?: string;
  /** Why the job ended the way it did, when there is something to say. */
  note?: string;
  counts: JobCounts;
}

export function createJob(
  kind: JobKind,
  rootUrl: string,
  options: Record<string, unknown>,
): string {
  const id = `${kind}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO crawl_jobs (id, kind, root_url, status, options, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', ?, ?, ?)`,
    )
    .run(id, kind, rootUrl, JSON.stringify(options), now, now);
  return id;
}

export function setJobStatus(jobId: string, status: JobStatus, error?: string): void {
  const now = Date.now();
  const finished = status === 'running' || status === 'queued' ? null : now;
  db()
    .prepare('UPDATE crawl_jobs SET status = ?, updated_at = ?, finished_at = ?, error = ? WHERE id = ?')
    .run(status, now, finished, error ?? null, jobId);
}

export function touchJob(jobId: string): void {
  db().prepare('UPDATE crawl_jobs SET updated_at = ? WHERE id = ?').run(Date.now(), jobId);
}

export function jobCounts(jobId: string): JobCounts {
  const row = db()
    .prepare(
      `SELECT
         COUNT(*) AS discovered,
         SUM(state = 'pending') AS pending,
         SUM(state = 'active')  AS active,
         SUM(state = 'done')    AS completed,
         SUM(state = 'failed')  AS failed,
         SUM(state = 'skipped') AS skipped
       FROM crawl_frontier WHERE job_id = ?`,
    )
    .get(jobId) as Record<string, unknown>;

  const n = (key: string) => Number(row?.[key] ?? 0);
  return {
    discovered: n('discovered'),
    pending: n('pending'),
    active: n('active'),
    completed: n('completed'),
    failed: n('failed'),
    skipped: n('skipped'),
  };
}

export function getJob(jobId: string): JobRecord | null {
  const row = db().prepare('SELECT * FROM crawl_jobs WHERE id = ?').get(jobId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;

  let options: Record<string, unknown> = {};
  try {
    options = JSON.parse(String(row.options)) as Record<string, unknown>;
  } catch {
    /* corrupt options are not worth failing a status call over */
  }

  return {
    id: String(row.id),
    kind: String(row.kind) as JobKind,
    rootUrl: String(row.root_url),
    status: String(row.status) as JobStatus,
    options,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    finishedAt: row.finished_at ? Number(row.finished_at) : undefined,
    error: row.error ? String(row.error) : undefined,
    note: row.note ? String(row.note) : undefined,
    counts: jobCounts(jobId),
  };
}

export function listJobs(limit = 20): JobRecord[] {
  const rows = db()
    .prepare('SELECT id FROM crawl_jobs ORDER BY created_at DESC LIMIT ?')
    .all(limit) as Record<string, unknown>[];
  return rows.map((r) => getJob(String(r.id))).filter((j): j is JobRecord => j !== null);
}

/** Records why a job ended as it did. Not an error: a normal outcome note. */
export function setJobNote(jobId: string, note: string): void {
  withRetry('setJobNote', () =>
    db().prepare('UPDATE crawl_jobs SET note = ?, updated_at = ? WHERE id = ?').run(note, Date.now(), jobId),
  );
}

export function deleteJob(jobId: string): void {
  const handle = db();
  handle.prepare('DELETE FROM crawl_frontier WHERE job_id = ?').run(jobId);
  handle.prepare('DELETE FROM crawl_pages WHERE job_id = ?').run(jobId);
  try {
    handle.prepare('DELETE FROM crawl_fts WHERE job_id = ?').run(jobId);
  } catch {
    /* fts disabled */
  }
  // The SEO row and link-graph tables are keyed by job too, and leaving them
  // behind would let a deleted crawl keep answering audit queries.
  for (const table of ['crawl_seo', 'crawl_links']) {
    try {
      handle.prepare(`DELETE FROM ${table} WHERE job_id = ?`).run(jobId);
    } catch {
      /* table not created yet: this job was never crawled with seo on */
    }
  }
  handle.prepare('DELETE FROM crawl_jobs WHERE id = ?').run(jobId);
}

/* ------------------------------------------------------------------ */
/* Frontier                                                            */
/* ------------------------------------------------------------------ */

export interface FrontierItem {
  url: string;
  depth: number;
  score?: number;
  parent?: string;
  linkText?: string;
}

/** Adds URLs to the frontier, ignoring any already seen. Returns how many were new. */
export function enqueue(jobId: string, items: FrontierItem[]): number {
  if (items.length === 0) return 0;
  const handle = db();
  const stmt = handle.prepare(
    `INSERT INTO crawl_frontier (job_id, url, depth, score, state, parent, link_text)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)
     ON CONFLICT(job_id, url) DO NOTHING`,
  );

  return withRetry('enqueue', () => {
  let added = 0;
  handle.exec('BEGIN IMMEDIATE');
  try {
    for (const item of items) {
      let url: string;
      try {
        url = normalizeUrl(item.url);
      } catch {
        continue;
      }
      const result = stmt.run(
        jobId,
        url,
        item.depth,
        item.score ?? 0,
        item.parent ?? null,
        item.linkText ?? null,
      );
      if (Number(result.changes) > 0) added++;
    }
    handle.exec('COMMIT');
  } catch (err) {
    try {
      handle.exec('ROLLBACK');
    } catch {
      /* nothing to roll back */
    }
    throw err;
  }
  return added;
  });
}

export type CrawlStrategy = 'bfs' | 'dfs' | 'best-first';

/** Marks up to `n` pending URLs as active and returns them. */
export function claim(jobId: string, n: number, strategy: CrawlStrategy): FrontierItem[] {
  if (n <= 0) return [];
  const order =
    strategy === 'dfs'
      ? 'depth DESC, score DESC'
      : strategy === 'best-first'
        ? 'score DESC, depth ASC'
        : 'depth ASC, score DESC';

  const handle = db();
  const rows = handle
    .prepare(
      `SELECT url, depth, score, parent, link_text FROM crawl_frontier
       WHERE job_id = ? AND state = 'pending'
       ORDER BY ${order} LIMIT ?`,
    )
    .all(jobId, n) as Record<string, unknown>[];

  if (rows.length === 0) return [];

  const mark = handle.prepare(
    "UPDATE crawl_frontier SET state = 'active' WHERE job_id = ? AND url = ? AND state = 'pending'",
  );
  const claimed: FrontierItem[] = [];
  for (const row of rows) {
    const result = mark.run(jobId, String(row.url));
    if (Number(result.changes) > 0) {
      claimed.push({
        url: String(row.url),
        depth: Number(row.depth),
        score: Number(row.score),
        parent: row.parent ? String(row.parent) : undefined,
        linkText: row.link_text ? String(row.link_text) : undefined,
      });
    }
  }
  return claimed;
}

export function markState(
  jobId: string,
  url: string,
  state: FrontierState,
  reason?: string,
): void {
  db()
    .prepare('UPDATE crawl_frontier SET state = ?, reason = ? WHERE job_id = ? AND url = ?')
    .run(state, reason ?? null, jobId, url);
}

/** Returns active URLs to pending. Used when resuming a job after a restart. */
export function resetActive(jobId: string): number {
  const result = db()
    .prepare("UPDATE crawl_frontier SET state = 'pending' WHERE job_id = ? AND state = 'active'")
    .run(jobId);
  return Number(result.changes);
}

/* ------------------------------------------------------------------ */
/* Pages                                                              */
/* ------------------------------------------------------------------ */

export interface StoredPage {
  url: string;
  status?: number;
  title?: string;
  description?: string;
  markdown?: string;
  chars?: number;
  depth?: number;
  contentHash?: string;
  renderedWith?: string;
  /**
   * Capture date of the archive copy whose text is stored here, set only when
   * the live URL was unreadable and the archive rung answered. Its presence
   * means `markdown` is not what the URL serves today — and `status` is the
   * live failure that sent us to the archive in the first place.
   */
  archivedOn?: string;
  fetchedAt?: number;
}

export function savePage(jobId: string, page: StoredPage): void {
  withRetry('savePage', () => savePageOnce(jobId, page));
}

function savePageOnce(jobId: string, page: StoredPage): void {
  const handle = db();
  handle
    .prepare(
      `INSERT INTO crawl_pages
         (job_id, url, status, title, description, markdown, chars, depth, content_hash, rendered_with, archived_on, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_id, url) DO UPDATE SET
         status=excluded.status, title=excluded.title, description=excluded.description,
         markdown=excluded.markdown, chars=excluded.chars, depth=excluded.depth,
         content_hash=excluded.content_hash, rendered_with=excluded.rendered_with,
         archived_on=excluded.archived_on, fetched_at=excluded.fetched_at`,
    )
    .run(
      jobId,
      page.url,
      page.status ?? null,
      page.title ?? null,
      page.description ?? null,
      page.markdown ?? null,
      page.chars ?? page.markdown?.length ?? 0,
      page.depth ?? 0,
      page.contentHash ?? null,
      page.renderedWith ?? null,
      page.archivedOn ?? null,
      page.fetchedAt ?? Date.now(),
    );

  try {
    handle.prepare('DELETE FROM crawl_fts WHERE job_id = ? AND url = ?').run(jobId, page.url);
    handle
      .prepare('INSERT INTO crawl_fts (url, title, body, job_id) VALUES (?, ?, ?, ?)')
      .run(page.url, page.title ?? '', page.markdown ?? '', jobId);
  } catch {
    /* fts disabled */
  }
}

/** True when another page in this job already had identical content. */
export function hasContentHash(jobId: string, hash: string): string | null {
  const row = db()
    .prepare('SELECT url FROM crawl_pages WHERE job_id = ? AND content_hash = ? LIMIT 1')
    .get(jobId, hash) as Record<string, unknown> | undefined;
  return row ? String(row.url) : null;
}

export interface PageQuery {
  offset?: number;
  limit?: number;
  includeMarkdown?: boolean;
  /** Cap markdown per page. */
  maxChars?: number;
}

export function getPages(jobId: string, query: PageQuery = {}): StoredPage[] {
  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;
  const columns = query.includeMarkdown
    ? 'url, status, title, description, markdown, chars, depth, rendered_with, archived_on, fetched_at'
    : 'url, status, title, description, chars, depth, rendered_with, archived_on, fetched_at';

  const rows = db()
    .prepare(
      `SELECT ${columns} FROM crawl_pages WHERE job_id = ?
       ORDER BY fetched_at ASC LIMIT ? OFFSET ?`,
    )
    .all(jobId, limit, offset) as Record<string, unknown>[];

  return rows.map((row) => {
    let markdown = row.markdown ? String(row.markdown) : undefined;
    if (markdown && query.maxChars && markdown.length > query.maxChars) {
      markdown = markdown.slice(0, query.maxChars).trimEnd() + '\n\n_[truncated]_';
    }
    return {
      url: String(row.url),
      status: row.status ? Number(row.status) : undefined,
      title: row.title ? String(row.title) : undefined,
      description: row.description ? String(row.description) : undefined,
      markdown,
      chars: Number(row.chars ?? 0),
      depth: Number(row.depth ?? 0),
      renderedWith: row.rendered_with ? String(row.rendered_with) : undefined,
      archivedOn: row.archived_on ? String(row.archived_on) : undefined,
      fetchedAt: Number(row.fetched_at ?? 0),
    };
  });
}

/** The stored content hash for a page, so a re-crawl can tell changed from unchanged. */
export function getPageHash(jobId: string, url: string): string | null {
  const row = db()
    .prepare('SELECT content_hash FROM crawl_pages WHERE job_id = ? AND url = ?')
    .get(jobId, url) as Record<string, unknown> | undefined;
  return row?.content_hash ? String(row.content_hash) : null;
}

/**
 * Puts every finished URL back in the queue for a re-crawl.
 *
 * Paired with HTTP revalidation this is the cheap path: the pages that have
 * not changed answer 304 and cost almost nothing, so refreshing a large crawl
 * is a fraction of the original work.
 */
export function resetDoneForRecrawl(jobId: string): number {
  const result = db()
    .prepare(
      "UPDATE crawl_frontier SET state = 'pending', reason = NULL WHERE job_id = ? AND state IN ('done', 'failed')",
    )
    .run(jobId);
  return Number(result.changes);
}

/** How many pages a re-crawl found changed vs unchanged. */
export function recrawlCounts(jobId: string): { changed: number; unchanged: number } {
  const row = db()
    .prepare(
      `SELECT SUM(reason = 'changed') AS changed, SUM(reason = 'unchanged') AS unchanged
       FROM crawl_frontier WHERE job_id = ? AND state = 'done'`,
    )
    .get(jobId) as Record<string, unknown>;
  return { changed: Number(row?.changed ?? 0), unchanged: Number(row?.unchanged ?? 0) };
}

/** Streams every page of a job in batches, so an export never loads it all at once. */
export function* iteratePages(jobId: string, batchSize = 200): Generator<StoredPage[]> {
  let offset = 0;
  for (;;) {
    const batch = getPages(jobId, { limit: batchSize, offset, includeMarkdown: true });
    if (batch.length === 0) return;
    yield batch;
    offset += batch.length;
    if (batch.length < batchSize) return;
  }
}

export function pageCount(jobId: string): number {
  const row = db()
    .prepare('SELECT COUNT(*) AS n FROM crawl_pages WHERE job_id = ?')
    .get(jobId) as Record<string, unknown>;
  return Number(row?.n ?? 0);
}

/* ------------------------------------------------------------------ */
/* Corpus search                                                      */
/* ------------------------------------------------------------------ */

export interface CorpusHit {
  url: string;
  title?: string;
  jobId: string;
  snippet: string;
  rank: number;
  /**
   * Capture date, when this page's text came from a web archive rather than the
   * live URL. Callers must show it: the snippet is then an answer about the
   * past, and a hit that does not say so is worse than no hit at all.
   */
  archivedOn?: string;
}

/**
 * Full-text search over everything crawled so far. Nothing in Firecrawl's API
 * does this: once you have paid to crawl a site, asking a question of that
 * corpus here costs one local query instead of a new crawl.
 */
export function searchCorpus(
  query: string,
  opts: { jobId?: string; limit?: number } = {},
): CorpusHit[] {
  const limit = opts.limit ?? 20;
  try {
    const where = opts.jobId ? 'crawl_fts MATCH ? AND job_id = ?' : 'crawl_fts MATCH ?';
    // Over-fetch, because the same URL can be indexed by several jobs and we
    // collapse those down to one hit below.
    const params2 = opts.jobId ? [query, opts.jobId, limit * 4] : [query, limit * 4];
    const rows = db()
      .prepare(
        // Left deliberately un-joined. Pulling archived_on in with a LEFT JOIN
        // on crawl_pages looks tidier and silently returns zero rows: aliasing
        // the FTS table breaks MATCH and `rank`, and the query fails open
        // rather than erroring. The capture dates are fetched separately below.
        `SELECT url, title, job_id,
                snippet(crawl_fts, 2, '**', '**', ' … ', 24) AS snippet,
                rank
         FROM crawl_fts WHERE ${where}
         ORDER BY rank LIMIT ?`,
      )
      .all(...(params2 as never[])) as Record<string, unknown>[];

    const bestByUrl = new Map<string, CorpusHit>();
    for (const row of rows) {
      const hit: CorpusHit = {
        url: String(row.url),
        title: row.title ? String(row.title) : undefined,
        jobId: String(row.job_id),
        snippet: String(row.snippet ?? '').replace(/\s+/g, ' ').trim(),
        rank: Number(row.rank ?? 0),
      };
      // FTS5 rank is more negative for a better match.
      const existing = bestByUrl.get(hit.url);
      if (!existing || hit.rank < existing.rank) bestByUrl.set(hit.url, hit);
    }

    const hits = [...bestByUrl.values()].sort((a, b) => a.rank - b.rank).slice(0, limit);

    // Attach the capture date to any hit whose text came from a web archive, so
    // the caller cannot present years-old content as current. Done as its own
    // query against crawl_pages because joining it into the FTS query above
    // silently returns nothing.
    if (hits.length) {
      try {
        const marks = hits.map(() => '(?, ?)').join(', ');
        const args = hits.flatMap((h) => [h.jobId, h.url]);
        const dated = db()
          .prepare(
            `SELECT url, job_id, archived_on FROM crawl_pages
              WHERE archived_on IS NOT NULL AND (job_id, url) IN (VALUES ${marks})`,
          )
          .all(...(args as never[])) as Record<string, unknown>[];
        const byKey = new Map(dated.map((r) => [`${String(r.job_id)}\u0000${String(r.url)}`, String(r.archived_on)]));
        for (const hit of hits) {
          const on = byKey.get(`${hit.jobId}\u0000${hit.url}`);
          if (on) hit.archivedOn = on;
        }
      } catch (err) {
        // A missing label must not cost the caller their search results, but it
        // is the kind of silence this whole change exists to remove, so log it.
        log.warn('could not read archive provenance for corpus hits', String(err));
      }
    }

    return hits;
  } catch (err) {
    log.debug('corpus search failed', String(err));
    return [];
  }
}
