/**
 * Web archive access: the Wayback Machine (CDX) and the Common Crawl index.
 *
 * Why this exists. The one thing this project cannot do that Firecrawl can is
 * walk through Cloudflare, DataDome or PerimeterX, because that needs a pool of
 * residential exit IPs we do not have. But a page that refuses us today was
 * very probably archived last week, and reading that copy is legitimate, free
 * and polite. Archives also give something Firecrawl has no answer for at all:
 * the same page as it looked in 2019.
 *
 * Two rules shape everything below.
 *
 * **Staleness is stated, never implied.** Every archived result carries its
 * capture date, its age in plain words, and a notice that says it is an
 * archived copy. An archived page presented as current is worse than no page,
 * because the caller will act on it.
 *
 * **Both services are free, so we are gentle.** One request at a time per host
 * with a gap between them, a single backoff retry on 429/503/504, and an
 * honest `OpenScrape/0.1` user-agent. Nothing here tries to get around a rate
 * limit; when we are throttled we back off once and then report it.
 */
import { httpFetch } from '../fetcher/http.js';
import { extractFromHtml } from '../extract/pipeline.js';
import { parseDocument, detectKind, type DocKind } from '../parse/documents.js';
import { diffContent, hashContent, type ContentDiff } from '../monitor/diff.js';
import { isHttpUrl, normalizeUrl } from '../util/url.js';
import { runPool } from '../util/pool.js';
import { log } from '../util/log.js';

/** How we identify ourselves to both archives. */
export const ARCHIVE_CLIENT = 'OpenScrape/0.1';

const CDX_ENDPOINT = 'http://web.archive.org/cdx/search/cdx';
const AVAILABILITY_ENDPOINT = 'https://archive.org/wayback/available';
const CC_COLLINFO = 'https://index.commoncrawl.org/collinfo.json';

/** Minimum gap between two requests to the same archive host. */
const HOST_GAP_MS = 1_100;
/** How long to wait before the single retry after a 429/503/504. */
const BACKOFF_MS = 2_500;
/** Never return more index records than this, whatever the caller asks for. */
export const CC_HARD_CAP = 5_000;
/** Never open more index pages than this per collection. */
const CC_PAGE_HARD_CAP = 50;
/** Common Crawl answers a wildcard query slowly; give it room. */
const CC_DEFAULT_TIMEOUT = 60_000;

const DAY_MS = 86_400_000;

/* ------------------------------------------------------------------ */
/* Politeness                                                          */
/* ------------------------------------------------------------------ */

const nextFreeAt = new Map<string, number>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reserves the next slot for a host and waits for it. Reserving before waiting
 * means two concurrent callers queue behind each other instead of both
 * deciding the host is free right now.
 */
async function waitForSlot(host: string, gapMs: number): Promise<void> {
  const now = Date.now();
  const free = Math.max(now, nextFreeAt.get(host) ?? 0);
  nextFreeAt.set(host, free + gapMs);
  if (free > now) await sleep(free - now);
}

interface ArchiveResponse {
  ok: boolean;
  status: number;
  body: Buffer;
  contentType: string;
  finalUrl: string;
  error?: string;
  /** Set when we backed off and retried once. */
  retried?: boolean;
}

