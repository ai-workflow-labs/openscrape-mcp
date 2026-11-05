/**
 * Does adaptive crawling actually save work, and is it honest when it fails?
 *
 * Three runs on the same site and the same budget:
 *
 *   1. a fixed crawl, to establish what the budget costs
 *   2. an adaptive crawl for something the site really answers
 *   3. an adaptive crawl for something it cannot possibly answer
 *
 * Run 3 matters most. A stopper that only ever reports success is useless —
 * what you need to know is that it says "I could not answer this" instead of
 * quietly stopping and letting you think it did.
 *
 *   npx tsx scripts/try-adaptive.ts
 */
import { startCrawl, isRunning } from '../src/core/crawl/engine.js';
import { getJob, pageCount } from '../src/core/crawl/store.js';

const ROOT = 'https://books.toscrape.com';
const LIMIT = 30;

async function run(label: string, opts: Record<string, unknown>): Promise<void> {
  const started = Date.now();
  const jobId = startCrawl(ROOT, {
    limit: LIMIT,
    maxDepth: 2,
    perHostConcurrency: 4,
    scrapeOptions: { formats: ['markdown', 'links'], maxAge: 10 * 60 * 1000 },
    ...opts,
  });

  while (isRunning(jobId)) await new Promise((r) => setTimeout(r, 300));

  const job = getJob(jobId);
  const ms = Date.now() - started;
  console.log(`\n--- ${label}`);
  console.log(`  budget ${LIMIT} pages · fetched ${pageCount(jobId)} · ${ms}ms`);
  if (job?.note) {
    for (const line of wrap(job.note, 92)) console.log(`  ${line}`);
  } else {
    console.log('  (no note: ran to the page limit)');
  }
}

function wrap(text: string, width: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width) {
      lines.push(line.trim());
      line = w;
    } else line += ' ' + w;
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

await run('fixed crawl, no query', {});

await run('adaptive: "science fiction books" (the site is a bookshop)', {
  query: 'science fiction books',
  adaptive: true,
  strategy: 'best-first',
});

await run('adaptive: nonsense the site cannot answer', {
  query: 'zqxjkwv flooberghast quarterly dividend yield',
  adaptive: true,
  adaptivePatience: 4,
  strategy: 'best-first',
});

process.exit(0);
