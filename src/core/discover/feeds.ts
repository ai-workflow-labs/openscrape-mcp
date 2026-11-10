import { gunzipSync } from 'node:zlib';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import * as cheerio from 'cheerio';
import { httpFetch } from '../fetcher/http.js';
import { getRobots } from './robots.js';
import { scrape } from '../scrape.js';
import { htmlToMarkdown } from '../extract/markdown.js';
import { absolutize, isHttpUrl, normalizeUrl, originOf } from '../util/url.js';
import { runPool } from '../util/pool.js';
import { log } from '../util/log.js';

/**
 * Feed discovery, parsing and reading.
 *
 * A feed is the cheapest structured data on the web: one request hands over
 * titles, dates, authors, categories and often the full article body, with no
 * browser, no extraction heuristics and no guessing. Where `sitemap.ts` answers
 * "what pages exist", this answers "what is new, and when".
 *
 * Three wire formats, one normalised item shape: RSS 2.0 (plus RSS 1.0/RDF),
 * Atom 1.0, and JSON Feed 1.1.
 *
 * The hard rule here is dates. A silently wrong timestamp corrupts every
 * "what's new since" query downstream, so a date is either parsed from a format
 * we actually recognise or reported as unparsed — never replaced with "now".
 */

export type FeedFormat = 'rss' | 'rdf' | 'atom' | 'json';

/** Where an item's body came from, so a summary is never mistaken for an article. */
export type ContentSource =
  | 'content:encoded'
  | 'atom:content'
  | 'description'
  | 'atom:summary'
  | 'json:content_html'
  | 'json:content_text'
  | 'scraped';

export interface FeedDate {
  /** ISO 8601 UTC, present only when the original parsed cleanly. */
  iso?: string;
  /** Exactly what the feed wrote, kept whether or not it parsed. */
  raw: string;
  /** Which grammar matched: useful when a date looks surprising. */
  via?: 'iso8601' | 'rfc822' | 'epoch' | 'lenient';
}

export interface FeedItem {
  title?: string;
  url?: string;
  /** guid / atom:id / JSON Feed id, verbatim. */
  id?: string;
  published?: FeedDate;
  updated?: FeedDate;
  author?: string;
  categories: string[];
  /** Short teaser, as markdown. */
  summary?: string;
  /** Body as markdown. May be the feed's own teaser — check `contentSource`. */
  content?: string;
  contentSource?: ContentSource;
  /** True only when `content` is the article fetched from `url`, not the feed's body. */
  fullText: boolean;
  /** Set when a fullText fetch was asked for and failed. */
  fetchError?: string;
  /** First enclosure URL (podcast audio, image). */
  enclosure?: string;
  /** Feed this item came from. Set on merged timelines. */
  feedUrl?: string;
  feedTitle?: string;
}

export interface ParsedFeed {
  /** URL the feed was fetched from. */
  url: string;
  format: FeedFormat;
  title?: string;
  description?: string;
  /** The site the feed belongs to (channel link / atom alternate / home_page_url). */
  siteUrl?: string;
  updated?: FeedDate;
  items: FeedItem[];
  /** Items dropped because an earlier item had the same guid/id/url. */
  duplicatesDropped: number;
  /** Items that carried a date string we refused to guess at. */
  unparsableDates: number;
}

// ----------------------------------------------------------------- dates

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Named zones RFC 822 allows. Anything else is an offset or nothing. */
const NAMED_ZONES: Record<string, number> = {
  ut: 0, utc: 0, gmt: 0, z: 0,
  est: -5 * 60, edt: -4 * 60,
  cst: -6 * 60, cdt: -5 * 60,
  mst: -7 * 60, mdt: -6 * 60,
  pst: -8 * 60, pdt: -7 * 60,
};

/**
 * Plausibility window. A feed claiming 1970 or 2190 is a broken date, not an
 * archive, and letting it through would poison date sorting for every item
 * around it.
 */
function plausible(ms: number): boolean {
  if (!Number.isFinite(ms)) return false;
  const year = new Date(ms).getUTCFullYear();
  return year >= 1980 && year <= new Date().getUTCFullYear() + 2;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Date.UTC silently rolls overflow forward: "32 Nov" becomes 2 December, which
 * is exactly the kind of invented timestamp this module exists to avoid. So we
 * build the instant and then check it still describes the fields we were given.
 */
function exactUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms = 0,
  offsetMin = 0,
): number | null {
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 60) return null;
  const naive = Date.UTC(year, month, day, hour, minute, second, ms);
  if (!Number.isFinite(naive)) return null;
  const back = new Date(naive);
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month ||
    back.getUTCDate() !== day ||
    back.getUTCHours() !== hour ||
    back.getUTCMinutes() !== minute
  ) {
    return null;
  }
  return naive - offsetMin * 60_000;
}

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?\s*(Z|z|[+-]\d{2}:?\d{2})?)?$/;

