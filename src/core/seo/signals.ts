/**
 * Per-page SEO signals.
 *
 * Everything here is read off the cheerio tree the extraction pipeline has
 * already built, so collecting it costs a few tree walks rather than a second
 * parse of the HTML. That matters: on a thousand-page crawl, re-parsing to get
 * a canonical tag would roughly double the CPU cost of the crawl.
 *
 * The signals are deliberately *raw*. Nothing here decides whether a title is
 * too long or a page is orphaned — that is the audit's job (see `audit.ts`),
 * and keeping the two apart means the rules can change without re-crawling.
 */
import type * as cheerio from 'cheerio';
import { absolutize } from '../util/url.js';

export interface OutLink {
  /** Absolute URL. */
  url: string;
  /** Visible anchor text, collapsed and trimmed. '' for image-only links. */
  anchor: string;
  /** The `rel` attribute as written, lowercased. */
  rel?: string;
  /** Same registrable host (ignoring `www.`) as the page it was found on. */
  internal: boolean;
  /** rel contains nofollow, ugc or sponsored. */
  nofollow: boolean;
}

export interface ImageStats {
  total: number;
  /** No alt attribute at all — a real accessibility and SEO problem. */
  missingAlt: number;
  /** alt="" — valid, and correct for decorative images. Counted, not faulted. */
  emptyAlt: number;
}

export interface SeoSignals {
  /** The <title> as written. */
  title?: string;
  titleLength: number;
  description?: string;
  descriptionLength: number;
  h1: string[];
  h2Count: number;
  /** Absolute rel=canonical, when present. */
  canonical?: string;
  /** True when canonical points somewhere other than this page. */
  canonicalIsSelf?: boolean;
  /** The robots meta content as written. */
  robotsMeta?: string;
  noindex: boolean;
  nofollowPage: boolean;
  hreflang: { lang: string; href: string }[];
  viewport?: string;
  /** <html lang>. */
  lang?: string;
  /** Words of extracted text, not of HTML. */
  wordCount: number;
  images: ImageStats;
  links: OutLink[];
  internalLinks: number;
  externalLinks: number;
  nofollowLinks: number;
  /** Schema.org / JSON-LD @type values found on the page. */
  structuredTypes: string[];
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
  twitterCard?: string;
  /** 64-bit simhash of the text, hex. Near-identical pages share most bits. */
  simhash: string;
}

function clean(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

/** `www.` is not a different site. Anything else is treated as external. */
function sameSite(a: string, b: string): boolean {
  const strip = (h: string) => h.toLowerCase().replace(/^www\./, '');
  return strip(a) === strip(b);
}

/* ------------------------------------------------------------------ */
/* Near-duplicate fingerprint                                          */
/* ------------------------------------------------------------------ */

/** FNV-1a, 32-bit. Small, fast, and good enough to seed simhash buckets. */
function hashToken(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * 64-bit simhash over 3-word shingles.
 *
 * Why shingles and not single words: two pages about the same product share
 * nearly all their words, so a word-level fingerprint calls them duplicates
 * when they are not. Shingles capture a little word order, which is what
 * actually differs between a real duplicate and two pages on one topic.
 *
 * Returned as 16 hex characters. Compare with `hammingDistance`: 0 means the
 * text is identical, under about 4 means near-identical in practice.
 */
export function simhash(text: string): string {
  const words = text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  if (words.length === 0) return '0'.repeat(16);

  // Two 32-bit halves, because JS bitwise ops are 32-bit.
  const hi = new Int32Array(32);
  const lo = new Int32Array(32);

  const shingles = Math.max(1, words.length - 2);
  for (let i = 0; i < shingles; i++) {
    const shingle = words.slice(i, i + 3).join(' ');
    const a = hashToken(shingle);
    const b = hashToken(`${shingle}#`);
    for (let bit = 0; bit < 32; bit++) {
      hi[bit] = (hi[bit] as number) + ((a >>> bit) & 1 ? 1 : -1);
      lo[bit] = (lo[bit] as number) + ((b >>> bit) & 1 ? 1 : -1);
    }
  }

  let hiBits = 0;
  let loBits = 0;
  for (let bit = 0; bit < 32; bit++) {
    if ((hi[bit] as number) > 0) hiBits |= 1 << bit;
    if ((lo[bit] as number) > 0) loBits |= 1 << bit;
  }

  const toHex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  return toHex(hiBits) + toHex(loBits);
}

/** Bits that differ between two simhashes. 0 = identical text. */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== 16 || b.length !== 16) return 64;
  let total = 0;
  for (let half = 0; half < 2; half++) {
    let x =
      (parseInt(a.slice(half * 8, half * 8 + 8), 16) ^
        parseInt(b.slice(half * 8, half * 8 + 8), 16)) >>>
      0;
    while (x) {
      x &= x - 1;
      total++;
    }
  }
  return total;
}

