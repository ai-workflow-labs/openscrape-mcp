/**
 * Proves the pacing fix without touching the network.
 *
 * The bug it guards against: a pacer that reads a shared timestamp, sleeps,
 * then pushes it forward works for sequential callers and does nothing for
 * concurrent ones. That is invisible in a single-threaded test and shows up in
 * production as "all three searches were rate-limited".
 *
 *   npx tsx scripts/try-pacing.ts
 */
import { createPacer } from '../src/core/search/pacing.js';

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}${detail ? `  (${detail})` : ''}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}  ${detail}`);
  }
}

const GAP = 200;

console.log('1. three callers arriving together are spaced, not simultaneous');
{
  const pacer = createPacer(GAP);
  const t0 = Date.now();
  const stamps: number[] = [];

  // Fired in the same tick — the exact shape that defeated the old pacer.
  await Promise.all(
    [0, 1, 2].map(async () => {
      await pacer.wait();
      stamps.push(Date.now() - t0);
    }),
  );

  stamps.sort((a, b) => a - b);
  const gaps = stamps.slice(1).map((s, i) => s - (stamps[i] as number));
  check('all three got a slot', stamps.length === 3);
  check(
    'each gap is at least the configured minimum',
    gaps.every((g) => g >= GAP - 20),
    `gaps: ${gaps.map((g) => g + 'ms').join(', ')}`,
  );
  check(
    'they did not all fire at once',
    (stamps[2] as number) >= GAP * 2 - 40,
    `last one at ${stamps[2]}ms, expected >= ${GAP * 2}ms`,
  );
}

console.log('\n2. order is preserved — first caller in, first slot out');
{
  const pacer = createPacer(50);
  const order: number[] = [];
  await Promise.all(
    [0, 1, 2, 3, 4].map(async (i) => {
      await pacer.wait();
      order.push(i);
    }),
  );
  check('FIFO', order.join(',') === '0,1,2,3,4', order.join(','));
}

console.log('\n3. a penalty holds back everyone still queued');
{
  const pacer = createPacer(10);
  await pacer.wait();
  pacer.penalise(300);
  const t0 = Date.now();
  await pacer.wait();
  const waited = Date.now() - t0;
  check('next caller waited out the penalty', waited >= 280, `${waited}ms`);
}

console.log('\n4. one rejected caller does not break the queue');
{
  const pacer = createPacer(20);
  const results: string[] = [];
  await Promise.all([
    pacer.wait().then(() => {
      results.push('a');
      throw new Error('caller a blew up');
    }).catch(() => results.push('a-handled')),
    pacer.wait().then(() => results.push('b')),
    pacer.wait().then(() => results.push('c')),
  ]);
  check('later callers still ran', results.includes('b') && results.includes('c'), results.join(','));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
