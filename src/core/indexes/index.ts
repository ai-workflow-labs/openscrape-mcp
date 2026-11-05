/**
 * Specialised search indexes.
 *
 * Firecrawl sells three curated indexes — Research, Developer, and Government
 * & Legal. None of them is magic: each one is a thin layer over public data
 * that the issuing institutions publish for free. arXiv, PubMed, bioRxiv,
 * Crossref and OpenAlex cover the literature; GitHub covers code; the Federal
 * Register and govinfo cover US rulemaking. This directory rebuilds all three
 * from those APIs, with no key required and no credits consumed.
 *
 * Two rules run through every module here:
 *
 *  1. Zero configuration must work. An API key may raise a rate limit or
 *     unlock an extra source, but it is never the difference between working
 *     and not working.
 *  2. Degrade out loud. When a source is down, rate-limited or needs a key we
 *     say which source, what happened and what would fix it. We never quietly
 *     drop a source and present the remainder as the whole answer, and we
 *     never invent a result.
 */
import { httpFetch } from '../fetcher/http.js';
import { log } from '../util/log.js';

/**
 * How we identify ourselves to public APIs.
 *
 * arXiv, Crossref, NCBI and OpenAlex all ask clients to say who they are so
 * they can throttle a misbehaving script rather than an entire IP range. We
 * send a product token and nothing else: no email address, no contact URL, no
 * machine identifier. Several of these services document a "polite pool" that
 * you join by handing over an email; we decline, because the user's address is
 * not ours to broadcast to a dozen third parties.
 */
export const CLIENT_NAME = 'OpenScrape/0.1';

/** NCBI asks E-utilities callers to pass a tool name. */
export const NCBI_TOOL = 'OpenScrape';

const JSON_ACCEPT = 'application/json, text/plain;q=0.9, */*;q=0.8';

/** What happened to one upstream source during a search. */
export interface SourceStatus {
  /** Short name as it appears in the output, e.g. "arxiv". */
  source: string;
  ok: boolean;
  /** Results contributed after filtering and de-duplication. */
  count: number;
  /** Why it failed, or what a key would buy. Shown to the user verbatim. */
  note?: string;
}

/** Result of one API call: either data, or a reason there is none. */
export type ApiResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number; error: string };

function describeHttpError(status: number, body: string): string {
  const trimmed = body.trim();
  // Most of these APIs explain themselves in a JSON `message`/`detail`/`error`.
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const err = parsed.error;
    const message =
      (typeof parsed.message === 'string' && parsed.message) ||
      (typeof parsed.detail === 'string' && parsed.detail) ||
      (typeof err === 'string' && err) ||
      (err && typeof err === 'object' && typeof (err as Record<string, unknown>).message === 'string'
        ? ((err as Record<string, unknown>).message as string)
        : '');
    if (message) return `HTTP ${status}: ${message}`;
  } catch {
    /* not JSON — fall through to the snippet below */
  }
  const snippet = trimmed.replace(/\s+/g, ' ').slice(0, 160);
  return snippet ? `HTTP ${status}: ${snippet}` : `HTTP ${status}`;
}

/** GET a URL and return its body as text, never throwing. */
export async function apiGetText(
  url: string,
  opts: { accept?: string; timeout?: number; headers?: Record<string, string> } = {},
): Promise<ApiResult<string>> {
  try {
    const page = await httpFetch(url, {
      timeout: opts.timeout ?? 20_000,
      headers: {
        'user-agent': CLIENT_NAME,
        accept: opts.accept ?? JSON_ACCEPT,
        ...(opts.headers ?? {}),
      },
    });
    const body = page.body.toString('utf8');
    if (page.status < 200 || page.status >= 300) {
      return { ok: false, status: page.status, error: describeHttpError(page.status, body) };
    }
    return { ok: true, status: page.status, data: body };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.debug('index fetch failed', { url, reason });
    return { ok: false, status: 0, error: reason.includes('aborted') ? 'request timed out' : reason };
  }
}

