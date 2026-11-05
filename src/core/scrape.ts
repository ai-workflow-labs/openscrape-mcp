import { fetchPage } from './fetcher/index.js';
import { extractFromHtml, type ExtractedPage } from './extract/pipeline.js';
import {
  bodyHash,
  getExtract,
  putExtract,
  EXTRACT_CACHE_MIN_BYTES,
} from './cache/store.js';
import { parseDocument, detectKind } from './parse/documents.js';
import { pruneMarkdown, filterByQuery, withCitations } from './extract/filters.js';
import { spillIfLarge } from './util/spill.js';
import { redactDeep, redactPii, type PiiKind } from './util/redact.js';
import { isHttpUrl } from './util/url.js';
import type { ArchivedContent } from './discover/archive.js';
import { applyLockdown, LockdownError } from './policy/lockdown.js';
import { extractBranding, type BrandingResult } from './extract/branding.js';
import { log } from './util/log.js';
import type { PageMetadata, ScrapeFormat, ScrapeOptions, ScrapeResult } from './types.js';

const DEFAULT_FORMATS: ScrapeFormat[] = ['markdown'];

/** One page in, clean data out. This is the `scrape` primitive everything else builds on. */
export async function scrape(url: string, options: ScrapeOptions = {}): Promise<ScrapeResult> {
  const started = Date.now();

  if (!isHttpUrl(url)) {
    return failure(url, `"${url}" is not an http(s) URL.`, started);
  }

  let opts: ScrapeOptions = {
    ...options,
    formats: options.formats?.length ? options.formats : DEFAULT_FORMATS,
    storeInCache: options.zeroDataRetention ? false : options.storeInCache,
  };

  // Operator policy, applied before anything is requested. A violation fails
  // the call outright rather than quietly returning something narrower, so a
  // caller never mistakes a restricted result for the full one.
  const lockNotices: string[] = [];
  try {
    const applied = applyLockdown(opts);
    opts = applied.options;
    lockNotices.push(...applied.notices);
  } catch (err) {
    if (err instanceof LockdownError) return failure(url, err.message, started);
    throw err;
  }

  const want = new Set(opts.formats as ScrapeFormat[]);

  // A screenshot can only come from a real browser.
  if (want.has('screenshot') && opts.render !== 'http') opts.render = 'browser';
  if (opts.actions?.length) opts.render = 'browser';

  let outcome;
  try {
    outcome = await fetchPage(url, opts);
  } catch (err) {
    return failure(url, describeFetchError(err, url), started);
  }

  const { page, fromCache, escalation } = outcome;
  const warnings: string[] = [...lockNotices];
  if (outcome.warning) warnings.push(outcome.warning);

  // The live page could not be read and the ladder served a public archive copy
  // instead. It goes through the same filters and caps as live content, but it
  // is labelled an old copy at every level: renderedWith, metadata.archive, and
  // a warning that leads with the capture date. Never passed off as live.
  if (outcome.archived) {
    return archivedResult(url, outcome.archived, opts, want, started, warnings, outcome.ladder);
  }

  if (page.blocked) {
    warnings.push(
      `The site answered with a bot wall (${page.blockReason}). Content may be incomplete. Try render:"browser", a logged-in profile, or your own proxy.`,
    );
  }

  const kind = detectKind(page.body, page.contentType, page.finalUrl);
  const isHtml = kind === 'html' || kind === 'unknown' ? looksLikeHtml(page.body) : false;

  const result: ScrapeResult = {
    success: page.status < 400 || page.body.byteLength > 0,
    url: page.finalUrl || url,
    metadata: baseMetadata(url, page, started, fromCache),
  };

  if (!isHtml && kind !== 'html') {
    // PDF, DOCX, CSV, JSON, plain text...
    if (opts.parseDocuments === false) {
      warnings.push(`Content type "${page.contentType}" was not parsed because parseDocuments is false.`);
    } else {
      const doc = await parseDocument(page.body, page.contentType, page.finalUrl);
      if (doc.warning) warnings.push(doc.warning);
      result.metadata.renderedWith = 'document';
      result.metadata.pages = doc.pages;
      result.metadata.title ??= doc.title ?? filenameFromUrl(page.finalUrl);
      if (want.has('markdown') || want.has('query')) result.markdown = doc.markdown;
      if (want.has('text')) result.text = doc.text;
      if (want.has('summary')) {
        // Page markers help when reading the body, but waste tokens in a summary.
        result.summary = doc.text
          .replace(/<!--\s*page \d+\s*-->/g, '')
          .replace(/\n{3,}/g, '\n\n')
          .trim()
          .slice(0, 1200);
      }
      if (want.has('rawHtml') || want.has('html')) {
        warnings.push(`"${kind}" documents have no HTML representation.`);
      }
      if (want.has('json')) result.json = { kind: doc.kind, pages: doc.pages };
    }
  } else {
    const html = page.body.toString('utf8');
    const extracted = extractCached(page.body, html, page.finalUrl || url, opts);

    Object.assign(result.metadata, stripUndefined(extracted.metadataPatch));
    if (!result.metadata.title && extracted.articleTitle) {
      result.metadata.title = extracted.articleTitle;
    }

    // Derived formats are computed from markdown, so build it when any of them is asked for.
    const needsMarkdown = want.has('markdown') || want.has('query');
    if (needsMarkdown) result.markdown = extracted.markdown;
    if (want.has('text')) result.text = extracted.text;
    if (want.has('html')) result.html = extracted.html;
    if (want.has('rawHtml')) result.rawHtml = html;
    if (want.has('links')) result.links = extracted.links;
    if (want.has('images')) result.images = extracted.images;
    if (want.has('summary')) result.summary = extracted.summary;
    if (want.has('json')) {
      result.json = {
        ...extracted.structured.merged,
        jsonLd: extracted.structured.jsonLd,
        microdata: extracted.structured.microdata,
        openGraph: extracted.structured.openGraph,
      };
    }

    if (extracted.seo) result.seo = extracted.seo;

    // Branding needs its own pass over the document, and may want a stylesheet
    // hop, so it is opt-in and runs here rather than inside the extractor.
    if (want.has('branding')) {
      result.branding = await buildBranding(html, page.finalUrl || url, opts);
    }

    if (extracted.markdown.trim().length === 0 && want.has('markdown')) {
      warnings.push(
        'No readable content was extracted. Try onlyMainContent:false, or render:"browser" if the page is JavaScript-driven.',
      );
    }
  }

  // Screenshot / action output travels alongside the fetched page.
  if (page.renderedWith === 'browser') {
    try {
      const { getBrowserExtras } = await import('./fetcher/browser.js');
      const extra = getBrowserExtras(page);
      if (extra?.screenshot) result.screenshot = extra.screenshot;
      if (extra?.actionResults) result.actionResults = extra.actionResults;
    } catch {
      /* browser module unavailable */
    }
  }

  if (outcome.revalidated) result.metadata.revalidated = true;
  if (escalation) result.metadata.escalationReason = escalation.reason;
  if (page.blockReason) result.metadata.blockReason = page.blockReason;
  if (outcome.ladder?.length) result.metadata.ladder = outcome.ladder;
  if (page.redirectChain?.length) result.metadata.redirectChain = page.redirectChain;

  // A bot wall or error page that yielded nothing readable is a failure, not a
  // success with empty markdown. By this point every rung of the ladder has had
  // its turn, including the archive, so there is nothing left to try — and a
  // caller that branches on `success` must not be told this worked.
  const readable = Boolean(
    result.markdown?.trim() ||
      result.text?.trim() ||
      result.summary?.trim() ||
      result.links?.length ||
      result.screenshot,
  );
  if (!readable && (page.status >= 400 || page.blocked)) {
    result.success = false;
    result.error = page.blocked
      ? `The site answered with a bot wall (${page.blockReason}) and no readable content could be recovered, from the live page or from a web archive.`
      : `The site answered HTTP ${page.status} and no readable content could be recovered, from the live page or from a web archive.`;
  }

  applyFilters(result, opts, want);
  if (!want.has('markdown')) delete result.markdown;
  applyRedaction(result, opts);
  applyLimits(result, opts);

  result.metadata.elapsedMs = Date.now() - started;
  if (warnings.length) result.warning = warnings.join(' ');

  log.debug('scrape done', {
    url,
    renderedWith: result.metadata.renderedWith,
    ms: result.metadata.elapsedMs,
    chars: result.markdown?.length ?? 0,
  });

  return result;
}



