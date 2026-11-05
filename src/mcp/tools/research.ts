import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { deepResearch } from '../../core/agent/research.js';
import type {
  ResearchFinding,
  ResearchOptions,
  ResearchResult,
  ResearchSourceName,
} from '../../core/agent/research.js';

const sourceEnum = z.enum(['web', 'corpus', 'papers', 'developer', 'gov']);

const researchInput = {
  question: z
    .string()
    .describe(
      'The research question, in full. Phrase it as you would to a colleague — the planner decomposes it into sub-queries itself.',
    ),
  maxSubQueries: z.number().optional().describe('Hard cap on sub-queries. Default 4.'),
  maxPages: z.number().optional().describe('Hard cap on pages read. Default 12.'),
  maxChars: z.number().optional().describe('Hard cap on total characters returned across all findings. Default 40000.'),
  deadlineMs: z.number().optional().describe('Wall-clock budget for the whole run, in ms. Default 90000.'),
  charsPerPage: z.number().optional().describe('Characters kept from each page. Default 3500.'),
  resultsPerQuery: z.number().optional().describe('Results requested per sub-query, per source. Default 6.'),
  concurrency: z.number().optional().describe('Parallel page reads. Default 4.'),
  sources: z
    .array(sourceEnum)
    .optional()
    .describe(
      'Restrict gathering. Default: "web" + "corpus" (anything already crawled locally, free) plus whichever ' +
        'specialised index the question matches — "papers" for academic wording, "developer" for code, "gov" for US law. ' +
        'Pass ["corpus"] to research entirely offline from previous crawls.',
    ),
  includeDomains: z.array(z.string()).optional().describe('Keep only web results on these hostnames.'),
  excludeDomains: z.array(z.string()).optional().describe('Drop web results on these hostnames.'),
  maxAge: z.number().optional().describe('Serve pages from the local cache when younger than this (ms). Default 24h.'),
  timeout: z.number().optional().describe('Per-page scrape timeout in ms. Default 20000.'),
  minScore: z
    .number()
    .optional()
    .describe('Drop findings scoring below this (0..1). Default 0.3. Lower it only if the gaps say everything was filtered out.'),
  country: z.string().optional().describe('2-letter country code for web search, e.g. "de".'),
  lang: z.string().optional().describe('Language code for web search, e.g. "en".'),
};

function toOptions(args: Record<string, unknown>): ResearchOptions {
  return {
    maxSubQueries: args.maxSubQueries as number | undefined,
    maxPages: args.maxPages as number | undefined,
    maxChars: args.maxChars as number | undefined,
    deadlineMs: args.deadlineMs as number | undefined,
    charsPerPage: args.charsPerPage as number | undefined,
    resultsPerQuery: args.resultsPerQuery as number | undefined,
    concurrency: args.concurrency as number | undefined,
    sources: args.sources as ResearchSourceName[] | undefined,
    includeDomains: args.includeDomains as string[] | undefined,
    excludeDomains: args.excludeDomains as string[] | undefined,
    maxAge: args.maxAge as number | undefined,
    timeout: args.timeout as number | undefined,
    minScore: args.minScore as number | undefined,
    country: args.country as string | undefined,
    lang: args.lang as string | undefined,
  };
}

function human(n: number): string {
  if (n < 1000) return String(n);
  return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
}

/**
 * Render the brief.
 *
 * Deliberately terse, and deliberately not a summary. The calling model writes
 * the answer; what it needs from us is passages it can quote and a URL beside
 * each one. A JSON envelope of the same information would spend a third of the
 * budget on field names.
 */