/** Statuses worth exactly one retry: the service is busy, not refusing us. */
function transient(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

async function archiveGet(
  url: string,
  timeout = 30_000,
  gapMs = HOST_GAP_MS,
): Promise<ArchiveResponse> {
  const host = new URL(url).host;
  let retried = false;

  for (let attempt = 0; attempt < 2; attempt++) {
    await waitForSlot(host, gapMs);
    try {
      const page = await httpFetch(url, {
        timeout,
        headers: { 'user-agent': ARCHIVE_CLIENT, accept: '*/*' },
      });
      if (transient(page.status) && attempt === 0) {
        log.warn('archive throttled, backing off once', { url, status: page.status });
        retried = true;
        await sleep(BACKOFF_MS);
        continue;
      }
      return {
        ok: page.status < 400,
        status: page.status,
        body: page.body,
        contentType: page.contentType,
        finalUrl: page.finalUrl || url,
        retried,
        error: page.status >= 400 ? `HTTP ${page.status}` : undefined,
      };
    } catch (err) {
      if (attempt === 0) {
        retried = true;
        await sleep(BACKOFF_MS);
        continue;
      }
      return {
        ok: false,
        status: 0,
        body: Buffer.alloc(0),
        contentType: '',
        finalUrl: url,
        retried,
        error: String(err),
      };
    }
  }

  return {
    ok: false,
    status: 0,
    body: Buffer.alloc(0),
    contentType: '',
    finalUrl: url,
    retried,
    error: 'request failed twice',
  };
}

function qs(params: Record<string, string | number | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.join('&');
}

/* ------------------------------------------------------------------ */
/* Timestamps and staleness                                            */
/* ------------------------------------------------------------------ */

/** A 14-digit Wayback timestamp, as a Date. Short forms are padded. */
export function parseArchiveTimestamp(timestamp: string): Date | null {
  const digits = timestamp.replace(/\D/g, '');
  if (digits.length < 4) return null;
  const padded = (digits + '00000101000000'.slice(digits.length)).slice(0, 14);
  const date = new Date(
    Date.UTC(
      Number(padded.slice(0, 4)),
      Number(padded.slice(4, 6)) - 1,
      Number(padded.slice(6, 8)),
      Number(padded.slice(8, 10)),
      Number(padded.slice(10, 12)),
      Number(padded.slice(12, 14)),
    ),
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Accepts a Date, an ISO date, or a Wayback timestamp. Returns 14 digits. */
export function toArchiveTimestamp(value: string | Date): string {
  if (value instanceof Date) {
    return value.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  }
  const digits = value.replace(/\D/g, '');
  if (digits.length >= 4) return (digits + '00000101000000'.slice(digits.length)).slice(0, 14);
  return '';
}

export interface Staleness {
  /** ISO form of the capture time. */
  capturedAt: string;
  /** Human form, e.g. "20 Jan 2002". */
  capturedOn: string;
  ageMs: number;
  ageDays: number;
  /** "6 years, 7 months" */
  ageText: string;
  /** One line stating plainly that this is not live content. */
  notice: string;
  /** True once the copy is old enough that facts on it are probably wrong. */
  stale: boolean;
}

function monthName(month: number): string {
  return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][
    month
  ] as string;
}

/** Age in words. Deliberately coarse: "about 3 years" beats "1174 days". */
export function describeAge(ageMs: number): string {
  if (ageMs < 0) return 'dated in the future';
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return minutes <= 1 ? 'under a minute' : `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return hours === 1 ? '1 hour' : `${hours} hours`;
  const days = Math.floor(ageMs / DAY_MS);
  if (days < 61) return `${days} days`;
  const months = Math.floor(days / 30.44);
  if (months < 24) return `${months} months`;
  const years = Math.floor(days / 365.25);
  const leftover = Math.floor((days - years * 365.25) / 30.44);
  return leftover > 0
    ? `${years} year${years === 1 ? '' : 's'}, ${leftover} month${leftover === 1 ? '' : 's'}`
    : `${years} year${years === 1 ? '' : 's'}`;
}

/**
 * The honesty layer. Every archived result carries one of these, and every
 * caller is expected to put `notice` where it cannot be missed.
 */
export function describeStaleness(timestamp: string, now = Date.now()): Staleness {
  const date = parseArchiveTimestamp(timestamp);
  if (!date) {
    return {
      capturedAt: 'unknown',
      capturedOn: 'unknown date',
      ageMs: 0,
      ageDays: 0,
      ageText: 'unknown age',
      notice: 'ARCHIVED COPY of unknown date — this is not live content.',
      stale: true,
    };
  }
  const ageMs = now - date.getTime();
  const ageText = describeAge(ageMs);
  const capturedOn = `${date.getUTCDate()} ${monthName(date.getUTCMonth())} ${date.getUTCFullYear()}`;
  return {
    capturedAt: date.toISOString(),
    capturedOn,
    ageMs,
    ageDays: Math.floor(ageMs / DAY_MS),
    ageText,
    notice: `ARCHIVED COPY captured ${capturedOn} — ${ageText} old, NOT live content.`,
    stale: ageMs > 30 * DAY_MS,
  };
}

/* ------------------------------------------------------------------ */
/* Snapshots                                                           */
/* ------------------------------------------------------------------ */

export type ArchiveName = 'wayback' | 'commoncrawl';

export interface ArchiveSnapshot {
  archive: ArchiveName;
  /** 14-digit capture time, e.g. "20190401234511". */
  timestamp: string;
  capturedAt: string;
  /** The URL as the archive recorded it. */
  url: string;
  mimeType?: string;
  /** Undefined on "revisit" records, which carry no status of their own. */
  statusCode?: number;
  digest?: string;
  length?: number;
  /**
   * Where the original bytes live. The `id_` suffix matters: without it
   * Wayback injects its navigation banner into the HTML, which then shows up
   * as content in the extracted markdown.
   */
  contentUrl: string;
  /** A de-duplicated capture: identical bytes to an earlier one. */
  revisit: boolean;
}

/** Raw-bytes URL for a capture — `id_` means "no Wayback banner". */
export function snapshotContentUrl(timestamp: string, url: string): string {
  return `https://web.archive.org/web/${timestamp}id_/${url}`;
}

export interface SnapshotListOptions {
  /** Snapshots to return. Default 20, hard cap 500. */
  limit?: number;
  /** Earliest capture to consider: YYYY, YYYYMM or YYYYMMDD. */
  from?: string;
  /** Latest capture to consider. */
  to?: string;
  /** Keep only captures that answered 200. Default true. */
  onlyOk?: boolean;
  /** Fold consecutive captures with identical content. Default true. */
  collapseDuplicates?: boolean;
  /** Newest first. Default true. */
  newestFirst?: boolean;
  /** Treat the URL as a prefix and list captures of everything under it. */
  matchPrefix?: boolean;
  timeout?: number;
}

export interface SnapshotList {
  ok: boolean;
  url: string;
  snapshots: ArchiveSnapshot[];
  /** Records the CDX API handed back, before our own filtering. */
  returned: number;
  /** Oldest and newest capture in the returned window. */
  oldest?: ArchiveSnapshot;
  newest?: ArchiveSnapshot;
  /** Plain words when there is nothing to report. */
  note?: string;
  error?: string;
  elapsedMs: number;
}

/** Maps CDX's header row to indexes so column order changes cannot break us. */
function rowsToSnapshots(rows: string[][]): ArchiveSnapshot[] {
  if (rows.length < 2) return [];
  const header = rows[0]!.map((h) => h.toLowerCase());
  const at = (name: string) => header.indexOf(name);
  const iTs = at('timestamp');
  const iUrl = at('original') >= 0 ? at('original') : at('url');
  const iMime = at('mimetype');
  const iStatus = at('statuscode');
  const iDigest = at('digest');
  const iLength = at('length');

  const out: ArchiveSnapshot[] = [];
  for (const row of rows.slice(1)) {
    const timestamp = iTs >= 0 ? row[iTs] : undefined;
    const url = iUrl >= 0 ? row[iUrl] : undefined;
    if (!timestamp || !url) continue;
    const mimeType = iMime >= 0 ? row[iMime] : undefined;
    const rawStatus = iStatus >= 0 ? row[iStatus] : undefined;
    const status = rawStatus && /^\d+$/.test(rawStatus) ? Number(rawStatus) : undefined;
    const rawLength = iLength >= 0 ? row[iLength] : undefined;
    const date = parseArchiveTimestamp(timestamp);
    out.push({
      archive: 'wayback',
      timestamp,
      capturedAt: date ? date.toISOString() : 'unknown',
      url,
      mimeType: mimeType && mimeType !== '-' ? mimeType : undefined,
      statusCode: status,
      digest: iDigest >= 0 ? row[iDigest] : undefined,
      length: rawLength && /^\d+$/.test(rawLength) ? Number(rawLength) : undefined,
      contentUrl: snapshotContentUrl(timestamp, url),
      revisit: mimeType === 'warc/revisit',
    });
  }
  return out;
}

/**
 * Lists what the Wayback Machine holds for a URL.
 *
 * An empty list is a real answer, not a failure: "no snapshots exist" tells the
 * caller to stop asking archives and try something else.
 */
export async function listSnapshots(
  url: string,
  opts: SnapshotListOptions = {},
): Promise<SnapshotList> {
  const started = Date.now();
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 500));
  const newestFirst = opts.newestFirst !== false;
  const onlyOk = opts.onlyOk !== false;

  if (!isHttpUrl(url)) {
    return {
      ok: false,
      url,
      snapshots: [],
      returned: 0,
      error: `"${url}" is not an http(s) URL.`,
      elapsedMs: Date.now() - started,
    };
  }

  // Filtering happens here, so ask for more than we need. A negative limit is
  // how CDX says "the newest N" rather than "the oldest N".
  const fetchCount = Math.min(limit * 3 + 10, 1500);
  const query = qs({
    url,
    output: 'json',
    fl: 'timestamp,original,mimetype,statuscode,digest,length',
    limit: newestFirst ? -fetchCount : fetchCount,
    from: opts.from,
    to: opts.to,
    collapse: opts.collapseDuplicates === false ? undefined : 'digest',
    matchType: opts.matchPrefix ? 'prefix' : undefined,
  });

  const res = await archiveGet(`${CDX_ENDPOINT}?${query}`, opts.timeout ?? 30_000);
  if (!res.ok) {
    return {
      ok: false,
      url,
      snapshots: [],
      returned: 0,
      error: `Wayback CDX API did not answer (${res.error ?? `HTTP ${res.status}`}).`,
      elapsedMs: Date.now() - started,
    };
  }

  let rows: string[][];
  try {
    const parsed = JSON.parse(res.body.toString('utf8')) as unknown;
    rows = Array.isArray(parsed) ? (parsed as string[][]) : [];
  } catch (err) {
    return {
      ok: false,
      url,
      snapshots: [],
      returned: 0,
      error: `Wayback CDX returned unparseable JSON: ${String(err)}`,
      elapsedMs: Date.now() - started,
    };
  }

  const all = rowsToSnapshots(rows);
  let kept = all;
  if (onlyOk) {
    // A revisit record has no status of its own but points at a 200 capture,
    // so dropping them would hide perfectly readable copies.
    kept = all.filter((s) => s.statusCode === 200 || (s.revisit && s.statusCode === undefined));
  }
  kept.sort((a, b) => (newestFirst ? b.timestamp.localeCompare(a.timestamp) : a.timestamp.localeCompare(b.timestamp)));

  const snapshots = kept.slice(0, limit);
  const byTime = [...kept].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const note =
    all.length === 0
      ? 'No snapshots exist for this URL in the Wayback Machine.'
      : snapshots.length === 0
        ? `${all.length} capture(s) exist but none answered 200; retry with onlyOk false to see them.`
        : undefined;

  log.debug('wayback snapshots', { url, returned: all.length, kept: snapshots.length });

  return {
    ok: true,
    url,
    snapshots,
    returned: all.length,
    oldest: byTime[0],
    newest: byTime[byTime.length - 1],
    note,
    elapsedMs: Date.now() - started,
  };
}

