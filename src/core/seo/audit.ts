/**
 * The audit rules.
 *
 * Deliberately separate from both the crawl and the signal collection, so the
 * rules can change without re-crawling a site, and so the thresholds are in
 * one readable place rather than scattered through queries.
 *
 * On thresholds: most of these are conventions, not laws. Google has never
 * published a title length limit — 60 characters is where titles typically
 * start being truncated in desktop results, which is a display concern, not a
 * ranking one. Every threshold here is an option with a stated default, and
 * every issue says what it found rather than asserting a penalty. A tool that
 * tells you "this will hurt rankings" is guessing; this one tells you what is
 * on the page and lets you decide.
 */
import {
  allSeoRows,
  inlinkCounts,
  brokenLinks,
  redirectedPages,
  duplicateGroups,
  archiveServedPages,
  httpErrorPages,
  type SeoRow,
} from './store.js';

export type Severity = 'error' | 'warning' | 'notice';

export interface Issue {
  code: string;
  severity: Severity;
  /** One line: what was found. */
  title: string;
  /** Why it matters, and what the threshold was. */
  detail: string;
  count: number;
  /** Up to `sampleSize` affected URLs, with the offending value where useful. */
  samples: string[];
}

export interface AuditOptions {
  /** Titles longer than this are reported. Default 60. */
  maxTitle?: number;
  /** Titles shorter than this are reported. Default 30. */
  minTitle?: number;
  /** Descriptions longer than this are reported. Default 160. */
  maxDescription?: number;
  /** Descriptions shorter than this are reported. Default 70. */
  minDescription?: number;
  /** Pages with fewer words than this are reported as thin. Default 300. */
  minWords?: number;
  /** Redirect chains of at least this many hops are reported. Default 2. */
  maxRedirectHops?: number;
  /** Simhash distance treated as a near-duplicate. Default 4. */
  duplicateDistance?: number;
  /** URLs listed per issue. Default 10. */
  sampleSize?: number;
}

export interface AuditReport {
  jobId: string;
  pages: number;
  issues: Issue[];
  /** Counts by severity, for a one-line summary. */
  totals: { error: number; warning: number; notice: number };
  /** Headline numbers worth seeing even when nothing is wrong. */
  stats: {
    indexable: number;
    noindex: number;
    errorPages: number;
    orphans: number;
    avgWords: number;
    withSchema: number;
    thinnest?: { url: string; words: number };
  };
  thresholds: Required<Omit<AuditOptions, 'sampleSize'>>;
}

/** Groups rows by a key, dropping rows whose key is empty. */
function groupBy(rows: SeoRow[], key: (r: SeoRow) => string | null | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const k = key(r);
    if (!k) continue;
    const list = out.get(k);
    if (list) list.push(r.url);
    else out.set(k, [r.url]);
  }
  return out;
}