const RFC822_RE =
  /^(?:[A-Za-z]{3,9},\s*)?(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*([A-Za-z]{1,5}|[+-]\d{4}|[+-]\d{2}:\d{2})?\s*$/;

function offsetMinutes(zone: string | undefined): number | null {
  if (!zone) return 0; // No zone stated: read as UTC rather than the scraper's local time.
  const z = zone.trim();
  if (/^[+-]\d{2}:?\d{2}$/.test(z)) {
    const sign = z.startsWith('-') ? -1 : 1;
    const digits = z.slice(1).replace(':', '');
    return sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
  }
  const named = NAMED_ZONES[z.toLowerCase()];
  return named === undefined ? null : named;
}

/**
 * Parses a feed date, or says it could not.
 *
 * Recognises ISO 8601 (Atom, JSON Feed), RFC 822/2822 (RSS) and bare epoch
 * seconds. Falls back to the engine's own lenient parser only when the string
 * at least contains a four-digit year, and tags the result so a caller can tell
 * a guessed date from a specified one.
 */
export function parseFeedDate(input: unknown): FeedDate | undefined {
  const raw = typeof input === 'string' ? input.trim() : typeof input === 'number' ? String(input) : '';
  if (!raw) return undefined;

  const isoMatch = ISO_RE.exec(raw);
  if (isoMatch) {
    const [, y, mo, d, h = '0', mi = '0', s = '0', frac = '0', zone] = isoMatch;
    const off = offsetMinutes(zone);
    if (off !== null) {
      const ms = exactUtc(
        Number(y),
        Number(mo) - 1,
        Number(d),
        Number(h),
        Number(mi),
        Number(s),
        Number(frac.padEnd(3, '0').slice(0, 3)),
        off,
      );
      if (ms !== null && plausible(ms)) return { iso: iso(ms), raw, via: 'iso8601' };
    }
    return { raw };
  }

  const rfc = RFC822_RE.exec(raw);
  if (rfc) {
    const [, d, monName, yearText, h = '0', mi = '0', s = '0', zone] = rfc;
    const month = MONTHS[monName.slice(0, 3).toLowerCase()];
    const off = offsetMinutes(zone);
    if (month !== undefined && off !== null) {
      let year = Number(yearText);
      if (yearText.length <= 2) year += year < 50 ? 2000 : 1900;
      const ms = exactUtc(year, month, Number(d), Number(h), Number(mi), Number(s), 0, off);
      if (ms !== null && plausible(ms)) return { iso: iso(ms), raw, via: 'rfc822' };
    }
    return { raw };
  }

  // Bare epoch seconds (some hand-rolled JSON feeds).
  if (/^\d{9,11}$/.test(raw)) {
    const ms = Number(raw) * 1000;
    if (plausible(ms)) return { iso: iso(ms), raw, via: 'epoch' };
    return { raw };
  }

  // Last resort, and only for something that looks like a date at all.
  if (/\b(19|20)\d{2}\b/.test(raw)) {
    const ms = Date.parse(raw);
    if (plausible(ms)) return { iso: iso(ms), raw, via: 'lenient' };
  }

  return { raw };
}

/** Sort key: newest first, undated last, stable. */
function dateKey(item: FeedItem): number {
  const stamp = item.published?.iso ?? item.updated?.iso;
  return stamp ? Date.parse(stamp) : -Infinity;
}

export function sortItemsNewestFirst(items: FeedItem[]): FeedItem[] {
  return [...items].sort((a, b) => dateKey(b) - dateKey(a));
}

// ------------------------------------------------------------ xml plumbing

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  // Namespace prefixes are kept: `content:encoded` is exactly the element
  // WordPress puts the full article body in, so throwing the prefix away would
  // lose the one field worth having.
  removeNSPrefix: false,
});

// Do not add `cdataPropName` or `commentPropName` here. This builder is handed
// the parsed body of a remote feed, so its input is whatever a stranger chose to
// publish; GHSA-gh4j-gqv2-49f6 is an injection through exactly those two options,
// where a `]]>` or `-->` inside the value closes the section early and whatever
// follows becomes live markup. Without them the builder emits neither CDATA nor
// comments, which is why that advisory never reached this call. Text and
// attribute values are escaped either way.
const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  suppressEmptyNode: true,
});

type Node = Record<string, unknown>;

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Text of an element, whether it arrived as a string, a CDATA blob or an attributed node. */
function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const t = textOf(entry);
      if (t) return t;
    }
    return undefined;
  }
  if (value && typeof value === 'object') {
    const t = (value as Node)['#text'];
    if (typeof t === 'string') return t.trim() || undefined;
    if (typeof t === 'number') return String(t);
  }
  return undefined;
}

/**
 * HTML of an element. Atom allows `type="xhtml"`, which the XML parser hands
 * back as a nested object tree rather than a string; rebuilding it keeps those
 * entries readable instead of silently empty.
 */
function markupOf(value: unknown): string | undefined {
  const text = textOf(value);
  if (text) return text;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const node = { ...(value as Node) };
    for (const key of Object.keys(node)) if (key.startsWith('@')) delete node[key];
    if (Object.keys(node).length === 0) return undefined;
    try {
      const built = builder.build(node);
      return typeof built === 'string' && built.trim() ? built : undefined;
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const m = markupOf(entry);
      if (m) return m;
    }
  }
  return undefined;
}

/** Picks the first present key, so namespace-prefixed variants are covered. */
function pick(node: Node, keys: string[]): unknown {
  for (const key of keys) {
    if (node[key] !== undefined && node[key] !== null) return node[key];
  }
  return undefined;
}

function maybeGunzip(body: Buffer, url: string, contentType: string): Buffer {
  const looksGzipped =
    url.endsWith('.gz') ||
    contentType.includes('gzip') ||
    (body.length > 2 && body[0] === 0x1f && body[1] === 0x8b);
  if (!looksGzipped) return body;
  try {
    return gunzipSync(body);
  } catch {
    return body;
  }
}

function collapse(text: string | undefined, limit = 400): string | undefined {
  if (!text) return undefined;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  return flat.length > limit ? flat.slice(0, limit).trimEnd() + '…' : flat;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', trade: '™',
  copy: '©', reg: '®', deg: '°', middot: '·', bull: '•', eacute: 'é',
};

/**
 * Feeds routinely double-escape: the XML carries `&amp;#8230;`, the XML parser
 * hands back `&amp;#8230;` -> `&#8230;`, and that survives into the text as
 * literal gibberish. One extra decode pass after conversion cleans it up.
 */