export interface AvailabilityResult {
  ok: boolean;
  url: string;
  available: boolean;
  snapshot?: ArchiveSnapshot;
  note?: string;
  error?: string;
  elapsedMs: number;
}

/**
 * The simpler `/wayback/available` endpoint: one request, one answer, no
 * listing. Useful as a cheap "is there anything at all" probe, but it is
 * aggressively rate-limited, so `closestSnapshot` falls back to CDX.
 */
export async function waybackAvailable(
  url: string,
  timestamp?: string | Date,
  timeout = 20_000,
): Promise<AvailabilityResult> {
  const started = Date.now();
  const ts = timestamp ? toArchiveTimestamp(timestamp) : undefined;
  const res = await archiveGet(`${AVAILABILITY_ENDPOINT}?${qs({ url, timestamp: ts })}`, timeout);

  if (!res.ok) {
    return {
      ok: false,
      url,
      available: false,
      error: `availability endpoint did not answer (${res.error ?? `HTTP ${res.status}`})`,
      elapsedMs: Date.now() - started,
    };
  }

  interface AvailBody {
    archived_snapshots?: {
      closest?: { available?: boolean; url?: string; timestamp?: string; status?: string };
    };
  }
  let body: AvailBody;
  try {
    body = JSON.parse(res.body.toString('utf8')) as AvailBody;
  } catch (err) {
    return {
      ok: false,
      url,
      available: false,
      error: `availability endpoint returned unparseable JSON: ${String(err)}`,
      elapsedMs: Date.now() - started,
    };
  }

  const closest = body.archived_snapshots?.closest;
  if (!closest?.available || !closest.timestamp) {
    return {
      ok: true,
      url,
      available: false,
      note: 'No snapshots exist for this URL in the Wayback Machine.',
      elapsedMs: Date.now() - started,
    };
  }

  const date = parseArchiveTimestamp(closest.timestamp);
  return {
    ok: true,
    url,
    available: true,
    snapshot: {
      archive: 'wayback',
      timestamp: closest.timestamp,
      capturedAt: date ? date.toISOString() : 'unknown',
      url,
      statusCode: closest.status && /^\d+$/.test(closest.status) ? Number(closest.status) : undefined,
      contentUrl: snapshotContentUrl(closest.timestamp, url),
      revisit: false,
    },
    elapsedMs: Date.now() - started,
  };
}

