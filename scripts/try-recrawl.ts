import { startCrawl, startRecrawl, isRunning } from '../src/core/crawl/engine.js';
import { getJob, recrawlCounts, pageCount } from '../src/core/crawl/store.js';

const root = process.argv[2] ?? 'https://en.wikipedia.org/wiki/Web_scraping';
const limit = Number(process.argv[3] ?? 6);

async function waitFor(jobId: string) {
  for (let i = 0; i < 300 && isRunning(jobId); i++) {
    await new Promise((r) => setTimeout(r, 300));
  }
}

console.log(`first crawl of ${root} (limit ${limit})`);
let t = Date.now();
const jobId = startCrawl(root, {
  limit,
  maxDepth: 1,
  perHostConcurrency: 3,
  scrapeOptions: { formats: ['markdown', 'links'], maxChars: 1500, maxAge: 0 },
});
await waitFor(jobId);
const firstMs = Date.now() - t;
let job = getJob(jobId)!;
console.log(`  ${job.status} in ${firstMs}ms · ${pageCount(jobId)} pages stored`);
console.log(`  counts ${JSON.stringify(job.counts)}`);

console.log(`\nre-crawl (same URLs, ETag revalidation)`);
t = Date.now();
const requeued = startRecrawl(jobId);
console.log(`  requeued ${requeued} url(s)`);
await waitFor(jobId);
const secondMs = Date.now() - t;
job = getJob(jobId)!;
const rc = recrawlCounts(jobId);
console.log(`  ${job.status} in ${secondMs}ms · ${pageCount(jobId)} pages stored`);
console.log(`  changed=${rc.changed} unchanged=${rc.unchanged}`);
console.log(`\nspeedup: ${(firstMs / Math.max(secondMs, 1)).toFixed(1)}x  (${firstMs}ms -> ${secondMs}ms)`);

const { closeBrowser } = await import('../src/core/fetcher/browser.js');
await closeBrowser();
