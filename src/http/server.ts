import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { scrape } from '../core/scrape.js';
import { map } from '../core/map.js';
import { parseDocument } from '../core/parse/documents.js';
import {
  cancelJob,
  isRunning,
  startBatch,
  startCrawl,
  type CrawlOptions,
} from '../core/crawl/engine.js';
import { getJob, getPages, pageCount } from '../core/crawl/store.js';
import { cacheStats } from '../core/cache/store.js';
import { checkUrlReachability } from '../core/util/ssrf.js';
import { log } from '../core/util/log.js';
import type { ScrapeFormat, ScrapeOptions } from '../core/types.js';

/**
 * A Firecrawl-shaped REST API over the same local engine.
 *
 * The point is drop-in compatibility: Firecrawl's own SDKs and its official MCP
 * server both accept a base-URL override, so pointing them here makes existing
 * code and tooling run against this machine instead of the paid service. The
 * response envelopes deliberately mirror theirs (`{success, data}`,
 * `{success, id}`, `{status, completed, total, data}`).
 *
 * This is optional — the MCP server is the primary interface and does not need
 * this process running.
 */

const MAX_BODY_BYTES = 2 * 1024 * 1024;

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  body: Record<string, unknown>;
  path: string;
  method: string;
  cfg: { allowPrivateTargets: boolean; allowLocalFileParse: boolean };
}

/**
 * Every URL arriving over the network is checked before we fetch it, so the
 * API cannot be used as a proxy into the private network it runs in.
 * Returns true when the request has already been refused.
 */
async function refusedForSsrf(ctx: Ctx, url: string): Promise<boolean> {
  if (ctx.cfg.allowPrivateTargets) return false;
  const verdict = await checkUrlReachability(url);
  if (verdict.ok) return false;
  fail(ctx.res, 400, `Refusing to fetch ${url}: ${verdict.reason}.`);
  return true;
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function fail(res: ServerResponse, status: number, error: string): void {
  send(res, status, { success: false, error });
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).byteLength;
    if (size > MAX_BODY_BYTES) throw new Error('Request body too large.');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new Error('Request body is not valid JSON.');
  }
}

/** Translates a Firecrawl-style request body into our ScrapeOptions. */
function toScrapeOptions(body: Record<string, unknown>): ScrapeOptions {
  const rawFormats = body.formats;
  const formats = Array.isArray(rawFormats)
    ? (rawFormats
        .map((f) => (typeof f === 'string' ? f : (f as { type?: string })?.type))
        .filter(Boolean) as ScrapeFormat[])
    : undefined;

  const queryOptions = body.queryOptions as { prompt?: string } | undefined;

  return {
    formats,
    onlyMainContent: body.onlyMainContent as boolean | undefined,
    includeTags: body.includeTags as string[] | undefined,
    excludeTags: body.excludeTags as string[] | undefined,
    maxAge: body.maxAge as number | undefined,
    storeInCache: body.storeInCache as boolean | undefined,
    timeout: body.timeout as number | undefined,
    waitFor: body.waitFor as number | undefined,
    mobile: body.mobile as boolean | undefined,
    headers: body.headers as Record<string, string> | undefined,
    proxy: body.proxy as string | undefined,
    maxChars: body.maxChars as number | undefined,
    redactPII: body.redactPII as boolean | undefined,
    zeroDataRetention: body.zeroDataRetention as boolean | undefined,
    fitMarkdown: body.fitMarkdown as boolean | undefined,
    citations: body.citations as boolean | undefined,
    query: (body.query as string | undefined) ?? queryOptions?.prompt,
    render: body.render as ScrapeOptions['render'],
    actions: body.actions as ScrapeOptions['actions'],
  };
}

