import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({ command: 'npx', args: ['tsx', 'src/index.ts'], stderr: 'pipe' });
const client = new Client({ name: 'research-check', version: '0.0.1' });
await client.connect(transport);

function text(r: unknown): string {
  const c = (r as { content?: { type: string; text?: string }[] }).content ?? [];
  return c.find((x) => x.type === 'text')?.text ?? '';
}

// Corpus-only: no network at all, proves the local-crawl integration.
console.log('### research on the local corpus (no web) ###');
const local = await client.callTool({
  name: 'research',
  arguments: { question: 'how do firecrawl credits work for failed requests', sources: ['corpus'], maxPages: 4 },
});
console.log(text(local).slice(0, 900));

console.log('\n\n### research on a question nothing can answer ###');
const nonsense = await client.callTool({
  name: 'research',
  arguments: { question: 'zqxjkwv flooberghast quantum marmalade protocol', sources: ['corpus'], maxPages: 2 },
});
console.log(text(nonsense).slice(0, 600));
console.log(`isError: ${(nonsense as { isError?: boolean }).isError}`);

await client.close();
