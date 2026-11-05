/**
 * Smoke-test the three specialised indexes against the live APIs.
 *
 *   npx tsx scripts/try-indexes.ts
 *   npx tsx scripts/try-indexes.ts papers "retrieval augmented generation"
 *   npx tsx scripts/try-indexes.ts read 2408.06717
 *   npx tsx scripts/try-indexes.ts tools
 *
 * Everything here must work with no API keys set at all. The script prints
 * which keys it found so a passing run with keys cannot be mistaken for a
 * passing run without them.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerIndexTools } from '../src/mcp/tools/indexes.js';
import { developerSearch } from '../src/core/indexes/developer.js';
import { govSearch } from '../src/core/indexes/gov.js';
import { readPaper, searchPapers } from '../src/core/indexes/papers.js';
import type { SourceStatus } from '../src/core/indexes/index.js';

const which = (process.argv[2] ?? 'all').toLowerCase();
const arg = process.argv[3];

function rule(title: string): void {
  console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`);
}

function sources(list: SourceStatus[]): void {
  console.log('\n  sources:');
  for (const s of list) {
    console.log(`    ${s.ok ? 'ok  ' : 'FAIL'} ${s.source.padEnd(22)} ${s.ok ? String(s.count).padStart(3) : '  -'}  ${s.note ?? ''}`);
  }
}

function keyReport(): void {
  const keys = {
    GITHUB_TOKEN: Boolean(process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN),
    GOVINFO_API_KEY: Boolean(process.env.GOVINFO_API_KEY),
    COURTLISTENER_TOKEN: Boolean(process.env.COURTLISTENER_TOKEN),
    NCBI_API_KEY: Boolean(process.env.NCBI_API_KEY),
    OPENALEX_API_KEY: Boolean(process.env.OPENALEX_API_KEY),
  };
  const set = Object.entries(keys).filter(([, v]) => v).map(([k]) => k);
  console.log(`keys present: ${set.length ? set.join(', ') : 'NONE (this is the zero-config path)'}`);
}

async function tryPapers(): Promise<void> {
  rule(`search_papers — "${arg ?? 'retrieval augmented generation'}"`);
  const result = await searchPapers(arg ?? 'retrieval augmented generation', {
    sources: ['arxiv', 'pubmed', 'crossref', 'openalex'],
    limit: 6,
  });
  console.log(`${result.papers.length} papers in ${result.elapsedMs}ms · upstream totals ${JSON.stringify(result.totals)}`);
  result.papers.forEach((p, i) => {
    console.log(`\n  ${i + 1}. ${p.title}`);
    console.log(`     ${p.authors.slice(0, 3).join(', ')}${p.authors.length > 3 ? ` +${p.authors.length - 3}` : ''}`);
    console.log(
      `     ${[p.venue, p.year, p.doi ? `doi:${p.doi}` : undefined, p.citations !== undefined ? `${p.citations} cites` : 'cites: unknown']
        .filter(Boolean)
        .join(' · ')}`,
    );
    console.log(`     [${p.sources.join(',')}] ${p.url}`);
    console.log(`     abstract: ${p.abstract ? `${p.abstract.length} chars` : 'none'}`);
  });
  sources(result.sources);

  rule('search_papers — bioRxiv recency scan (no server-side search upstream)');
  const pre = await searchPapers('single cell', { sources: ['biorxiv'], limit: 3, preprintWindowDays: 14 });
  console.log(`${pre.papers.length} preprints in ${pre.elapsedMs}ms`);
  pre.papers.forEach((p, i) => console.log(`  ${i + 1}. [${p.date}] ${p.title.slice(0, 90)}`));
  sources(pre.sources);
}

async function tryRead(): Promise<void> {
  const id = arg ?? '2408.06717';
  rule(`read_paper — ${id}`);
  const result = await readPaper(id, { maxChars: 4000 });
  if (!result.paper) {
    console.log(`not found. notes: ${result.notes.join('; ')}`);
    return;
  }
  const p = result.paper;
  console.log(`title:     ${p.title}`);
  console.log(`authors:   ${p.authors.slice(0, 5).join(', ')}`);
  console.log(`venue:     ${p.venue ?? '-'} (${p.year ?? '-'})`);
  console.log(`doi:       ${p.doi ?? '-'}`);
  console.log(`citations: ${p.citations ?? 'unknown'}`);
  console.log(`url:       ${p.url}`);
  console.log(`pdf:       ${p.pdfUrl ?? '-'}`);
  console.log(`abstract:  ${p.abstract ? `${p.abstract.length} chars` : 'none'}`);
  console.log(`full text: ${result.fullText ? `${result.fullText.length} chars from ${result.fullTextSource}` : 'none'}`);
  if (result.fullTextPages) console.log(`pages:     ${result.fullTextPages}`);
  if (result.notes.length) console.log(`notes:     ${result.notes.join('; ')}`);
  if (result.fullText) console.log(`\n  --- first 400 chars ---\n  ${result.fullText.slice(0, 400).replace(/\n/g, '\n  ')}`);
}

async function tryDeveloper(): Promise<void> {
  rule(`developer_search — "${arg ?? 'model context protocol server'}"`);
  const result = await developerSearch(arg ?? 'model context protocol server', {
    kinds: ['repos', 'prs'],
    language: 'typescript',
    limit: 5,
  });
  console.log(`${result.hits.length} hits in ${result.elapsedMs}ms · ${result.unauthenticated ? 'UNAUTHENTICATED' : 'authenticated'}`);
  result.hits.forEach((h, i) => {
    console.log(`\n  ${i + 1}. [${h.kind}] ${h.title}`);
    console.log(
      `     ${[h.language, h.license, h.stars !== undefined ? `★${h.stars}` : undefined, h.state, h.updated].filter(Boolean).join(' · ')}`,
    );
    console.log(`     ${h.url}`);
    if (h.description) console.log(`     ${h.description.slice(0, 110)}`);
    if (h.snippet) console.log(`     snippet: ${h.snippet.slice(0, 110)}`);
  });
  sources(result.sources);

  rule('developer_search — code search (expected to need GITHUB_TOKEN when unset)');
  const code = await developerSearch('registerTool', { kinds: ['code'], language: 'typescript', limit: 3 });
  console.log(`${code.hits.length} hits`);
  code.hits.forEach((h, i) => console.log(`  ${i + 1}. ${h.title}\n     ${h.snippet ?? ''}`));
  sources(code.sources);
}

async function tryGov(): Promise<void> {
  rule(`gov_search — "${arg ?? 'artificial intelligence'}"`);
  const result = await govSearch(arg ?? 'artificial intelligence', { limit: 5 });
  console.log(`${result.documents.length} documents in ${result.elapsedMs}ms · upstream totals ${JSON.stringify(result.totals)}`);
  result.documents.forEach((d, i) => {
    console.log(`\n  ${i + 1}. ${d.title}`);
    console.log(`     ${d.type} · ${d.date} · ${d.agencies.join('; ')}`);
    console.log(`     status: ${d.status}`);
    console.log(`     ${d.citation ? `${d.citation} · ` : ''}${d.url}`);
    if (d.abstract) console.log(`     ${d.abstract.slice(0, 140)}`);
  });
  sources(result.sources);
  console.log(`\n  caveat: ${result.caveat}`);
}

interface RegisteredTool {
  title?: string;
  handler: (args: Record<string, unknown>) => Promise<{ content: { text?: string }[]; isError?: boolean }>;
}

/**
 * Confirm the MCP layer registers and renders, without starting a transport.
 * The rendered text is the real deliverable, so we look at it directly.
 */
