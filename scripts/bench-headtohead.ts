/**
 * Head-to-head benchmark: our side of a same-URL, same-minute comparison
 * against Firecrawl's hosted API.
 *
 * Three rows, because "how fast is it" has three honest answers:
 *
 *   cold        maxAge 0 + revalidate false — a full download, nothing reused
 *   conditional maxAge 0 + revalidate true  — asks "changed?", serves stored
 *               bytes on a 304. This is the row a re-scrape actually hits.
 *   cached      maxAge 10min — no network at all
 *
 * Firecrawl's comparable number is its `maxAge: 0` call, which is the cold row.
 * The cached and conditional rows have no Firecrawl equivalent that does not
 * cost another credit, so they are reported as ours alone.
 *
 *   npx tsx scripts/bench-headtohead.ts [url]
 */
import { writeFileSync } from 'node:fs';
import { scrape } from '../src/core/scrape.js';
import type { ScrapeOptions, ScrapeResult } from '../src/core/types.js';

const url = process.argv[2] ?? 'https://en.wikipedia.org/wiki/Web_scraping';
const RUNS = 3;

interface Row {
  label: string;
  times: number[];
  chars: number;
  title: string;
  status: number;
  renderedWith: string;
  revalidated: boolean;
}

async function measure(label: string, opts: ScrapeOptions, runs = RUNS): Promise<Row> {
  const times: number[] = [];
  let last: ScrapeResult | null = null;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    last = await scrape(url, { ...opts, formats: ['markdown'] });
    times.push(performance.now() - t0);
  }
  return {
    label,
    times,
    chars: last?.markdown?.length ?? 0,
    title: last?.metadata.title ?? '(none)',
    status: last?.metadata.statusCode ?? 0,
    renderedWith: last?.metadata.renderedWith ?? '?',
    revalidated: Boolean(last?.metadata.revalidated),
  };
}

function stats(times: number[]): string {
  const sorted = [...times].sort((a, b) => a - b);
  const best = sorted[0] ?? 0;
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const worst = sorted[sorted.length - 1] ?? 0;
  return `best ${best.toFixed(0)}ms · median ${median.toFixed(0)}ms · worst ${worst.toFixed(0)}ms`;
}

console.log(`URL: ${url}`);
console.log(`${RUNS} runs per row, same process, same network.\n`);

const rows: Row[] = [];
rows.push(await measure('cold (full download)', { maxAge: 0, revalidate: false }));
rows.push(await measure('conditional (304 path)', { maxAge: 0, revalidate: true }));
rows.push(await measure('cached (no network)', { maxAge: 10 * 60 * 1000 }));

for (const r of rows) {
  console.log(`${r.label.padEnd(24)} ${stats(r.times)}`);
  console.log(
    `${''.padEnd(24)} ${r.status} ${r.renderedWith}${r.revalidated ? ' revalidated-304' : ''} · ${r.chars} chars markdown`,
  );
}

// Keep the markdown so the two outputs can be compared on content, not just speed.
const final = await scrape(url, { formats: ['markdown'], maxAge: 10 * 60 * 1000 });
const out = 'bench-ours.md';
writeFileSync(out, final.markdown ?? '', 'utf8');
console.log(`\ntitle:    ${final.metadata.title}`);
console.log(`markdown: ${final.markdown?.length ?? 0} chars -> ${out}`);
console.log(`links:    ${final.links?.length ?? 'n/a'}`);
process.exit(0);
