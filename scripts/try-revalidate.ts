/**
 * Proves conditional requests work: fetch, then refetch with a zero maxAge and
 * confirm the server answers 304 and we serve the stored body.
 */
import { scrape } from '../src/core/scrape.js';
import { getValidators } from '../src/core/cache/store.js';

const urls = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      'https://en.wikipedia.org/wiki/Web_scraping',
      'https://raw.githubusercontent.com/unclecode/crawl4ai/main/README.md',
      'https://example.com',
    ];

for (const url of urls) {
  // Pass 1: populate the cache and capture validators.
  const first = await scrape(url, { formats: ['markdown'], maxAge: 0, storeInCache: true });
  const v = getValidators(url, 'http');

  // Pass 2: maxAge 0 means "do not trust the cache" — but with a validator we
  // can still ask the server instead of re-downloading.
  const second = await scrape(url, { formats: ['markdown'], maxAge: 0 });

  console.log(url);
  console.log(
    `  pass1: ${first.metadata.elapsedMs}ms  ${first.markdown?.length ?? 0}ch  ` +
      `etag=${v?.etag ? v.etag.slice(0, 22) : 'none'}  lastmod=${v?.lastModified ? 'yes' : 'no'}`,
  );
  console.log(
    `  pass2: ${second.metadata.elapsedMs}ms  ${second.markdown?.length ?? 0}ch  ` +
      `revalidated=${second.metadata.revalidated === true}  cached=${second.metadata.cached}`,
  );
  const same = first.markdown === second.markdown;
  console.log(`  content identical: ${same}`);
  console.log();
}
