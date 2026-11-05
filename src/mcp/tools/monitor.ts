import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  changeTracking,
  resumeMonitors,
  runCheck,
  runDueMonitors,
  setMonitorBaseline,
  startMonitor,
  type CheckOutcome,
} from '../../core/monitor/engine.js';
import {
  deleteMonitor,
  getMonitor,
  listChecks,
  listMonitors,
  monitorStats,
  updateMonitor,
  type CheckRecord,
  type MonitorOptions,
  type MonitorRecord,
} from '../../core/monitor/store.js';
import type { ScrapeOptions } from '../../core/types.js';

export { resumeMonitors, runDueMonitors } from '../../core/monitor/engine.js';

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function ago(at: number | undefined): string {
  if (!at) return 'never';
  const ms = Date.now() - at;
  if (ms < 0) return `in ${human(-ms)}`;
  return `${human(ms)} ago`;
}

function human(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** One line per monitor: enough to pick one, nothing more. */
function monitorLine(m: MonitorRecord): string {
  const bits = [
    m.id,
    m.status,
    `every ${human(m.intervalMs)}`,
    `${m.checkCount} checks`,
    `${m.changeCount} changes`,
  ];
  if (m.status === 'active') bits.push(`next ${ago(m.nextCheckAt)}`);
  if (m.lastCheckAt) bits.push(`last ${ago(m.lastCheckAt)}`);
  if (m.error) bits.push(`error:${m.error.slice(0, 60)}`);
  return `- ${m.label ? `**${m.label}** ` : ''}<${m.url}>\n  ${bits.join(' · ')}`;
}

function checkLine(c: CheckRecord): string {
  const verdict = c.baseline ? 'baseline' : c.changed ? 'CHANGED' : 'no change';
  const bits = [new Date(c.checkedAt).toISOString(), verdict];
  if (c.status) bits.push(`http ${c.status}`);
  if (c.changed) bits.push(`+${c.addedLines}/-${c.removedLines}`);
  if (c.chars) bits.push(`${c.chars}ch`);
  if (c.error) bits.push(`error:${c.error.slice(0, 60)}`);
  return `- ${bits.join(' · ')}${c.characterization ? `\n  ${c.characterization}` : ''}`;
}

function monitorDetail(m: MonitorRecord): string {
  const out = [
    `# monitor ${m.id}${m.label ? ` — ${m.label}` : ''}`,
    `<${m.url}> · ${m.status} · every ${human(m.intervalMs)} · history ${m.historyLimit}`,
    `checks ${m.checkCount} · changes ${m.changeCount} · last check ${ago(m.lastCheckAt)} · last change ${ago(m.lastChangeAt)}` +
      (m.status === 'active' ? ` · next ${ago(m.nextCheckAt)}` : ''),
  ];
  if (m.lastHash) out.push(`hash ${m.lastHash.slice(0, 12)}`);
  if (m.error) out.push(`\n⚠ ${m.error}`);
  const opts = m.options;
  const noted: string[] = [];
  if (opts.webhook?.url) noted.push(`webhook ${opts.webhook.url}${opts.webhook.secret ? ' (signed)' : ''}`);
  if (opts.maxDiffChars) noted.push(`maxDiffChars ${opts.maxDiffChars}`);
  if (opts.scrapeOptions?.render) noted.push(`render ${opts.scrapeOptions.render}`);
  if (opts.scrapeOptions?.onlyMainContent === false) noted.push('onlyMainContent false');
  if (opts.scrapeOptions?.query) noted.push(`query "${opts.scrapeOptions.query}"`);
  if (noted.length) out.push(noted.join(' · '));
  return out.join('\n');
}

/** A check result: header, characterisation, then the capped diff. */
function checkDetail(outcome: CheckOutcome): string {
  const { monitor, check, diff } = outcome;
  const verdict = check.error
    ? 'FAILED'
    : check.baseline
      ? 'BASELINE'
      : check.changed
        ? 'CHANGED'
        : 'NO CHANGE';

  const bits = [monitor.id, verdict];
  if (check.status) bits.push(`http ${check.status}`);
  if (check.chars) bits.push(`${check.chars}ch`);
  if (check.changed) bits.push(check.summary ?? '');
  bits.push(`next ${ago(getMonitor(monitor.id)?.nextCheckAt)}`);

  const out = [`${monitor.url} · ${bits.filter(Boolean).join(' · ')}`];

  if (check.error) {
    out.push(`\n${check.error}`);
    return out.join('\n');
  }
  if (check.baseline) {
    out.push('\nFirst check: stored as the baseline. The next check reports a diff against it.');
    return out.join('\n');
  }
  if (!check.changed) return out.join('\n');

  if (check.characterization) out.push(`\n${check.characterization}`);
  if (check.diff) out.push(`\n\`\`\`diff\n${check.diff}\n\`\`\``);
  if (diff?.truncated || check.diffTruncatedChars) {
    out.push(`_diff truncated: ${check.diffTruncatedChars ?? diff?.truncatedChars} more chars._`);
  }
  return out.join('\n');
}

/* ------------------------------------------------------------------ */
/* Input schemas                                                       */
/* ------------------------------------------------------------------ */

const webhookSchema = z.object({
  url: z.string().describe('POST target.'),
  secret: z
    .string()
    .optional()
    .describe('HMAC-SHA256 key; the body is signed into `x-openscrape-signature`.'),
  events: z
    .array(z.enum(['checked', 'changed', 'error']))
    .optional()
    .describe('Which events to send. Default: all of them.'),
});

const scrapeOptionsSchema = z
  .object({
    formats: z.array(z.enum(['markdown', 'html', 'text'])).optional(),
    onlyMainContent: z.boolean().optional(),
    includeTags: z.array(z.string()).optional(),
    excludeTags: z.array(z.string()).optional(),
    query: z.string().optional().describe('Monitor only the part of the page matching this.'),
    render: z.enum(['auto', 'http', 'browser']).optional(),
    timeout: z.number().optional(),
    waitFor: z.number().optional(),
    waitForSelector: z.string().optional(),
    headers: z.record(z.string()).optional(),
    proxy: z.string().optional(),
    mobile: z.boolean().optional(),
  })
  .describe(
    'How to fetch the page on every check. Narrow this (includeTags, excludeTags or query) to ' +
      'watch one region and stop reporting unrelated churn.',
  );

function toMonitorOptions(args: Record<string, unknown>): MonitorOptions {
  return {
    scrapeOptions: args.scrapeOptions as ScrapeOptions | undefined,
    webhook: args.webhook as MonitorOptions['webhook'],
    maxDiffChars: args.maxDiffChars as number | undefined,
    maxSnapshotChars: args.maxSnapshotChars as number | undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

export function registerMonitorTools(server: McpServer): void {
  server.registerTool(
    'monitor_create',
    {
      title: 'Watch a page for changes',
      description:
        'Create a monitor: a URL re-fetched on an interval, hashed and diffed against the previous ' +
        'check. Checks run in-process while the server is up and the schedule is persisted, so a ' +
        'restart resumes it. The first check stores a baseline; later ones report a diff or "no change".',
      inputSchema: {
        url: z.string().describe('The http(s) URL to watch.'),
        label: z.string().optional().describe('Short name, for your own reference.'),
        intervalMs: z
          .number()
          .optional()
          .describe('How often to check, in ms. Default 3600000 (1h). Minimum 30000.'),
        historyLimit: z
          .number()
          .optional()
          .describe('Checks to keep per monitor. Default 20. Older ones are dropped.'),
        paused: z.boolean().optional().describe('Create it without scheduling any checks.'),
        checkNow: z
          .boolean()
          .optional()
          .describe('Run the first check immediately and return its result. Default true.'),
        baseline: z
          .string()
          .optional()
          .describe('Seed the previous version from content you already have, instead of fetching one.'),
        maxDiffChars: z.number().optional().describe('Cap the diff returned per check. Default 2000.'),
        maxSnapshotChars: z
          .number()
          .optional()
          .describe('Cap the stored page snapshot used as the next diff baseline. Default 60000.'),
        webhook: webhookSchema.optional().describe('POST when a change is detected.'),
        scrapeOptions: scrapeOptionsSchema.optional(),
      },
    },
    async (args) => {
      const paused = args.paused === true;
      const monitor = startMonitor({
        url: String(args.url),
        label: args.label as string | undefined,
        intervalMs: args.intervalMs as number | undefined,
        historyLimit: args.historyLimit as number | undefined,
        status: paused ? 'paused' : 'active',
        options: toMonitorOptions(args as Record<string, unknown>),
      });

      if (typeof args.baseline === 'string' && args.baseline.length > 0) {
        setMonitorBaseline(monitor.id, args.baseline);
      }

      const lines = [monitorDetail(getMonitor(monitor.id)!)];

      if (args.checkNow !== false && !paused) {
        const outcome = await runCheck(monitor.id);
        if (outcome) lines.push('', '## First check', checkDetail(outcome));
      }

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );

  server.registerTool(
    'monitor_list',
    {
      title: 'List monitors',
      description:
        'Every monitor with its interval, next check, and how many checks and changes it has seen.',
      inputSchema: {
        limit: z.number().optional().describe('Maximum monitors to list. Default 50.'),
        status: z.enum(['active', 'paused']).optional().describe('Filter by status.'),
      },
    },
    async (args) => {
      const all = listMonitors((args.limit as number | undefined) ?? 50);
      const monitors = args.status ? all.filter((m) => m.status === args.status) : all;
      const stats = monitorStats();

      if (monitors.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No monitors. Create one with `monitor_create`.' }],
        };
      }
      const header =
        `${monitors.length} monitor(s) · ${stats.active} active · ${stats.checks} stored checks · ` +
        `${(stats.snapshotBytes / 1024).toFixed(0)} KB of snapshots`;
      return {
        content: [
          { type: 'text' as const, text: `${header}\n\n${monitors.map(monitorLine).join('\n')}` },
        ],
      };
    },
  );

  server.registerTool(
    'monitor_get',
    {
      title: 'Monitor detail and history',
      description:
        'One monitor with its recent check history: when each ran, whether the page changed, and ' +
        'what changed. Pass `includeDiffs` to get the stored diffs too.',
      inputSchema: {
        id: z.string().describe('Monitor id from `monitor_create` or `monitor_list`.'),
        checks: z.number().optional().describe('How many recent checks to show. Default 10.'),
        includeDiffs: z
          .boolean()
          .optional()
          .describe('Include each check\'s stored diff. Off by default; diffs are the big part.'),
      },
    },
    async (args) => {
      const id = String(args.id);
      const monitor = getMonitor(id);
      if (!monitor) {
        return {
          content: [{ type: 'text' as const, text: `No monitor ${id}.` }],
          isError: true,
        };
      }

      const history = listChecks(id, (args.checks as number | undefined) ?? 10);
      const out = [monitorDetail(monitor)];
      if (history.length === 0) {
        out.push('\nNo checks yet.');
      } else {
        out.push(`\n## Checks (${history.length})\n`);
        out.push(history.map(checkLine).join('\n'));
        if (args.includeDiffs) {
          for (const c of history) {
            if (!c.diff) continue;
            out.push(
              `\n### ${new Date(c.checkedAt).toISOString()} · ${c.summary ?? ''}\n\n\`\`\`diff\n${c.diff}\n\`\`\``,
            );
          }
        }
      }
      return { content: [{ type: 'text' as const, text: out.join('\n') }] };
    },
  );

  server.registerTool(
    'monitor_update',
    {
      title: 'Change a monitor',
      description:
        'Change a monitor\'s interval, label, history cap, scrape options or webhook, or pause and ' +
        'resume it. Pausing stops checks but keeps the history; resuming makes it due immediately.',
      inputSchema: {
        id: z.string().describe('Monitor id.'),
        label: z.string().optional(),
        intervalMs: z.number().optional().describe('New interval in ms. Minimum 30000.'),
        historyLimit: z.number().optional().describe('New per-monitor history cap.'),
        status: z.enum(['active', 'paused']).optional().describe('Pause or resume.'),
        maxDiffChars: z.number().optional(),
        maxSnapshotChars: z.number().optional(),
        webhook: webhookSchema.optional(),
        scrapeOptions: scrapeOptionsSchema.optional(),
        replaceOptions: z
          .boolean()
          .optional()
          .describe('Replace scrape options and webhook wholesale instead of merging.'),
      },
    },
    async (args) => {
      const id = String(args.id);
      const patchOptions = toMonitorOptions(args as Record<string, unknown>);
      const hasOptionPatch = Object.values(patchOptions).some((v) => v !== undefined);

      const monitor = updateMonitor(id, {
        label: args.label as string | undefined,
        intervalMs: args.intervalMs as number | undefined,
        historyLimit: args.historyLimit as number | undefined,
        status: args.status as MonitorRecord['status'] | undefined,
        options: hasOptionPatch ? patchOptions : undefined,
        replaceOptions: args.replaceOptions === true,
      });

      if (!monitor) {
        return { content: [{ type: 'text' as const, text: `No monitor ${id}.` }], isError: true };
      }
      // A resumed or re-intervalled monitor needs the timer pointed at it again.
      resumeMonitors();
      return { content: [{ type: 'text' as const, text: monitorDetail(getMonitor(id)!) }] };
    },
  );

  server.registerTool(
    'monitor_delete',
    {
      title: 'Delete a monitor',
      description: 'Remove a monitor and its stored check history. Not reversible.',
      inputSchema: { id: z.string().describe('Monitor id.') },
    },
    async (args) => {
      const id = String(args.id);
      const existed = deleteMonitor(id);
      return {
        content: [
          { type: 'text' as const, text: existed ? `Deleted monitor ${id}.` : `No monitor ${id}.` },
        ],
        isError: !existed,
      };
    },
  );

  server.registerTool(
    'monitor_run',
    {
      title: 'Check a monitor now',
      description:
        'Fetch a monitored page right now and report whether it changed since the last check, with ' +
        'a capped diff. Resets the interval from now. Omit `id` to run every monitor that is due.',
      inputSchema: {
        id: z.string().optional().describe('Monitor id. Omit to run all due monitors.'),
      },
    },
    async (args) => {
      if (!args.id) {
        const outcomes = await runDueMonitors();
        if (outcomes.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No monitors are due.' }] };
        }
        const changed = outcomes.filter((o) => o.check.changed).length;
        const header = `Ran ${outcomes.length} due monitor(s) · ${changed} changed`;
        return {
          content: [
            {
              type: 'text' as const,
              text: `${header}\n\n${outcomes.map((o) => checkDetail(o)).join('\n\n')}`,
            },
          ],
        };
      }

      const id = String(args.id);
      const outcome = await runCheck(id);
      if (!outcome) {
        return {
          content: [
            { type: 'text' as const, text: `No monitor ${id} (or a check is already running).` },
          ],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: checkDetail(outcome) }] };
    },
  );

  server.registerTool(
    'change_tracking',
    {
      title: 'Has this page changed?',
      description:
        'Compare a URL against the last version stored for it and report whether it changed, plus a ' +
        'capped diff. This is Firecrawl\'s `changeTracking` format as a one-shot call: no monitor, no ' +
        'schedule. Pass `content` to compare text you already have, or omit it to fetch the page now.',
      inputSchema: {
        url: z.string().describe('The URL whose previous version to compare against.'),
        content: z
          .string()
          .optional()
          .describe('Current content. Omitted means: scrape the URL now and use its markdown.'),
        tag: z
          .string()
          .optional()
          .describe('Separate baseline lane for the same URL, e.g. one per scrape preset.'),
        store: z
          .boolean()
          .optional()
          .describe('Store this version as the new baseline. Default true.'),
        maxDiffChars: z.number().optional().describe('Cap the returned diff. Default 2000.'),
      },
    },
    async (args) => {
      const url = String(args.url);
      let content = args.content as string | undefined;
      let status: number | undefined;

      if (content === undefined) {
        const { scrape } = await import('../../core/scrape.js');
        const result = await scrape(url, { formats: ['markdown'], maxAge: 0 });
        if (!result.success) {
          return {
            content: [{ type: 'text' as const, text: `FAILED ${url}\n${result.error ?? ''}` }],
            isError: true,
          };
        }
        content = result.markdown ?? result.text ?? '';
        status = result.metadata?.statusCode;
      }

      const tracked = changeTracking(url, content, {
        tag: args.tag as string | undefined,
        store: args.store as boolean | undefined,
        maxDiffChars: args.maxDiffChars as number | undefined,
      });

      const verdict = tracked.first ? 'FIRST SEEN' : tracked.changed ? 'CHANGED' : 'NO CHANGE';
      const bits = [verdict, `${content.length}ch`, `hash ${tracked.hash.slice(0, 12)}`];
      if (status) bits.unshift(`http ${status}`);
      if (tracked.previousAt) bits.push(`previous ${ago(tracked.previousAt)}`);
      if (tracked.diff) bits.push(tracked.diff.summary);

      const out = [`${url} · ${bits.join(' · ')}`];
      if (tracked.first) out.push('\nNothing stored for this URL before; saved as the baseline.');
      if (tracked.diff) {
        out.push(`\n${tracked.diff.characterization}`);
        if (tracked.diff.diff) out.push(`\n\`\`\`diff\n${tracked.diff.diff}\n\`\`\``);
        if (tracked.diff.truncated) {
          out.push(`_diff truncated: ${tracked.diff.truncatedChars} more chars._`);
        }
      }
      return { content: [{ type: 'text' as const, text: out.join('\n') }] };
    },
  );
}
