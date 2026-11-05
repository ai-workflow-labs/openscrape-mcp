import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({ command: 'npx', args: ['tsx', 'src/index.ts'], stderr: 'pipe' });
const client = new Client({ name: 'verify', version: '0.0.1' });
await client.connect(transport);

function text(r: unknown): string {
  const c = (r as { content?: { type: string; text?: string }[] }).content ?? [];
  return c.find((x) => x.type === 'text')?.text ?? '(no text)';
}

async function call(name: string, args: Record<string, unknown>, chars = 420) {
  process.stdout.write(`\n##### ${name} #####\n`);
  try {
    const out = text(await client.callTool({ name, arguments: args }));
    process.stdout.write(out.slice(0, chars).replace(/\n{3,}/g, '\n\n') + '\n');
  } catch (err) {
    process.stdout.write(`THREW: ${String(err).slice(0, 200)}\n`);
  }
}

await call('search_papers', { query: 'retrieval augmented generation', limit: 3 });
await call('gov_search', { query: 'artificial intelligence', limit: 2 }, 600);
await call('developer_search', { query: 'model context protocol server', limit: 2 });
await call('read_paper', { id: '2408.06717', fullText: false }, 350);

const created = text(await client.callTool({
  name: 'monitor_create',
  arguments: { url: 'https://example.com', intervalMs: 3600000, checkNow: true },
}));
process.stdout.write(`\n##### monitor_create #####\n${created.slice(0, 350)}\n`);
const monId = /mon_[a-f0-9]+/.exec(created)?.[0];

if (monId) {
  await call('monitor_run', { id: monId }, 350);
  await call('monitor_get', { id: monId }, 350);
  await call('monitor_delete', { id: monId }, 200);
}

await call('change_tracking', {
  url: 'https://example.com/fake-product',
  content: 'Acme Pro\nPrice: $99\nIn stock',
  tag: 'verify-run',
}, 300);
await call('change_tracking', {
  url: 'https://example.com/fake-product',
  content: 'Acme Pro\nPrice: $79\nIn stock\nNew: annual plan',
  tag: 'verify-run',
}, 400);

await client.close();
