/**
 * MCP tools for web archive access.
 *
 * Output follows `src/mcp/format.ts`: a one-line header, then the essentials.
 * Snapshot lists are compact tables rather than raw CDX JSON — a 200-capture
 * listing rendered as JSON costs more tokens than the page it describes.
 *
 * Every archived result opens with its staleness notice. That placement is the
 * point: a model reading the top of this output cannot mistake a 2019 capture
 * for today's page.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  commonCrawlDiscover,
  commonCrawlLookup,
  compareSnapshots,
  fetchArchived,
  listSnapshots,
  type ArchiveSnapshot,
  type ArchivedContent,
  type CcCollectionStatus,
} from '../../core/discover/archive.js';

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], isError };
}

function human(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}

/** "2019-04-01 23:45" — readable, sortable, and shorter than an ISO string. */
function shortTime(timestamp: string): string {
  const t = timestamp.padEnd(14, '0');
  return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)} ${t.slice(8, 10)}:${t.slice(10, 12)}`;
}

function sizeOf(snapshot: ArchiveSnapshot): string {
  return snapshot.length === undefined ? '-' : human(snapshot.length);
}

/** A compact pipe table. Column widths are not padded: padding is tokens. */
function snapshotTable(snapshots: ArchiveSnapshot[]): string {
  const rows = snapshots.map(
    (s) =>
      `| ${s.timestamp} | ${shortTime(s.timestamp)} | ${s.statusCode ?? (s.revisit ? 'revisit' : '-')} | ${
        s.mimeType ?? '-'
      } | ${sizeOf(s)} |`,
  );
  return ['| timestamp | captured (UTC) | status | type | bytes |', '|---|---|---|---|---|', ...rows].join(
    '\n',
  );
}

function collectionsLine(statuses: CcCollectionStatus[]): string {
  if (!statuses.length) return 'no collections queried';
  return statuses
    .map((s) => {
      const head = `${s.id} ${s.ok ? `${s.records} rec` : 'FAILED'}`;
      return s.note ? `${head} (${s.note})` : head;
    })
    .join(' · ');
}

/** The staleness block that opens every archived-content result. */
function stalenessBlock(content: ArchivedContent): string[] {
  const s = content.staleness;
  return [
    `# ${content.title ?? content.url}`,
    `⚠ ${s.notice}`,
    `<${content.url}> · wayback · capture ${content.snapshot.timestamp} · ${content.kind} · ` +
      `${human(content.bytes)} bytes · ${content.elapsedMs}ms`,
    `Archived at: ${content.snapshot.contentUrl}`,
  ];
}