function toCrawlOptions(body: Record<string, unknown>): CrawlOptions {
  const scrapeOptions = body.scrapeOptions as Record<string, unknown> | undefined;
  return {
    limit: body.limit as number | undefined,
    maxDepth: (body.maxDepth ?? body.maxDiscoveryDepth) as number | undefined,
    strategy: body.strategy as CrawlOptions['strategy'],
    query: body.query as string | undefined,
    includePaths: body.includePaths as string[] | undefined,
    excludePaths: body.excludePaths as string[] | undefined,
    allowSubdomains: (body.allowSubdomains ?? body.crawlEntireDomain) as boolean | undefined,
    allowExternal: body.allowExternalLinks as boolean | undefined,
    allowBackwardLinks: body.allowBackwardLinks as boolean | undefined,
    concurrency: body.concurrency as number | undefined,
    perHostConcurrency: body.perHostConcurrency as number | undefined,
    delayMs: body.delay as number | undefined,
    respectRobots: (body.respectRobots ?? body.ignoreRobotsTxt === undefined
      ? undefined
      : !body.ignoreRobotsTxt) as boolean | undefined,
    deduplicateContent: body.deduplicateSimilarURLs as boolean | undefined,
    scrapeOptions: scrapeOptions ? toScrapeOptions(scrapeOptions) : undefined,
    webhook:
      typeof body.webhook === 'string'
        ? { url: body.webhook }
        : (body.webhook as CrawlOptions['webhook']),
  };
}

/* ------------------------------------------------------------------ */
/* Routes                                                             */
/* ------------------------------------------------------------------ */

async function routeScrape(ctx: Ctx): Promise<void> {
  const { res, body } = ctx;
  const url = body.url;
  if (typeof url !== 'string') return fail(res, 400, 'A "url" string is required.');
  if (await refusedForSsrf(ctx, url)) return;

  const result = await scrape(url, toScrapeOptions(body));
  if (!result.success && result.error) {
    return send(res, 200, { success: false, error: result.error, data: null });
  }

  send(res, 200, {
    success: true,
    data: {
      markdown: result.markdown,
      html: result.html,
      rawHtml: result.rawHtml,
      links: result.links,
      images: result.images,
      summary: result.summary,
      json: result.json,
      query: result.query,
      screenshot: result.screenshot,
      references: result.references,
      metadata: result.metadata,
      warning: result.warning,
    },
  });
}

async function routeMap(ctx: Ctx): Promise<void> {
  const { res, body } = ctx;
  const url = body.url;
  if (typeof url !== 'string') return fail(res, 400, 'A "url" string is required.');
  if (await refusedForSsrf(ctx, url)) return;

  const result = await map(url, {
    search: body.search as string | undefined,
    limit: body.limit as number | undefined,
    includePaths: body.includePaths as string[] | undefined,
    excludePaths: body.excludePaths as string[] | undefined,
    allowSubdomains: (body.includeSubdomains ?? body.allowSubdomains) as boolean | undefined,
    ignoreSitemap: body.ignoreSitemap as boolean | undefined,
    sitemapOnly: body.sitemapOnly as boolean | undefined,
    maxAge: body.maxAge as number | undefined,
  });

  send(res, 200, {
    success: true,
    links: result.links.map((l) => ({
      url: l.url,
      title: l.title,
      description: undefined,
      lastModified: l.lastModified,
    })),
    total: result.total,
    sources: result.sources,
    warning: result.warning,
  });
}

function jobEnvelope(jobId: string, body: Record<string, unknown>): unknown {
  const job = getJob(jobId);
  if (!job) return { success: false, error: `No job with id ${jobId}.` };

  const limit = Number(body.limit ?? 100);
  const offset = Number(body.skip ?? body.offset ?? 0);
  const pages = getPages(jobId, { limit, offset, includeMarkdown: true });
  const stored = pageCount(jobId);

  const statusMap: Record<string, string> = {
    queued: 'scraping',
    running: 'scraping',
    completed: 'completed',
    cancelled: 'cancelled',
    failed: 'failed',
    interrupted: 'failed',
  };

  return {
    success: true,
    status: statusMap[job.status] ?? job.status,
    total: job.counts.discovered,
    completed: stored,
    creditsUsed: 0,
    expiresAt: null,
    next: offset + pages.length < stored ? String(offset + pages.length) : null,
    data: pages.map((page) => ({
      markdown: page.markdown,
      metadata: {
        url: page.url,
        title: page.title,
        description: page.description,
        statusCode: page.status,
        sourceURL: page.url,
      },
    })),
  };
}

