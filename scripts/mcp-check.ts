/**
 * End-to-end MCP check: spawns the server over stdio exactly the way a client
 * does, lists the tools, then calls them.
 *
 *   npx tsx scripts/mcp-check.ts          # runs src/index.ts through tsx
 *   npx tsx scripts/mcp-check.ts dist     # runs the built dist/index.js
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const useDist = process.argv[2] === 'dist';

const transport = new StdioClientTransport(
  useDist
    ? { command: process.execPath, args: ['dist/index.js'], stderr: 'pipe' }
    : { command: 'npx', args: ['tsx', 'src/index.ts'], stderr: 'pipe' },
);

const client = new Client({ name: 'openscrape-check', version: '0.0.1' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`tools (${tools.length}):`);
for (const t of tools) {
  const props = Object.keys(
    (t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
  );
  console.log(`  ${t.name.padEnd(16)} ${String(props.length).padStart(2)} params — ${t.title ?? ''}`);
}

function firstText(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.find((c) => c.type === 'text')?.text ?? '';
}

async function call(name: string, args: Record<string, unknown>, show = 700): Promise<string> {
  const text = firstText(await client.callTool({ name, arguments: args }));
  console.log(`\n--- ${name} ---`);
  console.log(text.slice(0, show));
  return text;
}

await call('scrape', {
  url: 'https://www.firecrawl.dev/pricing',
  formats: ['query'],
  query: 'what does the standard plan cost per month',
  maxChars: 700,
  maxAge: 600_000,
});

await call('map', {
  url: 'https://www.firecrawl.dev',
  search: 'pricing and credits',
  limit: 6,
  maxAge: 600_000,
});

const crawlText = await call('crawl', {
  url: 'https://www.firecrawl.dev',
  limit: 4,
  maxDepth: 1,
  waitSeconds: 60,
  maxChars: 800,
  maxAge: 600_000,
});

const jobId = /\b(crawl_[a-f0-9]{16})\b/.exec(crawlText)?.[1];
if (jobId) {
  await call('crawl_status', { jobId, includeContent: true, limit: 2, maxCharsPerPage: 300 }, 900);
} else {
  console.log('\n(could not parse a job id out of the crawl output)');
}

await call('corpus_search', { query: '"pay as you go" OR credits', limit: 3 }, 600);
await call('crawl_jobs', { limit: 5 }, 500);
await call('cache_info', {}, 300);

await client.close();
