/**
 * The server definition, shared by every transport.
 *
 * Extracted from `index.ts` so stdio and HTTP cannot drift apart: a tool
 * registered for one transport but not the other is the kind of bug nobody
 * finds until a client reports a missing tool.
 *
 * Note what is *not* here: the heavy state. The SQLite handle, the browser
 * singleton and the crawl engine are module-level, so several `McpServer`
 * instances (one per HTTP session) share one cache, one browser and one job
 * table rather than fighting over them.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerScrapeTools } from './tools/scrape.js';
import { registerCrawlTools } from './tools/crawl.js';
import { registerMonitorTools, resumeMonitors } from './tools/monitor.js';
import { registerIndexTools } from './tools/indexes.js';
import { registerSearchTools } from './tools/search.js';
import { registerInteractTools, shutdownInteract } from './tools/interact.js';
import { registerResearchTools } from './tools/research.js';
import { registerExtractTools } from './tools/extract.js';
import { registerProxyTools } from './tools/proxy.js';
import { registerFeedTools } from './tools/feeds.js';
import { registerArchiveTools } from './tools/archive.js';
import { registerSeoTools } from './tools/seo.js';
import { registerPolicyTools } from './tools/policy.js';
import { registerAudioTools } from './tools/audio.js';
import { reconcileInterruptedJobs } from '../core/crawl/engine.js';
import { log } from '../core/util/log.js';

export const SERVER_NAME = 'openscrape';
export const SERVER_VERSION = '0.1.0';

const INSTRUCTIONS =
  'Local web scraping and crawling, with no API key and no per-page cost.\n\n' +
  '- `scrape` — one URL to clean markdown. Escalates to a real browser only when the page needs JavaScript. ' +
  'Pass `query` to extract just the relevant part of a long page, `maxChars` to cap context use, and ' +
  '`maxAge` to reuse the local cache instead of refetching.\n' +
  "- `map` — list a site's URLs fast (sitemaps first). Use it with `search` to find the right page before scraping.\n" +
  '- `crawl` / `batch_scrape` — background jobs; poll with `crawl_status`. Jobs survive a restart.\n' +
  '- `seo_audit` / `link_graph` / `broken_links` / `duplicate_content` — run over a finished crawl with no new requests.\n' +
  '- `archive_fetch` — read a page as it was on a past date, from the web archives.\n' +
  '- `corpus_search` — full-text search over everything already crawled, with no new requests.\n' +
  '- `parse_file` — local PDF, DOCX, CSV and text files.';

/** A fully registered server. Call once per transport or session. */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  registerScrapeTools(server);
  registerCrawlTools(server);
  registerMonitorTools(server);
  registerIndexTools(server);
  registerSearchTools(server);
  registerInteractTools(server);
  registerResearchTools(server);
  registerExtractTools(server);
  registerProxyTools(server);
  registerFeedTools(server);
  registerArchiveTools(server);
  registerSeoTools(server);
  registerPolicyTools(server);
  registerAudioTools(server);

  return server;
}

/**
 * One-time process startup, independent of transport.
 *
 * Safe to call once per process, not once per session: it reconciles crawl
 * jobs and restarts monitor schedules, both of which are process-wide.
 */
export function runStartupTasks(): void {
  // A crawl left mid-flight by a previous process must not look "running" forever.
  const interrupted = reconcileInterruptedJobs();
  if (interrupted > 0) {
    log.info(`marked ${interrupted} interrupted crawl job(s); resume them with crawl_control`);
  }

  // Monitors persist their next check time, so a restart picks the schedule back up.
  try {
    const monitors = resumeMonitors();
    if (monitors.active > 0) {
      log.info(`resumed ${monitors.active} monitor(s), ${monitors.due} due now`);
    }
  } catch (err) {
    log.warn('could not resume monitors', String(err));
  }
}

/** Releases the browser, the interact sessions and the pooled sockets. */
export async function releaseResources(): Promise<void> {
  try {
    await shutdownInteract();
    const { closeDispatchers } = await import('../core/fetcher/http.js');
    await closeDispatchers();
    const { closeBrowser } = await import('../core/fetcher/browser.js');
    await closeBrowser();
  } catch {
    /* browser was never started */
  }
}

/** Installs the signal and crash handlers every entry point wants. */
export function installProcessHandlers(onShutdown?: () => Promise<void>): void {
  const shutdown = async (signal: string): Promise<void> => {
    log.info(`shutting down (${signal})`);
    if (onShutdown) {
      try {
        await onShutdown();
      } catch (err) {
        log.warn('shutdown hook failed', String(err));
      }
    }
    await releaseResources();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  process.on('uncaughtException', (err) => {
    log.error('uncaught exception', String(err));
  });
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection', String(reason));
  });
}
