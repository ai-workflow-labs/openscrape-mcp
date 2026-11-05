import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { statSync, readFileSync } from 'node:fs';

const transport = new StdioClientTransport({ command: 'npx', args: ['tsx', 'src/index.ts'], stderr: 'pipe' });
const client = new Client({ name: 'export-check', version: '0.0.1' });
await client.connect(transport);

function text(r: unknown): string {
  const c = (r as { content?: { type: string; text?: string }[] }).content ?? [];
  return c.find((x) => x.type === 'text')?.text ?? '';
}

const jobs = text(await client.callTool({ name: 'crawl_jobs', arguments: { limit: 10 } }));
const jobId = /\b(crawl_[a-f0-9]{16})\b/.exec(jobs)?.[1];
if (!jobId) {
  console.log('no crawl job found to export');
  process.exit(0);
}
console.log(`exporting ${jobId}`);

for (const format of ['jsonl', 'csv', 'markdown'] as const) {
  const out = text(await client.callTool({ name: 'crawl_export', arguments: { jobId, format } }));
  console.log(`\n--- ${format} ---`);
  console.log(out);
  const path = out.split('\n').find((l) => l.includes('.openscrape'))?.trim();
  if (path) {
    const size = statSync(path).size;
    const head = readFileSync(path, 'utf8').slice(0, 180).replace(/\n/g, ' | ');
    console.log(`  verified on disk: ${size} bytes`);
    console.log(`  head: ${head}`);
  }
}

console.log('\n--- unknown job (should error cleanly) ---');
console.log(text(await client.callTool({ name: 'crawl_export', arguments: { jobId: 'crawl_doesnotexist' } })));

await client.close();
