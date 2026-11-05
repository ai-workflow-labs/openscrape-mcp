import { startCrawl, isRunning } from '../src/core/crawl/engine.js';
import { getJob, getPages, searchCorpus, ftsAvailable } from '../src/core/crawl/store.js';

const root = process.argv[2] ?? 'https://www.firecrawl.dev';
const query = process.argv[3];
const limit = Number(process.argv[4] ?? 8);

console.log(`crawling ${root} (limit ${limit}${query ? `, best-first on "${query}"` : ''})`);
const started = Date.now();

const jobId = startCrawl(root, {
  limit,
  maxDepth: 2,
  query,
  perHostConcurrency: 3,
  scrapeOptions: { formats: ['markdown', 'links'], maxChars: 2500, maxAge: 600_000 },
});
console.log(`job: ${jobId}\n`);

let lastLine = '';
while (isRunning(jobId)) {
  const job = getJob(jobId);
  if (job) {
    const c = job.counts;
    const line = `  ${job.status}  done=${c.completed} pending=${c.pending} active=${c.active} skipped=${c.skipped} failed=${c.failed} discovered=${c.discovered}`;
    if (line !== lastLine) { console.log(line); lastLine = line; }
  }
  await new Promise((r) => setTimeout(r, 400));
}

const job = getJob(jobId)!;
console.log(`\nfinal: ${job.status} in ${Date.now() - started}ms`);
console.log(`counts: ${JSON.stringify(job.counts)}\n`);

for (const page of getPages(jobId, { limit: 20 })) {
  console.log(`  d${page.depth} ${String(page.chars).padStart(6)}ch  ${(page.title ?? '').slice(0, 42).padEnd(42)} ${page.url}`);
}

if (ftsAvailable()) {
  const term = query ?? 'pricing';
  console.log(`\ncorpus search for "${term}":`);
  for (const hit of searchCorpus(term, { jobId, limit: 4 })) {
    console.log(`  ${hit.url}\n    ${hit.snippet.slice(0, 150)}`);
  }
}

const { closeBrowser } = await import('../src/core/fetcher/browser.js');
await closeBrowser();
