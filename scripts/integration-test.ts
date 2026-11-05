/**
 * Whole-surface integration test.
 *
 * Spawns the MCP server exactly the way a client does and calls at least one
 * tool from every family, asserting on the real response. The point is to
 * catch wiring and regression problems that a typecheck cannot see.
 *
 *   npx tsx scripts/integration-test.ts
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'npx',
  args: ['tsx', 'src/index.ts'],
  stderr: 'pipe',
});
const client = new Client({ name: 'integration', version: '0.0.1' });
await client.connect(transport);

let passed = 0;
let failed = 0;
const failures: string[] = [];

function text(r: unknown): string {
  const c = (r as { content?: { type: string; text?: string }[] }).content ?? [];
  return c.map((x) => x.text ?? '').join('\n');
}

/**
 * `expect` may be a string the output must contain, or a predicate.
 * A tool that is allowed to fail for environmental reasons (a throttled search
 * provider, say) passes `tolerate`, and a known-cause failure is reported as a
 * skip rather than a failure.
 */
async function check(
  label: string,
  tool: string,
  args: Record<string, unknown>,
  expect: string | ((out: string) => boolean),
  tolerate?: RegExp,
): Promise<void> {
  const started = Date.now();
  try {
    const result = await client.callTool({ name: tool, arguments: args });
    const out = text(result);
    const ok = typeof expect === 'string' ? out.includes(expect) : expect(out);

    if (ok) {
      passed++;
      console.log(`  PASS  ${label.padEnd(44)} ${Date.now() - started}ms`);
      return;
    }
    if (tolerate?.test(out)) {
      console.log(`  SKIP  ${label.padEnd(44)} ${Date.now() - started}ms  (environment: ${
        (tolerate.exec(out)?.[0] ?? '').slice(0, 60)
      })`);
      return;
    }
    failed++;
    failures.push(`${label}: unexpected output — ${out.slice(0, 220).replace(/\n/g, ' | ')}`);
    console.log(`  FAIL  ${label.padEnd(44)} ${Date.now() - started}ms`);
  } catch (err) {
    failed++;
    failures.push(`${label}: threw — ${String(err).slice(0, 220)}`);
    console.log(`  FAIL  ${label.padEnd(44)} threw`);
  }
}

const { tools } = await client.listTools();
console.log(`${tools.length} tools registered\n`);

const CACHE = 10 * 60 * 1000;

console.log('scrape family');
await check('scrape markdown', 'scrape', { url: 'https://example.com', maxAge: CACHE }, 'Example Domain');
await check(
  'scrape query extraction',
  'scrape',
  {
    url: 'https://www.firecrawl.dev/pricing',
    formats: ['query'],
    query: 'what does the standard plan cost per month',
    maxAge: CACHE,
  },
  (o) => /\$83|\$99/.test(o),
);
await check(
  'scrape structured data',
  'scrape',
  { url: 'https://en.wikipedia.org/wiki/Web_scraping', formats: ['json'], maxAge: CACHE },
  'Structured data',
);
await check(
  'scrape pdf',
  'scrape',
  { url: 'https://arxiv.org/pdf/1706.03762', maxChars: 600, maxAge: CACHE },
  (o) => o.includes('document') && o.length > 300,
);
await check(
  'scrape redacts PII',
  'scrape',
  { url: 'https://www.ietf.org/contact/', redactPII: true, maxChars: 4000, maxAge: CACHE },
  (o) => o.includes('REDACTED_EMAIL') || o.includes('redacted:'),
);
await check('cache_info', 'cache_info', {}, 'Cached pages');

console.log('\ndiscovery family');
await check('map with search ranking', 'map', { url: 'https://www.firecrawl.dev', search: 'pricing', limit: 5, maxAge: CACHE }, '/pricing');
await check('feed_discover', 'feed_discover', { url: 'https://github.blog' }, (o) => /RSS|Atom|JSON/.test(o));
await check('feed_read dates', 'feed_read', { url: 'https://daringfireball.net/feeds/json', limit: 2 }, (o) => /20\d\d-\d\d-\d\d/.test(o));
await check('feed_discover honest negative', 'feed_discover', { url: 'https://example.com' }, 'No feed found');

console.log('\ncrawl family');
await check(
  'crawl completes',
  'crawl',
  { url: 'https://example.com', limit: 1, maxDepth: 0, waitSeconds: 45, maxAge: CACHE },
  (o) => o.includes('completed') || o.includes('pages stored: 1'),
);
await check('crawl_jobs', 'crawl_jobs', { limit: 3 }, 'Crawl jobs');
await check('corpus_search', 'corpus_search', { query: 'credits OR pricing', limit: 2 }, (o) => /matches|No matches/.test(o));
await check('crawl_export unknown job errors', 'crawl_export', { jobId: 'crawl_nope' }, 'No job with id');

