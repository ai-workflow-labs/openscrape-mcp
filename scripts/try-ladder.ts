/**
 * Verifies the unified fetch ladder end to end:
 *
 *   cache -> 304 -> http -> browser -> your logged-in profile -> web archive
 *
 * The interesting case is the last rung: a URL the live web no longer serves.
 * We probe a few retired pages, because which ones still 404 changes over
 * time, and report exactly what each rung did. A page that turns out to be
 * alive again is reported as such rather than counted as a pass.
 *
 *   npx tsx scripts/try-ladder.ts
 */
import { scrape } from '../src/core/scrape.js';

const CANDIDATES = [
  'https://code.google.com/p/chromium/issues/list',
  'https://www.nytimes.com/learning/index.html',
  'https://blog.mozilla.org/en/this-page-was-never-here-openscrape/',
];

function report(label: string, r: Awaited<ReturnType<typeof scrape>>): void {
  const m = r.metadata;
  console.log(`\n--- ${label}`);
  console.log(`  success      ${r.success}`);
  console.log(`  status       ${m.statusCode}`);
  console.log(`  renderedWith ${m.renderedWith}`);
  console.log(`  elapsed      ${m.elapsedMs}ms`);
  if (m.archive) {
    console.log(`  ARCHIVE      ${m.archive.source}, captured ${m.archive.capturedOn} (${m.archive.ageText} old)`);
    console.log(`  snapshot     ${m.archive.snapshotUrl}`);
  }
  if (m.ladder?.length) console.log(`  ladder       ${m.ladder.join(' -> ')}`);
  if (m.blockReason) console.log(`  blocked      ${m.blockReason}`);
  console.log(`  markdown     ${r.markdown?.length ?? 0} chars`);
  if (r.markdown) console.log(`  first line   ${r.markdown.trim().split('\n')[0]?.slice(0, 90)}`);
  if (r.warning) console.log(`  warning      ${r.warning.slice(0, 220)}`);
}

console.log('1. A healthy page must NOT touch the extra rungs.');
const live = await scrape('https://example.com', { maxAge: 0 });
report('example.com', live);
if (live.metadata.renderedWith !== 'http') {
  console.log('  !! expected plain http');
}
if (live.metadata.archive) console.log('  !! archive rung should not have run');

console.log('\n2. Retired pages: does the archive rung catch them?');
let served: string | null = null;
for (const url of CANDIDATES) {
  const r = await scrape(url, { maxAge: 0, maxChars: 1200 });
  report(url, r);
  if (r.metadata.archive && (r.markdown?.length ?? 0) > 0) {
    served = url;
    break;
  }
}

if (!served) {
  console.log('\nNo candidate was both dead and archived today. The rung was exercised');
  console.log('(see each ladder line above) but did not serve content. Not a pass.');
} else {
  console.log(`\n3. Same URL with archiveFallback:false must fail honestly instead.`);
  const off = await scrape(served, { maxAge: 0, archiveFallback: false, maxChars: 400 });
  report(`${served} (archiveFallback:false)`, off);
  if (off.metadata.archive) console.log('  !! archive served despite archiveFallback:false');
  else console.log('  ok: no archive content, the live failure stands');
}

process.exit(0);
