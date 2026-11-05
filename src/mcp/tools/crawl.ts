import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { map } from '../../core/map.js';
import { peekRobots } from '../../core/discover/robots.js';
import {
  cancelJob,
  isRunning,
  resumeJob,
  startBatch,
  startCrawl,
  startRecrawl,
  type CrawlOptions,
} from '../../core/crawl/engine.js';
import {
  deleteJob,
  ftsAvailable,
  getJob,
  getPages,
  iteratePages,
  listJobs,
  pageCount,
  recrawlCounts,
  searchCorpus,
} from '../../core/crawl/store.js';
import type { ScrapeFormat, ScrapeOptions } from '../../core/types.js';

function human(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Shared scrape knobs for crawl and batch, kept small on purpose. */
const scrapeSubset = {
  formats: z
    .array(z.enum(['markdown', 'html', 'rawHtml', 'links', 'summary', 'json', 'text']))
    .optional()
    .describe('Formats to capture per page. Default ["markdown"]. "links" is always added when following links.'),
  onlyMainContent: z.boolean().optional().describe('Strip nav/header/footer. Default true.'),
  maxChars: z.number().optional().describe('Cap characters stored per page.'),
  maxAge: z.number().optional().describe('Reuse cached fetches younger than this (ms).'),
  render: z.enum(['auto', 'http', 'browser']).optional().describe('Default "auto".'),
  timeout: z.number().optional(),
  fitMarkdown: z.boolean().optional().describe('Prune boilerplate blocks from each page.'),
  redactPII: z.boolean().optional().describe('Mask emails, phones, cards and national IDs.'),
};

function toScrapeOptions(args: Record<string, unknown>): ScrapeOptions {
  return {
    formats: args.formats as ScrapeFormat[] | undefined,
    onlyMainContent: args.onlyMainContent as boolean | undefined,
    maxChars: args.maxChars as number | undefined,
    maxAge: args.maxAge as number | undefined,
    render: args.render as ScrapeOptions['render'],
    timeout: args.timeout as number | undefined,
    fitMarkdown: args.fitMarkdown as boolean | undefined,
    redactPII: args.redactPII as boolean | undefined,
  };
}

function statusReport(jobId: string, includePages: boolean, pageLimit: number, pageChars?: number): string {
  const job = getJob(jobId);
  if (!job) return `No job with id ${jobId}.`;

  const c = job.counts;
  const stored = pageCount(jobId);
  const live = isRunning(jobId);
  const seconds = ((job.finishedAt ?? Date.now()) - job.createdAt) / 1000;

  const lines = [
    `# ${job.kind} ${job.id}`,
    `${job.rootUrl} · ${job.status}${live ? ' (active)' : ''} · ${seconds.toFixed(1)}s`,
    `pages stored: ${stored} · done ${c.completed} · pending ${human(c.pending)} · skipped ${c.skipped} · failed ${c.failed} · discovered ${human(c.discovered)}`,
  ];
  // Why the job ended as it did, when there is something to say. An adaptive
  // crawl that stopped at page 12 of 500 needs this line to make sense.
  if (job.note) lines.push(job.note);

  const rc = recrawlCounts(jobId);
  if (rc.changed > 0 || rc.unchanged > 0) {
    lines.push(`last pass: ${rc.changed} changed · ${rc.unchanged} unchanged (304)`);
  }

  const robots = peekRobots(job.rootUrl);
  if (robots && robots.crawlDelayMs > 0) {
    const seconds = (robots.crawlDelayMs / 1000).toFixed(0);
    lines.push(
      `politeness: this site's robots.txt declares Crawl-delay ${seconds}s, so pages are fetched ` +
        `one every ${seconds}s per host. Slow by design, not stuck.`,
    );
  }
  if (job.error) lines.push(`\n⚠ ${job.error}`);
  if (job.status === 'interrupted') {
    lines.push('\n⚠ This job was interrupted by a server restart. Call crawl_resume to continue it.');
  }

  if (includePages) {
    const pages = getPages(jobId, { limit: pageLimit, includeMarkdown: true, maxChars: pageChars ?? 2000 });
    if (pages.length === 0) {
      lines.push('\nNo pages stored yet.');
    } else {
      lines.push(`\n## Pages (${pages.length} of ${stored})`);
      for (const page of pages) {
        lines.push(`\n### ${page.title ?? '(untitled)'}\n<${page.url}> · depth ${page.depth} · ${human(page.chars ?? 0)} chars`);
        if (page.markdown) lines.push(`\n${page.markdown}`);
      }
    }
  } else {
    const pages = getPages(jobId, { limit: pageLimit });
    if (pages.length) {
      lines.push(`\n## Pages (${pages.length} of ${stored})\n`);
      for (const page of pages) {
        lines.push(`- d${page.depth} ${human(page.chars ?? 0)}ch — ${page.title ?? '(untitled)'} <${page.url}>`);
      }
      if (stored > pages.length) {
        lines.push(`\n_Use crawl_status with includeContent:true and offset to read the page text._`);
      }
    }
  }

  return lines.join('\n');
}

export function registerCrawlTools(server: McpServer): void {
  /* ---------------------------------------------------------------- */
  server.registerTool(
    'map',
    {
      title: 'Map a site',
      description:
        "List a site's URLs fast. Reads robots.txt and sitemaps first (one or two requests can reveal thousands of pages) " +
        'and only follows links when sitemaps come back thin. Use `search` to rank the URLs by relevance — the quickest ' +
        'way to find the right page on a large site before scraping it.',
      inputSchema: {
        url: z.string().describe('Site or page URL to map.'),
        search: z.string().optional().describe('Rank and filter the URLs by relevance to this text.'),
        limit: z.number().optional().describe('Maximum URLs to return. Default 2000.'),
        includePaths: z.array(z.string()).optional().describe('Regexes; a URL path must match one of these.'),
        excludePaths: z.array(z.string()).optional().describe('Regexes; matching paths are dropped.'),
        allowSubdomains: z.boolean().optional().describe('Include sub.example.com. Default false.'),
        ignoreSitemap: z.boolean().optional().describe('Skip sitemaps and discover by following links.'),
        sitemapOnly: z.boolean().optional().describe('Use sitemaps only, never follow links.'),
        maxDepth: z.number().optional().describe('Link-following depth when discovering. Default 2.'),
        maxAge: z.number().optional().describe('Reuse cached fetches younger than this (ms).'),
        respectRobots: z.boolean().optional().describe('Obey robots.txt. Default true.'),
      },
    },
    async (args) => {
      const result = await map(String(args.url), {
        search: args.search as string | undefined,
        limit: args.limit as number | undefined,
        includePaths: args.includePaths as string[] | undefined,
        excludePaths: args.excludePaths as string[] | undefined,
        allowSubdomains: args.allowSubdomains as boolean | undefined,
        ignoreSitemap: args.ignoreSitemap as boolean | undefined,
        sitemapOnly: args.sitemapOnly as boolean | undefined,
        maxDepth: args.maxDepth as number | undefined,
        maxAge: args.maxAge as number | undefined,
        respectRobots: args.respectRobots as boolean | undefined,
      });

      const header = [
        `# Map of ${result.url}`,
        `${result.total} URLs found (showing ${result.links.length}) · ${result.elapsedMs}ms · ` +
          `sitemap ${result.sources.sitemapUrls} from ${result.sources.sitemapsFetched} file(s) · ` +
          `crawled ${result.sources.crawledPages} page(s)` +
          (result.robotsMissing ? ' · no robots.txt' : ''),
      ];
      if (result.warning) header.push(`\n⚠ ${result.warning}`);

      const body = result.links.map((l) => {
        const score = l.score !== undefined ? ` (${l.score.toFixed(1)})` : '';
        const title = l.title ? ` — ${l.title.slice(0, 70)}` : '';
        return `- ${l.url}${score}${title}`;
      });

      return { content: [{ type: 'text' as const, text: [...header, '', ...body].join('\n') }] };
    },
  );

  /* ---------------------------------------------------------------- */
  server.registerTool(
    'crawl',
    {
      title: 'Crawl a site',
      description:
        'Walk a site and capture every page as markdown. Runs as a background job: returns a job id immediately, or ' +
        'waits up to `waitSeconds` for small crawls. Poll with crawl_status. Set `query` to crawl best-first, so a ' +
        'page limit is spent on the pages most likely to matter instead of the first ones in link order.',
      inputSchema: {
        url: z.string().describe('Starting URL.'),
        limit: z.number().optional().describe('Maximum pages to fetch. Default 100.'),
        maxDepth: z.number().optional().describe('Link depth to follow. Default 3.'),
        strategy: z
          .enum(['bfs', 'dfs', 'best-first'])
          .optional()
          .describe('Frontier order. Defaults to best-first when `query` is set, otherwise bfs.'),
        query: z.string().optional().describe('Steers best-first ordering and filters each page to the relevant part.'),
        includePaths: z.array(z.string()).optional().describe('Regexes; a URL path must match one of these.'),
        excludePaths: z.array(z.string()).optional().describe('Regexes; matching paths are dropped.'),
        allowSubdomains: z.boolean().optional().describe('Follow links to subdomains. Default false.'),
        allowExternal: z.boolean().optional().describe('Follow links off the domain entirely. Default false.'),
        allowBackwardLinks: z.boolean().optional().describe('Follow links above the starting path. Default true.'),
        concurrency: z.number().optional().describe('Max pages in flight. Adapts to free memory.'),
        perHostConcurrency: z.number().optional().describe('Max pages in flight per host. Default 3.'),
        delayMs: z.number().optional().describe('Minimum gap between requests to one host. robots Crawl-delay wins if larger.'),
        respectRobots: z.boolean().optional().describe('Obey robots.txt. Default true.'),
        deduplicateContent: z.boolean().optional().describe('Skip pages identical to one already stored. Default true.'),
        adaptive: z
          .boolean()
          .optional()
          .describe(
            'Stop as soon as the query looks answered, instead of running to limit. Needs query. Reports why it stopped, including when it gave up without an answer.',
          ),
        adaptivePatience: z
          .number()
          .optional()
          .describe('Pages in a row adding nothing before adaptive gives up. Default 6.'),
        webhookUrl: z.string().optional().describe('POST progress events here.'),
        webhookSecret: z.string().optional().describe('Sign webhook bodies with HMAC-SHA256.'),
        waitSeconds: z.number().optional().describe('Wait up to this long for the crawl to finish before returning. Default 0.'),
        ...scrapeSubset,
      },
    },
    async (args) => {
      const options: CrawlOptions = {
        limit: args.limit as number | undefined,
        maxDepth: args.maxDepth as number | undefined,
        strategy: args.strategy as CrawlOptions['strategy'],
        query: args.query as string | undefined,
        includePaths: args.includePaths as string[] | undefined,
        excludePaths: args.excludePaths as string[] | undefined,
        allowSubdomains: args.allowSubdomains as boolean | undefined,
        allowExternal: args.allowExternal as boolean | undefined,
        allowBackwardLinks: args.allowBackwardLinks as boolean | undefined,
        concurrency: args.concurrency as number | undefined,
        perHostConcurrency: args.perHostConcurrency as number | undefined,
        delayMs: args.delayMs as number | undefined,
        respectRobots: args.respectRobots as boolean | undefined,
        deduplicateContent: args.deduplicateContent as boolean | undefined,
        adaptive: args.adaptive as boolean | undefined,
        adaptivePatience: args.adaptivePatience as number | undefined,
        scrapeOptions: toScrapeOptions(args as Record<string, unknown>),
        webhook: args.webhookUrl
          ? { url: String(args.webhookUrl), secret: args.webhookSecret as string | undefined }
          : undefined,
      };

      let jobId: string;
      try {
        jobId = startCrawl(String(args.url), options);
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Could not start crawl: ${String(err)}` }], isError: true };
      }

      const waitMs = Math.max(0, Number(args.waitSeconds ?? 0)) * 1000;
      const deadline = Date.now() + waitMs;
      while (waitMs > 0 && isRunning(jobId) && Date.now() < deadline) {
        await sleep(300);
      }

      const stillRunning = isRunning(jobId);
      const report = statusReport(jobId, false, 50);
      const tail = stillRunning
        ? `\n\n_Still crawling. Poll with crawl_status({jobId: "${jobId}"})._`
        : `\n\n_Finished. Read page text with crawl_status({jobId: "${jobId}", includeContent: true})._`;

      return { content: [{ type: 'text' as const, text: report + tail }] };
    },
  );

  /* ---------------------------------------------------------------- */
  server.registerTool(
    'batch_scrape',
    {
      title: 'Scrape many URLs',
      description:
        'Scrape a list of URLs as one background job, with adaptive concurrency and per-host politeness. ' +
        'Use this instead of calling scrape in a loop.',
      inputSchema: {
        urls: z.array(z.string()).describe('URLs to scrape.'),
        concurrency: z.number().optional().describe('Max pages in flight. Adapts to free memory.'),
        perHostConcurrency: z.number().optional().describe('Max pages in flight per host. Default 3.'),
        respectRobots: z.boolean().optional().describe('Obey robots.txt. Default true.'),
        query: z.string().optional().describe('Filter every page to the parts relevant to this question.'),
        waitSeconds: z.number().optional().describe('Wait up to this long before returning. Default 0.'),
        webhookUrl: z.string().optional(),
        webhookSecret: z.string().optional(),
        ...scrapeSubset,
      },
    },
    async (args) => {
      const urls = (args.urls as string[]) ?? [];
      let jobId: string;
      try {
        jobId = startBatch(urls, {
          concurrency: args.concurrency as number | undefined,
          perHostConcurrency: args.perHostConcurrency as number | undefined,
          respectRobots: args.respectRobots as boolean | undefined,
          query: args.query as string | undefined,
          scrapeOptions: toScrapeOptions(args as Record<string, unknown>),
          webhook: args.webhookUrl
            ? { url: String(args.webhookUrl), secret: args.webhookSecret as string | undefined }
            : undefined,
        });
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Could not start batch: ${String(err)}` }], isError: true };
      }

      const waitMs = Math.max(0, Number(args.waitSeconds ?? 0)) * 1000;
      const deadline = Date.now() + waitMs;
      while (waitMs > 0 && isRunning(jobId) && Date.now() < deadline) {
        await sleep(300);
      }

      const tail = isRunning(jobId)
        ? `\n\n_Still running. Poll with crawl_status({jobId: "${jobId}"})._`
        : `\n\n_Finished. Read page text with crawl_status({jobId: "${jobId}", includeContent: true})._`;

      return { content: [{ type: 'text' as const, text: statusReport(jobId, false, urls.length) + tail }] };
    },
  );

  /* ---------------------------------------------------------------- */
  server.registerTool(
    'crawl_status',
    {
      title: 'Crawl status and results',
      description: 'Progress and captured pages for a crawl or batch job. Set includeContent to read the page markdown.',
      inputSchema: {
        jobId: z.string().describe('Job id returned by crawl or batch_scrape.'),
        includeContent: z.boolean().optional().describe('Include each page\'s markdown. Default false.'),
        limit: z.number().optional().describe('How many pages to list. Default 50 (10 with content).'),
        offset: z.number().optional().describe('Skip this many pages, for paging through a large crawl.'),
        maxCharsPerPage: z.number().optional().describe('Cap markdown per page. Default 2000.'),
      },
    },
    async (args) => {
      const includeContent = Boolean(args.includeContent);
      const limit = Number(args.limit ?? (includeContent ? 10 : 50));
      const offset = Number(args.offset ?? 0);
      const jobId = String(args.jobId);

      const job = getJob(jobId);
      if (!job) {
        return { content: [{ type: 'text' as const, text: `No job with id ${jobId}.` }], isError: true };
      }

      if (offset > 0) {
        const pages = getPages(jobId, {
          limit,
          offset,
          includeMarkdown: includeContent,
          maxChars: Number(args.maxCharsPerPage ?? 2000),
        });
        const stored = pageCount(jobId);
        const lines = [`# ${job.id} pages ${offset}–${offset + pages.length} of ${stored}`];
        for (const page of pages) {
          lines.push(`\n### ${page.title ?? '(untitled)'}\n<${page.url}> · depth ${page.depth} · ${human(page.chars ?? 0)} chars`);
          if (page.markdown) lines.push(`\n${page.markdown}`);
        }
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: statusReport(jobId, includeContent, limit, Number(args.maxCharsPerPage ?? 2000)),
          },
        ],
      };
    },
  );

  /* ---------------------------------------------------------------- */
  server.registerTool(
    'crawl_jobs',
    {
      title: 'List crawl jobs',
      description:
        'Every crawl and batch job this server knows about, newest first. Jobs survive a restart, so an interrupted ' +
        'crawl can be resumed rather than started over.',
      inputSchema: {
        limit: z.number().optional().describe('How many jobs to list. Default 20.'),
      },
    },
    async (args) => {
      const jobs = listJobs(Number(args.limit ?? 20));
      if (jobs.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No crawl jobs yet.' }] };
      }
      const lines = jobs.map((job) => {
        const live = isRunning(job.id) ? ' (active)' : '';
        const when = new Date(job.createdAt).toISOString().replace('T', ' ').slice(0, 16);
        return `- ${job.id} · ${job.status}${live} · ${job.counts.completed} pages · ${when} · ${job.rootUrl}`;
      });
      return { content: [{ type: 'text' as const, text: `# Crawl jobs (${jobs.length})\n\n${lines.join('\n')}` }] };
    },
  );

  /* ---------------------------------------------------------------- */
  server.registerTool(
    'crawl_control',
    {
      title: 'Cancel, resume or delete a job',
      description: 'Stop a running crawl, resume one interrupted by a restart, or delete a job and its stored pages.',
      inputSchema: {
        jobId: z.string().describe('Job id.'),
        action: z
          .enum(['cancel', 'resume', 'delete', 'recrawl'])
          .describe(
            'What to do. "recrawl" refetches the URLs this job already found, using ETag revalidation so unchanged pages cost almost nothing.',
          ),
        discover: z
          .boolean()
          .optional()
          .describe('For "recrawl": also follow links again to pick up new pages. Default false.'),
      },
    },
    async (args) => {
      const jobId = String(args.jobId);
      const action = String(args.action);

      if (!getJob(jobId)) {
        return { content: [{ type: 'text' as const, text: `No job with id ${jobId}.` }], isError: true };
      }

      if (action === 'recrawl') {
        const requeued = startRecrawl(jobId, { discover: Boolean(args.discover) });
        if (requeued === null) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `${jobId} cannot be re-crawled right now (it may still be running).`,
              },
            ],
            isError: true,
          };
        }
        if (requeued === 0) {
          return {
            content: [
              { type: 'text' as const, text: `${jobId} has no finished URLs to re-crawl.` },
            ],
          };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `Re-crawling ${requeued} URL(s) from ${jobId} with ETag revalidation. ` +
                `Unchanged pages answer 304 and are left as they are. Poll with crawl_status.`,
            },
          ],
        };
      }

      if (action === 'cancel') {
        cancelJob(jobId);
        return { content: [{ type: 'text' as const, text: `Cancelled ${jobId}. Pages already captured are kept.` }] };
      }
      if (action === 'resume') {
        const ok = resumeJob(jobId);
        return {
          content: [
            {
              type: 'text' as const,
              text: ok
                ? `Resumed ${jobId}. Poll with crawl_status.`
                : `${jobId} cannot be resumed (it is already completed or cancelled).`,
            },
          ],
          isError: !ok,
        };
      }
      deleteJob(jobId);
      return { content: [{ type: 'text' as const, text: `Deleted ${jobId} and its stored pages.` }] };
    },
  );

  /* ---------------------------------------------------------------- */
  server.registerTool(
    'crawl_export',
    {
      title: 'Export a crawl to a file',
      description:
        'Write a finished crawl to disk as JSONL, CSV or a single Markdown bundle. Use this instead of paging ' +
        'thousands of pages through the conversation: the crawl stays on your machine and you get a file to feed ' +
        'to whatever comes next.',
      inputSchema: {
        jobId: z.string().describe('Job id to export.'),
        format: z.enum(['jsonl', 'csv', 'markdown']).optional().describe('Default "jsonl".'),
        path: z
          .string()
          .optional()
          .describe('Output file path. Defaults to a file in the OpenScrape data directory.'),
        includeContent: z
          .boolean()
          .optional()
          .describe('Include the page markdown. Default true. CSV keeps it on one line.'),
      },
    },
    async (args) => {
      const jobId = String(args.jobId);
      const job = getJob(jobId);
      if (!job) {
        return { content: [{ type: 'text' as const, text: `No job with id ${jobId}.` }], isError: true };
      }

      const format = (args.format as 'jsonl' | 'csv' | 'markdown' | undefined) ?? 'jsonl';
      const withContent = args.includeContent !== false;
      const total = pageCount(jobId);
      if (total === 0) {
        return { content: [{ type: 'text' as const, text: `${jobId} has no stored pages to export.` }] };
      }

      const { createWriteStream, mkdirSync } = await import('node:fs');
      const { join, dirname } = await import('node:path');
      const { EXPORTS_DIR } = await import('../../core/util/paths.js');

      const ext = format === 'markdown' ? 'md' : format;
      const outPath = args.path ? String(args.path) : join(EXPORTS_DIR, `${jobId}.${ext}`);
      try {
        mkdirSync(dirname(outPath), { recursive: true });
      } catch {
        /* directory may already exist */
      }

      const stream = createWriteStream(outPath, { encoding: 'utf8' });
      const write = (chunk: string) =>
        new Promise<void>((resolve, reject) => {
          stream.write(chunk, (err) => (err ? reject(err) : resolve()));
        });

      let written = 0;
      try {
        if (format === 'csv') {
          const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
          await write(
            ['url', 'title', 'description', 'status', 'depth', 'chars', 'fetched_at']
              .concat(withContent ? ['markdown'] : [])
              .join(',') + '\n',
          );
          for (const batch of iteratePages(jobId)) {
            for (const page of batch) {
              const row = [
                cell(page.url),
                cell(page.title),
                cell(page.description),
                cell(page.status),
                cell(page.depth),
                cell(page.chars),
                cell(page.fetchedAt ? new Date(page.fetchedAt).toISOString() : ''),
              ];
              if (withContent) row.push(cell(page.markdown));
              await write(row.join(',') + '\n');
              written++;
            }
          }
        } else if (format === 'markdown') {
          await write(`# ${job.rootUrl}\n\nCrawled ${total} pages · job ${jobId}\n`);
          for (const batch of iteratePages(jobId)) {
            for (const page of batch) {
              await write(`\n\n---\n\n## ${page.title ?? '(untitled)'}\n\n<${page.url}>\n`);
              if (withContent && page.markdown) await write(`\n${page.markdown}\n`);
              written++;
            }
          }
        } else {
          for (const batch of iteratePages(jobId)) {
            for (const page of batch) {
              const record: Record<string, unknown> = {
                url: page.url,
                title: page.title,
                description: page.description,
                statusCode: page.status,
                depth: page.depth,
                chars: page.chars,
                fetchedAt: page.fetchedAt ? new Date(page.fetchedAt).toISOString() : undefined,
              };
              if (withContent) record.markdown = page.markdown;
              await write(JSON.stringify(record) + '\n');
              written++;
            }
          }
        }
      } catch (err) {
        stream.destroy();
        return {
          content: [{ type: 'text' as const, text: `Export failed after ${written} page(s): ${String(err)}` }],
          isError: true,
        };
      }

      await new Promise<void>((resolve) => stream.end(resolve));
      const { statSync } = await import('node:fs');
      const size = statSync(outPath).size;

      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Exported ${written} page(s) from ${jobId} as ${format}.\n` +
              `${outPath}\n${(size / 1_048_576).toFixed(2)} MB`,
          },
        ],
      };
    },
  );

  /* ---------------------------------------------------------------- */
  server.registerTool(
    'corpus_search',
    {
      title: 'Search crawled pages',
      description:
        'Full-text search across every page crawled so far, on this machine. Once a site has been crawled, asking ' +
        'questions of it costs one local query instead of re-fetching anything. Supports SQLite FTS5 syntax: ' +
        'quoted phrases, OR, NEAR and prefix* matching.',
      inputSchema: {
        query: z.string().describe('FTS5 query, e.g. pricing OR credits, or "pay as you go".'),
        jobId: z.string().optional().describe('Restrict to one crawl job.'),
        limit: z.number().optional().describe('Maximum hits. Default 20.'),
      },
    },
    async (args) => {
      if (!ftsAvailable()) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Full-text search is unavailable: this Node build has no SQLite FTS5 support.',
            },
          ],
          isError: true,
        };
      }

      const hits = searchCorpus(String(args.query), {
        jobId: args.jobId as string | undefined,
        limit: Number(args.limit ?? 20),
      });

      if (hits.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No matches for "${String(args.query)}" in the crawled corpus. Crawl a site first, or widen the query.`,
            },
          ],
        };
      }

      const lines = hits.map((hit, i) => {
        const title = hit.title ? ` — ${hit.title.slice(0, 70)}` : '';
        return `${i + 1}. <${hit.url}>${title}\n   ${hit.snippet.slice(0, 300)}`;
      });
      return {
        content: [{ type: 'text' as const, text: `# ${hits.length} matches\n\n${lines.join('\n\n')}` }],
      };
    },
  );
}