export function registerArchiveTools(server: McpServer): void {
  // ------------------------------------------------------- archive_snapshots

  server.registerTool(
    'archive_snapshots',
    {
      title: 'List archived snapshots',
      description:
        'List the Wayback Machine captures that exist for a URL, newest first, with their timestamps, ' +
        'HTTP status and size. Use this before archive_fetch to see what dates are actually available. ' +
        'Optionally also checks whether Common Crawl holds the page. ' +
        '"No snapshots exist" is a real answer, not an error.',
      inputSchema: {
        url: z.string().describe('The http(s) URL to look up.'),
        limit: z.number().optional().describe('Snapshots to list. Default 20, max 500.'),
        from: z.string().optional().describe('Earliest capture to consider: YYYY, YYYYMM or YYYYMMDD.'),
        to: z.string().optional().describe('Latest capture to consider, same formats as `from`.'),
        includeErrorCaptures: z
          .boolean()
          .optional()
          .describe('Also list captures that answered 404/500 etc. Default false.'),
        allDuplicates: z
          .boolean()
          .optional()
          .describe('List every capture, including ones byte-identical to the previous. Default false.'),
        matchPrefix: z
          .boolean()
          .optional()
          .describe('Treat the URL as a prefix and list captures of everything beneath it.'),
        checkCommonCrawl: z
          .boolean()
          .optional()
          .describe('Also ask the Common Crawl index whether this page was captured. Slower.'),
      },
    },
    async (args) => {
      const url = String(args.url);
      const list = await listSnapshots(url, {
        limit: args.limit as number | undefined,
        from: args.from as string | undefined,
        to: args.to as string | undefined,
        onlyOk: args.includeErrorCaptures ? false : undefined,
        collapseDuplicates: args.allDuplicates ? false : undefined,
        matchPrefix: args.matchPrefix as boolean | undefined,
      });

      const out: string[] = [];
      out.push(`# Archived snapshots of ${url}`);

      if (!list.ok) {
        out.push(`FAILED · ${list.error ?? 'unknown error'} · ${list.elapsedMs}ms`);
        return textResult(out.join('\n'), true);
      }

      const span =
        list.oldest && list.newest
          ? `${shortTime(list.oldest.timestamp)} → ${shortTime(list.newest.timestamp)}`
          : 'no captures';
      out.push(
        `wayback · ${list.snapshots.length} shown of ${list.returned} returned · ${span} · ${list.elapsedMs}ms`,
      );
      if (list.note) out.push(`\n${list.note}`);
      if (list.snapshots.length) {
        out.push('');
        out.push(snapshotTable(list.snapshots));
        out.push(
          `\n_Read one with archive_fetch(url, snapshotTimestamp: "${list.snapshots[0]!.timestamp}")._`,
        );
      }

      if (args.checkCommonCrawl) {
        const cc = await commonCrawlLookup(url, { limit: 5 });
        out.push('\n## Common Crawl');
        out.push(collectionsLine(cc.collections));
        if (cc.error) out.push(`FAILED · ${cc.error}`);
        else if (!cc.captured) out.push(cc.note ?? 'No Common Crawl record of this URL.');
        else {
          out.push('');
          out.push(
            [
              '| timestamp | captured (UTC) | status | collection |',
              '|---|---|---|---|',
              ...cc.records.map(
                (r) =>
                  `| ${r.timestamp} | ${shortTime(r.timestamp)} | ${r.status ?? '-'} | ${r.collection} |`,
              ),
            ].join('\n'),
          );
        }
      }

      return textResult(out.join('\n'));
    },
  );

  // ----------------------------------------------------------- archive_fetch

  server.registerTool(
    'archive_fetch',
    {
      title: 'Read an archived copy',
      description:
        'Fetch an archived copy of a page from the Wayback Machine and return it as clean markdown, ' +
        'through the same extraction pipeline as `scrape`. This is the way to read a page that blocks ' +
        'us behind Cloudflare, DataDome or PerimeterX, and the only way to read a page as it looked on ' +
        'a past date. The result ALWAYS states the capture date and how old it is — archived content ' +
        'must never be treated as current.',
      inputSchema: {
        url: z.string().describe('The original http(s) URL (not a web.archive.org URL).'),
        date: z
          .string()
          .optional()
          .describe(
            'Prefer the capture closest to this date: "2019-06-01", "20190601" or a full timestamp. Omit for the most recent capture.',
          ),
        snapshotTimestamp: z
          .string()
          .optional()
          .describe('Read exactly this 14-digit capture timestamp, from archive_snapshots. Skips the lookup.'),
        onlyMainContent: z
          .boolean()
          .optional()
          .describe('Strip nav, header, footer and sidebars. Default true.'),
        maxChars: z.number().optional().describe('Cap the markdown returned.'),
        includeLinks: z.boolean().optional().describe('Also list the links found in the archived page.'),
        includeErrorCaptures: z
          .boolean()
          .optional()
          .describe('Accept a capture that answered 404/500 etc. Default false.'),
      },
    },
    async (args) => {
      const url = String(args.url);
      const result = await fetchArchived(url, {
        timestamp: args.date as string | undefined,
        snapshotTimestamp: args.snapshotTimestamp as string | undefined,
        onlyMainContent: args.onlyMainContent as boolean | undefined,
        maxChars: args.maxChars as number | undefined,
        includeErrorCaptures: args.includeErrorCaptures as boolean | undefined,
      });

      if (!result.ok || !result.content) {
        const reason = result.reason === 'no-snapshots' ? 'NO SNAPSHOTS' : 'FAILED';
        return textResult(
          `${reason} ${url}\n${result.message ?? 'unknown error'}\n\n` +
            (result.reason === 'no-snapshots'
              ? '_No archived copy exists. This is a complete answer: the archives simply never captured this URL._'
              : `_${result.elapsedMs}ms._`),
          result.reason !== 'no-snapshots',
        );
      }

      const content = result.content;
      const out = stalenessBlock(content);
      if (content.pages) out.push(`Pages: ${content.pages}`);
      if (content.warning) out.push(`\n⚠ ${content.warning}`);
      if (content.truncatedChars) {
        out.push(`\n_Truncated: ${human(content.truncatedChars)} characters dropped._`);
      }
      out.push(`\n## Content (as of ${content.staleness.capturedOn})\n\n${content.markdown}`);

      if (args.includeLinks && content.links.length) {
        const shown = content.links.slice(0, 100);
        out.push(
          `\n## Links (${content.links.length}${
            content.links.length > shown.length ? `, showing ${shown.length}` : ''
          })\n\n` + shown.map((l) => `- ${l}`).join('\n'),
        );
      }

      out.push(
        `\n---\n⚠ Everything above is from ${content.staleness.capturedOn} (${content.staleness.ageText} old). ` +
          `Do not report it as the page's current state.`,
      );

      return textResult(out.join('\n'));
    },
  );

  // -------------------------------------------------------- archive_discover

  server.registerTool(
    'archive_discover',
    {
      title: 'Discover URLs from Common Crawl',
      description:
        "Find URLs for a domain from the Common Crawl index — every page the crawl actually saw, " +
        'including pages no sitemap lists and no link on the site points at. Use it when `map` or a ' +
        'sitemap comes back thin. Wildcard index queries are expensive, so results are paged and ' +
        'hard-capped, and whatever was skipped is reported.',
      inputSchema: {
        domain: z
          .string()
          .describe('Domain or URL prefix, e.g. "example.com" or "example.com/docs". A path narrows the search.'),
        limit: z.number().optional().describe('URLs to return. Default 200, hard cap 5000.'),
        collections: z
          .number()
          .optional()
          .describe('How many monthly crawls to query, newest first. Default 1, max 6. More = slower.'),
        collectionIds: z
          .array(z.string())
          .optional()
          .describe('Specific crawl ids instead, e.g. ["CC-MAIN-2024-33"]. The newest indexes are often busy.'),
        maxPages: z.number().optional().describe('Index pages per collection. Default 4, hard cap 50.'),
        includeNonHtml: z
          .boolean()
          .optional()
          .describe('Include PDFs, images and other non-HTML captures. Default false.'),
        includeErrorCaptures: z
          .boolean()
          .optional()
          .describe('Include URLs whose capture answered 404/500 etc. Default false.'),
      },
    },
    async (args) => {
      const domain = String(args.domain);
      const result = await commonCrawlDiscover(domain, {
        limit: args.limit as number | undefined,
        collections: args.collections as number | undefined,
        collectionIds: args.collectionIds as string[] | undefined,
        maxPages: args.maxPages as number | undefined,
        onlyHtml: args.includeNonHtml ? false : undefined,
        onlyOk: args.includeErrorCaptures ? false : undefined,
      });

      const out: string[] = [];
      out.push(`# Common Crawl URLs for ${result.pattern}`);
      out.push(
        `${result.urls.length} urls from ${human(result.records)} index records · ${result.elapsedMs}ms` +
          (result.capped ? ' · CAPPED' : ''),
      );
      out.push(collectionsLine(result.collections));

      if (!result.ok) {
        out.push(`\nFAILED · ${result.error ?? 'unknown error'}`);
        out.push(
          '\n_The Common Crawl index frequently answers a wildcard query with a gateway timeout. ' +
            'Retrying, or naming an older collection via collectionIds, usually works._',
        );
        return textResult(out.join('\n'), true);
      }
      if (result.note) out.push(`\n${result.note}`);
      if (result.urls.length) {
        out.push('');
        out.push(result.urls.map((u) => `- ${u}`).join('\n'));
      }
      return textResult(out.join('\n'));
    },
  );

  // --------------------------------------------------------- archive_compare

  server.registerTool(
    'archive_compare',
    {
      title: 'Compare a page across two dates',
      description:
        'Fetch two archived copies of the same URL and report what changed between them: added and ' +
        'removed line counts, a plain-English characterisation (a price moved, a paragraph was added), ' +
        'and bounded diff hunks. Answers questions no live scrape can, like what a pricing page said ' +
        'last year. Both capture dates are stated.',
      inputSchema: {
        url: z.string().describe('The original http(s) URL.'),
        firstDate: z.string().describe('First date: "2019-06-01", "20190601" or a full timestamp.'),
        secondDate: z.string().describe('Second date, same formats. Order does not matter.'),
        maxDiffChars: z.number().optional().describe('Cap the rendered diff. Default 2000.'),
        onlyMainContent: z
          .boolean()
          .optional()
          .describe('Strip nav, header and footer before comparing. Default true — navigation churn otherwise swamps the diff.'),
        includeContent: z
          .boolean()
          .optional()
          .describe('Also return the full markdown of the newer capture.'),
      },
    },
    async (args) => {
      const url = String(args.url);
      const result = await compareSnapshots(url, String(args.firstDate), String(args.secondDate), {
        maxDiffChars: args.maxDiffChars as number | undefined,
        onlyMainContent: args.onlyMainContent as boolean | undefined,
      });

      const out: string[] = [];
      out.push(`# Changes to ${url}`);

      if (!result.ok) {
        out.push(`FAILED · ${result.message ?? 'unknown error'} · ${result.elapsedMs}ms`);
        return textResult(out.join('\n'), true);
      }

      const before = result.before!;
      const after = result.after!;
      out.push(
        `${before.staleness.capturedOn} → ${after.staleness.capturedOn}` +
          (result.gapDays !== undefined ? ` · ${result.gapDays} days apart` : '') +
          ` · ${result.elapsedMs}ms`,
      );
      out.push(
        `captures ${before.snapshot.timestamp} and ${after.snapshot.timestamp} · ` +
          `both are ARCHIVED copies, neither is live`,
      );
      if (result.message) out.push(`\n⚠ ${result.message}`);

      const diff = result.diff;
      if (!diff || !diff.changed) {
        out.push(
          `\n**No change.** The extracted content is byte-identical between the two captures ` +
            `(hash ${result.beforeHash?.slice(0, 12)}).`,
        );
      } else {
        out.push(`\n**${diff.summary}** — ${diff.characterization}`);
        if (diff.diff) out.push(`\n\`\`\`diff\n${diff.diff}\n\`\`\``);
        if (diff.truncated) out.push(`_Diff truncated: ${human(diff.truncatedChars)} characters dropped._`);
      }

      if (args.includeContent) {
        out.push(`\n## ${after.staleness.capturedOn} content\n\n${after.markdown}`);
      }

      out.push(
        `\n---\n⚠ Both copies are archived: the newer is from ${after.staleness.capturedOn} ` +
          `(${after.staleness.ageText} old). The page may have changed again since.`,
      );

      return textResult(out.join('\n'));
    },
  );
}