async function routeCrawlStart(ctx: Ctx): Promise<void> {
  const { res, body } = ctx;
  const url = body.url;
  if (typeof url !== 'string') return fail(res, 400, 'A "url" string is required.');
  if (await refusedForSsrf(ctx, url)) return;
  const jobId = startCrawl(url, toCrawlOptions(body));
  send(res, 200, { success: true, id: jobId, url: `/v1/crawl/${jobId}` });
}

async function routeBatchStart(ctx: Ctx): Promise<void> {
  const { res, body } = ctx;
  const urls = body.urls;
  if (!Array.isArray(urls) || urls.length === 0) {
    return fail(res, 400, 'A non-empty "urls" array is required.');
  }
  for (const candidate of urls.map(String)) {
    if (await refusedForSsrf(ctx, candidate)) return;
  }
  try {
    const jobId = startBatch(urls.map(String), toCrawlOptions(body));
    send(res, 200, { success: true, id: jobId, url: `/v1/batch/scrape/${jobId}` });
  } catch (err) {
    fail(res, 400, String(err));
  }
}

async function routeParse(ctx: Ctx): Promise<void> {
  const { res, body } = ctx;
  if (!ctx.cfg.allowLocalFileParse) {
    return fail(
      res,
      403,
      'Local file parsing is disabled over HTTP because it reads any path on this machine. ' +
        'Set OPENSCRAPE_ALLOW_FILE_PARSE=1 to enable it, or use the MCP parse_file tool instead.',
    );
  }
  const path = body.path;
  if (typeof path !== 'string') return fail(res, 400, 'A "path" string is required.');
  try {
    const { readFile } = await import('node:fs/promises');
    const buffer = await readFile(path);
    const doc = await parseDocument(buffer, '', path);
    send(res, 200, {
      success: true,
      data: { kind: doc.kind, pages: doc.pages, markdown: doc.markdown, warning: doc.warning },
    });
  } catch (err) {
    fail(res, 400, String(err));
  }
}

/* ------------------------------------------------------------------ */
/* Server                                                             */
/* ------------------------------------------------------------------ */

export interface HttpServerOptions {
  port?: number;
  host?: string;
  /** Require `Authorization: Bearer <key>`. Defaults to OPENSCRAPE_API_KEY. */
  apiKey?: string;
  /** Allow fetching private/loopback addresses. Default false (SSRF guard on). */
  allowPrivateTargets?: boolean;
  /** Expose POST /v1/parse, which reads any local file path. Default false. */
  allowLocalFileParse?: boolean;
}

