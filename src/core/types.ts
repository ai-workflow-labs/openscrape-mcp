/** All output formats we can produce for a page. Mirrors Firecrawl's `formats`. */
import type { PiiKind } from './util/redact.js';
import type { SeoSignals } from './seo/signals.js';
import type { BrandingResult } from './extract/branding.js';

export type ScrapeFormat =
  | 'markdown'
  | 'html'
  | 'rawHtml'
  | 'links'
  | 'images'
  | 'summary'
  | 'json'
  | 'screenshot'
  | 'text'
  | 'query'
  | 'branding';

export type RenderMode = 'auto' | 'http' | 'browser';

export interface ScrapeOptions {
  formats?: ScrapeFormat[];
  /** Strip nav/footer/ads via Readability. Default true. */
  onlyMainContent?: boolean;
  /** CSS selectors to keep (everything else dropped). */
  includeTags?: string[];
  /** CSS selectors to remove. */
  excludeTags?: string[];
  /** Serve from cache when the entry is younger than this (ms). 0 = always fresh. */
  maxAge?: number;
  /** Write the result to cache. Default true. */
  storeInCache?: boolean;
  /** How to fetch: auto escalates HTTP -> browser when the page looks JS-driven. */
  render?: RenderMode;
  /** Per-request timeout in ms. */
  timeout?: number;
  /** Extra request headers. */
  headers?: Record<string, string>;
  /** Emulate a phone. */
  mobile?: boolean;
  /** Browser-only: wait this long after load (ms). */
  waitFor?: number;
  /** Hard cap on characters returned per text format. Overflow spills to disk. */
  maxChars?: number;
  /** Follow <meta refresh> / JS redirects where cheap. */
  followRedirects?: boolean;
  /** Proxy URL (http://user:pass@host:port). */
  proxy?: string;
  /** Accept invalid TLS certificates. Off by default: turning it on lets a
   *  network attacker substitute page content without detection. */
  skipTlsVerification?: boolean;
  /** Use ETag / If-Modified-Since so an unchanged page costs a 304 instead of
   *  a full download. Default true. */
  revalidate?: boolean;
  /** Parse PDFs/DOCX instead of returning bytes. Default true. */
  parseDocuments?: boolean;
  /** For the `branding` format: fetch up to this many same-origin stylesheets
   *  so colours and fonts come from the real CSS, not just the HTML. Default 0,
   *  because it costs requests the caller did not explicitly ask for. */
  brandingStylesheets?: number;
  /** Collect per-page SEO signals (canonical, h1, hreflang, outlinks with anchor
   *  text, image alt coverage, duplicate fingerprint). Read off the parse the
   *  extractor already does, so it is nearly free. */
  collectSeo?: boolean;
  /** Fetch through one of your own logged-in browser profiles (see `profile_login`).
   *  Used as a ladder rung: a page that needs a session you already hold. */
  profile?: string;
  /** When the live page cannot be read (bot wall, 4xx/5xx, empty body), fall back
   *  to a public web-archive copy. Default true. The result is always labelled
   *  `renderedWith: 'archive'` and carries its capture date, never passed off as
   *  live. Set false to make an unreadable page simply fail. */
  archiveFallback?: boolean;
  /** Mask emails, phones, cards, national IDs. true = every detector. */
  redactPII?: boolean | PiiKind[];
  /** Keep nothing on disk: no cache write, no spill file. */
  zeroDataRetention?: boolean;
  /** Browser-only: wait until this selector appears. */
  waitForSelector?: string;
  /** Browser-only screenshot settings. */
  screenshot?: ScreenshotOptions;
  /** Browser-only: page interactions to run before capture. */
  actions?: PageAction[];
  /** Prune navigation residue and boilerplate from the markdown ("fit markdown"). */
  fitMarkdown?: boolean;
  /** Replace inline links with numbered citations plus a reference list. */
  citations?: boolean;
  /** Keep only the parts of the page that match this query (BM25, no LLM). */
  query?: string;
  /** Tuning for `query`. */
  queryOptions?: { topK?: number; targetChars?: number; minScoreRatio?: number };
}

export interface ScreenshotOptions {
  fullPage?: boolean;
  /** JPEG quality 1-100. Omit for PNG. */
  quality?: number;
  viewport?: { width: number; height: number };
}