export interface ClosestResult {
  ok: boolean;
  snapshot?: ArchiveSnapshot;
  /** Which endpoint actually answered. */
  via: 'availability' | 'cdx' | 'none';
  /** Days between the capture we found and the date asked for. */
  offDays?: number;
  note?: string;
  error?: string;
}

/**
 * Picks the capture nearest a target date (or the newest, with no target).
 *
 * Tries the one-request availability endpoint first and falls back to a CDX
 * listing, because availability is the first thing to rate-limit us.
 */
export async function closestSnapshot(
  url: string,
  target?: string | Date,
  opts: { timeout?: number; onlyOk?: boolean } = {},
): Promise<ClosestResult> {
  const wanted = target ? toArchiveTimestamp(target) : undefined;
  const wantedDate = wanted ? parseArchiveTimestamp(wanted) : null;

  const avail = await waybackAvailable(url, wanted, opts.timeout ?? 20_000);
  if (avail.ok && avail.available && avail.snapshot) {
    const date = parseArchiveTimestamp(avail.snapshot.timestamp);
    return {
      ok: true,
      snapshot: avail.snapshot,
      via: 'availability',
      offDays:
        wantedDate && date
          ? Math.round(Math.abs(date.getTime() - wantedDate.getTime()) / DAY_MS)
          : undefined,
    };
  }
  if (avail.ok && !avail.available) {
    // A definite "nothing here" is worth trusting, but CDX sometimes knows
    // about captures availability does not, so confirm before giving up.
    log.debug('availability says no snapshot, confirming via cdx', { url });
  }

  const list = await listSnapshots(url, {
    limit: 500,
    onlyOk: opts.onlyOk,
    timeout: opts.timeout,
    newestFirst: !wanted,
  });
  if (!list.ok) {
    return { ok: false, via: 'none', error: list.error ?? avail.error };
  }
  if (list.snapshots.length === 0) {
    return { ok: true, via: 'none', note: list.note ?? 'No snapshots exist for this URL.' };
  }

  if (!wantedDate) {
    return { ok: true, snapshot: list.snapshots[0], via: 'cdx' };
  }

  let best = list.snapshots[0]!;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const snap of list.snapshots) {
    const date = parseArchiveTimestamp(snap.timestamp);
    if (!date) continue;
    const gap = Math.abs(date.getTime() - wantedDate.getTime());
    if (gap < bestGap) {
      bestGap = gap;
      best = snap;
    }
  }
  return {
    ok: true,
    snapshot: best,
    via: 'cdx',
    offDays: Number.isFinite(bestGap) ? Math.round(bestGap / DAY_MS) : undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Reading an archived copy                                            */
/* ------------------------------------------------------------------ */

export interface ArchivedContent {
  /** The URL that was asked for. */
  url: string;
  archive: ArchiveName;
  snapshot: ArchiveSnapshot;
  /** Capture date, age in words, and the notice to show the user. */
  staleness: Staleness;
  markdown: string;
  text: string;
  title?: string;
  links: string[];
  kind: DocKind;
  contentType: string;
  bytes: number;
  pages?: number;
  truncatedChars?: number;
  elapsedMs: number;
  warning?: string;
}

export interface FetchArchivedOptions {
  /** Prefer the capture closest to this date. */
  timestamp?: string | Date;
  /** Read exactly this capture, skipping the lookup. */
  snapshotTimestamp?: string;
  /** Strip nav/header/footer, as `scrape` does. Default true. */
  onlyMainContent?: boolean;
  /** Cap the markdown returned. */
  maxChars?: number;
  timeout?: number;
  /** Accept captures that did not answer 200. Default false. */
  includeErrorCaptures?: boolean;
}

export interface ArchivedFetch {
  ok: boolean;
  url: string;
  content?: ArchivedContent;
  /** 'bad-url' | 'no-snapshots' | 'lookup-failed' | 'fetch-failed' | 'empty-capture' */
  reason?: string;
  message?: string;
  elapsedMs: number;
}

/**
 * Reads an archived copy of a URL and returns it as markdown.
 *
 * Archived HTML goes through the same extraction pipeline as a live scrape, so
 * the markdown looks identical to what `scrape` produces — with one deliberate
 * difference: the base URL used for resolving links is the *original* URL, not
 * the archive's, so links in the output point at the real site rather than at
 * web.archive.org. Non-HTML captures (PDF, DOCX, CSV) go through the document
 * parser, so an archived PDF reads as well as a live one.
 */
export async function fetchArchived(
  url: string,
  options: FetchArchivedOptions = {},
): Promise<ArchivedFetch> {
  const started = Date.now();

  if (!isHttpUrl(url)) {
    return {
      ok: false,
      url,
      reason: 'bad-url',
      message: `"${url}" is not an http(s) URL.`,
      elapsedMs: Date.now() - started,
    };
  }

  let snapshot: ArchiveSnapshot;
  if (options.snapshotTimestamp) {
    const ts = toArchiveTimestamp(options.snapshotTimestamp);
    const date = parseArchiveTimestamp(ts);
    snapshot = {
      archive: 'wayback',
      timestamp: ts,
      capturedAt: date ? date.toISOString() : 'unknown',
      url,
      contentUrl: snapshotContentUrl(ts, url),
      revisit: false,
    };
  } else {
    const closest = await closestSnapshot(url, options.timestamp, {
      timeout: options.timeout,
      onlyOk: !options.includeErrorCaptures,
    });
    if (!closest.ok) {
      return {
        ok: false,
        url,
        reason: 'lookup-failed',
        message: closest.error ?? 'The Wayback Machine did not answer.',
        elapsedMs: Date.now() - started,
      };
    }
    if (!closest.snapshot) {
      return {
        ok: false,
        url,
        reason: 'no-snapshots',
        message: closest.note ?? 'No snapshots exist for this URL.',
        elapsedMs: Date.now() - started,
      };
    }
    snapshot = closest.snapshot;
  }

  /**
   * A capture the archive holds is not always a capture it will serve.
   *
   * Wayback returns 403 for individual captures often enough that treating the
   * first refusal as "no archived copy" is wrong: there are usually dozens of
   * other captures of the same page, and the next one down works. An exclusion
   * normally applies to a date range rather than to everything, so walking
   * outward finds a servable copy.
   *
   * Bounded at a few attempts, because a URL excluded outright would otherwise
   * turn one failed lookup into a long sequence of them.
   */
  let res = await archiveGet(snapshot.contentUrl, options.timeout ?? 45_000);
  const refusals: string[] = [];

  if (!res.ok && !options.snapshotTimestamp) {
    refusals.push(`${snapshot.timestamp}: ${res.error ?? `HTTP ${res.status}`}`);

    const list = await listSnapshots(url, {
      timeout: options.timeout,
      onlyOk: !options.includeErrorCaptures,
      limit: 40,
    });

    // Newest first: a recent capture is the most useful when it works, and the
    // one already tried is skipped.
    const alternatives = [...(list.snapshots ?? [])]
      .filter((s) => s.timestamp !== snapshot.timestamp)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, 4);

    for (const candidate of alternatives) {
      log.debug('archive capture refused, trying another', {
        url,
        refused: snapshot.timestamp,
        next: candidate.timestamp,
      });
      const attempt = await archiveGet(candidate.contentUrl, options.timeout ?? 45_000);
      if (attempt.ok) {
        snapshot = candidate;
        res = attempt;
        break;
      }
      refusals.push(`${candidate.timestamp}: ${attempt.error ?? `HTTP ${attempt.status}`}`);
    }
  }

  if (!res.ok) {
    return {
      ok: false,
      url,
      reason: 'fetch-failed',
      message:
        refusals.length > 1
          ? `The archive holds captures of this URL but would not serve any of the ${refusals.length} tried: ${refusals.join('; ')}.`
          : `The archive holds capture ${snapshot.timestamp} but would not serve it (${res.error ?? `HTTP ${res.status}`}).`,
      elapsedMs: Date.now() - started,
    };
  }
  if (res.body.byteLength === 0) {
    return {
      ok: false,
      url,
      reason: 'empty-capture',
      message: `Capture ${snapshot.timestamp} is empty — the archive recorded the URL but stored no bytes.`,
      elapsedMs: Date.now() - started,
    };
  }

  const contentType = res.contentType || snapshot.mimeType || '';
  const kind = detectKind(res.body, contentType, url);
  const warnings: string[] = [];

  let markdown = '';
  let text = '';
  let title: string | undefined;
  let links: string[] = [];
  let pages: number | undefined;

  if (kind === 'html' || kind === 'unknown') {
    // Base the link resolution on the original URL, not the archive URL.
    const extracted = extractFromHtml(res.body.toString('utf8'), url, {
      onlyMainContent: options.onlyMainContent !== false,
    });
    markdown = extracted.markdown;
    text = extracted.text;
    title = extracted.articleTitle ?? extracted.metadataPatch.title;
    links = extracted.links;
  } else {
    const doc = await parseDocument(res.body, contentType, url);
    markdown = doc.markdown;
    text = doc.text;
    title = doc.title;
    pages = doc.pages;
    if (doc.warning) warnings.push(doc.warning);
  }

  let truncatedChars: number | undefined;
  if (options.maxChars && markdown.length > options.maxChars) {
    truncatedChars = markdown.length - options.maxChars;
    markdown = markdown.slice(0, options.maxChars).trimEnd();
  }

  if (!markdown.trim()) {
    warnings.push(
      'The capture yielded no readable text. It may be a redirect stub or a JavaScript-only page, which archives capture poorly.',
    );
  }

  const staleness = describeStaleness(snapshot.timestamp);
  log.debug('archived fetch', {
    url,
    timestamp: snapshot.timestamp,
    bytes: res.body.byteLength,
    kind,
  });

  return {
    ok: true,
    url,
    content: {
      url,
      archive: 'wayback',
      snapshot,
      staleness,
      markdown,
      text,
      title,
      links,
      kind,
      contentType,
      bytes: res.body.byteLength,
      pages,
      truncatedChars,
      elapsedMs: Date.now() - started,
      warning: warnings.length ? warnings.join(' ') : undefined,
    },
    elapsedMs: Date.now() - started,
  };
}

