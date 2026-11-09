/**
 * Guards the bug that made an audit confidently wrong.
 *
 * What happened: a site linked to a URL that is now 404. The fetch ladder found
 * a readable 2023 Wayback capture and served it, and `archivedResult` reported
 * `statusCode` as the *capture's* status (200) rather than the live one (404).
 * Everything downstream judges health on that field, so `broken_links` and
 * `seo_audit` both reported a site with a dead internal link as having none —
 * and the stored text carried no capture date, so `corpus_search` handed back
 * three-year-old content as if it were current.
 *
 * Two separate failures, so two separate things are checked here: that a dead
 * URL stays dead in the reports, and that archive-sourced text is labelled
 * wherever it is read back.
 *
 * No network: these are reporting-layer bugs, so the rows go in directly. That
 * also means this still passes once the real URL stops being a 404.
 *
 *   npx tsx scripts/try-archive-provenance.ts
 */
import { createJob, savePage, getPages, searchCorpus, ftsAvailable, deleteJob } from '../src/core/crawl/store.js';
import { saveSeo, brokenLinks, archiveServedPages } from '../src/core/seo/store.js';
import { auditCrawl } from '../src/core/seo/audit.js';
import type { SeoSignals } from '../src/core/seo/signals.js';

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}${detail ? `  (${detail})` : ''}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}  ${detail}`);
  }
}

/** Minimal signals: only the fields these rules read actually matter. */
function signals(over: Partial<SeoSignals> = {}): SeoSignals {
  return {
    titleLength: 0,
    descriptionLength: 0,
    h1: [],
    h2Count: 0,
    noindex: false,
    nofollowPage: false,
    hreflang: [],
    wordCount: 400,
    images: { total: 0, missingAlt: 0, emptyAlt: 0 },
    links: [],
    internalLinks: 0,
    externalLinks: 0,
    nofollowLinks: 0,
    structuredTypes: [],
    simhash: '0000000000000000',
    ...over,
  };
}

const DEAD = 'https://example.com/dead-shortlink';
const LIVE = 'https://example.com/docs';
const CAPTURED = '7 Feb 2023';

const jobId = createJob('crawl', 'https://example.com/', {});

// The documentation page, which links to the shortlink with the full example URL
// as its anchor — exactly the shape found on the real site.
savePage(jobId, { url: LIVE, status: 200, title: 'Docs', markdown: 'See the example short link.', depth: 1 });
saveSeo(jobId, {
  url: LIVE,
  status: 200,
  depth: 1,
  signals: signals({
    title: 'Docs',
    links: [{ url: DEAD, anchor: `${DEAD}?firstname=joe`, internal: true }],
    internalLinks: 1,
  }),
});

// The dead target: live 404, body served from an archive capture.
savePage(jobId, {
  url: DEAD,
  status: 404,
  title: 'Chat Conversation',
  markdown: 'Please review and submit your payment. Card number CVV.',
  depth: 2,
  renderedWith: 'archive',
  archivedOn: CAPTURED,
});
saveSeo(jobId, { url: DEAD, status: 404, depth: 2, signals: signals({ title: 'Chat Conversation' }) });

console.log('1. a dead URL stays dead, even though its body was readable');
{
  const broken = brokenLinks(jobId);
  const row = broken.find((b) => b.to_url === DEAD);
  check('broken_links reports it', Boolean(row), `${broken.length} broken target(s)`);
  check('with the live status, not the capture status', row?.status === 404, `status=${row?.status}`);
  check('and names the page that links to it', row?.example_from === LIVE, String(row?.example_from));
  check(
    'and says the body came from an archive, so a dead page with text is not a contradiction',
    row?.archived_on === CAPTURED,
    `archived_on=${row?.archived_on}`,
  );
}

console.log('\n2. the audit surfaces both facts');
{
  const report = auditCrawl(jobId, { sampleSize: 10 });
  const codes = report.issues.map((i) => i.code);

  const brokenIssue = report.issues.find((i) => i.code === 'broken-internal-link');
  check('broken-internal-link is raised', Boolean(brokenIssue), codes.join(', ') || '(no issues)');
  check('as an error', brokenIssue?.severity === 'error', String(brokenIssue?.severity));

  const archiveIssue = report.issues.find((i) => i.code === 'served-from-archive');
  check('served-from-archive is raised', Boolean(archiveIssue));
  check(
    'and its sample names the page and capture date',
    Boolean(archiveIssue?.samples.some((s) => s.includes(DEAD) && s.includes(CAPTURED))),
    archiveIssue?.samples[0] ?? '(none)',
  );

  // The summary counted archive-served pages as healthy, which is what made the
  // whole report read as "nothing wrong here".
  check('the headline stats count it as an error page', report.stats.errorPages === 1, `errorPages=${report.stats.errorPages}`);
}

console.log('\n3. archive-sourced text is labelled wherever it is read back');
{
  const rows = archiveServedPages(jobId);
  check('archiveServedPages finds it', rows.length === 1 && rows[0]?.url === DEAD, `${rows.length} row(s)`);

  const page = getPages(jobId, { limit: 50 }).find((p) => p.url === DEAD);
  check('getPages carries archivedOn through', page?.archivedOn === CAPTURED, String(page?.archivedOn));

  const live = getPages(jobId, { limit: 50 }).find((p) => p.url === LIVE);
  check('and leaves live pages unmarked', live?.archivedOn === undefined, String(live?.archivedOn));

  if (ftsAvailable()) {
    const hits = searchCorpus('payment', { jobId, limit: 5 });
    const hit = hits.find((h) => h.url === DEAD);
    check('corpus_search returns the hit', Boolean(hit), `${hits.length} hit(s)`);
    check('with its capture date attached', hit?.archivedOn === CAPTURED, String(hit?.archivedOn));
  } else {
    console.log('  SKIP  corpus_search checks — this Node build has no FTS5');
  }
}

deleteJob(jobId);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
