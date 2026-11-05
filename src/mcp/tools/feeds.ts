/**
 * MCP tools for web feeds.
 *
 * Output style follows `src/mcp/format.ts`: a one-line header, then a compact
 * list. A feed item is title + date + URL + a short teaser; full bodies travel
 * only when the caller asks for them, because a 40-item feed with every article
 * inlined is tens of thousands of tokens for a question that was "what's new".
 *
 * Two honesty rules shape the formatting:
 *  - a date is printed only when it actually parsed; otherwise the original
 *    string is shown as unparsed, never quietly replaced with today;
 *  - a body is labelled with where it came from, so the feed's own teaser is
 *    never presented as the full article.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  discoverFeeds,
  loadOpml,
  readFeed,
  readTimeline,
  type FeedDate,
  type FeedItem,
  type FeedDiscovery,
  type FeedReadResult,
  type TimelineResult,
} from '../../core/discover/feeds.js';

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], isError };
}

function human(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}

/** A date, or an honest note that the feed's date string did not parse. */
function showDate(date: FeedDate | undefined): string {
  if (!date) return 'no date';
  if (date.iso) return date.iso.replace('.000Z', 'Z');
  return `date unparsed: "${date.raw}"`;
}

const SOURCE_LABEL: Record<string, string> = {
  'content:encoded': 'feed body (content:encoded)',
  'atom:content': 'feed body (atom content)',
  description: 'feed teaser (description)',
  'atom:summary': 'feed teaser (atom summary)',
  'json:content_html': 'feed body (content_html)',
  'json:content_text': 'feed body (content_text)',
  scraped: 'FULL ARTICLE (scraped from the page)',
};

function itemBlock(item: FeedItem, index: number, includeContent: boolean): string[] {
  const out: string[] = [];
  out.push(`${index}. **${item.title ?? '(untitled)'}**`);

  const meta = [showDate(item.published ?? item.updated)];
  if (item.author) meta.push(item.author);
  if (item.feedTitle) meta.push(item.feedTitle);
  if (item.categories.length) meta.push(item.categories.slice(0, 4).join(', '));
  out.push(`   ${meta.join(' · ')}`);
  out.push(`   ${item.url ?? '(no link in feed)'}`);

  if (item.summary) out.push(`   ${item.summary}`);
  if (item.enclosure) out.push(`   enclosure: ${item.enclosure}`);
  if (item.fetchError) out.push(`   ⚠ full text failed: ${item.fetchError}`);

  if (includeContent && item.content) {
    const label = SOURCE_LABEL[item.contentSource ?? ''] ?? item.contentSource ?? 'unknown source';
    out.push(`   _body — ${label}_`);
    out.push('');
    out.push(item.content);
  }
  out.push('');
  return out;
}

// -------------------------------------------------------------- discovery

function formatDiscovery(result: FeedDiscovery): string {
  const out: string[] = [];
  out.push(`# Feeds for ${result.pageUrl}`);
  const header = [`${result.feeds.length} feed(s)`, `${result.tried.length} candidate(s) checked`, `${result.elapsedMs}ms`];
  if (!result.pageFetched) header.push('page not read');
  out.push(header.join(' · '));
  if (result.finalUrl && result.finalUrl !== result.pageUrl) out.push(`landed on <${result.finalUrl}>`);
  if (result.pageError) out.push(`\n⚠ ${result.pageError}`);

  if (result.feeds.length === 0) {
    out.push('\n**No feed found.** That is a normal answer: plenty of sites publish none.');
  } else {
    out.push('');
    result.feeds.forEach((feed, i) => {
      out.push(`${i + 1}. **${feed.title ?? '(untitled feed)'}** — ${feed.format.toUpperCase()} · ${feed.itemCount} items`);
      out.push(`   ${feed.url}`);
      const bits = [`found via ${feed.source}`];
      if (feed.newestItem) bits.push(`newest ${feed.newestItem.replace('.000Z', 'Z')}`);
      if (feed.unparsableDates) bits.push(`${feed.unparsableDates} unparsable date(s)`);
      out.push(`   ${bits.join(' · ')}`);
      if (feed.description) out.push(`   ${feed.description}`);
      if (feed.sampleTitles.length) out.push(`   recent: ${feed.sampleTitles.map((t) => `"${t}"`).join(', ')}`);
      out.push('');
    });
    out.push('Read one with `feed_read`, or several at once with `feed_timeline`.');
  }

  // Which paths were tried matters: it is the difference between "no feed" and
  // "we did not look".
  const failures = result.tried.filter((t) => !t.ok);
  if (failures.length) {
    out.push(`\n## Candidates that were not feeds (${failures.length})\n`);
    for (const t of failures) {
      out.push(`- ${t.url} — ${t.reason ?? 'no reason given'} [${t.source}]`);
    }
  }

  return out.join('\n');
}

