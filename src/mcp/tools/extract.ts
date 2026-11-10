import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { scrape } from '../../core/scrape.js';
import {
  extractPatterns,
  extractWithSchema,
  generateSchema,
  PATTERN_KINDS,
  type ExtractionSchema,
  type FieldDef,
  type PatternKind,
  type SchemaExtractionResult,
} from '../../core/extract/schema.js';
import { generateLlmsTxt } from '../../core/llmstxt.js';
import { spillIfLarge } from '../../core/util/spill.js';
import type { RenderMode, ScrapeOptions } from '../../core/types.js';

/**
 * Rule-based extraction tools: schemas, built-in patterns, a schema generator,
 * llms.txt, and OCR. Not one of them calls a language model or needs a key.
 */

/* -------------------------------------------------------------------------- */
/* Shared input pieces                                                        */
/* -------------------------------------------------------------------------- */

const fetchInput = {
  render: z
    .enum(['auto', 'http', 'browser'])
    .optional()
    .describe('"auto" (default) escalates to a real browser only when the page needs JavaScript.'),
  maxAge: z.number().optional().describe('Serve from the local cache when the copy is younger than this many ms.'),
  timeout: z.number().optional().describe('Per-request timeout in ms.'),
  waitForSelector: z.string().optional().describe('Browser only: wait until this CSS selector appears.'),
  waitFor: z.number().optional().describe('Browser only: extra wait after load, in ms.'),
  headers: z.record(z.string(), z.string()).optional().describe('Extra request headers.'),
  proxy: z.string().optional().describe('Proxy URL, e.g. http://user:pass@host:port.'),
  mobile: z.boolean().optional().describe('Emulate a phone.'),
};

function fetchOptions(args: Record<string, unknown>): ScrapeOptions {
  return {
    render: args.render as RenderMode | undefined,
    maxAge: args.maxAge as number | undefined,
    timeout: args.timeout as number | undefined,
    waitForSelector: args.waitForSelector as string | undefined,
    waitFor: args.waitFor as number | undefined,
    headers: args.headers as Record<string, string> | undefined,
    proxy: args.proxy as string | undefined,
    mobile: args.mobile as boolean | undefined,
  };
}

/** Field shape, defined twice so `nested` can carry sub-fields without z.lazy. */
const leafFieldShape = {
  name: z.string().describe('Key this field gets in the output record.'),
  selector: z
    .string()
    .optional()
    .describe('Selector relative to the record element. Omit to read the record element itself.'),
  type: z
    .enum(['text', 'html', 'attribute', 'regex', 'number'])
    .optional()
    .describe('Default "text".'),
  attribute: z.string().optional().describe('Attribute to read, for type "attribute". URL attributes are made absolute.'),
  pattern: z.string().optional().describe('Regex source, for type "regex" (or to pre-slice a "number").'),
  flags: z.string().optional().describe('Regex flags.'),
  group: z.number().optional().describe('Capture group to keep. Default 0 (whole match).'),
  fromHtml: z.boolean().optional().describe('Run the regex over the element HTML instead of its text.'),
  all: z.boolean().optional().describe('Collect every match into an array instead of the first.'),
  transform: z
    .enum(['none', 'trim', 'lower', 'upper', 'absolute', 'collapse'])
    .optional()
    .describe('Post-processing. "absolute" resolves a relative URL.'),
  default: z.union([z.string(), z.number(), z.null()]).optional().describe('Value to use when nothing matched.'),
};

const leafField = z.object(leafFieldShape);

const anyField = z.object({
  ...leafFieldShape,
  type: z
    .enum(['text', 'html', 'attribute', 'regex', 'number', 'nested'])
    .optional()
    .describe('Default "text". "nested" reads a sub-schema out of each matched child element.'),
  fields: z.array(leafField).optional().describe('Sub-fields, required for type "nested".'),
});

const schemaShape = z.object({
  name: z.string().optional().describe('Label echoed back, so saved schemas stay identifiable.'),
  baseSelector: z
    .string()
    .optional()
    .describe('Selector for the repeating record container. Omit to treat the page as one record.'),
  engine: z.enum(['css', 'xpath']).optional().describe('Default "css". XPath runs against a repaired, namespace-free XML view of the page.'),
  fields: z.array(anyField).min(1).describe('Fields to pull out of each record.'),
  limit: z.number().optional().describe('Stop after this many records.'),
});

/* -------------------------------------------------------------------------- */
/* Formatting                                                                 */
/* -------------------------------------------------------------------------- */