/**
 * Only the options that change the *conversion* belong in the fingerprint.
 * The query/prune/citation filters run afterwards, on the cached result.
 */
/**
 * Builds the branding result, including the optional stylesheet hop.
 *
 * CSS is fetched through `fetchPage` rather than raw HTTP so the stylesheet
 * requests obey the same cache, the same lockdown and the same politeness as
 * any other fetch — a branding call should not be a hole in the policy.
 */
async function buildBranding(
  html: string,
  baseUrl: string,
  opts: ScrapeOptions,
): Promise<BrandingResult> {
  const cheerio = await import('cheerio');
  const $ = cheerio.load(html);

  const budget = opts.brandingStylesheets ?? 0;
  const fetchCss =
    budget > 0
      ? async (cssUrl: string): Promise<string | null> => {
          try {
            const outcome = await fetchPage(cssUrl, {
              render: 'http',
              maxAge: opts.maxAge,
              timeout: opts.timeout,
              storeInCache: opts.storeInCache,
              zeroDataRetention: opts.zeroDataRetention,
            });
            if (outcome.page.status >= 400) return null;
            return outcome.page.body.toString('utf8');
          } catch (err) {
            log.debug('branding: could not fetch stylesheet', { cssUrl, error: String(err) });
            return null;
          }
        }
      : undefined;

  return extractBranding($, baseUrl, { maxStylesheets: budget }, fetchCss);
}