export interface ArchiveFallbackOptions extends FetchArchivedOptions {}

/**
 * The fetch-ladder hook: "the live site refused us — is there an archived copy?"
 *
 * Returns the archived content or `null`, and never throws, so a caller can
 * drop it at the end of a fetch chain without defending against it. The
 * returned object carries its own staleness notice; a caller that forwards the
 * content must forward that too.
 */
export async function tryArchiveFallback(
  url: string,
  opts: ArchiveFallbackOptions = {},
): Promise<ArchivedContent | null> {
  try {
    const result = await fetchArchived(url, opts);
    if (result.ok && result.content && result.content.markdown.trim()) {
      log.info('served from web archive', {
        url,
        captured: result.content.staleness.capturedOn,
        age: result.content.staleness.ageText,
      });
      return result.content;
    }
    log.debug('no archive fallback available', { url, reason: result.reason, message: result.message });
    return null;
  } catch (err) {
    log.debug('archive fallback threw', { url, error: String(err) });
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Historical comparison                                               */
/* ------------------------------------------------------------------ */

export interface ArchiveComparison {
  ok: boolean;
  url: string;
  before?: ArchivedContent;
  after?: ArchivedContent;
  /** Reuses the monitor's differ, so the output matches `monitor` exactly. */
  diff?: ContentDiff;
  beforeHash?: string;
  afterHash?: string;
  /** Days between the two captures. */
  gapDays?: number;
  message?: string;
  elapsedMs: number;
}

/**
 * Fetches two captures of a URL and reports what changed between them.
 *
 * The diffing is `src/core/monitor/diff.ts` unchanged: same normalisation, same
 * plain-English characterisation, same bounded hunks. A page compared across
 * years should read the same way as a page compared across an hour.
 */
export async function compareSnapshots(
  url: string,
  firstDate: string | Date,
  secondDate: string | Date,
  opts: { maxDiffChars?: number; onlyMainContent?: boolean; timeout?: number } = {},
): Promise<ArchiveComparison> {
  const started = Date.now();

  const [a, b] = await runPool(
    [firstDate, secondDate],
    1, // One at a time: two archive requests in parallel is not polite.
    (when) =>
      fetchArchived(url, {
        timestamp: when,
        onlyMainContent: opts.onlyMainContent,
        timeout: opts.timeout,
      }),
  );

  const failures: string[] = [];
  if (!a?.ok) failures.push(`first date: ${a?.message ?? 'lookup failed'}`);
  if (!b?.ok) failures.push(`second date: ${b?.message ?? 'lookup failed'}`);
  if (failures.length) {
    return {
      ok: false,
      url,
      before: a?.content,
      after: b?.content,
      message: failures.join('; '),
      elapsedMs: Date.now() - started,
    };
  }

  // Order by capture time, not by argument order, so "before" really is before.
  const pair = [a!.content!, b!.content!].sort((x, y) =>
    x.snapshot.timestamp.localeCompare(y.snapshot.timestamp),
  );
  const before = pair[0]!;
  const after = pair[1]!;

  if (before.snapshot.timestamp === after.snapshot.timestamp) {
    return {
      ok: true,
      url,
      before,
      after,
      diff: diffContent(before.markdown, after.markdown, opts),
      beforeHash: hashContent(before.markdown),
      afterHash: hashContent(after.markdown),
      gapDays: 0,
      message: `Both dates resolved to the same capture (${before.snapshot.timestamp}); the archive holds nothing in between.`,
      elapsedMs: Date.now() - started,
    };
  }

  const beforeAt = parseArchiveTimestamp(before.snapshot.timestamp);
  const afterAt = parseArchiveTimestamp(after.snapshot.timestamp);

  return {
    ok: true,
    url,
    before,
    after,
    diff: diffContent(before.markdown, after.markdown, opts),
    beforeHash: hashContent(before.markdown),
    afterHash: hashContent(after.markdown),
    gapDays:
      beforeAt && afterAt ? Math.round((afterAt.getTime() - beforeAt.getTime()) / DAY_MS) : undefined,
    elapsedMs: Date.now() - started,
  };
}

/* ------------------------------------------------------------------ */
/* Common Crawl                                                        */
/* ------------------------------------------------------------------ */

export interface CrawlCollection {
  id: string;
  name: string;
  cdxApi: string;
  from?: string;
  to?: string;
}

let collectionCache: { at: number; collections: CrawlCollection[] } | null = null;
/** collinfo.json changes roughly monthly; an hour of memo is plenty. */
const COLLINFO_TTL_MS = 3_600_000;

export interface CollectionsResult {
  ok: boolean;
  collections: CrawlCollection[];
  cached: boolean;
  error?: string;
}

/** The list of Common Crawl monthly indexes, newest first. */
export async function commonCrawlCollections(
  opts: { timeout?: number; maxAge?: number } = {},
): Promise<CollectionsResult> {
  const ttl = opts.maxAge ?? COLLINFO_TTL_MS;
  if (collectionCache && Date.now() - collectionCache.at < ttl) {
    return { ok: true, collections: collectionCache.collections, cached: true };
  }

  const res = await archiveGet(CC_COLLINFO, opts.timeout ?? 30_000);
  if (!res.ok) {
    return {
      ok: false,
      collections: collectionCache?.collections ?? [],
      cached: Boolean(collectionCache),
      error: `collinfo.json did not answer (${res.error ?? `HTTP ${res.status}`})`,
    };
  }

  interface RawCollection {
    id?: string;
    name?: string;
    'cdx-api'?: string;
    from?: string;
    to?: string;
  }
  let raw: RawCollection[];
  try {
    const parsed = JSON.parse(res.body.toString('utf8')) as unknown;
    raw = Array.isArray(parsed) ? (parsed as RawCollection[]) : [];
  } catch (err) {
    return {
      ok: false,
      collections: [],
      cached: false,
      error: `collinfo.json returned unparseable JSON: ${String(err)}`,
    };
  }

  const collections: CrawlCollection[] = [];
  for (const item of raw) {
    if (!item.id || !item['cdx-api']) continue;
    collections.push({
      id: item.id,
      name: item.name ?? item.id,
      cdxApi: item['cdx-api'],
      from: item.from,
      to: item.to,
    });
  }
  collectionCache = { at: Date.now(), collections };
  log.debug('common crawl collections', { count: collections.length });
  return { ok: true, collections, cached: false };
}

export interface CcRecord {
  url: string;
  timestamp: string;
  capturedAt: string;
  status?: number;
  mime?: string;
  digest?: string;
  languages?: string;
  collection: string;
}

/** One Common Crawl index page, parsed. Its index is NDJSON, not a JSON array. */
interface CcPage {
  ok: boolean;
  records: CcRecord[];
  /** The index says the page number is past the end — stop paging. */
  exhausted: boolean;
  error?: string;
}

function parseCcPage(text: string, collection: string): CcPage {
  const records: CcRecord[] = [];
  let exhausted = false;
  let error: string | undefined;

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!trimmed.startsWith('{')) continue;
    let row: Record<string, string>;
    try {
      row = JSON.parse(trimmed) as Record<string, string>;
    } catch {
      continue;
    }
    if (row.message) {
      // "Page N invalid: ..." means we ran past the last page; "No Captures
      // found" means the pattern matched nothing at all.
      if (/invalid/i.test(row.message)) exhausted = true;
      else error = row.message;
      continue;
    }
    const url = row.url;
    const timestamp = row.timestamp;
    if (!url || !timestamp) continue;
    const date = parseArchiveTimestamp(timestamp);
    records.push({
      url,
      timestamp,
      capturedAt: date ? date.toISOString() : 'unknown',
      status: row.status && /^\d+$/.test(row.status) ? Number(row.status) : undefined,
      mime: row['mime-detected'] ?? row.mime,
      digest: row.digest,
      languages: row.languages,
      collection,
    });
  }

  return { ok: !error, records, exhausted, error };
}