/* ------------------------------------------------------------------ */
/* Collection                                                          */
/* ------------------------------------------------------------------ */

/**
 * Reads the SEO signals off an already-parsed document.
 *
 * `text` is the extracted plain text, used for the word count and the
 * near-duplicate fingerprint — taking those from the HTML would count markup
 * and navigation as content.
 */
export function collectSeoSignals(
  $: cheerio.CheerioAPI,
  baseUrl: string,
  text: string,
): SeoSignals {
  const pageHost = (() => {
    try {
      return new URL(baseUrl).hostname;
    } catch {
      return '';
    }
  })();

  const meta = (name: string): string | undefined => {
    const byName = $(`meta[name="${name}" i]`).first().attr('content');
    if (byName !== undefined) return clean(byName);
    const byProp = $(`meta[property="${name}" i]`).first().attr('content');
    return byProp === undefined ? undefined : clean(byProp);
  };

  const title = clean($('title').first().text()) || undefined;
  const description = meta('description') || undefined;

  const h1: string[] = [];
  $('h1').each((_i, el) => {
    const t = clean($(el).text());
    if (t) h1.push(t);
  });

  const canonicalRaw = $('link[rel="canonical" i]').first().attr('href');
  const canonical = absolutize(canonicalRaw, baseUrl) ?? undefined;

  const robotsMeta = meta('robots');
  const robotsLower = (robotsMeta ?? '').toLowerCase();

  const hreflang: { lang: string; href: string }[] = [];
  $('link[rel="alternate" i][hreflang]').each((_i, el) => {
    const lang = clean($(el).attr('hreflang'));
    const href = absolutize($(el).attr('href'), baseUrl);
    if (lang && href) hreflang.push({ lang, href });
  });

  // Images: a missing alt attribute and alt="" mean different things, so they
  // are counted separately rather than lumped together as "no alt".
  const images: ImageStats = { total: 0, missingAlt: 0, emptyAlt: 0 };
  $('img').each((_i, el) => {
    images.total++;
    const alt = $(el).attr('alt');
    if (alt === undefined) images.missingAlt++;
    else if (alt.trim() === '') images.emptyAlt++;
  });

  const links: OutLink[] = [];
  const seen = new Set<string>();
  $('a[href]').each((_i, el) => {
    const $el = $(el);
    const abs = absolutize($el.attr('href'), baseUrl);
    if (!abs) return;
    // One row per destination per page: a nav link repeated in the footer is
    // the same edge in the graph, and counting it twice skews inlink counts.
    if (seen.has(abs)) return;
    seen.add(abs);

    const rel = clean($el.attr('rel')).toLowerCase() || undefined;
    let host = '';
    try {
      host = new URL(abs).hostname;
    } catch {
      /* non-http scheme; treated as external */
    }
    links.push({
      url: abs,
      anchor: clean($el.text()).slice(0, 300),
      rel,
      internal: Boolean(host) && sameSite(host, pageHost),
      nofollow: /\b(nofollow|ugc|sponsored)\b/.test(rel ?? ''),
    });
  });

  const structuredTypes = new Set<string>();
  $('script[type="application/ld+json"]').each((_i, el) => {
    const raw = $(el).contents().text();
    if (!raw.trim()) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) {
          node.forEach(walk);
          return;
        }
        if (!node || typeof node !== 'object') return;
        const obj = node as Record<string, unknown>;
        const t = obj['@type'];
        if (typeof t === 'string') structuredTypes.add(t);
        else if (Array.isArray(t)) t.forEach((x) => typeof x === 'string' && structuredTypes.add(x));
        if (Array.isArray(obj['@graph'])) walk(obj['@graph']);
      };
      walk(parsed);
    } catch {
      /* malformed JSON-LD is reported by the audit, not here */
    }
  });

  const internalLinks = links.filter((l) => l.internal).length;

  return {
    title,
    titleLength: title?.length ?? 0,
    description,
    descriptionLength: description?.length ?? 0,
    h1,
    h2Count: $('h2').length,
    canonical,
    canonicalIsSelf: canonical ? canonical.replace(/\/$/, '') === baseUrl.replace(/\/$/, '') : undefined,
    robotsMeta,
    noindex: /\bnoindex\b/.test(robotsLower),
    nofollowPage: /\bnofollow\b/.test(robotsLower),
    hreflang,
    viewport: meta('viewport') || undefined,
    lang: clean($('html').attr('lang')) || undefined,
    wordCount: (text.match(/[^\s]+/g) ?? []).length,
    images,
    links,
    internalLinks,
    externalLinks: links.length - internalLinks,
    nofollowLinks: links.filter((l) => l.nofollow).length,
    structuredTypes: [...structuredTypes],
    ogTitle: meta('og:title') || undefined,
    ogDescription: meta('og:description') || undefined,
    ogImage: absolutize(meta('og:image'), baseUrl) ?? undefined,
    twitterCard: meta('twitter:card') || undefined,
    simhash: simhash(text),
  };
}