function extractionFingerprint(opts: ScrapeOptions): string {
  return JSON.stringify([
    opts.onlyMainContent !== false,
    opts.includeTags ?? null,
    opts.excludeTags ?? null,
    // A cached extraction made without SEO signals cannot answer a request
    // that wants them, so it must not be reused for one.
    opts.collectSeo === true,
  ]);
}

function extractCached(
  body: Buffer,
  html: string,
  baseUrl: string,
  opts: ScrapeOptions,
): ExtractedPage {
  // Small pages parse in a millisecond; caching them would only grow the db.
  if (opts.zeroDataRetention || body.byteLength < EXTRACT_CACHE_MIN_BYTES) {
    return extractFromHtml(html, baseUrl, opts);
  }

  const sha = bodyHash(body);
  const fingerprint = extractionFingerprint(opts);

  const hit = getExtract<ExtractedPage>(sha, fingerprint);
  if (hit) {
    log.debug('extract cache hit', { baseUrl, bytes: body.byteLength });
    return hit;
  }

  const fresh = extractFromHtml(html, baseUrl, opts);
  putExtract(sha, fingerprint, fresh);
  return fresh;
}

/**
 * Order matters here: prune the noise, then answer the query against what is
 * left, then compress the links. Each step shrinks what the model has to read.
 */
function applyFilters(
  result: ScrapeResult,
  opts: ScrapeOptions,
  want: Set<ScrapeFormat>,
): void {
  if (typeof result.markdown !== 'string' || !result.markdown) return;

  if (opts.fitMarkdown) {
    const pruned = pruneMarkdown(result.markdown);
    // Never let a filter eat the whole page.
    if (pruned.markdown.length > result.markdown.length * 0.15) {
      result.markdown = pruned.markdown;
      result.metadata.prunedChars = pruned.removedChars;
    }
  }

  if (opts.query) {
    const filtered = filterByQuery(result.markdown, opts.query, opts.queryOptions);
    result.metadata.queryMatch = { matched: filtered.matchedChunks, total: filtered.totalChunks };
    if (want.has('query')) result.query = filtered.ranked;
    // When the caller asked for markdown as well, narrow it to the match too.
    if (want.has('markdown') && filtered.markdown) result.markdown = filtered.markdown;
  }

  if (opts.citations) {
    const cited = withCitations(result.markdown);
    result.markdown = cited.markdown;
    result.references = cited.references;
  }
}

function applyRedaction(result: ScrapeResult, opts: ScrapeOptions): void {
  if (!opts.redactPII) return;
  const kinds = Array.isArray(opts.redactPII) ? (opts.redactPII as PiiKind[]) : undefined;
  let total = 0;

  for (const key of ['markdown', 'text', 'html', 'rawHtml', 'summary', 'query'] as const) {
    const value = result[key];
    if (typeof value !== 'string') continue;
    const report = redactPii(value, kinds);
    result[key] = report.text;
    total += report.total;
  }
  if (result.json) result.json = redactDeep(result.json, kinds);
  if (result.links) result.links = result.links.map((l) => redactPii(l, kinds).text);
  result.metadata.redactedCount = total;
}

function applyLimits(result: ScrapeResult, opts: ScrapeOptions): void {
  const max = opts.maxChars;
  if (!max || max <= 0) return;
  const label = result.metadata.title || result.url;

  for (const key of ['markdown', 'text', 'html', 'rawHtml', 'query'] as const) {
    const value = result[key];
    if (typeof value !== 'string' || value.length <= max) continue;
    if (opts.zeroDataRetention) {
      result[key] = value.slice(0, max).trimEnd() + '\n\n---\n_[truncated]_';
      result.metadata.truncatedChars = value.length - max;
      continue;
    }
    const spilled = spillIfLarge(value, max, `${label}-${key}`);
    result[key] = spilled.text;
    if (spilled.spilledTo) result.metadata.spilledTo = spilled.spilledTo;
    if (spilled.truncatedChars) result.metadata.truncatedChars = spilled.truncatedChars;
  }
}