export function auditCrawl(jobId: string, options: AuditOptions = {}): AuditReport {
  const o = {
    maxTitle: options.maxTitle ?? 60,
    minTitle: options.minTitle ?? 30,
    maxDescription: options.maxDescription ?? 160,
    minDescription: options.minDescription ?? 70,
    minWords: options.minWords ?? 300,
    maxRedirectHops: options.maxRedirectHops ?? 2,
    duplicateDistance: options.duplicateDistance ?? 4,
  };
  const sampleSize = options.sampleSize ?? 10;

  const rows = allSeoRows(jobId);
  const issues: Issue[] = [];

  const add = (
    code: string,
    severity: Severity,
    title: string,
    detail: string,
    samples: string[],
    count = samples.length,
  ): void => {
    if (count === 0) return;
    issues.push({ code, severity, title, detail, count, samples: samples.slice(0, sampleSize) });
  };

  // Pages excluded from search by their own robots meta are not faulted for
  // their titles and descriptions — those tags do not matter on a noindex page.
  const indexable = rows.filter((r) => !r.noindex);

  /* ---------------------------------------------------------------- */
  /* Status                                                            */
  /* ---------------------------------------------------------------- */

  // From crawl_pages, not the SEO rows: a page with no extractable signals
  // (an archive-served one, for instance) has no SEO row, and reading status
  // from there let a dead URL pass as healthy.
  const httpErrors = httpErrorPages(jobId);
  add(
    'http-error',
    'error',
    'Pages that answered with an error',
    'Crawled URLs whose status was 400 or above. These are live URLs the site links to.',
    httpErrors.map(
      (r) =>
        `${r.url} — HTTP ${r.status}` +
        (r.archived_on ? ` (an archive copy from ${r.archived_on} was stored for it)` : ''),
    ),
  );

  /* ---------------------------------------------------------------- */
  /* Titles                                                            */
  /* ---------------------------------------------------------------- */

  add(
    'title-missing',
    'error',
    'Pages with no title',
    'No <title> element, or an empty one. This is the single strongest on-page signal and the clickable line in every search result.',
    indexable.filter((r) => !r.title).map((r) => r.url),
  );

  add(
    'title-long',
    'warning',
    `Titles longer than ${o.maxTitle} characters`,
    `Measured in characters, not pixels. Around ${o.maxTitle} is where desktop results typically truncate — a display concern, not a known ranking one.`,
    indexable
      .filter((r) => (r.title_length ?? 0) > o.maxTitle)
      .map((r) => `${r.url} — ${r.title_length} chars`),
  );

  add(
    'title-short',
    'notice',
    `Titles shorter than ${o.minTitle} characters`,
    'Short titles are often templated or incomplete. Sometimes correct for a brand or category page.',
    indexable
      .filter((r) => r.title && (r.title_length ?? 0) < o.minTitle)
      .map((r) => `${r.url} — "${r.title}"`),
  );

  const titleDupes = [...groupBy(indexable, (r) => r.title).entries()].filter(([, u]) => u.length > 1);
  add(
    'title-duplicate',
    'warning',
    'Duplicate titles',
    'Two or more indexable pages share a title, so search engines cannot tell them apart from the result alone.',
    titleDupes.map(([t, urls]) => `"${t}" — ${urls.length} pages: ${urls.slice(0, 3).join(', ')}`),
    titleDupes.length,
  );

  /* ---------------------------------------------------------------- */
  /* Descriptions                                                      */
  /* ---------------------------------------------------------------- */

  add(
    'description-missing',
    'warning',
    'Pages with no meta description',
    'Search engines then write the snippet themselves from page text. Not a ranking factor; it does affect click-through.',
    indexable.filter((r) => !r.description).map((r) => r.url),
  );

  add(
    'description-long',
    'notice',
    `Meta descriptions longer than ${o.maxDescription} characters`,
    `Beyond roughly ${o.maxDescription} characters the snippet is usually cut.`,
    indexable
      .filter((r) => (r.desc_length ?? 0) > o.maxDescription)
      .map((r) => `${r.url} — ${r.desc_length} chars`),
  );

  add(
    'description-short',
    'notice',
    `Meta descriptions shorter than ${o.minDescription} characters`,
    'Short descriptions waste available snippet space.',
    indexable
      .filter((r) => r.description && (r.desc_length ?? 0) < o.minDescription)
      .map((r) => `${r.url} — ${r.desc_length} chars`),
  );

  const descDupes = [...groupBy(indexable, (r) => r.description).entries()].filter(([, u]) => u.length > 1);
  add(
    'description-duplicate',
    'notice',
    'Duplicate meta descriptions',
    'Usually a template that does not vary per page.',
    descDupes.map(([d, urls]) => `"${d.slice(0, 60)}…" — ${urls.length} pages`),
    descDupes.length,
  );

  /* ---------------------------------------------------------------- */
  /* Headings                                                          */
  /* ---------------------------------------------------------------- */

  add(
    'h1-missing',
    'warning',
    'Pages with no H1',
    'The page has no top-level heading, so its main subject is not stated in the markup.',
    indexable.filter((r) => (r.h1_count ?? 0) === 0).map((r) => r.url),
  );

  add(
    'h1-multiple',
    'notice',
    'Pages with more than one H1',
    'Valid in HTML5 and not an error on its own; worth checking that each is really a top-level heading.',
    indexable
      .filter((r) => (r.h1_count ?? 0) > 1)
      .map((r) => `${r.url} — ${r.h1_count} H1s`),
  );

  /* ---------------------------------------------------------------- */
  /* Canonical and indexability                                        */
  /* ---------------------------------------------------------------- */

  add(
    'canonical-missing',
    'notice',
    'Pages with no rel=canonical',
    'Without one, parameter and variant URLs of the same page can be treated as separate pages.',
    indexable.filter((r) => !r.canonical).map((r) => r.url),
  );

  add(
    'canonical-elsewhere',
    'notice',
    'Pages whose canonical points to a different URL',
    'Often deliberate (a variant pointing at the main page). Listed so an accidental site-wide canonical is visible.',
    rows
      .filter((r) => r.canonical && !r.canonical_self)
      .map((r) => `${r.url} -> ${r.canonical}`),
  );

  add(
    'noindex',
    'notice',
    'Pages excluded from search by robots meta',
    'Often deliberate. Listed because an accidental noindex on a page that should rank is silent and costly.',
    rows.filter((r) => r.noindex).map((r) => `${r.url} — ${r.robots_meta}`),
  );

  /* ---------------------------------------------------------------- */
  /* Content                                                           */
  /* ---------------------------------------------------------------- */

  add(
    'thin-content',
    'notice',
    `Pages with fewer than ${o.minWords} words`,
    `Word count of extracted text, excluding navigation. There is no minimum word count for ranking; this flags pages that may be placeholders.`,
    indexable
      .filter((r) => (r.word_count ?? 0) < o.minWords)
      .map((r) => `${r.url} — ${r.word_count} words`),
  );

  const dupes = duplicateGroups(jobId, o.duplicateDistance, Math.max(120, Math.floor(o.minWords / 2)));
  add(
    'near-duplicate',
    'warning',
    'Groups of near-identical pages',
    `Text fingerprints within ${o.duplicateDistance} bits of each other. Exact duplicates are already skipped during the crawl, so these differ slightly — templated pages competing with one another.`,
    dupes.map((g) => `${g.urls.length} pages, distance ${g.distance}: ${g.urls.slice(0, 3).join(', ')}`),
    dupes.length,
  );

  /* ---------------------------------------------------------------- */
  /* Images                                                            */
  /* ---------------------------------------------------------------- */

  const noAlt = rows.filter((r) => (r.images_noalt ?? 0) > 0);
  add(
    'image-alt-missing',
    'warning',
    'Pages with images missing an alt attribute',
    'Counts images with no alt attribute at all. alt="" is correct for decorative images and is not counted here.',
    noAlt.map((r) => `${r.url} — ${r.images_noalt} of ${r.images_total} images`),
  );

  /* ---------------------------------------------------------------- */
  /* Technical                                                         */
  /* ---------------------------------------------------------------- */

  add(
    'viewport-missing',
    'warning',
    'Pages with no viewport meta',
    'Without it, mobile browsers render at desktop width and zoom out.',
    rows.filter((r) => !r.viewport).map((r) => r.url),
  );

  add(
    'lang-missing',
    'notice',
    'Pages with no lang attribute on <html>',
    'Used by screen readers and translation, and by hreflang validation.',
    rows.filter((r) => !r.lang).map((r) => r.url),
  );

  add(
    'schema-missing',
    'notice',
    'Pages with no structured data',
    'No JSON-LD @type found. Structured data is what makes rich results possible.',
    indexable.filter((r) => !r.schema_types).map((r) => r.url),
  );

  /* ---------------------------------------------------------------- */
  /* Links                                                             */
  /* ---------------------------------------------------------------- */

  const inlinks = inlinkCounts(jobId);
  // The crawl root is reached by being the root, not by a link, so a zero
  // inlink count at depth 0 is expected and is not an orphan.
  const orphans = inlinks.filter((r) => r.inlinks === 0 && (r.depth ?? 0) > 0);
  add(
    'orphan-page',
    'warning',
    'Pages with no internal links pointing to them',
    'Found by the crawl (via a sitemap or a redirect) but linked from nowhere on the site. Search engines reach these poorly and users cannot reach them at all.',
    orphans.map((r) => `${r.url} — depth ${r.depth}`),
  );

  const nofollowOnly = inlinks.filter((r) => r.inlinks > 0 && r.followed === 0);
  add(
    'inlinks-all-nofollow',
    'notice',
    'Pages whose only internal links are nofollow',
    'Reachable, but every link to them tells search engines not to follow it.',
    nofollowOnly.map((r) => `${r.url} — ${r.inlinks} links, 0 followed`),
  );

  const broken = brokenLinks(jobId);
  add(
    'broken-internal-link',
    'error',
    'Internal links pointing at error pages',
    'The target was crawled and answered 400 or above. Each entry says how many pages link to it.',
    broken.map(
      (b) =>
        `${b.to_url} — HTTP ${b.status}, linked from ${b.sources} page(s), e.g. ${b.example_from}` +
        // Say so, or the entry contradicts the stored page: dead URL, full text.
        (b.archived_on ? ` (dead live; text below is an archive copy from ${b.archived_on})` : ''),
    ),
  );

  // Pages whose body came from an archive because the live URL was unreadable.
  // Every other number in this report treats them as ordinary pages, so the
  // report has to say which ones they are.
  const archived = archiveServedPages(jobId);
  add(
    'served-from-archive',
    'warning',
    'Pages whose content came from a web archive, not the live site',
    'The live URL could not be read, so the crawl stored an archived copy. The text is real but dated: ' +
      'word counts, titles and duplicate matches for these pages describe the capture, not the site today. ' +
      'Re-crawl with archiveFallback disabled to audit only live content.',
    archived.map((a) => `${a.url} — live HTTP ${a.status ?? '?'}, captured ${a.archived_on}`),
  );

  const chains = redirectedPages(jobId).filter((r) => r.chain.length >= o.maxRedirectHops);
  add(
    'redirect-chain',
    'warning',
    `Pages reached through ${o.maxRedirectHops} or more redirects`,
    'Every hop costs a round trip and loses a little link equity. Point the internal links at the final URL instead.',
    chains.map(
      (r) =>
        `${r.url} — ${r.chain.length} hops: ${r.chain.map((h) => h.status).join('->')} from ${r.chain[0]?.from}`,
    ),
  );

  const deadEnds = rows.filter((r) => (r.links_internal ?? 0) === 0);
  add(
    'no-internal-outlinks',
    'notice',
    'Pages that link nowhere internally',
    'A dead end: a visitor who lands here has no onward path within the site.',
    deadEnds.map((r) => r.url),
  );

  /* ---------------------------------------------------------------- */
  /* Summary                                                           */
  /* ---------------------------------------------------------------- */

  const totals = { error: 0, warning: 0, notice: 0 };
  for (const i of issues) totals[i.severity]++;

  const words = rows.map((r) => r.word_count ?? 0);
  const thinnestRow = [...indexable].sort((a, b) => (a.word_count ?? 0) - (b.word_count ?? 0))[0];

  // Worst first, and within a severity the issue affecting the most pages.
  const order: Record<Severity, number> = { error: 0, warning: 1, notice: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity] || b.count - a.count);

  return {
    jobId,
    pages: rows.length,
    issues,
    totals,
    stats: {
      indexable: indexable.length,
      noindex: rows.length - indexable.length,
      errorPages: httpErrors.length,
      orphans: orphans.length,
      avgWords: words.length ? Math.round(words.reduce((a, b) => a + b, 0) / words.length) : 0,
      withSchema: rows.filter((r) => r.schema_types).length,
      thinnest: thinnestRow
        ? { url: thinnestRow.url, words: thinnestRow.word_count ?? 0 }
        : undefined,
    },
    thresholds: o,
  };
}
