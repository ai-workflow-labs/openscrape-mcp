import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({ command: 'npx', args: ['tsx', 'src/index.ts'], stderr: 'pipe' });
const client = new Client({ name: 'proxy-check', version: '0.0.1' });
await client.connect(transport);
function text(r: unknown): string {
  const c = (r as { content?: { type: string; text?: string }[] }).content ?? [];
  return c.find((x) => x.type === 'text')?.text ?? '';
}
console.log('--- proxy_status (none configured) ---');
console.log(text(await client.callTool({ name: 'proxy_status', arguments: {} })).slice(0, 400));
console.log('\n--- extract_patterns on a real page ---');
console.log(text(await client.callTool({
  name: 'extract_patterns',
  arguments: { url: 'https://books.toscrape.com', kinds: ['price'], maxAge: 600000 },
})).slice(0, 400));
await client.close();
