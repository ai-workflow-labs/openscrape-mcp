import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({ command: 'npx', args: ['tsx', 'src/index.ts'], stderr: 'pipe' });
const client = new Client({ name: 'feed-check', version: '0.0.1' });
await client.connect(transport);
function text(r: unknown): string {
  const c = (r as { content?: { type: string; text?: string }[] }).content ?? [];
  return c.find((x) => x.type === 'text')?.text ?? '';
}
console.log('--- feed_discover on a real blog ---');
console.log(text(await client.callTool({ name: 'feed_discover', arguments: { url: 'https://github.blog' } })).slice(0, 450));
console.log('\n--- feed_read (dates must be real) ---');
console.log(text(await client.callTool({ name: 'feed_read', arguments: { url: 'https://daringfireball.net/feeds/json', limit: 3 } })).slice(0, 550));
console.log('\n--- feed_discover on a site with no feed ---');
console.log(text(await client.callTool({ name: 'feed_discover', arguments: { url: 'https://example.com' } })).slice(0, 300));
await client.close();
