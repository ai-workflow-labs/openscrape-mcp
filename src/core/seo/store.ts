/**
 * SEO storage and queries over a finished crawl.
 *
 * Two tables sit beside `crawl_pages`: one row per page of head signals, and
 * one row per *edge* of the link graph. The edges are the point — a crawl that
 * keeps only pages can tell you a page exists, but not that nothing links to
 * it, which is the question an audit is actually for.
 *
 * Every query here reads the stored crawl and makes no network requests, so an
 * audit can be re-run with changed rules without re-crawling the site.
 */
import { rawDb } from '../cache/store.js';
import { log } from '../util/log.js';
import { hammingDistance } from './signals.js';
import type { SeoSignals } from './signals.js';
import type { RedirectHop } from '../types.js';

let migrated = false;

function db() {
  const handle = rawDb();
  if (migrated) return handle;

  handle.exec(`
    CREATE TABLE IF NOT EXISTS crawl_seo (
      job_id          TEXT NOT NULL,
      url             TEXT NOT NULL,
      title           TEXT,
      title_length    INTEGER,
      description     TEXT,
      desc_length     INTEGER,
      h1_count        INTEGER,
      h1_first        TEXT,
      h2_count        INTEGER,
      canonical       TEXT,
      canonical_self  INTEGER,
      robots_meta     TEXT,
      noindex         INTEGER,
      lang            TEXT,
      viewport        INTEGER,
      hreflang_count  INTEGER,
      word_count      INTEGER,
      images_total    INTEGER,
      images_noalt    INTEGER,
      links_internal  INTEGER,
      links_external  INTEGER,
      links_nofollow  INTEGER,
      schema_types    TEXT,
      og_title        INTEGER,
      og_image        INTEGER,
      simhash         TEXT,
      status          INTEGER,
      depth           INTEGER,
      redirect_chain  TEXT,
      PRIMARY KEY (job_id, url)
    );
    CREATE INDEX IF NOT EXISTS crawl_seo_simhash ON crawl_seo(job_id, simhash);

    CREATE TABLE IF NOT EXISTS crawl_links (
      job_id   TEXT NOT NULL,
      from_url TEXT NOT NULL,
      to_url   TEXT NOT NULL,
      anchor   TEXT,
      rel      TEXT,
      internal INTEGER NOT NULL,
      nofollow INTEGER NOT NULL,
      PRIMARY KEY (job_id, from_url, to_url)
    );
    CREATE INDEX IF NOT EXISTS crawl_links_to ON crawl_links(job_id, to_url);
    CREATE INDEX IF NOT EXISTS crawl_links_from ON crawl_links(job_id, from_url);
  `);

  migrated = true;
  return handle;
}

function withRetry<T>(label: string, fn: () => T, attempts = 4): T {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return fn();
    } catch (err) {
      lastError = err;
      if (!/database is locked|SQLITE_BUSY/i.test(String(err))) throw err;
      const until = Date.now() + 40 * (i + 1);
      while (Date.now() < until) {
        /* spin briefly */
      }
      log.debug('sqlite busy, retrying', { label, attempt: i + 1 });
    }
  }
  throw lastError;
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

export interface SavedSeo {
  url: string;
  status?: number;
  depth?: number;
  signals: SeoSignals;
  redirectChain?: RedirectHop[];
}

function saveOnce(jobId: string, page: SavedSeo): void {
  const handle = db();
  const s = page.signals;

  handle
    .prepare(
      `INSERT INTO crawl_seo (
         job_id, url, title, title_length, description, desc_length,
         h1_count, h1_first, h2_count, canonical, canonical_self, robots_meta,
         noindex, lang, viewport, hreflang_count, word_count,
         images_total, images_noalt, links_internal, links_external, links_nofollow,
         schema_types, og_title, og_image, simhash, status, depth, redirect_chain
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(job_id, url) DO UPDATE SET
         title=excluded.title, title_length=excluded.title_length,
         description=excluded.description, desc_length=excluded.desc_length,
         h1_count=excluded.h1_count, h1_first=excluded.h1_first, h2_count=excluded.h2_count,
         canonical=excluded.canonical, canonical_self=excluded.canonical_self,
         robots_meta=excluded.robots_meta, noindex=excluded.noindex,
         lang=excluded.lang, viewport=excluded.viewport, hreflang_count=excluded.hreflang_count,
         word_count=excluded.word_count, images_total=excluded.images_total,
         images_noalt=excluded.images_noalt, links_internal=excluded.links_internal,
         links_external=excluded.links_external, links_nofollow=excluded.links_nofollow,
         schema_types=excluded.schema_types, og_title=excluded.og_title,
         og_image=excluded.og_image, simhash=excluded.simhash,
         status=excluded.status, depth=excluded.depth, redirect_chain=excluded.redirect_chain`,
    )
    .run(
      jobId,
      page.url,
      s.title ?? null,
      s.titleLength,
      s.description ?? null,
      s.descriptionLength,
      s.h1.length,
      s.h1[0] ?? null,
      s.h2Count,
      s.canonical ?? null,
      s.canonicalIsSelf ? 1 : 0,
      s.robotsMeta ?? null,
      s.noindex ? 1 : 0,
      s.lang ?? null,
      s.viewport ? 1 : 0,
      s.hreflang.length,
      s.wordCount,
      s.images.total,
      s.images.missingAlt,
      s.internalLinks,
      s.externalLinks,
      s.nofollowLinks,
      s.structuredTypes.join(',') || null,
      s.ogTitle ? 1 : 0,
      s.ogImage ? 1 : 0,
      s.simhash,
      page.status ?? null,
      page.depth ?? 0,
      page.redirectChain?.length ? JSON.stringify(page.redirectChain) : null,
    );

  // Edges are replaced wholesale for this page: a link removed from the page
  // must disappear from the graph, or a re-crawl would keep reporting it.
  handle.prepare('DELETE FROM crawl_links WHERE job_id = ? AND from_url = ?').run(jobId, page.url);

  const insert = handle.prepare(
    `INSERT INTO crawl_links (job_id, from_url, to_url, anchor, rel, internal, nofollow)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(job_id, from_url, to_url) DO UPDATE SET
       anchor=excluded.anchor, rel=excluded.rel,
       internal=excluded.internal, nofollow=excluded.nofollow`,
  );
  handle.exec('BEGIN IMMEDIATE');
  try {
    for (const l of s.links) {
      insert.run(jobId, page.url, l.url, l.anchor || null, l.rel ?? null, l.internal ? 1 : 0, l.nofollow ? 1 : 0);
    }
    handle.exec('COMMIT');
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }
}

