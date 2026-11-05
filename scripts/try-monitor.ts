/**
 * End-to-end exercise of page monitoring.
 *
 *   npx tsx scripts/try-monitor.ts [url]
 *
 * 1. creates a monitor on a real URL
 * 2. runs a check (baseline)
 * 3. runs a second check (must report "no change")
 * 4. seeds a deliberately modified previous snapshot and checks again, so the
 *    diff path is proved without waiting for the site to change
 * 5. exercises changeTracking() standalone, including price characterisation
 * 6. shows the persisted schedule, then cleans up
 */
import {
  changeTracking,
  resumeMonitors,
  runCheck,
  runDueMonitors,
  setMonitorBaseline,
  startMonitor,
  stopMonitorScheduler,
  type CheckOutcome,
} from '../src/core/monitor/engine.js';
import {
  deleteMonitor,
  deleteSnapshot,
  getMonitor,
  latestBaseline,
  listChecks,
  monitorStats,
  updateMonitor,
} from '../src/core/monitor/store.js';
import { diffContent } from '../src/core/monitor/diff.js';

const url = process.argv[2] ?? 'https://example.com';

function show(label: string, outcome: CheckOutcome | null): void {
  if (!outcome) {
    console.log(`  ${label}: no outcome (monitor missing or check already running)`);
    return;
  }
  const c = outcome.check;
  const verdict = c.error ? 'FAILED' : c.baseline ? 'BASELINE' : c.changed ? 'CHANGED' : 'NO CHANGE';
  console.log(
    `  ${label}: ${verdict}  http=${c.status ?? '-'} chars=${c.chars ?? 0} ` +
      `+${c.addedLines}/-${c.removedLines} hash=${(c.contentHash ?? '').slice(0, 10)}`,
  );
  if (c.error) console.log(`    error: ${c.error}`);
  if (c.characterization) console.log(`    what: ${c.characterization}`);
  if (c.diff) {
    console.log('    diff:');
    for (const line of c.diff.split('\n').slice(0, 14)) console.log(`      ${line}`);
    if (c.diffTruncatedChars) console.log(`      [${c.diffTruncatedChars} more chars truncated]`);
  }
}

console.log(`monitoring ${url}\n`);

/* 1. create ------------------------------------------------------------ */
const monitor = startMonitor({
  url,
  label: 'try-monitor',
  intervalMs: 60_000,
  historyLimit: 5,
  options: { maxDiffChars: 800, scrapeOptions: { formats: ['markdown'], onlyMainContent: true } },
});
console.log(
  `created ${monitor.id}  interval=${monitor.intervalMs}ms history=${monitor.historyLimit} ` +
    `nextCheckAt=${new Date(monitor.nextCheckAt!).toISOString()}`,
);

/* 2 + 3. two real checks ---------------------------------------------- */
console.log('\nreal checks:');
show('check 1', await runCheck(monitor.id));
show('check 2', await runCheck(monitor.id));

/* 4. prove the diff path with a seeded previous snapshot --------------- */
console.log('\nseeded-change check:');
const baseline = latestBaseline(monitor.id);
if (!baseline) {
  console.log('  no baseline stored — the fetch must have failed, skipping');
} else {
  // Edit the first line in place and append two lines, so the next check must
  // report one edited line plus two removals against the real page.
  const lines = baseline.content.split('\n');
  const first = lines.findIndex((l) => l.trim().length > 0);
  if (first >= 0) lines[first] = `${lines[first]} (stale copy)`;
  const seeded = [...lines, '', 'Price: $99.00', 'Status: Out of stock'].join('\n');
  setMonitorBaseline(monitor.id, seeded);
  console.log(`  seeded previous snapshot (${seeded.length} chars, was ${baseline.content.length})`);
  show('check 3', await runCheck(monitor.id));
  show('check 4', await runCheck(monitor.id));
}

/* 5. standalone changeTracking ---------------------------------------- */
console.log('\nchangeTracking() standalone:');
const trackUrl = 'https://example.invalid/pricing';
deleteSnapshot(trackUrl);

