/**
 * MCP tools for the three specialised indexes.
 *
 * Output style follows `src/mcp/format.ts`: a one-line header, a compact
 * numbered list, then a short per-source status block. No JSON envelopes — a
 * search result list spent on field names and punctuation is context the
 * calling model could have spent on the papers themselves.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { developerSearch } from '../../core/indexes/developer.js';
import { govSearch, GOV_CAVEAT } from '../../core/indexes/gov.js';
import { readPaper, searchPapers } from '../../core/indexes/papers.js';
import { clip, formatSources, type SourceStatus } from '../../core/indexes/index.js';
import type { DeveloperKind, DeveloperSearchOptions } from '../../core/indexes/developer.js';
import type { GovSearchOptions, GovSource } from '../../core/indexes/gov.js';
import type { PaperSearchOptions, PaperSource } from '../../core/indexes/papers.js';

function human(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}

/** "arxiv 12.4k · pubmed 231" — how many hits each source reported upstream. */
function totalsLine(totals: Record<string, number>): string {
  const parts = Object.entries(totals).map(([name, count]) => `${name} ${human(count)}`);
  return parts.length ? parts.join(' · ') : 'no upstream hits';
}

/** Authors, abbreviated the way a citation would be. */
function authorList(authors: string[], max = 3): string {
  if (!authors.length) return 'unknown authors';
  if (authors.length <= max) return authors.join(', ');
  return `${authors.slice(0, max).join(', ')} +${authors.length - max}`;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], isError };
}

/** True when every source failed — the caller should know the list is empty for a reason. */
function allFailed(sources: SourceStatus[]): boolean {
  return sources.length > 0 && sources.every((s) => !s.ok);
}

// ----------------------------------------------------------- search_papers

const paperSourceEnum = z.enum(['arxiv', 'pubmed', 'biorxiv', 'medrxiv', 'crossref', 'openalex']);

const searchPapersInput = {
  query: z.string().describe('What to search for. Quoted "phrases" are kept together.'),
  sources: z
    .array(paperSourceEnum)
    .optional()
    .describe(
      'Which APIs to query. Default ["arxiv","pubmed","openalex"]. ' +
        '"crossref" adds publisher metadata across all disciplines; "biorxiv"/"medrxiv" scan a recent window of preprints.',
    ),
  limit: z.number().optional().describe('Papers to return after merging duplicates. Default 10, max 50.'),
  yearFrom: z.number().optional().describe('Earliest publication year.'),
  yearTo: z.number().optional().describe('Latest publication year.'),
  sortBy: z
    .enum(['relevance', 'date', 'citations'])
    .optional()
    .describe('Default "relevance". "citations" sorts by OpenAlex citation count.'),
  includeAbstracts: z.boolean().optional().describe('Include abstracts. Default true.'),
  enrichCitations: z
    .boolean()
    .optional()
    .describe('Look up citation counts in OpenAlex for everything with a DOI. Default true.'),
  abstractChars: z.number().optional().describe('Characters of abstract to show per paper. Default 320, 0 to omit.'),
  preprintWindowDays: z
    .number()
    .optional()
    .describe('bioRxiv/medRxiv only: how many days back to scan. Default 30.'),
};

function formatPapers(result: Awaited<ReturnType<typeof searchPapers>>, abstractChars: number): string {
  const out: string[] = [];
  out.push(`# Papers: ${result.query}`);
  out.push(`${result.papers.length} result(s) · ${totalsLine(result.totals)} upstream · ${result.elapsedMs}ms`);

  if (!result.papers.length) {
    out.push(
      allFailed(result.sources)
        ? '\n**No results because every source failed.** See the reasons below — this is not "nothing was published".'
        : '\nNo papers matched. Try fewer terms, a different source, or a wider year range.',
    );
    out.push(formatSources(result.sources));
    return out.join('\n');
  }

  out.push('');
  result.papers.forEach((paper, i) => {
    const meta = [paper.venue, paper.year ? String(paper.year) : paper.date]
      .filter(Boolean)
      .join(' ');
    const bits = [meta || undefined];
    if (paper.citations !== undefined) bits.push(`${human(paper.citations)} cites`);
    if (paper.type && paper.type !== 'preprint') bits.push(paper.type);
    if (paper.version) bits.push(`v${paper.version}`);
    bits.push(`[${paper.sources.join(',')}]`);

    out.push(`${i + 1}. **${paper.title}**`);
    out.push(`   ${authorList(paper.authors)} · ${bits.filter(Boolean).join(' · ')}`);
    const links = [paper.url];
    if (paper.doi) links.push(`doi:${paper.doi}`);
    if (paper.pdfUrl && paper.pdfUrl !== paper.url) links.push(`pdf: ${paper.pdfUrl}`);
    out.push(`   ${links.join(' · ')}`);
    out.push(`   read_paper id: ${paper.id}`);
    if (abstractChars > 0 && paper.abstract) out.push(`   ${clip(paper.abstract, abstractChars)}`);
    out.push('');
  });

  out.push(formatSources(result.sources));
  return out.join('\n');
}