export function saveSeo(jobId: string, page: SavedSeo): void {
  withRetry('saveSeo', () => saveOnce(jobId, page));
}

export function clearSeo(jobId: string): void {
  const handle = db();
  withRetry('clearSeo', () => {
    handle.prepare('DELETE FROM crawl_seo WHERE job_id = ?').run(jobId);
    handle.prepare('DELETE FROM crawl_links WHERE job_id = ?').run(jobId);
  });
}

/** True when this job has SEO rows, i.e. it was crawled with `seo` enabled. */
export function hasSeoData(jobId: string): boolean {
  const row = db()
    .prepare('SELECT COUNT(*) AS n FROM crawl_seo WHERE job_id = ?')
    .get(jobId) as { n: number } | undefined;
  return (row?.n ?? 0) > 0;
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

export interface SeoRow {
  url: string;
  title: string | null;
  title_length: number | null;
  description: string | null;
  desc_length: number | null;
  h1_count: number | null;
  h1_first: string | null;
  h2_count: number | null;
  canonical: string | null;
  canonical_self: number | null;
  robots_meta: string | null;
  noindex: number | null;
  lang: string | null;
  viewport: number | null;
  hreflang_count: number | null;
  word_count: number | null;
  images_total: number | null;
  images_noalt: number | null;
  links_internal: number | null;
  links_external: number | null;
  links_nofollow: number | null;
  schema_types: string | null;
  og_title: number | null;
  og_image: number | null;
  simhash: string | null;
  status: number | null;
  depth: number | null;
  redirect_chain: string | null;
}

export function allSeoRows(jobId: string): SeoRow[] {
  return db().prepare('SELECT * FROM crawl_seo WHERE job_id = ? ORDER BY depth, url').all(jobId) as unknown as SeoRow[];
}

export function seoRowCount(jobId: string): number {
  const row = db()
    .prepare('SELECT COUNT(*) AS n FROM crawl_seo WHERE job_id = ?')
    .get(jobId) as { n: number } | undefined;
  return row?.n ?? 0;
}

export interface InlinkRow {
  url: string;
  inlinks: number;
  followed: number;
  depth: number | null;
  title: string | null;
}

/**
 * Inlink counts for every crawled page.
 *
 * Only internal edges count: an external site linking in is not something this
 * crawl can see, and counting it would make an orphan look connected.
 */
export function inlinkCounts(jobId: string): InlinkRow[] {
  return db()
    .prepare(
      `SELECT p.url AS url,
              COUNT(l.from_url) AS inlinks,
              COALESCE(SUM(CASE WHEN l.nofollow = 0 THEN 1 ELSE 0 END), 0) AS followed,
              p.depth AS depth,
              p.title AS title
         FROM crawl_pages p
         LEFT JOIN crawl_links l
                ON l.job_id = p.job_id
               AND l.to_url = p.url
               AND l.internal = 1
               AND l.from_url <> p.url
        WHERE p.job_id = ?
        GROUP BY p.url
        ORDER BY inlinks ASC, p.depth ASC`,
    )
    .all(jobId) as unknown as InlinkRow[];
}

export interface AnchorRow {
  to_url: string;
  anchor: string | null;
  uses: number;
}

/**
 * Anchor text pointing at a page — what the site tells search engines it is about.
 *
 * Self-links are excluded, matching `inlinkCounts`. A page that links to itself
 * is not linking to itself in any sense that matters here, and counting it made
 * the anchor total disagree with the inlink count by exactly one.
 */
export function anchorsFor(jobId: string, url: string): AnchorRow[] {
  return db()
    .prepare(
      `SELECT to_url, anchor, COUNT(*) AS uses
         FROM crawl_links
        WHERE job_id = ? AND to_url = ? AND internal = 1 AND from_url <> to_url
        GROUP BY anchor
        ORDER BY uses DESC, anchor`,
    )
    .all(jobId, url) as unknown as AnchorRow[];
}

export interface OutlinkRow {
  to_url: string;
  anchor: string | null;
  rel: string | null;
  internal: number;
  nofollow: number;
}

export function outlinksFrom(jobId: string, url: string, limit = 200): OutlinkRow[] {
  return db()
    .prepare(
      `SELECT to_url, anchor, rel, internal, nofollow
         FROM crawl_links
        WHERE job_id = ? AND from_url = ?
        ORDER BY internal DESC, to_url
        LIMIT ?`,
    )
    .all(jobId, url, limit) as unknown as OutlinkRow[];
}

export interface BrokenRow {
  to_url: string;
  status: number | null;
  sources: number;
  example_from: string | null;
  example_anchor: string | null;
}

/**
 * Internal link targets that answered with an error.
 *
 * Only pages the crawl actually visited can be judged, so this reports targets
 * that were fetched and failed — not every unvisited URL, which would turn a
 * depth limit into a wall of false "broken" links.
 */
export function brokenLinks(jobId: string): BrokenRow[] {
  return db()
    .prepare(
      `SELECT l.to_url AS to_url,
              p.status AS status,
              COUNT(DISTINCT l.from_url) AS sources,
              MIN(l.from_url) AS example_from,
              MIN(l.anchor) AS example_anchor
         FROM crawl_links l
         JOIN crawl_pages p ON p.job_id = l.job_id AND p.url = l.to_url
        WHERE l.job_id = ? AND l.internal = 1 AND p.status >= 400
        GROUP BY l.to_url, p.status
        ORDER BY sources DESC, l.to_url`,
    )
    .all(jobId) as unknown as BrokenRow[];
}

export interface RedirectedRow {
  url: string;
  chain: RedirectHop[];
  inlinks: number;
}

/** Pages reached through one or more redirects, worst chain first. */
export function redirectedPages(jobId: string): RedirectedRow[] {
  const rows = db()
    .prepare(
      `SELECT s.url AS url,
              s.redirect_chain AS chain,
              (SELECT COUNT(*) FROM crawl_links l
                WHERE l.job_id = s.job_id AND l.to_url = s.url AND l.internal = 1) AS inlinks
         FROM crawl_seo s
        WHERE s.job_id = ? AND s.redirect_chain IS NOT NULL`,
    )
    .all(jobId) as unknown as { url: string; chain: string; inlinks: number }[];

  const out: RedirectedRow[] = [];
  for (const r of rows) {
    try {
      out.push({ url: r.url, chain: JSON.parse(r.chain) as RedirectHop[], inlinks: r.inlinks });
    } catch {
      /* unreadable chain json: skip rather than guess */
    }
  }
  return out.sort((a, b) => b.chain.length - a.chain.length);
}

export interface DuplicateGroup {
  /** Bits differing between the members. 0 = identical text. */
  distance: number;
  urls: string[];
  words: number;
}

/**
 * Near-duplicate page groups.
 *
 * Exact duplicates are already caught during the crawl by content hash; this
 * finds the harder case — pages whose text is 95% the same, such as a product
 * page templated across colours, or a city page with the city name swapped.
 * Those compete with each other in search and are invisible to a hash.
 *
 * O(n²) over pages, which is fine to a few thousand. Pages under `minWords`
 * are skipped: two short pages trivially look alike and the result is noise.
 */
export function duplicateGroups(jobId: string, maxDistance = 4, minWords = 120): DuplicateGroup[] {
  const rows = db()
    .prepare(
      `SELECT url, simhash, word_count FROM crawl_seo
        WHERE job_id = ? AND simhash IS NOT NULL AND word_count >= ?
        ORDER BY url`,
    )
    .all(jobId, minWords) as unknown as { url: string; simhash: string; word_count: number }[];

  const seen = new Set<number>();
  const groups: DuplicateGroup[] = [];

  for (let i = 0; i < rows.length; i++) {
    if (seen.has(i)) continue;
    const a = rows[i];
    if (!a) continue;
    const members: string[] = [];
    let worst = 0;

    for (let j = i + 1; j < rows.length; j++) {
      if (seen.has(j)) continue;
      const b = rows[j];
      if (!b) continue;
      const d = hammingDistance(a.simhash, b.simhash);
      if (d <= maxDistance) {
        members.push(b.url);
        seen.add(j);
        if (d > worst) worst = d;
      }
    }

    if (members.length) {
      seen.add(i);
      groups.push({ distance: worst, urls: [a.url, ...members], words: a.word_count });
    }
  }

  return groups.sort((x, y) => y.urls.length - x.urls.length);
}