function baseMetadata(
  url: string,
  page: { finalUrl: string; status: number; contentType: string; renderedWith: PageMetadata['renderedWith'] },
  started: number,
  fromCache: boolean,
): PageMetadata {
  return {
    url: page.finalUrl || url,
    sourceURL: url,
    statusCode: page.status,
    contentType: page.contentType,
    renderedWith: fromCache ? 'cache' : page.renderedWith,
    elapsedMs: Date.now() - started,
    cached: fromCache,
  };
}

/**
 * Turns an archived capture into a normal `ScrapeResult`.
 *
 * The markdown, text and links come from the archive module, which ran them
 * through the very same extraction pipeline a live scrape uses — so the shape
 * of the output is identical and every downstream tool keeps working. What is
 * deliberately NOT identical is the labelling: `renderedWith` is 'archive',
 * `metadata.archive` carries the capture date and snapshot URL, and the first
 * warning states the age in words before anything else. A caller that ignores
 * all three still cannot mistake it for live content, because `statusCode`
 * stays at the live page's status.
 */
function archivedResult(
  url: string,
  archived: ArchivedContent,
  opts: ScrapeOptions,
  want: Set<ScrapeFormat>,
  started: number,
  warnings: string[],
  ladder?: string[],
): ScrapeResult {
  warnings.unshift(archived.staleness.notice);
  if (archived.warning) warnings.push(archived.warning);

  const result: ScrapeResult = {
    success: true,
    url: archived.url,
    metadata: {
      url: archived.url,
      sourceURL: url,
      // A "revisit" record carries no status of its own; the bytes were served.
      statusCode: archived.snapshot.statusCode ?? 200,
      contentType: archived.contentType,
      renderedWith: 'archive',
      elapsedMs: Date.now() - started,
      cached: false,
      title: archived.title,
      pages: archived.pages,
      archive: {
        source: archived.archive,
        capturedOn: archived.staleness.capturedOn,
        ageText: archived.staleness.ageText,
        snapshotUrl: archived.snapshot.contentUrl,
        notice: archived.staleness.notice,
      },
      ...(ladder?.length ? { ladder } : {}),
    },
  };

  if (want.has('markdown') || want.has('query')) result.markdown = archived.markdown;
  if (want.has('text')) result.text = archived.text;
  if (want.has('links')) result.links = archived.links;
  if (want.has('summary')) {
    result.summary = archived.text
      .replace(/<!--\s*page \d+\s*-->/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 1200);
  }
  if (want.has('json')) {
    result.json = {
      archive: archived.archive,
      capturedAt: archived.staleness.capturedAt,
      kind: archived.kind,
      pages: archived.pages,
    };
  }
  if (want.has('html') || want.has('rawHtml')) {
    warnings.push(
      'An archived capture is returned as extracted text, so "html" and "rawHtml" are not available for it.',
    );
  }
  if (want.has('screenshot')) {
    warnings.push('A screenshot cannot be taken of an archived capture.');
  }

  applyFilters(result, opts, want);
  if (!want.has('markdown')) delete result.markdown;
  applyRedaction(result, opts);
  applyLimits(result, opts);

  result.metadata.elapsedMs = Date.now() - started;
  if (warnings.length) result.warning = warnings.join(' ');

  log.debug('scrape served from archive', {
    url,
    captured: archived.staleness.capturedOn,
    chars: result.markdown?.length ?? 0,
  });
  return result;
}

function failure(url: string, message: string, started: number): ScrapeResult {
  return {
    success: false,
    url,
    error: message,
    metadata: {
      url,
      sourceURL: url,
      statusCode: 0,
      renderedWith: 'http',
      elapsedMs: Date.now() - started,
      cached: false,
    },
  };
}

function describeFetchError(err: unknown, url: string): string {
  const msg = String((err as { message?: string })?.message ?? err);
  const host = safeHost(url);
  if (/ENOTFOUND|EAI_AGAIN/.test(msg)) return `DNS lookup failed for ${host}. Check the domain.`;
  if (/ECONNREFUSED/.test(msg)) return `${host} refused the connection.`;
  if (/CERT|SSL|certificate/i.test(msg)) return `TLS certificate problem for ${host}: ${msg}`;
  if (/timeout|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT/i.test(msg)) {
    return `${host} did not respond in time. Raise "timeout" or try render:"browser".`;
  }
  return `Fetch failed for ${url}: ${msg}`;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function looksLikeHtml(body: Buffer): boolean {
  const head = body.subarray(0, 1200).toString('utf8').toLowerCase();
  return /<!doctype html|<html|<head|<body|<div|<meta/.test(head);
}

function filenameFromUrl(url: string): string | undefined {
  try {
    const name = new URL(url).pathname.split('/').filter(Boolean).pop();
    return name ? decodeURIComponent(name) : undefined;
  } catch {
    return undefined;
  }
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}