function decodeEntities(text: string): string {
  if (!/&(#\d+|#x[0-9a-f]+|[a-z]+);/i.test(text)) return text;
  return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number(body.slice(1));
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Feed bodies are HTML fragments; markdown is what the rest of the server speaks. */
function bodyToMarkdown(html: string | undefined): string | undefined {
  if (!html) return undefined;
  const looksHtml = /<[a-z!/][\s\S]*>/i.test(html);
  const md = looksHtml ? htmlToMarkdown(html) : html.trim();
  return decodeEntities(md).trim() || undefined;
}

// ------------------------------------------------------------- normalising

interface ItemDraft {
  item: FeedItem;
  dedupeKeys: string[];
}

function finish(drafts: ItemDraft[], feed: Omit<ParsedFeed, 'items' | 'duplicatesDropped' | 'unparsableDates'>): ParsedFeed {
  const seen = new Set<string>();
  const items: FeedItem[] = [];
  let duplicatesDropped = 0;
  let unparsableDates = 0;

  for (const draft of drafts) {
    const keys = draft.dedupeKeys.filter(Boolean);
    if (keys.some((k) => seen.has(k))) {
      duplicatesDropped++;
      continue;
    }
    for (const k of keys) seen.add(k);
    const { published, updated } = draft.item;
    if ((published && !published.iso) || (!published && updated && !updated.iso)) unparsableDates++;
    items.push(draft.item);
  }

  return { ...feed, items, duplicatesDropped, unparsableDates };
}

function dedupeKeysFor(id: string | undefined, url: string | undefined, title: string | undefined): string[] {
  const keys: string[] = [];
  if (id) keys.push('id:' + id);
  if (url) {
    try {
      keys.push('url:' + normalizeUrl(url));
    } catch {
      keys.push('url:' + url);
    }
  }
  if (!id && !url && title) keys.push('title:' + title.toLowerCase());
  return keys;
}

// ------------------------------------------------------------------- RSS

function parseRssChannel(channel: Node, baseUrl: string, format: FeedFormat, itemNodes: Node[]): ParsedFeed {
  const siteUrl = absolutize(textOf(pick(channel, ['link'])), baseUrl) ?? undefined;
  const base = siteUrl ?? baseUrl;

  const drafts: ItemDraft[] = itemNodes.map((node) => {
    const guid = textOf(pick(node, ['guid', 'dc:identifier']));
    const linkText = textOf(pick(node, ['link', 'feedburner:origLink']));
    let url = absolutize(linkText, base) ?? undefined;
    // A guid flagged as a permalink is a real URL, and some feeds ship no <link>.
    if (!url && guid && isHttpUrl(guid)) url = guid;

    const description = markupOf(pick(node, ['description', 'summary']));
    const encoded = markupOf(pick(node, ['content:encoded', 'content']));

    const contentHtml = encoded ?? description;
    const contentSource: ContentSource | undefined = encoded
      ? 'content:encoded'
      : description
        ? 'description'
        : undefined;

    const enclosureNode = asArray(pick(node, ['enclosure']) as Node | Node[] | undefined)[0];
    const title = textOf(pick(node, ['title']));

    const item: FeedItem = {
      title,
      url,
      id: guid,
      published: parseFeedDate(textOf(pick(node, ['pubDate', 'dc:date', 'published', 'date']))),
      updated: parseFeedDate(textOf(pick(node, ['atom:updated', 'lastBuildDate', 'dcterms:modified']))),
      author: textOf(pick(node, ['dc:creator', 'author', 'itunes:author'])),
      categories: asArray(pick(node, ['category']) as unknown[])
        .map((c) => textOf(c) ?? textOf((c as Node)?.['@term']))
        .filter((c): c is string => Boolean(c)),
      summary: collapse(bodyToMarkdown(description)),
      content: bodyToMarkdown(contentHtml),
      contentSource,
      fullText: false,
      enclosure: absolutize(textOf(enclosureNode?.['@url']), base) ?? undefined,
    };

    return { item, dedupeKeys: dedupeKeysFor(guid, url, title) };
  });

  return finish(drafts, {
    url: baseUrl,
    format,
    title: textOf(pick(channel, ['title'])),
    description: collapse(bodyToMarkdown(markupOf(pick(channel, ['description', 'subtitle'])))),
    siteUrl,
    updated: parseFeedDate(textOf(pick(channel, ['lastBuildDate', 'pubDate', 'dc:date']))),
  });
}

// ------------------------------------------------------------------ Atom

/** Atom links are typed; the article is the `alternate` one, not `self` or `hub`. */
function atomLink(value: unknown, base: string, wantRel = 'alternate'): string | undefined {
  const links = asArray(value as Node | Node[] | undefined);
  const candidates = links.filter((l) => l && typeof l === 'object');
  const scored = candidates
    .map((l) => {
      const rel = String(l['@rel'] ?? 'alternate');
      const type = String(l['@type'] ?? '');
      let score = 0;
      if (rel === wantRel) score += 3;
      else if (rel === 'self' && wantRel !== 'self') score -= 2;
      else if (rel !== 'alternate') score -= 1;
      if (type.includes('html')) score += 2;
      return { href: absolutize(String(l['@href'] ?? ''), base), score };
    })
    .filter((c): c is { href: string; score: number } => Boolean(c.href))
    .sort((a, b) => b.score - a.score);

  if (scored.length) return scored[0].href;
  // Some feeds write <link>http://...</link> even inside Atom.
  return absolutize(textOf(value), base) ?? undefined;
}

function authorName(value: unknown): string | undefined {
  for (const entry of asArray(value as unknown[])) {
    if (typeof entry === 'string') {
      const t = entry.trim();
      if (t) return t;
      continue;
    }
    if (entry && typeof entry === 'object') {
      const name = textOf((entry as Node).name) ?? textOf((entry as Node).email);
      if (name) return name;
    }
  }
  return undefined;
}

function parseAtomFeed(feed: Node, baseUrl: string): ParsedFeed {
  const xmlBase = textOf(feed['@xml:base']);
  const base = (xmlBase && absolutize(xmlBase, baseUrl)) || baseUrl;
  const siteUrl = atomLink(feed.link, base);

  const entries = asArray(pick(feed, ['entry']) as Node | Node[] | undefined).filter(Boolean);

  const drafts: ItemDraft[] = entries.map((node) => {
    const entryBase = (textOf(node['@xml:base']) && absolutize(textOf(node['@xml:base']), base)) || base;
    const id = textOf(pick(node, ['id']));
    let url = atomLink(node.link, entryBase);
    if (!url && id && isHttpUrl(id)) url = id;

    const contentHtml = markupOf(pick(node, ['content']));
    const summaryHtml = markupOf(pick(node, ['summary']));
    const title = textOf(pick(node, ['title']));

    const item: FeedItem = {
      title,
      url,
      id,
      // `issued`/`modified` are Atom 0.3, still in the wild.
      published: parseFeedDate(textOf(pick(node, ['published', 'issued', 'created']))) ??
        parseFeedDate(textOf(pick(node, ['updated', 'modified']))),
      updated: parseFeedDate(textOf(pick(node, ['updated', 'modified']))),
      author: authorName(pick(node, ['author', 'dc:creator'])),
      categories: asArray(pick(node, ['category']) as unknown[])
        .map((c) => (typeof c === 'object' && c ? textOf((c as Node)['@term']) ?? textOf(c) : textOf(c)))
        .filter((c): c is string => Boolean(c)),
      summary: collapse(bodyToMarkdown(summaryHtml ?? contentHtml)),
      content: bodyToMarkdown(contentHtml ?? summaryHtml),
      contentSource: contentHtml ? 'atom:content' : summaryHtml ? 'atom:summary' : undefined,
      fullText: false,
      enclosure: atomLink(node.link, entryBase, 'enclosure'),
    };

    return { item, dedupeKeys: dedupeKeysFor(id, url, title) };
  });

  return finish(drafts, {
    url: baseUrl,
    format: 'atom',
    title: textOf(pick(feed, ['title'])),
    description: collapse(bodyToMarkdown(markupOf(pick(feed, ['subtitle', 'tagline'])))),
    siteUrl,
    updated: parseFeedDate(textOf(pick(feed, ['updated', 'modified']))),
  });
}

// ------------------------------------------------------------- JSON Feed

interface JsonFeedItem {
  id?: unknown;
  url?: unknown;
  external_url?: unknown;
  title?: unknown;
  content_html?: unknown;
  content_text?: unknown;
  summary?: unknown;
  date_published?: unknown;
  date_modified?: unknown;
  author?: { name?: unknown } | unknown;
  authors?: unknown;
  tags?: unknown;
  attachments?: unknown;
}

function jsonAuthors(item: JsonFeedItem, feedLevel: unknown): string | undefined {
  const pools = [item.authors, item.author, feedLevel];
  for (const pool of pools) {
    for (const entry of asArray(pool as unknown[])) {
      if (typeof entry === 'string' && entry.trim()) return entry.trim();
      if (entry && typeof entry === 'object') {
        const name = (entry as Node).name;
        if (typeof name === 'string' && name.trim()) return name.trim();
      }
    }
  }
  return undefined;
}

function parseJsonFeed(doc: Node, baseUrl: string): ParsedFeed | null {
  const version = typeof doc.version === 'string' ? doc.version : '';
  const items = Array.isArray(doc.items) ? (doc.items as JsonFeedItem[]) : null;
  if (!items) return null;
  if (!version.includes('jsonfeed.org') && typeof doc.title !== 'string') return null;

  const homePage = typeof doc.home_page_url === 'string' ? doc.home_page_url : undefined;
  const base = homePage ? absolutize(homePage, baseUrl) ?? baseUrl : baseUrl;

  const drafts: ItemDraft[] = items.map((raw) => {
    const id = typeof raw.id === 'string' ? raw.id : raw.id !== undefined ? String(raw.id) : undefined;
    const href = typeof raw.url === 'string' ? raw.url : typeof raw.external_url === 'string' ? raw.external_url : undefined;
    let url = absolutize(href, base) ?? undefined;
    if (!url && id && isHttpUrl(id)) url = id;

    const html = typeof raw.content_html === 'string' ? raw.content_html : undefined;
    const text = typeof raw.content_text === 'string' ? raw.content_text : undefined;
    const summaryText = typeof raw.summary === 'string' ? raw.summary : undefined;
    const title = typeof raw.title === 'string' ? raw.title.trim() || undefined : undefined;

    const attachment = asArray(raw.attachments as Node[] | undefined)[0];

    const item: FeedItem = {
      title,
      url,
      id,
      published: parseFeedDate(raw.date_published),
      updated: parseFeedDate(raw.date_modified),
      author: jsonAuthors(raw, doc.authors ?? doc.author),
      categories: asArray(raw.tags as unknown[])
        .map((t) => (typeof t === 'string' ? t.trim() : undefined))
        .filter((t): t is string => Boolean(t)),
      summary: collapse(summaryText ?? bodyToMarkdown(html) ?? text),
      content: bodyToMarkdown(html) ?? (text ? text.trim() : undefined),
      contentSource: html ? 'json:content_html' : text ? 'json:content_text' : undefined,
      fullText: false,
      enclosure: absolutize(typeof attachment?.url === 'string' ? attachment.url : undefined, base) ?? undefined,
    };

    return { item, dedupeKeys: dedupeKeysFor(id, url, title) };
  });

  return finish(drafts, {
    url: baseUrl,
    format: 'json',
    title: typeof doc.title === 'string' ? doc.title : undefined,
    description: typeof doc.description === 'string' ? collapse(doc.description) : undefined,
    siteUrl: homePage ? absolutize(homePage, baseUrl) ?? undefined : undefined,
    updated: undefined,
  });
}

// --------------------------------------------------------------- entry point

/**
 * Parses a feed body in any of the three formats.
 *
 * Returns null when the bytes are not a feed at all — which is how candidate
 * URLs get verified, rather than trusting a path that merely looks feed-shaped.
 */
export function parseFeed(body: Buffer | string, feedUrl: string, contentType = ''): ParsedFeed | null {
  const text = typeof body === 'string' ? body : maybeGunzip(body, feedUrl, contentType).toString('utf8');
  const trimmed = text.replace(/^﻿/, '').trimStart();
  if (!trimmed) return null;

  if (trimmed.startsWith('{')) {
    try {
      const doc = JSON.parse(trimmed) as Node;
      return parseJsonFeed(doc, feedUrl);
    } catch (err) {
      log.debug('json feed parse failed', { feedUrl, error: String(err) });
      return null;
    }
  }

  if (!trimmed.startsWith('<')) return null;

  let doc: Node;
  try {
    doc = parser.parse(trimmed) as Node;
  } catch (err) {
    log.debug('feed xml parse failed', { feedUrl, error: String(err) });
    return null;
  }

  const rss = (pick(doc, ['rss', 'rdf:RDF', 'RDF']) ?? undefined) as Node | undefined;
  if (rss) {
    const channel = asArray(pick(rss, ['channel']) as Node | Node[] | undefined)[0];
    if (channel) {
      // RSS 1.0 hangs <item> off the document root, not off <channel>.
      const items = [
        ...asArray(pick(channel, ['item']) as Node | Node[] | undefined),
        ...asArray(pick(rss, ['item']) as Node | Node[] | undefined),
      ].filter(Boolean);
      const isRdf = doc['rdf:RDF'] !== undefined || doc.RDF !== undefined;
      return parseRssChannel(channel, feedUrl, isRdf ? 'rdf' : 'rss', items);
    }
  }

  const atom = (pick(doc, ['feed', 'atom:feed']) ?? undefined) as Node | undefined;
  if (atom && typeof atom === 'object') {
    return parseAtomFeed(atom, feedUrl);
  }

  return null;
}

// ------------------------------------------------------------ fetch a feed

export interface FetchFeedResult {
  url: string;
  ok: boolean;
  status?: number;
  feed?: ParsedFeed;
  /** Why this is not a usable feed: http status, "not a feed", a network error. */
  reason?: string;
  contentType?: string;
  bytes?: number;
}

export async function fetchFeed(url: string, timeout = 15_000): Promise<FetchFeedResult> {
  if (!isHttpUrl(url)) return { url, ok: false, reason: 'not an http(s) URL' };

  let page;
  try {
    page = await httpFetch(url, {
      timeout,
      headers: {
        accept:
          'application/rss+xml, application/atom+xml, application/feed+json, application/json, application/xml, text/xml;q=0.9, */*;q=0.5',
      },
    });
  } catch (err) {
    return { url, ok: false, reason: `fetch failed: ${String(err)}` };
  }

  if (page.status >= 400) {
    return { url, ok: false, status: page.status, reason: `HTTP ${page.status}` };
  }
  if (page.body.byteLength === 0) {
    return { url, ok: false, status: page.status, reason: 'empty response' };
  }

  const parsed = parseFeed(page.body, page.finalUrl || url, page.contentType);
  if (!parsed) {
    return {
      url,
      ok: false,
      status: page.status,
      contentType: page.contentType,
      bytes: page.body.byteLength,
      reason: `not a feed (${page.contentType.split(';')[0] || 'unknown type'})`,
    };
  }

  return {
    url,
    ok: true,
    status: page.status,
    feed: { ...parsed, url: page.finalUrl || url },
    contentType: page.contentType,
    bytes: page.body.byteLength,
  };
}

// ---------------------------------------------------------------- discovery

/** Conventional paths, tried only when the page advertises nothing. */
export const FEED_GUESSES = [
  '/feed',
  '/rss',
  '/rss.xml',
  '/atom.xml',
  '/feed.xml',
  '/index.xml',
  '/feed.json',
  '/blog/feed',
  '/?feed=rss2',
];

const FEED_TYPES = /(rss\+xml|atom\+xml|feed\+json|rdf\+xml)/i;

export type CandidateSource = 'link-tag' | 'anchor' | 'robots' | 'guess' | 'given';

export interface FeedCandidate {
  url: string;
  source: CandidateSource;
  /** The type the page claimed, when it claimed one. */
  declaredType?: string;
  /** The link's own title attribute. */
  declaredTitle?: string;
}

export interface TriedCandidate extends FeedCandidate {
  ok: boolean;
  reason?: string;
  status?: number;
}

export interface DiscoveredFeed {
  url: string;
  format: FeedFormat;
  title?: string;
  description?: string;
  siteUrl?: string;
  source: CandidateSource;
  itemCount: number;
  /** Newest parsed item date, when any item had one. */
  newestItem?: string;
  /** Items whose dates we would not guess at. */
  unparsableDates: number;
  /** A couple of titles, as proof the feed really parsed. */
  sampleTitles: string[];
}

export interface FeedDiscovery {
  pageUrl: string;
  finalUrl?: string;
  feeds: DiscoveredFeed[];
  /** Every candidate and what happened to it — a site with no feed is a real answer. */
  tried: TriedCandidate[];
  pageFetched: boolean;
  pageError?: string;
  elapsedMs: number;
}

/** Reads `<link rel="alternate">` declarations, plus obvious feed anchors. */
export function feedLinksInHtml(html: string, baseUrl: string): FeedCandidate[] {
  const found: FeedCandidate[] = [];
  const seen = new Set<string>();

  const push = (href: string | undefined, source: CandidateSource, type?: string, title?: string) => {
    const abs = absolutize(href, baseUrl);
    if (!abs || !isHttpUrl(abs)) return;
    let key: string;
    try {
      key = normalizeUrl(abs);
    } catch {
      key = abs;
    }
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ url: abs, source, declaredType: type, declaredTitle: title });
  };

  let $: cheerio.CheerioAPI;
  try {
    $ = cheerio.load(html);
  } catch (err) {
    log.debug('feed link scan failed', { baseUrl, error: String(err) });
    return found;
  }

  $('link[rel], a[type]').each((_, el) => {
    const rel = ($(el).attr('rel') ?? '').toLowerCase();
    const type = $(el).attr('type') ?? '';
    const href = $(el).attr('href');
    if (!FEED_TYPES.test(type)) return;
    if (el.tagName?.toLowerCase() === 'link' && !/alternate|alternative/.test(rel) && rel !== '') return;
    push(href, el.tagName?.toLowerCase() === 'link' ? 'link-tag' : 'anchor', type, $(el).attr('title'));
  });

  // Plain <a href="/feed"> links, for sites that never declared an alternate.
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    if (!/(^|\/)(feed|rss|atom|index\.xml|feed\.json|rss\.xml|atom\.xml)(\/|$|\?)/i.test(href)) return;
    push(href, 'anchor', undefined, $(el).attr('title'));
  });

  return found;
}