// ------------------------------------------------------- developer_search

const developerKindEnum = z.enum(['repos', 'code', 'issues', 'prs']);

const developerSearchInput = {
  query: z.string().describe('What to search for. GitHub search qualifiers (org:, path:, in:, stars:) pass through.'),
  kinds: z
    .array(developerKindEnum)
    .optional()
    .describe(
      'What to search. Default ["repos","issues","prs"]. "code" needs GITHUB_TOKEN (GitHub refuses code search to anonymous callers).',
    ),
  limit: z.number().optional().describe('Hits to return. Default 10, max 30.'),
  language: z.string().optional().describe('Restrict to a language, e.g. "typescript".'),
  repo: z.string().optional().describe('Restrict to one repository, "owner/name".'),
  license: z.string().optional().describe('Restrict repositories by license key, e.g. "mit", "apache-2.0".'),
  sort: z.enum(['best', 'stars', 'updated']).optional().describe('Default "best" (GitHub relevance).'),
  grepApp: z.boolean().optional().describe('Also try grep.app cross-repo code search when searching code. Default true.'),
};

function formatDeveloper(result: Awaited<ReturnType<typeof developerSearch>>): string {
  const out: string[] = [];
  out.push(`# Developer: ${result.query}`);
  out.push(
    `${result.hits.length} result(s) · ${totalsLine(result.totals)} upstream · ` +
      `${result.unauthenticated ? 'unauthenticated' : 'authenticated'} · ${result.elapsedMs}ms`,
  );
  if (result.unauthenticated) {
    out.push(
      '> No GITHUB_TOKEN set: GitHub search is capped at **10 requests/minute** per IP and code search is ' +
        'refused outright. Set `GITHUB_TOKEN` in the environment for 30/minute and working code search.',
    );
  }

  if (!result.hits.length) {
    out.push(
      allFailed(result.sources)
        ? '\n**No results because every source failed.** See the reasons below.'
        : '\nNo hits. Loosen the filters or drop a qualifier.',
    );
    out.push(formatSources(result.sources));
    return out.join('\n');
  }

  out.push('');
  result.hits.forEach((hit, i) => {
    const bits: string[] = [hit.kind];
    if (hit.language) bits.push(hit.language);
    if (hit.license && hit.license !== 'NOASSERTION') bits.push(hit.license);
    if (hit.stars !== undefined) bits.push(`★${human(hit.stars)}`);
    if (hit.forks !== undefined && hit.kind === 'repos') bits.push(`${human(hit.forks)} forks`);
    if (hit.state) bits.push(hit.state);
    if (hit.comments !== undefined && hit.comments > 0) bits.push(`${hit.comments} comments`);
    if (hit.updated) bits.push(hit.updated);

    out.push(`${i + 1}. **${hit.title}**`);
    out.push(`   ${bits.join(' · ')}`);
    out.push(`   ${hit.url}`);
    if (hit.repo && hit.kind !== 'repos') out.push(`   repo: ${hit.repo}`);
    if (hit.description) out.push(`   ${hit.description}`);
    if (hit.snippet) out.push(`   \`${hit.snippet}\``);
    if (hit.topics?.length) out.push(`   topics: ${hit.topics.join(', ')}`);
    out.push('');
  });

  out.push(formatSources(result.sources));
  return out.join('\n');
}

// -------------------------------------------------------------- gov_search

const govSourceEnum = z.enum(['federalregister', 'govinfo', 'courtlistener']);