async function ccQuery(
  collection: CrawlCollection,
  pattern: string,
  page: number,
  limit: number,
  timeout: number,
): Promise<CcPage> {
  const query = qs({
    url: pattern,
    output: 'json',
    fl: 'url,timestamp,status,mime-detected,digest,languages',
    limit,
    page: page > 0 ? page : undefined,
  });
  const res = await archiveGet(`${collection.cdxApi}?${query}`, timeout);

  if (res.status === 404) {
    // Common Crawl answers a pattern with no matches with a 404 plus a message.
    const parsed = parseCcPage(res.body.toString('utf8'), collection.id);
    return {
      ok: true,
      records: [],
      exhausted: true,
      error: parsed.error ?? 'no captures found for this pattern',
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      records: [],
      exhausted: false,
      error: res.error ?? `HTTP ${res.status}`,
    };
  }
  return parseCcPage(res.body.toString('utf8'), collection.id);
}

export interface CcCollectionStatus {
  id: string;
  ok: boolean;
  /** Index records read from this collection. */
  records: number;
  /** Index pages opened. */
  pages: number;
  note?: string;
}

export interface CcDiscoverResult {
  ok: boolean;
  /** The pattern actually queried, e.g. "example.com/*". */
  pattern: string;
  /** Unique, normalised URLs. */
  urls: string[];
  /** Raw index records read before de-duplication. */
  records: number;
  collections: CcCollectionStatus[];
  /** True when the hard cap stopped us, so more URLs exist. */
  capped: boolean;
  note?: string;
  error?: string;
  elapsedMs: number;
}

