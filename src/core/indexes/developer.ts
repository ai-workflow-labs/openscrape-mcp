/**
 * Developer index — code, repositories and issue history.
 *
 * Firecrawl's Developer Index is a curated crawl of public repositories,
 * issues, merged pull requests and READMEs. GitHub already exposes all of that
 * through its REST search API, and grep.app indexes code across hundreds of
 * thousands of repositories for literal and regex matching.
 *
 * Rate limits, honestly stated:
 *
 *  - Unauthenticated GitHub search allows 10 requests/minute per IP, so a
 *    multi-kind search can exhaust it in one call. `GITHUB_TOKEN` in the
 *    environment raises that to 30/minute.
 *  - GitHub code search (`/search/code`) requires authentication outright: it
 *    answers 401 without a token, whatever the rate limit. We say so instead
 *    of returning an empty list.
 *
 * Neither is a paywall we put there, and nothing here needs a key to be
 * useful: repository, issue and pull-request search all work with none.
 */
import { log } from '../util/log.js';
import { runPool } from '../util/pool.js';
import { apiGetJson, CLIENT_NAME, clip, qs, type SourceStatus } from './index.js';

export type DeveloperKind = 'repos' | 'code' | 'issues' | 'prs';

export interface DeveloperHit {
  kind: DeveloperKind;
  title: string;
  url: string;
  /** owner/name, when the hit belongs to a repository. */
  repo?: string;
  description?: string;
  language?: string;
  license?: string;
  stars?: number;
  forks?: number;
  /** Path within the repository, for code hits. */
  path?: string;
  /** Matching lines, for code hits. */
  snippet?: string;
  /** open / closed / merged, for issues and pull requests. */
  state?: string;
  updated?: string;
  comments?: number;
  topics?: string[];
}

export interface DeveloperSearchOptions {
  /** What to search. Default: repos, issues, prs (code needs a token). */
  kinds?: DeveloperKind[];
  limit?: number;
  /** Restrict to a programming language, e.g. "typescript". */
  language?: string;
  /** Restrict to one repository, "owner/name". */
  repo?: string;
  /** SPDX-ish license key, e.g. "mit", "apache-2.0". Repository search only. */
  license?: string;
  /** Include grep.app cross-repo code search. Default true. */
  grepApp?: boolean;
  sort?: 'best' | 'stars' | 'updated';
  timeout?: number;
}

export interface DeveloperSearchResult {
  query: string;
  hits: DeveloperHit[];
  sources: SourceStatus[];
  totals: Record<string, number>;
  /** True when no GITHUB_TOKEN was available. */
  unauthenticated: boolean;
  elapsedMs: number;
}

const DEFAULT_KINDS: DeveloperKind[] = ['repos', 'issues', 'prs'];
const GITHUB_API = 'https://api.github.com';

function githubToken(): string | undefined {
  const token = (process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '').trim();
  return token || undefined;
}

