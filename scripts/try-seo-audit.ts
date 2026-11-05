/**
 * End-to-end check of the SEO audit layer.
 *
 * Crawls a real site with SEO collection on, then runs every query over the
 * stored result: the audit, the link graph, broken links and near-duplicates.
 *
 *   npx tsx scripts/try-seo-audit.ts [url] [limit]
 *
 * books.toscrape.com is the default on purpose: it is a templated catalogue,
 * which is exactly the shape that produces real near-duplicate groups and
 * thin pages. A site with no problems proves nothing about a problem finder.
 */
import { startCrawl, isRunning } from '../src/core/crawl/engine.js';
import { getJob } from '../src/core/crawl/store.js';
import { auditCrawl } from '../src/core/seo/audit.js';
import {
  inlinkCounts,
  duplicateGroups,
  brokenLinks,
  redirectedPages,
  seoRowCount,
  anchorsFor,
} from '../src/core/seo/store.js';

const root = process.argv[2] ?? 'https://books.toscrape.com';
const limit = Number(process.argv[3] ?? 25);

console.log(`crawling ${root} (limit ${limit}, seo on)`);
const started = Date.now();

const jobId = startCrawl(root, {
  limit,
  maxDepth: 2,
  perHostConcurrency: 4,
  scrapeOptions: { formats: ['markdown', 'links'], maxAge: 10 * 60 * 1000 },
});
console.log(`job: ${jobId}`);

while (isRunning(jobId)) await new Promise((r) => setTimeout(r, 400));

const job = getJob(jobId);
console.log(`crawl ${job?.status} in ${Date.now() - started}ms · ${JSON.stringify(job?.counts)}`);
console.log(`seo rows stored: ${seoRowCount(jobId)}\n`);

const t0 = Date.now();
const report = auditCrawl(jobId);
const auditMs = Date.now() - t0;

console.log(`=== AUDIT (${auditMs}ms, no network) ===`);
console.log(
  `${report.pages} pages · ${report.totals.error} error · ${report.totals.warning} warning · ${report.totals.notice} notice`,
);
const s = report.stats;
console.log(
  `indexable ${s.indexable} · noindex ${s.noindex} · error pages ${s.errorPages} · orphans ${s.orphans} · avg ${s.avgWords} words · schema ${s.withSchema}`,
);
if (s.thinnest) console.log(`thinnest: ${s.thinnest.words} words at ${s.thinnest.url}`);

for (const i of report.issues) {
  const mark = i.severity === 'error' ? 'ERR ' : i.severity === 'warning' ? 'WARN' : 'note';
  console.log(`\n[${mark}] ${i.title} — ${i.count}  (${i.code})`);
  for (const sample of i.samples.slice(0, 3)) console.log(`       ${sample.slice(0, 150)}`);
}

console.log(`\n=== LINK GRAPH ===`);
const links = inlinkCounts(jobId);
console.log(`${links.length} pages ranked by inlinks`);
for (const r of links.slice(0, 5)) console.log(`  ${String(r.inlinks).padStart(4)} in · d${r.depth} · ${r.url}`);
const most = [...links].sort((a, b) => b.inlinks - a.inlinks)[0];
if (most) {
  console.log(`\nmost-linked page: ${most.url} (${most.inlinks} inlinks)`);
  for (const a of anchorsFor(jobId, most.url).slice(0, 5)) {
    console.log(`  ${a.uses}× ${JSON.stringify(a.anchor ?? '')}`);
  }
}

console.log(`\n=== BROKEN / REDIRECTS ===`);
console.log(`broken internal targets: ${brokenLinks(jobId).length}`);
const chains = redirectedPages(jobId);
console.log(`redirected pages: ${chains.length}`);
for (const c of chains.slice(0, 3)) console.log(`  ${c.chain.length} hops -> ${c.url}`);

console.log(`\n=== NEAR-DUPLICATES ===`);
for (const d of [0, 4, 8]) {
  const groups = duplicateGroups(jobId, d, 60);
  console.log(`distance <= ${d}: ${groups.length} group(s)`);
  for (const g of groups.slice(0, 2)) {
    console.log(`  ${g.urls.length} pages (~${g.words} words): ${g.urls.slice(0, 3).join(' | ')}`);
  }
}

console.log(`\njob id for the MCP tools: ${jobId}`);
process.exit(0);
