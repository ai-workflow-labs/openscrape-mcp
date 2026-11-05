import robotsParserImport from 'robots-parser';
import { httpFetch } from '../fetcher/http.js';
import { originOf } from '../util/url.js';
import { log } from '../util/log.js';

/**
 * robots.txt handling.
 *
 * We identify as "OpenScrape" when matching rules, which means we obey the
 * `*` group rather than quietly claiming to be Googlebot to get more access.
 */
export const ROBOTS_AGENT = 'OpenScrape';

/**
 * robots-parser ships a `declare module 'robots-parser';` shorthand that
 * shadows its own typed default export, so the import arrives untyped. The
 * runtime value is a plain CJS function; this restores the shape we use.
 */
interface RobotsRules {
  isAllowed(url: string, ua?: string): boolean | undefined;
  getCrawlDelay(ua?: string): number | undefined;
  getSitemaps(): string[];
}

const robotsParser = robotsParserImport as unknown as (
  url: string,
  robotstxt: string,
) => RobotsRules;

export interface RobotsInfo {
  /** Sitemap URLs the site advertises. */
  sitemaps: string[];
  /** Crawl-delay in ms, when declared. */
  crawlDelayMs: number;
  isAllowed(url: string): boolean;
  /** True when robots.txt could not be read, so nothing is disallowed. */
  missing: boolean;
}

const TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, { at: number; info: RobotsInfo }>();

const ALLOW_ALL: Omit<RobotsInfo, 'missing'> = {
  sitemaps: [],
  crawlDelayMs: 0,
  isAllowed: () => true,
};

export async function getRobots(url: string, timeout = 10_000): Promise<RobotsInfo> {
  let origin: string;
  try {
    origin = originOf(url);
  } catch {
    return { ...ALLOW_ALL, missing: true };
  }

  const hit = cache.get(origin);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.info;

  const robotsUrl = `${origin}/robots.txt`;
  let info: RobotsInfo;

  try {
    const page = await httpFetch(robotsUrl, { timeout });
    if (page.status >= 400 || page.body.byteLength === 0) {
      info = { ...ALLOW_ALL, missing: true };
    } else {
      const text = page.body.toString('utf8');
      const parser = robotsParser(robotsUrl, text);
      const delaySeconds = parser.getCrawlDelay(ROBOTS_AGENT);
      info = {
        sitemaps: parser.getSitemaps(),
        crawlDelayMs: typeof delaySeconds === 'number' ? Math.round(delaySeconds * 1000) : 0,
        isAllowed: (target: string) => parser.isAllowed(target, ROBOTS_AGENT) !== false,
        missing: false,
      };
    }
  } catch (err) {
    log.debug('robots fetch failed', { robotsUrl, error: String(err) });
    info = { ...ALLOW_ALL, missing: true };
  }

  cache.set(origin, { at: Date.now(), info });
  return info;
}

/**
 * Returns an already-fetched robots.txt without making a request.
 *
 * Lets synchronous code (a status report, say) explain *why* a crawl is slow —
 * a site declaring `Crawl-delay: 30` makes five pages take two and a half
 * minutes, which looks like a hang unless you say so.
 */
export function peekRobots(url: string): RobotsInfo | null {
  try {
    const hit = cache.get(originOf(url));
    if (!hit || Date.now() - hit.at >= TTL_MS) return null;
    return hit.info;
  } catch {
    return null;
  }
}

export function clearRobotsCache(): void {
  cache.clear();
}
