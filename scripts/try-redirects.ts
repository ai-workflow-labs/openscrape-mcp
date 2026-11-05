/**
 * Verifies that redirect chains are captured, not silently collapsed.
 *
 *   npx tsx scripts/try-redirects.ts
 */
import { scrape } from '../src/core/scrape.js';

const CASES = [
  'http://wikipedia.org',          // http -> https -> www, two hops
  'http://github.com',             // http -> https
  'https://example.com',           // no redirect at all
  'https://httpbin.org/redirect/3' // three deliberate hops
];

for (const url of CASES) {
  const r = await scrape(url, { maxAge: 0, formats: ['markdown'], maxChars: 200, timeout: 20_000 });
  const chain = r.metadata.redirectChain ?? [];
  console.log(`\n${url}`);
  console.log(`  status   ${r.metadata.statusCode}  final ${r.metadata.url}`);
  console.log(`  hops     ${chain.length}`);
  for (const h of chain) console.log(`    ${h.status}  ${h.from}  ->  ${h.to}`);
  if (!r.success) console.log(`  error    ${r.error}`);
}

process.exit(0);
