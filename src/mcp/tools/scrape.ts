import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { scrape } from '../../core/scrape.js';
import { parseDocument } from '../../core/parse/documents.js';
import { cacheStats, pruneCache } from '../../core/cache/store.js';
import { formatScrape } from '../format.js';
import type { PageAction, ScrapeFormat, ScrapeOptions } from '../../core/types.js';

const formatEnum = z.enum([
  'markdown',
  'html',
  'rawHtml',
  'links',
  'images',
  'summary',
  'json',
  'screenshot',
  'text',
  'query',
  'branding',
]);

const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('wait'), milliseconds: z.number().optional(), selector: z.string().optional() }),
  z.object({ type: z.literal('click'), selector: z.string(), all: z.boolean().optional() }),
  z.object({ type: z.literal('write'), selector: z.string().optional(), text: z.string() }),
  z.object({ type: z.literal('press'), key: z.string() }),
  z.object({
    type: z.literal('scroll'),
    direction: z.enum(['up', 'down']).optional(),
    amount: z.number().optional(),
    selector: z.string().optional(),
  }),
  z.object({ type: z.literal('scrape') }),
  z.object({ type: z.literal('screenshot'), fullPage: z.boolean().optional() }),
  z.object({ type: z.literal('executeJavascript'), script: z.string() }),
  z.object({ type: z.literal('navigate'), url: z.string() }),
]);

const scrapeInput = {
  url: z.string().describe('The http(s) URL to scrape.'),
  formats: z
    .array(formatEnum)
    .optional()
    .describe(
      'What to return. Default ["markdown"]. "query" returns only the parts matching `query`; "json" returns the page\'s own structured data (JSON-LD, OpenGraph, microdata).',
    ),
  onlyMainContent: z
    .boolean()
    .optional()
    .describe('Strip nav, header, footer and sidebars. Default true. Set false for full-page HTML.'),
  includeTags: z.array(z.string()).optional().describe('CSS selectors to keep; everything else is dropped.'),
  excludeTags: z.array(z.string()).optional().describe('CSS selectors to remove.'),
  query: z
    .string()
    .optional()
    .describe(
      'Keep only page sections relevant to this question (BM25 ranking, no LLM call). The cheapest way to read one fact out of a long page.',
    ),
  fitMarkdown: z
    .boolean()
    .optional()
    .describe('Prune leftover navigation residue and boilerplate blocks from the markdown.'),
  citations: z
    .boolean()
    .optional()
    .describe('Replace inline links with numbered citations plus a reference list. Shrinks link-heavy pages.'),
  maxChars: z
    .number()
    .optional()
    .describe('Cap characters per text format. Overflow is written to a file and the path is reported.'),
  maxAge: z
    .number()
    .optional()
    .describe('Serve from the local cache when the stored copy is younger than this many ms. 0 = always fetch fresh.'),
  render: z
    .enum(['auto', 'http', 'browser'])
    .optional()
    .describe('"auto" (default) uses plain HTTP and escalates to a real browser only when the page needs JavaScript.'),
  timeout: z.number().optional().describe('Per-request timeout in ms.'),
  waitFor: z.number().optional().describe('Browser only: extra wait after load, in ms.'),
  waitForSelector: z.string().optional().describe('Browser only: wait until this CSS selector appears.'),
  mobile: z.boolean().optional().describe('Emulate a phone.'),
  headers: z.record(z.string(), z.string()).optional().describe('Extra request headers.'),
  proxy: z.string().optional().describe('Proxy URL, e.g. http://user:pass@host:port.'),
  actions: z.array(actionSchema).optional().describe('Browser interactions to run before capture (click, write, scroll, press, screenshot...).'),
  screenshotFullPage: z.boolean().optional().describe('Capture the whole page rather than the viewport.'),
  redactPII: z.boolean().optional().describe('Mask emails, phone numbers, cards and national IDs in the output.'),
  zeroDataRetention: z.boolean().optional().describe('Write nothing to disk: no cache entry, no overflow file.'),
  parseDocuments: z.boolean().optional().describe('Parse PDF/DOCX/CSV content. Default true.'),
  profile: z
    .string()
    .optional()
    .describe(
      'Fetch through one of your saved logged-in browser profiles (see profile_list / profile_login). Used only if the anonymous fetch comes back unreadable.',
    ),
  brandingStylesheets: z
    .number()
    .optional()
    .describe(
      'For the branding format: fetch up to this many same-origin stylesheets so colours and fonts come from the real CSS. Default 0 (HTML only), because each one is an extra request.',
    ),
  archiveFallback: z
    .boolean()
    .optional()
    .describe(
      'When the live page cannot be read (bot wall, 4xx/5xx, empty body), serve a public web-archive copy instead, clearly labelled with its capture date. Default true. Set false to make an unreadable page simply fail.',
    ),
};

