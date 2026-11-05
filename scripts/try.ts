/**
 * Smoke test: run the scraper against real pages and print a compact report.
 *   npx tsx scripts/try.ts [url...]
 */
import { scrape } from '../src/core/scrape.js';
import type { ScrapeResult } from '../src/core/types.js';

const DEFAULTS = [
  'https://example.com',
  'https://en.wikipedia.org/wiki/Web_scraping',
  'https://news.ycombinator.com',
  'https://www.firecrawl.dev/pricing',
];

function report(r: ScrapeResult): void {
  const m = r.metadata;
  const line = [
    r.success ? 'OK ' : 'ERR',
    String(m.statusCode).padStart(3),
    m.renderedWith.padEnd(8),
    `${String(m.elapsedMs).padStart(6)}ms`,
    `md=${String(r.markdown?.length ?? 0).padStart(6)}`,
    `links=${String(r.links?.length ?? 0).padStart(4)}`,
    r.url.slice(0, 60),
  ].join('  ');
  console.log(line);
  if (m.title) console.log(`      title: ${m.title.slice(0, 90)}`);
  if (m.escalationReason) console.log(`      escalated: ${m.escalationReason}`);
  if (r.error) console.log(`      error: ${r.error}`);
  if (r.warning) console.log(`      warn: ${r.warning.slice(0, 160)}`);
  if (r.markdown) {
    const preview = r.markdown.replace(/\s+/g, ' ').slice(0, 160);
    console.log(`      md: ${preview}`);
  }
  if (r.summary) console.log(`      sum: ${r.summary.replace(/\s+/g, ' ').slice(0, 160)}`);
  console.log();
}

const urls = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULTS;

for (const url of urls) {
  try {
    const result = await scrape(url, {
      formats: ['markdown', 'links', 'summary', 'json'],
      maxChars: 4000,
      maxAge: 0,
    });
    report(result);
  } catch (err) {
    console.log(`ERR  ---  threw for ${url}: ${String(err)}\n`);
  }
}

// Second pass to prove the cache works.
console.log('--- cache check (maxAge 10 min) ---');
for (const url of urls.slice(0, 2)) {
  await scrape(url, { formats: ['markdown'], maxAge: 600_000, storeInCache: true });
  const again = await scrape(url, { formats: ['markdown'], maxAge: 600_000 });
  console.log(
    `${again.metadata.cached ? 'CACHED' : 'FRESH '}  ${String(again.metadata.elapsedMs).padStart(5)}ms  ${url}`,
  );
}

const { closeBrowser } = await import('../src/core/fetcher/browser.js');
await closeBrowser();
