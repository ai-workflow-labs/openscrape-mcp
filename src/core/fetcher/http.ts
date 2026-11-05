import { fetch as undiciFetch, ProxyAgent, Agent } from 'undici';
import {
  nextProxy,
  reportProxyOutcome,
  outcomeFromResponse,
  outcomeFromError,
} from './proxypool.js';
import { log } from '../util/log.js';
import type { FetchedPage, RedirectHop, ScrapeOptions } from '../types.js';

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

/** Headers a real Chrome sends. Missing these is the #1 reason cheap scrapers get 403s. */
function baseHeaders(opts: ScrapeOptions, url: string): Record<string, string> {
  const u = new URL(url);
  return {
    'user-agent': opts.mobile ? MOBILE_UA : DESKTOP_UA,
    accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9',
    'accept-encoding': 'gzip, deflate, br',
    'cache-control': 'no-cache',
    pragma: 'no-cache',
    'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': opts.mobile ? '?1' : '?0',
    'sec-ch-ua-platform': opts.mobile ? '"Android"' : '"Windows"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
    referer: u.origin + '/',
    ...(opts.headers ?? {}),
  };
}

/** Signals that we hit a bot wall rather than the real page. */
export function detectBlock(
  status: number,
  headers: Record<string, unknown>,
  body: Buffer,
): string | null {
  const server = String(headers['server'] ?? '').toLowerCase();
  const head = body.subarray(0, 4000).toString('utf8').toLowerCase();

  if (status === 403 && (server.includes('cloudflare') || headers['cf-ray'])) {
    return 'cloudflare-403';
  }
  if (status === 503 && head.includes('just a moment')) return 'cloudflare-challenge';
  if (head.includes('cf-browser-verification') || head.includes('cf_chl_opt')) {
    return 'cloudflare-challenge';
  }
  if (head.includes('/cdn-cgi/challenge-platform')) return 'cloudflare-challenge';
  if (head.includes('captcha-delivery.com') || head.includes('datadome')) return 'datadome';
  if (head.includes('px-captcha') || head.includes('perimeterx')) return 'perimeterx';
  if (head.includes('_incapsula_')) return 'imperva';
  if (status === 429) return 'rate-limited';
  if (status === 401) return 'auth-required';
  return null;
}