const govSearchInput = {
  query: z.string().describe('What to search for.'),
  sources: z
    .array(govSourceEnum)
    .optional()
    .describe(
      'Default: all three. "federalregister" needs no key. "govinfo" needs GOVINFO_API_KEY, ' +
        '"courtlistener" needs COURTLISTENER_TOKEN; both are skipped with a note when unset.',
    ),
  limit: z.number().optional().describe('Documents to return. Default 10, max 50.'),
  dateFrom: z.string().optional().describe('Earliest publication date, ISO (YYYY-MM-DD).'),
  dateTo: z.string().optional().describe('Latest publication date, ISO (YYYY-MM-DD).'),
  docTypes: z
    .array(z.enum(['rule', 'proposed_rule', 'notice', 'presidential_document']))
    .optional()
    .describe('Federal Register document types to include.'),
  agencies: z
    .array(z.string())
    .optional()
    .describe('Federal Register agency slugs, e.g. "environmental-protection-agency".'),
  collections: z
    .array(z.string())
    .optional()
    .describe('govinfo collection codes, e.g. ["CFR","USCODE","BILLS"]. Needs GOVINFO_API_KEY.'),
  order: z.enum(['newest', 'oldest', 'relevance']).optional().describe('Default "newest".'),
};

function formatGov(result: Awaited<ReturnType<typeof govSearch>>): string {
  const out: string[] = [];
  out.push(`# US gov & legal: ${result.query}`);
  out.push(`${result.documents.length} result(s) · ${totalsLine(result.totals)} upstream · ${result.elapsedMs}ms`);
  // The caveat goes above the results, not in a footnote nobody reads.
  out.push(`\n> ⚠ ${result.caveat}`);

  if (!result.documents.length) {
    out.push(
      allFailed(result.sources)
        ? '\n**No results because every source failed.** See the reasons below — this does not mean no such law exists.'
        : '\nNo documents matched. Note that a search finding nothing is not evidence that no rule applies.',
    );
    out.push(formatSources(result.sources));
    return out.join('\n');
  }

  out.push('');
  result.documents.forEach((doc, i) => {
    out.push(`${i + 1}. **${doc.title}**`);
    out.push(
      `   ${doc.type} · ${doc.date ?? 'date unknown'} · ${doc.agencies.length ? doc.agencies.join('; ') : 'agency not stated'}`,
    );
    out.push(`   status: ${doc.status ?? 'not stated upstream'}`);
    out.push(`   ${doc.url}`);
    const refs: string[] = [];
    if (doc.citation) refs.push(doc.citation);
    if (doc.identifier) refs.push(`id ${doc.identifier}`);
    if (doc.docketIds?.length) refs.push(`docket ${doc.docketIds.join(', ')}`);
    if (doc.cfrReferences?.length) refs.push(doc.cfrReferences.join('; '));
    if (doc.effectiveOn) refs.push(`effective ${doc.effectiveOn}`);
    if (doc.commentsCloseOn) refs.push(`comments close ${doc.commentsCloseOn}`);
    if (refs.length) out.push(`   ${refs.join(' · ')}`);
    if (doc.abstract) out.push(`   ${doc.abstract}`);
    out.push('');
  });

  out.push(formatSources(result.sources));
  return out.join('\n');
}

// --------------------------------------------------------------- registration