function statTable(result: SchemaExtractionResult): string {
  if (result.fieldStats.length === 0) return '';
  const rows = result.fieldStats.map(
    (s) => `| ${s.name} | ${s.type} | \`${s.selector}\` | ${s.hits} | ${s.misses} |`,
  );
  return ['| field | type | selector | hits | misses |', '| --- | --- | --- | --- | --- |', ...rows].join('\n');
}

function formatSchemaResult(url: string, result: SchemaExtractionResult, spillLabel: string, maxChars?: number): string {
  const out: string[] = [];
  out.push(`# ${result.name ?? 'Schema extraction'}`);
  out.push(
    `<${url}> · ${result.engine} · base \`${result.baseSelector}\` · ` +
      `${result.baseMatches} base match(es) · ${result.records.length} record(s) · ${result.elapsedMs}ms`,
  );

  if (result.records.length === 0) {
    out.push('', '**Nothing was extracted.** Selectors tried:', '');
    out.push(`- base: \`${result.baseSelector}\` → ${result.baseMatches} match(es)`);
    for (const s of result.fieldStats) {
      out.push(`- field \`${s.name}\`: \`${s.selector}\` → ${s.hits} hit(s), ${s.misses} miss(es)`);
    }
    if (result.fieldStats.length === 0) out.push('- no field selector ran, because the base matched nothing');
    if (result.diagnostics.length) out.push('', ...result.diagnostics.map((d) => `⚠ ${d}`));
    out.push(
      '',
      'Next steps: check the selector against the real markup (`scrape` with formats:["rawHtml"]), ' +
        'use `generate_schema` to infer one, or add render:"browser" if the list is drawn by JavaScript.',
    );
    return out.join('\n');
  }

  const table = statTable(result);
  if (table) out.push('', table);
  if (result.diagnostics.length) out.push('', ...result.diagnostics.map((d) => `⚠ ${d}`));

  const json = JSON.stringify(result.records, null, 1);
  const spilled = spillIfLarge(json, maxChars, spillLabel);
  out.push('', '```json', spilled.text, '```');
  return out.join('\n');
}

/* -------------------------------------------------------------------------- */
/* Registration                                                              */
/* -------------------------------------------------------------------------- */

