import { map } from '../src/core/map.js';

const site = process.argv[2] ?? 'https://www.firecrawl.dev';
const search = process.argv[3];

const result = await map(site, { limit: 15, search, maxAge: 600_000 });

console.log(`site:      ${result.url}`);
console.log(`found:     ${result.total} urls (showing ${result.links.length})`);
console.log(`sources:   sitemap=${result.sources.sitemapUrls} from ${result.sources.sitemapsFetched} sitemap(s), crawled=${result.sources.crawledPages} pages, links=${result.sources.linkUrls}`);
console.log(`robots:    ${result.robotsMissing ? 'missing' : 'present'}`);
console.log(`elapsed:   ${result.elapsedMs}ms`);
if (result.warning) console.log(`warning:   ${result.warning}`);
console.log();
for (const link of result.links) {
  const score = link.score !== undefined ? ` (${link.score.toFixed(1)})` : '';
  console.log(`  [${link.source}]${score} ${link.url}`);
}
