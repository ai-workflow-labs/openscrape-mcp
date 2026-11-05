import { rawDb } from '../src/core/cache/store.js';
import { listJobs, getJob, setJobStatus } from '../src/core/crawl/store.js';
import { reconcileInterruptedJobs, resumeJob, isRunning } from '../src/core/crawl/engine.js';

const rows = rawDb().prepare('SELECT id, status, error FROM crawl_jobs ORDER BY created_at DESC').all() as any[];
console.log('db rows:');
for (const r of rows) console.log(`  ${r.id}  ${r.status}  err=${String(r.error ?? '').slice(0, 90)}`);

// Simulate a server restart leaving a job mid-flight.
const victim = rows[rows.length - 1];
setJobStatus(String(victim.id), 'running');
console.log(`\nforced ${victim.id} back to "running" to simulate a crash`);

const n = reconcileInterruptedJobs();
console.log(`reconcileInterruptedJobs() marked ${n} job(s)`);
console.log(`  ${victim.id} is now: ${getJob(String(victim.id))?.status}`);

const ok = resumeJob(String(victim.id));
console.log(`resumeJob -> ${ok}, isRunning -> ${isRunning(String(victim.id))}`);

for (let i = 0; i < 40 && isRunning(String(victim.id)); i++) {
  await new Promise((r) => setTimeout(r, 400));
}
const after = getJob(String(victim.id))!;
console.log(`after resume: ${after.status}, pages done=${after.counts.completed}`);

const { closeBrowser } = await import('../src/core/fetcher/browser.js');
await closeBrowser();