export interface DiscoverOptions {
  /** Per-request timeout. Default 15s. */
  timeout?: number;
  /** Try the conventional paths. Default true. */
  tryGuesses?: boolean;
  /** Stop after verifying this many feeds. Default 10. */
  limit?: number;
  /** Candidate verifications in flight. Default 6. */
  concurrency?: number;
  /** Sample item titles to keep per feed. Default 3. */
  sampleTitles?: number;
}

/**
 * Finds the feeds a page offers.
 *
 * Declared `<link rel="alternate">` first, then anchors, then the conventional
 * paths. Every candidate is fetched and parsed before it is reported, because
 * `/feed` returning a 200 HTML page is the normal case on sites that have no
 * feed at all.
 */
export async function discoverFeeds(pageUrl: string, opts: DiscoverOptions = {}): Promise<FeedDiscovery> {
  const started = Date.now();
  const timeout = opts.timeout ?? 15_000;
  const limit = opts.limit ?? 10;
  const sampleCount = opts.sampleTitles ?? 3;

  if (!isHttpUrl(pageUrl)) {
    return {
      pageUrl,
      feeds: [],
      tried: [],
      pageFetched: false,
      pageError: `"${pageUrl}" is not an http(s) URL`,
      elapsedMs: Date.now() - started,
    };
  }

  const candidates: FeedCandidate[] = [];
  const seen = new Set<string>();
  const addCandidate = (candidate: FeedCandidate) => {
    let key: string;
    try {
      key = normalizeUrl(candidate.url);
    } catch {
      return;
    }
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };

  let finalUrl: string | undefined;
  let pageFetched = false;
  let pageError: string | undefined;
  let directFeed: ParsedFeed | null = null;

  try {
    const page = await httpFetch(pageUrl, { timeout });
    finalUrl = page.finalUrl || pageUrl;
    if (page.status >= 400) {
      pageError = `HTTP ${page.status} fetching the page`;
    } else {
      pageFetched = true;
      const bodyText = maybeGunzip(page.body, pageUrl, page.contentType).toString('utf8');
      // The URL given may itself be a feed.
      directFeed = parseFeed(bodyText, finalUrl, page.contentType);
      if (!directFeed) {
        for (const candidate of feedLinksInHtml(bodyText, finalUrl)) addCandidate(candidate);
      }
    }
  } catch (err) {
    pageError = `fetch failed: ${String(err)}`;
  }

  if (directFeed) {
    const feed = directFeed;
    return {
      pageUrl,
      finalUrl,
      feeds: [toDiscovered(feed, 'given', sampleCount)],
      tried: [{ url: finalUrl ?? pageUrl, source: 'given', ok: true }],
      pageFetched,
      elapsedMs: Date.now() - started,
    };
  }

  // Some sites advertise their feed in robots.txt alongside sitemaps.
  try {
    const robots = await getRobots(pageUrl, timeout);
    for (const entry of robots.sitemaps) {
      if (/feed|rss|atom/i.test(entry)) addCandidate({ url: entry, source: 'robots' });
    }
  } catch {
    /* robots is a bonus, never a blocker */
  }

  if (opts.tryGuesses !== false) {
    let origin: string;
    try {
      origin = originOf(finalUrl ?? pageUrl);
    } catch {
      origin = '';
    }
    if (origin) {
      for (const path of FEED_GUESSES) addCandidate({ url: origin + path, source: 'guess' });
    }
  }

  const results = await runPool(candidates, Math.max(1, opts.concurrency ?? 6), async (candidate) => {
    const res = await fetchFeed(candidate.url, timeout);
    return { candidate, res };
  });

  const feeds: DiscoveredFeed[] = [];
  const tried: TriedCandidate[] = [];

  // Several candidate paths routinely redirect to the same document — /feed,
  // /rss and /?feed=rss2 are one feed on most WordPress sites — so feeds are
  // de-duplicated by where they actually landed, not by the path we guessed.
  const resolved = new Set<string>();
  for (const { candidate, res } of results) {
    if (!res.ok || !res.feed) {
      tried.push({ ...candidate, ok: false, reason: res.reason, status: res.status });
      continue;
    }
    let key: string;
    try {
      key = normalizeUrl(res.feed.url);
    } catch {
      key = res.feed.url;
    }
    if (resolved.has(key)) {
      tried.push({ ...candidate, ok: true, status: res.status, reason: `same feed as ${res.feed.url}` });
      continue;
    }
    resolved.add(key);
    tried.push({ ...candidate, ok: true, status: res.status });
    if (feeds.length < limit) {
      feeds.push(toDiscovered(res.feed, candidate.source, sampleCount, candidate.declaredTitle));
    }
  }

  // Declared links before guesses: that is the order of trustworthiness.
  const rank: Record<CandidateSource, number> = { given: 0, 'link-tag': 1, robots: 2, anchor: 3, guess: 4 };
  feeds.sort((a, b) => rank[a.source] - rank[b.source] || b.itemCount - a.itemCount);

  log.debug('feed discovery', { pageUrl, candidates: candidates.length, feeds: feeds.length });

  return { pageUrl, finalUrl, feeds, tried, pageFetched, pageError, elapsedMs: Date.now() - started };
}