function decodeBody(body: Buffer, contentType: string): string {
  let charset = /charset=([^;\s]+)/i.exec(contentType)?.[1];
  if (!charset) {
    const head = body.subarray(0, 2048).toString('latin1');
    charset =
      /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ||
      /<meta[^>]+content=["'][^"']*charset=([\w-]+)/i.exec(head)?.[1];
  }
  const label = (charset || 'utf-8').toLowerCase().replace(/["']/g, '');
  try {
    return new TextDecoder(label, { fatal: false }).decode(body);
  } catch {
    return body.toString('utf8');
  }
}

/** Re-encodes a body to UTF-8 when the page declared a legacy charset. */
export function bodyToUtf8(body: Buffer, contentType: string): Buffer {
  const ct = contentType.toLowerCase();
  if (ct.includes('charset=utf-8') || ct.includes('charset=utf8')) return body;
  const text = decodeBody(body, contentType);
  return Buffer.from(text, 'utf8');
}

export function isTextual(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return (
    ct.startsWith('text/') ||
    ct.includes('json') ||
    ct.includes('xml') ||
    ct.includes('javascript') ||
    ct.includes('x-www-form-urlencoded') ||
    ct === ''
  );
}

/** HTTP validators from a stored copy, turned into conditional request headers. */
export interface Conditional {
  etag?: string;
  lastModified?: string;
}

/**
 * Dispatchers are pooled, not built per request.
 *
 * A fresh `Agent` per fetch throws away keep-alive: every page pays a new TCP
 * and TLS handshake, which on a crawl of one host is most of the latency.
 * Reusing a dispatcher per (proxy, TLS, timeout) shape keeps connections warm
 * and lets HTTP/2 multiplex where the server supports it.
 */
const dispatchers = new Map<string, Agent | ProxyAgent>();

function dispatcherFor(opts: ScrapeOptions, timeout: number): Agent | ProxyAgent {
  const rejectUnauthorized = opts.skipTlsVerification !== true;
  const key = `${opts.proxy ?? 'direct'}|${rejectUnauthorized}|${timeout}`;

  const existing = dispatchers.get(key);
  if (existing) return existing;

  const connect = { rejectUnauthorized };
  const made = opts.proxy
    ? new ProxyAgent({ uri: opts.proxy, connect })
    : new Agent({
        connect,
        bodyTimeout: timeout,
        headersTimeout: timeout,
        allowH2: true,
        keepAliveTimeout: 30_000,
        keepAliveMaxTimeout: 120_000,
        connections: 64,
      });

  // Bound the pool so an unusual mix of options cannot grow it without limit.
  if (dispatchers.size > 24) {
    const oldest = dispatchers.keys().next().value;
    if (oldest !== undefined) {
      const victim = dispatchers.get(oldest);
      dispatchers.delete(oldest);
      void victim?.close().catch(() => {});
    }
  }

  dispatchers.set(key, made);
  return made;
}

/** Closes pooled connections. Call on shutdown. */
export async function closeDispatchers(): Promise<void> {
  const all = [...dispatchers.values()];
  dispatchers.clear();
  await Promise.allSettled(all.map((d) => d.close()));
}

/** Statuses that mean "look elsewhere". 304 is 3xx but is not a redirect. */
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/** Hops we will follow before giving up. Matches the fetch standard's limit. */
const MAX_HOPS = 20;

export async function httpFetch(
  url: string,
  opts: ScrapeOptions = {},
  conditional?: Conditional,
): Promise<FetchedPage> {
  const timeout = opts.timeout ?? 30_000;

  // An explicit per-request proxy always wins; otherwise the pool picks one,
  // and returns null when none is configured (the normal case).
  const pooled = opts.proxy ?? nextProxy(url) ?? undefined;
  const effective = pooled === opts.proxy ? opts : { ...opts, proxy: pooled };
  const dispatcher = dispatcherFor(effective, timeout);
  const startedAt = Date.now();

  /**
   * Redirects are followed by hand rather than by undici.
   *
   * Letting the client follow them is less code, but it throws away the chain:
   * you learn where you landed and nothing about how. `/a -> /b -> /c` and a
   * direct hit on `/c` look identical, when the first is a real defect worth
   * reporting. Following them here costs one loop and keeps the hops.
   */
  const chain: RedirectHop[] = [];
  let current = url;
  let res: Awaited<ReturnType<typeof undiciFetch>>;

  for (let hop = 0; ; hop++) {
    const headers = baseHeaders(opts, current);

    // Validators belong to the URL they were stored for. Sending them to a
    // redirect target asks "has *that* changed?" about the wrong resource,
    // and a 304 to that question would serve the wrong stored body.
    if (hop === 0) {
      // Asking "has this changed?" costs a few hundred bytes; a full
      // re-download of an unchanged page costs the body plus re-parsing it.
      if (conditional?.etag) headers['if-none-match'] = conditional.etag;
      if (conditional?.lastModified) headers['if-modified-since'] = conditional.lastModified;
    }
    if (hop > 0) headers.referer = chain[hop - 1]?.from ?? current;

    try {
      res = await undiciFetch(current, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeout),
        dispatcher,
      } as Parameters<typeof undiciFetch>[1]);
    } catch (err) {
      // A transport failure is the proxy's problem, not the site's.
      reportProxyOutcome(pooled, current, outcomeFromError(err, undefined, Date.now() - startedAt));
      throw err;
    }

    if (opts.followRedirects === false) break;
    if (!REDIRECT_STATUS.has(res.status)) break;

    const location = res.headers.get('location');
    if (!location) break; // A 3xx with nowhere to go is the final answer.

    let next: string;
    try {
      next = new URL(location, current).toString();
    } catch {
      break; // Unparseable Location: report the 3xx as it stands.
    }

    // A loop back to somewhere we have already been will never terminate.
    if (next === current || chain.some((h) => h.from === next)) {
      log.debug('redirect loop', { url, next });
      chain.push({ from: current, to: next, status: res.status });
      break;
    }

    chain.push({ from: current, to: next, status: res.status });
    await res.arrayBuffer().catch(() => undefined); // release the connection
    current = next;

    if (hop + 1 >= MAX_HOPS) {
      log.warn('too many redirects', { url, hops: chain.length });
      break;
    }
  }

  const raw = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') ?? '';
  const etag = res.headers.get('etag') ?? undefined;
  const lastModified = res.headers.get('last-modified') ?? undefined;
  const redirectChain = chain.length ? chain : undefined;

  // 304 Not Modified: the body is empty by definition, and the caller serves
  // the copy it already has.
  if (res.status === 304) {
    reportProxyOutcome(pooled, url, outcomeFromResponse(304, null, undefined, Date.now() - startedAt));
    log.debug('http 304 not modified', { url });
    return {
      url,
      finalUrl: current,
      status: 304,
      contentType,
      body: Buffer.alloc(0),
      renderedWith: 'http',
      revalidated: true,
      redirectChain,
      etag: etag ?? conditional?.etag,
      lastModified: lastModified ?? conditional?.lastModified,
    };
  }

  const headerBag: Record<string, unknown> = {};
  res.headers.forEach((value, key) => {
    headerBag[key.toLowerCase()] = value;
  });

  const blockReason = detectBlock(res.status, headerBag, raw);

  // The pool classifies on detectBlock's verdict, so "site blocked us" never
  // gets counted against the proxy's own health.
  reportProxyOutcome(
    pooled,
    url,
    outcomeFromResponse(res.status, blockReason, undefined, Date.now() - startedAt),
  );

  log.debug('http fetch', {
    url,
    status: res.status,
    bytes: raw.byteLength,
    hops: chain.length,
    blockReason,
  });

  return {
    url,
    finalUrl: current,
    status: res.status,
    contentType,
    body: isTextual(contentType) ? bodyToUtf8(raw, contentType) : raw,
    renderedWith: 'http',
    blocked: Boolean(blockReason),
    blockReason: blockReason ?? undefined,
    redirectChain,
    etag,
    lastModified,
  };
}