/** Mirrors Firecrawl's `actions`: click, type, scroll, wait, press, screenshot, scrape. */
export type PageAction =
  | { type: 'wait'; milliseconds?: number; selector?: string }
  | { type: 'click'; selector: string; all?: boolean }
  | { type: 'write'; selector?: string; text: string }
  | { type: 'press'; key: string }
  | { type: 'scroll'; direction?: 'up' | 'down'; amount?: number; selector?: string }
  | { type: 'scrape' }
  | { type: 'screenshot'; fullPage?: boolean }
  | { type: 'executeJavascript'; script: string }
  | { type: 'navigate'; url: string };

export interface PageMetadata {
  url: string;
  sourceURL: string;
  title?: string;
  description?: string;
  language?: string;
  canonical?: string;
  author?: string;
  publishedTime?: string;
  modifiedTime?: string;
  siteName?: string;
  favicon?: string;
  ogImage?: string;
  keywords?: string[];
  contentType?: string;
  statusCode: number;
  /** How the page was actually fetched. */
  renderedWith: 'http' | 'browser' | 'document' | 'cache' | 'archive';
  /** Set only when `renderedWith` is 'archive': which archive, when it was
   *  captured, and how old that copy is. Never present for live content. */
  archive?: {
    source: string;
    capturedOn: string;
    ageText: string;
    snapshotUrl: string;
    notice: string;
  };
  /** The rungs of the fetch ladder that were tried, in order, with why each
   *  one was not the answer. Present only when more than one was needed. */
  ladder?: string[];
  /** Redirect hops followed to reach this page. Two or more is an SEO defect. */
  redirectChain?: RedirectHop[];
  /** Wall-clock fetch+extract time in ms. */
  elapsedMs: number;
  /** True when this result came from the local cache. */
  cached: boolean;
  /** True when the server answered 304 and the stored body was reused. */
  revalidated?: boolean;
  /** Set when a text format was truncated; full text lives at this path. */
  spilledTo?: string;
  /** Characters removed by truncation. */
  truncatedChars?: number;
  /** Count of PII matches masked, when redaction ran. */
  redactedCount?: number;
  /** Why the fetcher escalated to a real browser, when it did. */
  escalationReason?: string;
  /** Set when a bot wall was detected. */
  blockReason?: string;
  /** Number of pages, for parsed documents. */
  pages?: number;
  /** Characters removed by the fit-markdown pruner. */
  prunedChars?: number;
  /** How many query chunks matched, out of how many. */
  queryMatch?: { matched: number; total: number };
}

export interface ScrapeResult {
  success: boolean;
  url: string;
  markdown?: string;
  text?: string;
  html?: string;
  rawHtml?: string;
  links?: string[];
  images?: string[];
  summary?: string;
  json?: Record<string, unknown>;
  /** Query-relevant excerpt, when the `query` format was requested. */
  query?: string;
  /** Reference list, when `citations` was enabled. */
  references?: string[];
  screenshot?: string;
  /** Per-action results when `actions` ran (screenshots, scraped snapshots). */
  actionResults?: unknown[];
  /** Raw SEO signals, only when `collectSeo` was requested. */
  seo?: SeoSignals;
  /** Logo, colours and fonts, when the `branding` format was requested. */
  branding?: BrandingResult;
  metadata: PageMetadata;
  warning?: string;
  error?: string;
}

export interface RedirectHop {
  from: string;
  to: string;
  /** 301, 302, 303, 307 or 308. */
  status: number;
}

export interface FetchedPage {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  body: Buffer;
  renderedWith: 'http' | 'browser' | 'document';
  /** Set when the fetcher detected a bot-wall it could not pass. */
  blocked?: boolean;
  blockReason?: string;
  /** Every redirect hop that was followed to reach `finalUrl`, in order.
   *  Empty or absent when the first request answered directly. A chain of two
   *  or more hops is a real SEO defect, which is why it is recorded. */
  redirectChain?: RedirectHop[];
  /** HTTP validators, used to revalidate cheaply on the next fetch. */
  etag?: string;
  lastModified?: string;
  /** True when the server answered 304 and we served the stored body. */
  revalidated?: boolean;
}
