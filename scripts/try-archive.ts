/**
 * Proves the archive module against the real Wayback Machine and Common Crawl.
 *
 * Both services are free and rate-limited, so this runs strictly sequentially
 * and leans on the module's own per-host gap. Expect it to take a minute or two.
 */
import {
  commonCrawlCollections,
  commonCrawlDiscover,
  commonCrawlLookup,
  compareSnapshots,
  fetchArchived,
  listSnapshots,
  tryArchiveFallback,
  waybackAvailable,
} from '../src/core/discover/archive.js';
import { scrape } from '../src/core/scrape.js';

function rule(title: string): void {
  console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`);
}

function short(ts: string): string {
  return `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)} ${ts.slice(8, 10)}:${ts.slice(10, 12)}`;
}

/* 1 --------------------------------------------- snapshots for a known page */

rule('1. archive_snapshots — Wayback CDX listing for a well-archived page');
{
  const t0 = Date.now();
  const list = await listSnapshots('https://www.iana.org/domains/reserved', { limit: 8 });
  console.log(`ok=${list.ok} returned=${list.returned} shown=${list.snapshots.length} in ${Date.now() - t0}ms`);
  if (list.error) console.log(`error: ${list.error}`);
  if (list.note) console.log(`note: ${list.note}`);
  if (list.oldest && list.newest) {
    console.log(`span: ${short(list.oldest.timestamp)} -> ${short(list.newest.timestamp)}`);
  }
  for (const s of list.snapshots) {
    console.log(`  ${s.timestamp}  ${String(s.statusCode ?? (s.revisit ? 'revisit' : '-')).padEnd(7)} ${String(s.length ?? '-').padStart(7)}B  ${s.mimeType ?? '-'}`);
  }
}

/* 2 -------------------------------------------------- availability endpoint */

rule('2. /wayback/available — the simple availability endpoint');
{
  const avail = await waybackAvailable('https://www.iana.org/domains/reserved', '20180101');
  console.log(`ok=${avail.ok} available=${avail.available} in ${avail.elapsedMs}ms`);
  if (avail.error) console.log(`error: ${avail.error}  (this endpoint rate-limits hard; closestSnapshot falls back to CDX)`);
  if (avail.snapshot) console.log(`closest to 2018-01-01: ${avail.snapshot.timestamp} -> ${avail.snapshot.contentUrl}`);
}

/* 3 -------------------------------------- the blocked page, live vs archive */

rule('3. The headline case: a page that refused the live fetcher');
{
  const target = 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf';

  console.log(`live fetch of ${target}`);
  const live = await scrape(target, { formats: ['markdown'], maxAge: 0 });
  console.log(
    `  live: success=${live.success} status=${live.metadata.statusCode} ` +
      `rendered=${live.metadata.renderedWith} block=${live.metadata.blockReason ?? 'none'} ` +
      `chars=${live.markdown?.length ?? 0} in ${live.metadata.elapsedMs}ms`,
  );
  if (live.error) console.log(`  live error: ${live.error}`);
  if (live.warning) console.log(`  live warning: ${live.warning}`);

  console.log(`\narchive fallback for the same URL`);
  const archived = await tryArchiveFallback(target);
  if (!archived) {
    console.log('  tryArchiveFallback returned null — no usable archived copy.');
  } else {
    console.log(`  archive: ${archived.archive} capture ${archived.snapshot.timestamp}`);
    console.log(`  ${archived.staleness.notice}`);
    console.log(`  kind=${archived.kind} bytes=${archived.bytes} pages=${archived.pages ?? '-'} chars=${archived.markdown.length}`);
    console.log(`  content: ${JSON.stringify(archived.markdown.slice(0, 180))}`);
  }
}

/* 4 ----------------------------------------- archived HTML -> markdown */

rule('4. archive_fetch — an archived HTML page as markdown, with its age');
{
  const result = await fetchArchived('https://example.com', { timestamp: '2002-01-20', maxChars: 600 });
  if (!result.ok || !result.content) {
    console.log(`failed: ${result.reason} — ${result.message}`);
  } else {
    const c = result.content;
    console.log(`capture ${c.snapshot.timestamp} (${c.staleness.capturedOn}, ${c.staleness.ageText} old)`);
    console.log(`notice:  ${c.staleness.notice}`);
    console.log(`title:   ${c.title ?? '(none)'}`);
    console.log(`source:  ${c.snapshot.contentUrl}`);
    console.log(`kind=${c.kind} bytes=${c.bytes} links=${c.links.length} in ${c.elapsedMs}ms`);
    console.log(`\n--- markdown ---\n${c.markdown}\n--- end ---`);
  }
}

/* 5 -------------------------------------------------- no snapshots at all */

rule('5. Degrading honestly — a URL nothing ever archived');
{
  const result = await fetchArchived('https://openscrape-nonexistent-9f3a21c7.example/page');
  console.log(`ok=${result.ok} reason=${result.reason}`);
  console.log(`message: ${result.message}`);
}

/* 6 ---------------------------------------------- Common Crawl discovery */

rule('6. archive_discover — Common Crawl URL discovery');
{
  const collections = await commonCrawlCollections();
  console.log(`collinfo.json: ok=${collections.ok} collections=${collections.collections.length}`);
  if (collections.error) console.log(`error: ${collections.error}`);
  console.log(`newest 4: ${collections.collections.slice(0, 4).map((c) => c.id).join(', ')}`);

  // The newest indexes often answer a wildcard query with a gateway timeout,
  // so try the newest first and fall back to an older one.
  const candidates = [undefined, ['CC-MAIN-2024-33']] as (string[] | undefined)[];
  for (const ids of candidates) {
    const label = ids ? ids.join(',') : 'newest';
    console.log(`\nquerying ${label} for iana.org/*`);
    const result = await commonCrawlDiscover('iana.org', {
      limit: 25,
      collectionIds: ids,
      maxPages: 1,
      timeout: 25_000,
    });
    console.log(
      `  ok=${result.ok} urls=${result.urls.length} records=${result.records} capped=${result.capped} in ${result.elapsedMs}ms`,
    );
    console.log(`  collections: ${result.collections.map((c) => `${c.id}:${c.ok ? c.records : 'FAILED'}${c.note ? `(${c.note})` : ''}`).join(' ')}`);
    if (result.note) console.log(`  note: ${result.note}`);
    if (result.error) console.log(`  error: ${result.error}`);
    if (result.urls.length) {
      for (const url of result.urls.slice(0, 15)) console.log(`    ${url}`);
      break;
    }
  }
}

/* 7 ------------------------------------------------- Common Crawl lookup */