function formatResearch(r: ResearchResult): string {
  const out: string[] = [];

  const header = [
    `${r.findings.length} finding(s)`,
    `${r.uniqueSources} source(s)`,
    `${r.budget.pagesRead.used}/${r.budget.pagesRead.limit} pages`,
    `${human(r.budget.chars.used)}/${human(r.budget.chars.limit)} chars`,
    `${r.elapsedMs}ms/${r.budget.time.limitMs}ms`,
    r.plan.kind,
    r.webSearchWorked ? 'web:ok' : 'web:unavailable',
  ];
  if (r.budget.stoppedBy) header.push(`stopped:${r.budget.stoppedBy}`);

  out.push(`# Research: ${r.question}`);
  out.push(header.join(' · '));

  if (!r.ok) {
    out.push(
      '\n**INCOMPLETE — no sources were reached.** This is not a research result. ' +
        'Do not answer from it; the gaps below say what failed and what would fix it.',
    );
  }

  out.push(`\n## Sub-queries run (${r.subQueries.length}/${r.budget.subQueries.limit})\n`);
  r.subQueries.forEach((q, i) => out.push(`${i + 1}. ${q}`));

  const perSource = (Object.entries(r.sourceCounts) as [ResearchSourceName, { candidates: number; queued: number; findings: number }][])
    .filter(([, c]) => c.candidates > 0 || c.findings > 0)
    .map(([name, c]) => `${name} ${c.findings}/${c.candidates}`);
  if (perSource.length) out.push(`\nSources (findings/candidates): ${perSource.join(' · ')}`);

  if (r.findings.length) {
    // Grouped by URL so each citation appears once, with its passages under it.
    const byUrl = new Map<string, ResearchFinding[]>();
    for (const f of r.findings) {
      const list = byUrl.get(f.url);
      if (list) list.push(f);
      else byUrl.set(f.url, [f]);
    }
    const groups = [...byUrl.entries()].sort(
      (a, b) => Math.max(...b[1].map((f) => f.score)) - Math.max(...a[1].map((f) => f.score)),
    );

    out.push(`\n## Findings\n`);
    for (const [url, group] of groups) {
      const first = group[0];
      const meta = [
        first.source,
        `score ${Math.max(...group.map((f) => f.score)).toFixed(2)}`,
        first.publishedDate,
        first.cached ? 'cached' : undefined,
      ]
        .filter(Boolean)
        .join(' · ');
      out.push(`### ${first.title}`);
      out.push(`<${url}> · ${meta}`);
      for (const f of group) {
        out.push(`\n_re: ${f.subQuery}_\n`);
        out.push(f.passage);
      }
      out.push('');
    }
  }

  if (r.gaps.length) {
    out.push(`\n## Not reached (${r.gaps.length})\n`);
    for (const g of r.gaps) {
      out.push(`- **${g.source}** — ${g.what}: ${g.why}${g.fix ? `\n  - fix: ${g.fix}` : ''}`);
    }
  }

  for (const w of r.warnings) out.push(`\n⚠ ${w}`);

  out.push(
    '\n_Passages above are verbatim extracts, ranked but not synthesised. ' +
      'Write the answer yourself and cite the URL beside each passage._',
  );

  return out.join('\n');
}

export function registerResearchTools(server: McpServer): void {
  server.registerTool(
    'research',
    {
      title: 'Deep research across many sources',
      description:
        'Investigate a question when you do not know which URLs hold the answer. Decomposes the question into ' +
        'sub-queries, fans them out across web search, anything already crawled locally (free), and the academic, ' +
        'code and US-government indexes when the question fits, then reads the most promising pages with BM25 ' +
        'extraction so each contributes only its relevant passages. Returns ranked, de-duplicated passages with a ' +
        'URL beside each one, plus an explicit list of what could not be reached. Hard-capped on sub-queries, pages, ' +
        'characters and wall-clock time. It does NOT write the answer or call any model — you synthesise and cite.',
      inputSchema: researchInput,
    },
    async (args) => {
      const question = String(args.question ?? '');
      const result = await deepResearch(question, toOptions(args as Record<string, unknown>));
      return {
        content: [{ type: 'text' as const, text: formatResearch(result) }],
        isError: !result.ok,
      };
    },
  );
}