function toOptions(args: Record<string, unknown>): ScrapeOptions {
  return {
    formats: args.formats as ScrapeFormat[] | undefined,
    onlyMainContent: args.onlyMainContent as boolean | undefined,
    includeTags: args.includeTags as string[] | undefined,
    excludeTags: args.excludeTags as string[] | undefined,
    query: args.query as string | undefined,
    fitMarkdown: args.fitMarkdown as boolean | undefined,
    citations: args.citations as boolean | undefined,
    maxChars: args.maxChars as number | undefined,
    maxAge: args.maxAge as number | undefined,
    render: args.render as ScrapeOptions['render'],
    timeout: args.timeout as number | undefined,
    waitFor: args.waitFor as number | undefined,
    waitForSelector: args.waitForSelector as string | undefined,
    mobile: args.mobile as boolean | undefined,
    headers: args.headers as Record<string, string> | undefined,
    proxy: args.proxy as string | undefined,
    actions: args.actions as PageAction[] | undefined,
    screenshot: args.screenshotFullPage ? { fullPage: true } : undefined,
    redactPII: args.redactPII as boolean | undefined,
    zeroDataRetention: args.zeroDataRetention as boolean | undefined,
    parseDocuments: args.parseDocuments as boolean | undefined,
    profile: args.profile as string | undefined,
    brandingStylesheets: args.brandingStylesheets as number | undefined,
    archiveFallback: args.archiveFallback as boolean | undefined,
  };
}

export function registerScrapeTools(server: McpServer): void {
  server.registerTool(
    'scrape',
    {
      title: 'Scrape a page',
      description:
        'Fetch one URL and return clean markdown (or HTML, links, images, structured data, a screenshot). ' +
        'Handles JavaScript-rendered pages by escalating to a real browser only when needed, parses PDF/DOCX/CSV, ' +
        'and caches fetches locally so repeat reads are free. Use `query` to pull just the relevant part of a long page.',
      inputSchema: scrapeInput,
    },
    async (args) => {
      const url = String(args.url);
      const result = await scrape(url, toOptions(args as Record<string, unknown>));
      const text = formatScrape(result);

      // A screenshot travels as a real image block, not base64 in the text.
      if (result.screenshot) {
        const [meta, data] = result.screenshot.split(',', 2);
        const mimeType = /data:([^;]+)/.exec(meta)?.[1] ?? 'image/png';
        return {
          content: [
            { type: 'text' as const, text },
            { type: 'image' as const, data: data ?? '', mimeType },
          ],
          isError: !result.success,
        };
      }

      return {
        content: [{ type: 'text' as const, text }],
        isError: !result.success,
      };
    },
  );

  server.registerTool(
    'parse_file',
    {
      title: 'Parse a local document',
      description:
        'Read a local PDF, DOCX, CSV, JSON, XML, Markdown or text file and return it as markdown. ' +
        'Use this instead of reading binary files directly.',
      inputSchema: {
        path: z.string().describe('Absolute path to the file.'),
        maxChars: z.number().optional().describe('Cap the returned characters.'),
        redactPII: z.boolean().optional().describe('Mask emails, phones, cards and national IDs.'),
      },
    },
    async (args) => {
      const { readFile } = await import('node:fs/promises');
      const path = String(args.path);

      // Reading arbitrary local files is the one capability here that reaches
      // outside the web, so the lockdown file can switch it off entirely.
      const { fileParseAllowed, lockdownPath } = await import('../../core/policy/lockdown.js');
      if (!fileParseAllowed()) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Refusing to read local files: allowFileParse is false in ${lockdownPath()}.`,
            },
          ],
          isError: true,
        };
      }

      try {
        const buffer = await readFile(path);
        const doc = await parseDocument(buffer, '', path);
        let body = doc.markdown || doc.text;

        if (args.redactPII) {
          const { redactPii } = await import('../../core/util/redact.js');
          body = redactPii(body).text;
        }
        const max = args.maxChars as number | undefined;
        if (max && body.length > max) {
          body = body.slice(0, max).trimEnd() + `\n\n---\n_[truncated ${body.length - max} chars]_`;
        }

        const header = [
          `# ${path.split(/[\\/]/).pop()}`,
          `${doc.kind}${doc.pages ? ` · ${doc.pages} pages` : ''} · ${buffer.byteLength} bytes`,
          doc.warning ? `\n⚠ ${doc.warning}` : '',
        ]
          .filter(Boolean)
          .join('\n');

        return { content: [{ type: 'text' as const, text: `${header}\n\n${body}` }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Could not read ${path}: ${String(err)}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'cache_info',
    {
      title: 'Cache status',
      description:
        'Report how many pages are cached locally and how much space they use. Optionally prune entries older than a given age.',
      inputSchema: {
        pruneOlderThanMs: z
          .number()
          .optional()
          .describe('Delete cached fetches older than this many milliseconds.'),
      },
    },
    async (args) => {
      let pruned = 0;
      if (typeof args.pruneOlderThanMs === 'number') {
        pruned = pruneCache(args.pruneOlderThanMs);
      }
      const stats = cacheStats();
      const mb = (stats.bytes / 1_048_576).toFixed(1);
      const oldest = stats.oldest ? new Date(stats.oldest).toISOString() : 'n/a';
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Cached pages: ${stats.entries}\nDisk used: ${mb} MB\nOldest entry: ${oldest}` +
              (pruned ? `\nPruned: ${pruned} entries` : ''),
          },
        ],
      };
    },
  );
}