export function startHttpServer(options: HttpServerOptions = {}) {
  const port = options.port ?? Number(process.env.OPENSCRAPE_HTTP_PORT ?? 3002);
  const host = options.host ?? process.env.OPENSCRAPE_HTTP_HOST ?? '127.0.0.1';
  const apiKey = options.apiKey ?? process.env.OPENSCRAPE_API_KEY;
  const allowPrivateTargets =
    options.allowPrivateTargets ?? process.env.OPENSCRAPE_ALLOW_PRIVATE_TARGETS === '1';
  const allowLocalFileParse =
    options.allowLocalFileParse ?? process.env.OPENSCRAPE_ALLOW_FILE_PARSE === '1';

  const isLoopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';

  // Binding to a routable interface without a key would hand every machine on
  // the network a scraper that can also read this one's private addresses.
  if (!isLoopback && !apiKey) {
    throw new Error(
      `Refusing to listen on ${host} without a bearer token. Set OPENSCRAPE_API_KEY, or bind to 127.0.0.1.`,
    );
  }
  if (!isLoopback) {
    log.warn(
      `http api is bound to ${host}, not loopback. Bearer auth is on; SSRF guard is ` +
        `${allowPrivateTargets ? 'OFF (unsafe)' : 'on'}; local file parse is ${allowLocalFileParse ? 'ENABLED (unsafe)' : 'disabled'}.`,
    );
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      log.error('http handler failed', String(err));
      if (!res.headersSent) fail(res, 500, String(err));
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? host}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = (req.method ?? 'GET').toUpperCase();

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
      });
      res.end();
      return;
    }

    if (path === '/health' || path === '/v1/health') {
      const stats = cacheStats();
      return send(res, 200, {
        success: true,
        service: 'openscrape',
        cachedPages: stats.entries,
        cacheBytes: stats.bytes,
      });
    }

    // Auth is opt-in: a local-only server usually does not need it, but a
    // server exposed on a LAN absolutely does.
    if (apiKey) {
      const header = String(req.headers.authorization ?? '');
      const token = header.replace(/^Bearer\s+/i, '').trim();
      if (token !== apiKey) return fail(res, 401, 'Invalid or missing bearer token.');
    }

    let body: Record<string, unknown> = {};
    if (method === 'POST') {
      try {
        body = await readBody(req);
      } catch (err) {
        return fail(res, 400, String((err as Error).message ?? err));
      }
    } else {
      for (const [k, v] of url.searchParams.entries()) body[k] = v;
    }

    const ctx: Ctx = {
      req,
      res,
      body,
      path,
      method,
      cfg: { allowPrivateTargets, allowLocalFileParse },
    };

    // Accept both /v1/... and bare paths, so either base URL style works.
    const route = path.replace(/^\/v[12]/, '') || '/';

    if (method === 'POST' && route === '/scrape') return routeScrape(ctx);
    if (method === 'POST' && route === '/map') return routeMap(ctx);
    if (method === 'POST' && route === '/crawl') return routeCrawlStart(ctx);
    if (method === 'POST' && route === '/batch/scrape') return routeBatchStart(ctx);
    if (method === 'POST' && route === '/parse') return routeParse(ctx);

    const crawlId = /^\/(?:crawl|batch\/scrape)\/([\w-]+)$/.exec(route)?.[1];
    if (crawlId && method === 'GET') {
      // An unknown job is a 404, not a 200 carrying an error: SDKs branch on status.
      if (!getJob(crawlId)) return fail(res, 404, `No job with id ${crawlId}.`);
      return send(res, 200, jobEnvelope(crawlId, body));
    }
    if (crawlId && method === 'DELETE') {
      const ok = cancelJob(crawlId);
      return send(res, ok ? 200 : 404, { success: ok, status: ok ? 'cancelled' : 'not found' });
    }

    fail(
      res,
      404,
      `Unknown route ${method} ${path}. Available: POST /v1/scrape, /v1/map, /v1/crawl, /v1/batch/scrape, /v1/parse; GET|DELETE /v1/crawl/:id; GET /health.`,
    );
  }

  return new Promise<{ port: number; close: () => Promise<void> }>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      log.info(`http api listening on http://${host}:${port}${apiKey ? ' (bearer auth on)' : ''}`);
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

/**
 * Lets this file run on its own: `npx tsx src/http/server.ts`.
 * Windows reports argv[1] with backslashes, so normalise before comparing.
 */
const entry = (process.argv[1] ?? '').replace(/\\/g, '/');
const isDirectRun = /\/http\/server\.(ts|js)$/.test(entry);

if (isDirectRun) {
  const started = await startHttpServer();
  const shutdown = async () => {
    await started.close();
    try {
      const { closeBrowser } = await import('../core/fetcher/browser.js');
      await closeBrowser();
    } catch {
      /* browser never started */
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}