/** GET a URL and parse the body as JSON, never throwing. */
export async function apiGetJson<T>(
  url: string,
  opts: { timeout?: number; headers?: Record<string, string> } = {},
): Promise<ApiResult<T>> {
  const text = await apiGetText(url, opts);
  if (!text.ok) return text;
  try {
    return { ok: true, status: text.status, data: JSON.parse(text.data) as T };
  } catch {
    return { ok: false, status: text.status, error: 'upstream returned a non-JSON body' };
  }
}

/**
 * GET JSON, retrying once when the upstream says "busy, come back".
 *
 * OpenAlex throttles anonymous callers when its cluster is loaded and names a
 * retry delay in the error; a single short wait usually clears it. We retry
 * only 429 and 503 — never a 4xx that means the request itself was wrong — and
 * give up loudly rather than looping.
 */
export async function apiGetJsonRetrying<T>(
  url: string,
  opts: { timeout?: number; headers?: Record<string, string>; retryDelayMs?: number } = {},
): Promise<ApiResult<T>> {
  const first = await apiGetJson<T>(url, opts);
  if (first.ok || (first.status !== 429 && first.status !== 503)) return first;

  const delay = Math.min(opts.retryDelayMs ?? 2500, 10_000);
  log.debug('index retrying after throttle', { url, status: first.status, delay });
  await new Promise((resolve) => setTimeout(resolve, delay));

  const second = await apiGetJson<T>(url, opts);
  if (second.ok) return second;
  return { ok: false, status: second.status, error: `${second.error} (retried once after ${delay}ms)` };
}

/** Build a query string, dropping undefined values. */
export function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') sp.set(key, String(value));
  }
  return sp.toString();
}

/** Collapse whitespace and strip the XML/HTML tags that abstracts arrive wrapped in. */
export function cleanText(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const text = input
    .replace(/<\/?(?:jats:)?(?:p|italic|bold|sub|sup|sc|title|list|list-item)[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x?[0-9a-f]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text || undefined;
}

/** Shorten prose to a budget without cutting mid-word. */
export function clip(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
}

/** Normalise a DOI to a bare, lowercase `10.x/y` for de-duplication. */
export function normalizeDoi(doi: string | undefined): string | undefined {
  if (!doi) return undefined;
  const match = /10\.\d{4,9}\/\S+/.exec(doi.trim());
  return match ? match[0].toLowerCase().replace(/[.,;)\]]+$/, '') : undefined;
}

/** A title reduced to comparable letters, for de-duplicating across sources. */
export function titleKey(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Whether every word of the query appears somewhere in the haystack. */
export function matchesAllTerms(haystack: string, terms: string[]): boolean {
  const lower = haystack.toLowerCase();
  return terms.every((t) => lower.includes(t));
}

/** Split a user query into lowercase search terms, honouring "quoted phrases". */
export function queryTerms(query: string): string[] {
  const terms: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query)) !== null) {
    const term = (m[1] ?? m[2] ?? '').toLowerCase().trim();
    if (term.length > 1) terms.push(term);
  }
  return terms;
}

/** Render the per-source status block that every index tool ends with. */
export function formatSources(sources: SourceStatus[]): string {
  if (!sources.length) return '';
  const lines = sources.map((s) => {
    const mark = s.ok ? '✓' : '✗';
    const count = s.ok ? `${s.count}` : '—';
    return `- ${mark} ${s.source} (${count})${s.note ? ` — ${s.note}` : ''}`;
  });
  return `\n## Sources\n\n${lines.join('\n')}`;
}

export { searchPapers, readPaper } from './papers.js';
export type { Paper, PaperSearchOptions, PaperSearchResult, PaperReadResult, PaperSource } from './papers.js';

export { developerSearch } from './developer.js';
export type { DeveloperHit, DeveloperSearchOptions, DeveloperSearchResult, DeveloperKind } from './developer.js';

export { govSearch } from './gov.js';
export type { GovDocument, GovSearchOptions, GovSearchResult, GovSource } from './gov.js';