export function registerExtractTools(server: McpServer): void {
  server.registerTool(
    'extract_schema',
    {
      title: 'Extract records with a schema',
      description:
        'Pull structured records out of a page using a declarative CSS or XPath schema: name the repeating ' +
        'container, name the fields inside it. Field types: text, html, attribute, regex, number, nested. ' +
        'Relative URLs come back absolute. Free and deterministic — no model call, and the same schema can be ' +
        'reused on every page of the same template. Use `generate_schema` first if you do not know the selectors.',
      inputSchema: {
        url: z.string().describe('The http(s) URL to extract from.'),
        schema: schemaShape.optional().describe('The extraction schema.'),
        schemaJson: z
          .string()
          .optional()
          .describe('The same schema as a JSON string. Use this for sub-schemas nested more than one level deep.'),
        onlyMainContent: z
          .boolean()
          .optional()
          .describe('Default false: schemas usually target the full page, including lists outside the article body.'),
        maxChars: z.number().optional().describe('Cap the JSON returned; the overflow is written to a file.'),
        ...fetchInput,
      },
    },
    async (args) => {
      let schema: ExtractionSchema | undefined = args.schema as ExtractionSchema | undefined;
      if (!schema && typeof args.schemaJson === 'string') {
        try {
          schema = JSON.parse(args.schemaJson) as ExtractionSchema;
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `schemaJson is not valid JSON: ${String(err)}` }],
            isError: true,
          };
        }
      }
      if (!schema?.fields?.length) {
        return {
          content: [{ type: 'text' as const, text: 'Provide a `schema` (or `schemaJson`) with at least one field.' }],
          isError: true,
        };
      }

      const url = String(args.url);
      const page = await scrape(url, {
        ...fetchOptions(args as Record<string, unknown>),
        formats: ['rawHtml'],
        onlyMainContent: args.onlyMainContent === true,
      });

      if (!page.success || !page.rawHtml) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `FAILED ${url}\n${page.error ?? 'No HTML was returned, so there was nothing to run the schema against.'}`,
            },
          ],
          isError: true,
        };
      }

      try {
        const result = extractWithSchema(page.rawHtml, page.metadata.url, schema);
        return {
          content: [
            {
              type: 'text' as const,
              text: formatSchemaResult(page.metadata.url, result, `schema-${url}`, args.maxChars as number | undefined),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Schema could not be applied: ${String(err)}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'extract_patterns',
    {
      title: 'Extract with built-in patterns',
      description:
        'Run ready-made extractors over any page with no schema at all: emails, phone numbers, prices with ' +
        'currency, dates, URLs, social handles and postal codes. Values are validated (a 16-digit run that ' +
        'passes Luhn is a card, so it is kept out of the phone and price results) and each group reports how ' +
        'many candidates were rejected, so a thin result is not mistaken for an empty page.',
      inputSchema: {
        url: z.string().describe('The http(s) URL to scan.'),
        patterns: z
          .array(z.enum(PATTERN_KINDS))
          .optional()
          .describe(`Which extractors to run. Default all: ${PATTERN_KINDS.join(', ')}.`),
        onlyMainContent: z
          .boolean()
          .optional()
          .describe('Default false. Contact details usually live in the footer, which main-content extraction drops.'),
        limitPerPattern: z.number().optional().describe('Maximum distinct values per pattern. Default 50.'),
        ...fetchInput,
      },
    },
    async (args) => {
      const url = String(args.url);
      const page = await scrape(url, {
        ...fetchOptions(args as Record<string, unknown>),
        formats: ['rawHtml', 'text'],
        onlyMainContent: args.onlyMainContent === true,
      });

      if (!page.success || (!page.text && !page.rawHtml)) {
        return {
          content: [{ type: 'text' as const, text: `FAILED ${url}\n${page.error ?? 'Nothing was returned to scan.'}` }],
          isError: true,
        };
      }

      const groups = extractPatterns(
        { text: page.text ?? '', html: page.rawHtml ?? '', baseUrl: page.metadata.url },
        args.patterns as PatternKind[] | undefined,
        (args.limitPerPattern as number | undefined) ?? 50,
      );

      const out: string[] = [];
      out.push(`# Patterns · ${page.metadata.title ?? url}`);
      out.push(`<${page.metadata.url}> · ${page.metadata.statusCode} · ${page.metadata.renderedWith} · ${page.metadata.elapsedMs}ms`);

      for (const group of groups) {
        const head = `## ${group.kind} — ${group.hits.length} distinct / ${group.matches} match(es)${
          group.rejected ? `, ${group.rejected} rejected` : ''
        }`;
        out.push('', head, `_${group.describes}_`);
        if (group.hits.length === 0) {
          out.push(
            group.matches > 0
              ? `(every candidate failed validation — nothing reportable)`
              : `(no match on this page)`,
          );
          continue;
        }
        out.push(
          ...group.hits.map(
            (h) => `- ${h.value}${h.label ? ` [${h.label}]` : ''}${h.count > 1 ? ` ×${h.count}` : ''}`,
          ),
        );
      }

      return { content: [{ type: 'text' as const, text: out.join('\n') }] };
    },
  );

  server.registerTool(
    'generate_schema',
    {
      title: 'Infer a reusable extraction schema',
      description:
        'Look at a page and work out the schema for it: find the repeating container by comparing sibling ' +
        'elements for similar structure, then propose a selector per field. Deterministic structure analysis, ' +
        'no model call. Returns the schema, the containers it considered and why it picked one, plus a verified ' +
        'sample — save the schema and reuse it with `extract_schema` on every page of that template.',
      inputSchema: {
        url: z.string().describe('A representative listing page.'),
        description: z
          .string()
          .optional()
          .describe('Plain language for what the records are, e.g. "product cards with price and link". Its words are matched against class and id names.'),
        examples: z
          .array(z.string())
          .optional()
          .describe('A couple of values you can see on the page. Strongly anchors the container choice.'),
        minRecords: z.number().optional().describe('A container must repeat at least this many times. Default 3.'),
        maxFields: z.number().optional().describe('Cap on proposed fields. Default 8.'),
        ...fetchInput,
      },
    },
    async (args) => {
      const url = String(args.url);
      const page = await scrape(url, {
        ...fetchOptions(args as Record<string, unknown>),
        formats: ['rawHtml'],
        onlyMainContent: false,
      });

      if (!page.success || !page.rawHtml) {
        return {
          content: [
            { type: 'text' as const, text: `FAILED ${url}\n${page.error ?? 'No HTML was returned to analyse.'}` },
          ],
          isError: true,
        };
      }

      const generated = generateSchema(page.rawHtml, page.metadata.url, {
        description: args.description as string | undefined,
        examples: args.examples as string[] | undefined,
        minRecords: args.minRecords as number | undefined,
        maxFields: args.maxFields as number | undefined,
      });

      const out: string[] = [];
      out.push(`# Inferred schema · ${page.metadata.title ?? url}`);
      out.push(
        `<${page.metadata.url}> · confidence ${generated.confidence.toFixed(2)} · ` +
          `${generated.coverage.records} record(s) verified · ${generated.candidates.length} container(s) considered`,
      );

      if (generated.candidates.length) {
        out.push('', '| container | members | score | why |', '| --- | --- | --- | --- |');
        for (const c of generated.candidates) {
          out.push(`| \`${c.selector}\` | ${c.members} | ${c.score} | ${c.reasons.join(', ')} |`);
        }
      }

      if (generated.schema.fields.length === 0) {
        out.push('', '**No schema could be inferred.**');
        out.push(...generated.notes.map((n) => `⚠ ${n}`));
        return { content: [{ type: 'text' as const, text: out.join('\n') }] };
      }

      out.push('', '## Schema (save and reuse)', '', '```json', JSON.stringify(generated.schema, null, 1), '```');

      const cov = Object.entries(generated.coverage.perField);
      if (cov.length) {
        out.push(
          '',
          '## Field coverage',
          '',
          ...cov.map(([name, ratio]) => `- ${name}: ${Math.round(ratio * 100)}% of records`),
        );
      }

      if (generated.sample.length) {
        out.push('', '## Sample records', '', '```json', JSON.stringify(generated.sample, null, 1), '```');
      }
      if (generated.notes.length) out.push('', ...generated.notes.map((n) => `⚠ ${n}`));

      return { content: [{ type: 'text' as const, text: out.join('\n') }] };
    },
  );

  server.registerTool(
    'generate_llmstxt',
    {
      title: 'Generate llms.txt for a site',
      description:
        'Build the llms.txt file for a site: an H1 site name, a blockquote summary, then sections of ' +
        '"- [title](url): description" lines. Assembled from a site map plus a concurrent scrape of the top ' +
        'pages, so every title and description is the page\'s own — nothing is written by a model. Set ' +
        'full:true for the expanded llms-full.txt variant, which inlines each page\'s content.',
      inputSchema: {
        url: z.string().describe('Site root, e.g. https://example.com.'),
        limit: z.number().optional().describe('How many pages to include. Default 20.'),
        full: z.boolean().optional().describe('Also produce llms-full.txt with each page\'s content inlined.'),
        search: z.string().optional().describe('Bias page selection toward this topic.'),
        sitemapOnly: z
          .boolean()
          .optional()
          .describe('Use sitemaps only. Keeps the request count low on a site that publishes no sitemap.'),
        concurrency: z.number().optional().describe('Parallel scrapes.'),
        maxAge: z.number().optional().describe('Serve fetches from cache when younger than this (ms). Default 1 hour.'),
        maxCharsPerPage: z.number().optional().describe('Per-page cap inside llms-full.txt. Default 6000.'),
        maxChars: z.number().optional().describe('Cap the returned text; the overflow is written to a file.'),
        siteName: z.string().optional().describe('Override the H1 site name.'),
        summary: z.string().optional().describe('Override the blockquote summary.'),
        timeout: z.number().optional().describe('Per-request timeout in ms.'),
      },
    },
    async (args) => {
      const url = String(args.url);
      let result;
      try {
        result = await generateLlmsTxt(url, {
          limit: args.limit as number | undefined,
          full: args.full as boolean | undefined,
          search: args.search as string | undefined,
          sitemapOnly: args.sitemapOnly as boolean | undefined,
          concurrency: args.concurrency as number | undefined,
          maxAge: args.maxAge as number | undefined,
          maxCharsPerPage: args.maxCharsPerPage as number | undefined,
          siteName: args.siteName as string | undefined,
          summary: args.summary as string | undefined,
          timeout: args.timeout as number | undefined,
        });
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `FAILED ${url}\n${String(err)}` }],
          isError: true,
        };
      }

      const out: string[] = [];
      out.push(`# llms.txt · ${result.siteName}`);
      out.push(
        `<${result.url}> · ${result.mapped} url(s) mapped · ${result.scraped} scraped · ` +
          `${result.failed.length} failed · ${result.pages.length} listed · ${result.elapsedMs}ms`,
      );
      if (result.warning) out.push(`\n⚠ ${result.warning}`);
      if (result.failed.length) {
        out.push(
          '',
          ...result.failed.slice(0, 5).map((f) => `- failed: ${f.url} — ${f.error}`),
        );
      }

      const maxChars = args.maxChars as number | undefined;
      const short = spillIfLarge(result.llmstxt, maxChars, `llms-txt-${result.siteName}`);
      out.push('', '## llms.txt', '', '```markdown', short.text, '```');

      if (result.llmsfull) {
        const full = spillIfLarge(result.llmsfull, maxChars ?? 20000, `llms-full-${result.siteName}`);
        out.push('', '## llms-full.txt', '', '```markdown', full.text, '```');
      }

      return { content: [{ type: 'text' as const, text: out.join('\n') }] };
    },
  );

  server.registerTool(
    'ocr',
    {
      title: 'OCR a scanned PDF or an image',
      description:
        'Read text out of a scanned PDF or an image with tesseract.js — locally, with no API key. Slow (tens ' +
        'of seconds per page), so it is opt-in and page-capped. Accepts a local path or a URL. If the OCR ' +
        'engine or its language data is unavailable, it says so and explains how to fix it instead of failing.',
      inputSchema: {
        path: z.string().optional().describe('Absolute path to a local PDF or image.'),
        url: z.string().optional().describe('URL of a PDF or image to fetch and OCR.'),
        language: z.string().optional().describe('tesseract language code(s), e.g. "eng", "eng+deu". Default "eng".'),
        maxPages: z.number().optional().describe('Cap the PDF pages processed. Default 5.'),
        minConfidence: z.number().optional().describe('Drop pages below this mean confidence (0-100).'),
        maxChars: z.number().optional().describe('Cap the returned text; the overflow is written to a file.'),
      },
    },
    async (args) => {
      const { ocrImage, ocrPdf, ocrAvailable } = await import('../../core/extract/ocr.js');
      const probe = await ocrAvailable();
      if (!probe.available) {
        return {
          content: [{ type: 'text' as const, text: `OCR is not available.\n${probe.message ?? ''}` }],
          isError: true,
        };
      }

      let data: Buffer;
      let label: string;
      if (typeof args.path === 'string' && args.path) {
        const { readFile } = await import('node:fs/promises');
        try {
          data = await readFile(args.path);
          label = args.path;
        } catch (err) {
          return { content: [{ type: 'text' as const, text: `Could not read ${args.path}: ${String(err)}` }], isError: true };
        }
      } else if (typeof args.url === 'string' && args.url) {
        const { fetchPage } = await import('../../core/fetcher/index.js');
        try {
          const outcome = await fetchPage(args.url, { render: 'http' });
          data = outcome.page.body;
          label = outcome.page.finalUrl || args.url;
        } catch (err) {
          return { content: [{ type: 'text' as const, text: `Could not fetch ${args.url}: ${String(err)}` }], isError: true };
        }
      } else {
        return { content: [{ type: 'text' as const, text: 'Give either `path` or `url`.' }], isError: true };
      }

      const isPdf = data.subarray(0, 5).toString('latin1') === '%PDF-';
      const result = isPdf
        ? await ocrPdf(data, {
            language: args.language as string | undefined,
            maxPages: args.maxPages as number | undefined,
            minConfidence: args.minConfidence as number | undefined,
          })
        : await ocrImage(data, { language: args.language as string | undefined });

      const head = [
        `# OCR · ${label.split(/[\\/]/).pop()}`,
        `${isPdf ? 'pdf' : 'image'} · ${data.byteLength} bytes · ${result.pages.length} page(s) · ` +
          `${result.engine ?? 'tesseract.js'} · ${result.elapsedMs}ms`,
        result.message ? `\n⚠ ${result.message}` : '',
      ]
        .filter(Boolean)
        .join('\n');

      if (!result.text) {
        return { content: [{ type: 'text' as const, text: `${head}\n\nNo text was recognised.` }], isError: !result.available };
      }

      const body = spillIfLarge(result.text, args.maxChars as number | undefined, `ocr-${label}`);
      const confidences = result.pages.map((p) => `p${p.page}:${p.confidence}%`).join(' ');
      return {
        content: [{ type: 'text' as const, text: `${head}\nconfidence ${confidences}\n\n${body.text}` }],
      };
    },
  );
}

/** Re-exported so callers can build schemas programmatically without digging. */
export type { ExtractionSchema, FieldDef };
