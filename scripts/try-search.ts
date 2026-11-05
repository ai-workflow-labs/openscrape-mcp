/**
 * Manual smoke test for the search chain.
 *
 *   npx tsx scripts/try-search.ts "firecrawl alternative"
 *   npx tsx scripts/try-search.ts "openai news" news 5
 *   OPENSCRAPE_SEARXNG_URL=http://localhost:8080 npx tsx scripts/try-search.ts "rust async"
 *
 * With no environment variables at all this must still return real results
 * from DuckDuckGo — that is the project's zero-setup promise.
 */
import { search, providerStatuses } from '../src/core/search/index.js';
import type { SearchSource } from '../src/core/search/index.js';

const query = process.argv[2] ?? 'firecrawl alternative';
const source = (process.argv[3] as SearchSource | undefined) ?? 'web';
const limit = Number(process.argv[4] ?? 10);

console.log('providers:');
for (const { provider, status } of providerStatuses()) {
  console.log(`  ${status.ready ? '✓' : '·'} ${provider}: ${status.detail ?? status.reason}`);
}
console.log();

const res = await search(query, { sources: [source], limit });

console.log(`query:     ${res.query}`);
console.log(`answered:  ${JSON.stringify(res.answeredBy)}`);
console.log(`results:   ${res.results.length} (dropped ${res.dropped})`);
console.log(`elapsed:   ${res.elapsedMs}ms`);
console.log();

console.log('attempts:');
for (const a of res.attempts) {
  const bits = [a.provider, a.source, a.status];
  if (a.results !== undefined) bits.push(`${a.results} results`);
  if (a.elapsedMs !== undefined) bits.push(`${a.elapsedMs}ms`);
  console.log(`  ${bits.join(' · ')}${a.reason ? ` — ${a.reason}` : ''}`);
}
for (const w of res.warnings) console.log(`  ⚠ ${w}`);
console.log();

res.results.forEach((r, i) => {
  console.log(`${i + 1}. ${r.title}`);
  console.log(`   ${r.url}`);
  if (r.description) console.log(`   ${r.description.replace(/\s+/g, ' ').slice(0, 160)}`);
  const meta = [r.provider, r.engine, r.publishedDate].filter(Boolean).join(' · ');
  if (meta) console.log(`   [${meta}]`);
});

if (res.results.length === 0) {
  console.error(
    source === 'web'
      ? '\nNo web results. The zero-setup path (DuckDuckGo) is broken.'
      : `\nNo ${source} results — see the attempts above for which provider is missing.`,
  );
  process.exitCode = 1;
}
