/**
 * The failure this reproduces: three searches fired at once, all rate-limited.
 *
 * The old pacing read a shared timestamp, slept until it, then pushed it
 * forward — which works for sequential calls and does nothing at all for
 * concurrent ones. Three callers arriving together all saw a wait of zero.
 *
 *   npx tsx scripts/try-search-concurrent.ts
 *
 * Known noise, so nobody else chases it: on Windows this script sometimes dies
 * at *exit* with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING),
 * src\win\async.c` and exit code 127, after the results have already printed.
 * Measured at roughly one run in three. It is a libuv teardown race under tsx,
 * not a fault in the code under test: the same three concurrent searches run
 * against the built output with plain node exited 0 with full results four
 * times out of four. The MCP server runs `node dist/index.js`, not tsx, so the
 * shipped path is not affected.
 */
import { search, providerStatuses } from '../src/core/search/index.js';

console.log('providers:');
for (const { provider, status } of providerStatuses()) {
  console.log(`  ${provider.padEnd(12)} ${status.ready ? 'ready' : 'not ready'}  ${status.detail ?? status.reason ?? ''}`);
}

const QUERIES = [
  'instagram ai automation agency',
  'n8n automation consultant',
  'make.com agency pricing',
];

console.log(`\nfiring ${QUERIES.length} searches SIMULTANEOUSLY (the case that failed)\n`);

const started = Date.now();
const results = await Promise.all(
  QUERIES.map(async (q) => {
    const t0 = Date.now();
    try {
      const r = await search(q, { limit: 5 });
      return { q, ok: r.results.length > 0, n: r.results.length, ms: Date.now() - t0, attempts: r.attempts, warnings: r.warnings };
    } catch (err) {
      return { q, ok: false, n: 0, ms: Date.now() - t0, error: err instanceof Error ? err.message : String(err) };
    }
  }),
);

let pass = 0;
for (const r of results) {
  const mark = r.ok ? 'PASS' : 'FAIL';
  if (r.ok) pass++;
  console.log(`  ${mark}  ${r.q.padEnd(34)} ${String(r.n).padStart(2)} results  ${r.ms}ms`);
  if ('attempts' in r && r.attempts) {
    const used = r.attempts.filter((a) => a.status === 'ok').map((a) => a.provider);
    const failed = r.attempts.filter((a) => a.status === 'failed').map((a) => a.provider);
    console.log(`        served by: ${used.join(', ') || 'none'}${failed.length ? ` · failed: ${failed.join(', ')}` : ''}`);
  }
  if ('error' in r && r.error) console.log(`        ${r.error.slice(0, 160)}`);
}

console.log(`\n${pass}/${QUERIES.length} succeeded in ${Date.now() - started}ms total`);

// Spacing is the actual fix: with the gap enforced across callers the three
// cannot land in the same instant, so the wall-clock total must exceed a
// single search by at least the configured gaps.
if (pass === QUERIES.length) {
  console.log('All three returned results while sent together — the concurrent path holds.');
} else {
  console.log('Still failing. Check whether the whole IP is in a DDG penalty window.');
}

process.exit(pass === QUERIES.length ? 0 : 1);