function toDiscovered(
  feed: ParsedFeed,
  source: CandidateSource,
  sampleCount: number,
  fallbackTitle?: string,
): DiscoveredFeed {
  const dated = feed.items.map((i) => i.published?.iso ?? i.updated?.iso).filter((d): d is string => Boolean(d));
  dated.sort();
  return {
    url: feed.url,
    format: feed.format,
    title: feed.title ?? fallbackTitle,
    description: feed.description,
    siteUrl: feed.siteUrl,
    source,
    itemCount: feed.items.length,
    newestItem: dated.length ? dated[dated.length - 1] : undefined,
    unparsableDates: feed.unparsableDates,
    sampleTitles: feed.items
      .slice(0, Math.max(0, sampleCount))
      .map((i) => i.title ?? '(untitled)'),
  };
}

// ------------------------------------------------------------------ reading

export interface ReadFeedOptions {
  /** Items to return, newest first. Default 20. */
  limit?: number;
  /** Only items published (or updated) at or after this instant. */
  since?: string;
  /**
   * Keep item bodies. Default true. When false the bodies are dropped and
   * nothing is reported as truncated — a budget cannot cut what was not asked
   * for, and saying otherwise would be a misleading warning.
   */
  includeContent?: boolean;
  /** Fetch each item's page for the real article body. */
  fullText?: boolean;
  /** Total character budget across all item bodies. Default 20000. */
  maxChars?: number;
  /** Characters of body kept per item when not budget-limited. Default 4000. */
  perItemChars?: number;
  /** Concurrent article fetches when fullText is on. Default 5. */
  concurrency?: number;
  timeout?: number;
  /** Serve article fetches from the local cache when younger than this. */
  maxAge?: number;
}

