import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { search, providerStatuses } from '../../core/search/index.js';
import type {
  SearchOptions,
  SearchResponse,
  SearchResult,
  SearchSource,
} from '../../core/search/index.js';
import { formatScrape } from '../format.js';
import type { ScrapeFormat, ScrapeOptions } from '../../core/types.js';

const sourceEnum = z.enum(['web', 'news', 'images']);
const timeEnum = z.enum(['day', 'week', 'month', 'year']);

const scrapeOptionsSchema = z
  .object({
    formats: z
      .array(z.enum(['markdown', 'html', 'rawHtml', 'links', 'images', 'summary', 'json', 'text', 'query']))
      .optional(),
    onlyMainContent: z.boolean().optional(),
    query: z.string().optional(),
    maxChars: z.number().optional(),
    maxAge: z.number().optional(),
    render: z.enum(['auto', 'http', 'browser']).optional(),
    timeout: z.number().optional(),
    fitMarkdown: z.boolean().optional(),
    redactPII: z.boolean().optional(),
  })
  .optional();

const searchInput = {
  query: z.string().describe('What to search for. Supports engine operators like site: and quotes.'),
  limit: z.number().optional().describe('Results per source. Default 10.'),
  sources: z
    .array(sourceEnum)
    .optional()
    .describe('Which indexes to query. Default ["web"]. "news" and "images" need SearxNG or a Brave key.'),
  country: z.string().optional().describe('2-letter country code to localise results, e.g. "de".'),
  location: z.string().optional().describe('Locale hint; a 2-letter code here is treated as `country`.'),
  lang: z.string().optional().describe('Language code, e.g. "en", "fr".'),
  time: timeEnum.optional().describe('Only results from the last day / week / month / year.'),
  includeDomains: z
    .array(z.string())
    .optional()
    .describe('Keep only results on these hostnames (subdomains included).'),
  excludeDomains: z.array(z.string()).optional().describe('Drop results on these hostnames.'),
  provider: z
    .enum(['searxng', 'brave', 'duckduckgo'])
    .optional()
    .describe('Force one provider instead of walking the SearxNG -> Brave -> DuckDuckGo chain.'),
  timeout: z.number().optional().describe('Per-request timeout in ms.'),
  scrapeOptions: scrapeOptionsSchema.describe(
    'Fetch the full content of every result, concurrently. Same options as the `scrape` tool.',
  ),
};

function toOptions(args: Record<string, unknown>): SearchOptions {
  const raw = args.scrapeOptions as Record<string, unknown> | undefined;
  const scrapeOptions: ScrapeOptions | undefined = raw
    ? {
        formats: raw.formats as ScrapeFormat[] | undefined,
        onlyMainContent: raw.onlyMainContent as boolean | undefined,
        query: raw.query as string | undefined,
        maxChars: (raw.maxChars as number | undefined) ?? 4000,
        maxAge: raw.maxAge as number | undefined,
        render: raw.render as ScrapeOptions['render'],
        timeout: raw.timeout as number | undefined,
        fitMarkdown: raw.fitMarkdown as boolean | undefined,
        redactPII: raw.redactPII as boolean | undefined,
      }
    : undefined;

  return {
    limit: args.limit as number | undefined,
    sources: args.sources as SearchSource[] | undefined,
    country: args.country as string | undefined,
    location: args.location as string | undefined,
    lang: args.lang as string | undefined,
    time: args.time as SearchOptions['time'],
    includeDomains: args.includeDomains as string[] | undefined,
    excludeDomains: args.excludeDomains as string[] | undefined,
    provider: args.provider as SearchOptions['provider'],
    timeout: args.timeout as number | undefined,
    scrapeOptions,
  };
}

function oneLine(text: string, max = 220): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Short date, when the provider gave us something date-shaped. */
function shortDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // Take an ISO-ish prefix verbatim. Parsing it first would re-interpret a
  // timezone-less timestamp as local and shift the day on the way out.
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  if (iso) return iso[1];
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return oneLine(value, 24); // Brave sends things like "3 days ago".
  return new Date(parsed).toISOString().slice(0, 10);
}

/**
 * One header line, then a compact numbered list.
 *
 * The point of the whole project is not spending the model's context on
 * punctuation, so results are rendered as plain lines rather than a JSON
 * envelope with a field name in front of every value.
 */
