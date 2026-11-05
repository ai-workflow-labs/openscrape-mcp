import { searchCorpus, listJobs, ftsAvailable, getPages } from '../src/core/crawl/store.js';

console.log('fts available:', ftsAvailable());
const jobs = listJobs(5);
console.log('jobs:', jobs.map((j) => `${j.id} ${j.status} ${j.counts.completed}p`).join(' | ') || '(none)');

for (const term of ['pricing OR credits', '"pay as you go"', 'alexandr*']) {
  const hits = searchCorpus(term, { limit: 3 });
  console.log(`\nquery ${term} -> ${hits.length} hit(s)`);
  for (const hit of hits) {
    console.log(`  ${hit.url}`);
    console.log(`    ${hit.snippet.slice(0, 140)}`);
  }
}