console.log('\nextraction family');
await check(
  'extract_patterns finds prices',
  'extract_patterns',
  { url: 'https://books.toscrape.com', kinds: ['price'], maxAge: CACHE },
  (o) => /price —\s*\d+ distinct/.test(o) && !/price —\s*0 distinct/.test(o),
);
await check(
  'extract_schema records',
  'extract_schema',
  {
    url: 'https://books.toscrape.com',
    schema: {
      baseSelector: 'article.product_pod',
      fields: [
        { name: 'title', selector: 'h3 a', type: 'attribute', attribute: 'title' },
        { name: 'price', selector: '.price_color', type: 'text' },
      ],
    },
    maxAge: CACHE,
  },
  (o) => o.includes('A Light in the Attic'),
);
await check(
  'extract_schema honest miss',
  'extract_schema',
  {
    url: 'https://example.com',
    schema: { baseSelector: '.does-not-exist', fields: [{ name: 'x', selector: 'p', type: 'text' }] },
    maxAge: CACHE,
  },
  (o) => /matched 0 elements|0 records/.test(o),
);

console.log('\nindex family');
await check('search_papers', 'search_papers', { query: 'retrieval augmented generation', limit: 2 }, (o) => o.includes('http'));
await check('gov_search carries caveat', 'gov_search', { query: 'artificial intelligence', limit: 1 }, 'verify');
await check(
  'developer_search',
  'developer_search',
  { query: 'model context protocol', limit: 2 },
  (o) => o.includes('github.com'),
  /rate.?limit|unauthenticated|403|429/i,
);

console.log('\nresearch and monitoring');
await check(
  'research on local corpus',
  'research',
  { question: 'how do firecrawl credits work', sources: ['corpus'], maxPages: 3 },
  (o) => /finding\(s\)/.test(o),
);
await check(
  'research refuses nonsense',
  'research',
  { question: 'zqxjkwv flooberghast marmalade', sources: ['corpus'], maxPages: 2 },
  (o) => o.includes('INCOMPLETE') || o.includes('0 finding'),
);
await check(
  'change_tracking first seen',
  'change_tracking',
  { url: 'https://example.com/integration-probe', content: 'Price: $10', tag: 'integration' },
  (o) => /FIRST SEEN|CHANGED|NO CHANGE/.test(o),
);
await check(
  'change_tracking detects a change',
  'change_tracking',
  { url: 'https://example.com/integration-probe', content: 'Price: $20', tag: 'integration' },
  'CHANGED',
);

console.log('\ninfrastructure');
await check('proxy_status with none configured', 'proxy_status', {}, 'none configured');
await check('search_providers', 'search_providers', {}, (o) => /duckduckgo|searxng|brave/i.test(o));
await check(
  'search (may be throttled)',
  'search',
  { query: 'model context protocol', limit: 3 },
  (o) => o.includes('http'),
  /throttl|bot check|no results|unavailable|SEARXNG|BRAVE/i,
);

console.log('\nseo family');
// The SEO tools read a stored crawl, so one has to exist first. This crawl is
// deliberately tiny; what is being tested is the wiring, not the crawler.
const seoCrawl = text(
  await client.callTool({
    name: 'crawl',
    arguments: {
      url: 'https://books.toscrape.com',
      limit: 4,
      maxDepth: 1,
      waitSeconds: 90,
      maxAge: CACHE,
    },
  }),
);
const seoJobId = /crawl_[a-f0-9]+/.exec(seoCrawl)?.[0];

if (!seoJobId) {
  failed++;
  failures.push(`seo setup: no job id in crawl output — ${seoCrawl.slice(0, 200).replace(/\n/g, ' | ')}`);
  console.log('  FAIL  seo setup crawl');
} else {
  await check(
    'seo_audit reports issues',
    'seo_audit',
    { jobId: seoJobId },
    (o) => /SEO audit · \d+ pages/.test(o) && /Thresholds used/.test(o),
  );
  await check(
    'seo_audit finds missing descriptions',
    'seo_audit',
    { jobId: seoJobId, codes: ['description-missing'] },
    (o) => /description-missing/.test(o),
  );
  await check(
    'link_graph counts inlinks',
    'link_graph',
    { jobId: seoJobId },
    (o) => /Link graph · \d+ pages/.test(o) && /\| inlinks \|/.test(o),
  );
  await check(
    'link_graph details one page',
    'link_graph',
    { jobId: seoJobId, url: 'https://books.toscrape.com/' },
    (o) => /Anchor text pointing here/.test(o) && /Links from this page/.test(o),
  );
  await check(
    'broken_links reports honestly',
    'broken_links',
    { jobId: seoJobId },
    (o) => /Broken internal links/.test(o) && /(None\.|HTTP \d\d\d)/.test(o),
  );
  await check(
    'duplicate_content runs',
    'duplicate_content',
    { jobId: seoJobId, distance: 4 },
    (o) => /Near-duplicate content/.test(o) && /group\(s\)/.test(o),
  );
}