export interface FeedReadResult {
  url: string;
  ok: boolean;
  reason?: string;
  feed?: ParsedFeed;
  items: FeedItem[];
  /** Items the feed carried, before limit/since filtering. */
  totalItems: number;
  /** Items dropped by the `since` filter. */
  filteredOut: number;
  /** Items the `since` filter could not judge because their date never parsed. */
  undatedSkipped: number;
  /** True when a character budget cut item bodies short. */
  truncated: boolean;
  truncatedChars: number;
  /** Items whose full-article fetch failed. */
  fullTextFailures: number;
  elapsedMs: number;
}

function clipBody(item: FeedItem, perItem: number, budget: { left: number; cut: number }): void {
  if (!item.content) return;
  const allowance = Math.max(0, Math.min(perItem, budget.left));
  if (item.content.length <= allowance) {
    budget.left -= item.content.length;
    return;
  }
  budget.cut += item.content.length - allowance;
  item.content = allowance > 0 ? item.content.slice(0, allowance).trimEnd() + '…' : undefined;
  budget.left -= allowance;
}

/** Reads one feed: newest items, optional since-filter, optional real article bodies. */
export async function readFeed(feedUrl: string, opts: ReadFeedOptions = {}): Promise<FeedReadResult> {
  const started = Date.now();
  const limit = Math.max(1, opts.limit ?? 20);
  const perItem = Math.max(0, opts.perItemChars ?? 4000);
  const budget = { left: Math.max(0, opts.maxChars ?? 20_000), cut: 0 };

  const fetched = await fetchFeed(feedUrl, opts.timeout ?? 15_000);
  if (!fetched.ok || !fetched.feed) {
    return {
      url: feedUrl,
      ok: false,
      reason: fetched.reason,
      items: [],
      totalItems: 0,
      filteredOut: 0,
      undatedSkipped: 0,
      truncated: false,
      truncatedChars: 0,
      fullTextFailures: 0,
      elapsedMs: Date.now() - started,
    };
  }

  const feed = fetched.feed;
  const all = sortItemsNewestFirst(feed.items);
  let filteredOut = 0;
  let undatedSkipped = 0;
  let kept = all;

  if (opts.since) {
    const cutoff = Date.parse(opts.since);
    if (Number.isFinite(cutoff)) {
      kept = all.filter((item) => {
        const stamp = item.published?.iso ?? item.updated?.iso;
        if (!stamp) {
          // No trustworthy date, so no honest answer to "is it newer?".
          undatedSkipped++;
          return false;
        }
        if (Date.parse(stamp) >= cutoff) return true;
        filteredOut++;
        return false;
      });
    }
  }

  const items = kept.slice(0, limit).map((item) => ({ ...item, feedUrl: feed.url, feedTitle: feed.title }));
  let fullTextFailures = 0;

  if (opts.fullText && items.length) {
    const targets = items.map((item, index) => ({ item, index })).filter((t) => t.item.url);
    await runPool(targets, Math.max(1, opts.concurrency ?? 5), async ({ item }) => {
      try {
        const result = await scrape(item.url as string, {
          formats: ['markdown'],
          onlyMainContent: true,
          maxAge: opts.maxAge,
          timeout: opts.timeout,
        });
        if (result.success && result.markdown?.trim()) {
          item.content = result.markdown.trim();
          item.contentSource = 'scraped';
          item.fullText = true;
        } else {
          fullTextFailures++;
          item.fetchError = result.error ?? 'no article text returned';
        }
      } catch (err) {
        fullTextFailures++;
        item.fetchError = String(err);
      }
      return null;
    });
  }

  if (opts.includeContent === false && !opts.fullText) {
    for (const item of items) item.content = undefined;
  } else {
    for (const item of items) clipBody(item, perItem, budget);
  }

  return {
    url: feed.url,
    ok: true,
    feed,
    items,
    totalItems: feed.items.length,
    filteredOut,
    undatedSkipped,
    truncated: budget.cut > 0,
    truncatedChars: budget.cut,
    fullTextFailures,
    elapsedMs: Date.now() - started,
  };
}

