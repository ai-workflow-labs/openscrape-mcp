import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({ command: 'npx', args: ['tsx', 'src/index.ts'], stderr: 'pipe' });
const client = new Client({ name: 'list', version: '0.0.1' });
await client.connect(transport);
const { tools } = await client.listTools();
console.log(`${tools.length} tools:`);
for (const t of tools) console.log(`  ${t.name}`);
await client.close();
