/**
 * Live check for feed discovery and parsing.
 *
 *   npx tsx scripts/try-feeds.ts              # the whole suite
 *   npx tsx scripts/try-feeds.ts <page-url>   # discover + read one site
 *
 * The suite hits real sites on purpose: the only way to know a feed parser
 * works is to point it at the mess people actually publish.
 */
import {
  discoverFeeds,
  fetchFeed,
  parseFeedDate,
  parseOpml,
  readFeed,
  readTimeline,
  type FeedItem,
} from '../src/core/discover/feeds.js';

function head(title: string): void {
  console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`);
}

function showItem(item: FeedItem, i: number): void {
  const date = item.published?.iso
    ? item.published.iso
    : item.published
      ? `UNPARSED "${item.published.raw}"`
      : item.updated?.iso
        ? `${item.updated.iso} (updated)`
        : 'no date';
  console.log(`  ${i + 1}. ${item.title ?? '(untitled)'}`);
  console.log(`     date:   ${date}${item.published?.via ? `  [${item.published.via}]` : ''}`);
  if (item.published?.iso) console.log(`     raw:    "${item.published.raw}"`);
  console.log(`     url:    ${item.url ?? '(none)'}`);
  if (item.author) console.log(`     author: ${item.author}`);
  if (item.categories.length) console.log(`     tags:   ${item.categories.slice(0, 5).join(', ')}`);
  if (item.contentSource) {
    console.log(`     body:   ${item.contentSource}, ${item.content?.length ?? 0} chars of markdown`);
  }
  if (item.summary) console.log(`     teaser: ${item.summary.slice(0, 110)}`);
}

async function readOne(label: string, url: string, expect: string): Promise<boolean> {
  head(`${label}\n${url}\nexpecting format: ${expect}`);
  const result = await readFeed(url, { limit: 4, perItemChars: 300, maxChars: 1200 });

  if (!result.ok || !result.feed) {
    console.log(`FAILED: ${result.reason}`);
    return false;
  }

  const feed = result.feed;
  console.log(`feed:      ${feed.title ?? '(untitled)'}`);
  console.log(`format:    ${feed.format}${feed.format === expect ? '  ✓' : `  ✗ expected ${expect}`}`);
  console.log(`site:      ${feed.siteUrl ?? '(none)'}`);
  console.log(`items:     ${result.totalItems} in feed, showing ${result.items.length}`);
  console.log(`dupes:     ${feed.duplicatesDropped} dropped`);
  console.log(`bad dates: ${feed.unparsableDates}`);
  console.log(`truncated: ${result.truncated ? `${result.truncatedChars} chars` : 'no'}`);
  console.log(`elapsed:   ${result.elapsedMs}ms`);
  console.log();
  result.items.forEach(showItem);

  const parsedDates = result.items.filter((i) => i.published?.iso || i.updated?.iso).length;
  const titled = result.items.filter((i) => i.title).length;
  const verdict = feed.format === expect && parsedDates === result.items.length && titled === result.items.length;
  console.log(
    `\nverdict:   ${verdict ? 'OK' : 'PROBLEM'} — ${titled}/${result.items.length} titles, ${parsedDates}/${result.items.length} dates parsed`,
  );
  return verdict;
}

// ------------------------------------------------------------------- date unit checks

function dateChecks(): boolean {
  head('Date parsing (the non-negotiable: correct or none)');
  const cases: [string, string | null][] = [
    ['Tue, 04 Nov 2025 09:30:00 +0000', '2025-11-04T09:30:00.000Z'],
    ['Mon, 3 Nov 2025 14:05:00 GMT', '2025-11-03T14:05:00.000Z'],
    ['Fri, 31 Oct 2025 10:00:00 -0400', '2025-10-31T14:00:00.000Z'],
    ['Wed, 29 Oct 2025 08:00:00 EST', '2025-10-29T13:00:00.000Z'],
    ['2025-11-04T09:30:00Z', '2025-11-04T09:30:00.000Z'],
    ['2025-11-04T09:30:00+02:00', '2025-11-04T07:30:00.000Z'],
    ['2025-11-04T09:30:00.123-05:00', '2025-11-04T14:30:00.123Z'],
    ['2025-11-04', '2025-11-04T00:00:00.000Z'],
    ['04 Nov 25 09:30 +0000', '2025-11-04T09:30:00.000Z'],
    // Rubbish must come back unparsed, not as "now".
    ['', null],
    ['last Tuesday', null],
    ['Tue, 32 Nov 2025 09:30:00 +0000', null],
    ['0000-00-00T00:00:00Z', null],
    ['1970-01-01T00:00:00Z', null],
  ];

  let pass = 0;
  for (const [raw, want] of cases) {
    const got = parseFeedDate(raw);
    const iso = got?.iso ?? null;
    const ok = iso === want;
    if (ok) pass++;
    console.log(
      `  ${ok ? '✓' : '✗'} ${JSON.stringify(raw).padEnd(34)} -> ${iso ?? '(unparsed)'}${ok ? '' : `   want ${want ?? '(unparsed)'}`}`,
    );
    if (got && !got.iso && raw) {
      // The original must survive even when parsing fails.
      if (got.raw !== raw.trim()) console.log(`     ✗ raw string lost: "${got.raw}"`);
    }
  }
  console.log(`\n  ${pass}/${cases.length} date cases pass`);
  return pass === cases.length;
}

// ------------------------------------------------------------------- main

const target = process.argv[2];

if (target) {
  head(`Discovering feeds on ${target}`);
  const disc = await discoverFeeds(target);
  console.log(`candidates: ${disc.tried.length}, feeds: ${disc.feeds.length}, ${disc.elapsedMs}ms`);
  for (const feed of disc.feeds) {
    console.log(`  [${feed.source}] ${feed.format} ${feed.url} — ${feed.title ?? ''} (${feed.itemCount} items)`);
  }
  for (const t of disc.tried.filter((x) => !x.ok)) console.log(`  ✗ ${t.url} — ${t.reason}`);
  if (disc.feeds[0]) await readOne('Reading the first feed found', disc.feeds[0].url, disc.feeds[0].format);
  process.exit(0);
}

const results: [string, boolean][] = [];

results.push(['date parsing', dateChecks()]);

// 1. RSS 2.0 from WordPress — the content:encoded case.
results.push([
  'RSS 2.0 (WordPress, content:encoded)',
  await readOne('RSS 2.0 — WordPress', 'https://wordpress.org/news/feed/', 'rss'),
]);

// 2. Atom 1.0 — link rel=alternate plus content vs summary.
results.push(['Atom 1.0', await readOne('Atom 1.0', 'https://github.blog/feed/atom/', 'atom')]);

// 3. JSON Feed 1.1.
results.push(['JSON Feed 1.1', await readOne('JSON Feed 1.1', 'https://daringfireball.net/feeds/json', 'json')]);

// 4. Discovery from a page, not a feed URL.
head('Discovery from an ordinary page (declared <link rel="alternate">)');
{
  const disc = await discoverFeeds('https://wordpress.org/news/');
  console.log(`page:       ${disc.finalUrl ?? disc.pageUrl}`);
  console.log(`candidates: ${disc.tried.length} checked in ${disc.elapsedMs}ms`);
  for (const feed of disc.feeds) {
    console.log(`  ✓ [${feed.source}] ${feed.format.padEnd(5)} ${feed.url}`);
    console.log(`      "${feed.title ?? ''}" · ${feed.itemCount} items · newest ${feed.newestItem ?? 'n/a'}`);
  }
  for (const t of disc.tried.filter((x) => !x.ok)) console.log(`  ✗ ${t.url} — ${t.reason} [${t.source}]`);
  results.push(['discovery from page', disc.feeds.length > 0]);
}

// 5. The honest negative: a real site that publishes no feed.
head('Honest negative — a site with no feed');
{
  const disc = await discoverFeeds('https://example.com');
  console.log(`feeds found: ${disc.feeds.length}`);
  console.log(`tried ${disc.tried.length} candidate(s):`);
  for (const t of disc.tried) console.log(`  ${t.ok ? '✓' : '✗'} ${t.url} — ${t.reason ?? 'ok'} [${t.source}]`);
  results.push(['honest negative', disc.feeds.length === 0 && disc.tried.length > 0]);
}

// 6. since-filter.
head('since filter');
{
  const since = new Date(Date.now() - 45 * 24 * 3600 * 1000).toISOString();
  const res = await readFeed('https://wordpress.org/news/feed/', { limit: 50, since, perItemChars: 0 });
  console.log(`since ${since}`);
  console.log(`kept ${res.items.length}, dropped ${res.filteredOut} older, ${res.undatedSkipped} undated`);
  for (const item of res.items.slice(0, 5)) {
    console.log(`  ${item.published?.iso ?? '(no date)'}  ${item.title}`);
  }
  const monotonic = res.items.every(
    (item, i) =>
      i === 0 ||
      Date.parse(res.items[i - 1].published?.iso ?? '0') >= Date.parse(item.published?.iso ?? '0'),
  );
  console.log(`newest-first order: ${monotonic ? 'OK' : 'BROKEN'}`);
  results.push(['since filter', res.ok && monotonic && res.items.length + res.filteredOut > 0]);
}

// 7. fullText — the feed teaser vs the real article.
head('fullText — scraping each item for the real body');
{
  const res = await readFeed('https://daringfireball.net/feeds/json', {
    limit: 2,
    fullText: true,
    perItemChars: 1500,
    maxChars: 4000,
  });
  for (const item of res.items) {
    console.log(`  ${item.title}`);
    console.log(`    source=${item.contentSource} fullText=${item.fullText} chars=${item.content?.length ?? 0}`);
    if (item.fetchError) console.log(`    error=${item.fetchError}`);
  }
  console.log(`failures: ${res.fullTextFailures}, truncated: ${res.truncatedChars} chars`);
  results.push(['fullText', res.ok && res.items.some((i) => i.fullText)]);
}

// 8. OPML parsing.
head('OPML subscription list');
{
  const opml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>Test subscriptions</title></head>
  <body>
    <outline text="Tech">
      <outline type="rss" text="WordPress" title="WordPress News"
               xmlUrl="https://wordpress.org/news/feed/" htmlUrl="https://wordpress.org/news/"/>
      <outline type="rss" text="Daring Fireball" xmlUrl="https://daringfireball.net/feeds/json"/>
    </outline>
    <outline text="Not a feed, just a folder"/>
  </body>
</opml>`;
  const parsed = parseOpml(opml);
  console.log(`title:   ${parsed.title}`);
  console.log(`feeds:   ${parsed.feeds.length} (skipped ${parsed.skipped})`);
  for (const feed of parsed.feeds) {
    console.log(`  ${feed.category ?? '-'} / ${feed.title ?? '(untitled)'} -> ${feed.url}`);
  }
  results.push(['OPML parsing', parsed.feeds.length === 2 && parsed.title === 'Test subscriptions']);

  head('Merged timeline from that OPML');
  const timeline = await readTimeline(parsed.feeds.map((f) => f.url), { limit: 8, perItemChars: 0 });
  console.log(`${timeline.items.length}/${timeline.totalItems} items, ${timeline.elapsedMs}ms`);
  for (const item of timeline.items) {
    console.log(`  ${(item.published?.iso ?? 'undated').padEnd(26)} [${item.feedTitle ?? '?'}] ${item.title}`);
  }
  for (const feed of timeline.feeds) {
    console.log(`  ${feed.ok ? '✓' : '✗'} ${feed.title ?? feed.url} ${feed.ok ? `(${feed.format}, ${feed.items})` : `— ${feed.reason}`}`);
  }
  const mixed = new Set(timeline.items.map((i) => i.feedUrl)).size > 1;
  results.push(['merged timeline', timeline.items.length > 0 && mixed]);
}