// --------------------------------------------------------------------- OPML

export interface OpmlFeed {
  url: string;
  title?: string;
  siteUrl?: string;
  /** Enclosing outline titles, so a grouped subscription list keeps its folders. */
  category?: string;
}

export interface OpmlDocument {
  title?: string;
  feeds: OpmlFeed[];
  /** Outlines that had no xmlUrl, so nothing was silently dropped. */
  skipped: number;
}

/** Parses an OPML subscription list into its feed URLs. */
export function parseOpml(xml: string, baseUrl = 'https://example.invalid/'): OpmlDocument {
  const feeds: OpmlFeed[] = [];
  let skipped = 0;
  let title: string | undefined;

  let doc: Node;
  try {
    doc = parser.parse(xml) as Node;
  } catch (err) {
    log.debug('opml parse failed', { error: String(err) });
    return { title, feeds, skipped };
  }

  const opml = (pick(doc, ['opml', 'OPML']) ?? undefined) as Node | undefined;
  if (!opml) return { title, feeds, skipped };

  const head = asArray(pick(opml, ['head']) as Node | Node[] | undefined)[0];
  if (head) title = textOf(pick(head, ['title']));

  const seen = new Set<string>();

  const walk = (node: Node, trail: string[]): void => {
    const xmlUrl = textOf(node['@xmlUrl']) ?? textOf(node['@xmlurl']) ?? textOf(node['@url']);
    const outlineTitle = textOf(node['@title']) ?? textOf(node['@text']);
    const children = asArray(pick(node, ['outline']) as Node | Node[] | undefined);

    if (xmlUrl) {
      const abs = absolutize(xmlUrl, baseUrl);
      if (abs && isHttpUrl(abs)) {
        let key: string;
        try {
          key = normalizeUrl(abs);
        } catch {
          key = abs;
        }
        if (!seen.has(key)) {
          seen.add(key);
          feeds.push({
            url: abs,
            title: outlineTitle,
            siteUrl: absolutize(textOf(node['@htmlUrl']), baseUrl) ?? undefined,
            category: trail.length ? trail.join(' / ') : undefined,
          });
        }
      } else {
        skipped++;
      }
    } else if (children.length === 0) {
      skipped++;
    }

    const nextTrail = outlineTitle && children.length ? [...trail, outlineTitle] : trail;
    for (const child of children) walk(child, nextTrail);
  };

  const body = asArray(pick(opml, ['body']) as Node | Node[] | undefined)[0];
  for (const outline of asArray(pick(body ?? {}, ['outline']) as Node | Node[] | undefined)) {
    walk(outline, []);
  }

  return { title, feeds, skipped };
}