export function formatSearch(res: SearchResponse): string {
  const out: string[] = [];

  const answered = Object.entries(res.answeredBy)
    .map(([source, provider]) => `${source}:${provider}`)
    .join(' ');
  const head = [
    `${res.results.length} result${res.results.length === 1 ? '' : 's'}`,
    answered || 'no provider answered',
    `${res.elapsedMs}ms`,
  ];
  if (res.dropped) head.push(`dropped:${res.dropped}`);
  if (res.scraped !== undefined) head.push(`scraped:${res.scraped}`);

  out.push(`# search: ${res.query}`);
  out.push(head.join(' · '));

  // Honest degradation: always say which providers were skipped and why, and
  // flag when our own filters threw away most of what a provider returned.
  const notable = res.attempts.filter(
    (a) => a.status !== 'ok' || (a.received !== undefined && a.received !== a.results),
  );
  if (notable.length) {
    out.push('');
    for (const a of notable) {
      if (a.status === 'ok') {
        out.push(`- ${a.provider} ok (${a.source}): kept ${a.results} of ${a.received} after filters`);
      } else {
        out.push(`- ${a.provider} ${a.status} (${a.source}): ${a.reason ?? 'unknown reason'}`);
      }
    }
  }
  for (const warning of res.warnings) out.push(`\n⚠ ${warning}`);

  const bySource = new Map<SearchSource, SearchResult[]>();
  for (const item of res.results) {
    const list = bySource.get(item.source) ?? [];
    list.push(item);
    bySource.set(item.source, list);
  }

  for (const [source, items] of bySource) {
    out.push(`\n## ${source} (${items.length})`);
    items.forEach((item, i) => {
      const meta = [shortDate(item.publishedDate), item.engine].filter(Boolean).join(' · ');
      out.push(`${i + 1}. ${item.title || '(untitled)'}`);
      out.push(`   <${item.url}>${meta ? ` · ${meta}` : ''}`);
      if (item.description) out.push(`   ${oneLine(item.description)}`);
      if (item.imageUrl) out.push(`   image: <${item.imageUrl}>`);
    });
  }

  const scrapedPages = res.results.filter((r) => r.scrape);
  if (scrapedPages.length) {
    out.push(`\n## Pages (${scrapedPages.length})`);
    for (const item of scrapedPages) {
      if (!item.scrape) continue;
      out.push(`\n---\n\n${formatScrape(item.scrape)}`);
    }
  }

  return out.join('\n');
}

export function registerSearchTools(server: McpServer): void {
  server.registerTool(
    'search',
    {
      title: 'Search the web',
      description:
        'Search the web and get back titles, URLs and snippets — optionally with the full page content of ' +
        'every result in the same call. Walks a free provider chain: a self-hosted SearxNG instance ' +
        '(OPENSCRAPE_SEARXNG_URL) first, then the Brave Search API (BRAVE_SEARCH_API_KEY), then DuckDuckGo, ' +
        'which needs no configuration at all. Filter by site, language, country or recency. ' +
        'Use this to find pages; use `scrape` when you already know the URL.',
      inputSchema: searchInput,
    },
    async (args) => {
      const query = String(args.query ?? '');
      const res = await search(query, toOptions(args as Record<string, unknown>));
      // A query that genuinely matches nothing is an answer, not a failure.
      // Only report an error when no provider in the chain answered at all.
      const answered = Object.keys(res.answeredBy).length > 0;
      return {
        content: [{ type: 'text' as const, text: formatSearch(res) }],
        isError: !answered,
      };
    },
  );

  server.registerTool(
    'search_providers',
    {
      title: 'Search provider status',
      description:
        'Report which search providers are configured and which would answer the next query, ' +
        'with the exact environment variable to set for the ones that are not.',
      inputSchema: {},
    },
    async () => {
      const lines = providerStatuses().map(({ provider, status }) =>
        status.ready
          ? `✓ ${provider} ready${status.detail ? ` (${status.detail})` : ''}`
          : `· ${provider} unavailable: ${status.reason ?? 'not configured'}`,
      );
      const ready = providerStatuses().filter((p) => p.status.ready).map((p) => p.provider);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Search chain: searxng → brave → duckduckgo\n${lines.join('\n')}\n\nNext query would use: ${
              ready[0] ?? 'nothing'
            }`,
          },
        ],
      };
    },
  );
}