async function tryTools(): Promise<void> {
  rule('registerIndexTools — MCP registration');
  const server = new McpServer({ name: 'try-indexes', version: '0.0.0' });
  registerIndexTools(server);
  const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools;
  const names = Object.keys(registered);
  console.log(`${names.length} tool(s) registered`);
  for (const name of names) console.log(`  ${name.padEnd(18)} ${registered[name]?.title ?? ''}`);

  for (const [name, args] of [
    ['search_papers', { query: 'sparse autoencoder interpretability', limit: 2, sources: ['arxiv'] }],
    ['developer_search', { query: 'zod schema validation', kinds: ['repos'], limit: 2 }],
    ['gov_search', { query: 'per- and polyfluoroalkyl substances', limit: 2, docTypes: ['rule'] }],
  ] as [string, Record<string, unknown>][]) {
    const tool = registered[name];
    if (!tool) continue;
    rule(`rendered output — ${name}`);
    const result = await tool.handler(args);
    console.log(result.content.map((c) => c.text ?? '').join('\n'));
    console.log(`[isError: ${Boolean(result.isError)}]`);
  }
}

keyReport();

if (which === 'all' || which === 'tools') await tryTools();

if (which === 'all' || which === 'papers') await tryPapers();
if (which === 'all' || which === 'read') await tryRead();
if (which === 'all' || which === 'developer' || which === 'dev') await tryDeveloper();
if (which === 'all' || which === 'gov') await tryGov();

console.log('\ndone.');
