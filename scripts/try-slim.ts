/**
 * What still works with no browser — the 512 MB / free-tier configuration.
 *
 * Run exactly as the slim image runs:
 *
 *   OPENSCRAPE_MODE=hosted OPENSCRAPE_LOCKDOWN_JSON='{"allowBrowser":false}' \
 *     npx tsx scripts/try-slim.ts
 *
 * The point is not that everything passes. It is that the things which cannot
 * work say so clearly instead of returning empty output, because a scraper
 * that silently returns half a page is worse than one that refuses.
 */
import { scrape } from '../src/core/scrape.js';
import { lockdownSummary } from '../src/core/policy/lockdown.js';

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}`);
  }
  if (detail) console.log(`        ${detail}`);
}

console.log(lockdownSummary());
console.log(`heap cap: ${process.env.NODE_OPTIONS ?? '(unset)'}\n`);

const rss = (): number => Math.round(process.memoryUsage().rss / 1024 / 1024);
console.log(`rss at start: ${rss()} MB`);

console.log('\n1. plain HTTP scraping — the fast path, and most pages');
{
  const r = await scrape('https://example.com', { maxAge: 0 });
  check('example.com', r.success && (r.markdown?.length ?? 0) > 100, `${r.markdown?.length} chars, ${r.metadata.elapsedMs}ms`);
}
{
  const r = await scrape('https://en.wikipedia.org/wiki/Web_scraping', { maxAge: 0, maxChars: 4000 });
  check('a 239 KB article', r.success && (r.markdown?.length ?? 0) > 1000, `${r.metadata.elapsedMs}ms, rss ${rss()} MB`);
}

console.log('\n2. a JS-heavy page must warn, not silently return a shell');
{
  const r = await scrape('https://react.dev', { maxAge: 0, maxChars: 500 });
  const warned = /browser|JavaScript-rendered|lockdown/i.test(r.warning ?? '');
  check('says the browser was unavailable', warned, (r.warning ?? '(no warning)').slice(0, 150));
  console.log(`        ladder: ${(r.metadata.ladder ?? ['(single rung)']).join(' -> ')}`);
}

console.log('\n3. a screenshot must be refused, not returned empty');
{
  const r = await scrape('https://example.com', { maxAge: 0, formats: ['screenshot'] });
  check('refused with a reason', !r.success, (r.error ?? '').slice(0, 130));
}

console.log('\n4. the parts that need no browser at all');
{
  const { map } = await import('../src/core/map.js');
  const m = await map('https://books.toscrape.com', { limit: 10 });
  check('map', m.links.length > 0, `${m.links.length} of ${m.total} urls, ${m.elapsedMs}ms`);
}
{
  const r = await scrape('https://books.toscrape.com', {
    maxAge: 0,
    formats: ['markdown'],
    collectSeo: true,
  });
  check('seo signals', (r.seo?.links.length ?? 0) > 0, `${r.seo?.links.length} links, ${r.seo?.wordCount} words`);
}
{
  const { fetchArchived } = await import('../src/core/discover/archive.js');
  const a = await fetchArchived('https://example.com', { maxChars: 200 });
  check('archive read', a.ok, a.content ? `captured ${a.content.staleness.capturedOn}` : a.message);
}

console.log(`\nrss at end: ${rss()} MB  (512 MB instance, Node capped at 384 MB)`);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