// ------------------------------------------------------------------- read

function formatRead(result: FeedReadResult, includeContent: boolean): string {
  const out: string[] = [];

  if (!result.ok) {
    return `FAILED ${result.url}\n${result.reason ?? 'could not read the feed'}\n\nIf you are not sure this URL is a feed, run \`feed_discover\` on the site first.`;
  }

  const feed = result.feed;
  out.push(`# ${feed?.title ?? '(untitled feed)'}`);
  const header = [
    feed?.format.toUpperCase() ?? '?',
    `${result.items.length}/${result.totalItems} items`,
    `${result.elapsedMs}ms`,
  ];
  if (result.filteredOut) header.push(`since-filter dropped ${result.filteredOut}`);
  if (result.undatedSkipped) header.push(`${result.undatedSkipped} skipped: no usable date`);
  if (feed?.duplicatesDropped) header.push(`${feed.duplicatesDropped} duplicate(s) merged`);
  if (feed?.unparsableDates) header.push(`${feed.unparsableDates} unparsable date(s)`);
  if (result.fullTextFailures) header.push(`${result.fullTextFailures} full-text fetch failure(s)`);
  if (result.truncated) header.push(`truncated:${human(result.truncatedChars)}`);
  out.push(`<${result.url}> · ${header.join(' · ')}`);
  if (feed?.siteUrl) out.push(`site: ${feed.siteUrl}`);
  if (feed?.description) out.push(`> ${feed.description}`);

  if (result.undatedSkipped) {
    out.push(
      `\n⚠ ${result.undatedSkipped} item(s) were left out of the \`since\` filter because their date could not be parsed. Drop \`since\` to see them.`,
    );
  }
  if (result.truncated) {
    out.push(`\n⚠ Item bodies were cut short by the character budget (${human(result.truncatedChars)} chars dropped). Raise \`maxChars\` for more.`);
  }
  if (includeContent && !result.items.some((i) => i.fullText)) {
    out.push('\n_Bodies below are the feed\'s own text, not necessarily the full article. Pass `fullText: true` to fetch the real pages._');
  }

  if (!result.items.length) {
    out.push('\nNo items matched. Try removing `since` or raising `limit`.');
    return out.join('\n');
  }

  out.push('');
  result.items.forEach((item, i) => out.push(...itemBlock(item, i + 1, includeContent)));

  return out.join('\n').trimEnd();
}

// --------------------------------------------------------------- timeline

function formatTimeline(result: TimelineResult, includeContent: boolean): string {
  const out: string[] = [];
  const ok = result.feeds.filter((f) => f.ok);

  out.push(`# Timeline across ${result.feeds.length} feed(s)`);
  const header = [
    `${ok.length} readable`,
    `${result.items.length}/${result.totalItems} items`,
    `${result.elapsedMs}ms`,
  ];
  if (result.undatedSkipped) header.push(`${result.undatedSkipped} skipped: no usable date`);
  if (result.fullTextFailures) header.push(`${result.fullTextFailures} full-text failure(s)`);
  if (result.truncated) header.push(`truncated:${human(result.truncatedChars)}`);
  out.push(header.join(' · '));

  if (result.undatedIncluded) {
    out.push(
      `\n⚠ ${result.undatedIncluded} item(s) in this list carry no parsable date, so they sort last rather than by time.`,
    );
  }

  if (result.items.length) {
    out.push('');
    result.items.forEach((item, i) => out.push(...itemBlock(item, i + 1, includeContent)));
  } else {
    out.push('\nNo items. Either the feeds are empty or every one of them failed — see the status list.');
  }

  out.push(`## Feeds\n`);
  for (const feed of result.feeds) {
    out.push(
      feed.ok
        ? `- ✓ ${feed.title ?? '(untitled)'} — ${feed.format?.toUpperCase() ?? '?'} · ${feed.items} item(s) · ${feed.url}`
        : `- ✗ ${feed.url} — ${feed.reason ?? 'failed'}`,
    );
  }

  return out.join('\n').trimEnd();
}