export interface CcDiscoverOptions {
  /** Override the default `<host>/*` pattern. */
  pattern?: string;
  /** URLs to return. Default 200, hard cap 5000. */
  limit?: number;
  /** How many collections to query, newest first. Default 1, max 6. */
  collections?: number;
  /** Specific collection ids instead of the newest N. */
  collectionIds?: string[];
  /** Index pages per collection. Default 4, hard cap 50. */
  maxPages?: number;
  /** Keep only 200 responses. Default true. */
  onlyOk?: boolean;
  /** Keep only HTML. Default true. */
  onlyHtml?: boolean;
  timeout?: number;
}

function patternFor(input: string): string {
  // Accept a bare domain, a URL, or an explicit pattern.
  if (input.includes('*')) return input.replace(/^https?:\/\//, '');
  try {
    const u = new URL(input.includes('://') ? input : `https://${input}`);
    const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
    return `${u.host}${path}/*`;
  } catch {
    return `${input.replace(/\/$/, '')}/*`;
  }
}

/**
 * URL discovery at scale from the Common Crawl index.
 *
 * This is the part archives give us that a sitemap cannot: every URL the crawl
 * actually saw, including the ones a site never lists. A wildcard query can
 * match millions of records, so paging is bounded, the record count is capped
 * hard, and whatever we stopped short of is reported rather than hidden.
 */
export async function commonCrawlDiscover(
  domain: string,
  opts: CcDiscoverOptions = {},
): Promise<CcDiscoverResult> {
  const started = Date.now();
  const limit = Math.max(1, Math.min(opts.limit ?? 200, CC_HARD_CAP));
  const maxPages = Math.max(1, Math.min(opts.maxPages ?? 4, CC_PAGE_HARD_CAP));
  const timeout = opts.timeout ?? CC_DEFAULT_TIMEOUT;
  const onlyOk = opts.onlyOk !== false;
  const onlyHtml = opts.onlyHtml !== false;
  const pattern = opts.pattern ?? patternFor(domain);

  const collInfo = await commonCrawlCollections({ timeout: Math.min(timeout, 30_000) });
  if (collInfo.collections.length === 0) {
    return {
      ok: false,
      pattern,
      urls: [],
      records: 0,
      collections: [],
      capped: false,
      error: collInfo.error ?? 'Common Crawl published no collections.',
      elapsedMs: Date.now() - started,
    };
  }

  let chosen: CrawlCollection[];
  if (opts.collectionIds?.length) {
    const wanted = new Set(opts.collectionIds);
    chosen = collInfo.collections.filter((c) => wanted.has(c.id));
    const missing = opts.collectionIds.filter((id) => !chosen.some((c) => c.id === id));
    if (missing.length) log.warn('unknown common crawl collection(s)', { missing });
  } else {
    chosen = collInfo.collections.slice(0, Math.max(1, Math.min(opts.collections ?? 1, 6)));
  }
  if (chosen.length === 0) {
    return {
      ok: false,
      pattern,
      urls: [],
      records: 0,
      collections: [],
      error: `None of the requested collections exist. Newest available: ${collInfo.collections
        .slice(0, 3)
        .map((c) => c.id)
        .join(', ')}.`,
      capped: false,
      elapsedMs: Date.now() - started,
    };
  }

  const seen = new Set<string>();
  const urls: string[] = [];
  const statuses: CcCollectionStatus[] = [];
  let records = 0;
  let capped = false;

  // Sequential on purpose: a wildcard query is expensive for the index, and
  // running several at once is exactly the behaviour that gets a client blocked.
  for (const collection of chosen) {
    const status: CcCollectionStatus = { id: collection.id, ok: true, records: 0, pages: 0 };
    statuses.push(status);

    for (let page = 0; page < maxPages; page++) {
      if (urls.length >= limit) {
        capped = true;
        status.note = status.note ?? 'stopped at the URL cap';
        break;
      }
      const result = await ccQuery(collection, pattern, page, Math.min(limit * 5, CC_HARD_CAP), timeout);
      status.pages++;

      if (!result.ok) {
        status.ok = false;
        status.note = result.error;
        break;
      }
      status.records += result.records.length;
      records += result.records.length;

      for (const record of result.records) {
        if (onlyOk && record.status !== undefined && record.status !== 200) continue;
        if (onlyHtml && record.mime && !record.mime.includes('html')) continue;
        let key: string;
        try {
          key = normalizeUrl(record.url);
        } catch {
          continue;
        }
        if (seen.has(key)) continue;
        seen.add(key);
        urls.push(key);
        if (urls.length >= limit) {
          capped = true;
          break;
        }
      }

      if (result.exhausted) {
        if (result.error && status.records === 0) status.note = result.error;
        break;
      }
      if (result.records.length === 0) break;
      if (page + 1 >= maxPages) status.note = status.note ?? `stopped after ${maxPages} index page(s)`;
    }
  }

  const anyOk = statuses.some((s) => s.ok);
  const note =
    urls.length === 0 && anyOk
      ? `No Common Crawl records match "${pattern}" in ${chosen.map((c) => c.id).join(', ')}. The crawl may not have reached this site, or it is newer than the index.`
      : capped
        ? `Stopped at ${urls.length} URLs — more exist.`
        : undefined;

  log.debug('common crawl discover', {
    pattern,
    urls: urls.length,
    records,
    collections: chosen.map((c) => c.id),
  });

  return {
    ok: anyOk,
    pattern,
    urls,
    records,
    collections: statuses,
    capped,
    note,
    error: anyOk ? undefined : (statuses.find((s) => !s.ok)?.note ?? 'every collection query failed'),
    elapsedMs: Date.now() - started,
  };
}

export interface CcLookupResult {
  ok: boolean;
  url: string;
  captured: boolean;
  records: CcRecord[];
  collections: CcCollectionStatus[];
  note?: string;
  error?: string;
  elapsedMs: number;
}

/** Was this exact page captured by Common Crawl, and when? */
export async function commonCrawlLookup(
  url: string,
  opts: { collections?: number; collectionIds?: string[]; limit?: number; timeout?: number } = {},
): Promise<CcLookupResult> {
  const started = Date.now();
  const limit = Math.max(1, Math.min(opts.limit ?? 10, 200));
  const timeout = opts.timeout ?? CC_DEFAULT_TIMEOUT;

  const collInfo = await commonCrawlCollections({ timeout: Math.min(timeout, 30_000) });
  if (collInfo.collections.length === 0) {
    return {
      ok: false,
      url,
      captured: false,
      records: [],
      collections: [],
      error: collInfo.error ?? 'Common Crawl published no collections.',
      elapsedMs: Date.now() - started,
    };
  }

  let chosen: CrawlCollection[];
  if (opts.collectionIds?.length) {
    const wanted = new Set(opts.collectionIds);
    chosen = collInfo.collections.filter((c) => wanted.has(c.id));
  } else {
    chosen = collInfo.collections.slice(0, Math.max(1, Math.min(opts.collections ?? 2, 6)));
  }

  const records: CcRecord[] = [];
  const statuses: CcCollectionStatus[] = [];
  const target = url.replace(/^https?:\/\//, '');

  for (const collection of chosen) {
    const status: CcCollectionStatus = { id: collection.id, ok: true, records: 0, pages: 1 };
    statuses.push(status);
    const result = await ccQuery(collection, target, 0, limit, timeout);
    if (!result.ok) {
      status.ok = false;
      status.note = result.error;
      continue;
    }
    if (result.records.length === 0 && result.error) status.note = result.error;
    status.records = result.records.length;
    records.push(...result.records.slice(0, limit));
  }

  const anyOk = statuses.some((s) => s.ok);
  return {
    ok: anyOk,
    url,
    captured: records.length > 0,
    records,
    collections: statuses,
    note:
      records.length === 0 && anyOk
        ? `Common Crawl has no record of this URL in ${chosen.map((c) => c.id).join(', ')}.`
        : undefined,
    error: anyOk ? undefined : (statuses.find((s) => !s.ok)?.note ?? 'every collection query failed'),
    elapsedMs: Date.now() - started,
  };
}