const v1 = 'Acme Pro\nPrice: $99\nSeats: 5\nUptime: 99.9%\nIn stock';
const v2 = 'Acme Pro\nPrice: $89\nSeats: 5\nUptime: 99.95%\nIn stock\nNew: annual billing';

const first = changeTracking(trackUrl, v1);
console.log(`  first:  changed=${first.changed} first=${first.first} hash=${first.hash.slice(0, 10)}`);

const second = changeTracking(trackUrl, v2);
console.log(
  `  second: changed=${second.changed} previousHash=${(second.previousHash ?? '').slice(0, 10)} ` +
    `previousAt=${second.previousAt ? new Date(second.previousAt).toISOString() : '-'}`,
);
console.log(`    summary: ${second.diff?.summary}`);
console.log(`    what:    ${second.diff?.characterization}`);
for (const line of (second.diff?.diff ?? '').split('\n')) console.log(`      ${line}`);

const third = changeTracking(trackUrl, v2);
console.log(`  third (same content): changed=${third.changed}`);

/* diff cap behaviour */
const long = Array.from({ length: 200 }, (_, i) => `row ${i}: value ${i}`).join('\n');
const longer = Array.from({ length: 200 }, (_, i) => `row ${i}: value ${i + 1}`).join('\n');
const capped = diffContent(long, longer, { maxDiffChars: 300 });
console.log(
  `\ndiff cap: ${capped.summary} rendered=${capped.diff.length}ch truncated=${capped.truncated} ` +
    `dropped=${capped.truncatedChars}ch`,
);
console.log(`  what: ${capped.characterization}`);

/* 6. schedule + history ----------------------------------------------- */
const after = getMonitor(monitor.id)!;
console.log(
  `\nmonitor now: checks=${after.checkCount} changes=${after.changeCount} ` +
    `nextCheckAt=${after.nextCheckAt ? new Date(after.nextCheckAt).toISOString() : '-'}`,
);
console.log(`history (cap ${after.historyLimit}):`);
for (const c of listChecks(monitor.id, 10)) {
  console.log(
    `  ${new Date(c.checkedAt).toISOString()} ${c.baseline ? 'baseline ' : c.changed ? 'CHANGED  ' : 'no change'} ` +
      `+${c.addedLines}/-${c.removedLines} ${c.summary ?? ''}`,
  );
}

console.log('\npause + resume:');
updateMonitor(monitor.id, { status: 'paused' });
console.log(`  paused: nextCheckAt=${getMonitor(monitor.id)!.nextCheckAt ?? 'null'}`);
console.log(`  due now: ${(await runDueMonitors()).length} monitor(s) ran while paused`);
updateMonitor(monitor.id, { status: 'active' });
console.log(`  resumed: nextCheckAt=${new Date(getMonitor(monitor.id)!.nextCheckAt!).toISOString()}`);

const report = resumeMonitors();
console.log(
  `\nresumeMonitors(): active=${report.active} due=${report.due} repaired=${report.repaired} ` +
    `next=${report.nextCheckAt ? new Date(report.nextCheckAt).toISOString() : '-'}`,
);

const stats = monitorStats();
console.log(
  `stats: monitors=${stats.monitors} active=${stats.active} checks=${stats.checks} ` +
    `snapshots=${stats.snapshots} snapshotBytes=${stats.snapshotBytes}`,
);

/* 7. MCP registration smoke test -------------------------------------- */
const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
const { registerMonitorTools } = await import('../src/mcp/tools/monitor.js');
const probe = new McpServer({ name: 'monitor-probe', version: '0' });
registerMonitorTools(probe);
const registered = Object.keys(
  (probe as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
);
console.log(`\nregistered tools (${registered.length}): ${registered.join(', ')}`);

/* cleanup -------------------------------------------------------------- */
stopMonitorScheduler();
deleteMonitor(monitor.id);
deleteSnapshot(trackUrl);
console.log(`\ncleaned up ${monitor.id}`);

const { closeBrowser } = await import('../src/core/fetcher/browser.js');
await closeBrowser();