function githubHeaders(): Record<string, string> {
  const token = githubToken();
  return {
    'user-agent': CLIENT_NAME,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

/** Turn a rate-limit or auth failure into a sentence that names the fix. */
function githubNote(status: number, error: string, kind: DeveloperKind): string {
  const authed = Boolean(githubToken());
  if (status === 401 || status === 403) {
    if (/rate limit/i.test(error)) {
      return authed
        ? `${error} — authenticated search allows 30 requests/minute; wait for the window to reset`
        : `${error} — unauthenticated GitHub search allows only 10 requests/minute; set GITHUB_TOKEN for 30/minute`;
    }
    if (kind === 'code') {
      return 'GitHub code search requires authentication — set GITHUB_TOKEN to enable it (repository, issue and PR search work without one)';
    }
    return authed ? error : `${error} — set GITHUB_TOKEN if this is a permissions problem`;
  }
  if (status === 422) return `${error} — GitHub rejected the query syntax`;
  return error;
}

/** Append GitHub search qualifiers for the filters the caller asked for. */
function withQualifiers(query: string, opts: DeveloperSearchOptions, kind: DeveloperKind): string {
  const parts = [query.trim()];
  const has = (q: string) => new RegExp(`\\b${q}:`, 'i').test(query);
  if (opts.language && !has('language')) parts.push(`language:${opts.language}`);
  if (opts.repo && !has('repo')) parts.push(`repo:${opts.repo}`);
  if (opts.license && kind === 'repos' && !has('license')) parts.push(`license:${opts.license}`);
  if (kind === 'issues' && !/\bis:(issue|pr)\b/i.test(query)) parts.push('is:issue');
  if (kind === 'prs' && !/\bis:(issue|pr)\b/i.test(query)) parts.push('is:pr');
  return parts.filter(Boolean).join(' ');
}

interface GhRepo {
  full_name?: string;
  html_url?: string;
  description?: string | null;
  language?: string | null;
  stargazers_count?: number;
  forks_count?: number;
  pushed_at?: string;
  topics?: string[];
  license?: { spdx_id?: string | null; key?: string } | null;
}

interface GhIssue {
  title?: string;
  html_url?: string;
  repository_url?: string;
  number?: number;
  state?: string;
  body?: string | null;
  updated_at?: string;
  comments?: number;
  pull_request?: { merged_at?: string | null };
  draft?: boolean;
}

interface GhCode {
  name?: string;
  path?: string;
  html_url?: string;
  repository?: GhRepo;
  text_matches?: { fragment?: string }[];
}

function repoFromApiUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  return /repos\/([^/]+\/[^/]+)/.exec(url)?.[1];
}

async function searchGithub(
  kind: DeveloperKind,
  query: string,
  opts: DeveloperSearchOptions,
): Promise<{ hits: DeveloperHit[]; total: number; status: SourceStatus }> {
  const path = kind === 'repos' ? 'repositories' : kind === 'code' ? 'code' : 'issues';
  const perPage = Math.min(opts.limit ?? 10, 30);
  const sort =
    kind === 'repos' && opts.sort === 'stars'
      ? 'stars'
      : opts.sort === 'updated'
        ? kind === 'repos'
          ? 'pushed'
          : 'updated'
        : undefined;

  const url = `${GITHUB_API}/search/${path}?${qs({
    q: withQualifiers(query, opts, kind),
    per_page: perPage,
    sort,
    order: sort ? 'desc' : undefined,
  })}`;

  // text_matches gives us the matching lines for code hits.
  const headers = githubHeaders();
  if (kind === 'code') headers.accept = 'application/vnd.github.text-match+json';

  const label = `github/${kind}`;
  const res = await apiGetJson<{ total_count?: number; items?: unknown[] }>(url, {
    headers,
    timeout: opts.timeout,
  });
  if (!res.ok) {
    return {
      hits: [],
      total: 0,
      status: { source: label, ok: false, count: 0, note: githubNote(res.status, res.error, kind) },
    };
  }

  const items = res.data.items ?? [];
  const hits: DeveloperHit[] = [];

  for (const raw of items) {
    if (kind === 'repos') {
      const repo = raw as GhRepo;
      if (!repo.full_name || !repo.html_url) continue;
      hits.push({
        kind,
        title: repo.full_name,
        url: repo.html_url,
        repo: repo.full_name,
        description: clip(repo.description ?? undefined, 220),
        language: repo.language ?? undefined,
        license: repo.license?.spdx_id ?? repo.license?.key ?? undefined,
        stars: repo.stargazers_count,
        forks: repo.forks_count,
        updated: repo.pushed_at?.slice(0, 10),
        topics: repo.topics?.slice(0, 6),
      });
    } else if (kind === 'code') {
      const code = raw as GhCode;
      if (!code.html_url) continue;
      const fragment = code.text_matches
        ?.map((m) => m.fragment?.trim())
        .filter(Boolean)
        .join(' … ');
      hits.push({
        kind,
        title: `${code.repository?.full_name ?? ''}${code.path ? `/${code.path}` : ''}` || (code.name ?? code.html_url),
        url: code.html_url,
        repo: code.repository?.full_name,
        path: code.path,
        language: code.repository?.language ?? undefined,
        license: code.repository?.license?.spdx_id ?? undefined,
        stars: code.repository?.stargazers_count,
        snippet: clip(fragment?.replace(/\s+/g, ' '), 240),
      });
    } else {
      const issue = raw as GhIssue;
      if (!issue.html_url || !issue.title) continue;
      const isPr = Boolean(issue.pull_request);
      if (kind === 'prs' && !isPr) continue;
      if (kind === 'issues' && isPr) continue;
      const state = isPr
        ? issue.pull_request?.merged_at
          ? 'merged'
          : issue.draft
            ? 'draft'
            : (issue.state ?? 'open')
        : (issue.state ?? 'open');
      hits.push({
        kind,
        title: `#${issue.number ?? '?'} ${issue.title}`,
        url: issue.html_url,
        repo: repoFromApiUrl(issue.repository_url),
        description: clip(issue.body?.replace(/\s+/g, ' ') ?? undefined, 200),
        state,
        updated: issue.updated_at?.slice(0, 10),
        comments: issue.comments,
      });
    }
  }

  return { hits, total: res.data.total_count ?? hits.length, status: { source: label, ok: true, count: hits.length } };
}

interface GrepAppResponse {
  facets?: { count?: number };
  hits?: {
    total?: number;
    hits?: {
      repo?: { raw?: string };
      path?: { raw?: string };
      branch?: { raw?: string };
      language?: { raw?: string };
      content?: { snippet?: string };
    }[];
  };
}

/**
 * grep.app: literal and regex code search across public repositories.
 *
 * This one is best-effort. grep.app sits behind a bot checkpoint that, at the
 * time of writing, answers a plain API request from a non-browser client with
 * an interstitial rather than JSON. We identify ourselves honestly and report
 * the refusal rather than dressing a challenge page up as zero results.
 */
async function searchGrepApp(
  query: string,
  opts: DeveloperSearchOptions,
): Promise<{ hits: DeveloperHit[]; total: number; status: SourceStatus }> {
  const url = `https://grep.app/api/search?${qs({
    q: query,
    filter_language: opts.language ? opts.language.replace(/^(\w)/, (c) => c.toUpperCase()) : undefined,
    filter_repository: opts.repo,
  })}`;

  const res = await apiGetJson<GrepAppResponse>(url, { timeout: opts.timeout ?? 15_000 });
  if (!res.ok) {
    const blocked = res.status === 403 || res.status === 429 || /checkpoint|verification|<!doctype/i.test(res.error);
    return {
      hits: [],
      total: 0,
      status: {
        source: 'grep.app',
        ok: false,
        count: 0,
        note: blocked
          ? 'bot checkpoint — grep.app is not answering non-browser clients; use github/code with GITHUB_TOKEN for code search'
          : res.error,
      },
    };
  }

  const raw = res.data.hits?.hits ?? [];
  const hits: DeveloperHit[] = [];
  for (const hit of raw.slice(0, opts.limit ?? 10)) {
    const repo = hit.repo?.raw;
    const path = hit.path?.raw;
    if (!repo || !path) continue;
    hits.push({
      kind: 'code',
      title: `${repo}/${path}`,
      url: `https://github.com/${repo}/blob/${hit.branch?.raw ?? 'HEAD'}/${path}`,
      repo,
      path,
      language: hit.language?.raw,
      snippet: clip(
        hit.content?.snippet
          ?.replace(/<[^>]+>/g, '')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&')
          .replace(/\s+/g, ' ')
          .trim(),
        240,
      ),
    });
  }

  return {
    hits,
    total: res.data.hits?.total ?? res.data.facets?.count ?? hits.length,
    status: { source: 'grep.app', ok: true, count: hits.length },
  };
}

/** Search code, repositories, issues and pull requests across public sources. */
export async function developerSearch(
  query: string,
  opts: DeveloperSearchOptions = {},
): Promise<DeveloperSearchResult> {
  const started = Date.now();
  const kinds = opts.kinds?.length ? [...new Set(opts.kinds)] : DEFAULT_KINDS;
  const limit = Math.max(1, Math.min(opts.limit ?? 10, 30));
  const authed = Boolean(githubToken());

  type Job = { run: () => Promise<{ hits: DeveloperHit[]; total: number; status: SourceStatus }> };
  const jobs: Job[] = kinds.map((kind) => ({ run: () => searchGithub(kind, query, { ...opts, limit }) }));
  if (opts.grepApp !== false && kinds.includes('code')) {
    jobs.push({ run: () => searchGrepApp(query, { ...opts, limit }) });
  }

  // GitHub's unauthenticated search budget is 10/minute, so keep it sequential-ish.
  const runs = await runPool(jobs, authed ? jobs.length : 2, (job) => job.run());

  const totals: Record<string, number> = {};
  const statuses: SourceStatus[] = [];
  for (const run of runs) {
    statuses.push(run.status);
    if (run.status.ok) totals[run.status.source] = run.total;
  }

  // Interleave kinds so one does not crowd out the others, then de-duplicate by URL.
  const seen = new Set<string>();
  const hits: DeveloperHit[] = [];
  const maxLen = Math.max(0, ...runs.map((r) => r.hits.length));
  for (let i = 0; i < maxLen && hits.length < limit; i++) {
    for (const run of runs) {
      const hit = run.hits[i];
      if (!hit || seen.has(hit.url) || hits.length >= limit) continue;
      seen.add(hit.url);
      hits.push(hit);
    }
  }

  log.debug('developer search', { query, kinds, hits: hits.length, authed });

  return { query, hits, sources: statuses, totals, unauthenticated: !authed, elapsedMs: Date.now() - started };
}