export function registerIndexTools(server: McpServer): void {
  server.registerTool(
    'search_papers',
    {
      title: 'Search academic papers',
      description:
        'Search academic literature across arXiv, PubMed, bioRxiv/medRxiv, Crossref and OpenAlex at once. ' +
        'Returns title, authors, venue, year, DOI, abstract, citation count and a full-text link, merged across ' +
        'sources and de-duplicated by DOI. No API key needed. Pass the printed id to `read_paper` for the full text.',
      inputSchema: searchPapersInput,
    },
    async (args) => {
      const opts: PaperSearchOptions = {
        sources: args.sources as PaperSource[] | undefined,
        limit: args.limit as number | undefined,
        yearFrom: args.yearFrom as number | undefined,
        yearTo: args.yearTo as number | undefined,
        sortBy: args.sortBy as PaperSearchOptions['sortBy'],
        includeAbstracts: args.includeAbstracts as boolean | undefined,
        enrichCitations: args.enrichCitations as boolean | undefined,
        preprintWindowDays: args.preprintWindowDays as number | undefined,
      };
      const result = await searchPapers(String(args.query), opts);
      const abstractChars = typeof args.abstractChars === 'number' ? args.abstractChars : 320;
      return textResult(formatPapers(result, abstractChars), !result.papers.length && allFailed(result.sources));
    },
  );

  server.registerTool(
    'read_paper',
    {
      title: 'Read one paper',
      description:
        'Fetch one paper by arXiv id, DOI, PMID or URL: its metadata and abstract, plus the full text when a PDF ' +
        'or open-access page is reachable (PDFs are parsed, not downloaded). Say what you could not get rather ' +
        'than guessing: if the full text is paywalled this reports that explicitly.',
      inputSchema: {
        id: z
          .string()
          .describe('arXiv id ("2408.06717" or an arxiv.org URL), a DOI, "pmid:38786024", or any paper URL.'),
        fullText: z.boolean().optional().describe('Fetch the full text as well as the abstract. Default true.'),
        maxChars: z.number().optional().describe('Cap the full text. Overflow spills to a file and the path is reported.'),
      },
    },
    async (args) => {
      const result = await readPaper(String(args.id), {
        fullText: args.fullText as boolean | undefined,
        maxChars: args.maxChars as number | undefined,
      });

      const paper = result.paper;
      const out: string[] = [];
      if (!paper) {
        out.push(`# Paper not found: ${String(args.id)}`);
        out.push(result.notes.length ? result.notes.map((n) => `- ${n}`).join('\n') : 'No metadata source recognised it.');
        return textResult(out.join('\n'), true);
      }

      out.push(`# ${paper.title}`);
      const head = [
        paper.venue,
        paper.year ? String(paper.year) : paper.date,
        paper.citations !== undefined ? `${human(paper.citations)} cites` : undefined,
        paper.doi ? `doi:${paper.doi}` : undefined,
        paper.sources.length ? `[${paper.sources.join(',')}]` : undefined,
        `${result.elapsedMs}ms`,
      ].filter(Boolean);
      out.push(head.join(' · '));
      out.push(`${authorList(paper.authors, 12)}`);
      out.push(`<${paper.url}>${paper.pdfUrl && paper.pdfUrl !== paper.url ? ` · pdf: ${paper.pdfUrl}` : ''}`);
      if (result.notes.length) out.push(`\n⚠ ${result.notes.join('; ')}`);
      if (paper.abstract) out.push(`\n## Abstract\n\n${paper.abstract}`);
      if (result.fullText) {
        out.push(
          `\n## Full text\n\n_from ${result.fullTextSource}${result.fullTextPages ? ` · ${result.fullTextPages} pages` : ''}_\n\n${result.fullText}`,
        );
      }
      return textResult(out.join('\n'));
    },
  );

  server.registerTool(
    'developer_search',
    {
      title: 'Search code and developer docs',
      description:
        'Search public repositories, source code, issues and pull requests via the GitHub REST API, plus grep.app ' +
        'for cross-repo code search. Filters for language, repo and license. Works unauthenticated at a low rate ' +
        'limit; GITHUB_TOKEN raises it and is required for code search. The output always says which it was.',
      inputSchema: developerSearchInput,
    },
    async (args) => {
      const opts: DeveloperSearchOptions = {
        kinds: args.kinds as DeveloperKind[] | undefined,
        limit: args.limit as number | undefined,
        language: args.language as string | undefined,
        repo: args.repo as string | undefined,
        license: args.license as string | undefined,
        sort: args.sort as DeveloperSearchOptions['sort'],
        grepApp: args.grepApp as boolean | undefined,
      };
      const result = await developerSearch(String(args.query), opts);
      return textResult(formatDeveloper(result), !result.hits.length && allFailed(result.sources));
    },
  );

  server.registerTool(
    'gov_search',
    {
      title: 'Search US government and legal documents',
      description:
        'Search US federal rulemaking and legal material: the Federal Register (rules, proposed rules, notices, ' +
        'presidential documents — no key needed), govinfo (CFR, US Code, bills — needs GOVINFO_API_KEY) and ' +
        'CourtListener case law (needs COURTLISTENER_TOKEN). Each result carries its date, agency and type. ' +
        'IMPORTANT: results include historical and superseded documents and are not a statement of current law — ' +
        'the output repeats this caveat and it should be passed on to the user.',
      inputSchema: govSearchInput,
    },
    async (args) => {
      const opts: GovSearchOptions = {
        sources: args.sources as GovSource[] | undefined,
        limit: args.limit as number | undefined,
        dateFrom: args.dateFrom as string | undefined,
        dateTo: args.dateTo as string | undefined,
        docTypes: args.docTypes as GovSearchOptions['docTypes'],
        agencies: args.agencies as string[] | undefined,
        collections: args.collections as string[] | undefined,
        order: args.order as GovSearchOptions['order'],
      };
      const result = await govSearch(String(args.query), opts);
      return textResult(formatGov(result), !result.documents.length && allFailed(result.sources));
    },
  );
}

export { GOV_CAVEAT };
