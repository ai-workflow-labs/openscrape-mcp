/** Measures the effect of connection reuse: many pages from one host. */
import { httpFetch, closeDispatchers } from '../src/core/fetcher/http.js';
import { map } from '../src/core/map.js';
import { runPool } from '../src/core/util/pool.js';

const site = process.argv[2] ?? 'https://en.wikipedia.org';
const n = Number(process.argv[3] ?? 20);

const discovered = await map(site, { limit: n, maxAge: 600_000 });
const urls = discovered.links.slice(0, n).map((l) => l.url);
console.log(`fetching ${urls.length} pages from ${new URL(site).host}`);

async function run(label: string, concurrency: number) {
  const t = Date.now();
  let bytes = 0;
  let ok = 0;
  await runPool(urls, concurrency, async (u) => {
    try {
      const page = await httpFetch(u, { timeout: 20_000, revalidate: false });
      bytes += page.body.byteLength;
      if (page.status < 400) ok++;
    } catch {
      /* counted as not-ok */
    }
  });
  const ms = Date.now() - t;
  console.log(
    `  ${label.padEnd(16)} ${String(ms).padStart(6)}ms  ${ok}/${urls.length} ok  ` +
      `${(bytes / 1_048_576).toFixed(1)}MB  ${(urls.length / (ms / 1000)).toFixed(1)} pages/s`,
  );
}

await run('sequential', 1);
await run('concurrent x8', 8);
await run('concurrent x16', 16);
await closeDispatchers();
