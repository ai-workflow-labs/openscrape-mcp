/**
 * MCP tools over the proxy rotation pool.
 *
 * Output is a compact fixed-width table rather than a JSON envelope: a pool of
 * ten proxies should cost a dozen lines, not a page of field names.
 *
 * Nothing here prints a proxy URL. Every row is identified by the pool's
 * redacted `host:port#hash` id, because a proxy URL carries `user:password@`
 * and a tool result is a transcript.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  checkProxyPool,
  proxyPoolStatus,
  type ProxyCheckResult,
  type ProxyPoolStatus,
} from '../../core/fetcher/proxypool.js';

const AUTHORISED_USE =
  'For proxies you own or are licensed to use, against sites you are authorised to scrape. ' +
  'Rotation spreads your own traffic across your own egress IPs and backs off when a site pushes back. ' +
  'It does not bypass, defeat or solve any bot protection or CAPTCHA.';

const NONE_CONFIGURED =
  'Proxy pool: none configured.\n\n' +
  'Scrapes use a direct connection, which is the normal setup and needs nothing further.\n' +
  'To add your own proxies, set OPENSCRAPE_PROXIES to a comma-separated list\n' +
  '(http://user:pass@host:port, or host:port), or OPENSCRAPE_PROXY_FILE to a file\n' +
  'with one per line. Optional: OPENSCRAPE_PROXY_STRATEGY =\n' +
  'round-robin | least-recently-used | lowest-latency | sticky-per-host.';

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function padLeft(value: string, width: number): string {
  return value.length >= width ? value : ' '.repeat(width - value.length) + value;
}

function ms(value: number): string {
  return value >= 10_000 ? `${Math.round(value / 1000)}s` : `${value}ms`;
}

function table(rows: string[][]): string {
  const widths = rows[0].map((_, col) => Math.max(...rows.map((r) => (r[col] ?? '').length)));
  // Counters right-align so they stay readable; ids and notes left-align.
  const numeric = new Set([2, 3, 4, 5]);
  return rows
    .map((row) =>
      row
        .map((cell, col) =>
          numeric.has(col) ? padLeft(cell, widths[col]) : pad(cell, widths[col]),
        )
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

export function formatProxyStatus(status: ProxyPoolStatus, now = Date.now()): string {
  if (status.configured === 0) return NONE_CONFIGURED;

  const header =
    `Proxy pool: ${status.configured} configured · ${status.available} available · ` +
    `${status.benched} benched · strategy ${status.strategy}` +
    (status.sources.length ? ` · from ${status.sources.join(', ')}` : '');

  const rows: string[][] = [['proxy', 'state', 'ok', 'fail', 'blk', 'p50', 'egress', 'note']];

  for (const p of status.proxies) {
    const notes: string[] = [];
    if (p.state === 'benched' && p.benchedUntil) {
      notes.push(`benched ${ms(Math.max(0, p.benchedUntil - now))} (x${p.benchCount})`);
    }
    if (p.state === 'probation') notes.push('probe due');
    if (p.duplicateOf) notes.push(`same egress as ${p.duplicateOf}`);
    for (const b of p.hostBlocks) {
      notes.push(`${b.host}:${b.lastReason}${b.count > 1 ? `x${b.count}` : ''}`);
    }
    if (p.lastError && p.state !== 'ok') notes.push(p.lastError);

    rows.push([
      p.id,
      p.state,
      String(p.successes),
      String(p.failures),
      String(p.blocks),
      p.medianLatencyMs === null ? '-' : ms(p.medianLatencyMs),
      p.egressIp ?? '-',
      notes.join('; '),
    ]);
  }

  const out = [header, '', table(rows)];

  if (status.stickyAssignments.length) {
    out.push(
      '',
      'Sticky: ' + status.stickyAssignments.map((s) => `${s.host} -> ${s.proxy}`).join(', '),
    );
  }

  const dupes = status.proxies.filter((p) => p.duplicateOf).length;
  if (dupes) {
    out.push(
      '',
      `⚠ ${dupes} proxy(ies) share an egress IP with another — they give no rotation benefit. ` +
        'Run proxy_check to re-measure.',
    );
  }
  if (status.proxies.some((p) => p.egressIp === undefined)) {
    out.push('', 'Egress IPs are discovered by proxy_check.');
  }

  out.push('', AUTHORISED_USE);
  return out.join('\n');
}

export function formatProxyCheck(results: ProxyCheckResult[]): string {
  if (!results.length) return NONE_CONFIGURED;

  const working = results.filter((r) => r.ok);
  const rows: string[][] = [['proxy', 'result', '', '', '', 'latency', 'egress', 'note']];

  for (const r of results) {
    const notes: string[] = [];
    if (r.duplicateOf) notes.push(`same egress as ${r.duplicateOf}`);
    if (r.error) notes.push(r.error);
    rows.push([
      r.proxy,
      r.ok ? 'ok' : 'broken',
      '',
      '',
      '',
      r.latencyMs === undefined ? '-' : ms(r.latencyMs),
      r.egressIp ?? '-',
      notes.join('; '),
    ]);
  }

  const uniqueIps = new Set(results.filter((r) => r.egressIp).map((r) => r.egressIp));
  const out = [
    `Proxy check: ${working.length}/${results.length} working · ${uniqueIps.size} distinct egress IP(s)`,
    '',
    table(rows),
  ];

  const dupes = results.filter((r) => r.duplicateOf).length;
  if (dupes) {
    out.push(
      '',
      `⚠ ${dupes} proxy(ies) came out on an egress IP another proxy already uses. ` +
        'Two proxies on one IP give no rotation benefit.',
    );
  }
  if (working.length === 0) {
    out.push(
      '',
      'None of the configured proxies answered. Scrapes still work over a direct connection.',
    );
  }

  out.push('', AUTHORISED_USE);
  return out.join('\n');
}

export function registerProxyTools(server: McpServer): void {
  server.registerTool(
    'proxy_status',
    {
      title: 'Proxy pool status',
      description:
        'Report the configured proxy rotation pool: per-proxy successes, failures, site blocks, median latency, ' +
        'egress IP, which proxies are benched by the circuit breaker, and which share an egress IP (no rotation benefit). ' +
        'Reports "none configured" when no proxies are set up, which is the normal case — scrapes then use a direct connection. ' +
        'Proxy credentials are never shown: each proxy appears as host:port#hash. ' +
        AUTHORISED_USE,
      inputSchema: {},
    },
    async () => {
      const status = proxyPoolStatus();
      return { content: [{ type: 'text' as const, text: formatProxyStatus(status) }] };
    },
  );

  server.registerTool(
    'proxy_check',
    {
      title: 'Check proxies now',
      description:
        'Probe every configured proxy against a neutral IP-echo endpoint and report which work, their latency, ' +
        'their apparent egress IP, and any duplicates. Results feed the pool health, so a recovered proxy comes ' +
        'back into service. Unreachable proxies are reported as broken rather than failing the call. ' +
        'Proxy credentials are never shown. ' +
        AUTHORISED_USE,
      inputSchema: {
        timeout: z
          .number()
          .optional()
          .describe('Per-proxy probe timeout in ms. Default 10000.'),
      },
    },
    async (args) => {
      const timeout = typeof args.timeout === 'number' ? args.timeout : undefined;
      const results = await checkProxyPool(timeout);
      return { content: [{ type: 'text' as const, text: formatProxyCheck(results) }] };
    },
  );
}