// ------------------------------------------------------------- registration

export function registerFeedTools(server: McpServer): void {
  server.registerTool(
    'feed_discover',
    {
      title: 'Find a site’s feeds',
      description:
        'Find the RSS, Atom or JSON feeds a page or site publishes. Reads the HTML head’s ' +
        '`<link rel="alternate">` declarations, then feed-looking anchors, then the conventional paths ' +
        '(/feed, /rss.xml, /atom.xml, /index.xml, /feed.json, ...). Every candidate is fetched and actually ' +
        'parsed before it is reported, so a URL that merely looks like a feed is not claimed as one. ' +
        'A feed beats crawling for "what is new on this site": one request returns titles, dates, authors and often full bodies.',
      inputSchema: {
        url: z.string().describe('Any page on the site, or the site root. A feed URL itself also works.'),
        tryGuesses: z
          .boolean()
          .optional()
          .describe('Also probe the conventional feed paths. Default true. Set false to only trust what the page declares.'),
        limit: z.number().optional().describe('Stop after this many verified feeds. Default 10.'),
        timeout: z.number().optional().describe('Per-request timeout in ms. Default 15000.'),
      },
    },
    async (args) => {
      const result = await discoverFeeds(String(args.url), {
        tryGuesses: args.tryGuesses as boolean | undefined,
        limit: args.limit as number | undefined,
        timeout: args.timeout as number | undefined,
      });
      return textResult(formatDiscovery(result), result.feeds.length === 0 && Boolean(result.pageError));
    },
  );

  server.registerTool(
    'feed_read',
    {
      title: 'Read a feed',
      description:
        'Read one RSS 2.0, Atom 1.0 or JSON Feed 1.1 URL and return its recent items: title, date, link, author, ' +
        'categories and a short teaser. Dates are parsed from RFC 822 (RSS) and ISO 8601 (Atom/JSON Feed); a date ' +
        'that cannot be parsed is reported as unparsed rather than guessed, so `since` queries stay trustworthy. ' +
        'Set `includeContent` for the feed’s own bodies (WordPress `content:encoded` included), or `fullText` to ' +
        'scrape each item’s page concurrently when the feed only carries a teaser.',
      inputSchema: {
        url: z.string().describe('The feed URL. Use `feed_discover` first if you only have a site.'),
        limit: z.number().optional().describe('Items to return, newest first. Default 20.'),
        since: z
          .string()
          .optional()
          .describe(
            'Only items at or after this ISO 8601 instant (e.g. "2026-10-01" or "2026-10-01T00:00:00Z"). ' +
              'Items whose own date could not be parsed are excluded and counted, never assumed to be new.',
          ),
        includeContent: z
          .boolean()
          .optional()
          .describe('Include the feed’s own body text for each item. Default false — teasers only, to save tokens.'),
        fullText: z
          .boolean()
          .optional()
          .describe(
            'Fetch each item’s page and return the real article instead of the feed’s teaser. Concurrent, and labelled as scraped.',
          ),
        maxChars: z.number().optional().describe('Total character budget across all item bodies. Default 20000; overflow is reported.'),
        perItemChars: z.number().optional().describe('Characters of body kept per item. Default 4000.'),
        concurrency: z.number().optional().describe('Concurrent article fetches when fullText is on. Default 5.'),
        maxAge: z.number().optional().describe('Serve fullText fetches from the local cache when younger than this many ms.'),
        timeout: z.number().optional().describe('Per-request timeout in ms.'),
      },
    },
    async (args) => {
      const includeContent = Boolean(args.includeContent) || Boolean(args.fullText);
      const result = await readFeed(String(args.url), {
        limit: args.limit as number | undefined,
        since: args.since as string | undefined,
        includeContent,
        fullText: args.fullText as boolean | undefined,
        maxChars: args.maxChars as number | undefined,
        perItemChars: args.perItemChars as number | undefined,
        concurrency: args.concurrency as number | undefined,
        maxAge: args.maxAge as number | undefined,
        timeout: args.timeout as number | undefined,
      });
      return textResult(formatRead(result, includeContent), !result.ok);
    },
  );

  server.registerTool(
    'feed_timeline',
    {
      title: 'Merge several feeds',
      description:
        'Read many feeds at once and merge them into a single date-sorted timeline — a news firehose over a set of ' +
        'sites. Takes a list of feed URLs, an OPML subscription list (a URL or inline OPML XML), or both. Each feed’s ' +
        'status is reported, so a feed that failed never reads as "nothing was published", and undated items sort last ' +
        'rather than being stamped with the current time.',
      inputSchema: {
        feeds: z.array(z.string()).optional().describe('Feed URLs to merge.'),
        opml: z
          .string()
          .optional()
          .describe('An OPML subscription list: either a URL to one, or the OPML XML itself. Its feeds are added to `feeds`.'),
        limit: z.number().optional().describe('Items in the merged timeline. Default 30.'),
        since: z.string().optional().describe('Only items at or after this ISO 8601 instant.'),
        perFeedLimit: z.number().optional().describe('Items taken from each feed before merging. Default 50.'),
        includeContent: z.boolean().optional().describe('Include item bodies. Default false.'),
        fullText: z.boolean().optional().describe('Scrape each merged item’s page for the real article.'),
        maxChars: z.number().optional().describe('Total character budget across all item bodies. Default 20000.'),
        perItemChars: z.number().optional().describe('Characters of body kept per item. Default 1200.'),
        feedConcurrency: z.number().optional().describe('Feeds fetched at once. Default 6.'),
        concurrency: z.number().optional().describe('Concurrent article fetches when fullText is on. Default 5.'),
        timeout: z.number().optional().describe('Per-request timeout in ms.'),
      },
    },
    async (args) => {
      const urls = [...((args.feeds as string[] | undefined) ?? [])];
      const notes: string[] = [];

      if (args.opml) {
        const opml = await loadOpml(String(args.opml), args.timeout as number | undefined);
        for (const feed of opml.feeds) urls.push(feed.url);
        notes.push(
          `OPML ${opml.title ? `"${opml.title}" ` : ''}(${opml.source}): ${opml.feeds.length} feed(s)` +
            (opml.skipped ? `, ${opml.skipped} outline(s) without a feed URL` : ''),
        );
        if (opml.feeds.length === 0) {
          notes.push('⚠ No feed URLs in that OPML — check it has `outline` elements with an `xmlUrl` attribute.');
        }
      }

      if (urls.length === 0) {
        return textResult(
          'No feeds to read. Pass `feeds` with feed URLs, an `opml` list, or run `feed_discover` on a site first.' +
            (notes.length ? `\n\n${notes.join('\n')}` : ''),
          true,
        );
      }

      const includeContent = Boolean(args.includeContent) || Boolean(args.fullText);
      const result = await readTimeline(urls, {
        limit: args.limit as number | undefined,
        since: args.since as string | undefined,
        includeContent,
        perFeedLimit: args.perFeedLimit as number | undefined,
        fullText: args.fullText as boolean | undefined,
        maxChars: args.maxChars as number | undefined,
        perItemChars: args.perItemChars as number | undefined,
        feedConcurrency: args.feedConcurrency as number | undefined,
        concurrency: args.concurrency as number | undefined,
        timeout: args.timeout as number | undefined,
      });

      const body = formatTimeline(result, includeContent);
      const text = notes.length ? `${notes.join('\n')}\n\n${body}` : body;
      return textResult(text, result.feeds.every((f) => !f.ok));
    },
  );
}