/** Loads OPML from a URL or from inline XML text. */
export async function loadOpml(source: string, timeout = 15_000): Promise<OpmlDocument & { source: string }> {
  const trimmed = source.trim();
  if (trimmed.startsWith('<')) {
    return { ...parseOpml(trimmed), source: 'inline' };
  }
  if (!isHttpUrl(trimmed)) {
    return { title: undefined, feeds: [], skipped: 0, source: trimmed };
  }
  const page = await httpFetch(trimmed, { timeout });
  if (page.status >= 400) {
    return { title: undefined, feeds: [], skipped: 0, source: trimmed };
  }
  const xml = maybeGunzip(page.body, trimmed, page.contentType).toString('utf8');
  return { ...parseOpml(xml, page.finalUrl || trimmed), source: trimmed };
}

// ----------------------------------------------------------------- timeline

export interface TimelineOptions extends ReadFeedOptions {
  /** Feeds fetched at once. Default 6. */
  feedConcurrency?: number;
  /** Items in the merged timeline. Default 30. */
  limit?: number;
  /** Items taken from each feed before merging. Default 50. */
  perFeedLimit?: number;
}

export interface TimelineFeedStatus {
  url: string;
  ok: boolean;
  title?: string;
  format?: FeedFormat;
  items: number;
  reason?: string;
}

export interface TimelineResult {
  items: FeedItem[];
  feeds: TimelineFeedStatus[];
  /** Items across all feeds before the merge limit. */
  totalItems: number;
  undatedSkipped: number;
  undatedIncluded: number;
  truncated: boolean;
  truncatedChars: number;
  fullTextFailures: number;
  elapsedMs: number;
}

/**
 * Reads several feeds into one date-sorted timeline.
 *
 * This is what turns the tool into a news firehose over a set of sites: one
 * call, one merged list, and a per-feed status block so a silent failure never
 * reads as "nothing was published".
 */
export async function readTimeline(feedUrls: string[], opts: TimelineOptions = {}): Promise<TimelineResult> {
  const started = Date.now();
  const limit = Math.max(1, opts.limit ?? 30);
  const perFeedLimit = Math.max(1, opts.perFeedLimit ?? 50);
  const perItem = Math.max(0, opts.perItemChars ?? 1200);
  const budget = { left: Math.max(0, opts.maxChars ?? 20_000), cut: 0 };

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const url of feedUrls) {
    let key: string;
    try {
      key = normalizeUrl(url);
    } catch {
      key = url;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(url);
  }

  const reads = await runPool(unique, Math.max(1, opts.feedConcurrency ?? 6), (url) =>
    readFeed(url, {
      limit: perFeedLimit,
      since: opts.since,
      timeout: opts.timeout,
      // Bodies are clipped once, after the merge, against one shared budget.
      maxChars: Number.MAX_SAFE_INTEGER,
      perItemChars: Number.MAX_SAFE_INTEGER,
      includeContent: true,
      fullText: false,
    }),
  );

  const statuses: TimelineFeedStatus[] = [];
  let pooled: FeedItem[] = [];
  let undatedSkipped = 0;

  for (const read of reads) {
    statuses.push({
      url: read.url,
      ok: read.ok,
      title: read.feed?.title,
      format: read.feed?.format,
      items: read.items.length,
      reason: read.reason,
    });
    undatedSkipped += read.undatedSkipped;
    pooled = pooled.concat(read.items);
  }

  const sorted = sortItemsNewestFirst(pooled);
  const items = sorted.slice(0, limit).map((item) => ({ ...item }));
  const undatedIncluded = items.filter((i) => !(i.published?.iso ?? i.updated?.iso)).length;

  let fullTextFailures = 0;
  if (opts.fullText && items.length) {
    const targets = items.filter((item) => item.url);
    await runPool(targets, Math.max(1, opts.concurrency ?? 5), async (item) => {
      try {
        const result = await scrape(item.url as string, {
          formats: ['markdown'],
          onlyMainContent: true,
          maxAge: opts.maxAge,
          timeout: opts.timeout,
        });
        if (result.success && result.markdown?.trim()) {
          item.content = result.markdown.trim();
          item.contentSource = 'scraped';
          item.fullText = true;
        } else {
          fullTextFailures++;
          item.fetchError = result.error ?? 'no article text returned';
        }
      } catch (err) {
        fullTextFailures++;
        item.fetchError = String(err);
      }
      return null;
    });
  }

  if (opts.includeContent === false && !opts.fullText) {
    for (const item of items) item.content = undefined;
  } else {
    for (const item of items) clipBody(item, perItem, budget);
  }

  return {
    items,
    feeds: statuses,
    totalItems: pooled.length,
    undatedSkipped,
    undatedIncluded,
    truncated: budget.cut > 0,
    truncatedChars: budget.cut,
    fullTextFailures,
    elapsedMs: Date.now() - started,
  };
}