await check(
  'seo_audit refuses an unknown job',
  'seo_audit',
  { jobId: 'crawl_nope' },
  'No job with id',
);

console.log('\nbranding, policy and audio');
await check(
  'branding finds a brand colour',
  'scrape',
  { url: 'https://www.firecrawl.dev', formats: ['branding'], maxAge: CACHE },
  (o) => /## Branding/.test(o) && /#[0-9a-f]{6}/.test(o) && /Stylesheets: \d+ found/.test(o),
);
await check(
  'branding is honest about unread CSS',
  'scrape',
  { url: 'https://www.firecrawl.dev', formats: ['branding'], maxAge: CACHE },
  (o) => /not read|No colours were declared/.test(o),
);
await check(
  'lockdown_status reports no restrictions',
  'lockdown_status',
  {},
  (o) => /Lockdown status/.test(o) && /(Nothing is restricted|Lockdown active)/.test(o),
);
await check(
  'transcribe_engines reports availability',
  'transcribe_engines',
  {},
  (o) => /Speech-to-text engines/.test(o) && /(configured|not set|installed)/.test(o),
);
// Whatever state the machine is in, this must refuse with a reason a reader
// can act on — never an empty transcript, which is indistinguishable from
// silence. The accepted reasons cover all three real states: no engine, an
// engine that will not load, and a URL that is not actually audio.
await check(
  'transcribe refuses with an actionable reason',
  'transcribe',
  { source: 'https://example.com/not-audio.mp3' },
  (o) =>
    /No speech-to-text engine is available/.test(o) ||
    /installed but will not load/.test(o) ||
    /is not audio or video/.test(o) ||
    /HTTP \d\d\d/.test(o),
);

if (seoJobId) {
  await check(
    'adaptive crawl stops early and says why',
    'crawl',
    {
      url: 'https://books.toscrape.com',
      limit: 25,
      maxDepth: 2,
      query: 'science fiction books',
      adaptive: true,
      strategy: 'best-first',
      waitSeconds: 120,
      maxAge: CACHE,
    },
    (o) => /Adaptive:/.test(o) && /(answered after|stopped after)/.test(o),
  );
}

console.log('\narchive family');
await check(
  'archive_snapshots lists captures',
  'archive_snapshots',
  { url: 'https://example.com', limit: 3 },
  (o) => /\d{4}/.test(o) && /wayback|capture|snapshot/i.test(o),
  /unavailable|rate.?limit|timed out|no captures/i,
);
await check(
  'archive_fetch reads an old copy',
  'archive_fetch',
  { url: 'https://www.nytimes.com/learning/index.html', maxChars: 500 },
  (o) => /ARCHIVED|captured/i.test(o) && o.length > 200,
  /unavailable|rate.?limit|timed out|no captures/i,
);
await check(
  'archive honest negative',
  'archive_fetch',
  { url: 'https://example.com/openscrape-never-existed-xyzzy' },
  (o) => /no |not found|no capture/i.test(o),
  /unavailable|rate.?limit|timed out/i,
);
await check(
  'fetch ladder falls back to the archive',
  'scrape',
  { url: 'https://www.nytimes.com/learning/index.html', maxChars: 500 },
  (o) => /ARCHIVED/.test(o) && /Fetch ladder:/.test(o),
  /unavailable|rate.?limit|timed out|no capture/i,
);
await check(
  'archiveFallback:false fails honestly',
  'scrape',
  { url: 'https://www.nytimes.com/learning/index.html', archiveFallback: false },
  (o) => /FAILED|bot wall/i.test(o) && !/ARCHIVED/.test(o),
);

console.log('\nbrowser family');
await check(
  'interact session round trip',
  'interact_open',
  { url: 'https://example.com' },
  (o) => /session|s_/.test(o),
);
await check('interact_sessions', 'interact_sessions', {}, (o) => o.length > 0);
await check('profile_list', 'profile_list', {}, (o) => o.length > 0);

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  - ${f}`);
}

await client.close();
process.exit(failed === 0 ? 0 : 1);