// 9. A broken feed URL must fail loudly, not silently return nothing.
head('A URL that is not a feed');
{
  const res = await fetchFeed('https://example.com/definitely-not-a-feed.xml');
  console.log(`ok=${res.ok} status=${res.status ?? '-'} reason=${res.reason}`);
  results.push(['non-feed rejected', !res.ok]);
}

// 10. The MCP surface: the tools register, and their handlers format text.
head('MCP tools');
{
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { registerFeedTools } = await import('../src/mcp/tools/feeds.js');

  type Handler = {
    title?: string;
    handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;
  };

  const server = new McpServer({ name: 'try-feeds', version: '0' });
  registerFeedTools(server);
  const registered = (server as unknown as { _registeredTools: Record<string, Handler> })._registeredTools;
  const names = Object.keys(registered);
  console.log(`registered: ${names.join(', ')}`);

  const read = await registered['feed_read'].handler({ url: 'https://wordpress.org/news/feed/', limit: 2 }, {});
  console.log('\n--- feed_read ---');
  console.log(read.content[0].text.split('\n').slice(0, 14).join('\n'));

  const none = await registered['feed_discover'].handler({ url: 'https://example.com' }, {});
  console.log('\n--- feed_discover on a site with no feed ---');
  console.log(none.content[0].text.split('\n').slice(0, 6).join('\n'));

  const timeline = await registered['feed_timeline'].handler(
    { feeds: ['https://daringfireball.net/feeds/json', 'https://github.blog/feed/atom/'], limit: 3 },
    {},
  );
  console.log('\n--- feed_timeline ---');
  console.log(timeline.content[0].text);

  const expected = ['feed_discover', 'feed_read', 'feed_timeline'];
  results.push([
    'MCP tools register and answer',
    expected.every((n) => names.includes(n)) && !read.isError && !timeline.isError,
  ]);
}

head('Summary');
let failed = 0;
for (const [name, ok] of results) {
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