rule('7. Common Crawl capture check for one page');
{
  const result = await commonCrawlLookup('https://www.iana.org/domains/reserved', {
    collectionIds: ['CC-MAIN-2024-33'],
    limit: 5,
    timeout: 25_000,
  });
  console.log(`ok=${result.ok} captured=${result.captured} records=${result.records.length} in ${result.elapsedMs}ms`);
  console.log(
    `collections: ${result.collections.map((c) => `${c.id}:${c.ok ? c.records : 'FAILED'}${c.note ? `(${c.note})` : ''}`).join(' ')}`,
  );
  if (result.note) console.log(`note: ${result.note}`);
  if (result.error) console.log(`error: ${result.error}`);
  for (const r of result.records) console.log(`  ${r.timestamp} ${r.status ?? '-'} ${r.mime ?? '-'} ${r.url}`);
}

/* 8 ------------------------------------------------- historical comparison */

rule('8. archive_compare — the same page across two years');
{
  const result = await compareSnapshots('https://www.iana.org/domains/reserved', '2015-06-01', '2024-06-01', {
    maxDiffChars: 1200,
  });
  if (!result.ok) {
    console.log(`failed: ${result.message}`);
  } else {
    const before = result.before!;
    const after = result.after!;
    console.log(`before: ${before.snapshot.timestamp} (${before.staleness.capturedOn}) ${before.markdown.length} chars`);
    console.log(`after:  ${after.snapshot.timestamp} (${after.staleness.capturedOn}) ${after.markdown.length} chars`);
    console.log(`gap:    ${result.gapDays} days · ${result.elapsedMs}ms`);
    if (result.message) console.log(`note:   ${result.message}`);
    const diff = result.diff!;
    console.log(`\nchanged=${diff.changed} ${diff.summary}`);
    console.log(`characterization: ${diff.characterization}`);
    if (diff.diff) console.log(`\n${diff.diff}`);
    if (diff.truncated) console.log(`\n[diff truncated: ${diff.truncatedChars} chars dropped]`);
  }
}

console.log('\ndone.');
