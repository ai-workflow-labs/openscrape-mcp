import { normalizeUrl } from '../util/url.js';

/**
 * Decides which URLs a map or crawl is allowed to touch, and how promising
 * each one looks. Shared by `map` (for its `search` filter) and the crawler
 * (for best-first ordering), so both rank URLs the same way.
 */

/** Binary assets we can never turn into text. */
const SKIP_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp', 'tiff',
  'mp3', 'mp4', 'm4a', 'm4v', 'wav', 'ogg', 'webm', 'avi', 'mov', 'mkv', 'flac',
  'zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar', 'dmg', 'iso', 'exe', 'msi',
  'apk', 'deb', 'rpm', 'woff', 'woff2', 'ttf', 'otf', 'eot',
  'css', 'js', 'mjs', 'map', 'wasm',
]);

/** Non-HTML formats we *can* read, so they stay in scope. */
const DOCUMENT_EXTENSIONS = new Set(['pdf', 'docx', 'doc', 'csv', 'tsv', 'txt', 'md', 'json', 'xml', 'rss', 'atom']);

export interface ScopeOptions {
  /** The URL the map/crawl started from. */
  root: string;
  /** Regular expressions; a URL path must match at least one. */
  includePaths?: string[];
  /** Regular expressions; a URL path matching any of these is dropped. */
  excludePaths?: string[];
  /** Allow sub.example.com when the root is example.com. Default false. */
  allowSubdomains?: boolean;
  /** Allow other domains entirely. Default false. */
  allowExternal?: boolean;
  /** Extra hostnames to treat as in scope. */
  allowedDomains?: string[];
  /** Follow links above the starting path, e.g. from /docs/a back to /. Default true. */
  allowBackwardLinks?: boolean;
  /** Skip PDFs and other documents. Default false. */
  htmlOnly?: boolean;
}

export interface ScopeVerdict {
  ok: boolean;
  reason?: string;
}

export interface Scope {
  inScope(url: string): ScopeVerdict;
  rootPath: string;
  rootHost: string;
}

function baseDomain(hostname: string): string {
  return hostname.replace(/^www\./i, '').toLowerCase();
}

function extensionOf(pathname: string): string {
  const last = pathname.split('/').pop() ?? '';
  const dot = last.lastIndexOf('.');
  return dot > 0 ? last.slice(dot + 1).toLowerCase() : '';
}

function compile(patterns: string[] | undefined): RegExp[] {
  if (!patterns?.length) return [];
  const out: RegExp[] = [];
  for (const pattern of patterns) {
    try {
      out.push(new RegExp(pattern));
    } catch {
      // Treat an invalid regex as a literal substring rather than failing the crawl.
      out.push(new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  }
  return out;
}

export function makeScope(opts: ScopeOptions): Scope {
  const rootUrl = new URL(opts.root);
  const rootHost = baseDomain(rootUrl.hostname);
  const rootPath = rootUrl.pathname.replace(/\/[^/]*$/, '/') || '/';

  const include = compile(opts.includePaths);
  const exclude = compile(opts.excludePaths);
  const extraDomains = new Set((opts.allowedDomains ?? []).map(baseDomain));

  return {
    rootPath,
    rootHost,
    inScope(candidate: string): ScopeVerdict {
      let u: URL;
      try {
        u = new URL(normalizeUrl(candidate));
      } catch {
        return { ok: false, reason: 'unparseable' };
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return { ok: false, reason: 'non-http' };
      }

      const host = baseDomain(u.hostname);
      if (!opts.allowExternal) {
        const sameHost = host === rootHost;
        const isSubdomain = host.endsWith('.' + rootHost);
        const allowed = sameHost || extraDomains.has(host) || (opts.allowSubdomains === true && isSubdomain);
        if (!allowed) return { ok: false, reason: 'off-domain' };
      }

      const ext = extensionOf(u.pathname);
      if (ext && SKIP_EXTENSIONS.has(ext)) return { ok: false, reason: 'binary-asset' };
      if (ext && DOCUMENT_EXTENSIONS.has(ext) && opts.htmlOnly) {
        return { ok: false, reason: 'not-html' };
      }

      const pathAndQuery = u.pathname + (u.search || '');
      if (exclude.some((re) => re.test(pathAndQuery))) return { ok: false, reason: 'excludePaths' };
      if (include.length > 0 && !include.some((re) => re.test(pathAndQuery))) {
        return { ok: false, reason: 'includePaths' };
      }

      if (opts.allowBackwardLinks === false && !u.pathname.startsWith(rootPath)) {
        return { ok: false, reason: 'above-root-path' };
      }

      return { ok: true };
    },
  };
}

/* ------------------------------------------------------------------ */
/* URL relevance scoring                                               */
/* ------------------------------------------------------------------ */

const SCORE_STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'is', 'how', 'what']);

export function queryTerms(query: string): string[] {
  return [
    ...new Set(
      (query.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
        (t) => t.length > 1 && !SCORE_STOPWORDS.has(t),
      ),
    ),
  ];
}

/**
 * How well a URL (and its link text, when we have it) matches a query.
 * Used to order a best-first crawl so a limit of 50 pages is spent on the 50
 * pages most likely to matter, instead of the first 50 in link order.
 */
export function scoreUrl(url: string, terms: string[], linkText?: string): number {
  if (terms.length === 0) return 0;

  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 0;
  }

  const slug = decodeURIComponent(u.pathname + ' ' + u.search)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');
  const text = (linkText ?? '').toLowerCase();

  let score = 0;
  for (const term of terms) {
    if (slug.includes(term)) score += 3;
    if (text.includes(term)) score += 2;
  }

  // Shallow pages tend to be hubs; deep ones tend to be specific. Mild nudge.
  const depth = u.pathname.split('/').filter(Boolean).length;
  score += Math.max(0, 2 - depth * 0.25);

  // Penalise the usual low-value paths.
  if (/\/(tag|tags|category|categories|author|page|archive|feed|comment)s?\//.test(u.pathname)) {
    score -= 2;
  }
  if (u.search) score -= 0.5;

  return score;
}
