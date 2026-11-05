/**
 * Government and legal index — US federal rulemaking and case law.
 *
 * Three free sources, in descending order of how much they ask of you:
 *
 *  - Federal Register API — no key at all. Rules, proposed rules, notices and
 *    presidential documents from 1994 on, with agency, docket and CFR data.
 *  - govinfo API — needs a free `GOVINFO_API_KEY` from govinfo.gov/api-signup.
 *    Adds the US Code, CFR, bills, statutes, committee reports and the
 *    Congressional Record. Without the key we skip it and say so.
 *  - CourtListener API — needs a free `COURTLISTENER_TOKEN`. Adds federal and
 *    state case law. Without the token it answers 401, which we report.
 *
 * ## The caveat that matters
 *
 * None of this is a statement of current law, and a search result is not a
 * citation. The Federal Register is a dated journal of record: a document is
 * published as it was issued and is never revised in place, so a 2019 final
 * rule stays in the index verbatim even after a 2024 rule amends or revokes
 * it. govinfo likewise serves historical editions of the CFR and superseded
 * versions of bills alongside current ones. Nothing in either API marks a
 * document as "no longer good law".
 *
 * So every result we return carries its date, its issuing agency and its
 * document type, and every response says plainly that currency has to be
 * verified against the current CFR or US Code before the document is relied
 * on. Coverage is United States federal material only.
 */
import { fetch as undiciFetch } from 'undici';
import { log } from '../util/log.js';
import { runPool } from '../util/pool.js';
import { apiGetJson, CLIENT_NAME, cleanText, clip, qs, type SourceStatus } from './index.js';

export type GovSource = 'federalregister' | 'govinfo' | 'courtlistener';

export interface GovDocument {
  source: GovSource;
  title: string;
  url: string;
  /** "Rule", "Proposed Rule", "Notice", "Opinion", a govinfo collection name… */
  type: string;
  /** Publication or decision date, ISO. Always shown: currency depends on it. */
  date?: string;
  /** Issuing agencies or the deciding court. Always shown. */
  agencies: string[];
  /**
   * What we can honestly say about the document's standing — never a claim
   * that it is or is not current law.
   */
  status?: string;
  abstract?: string;
  /** Federal Register document number, govinfo package id, or docket number. */
  identifier?: string;
  docketIds?: string[];
  /** e.g. "90 FR 12345". */
  citation?: string;
  cfrReferences?: string[];
  pdfUrl?: string;
  effectiveOn?: string;
  commentsCloseOn?: string;
}

export interface GovSearchOptions {
  /** Which sources to query. Default: all three; keyless ones are skipped with a note. */
  sources?: GovSource[];
  limit?: number;
  /** ISO dates, inclusive. */
  dateFrom?: string;
  dateTo?: string;
  /** Federal Register document types. */
  docTypes?: ('rule' | 'proposed_rule' | 'notice' | 'presidential_document')[];
  /** Federal Register agency slugs, e.g. "environmental-protection-agency". */
  agencies?: string[];
  /** Newest first (default) or relevance. */
  order?: 'newest' | 'oldest' | 'relevance';
  /** govinfo collection codes, e.g. ["CFR","USCODE","BILLS"]. */
  collections?: string[];
  timeout?: number;
}

export interface GovSearchResult {
  query: string;
  documents: GovDocument[];
  sources: SourceStatus[];
  totals: Record<string, number>;
  /** Shown on every response. US-only coverage; currency must be verified. */
  caveat: string;
  elapsedMs: number;
}

export const GOV_CAVEAT =
  'US federal sources only — no state, local or non-US law. These indexes include historical and ' +
  'superseded material: a document is published as issued and is never revised in place, so a rule ' +
  'here may since have been amended, stayed or revoked, and nothing in the upstream data flags that. ' +
  'Check each result\'s date, agency and type, and verify against the current CFR or US Code (or a ' +
  'lawyer) before relying on it as current law.';

const ALL_SOURCES: GovSource[] = ['federalregister', 'govinfo', 'courtlistener'];

function govinfoKey(): string | undefined {
  return (process.env.GOVINFO_API_KEY ?? '').trim() || undefined;
}

function courtListenerToken(): string | undefined {
  return (process.env.COURTLISTENER_TOKEN ?? process.env.COURTLISTENER_API_TOKEN ?? '').trim() || undefined;
}

// ------------------------------------------------------- Federal Register

const FR_TYPE_CODES: Record<string, string> = {
  rule: 'RULE',
  proposed_rule: 'PRORULE',
  notice: 'NOTICE',
  presidential_document: 'PRESDOCU',
};

const FR_TYPE_LABELS: Record<string, string> = {
  RULE: 'Rule',
  PRORULE: 'Proposed Rule',
  NOTICE: 'Notice',
  PRESDOCU: 'Presidential Document',
};

interface FrDocument {
  title?: string;
  type?: string;
  abstract?: string | null;
  action?: string | null;
  document_number?: string;
  html_url?: string;
  pdf_url?: string;
  publication_date?: string;
  effective_on?: string | null;
  comments_close_on?: string | null;
  significant?: boolean | null;
  citation?: string | null;
  docket_ids?: string[];
  agencies?: { name?: string; raw_name?: string }[];
  cfr_references?: { title?: number; part?: number | string }[];
}

/**
 * What we can say about a Federal Register document's standing from the data
 * the API actually gives us — and nothing beyond it.
 */
function frStatus(doc: FrDocument): string {
  const kind = doc.type ?? 'Document';
  const bits: string[] = [];
  const today = new Date().toISOString().slice(0, 10);

  if (kind === 'Proposed Rule') {
    bits.push(
      doc.comments_close_on
        ? doc.comments_close_on >= today
          ? `proposal, comments open until ${doc.comments_close_on}`
          : `proposal, comment period closed ${doc.comments_close_on}`
        : 'proposal — not binding unless finalised',
    );
  } else if (kind === 'Rule') {
    bits.push(
      doc.effective_on
        ? doc.effective_on > today
          ? `final rule, effective ${doc.effective_on} (not yet in force)`
          : `final rule, effective ${doc.effective_on}`
        : 'final rule, no effective date given',
    );
  } else {
    bits.push(`${kind.toLowerCase()} as published`);
  }
  if (doc.significant) bits.push('significant regulatory action');
  bits.push('may have been amended or revoked since — verify');
  return bits.join('; ');
}

async function searchFederalRegister(
  query: string,
  opts: GovSearchOptions,
): Promise<{ documents: GovDocument[]; total: number; status: SourceStatus }> {
  const fields = [
    'title',
    'type',
    'abstract',
    'action',
    'document_number',
    'html_url',
    'pdf_url',
    'publication_date',
    'effective_on',
    'comments_close_on',
    'significant',
    'citation',
    'docket_ids',
    'agencies',
    'cfr_references',
  ];

  const params = new URLSearchParams();
  params.set('conditions[term]', query);
  params.set('per_page', String(Math.min(opts.limit ?? 10, 50)));
  params.set('order', opts.order === 'relevance' ? 'relevance' : opts.order === 'oldest' ? 'oldest' : 'newest');
  if (opts.dateFrom) params.set('conditions[publication_date][gte]', opts.dateFrom);
  if (opts.dateTo) params.set('conditions[publication_date][lte]', opts.dateTo);
  for (const field of fields) params.append('fields[]', field);
  for (const type of opts.docTypes ?? []) {
    const code = FR_TYPE_CODES[type];
    if (code) params.append('conditions[type][]', code);
  }
  for (const agency of opts.agencies ?? []) params.append('conditions[agencies][]', agency);

  const url = `https://www.federalregister.gov/api/v1/documents.json?${params.toString()}`;
  const res = await apiGetJson<{ count?: number; results?: FrDocument[] }>(url, { timeout: opts.timeout });
  if (!res.ok) {
    return {
      documents: [],
      total: 0,
      status: { source: 'federalregister', ok: false, count: 0, note: res.error },
    };
  }

  const documents: GovDocument[] = [];
  for (const doc of res.data.results ?? []) {
    const title = cleanText(doc.title);
    if (!title || !doc.html_url) continue;
    documents.push({
      source: 'federalregister',
      title,
      url: doc.html_url,
      type: FR_TYPE_LABELS[doc.type ?? ''] ?? doc.type ?? 'Document',
      date: doc.publication_date,
      agencies: (doc.agencies ?? []).map((a) => a.name ?? a.raw_name ?? '').filter(Boolean),
      status: frStatus(doc),
      abstract: clip(cleanText(doc.abstract ?? doc.action ?? undefined), 320),
      identifier: doc.document_number,
      docketIds: doc.docket_ids?.length ? doc.docket_ids : undefined,
      citation: doc.citation ?? undefined,
      cfrReferences: doc.cfr_references?.length
        ? doc.cfr_references.map((r) => `${r.title ?? '?'} CFR ${r.part ?? ''}`.trim())
        : undefined,
      pdfUrl: doc.pdf_url,
      effectiveOn: doc.effective_on ?? undefined,
      commentsCloseOn: doc.comments_close_on ?? undefined,
    });
  }

  return {
    documents,
    total: res.data.count ?? documents.length,
    status: { source: 'federalregister', ok: true, count: documents.length },
  };
}

// --------------------------------------------------------------- govinfo

interface GovinfoResult {
  title?: string;
  packageId?: string;
  granuleId?: string;
  collectionCode?: string;
  collectionName?: string;
  dateIssued?: string;
  lastModified?: string;
  resultLink?: string;
  governmentAuthor?: string[];
  download?: { pdfLink?: string; txtLink?: string };
}

/**
 * govinfo's search is POST-only, so this is the one call that does not go
 * through `httpFetch`. Everything else about it is the same: generic client
 * name, no email, JSON in and out.
 */
async function govinfoPost<T>(
  path: string,
  body: unknown,
  key: string,
  timeout: number,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await undiciFetch(`https://api.govinfo.gov${path}?${qs({ api_key: key })}`, {
      method: 'POST',
      headers: { 'user-agent': CLIENT_NAME, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string };
        message = `HTTP ${res.status}: ${parsed.error?.message ?? parsed.message ?? text.slice(0, 120)}`;
      } catch {
        message = `HTTP ${res.status}: ${text.replace(/\s+/g, ' ').slice(0, 120)}`;
      }
      return { ok: false, error: message };
    }
    return { ok: true, data: JSON.parse(text) as T };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function searchGovinfo(
  query: string,
  opts: GovSearchOptions,
): Promise<{ documents: GovDocument[]; total: number; status: SourceStatus }> {
  const key = govinfoKey();
  if (!key) {
    return {
      documents: [],
      total: 0,
      status: {
        source: 'govinfo',
        ok: false,
        count: 0,
        note: 'not queried: needs a free GOVINFO_API_KEY (govinfo.gov/api-signup). Federal Register coverage needs no key and ran.',
      },
    };
  }

  // govinfo's query language takes the same field qualifiers as its web UI.
  const clauses = [query];
  if (opts.collections?.length) clauses.push(`collection:(${opts.collections.join(' OR ')})`);
  if (opts.dateFrom || opts.dateTo) {
    clauses.push(`publishdate:range(${opts.dateFrom ?? '1990-01-01'},${opts.dateTo ?? new Date().toISOString().slice(0, 10)})`);
  }

  const res = await govinfoPost<{ count?: number; results?: GovinfoResult[] }>(
    '/search',
    {
      query: clauses.join(' AND '),
      pageSize: Math.min(opts.limit ?? 10, 50),
      offsetMark: '*',
      sorts: [
        {
          field: opts.order === 'relevance' ? 'score' : 'publishdate',
          sortOrder: opts.order === 'oldest' ? 'ASC' : 'DESC',
        },
      ],
    },
    key,
    opts.timeout ?? 25_000,
  );

  if (!res.ok) {
    return { documents: [], total: 0, status: { source: 'govinfo', ok: false, count: 0, note: res.error } };
  }

  const documents: GovDocument[] = [];
  for (const item of res.data.results ?? []) {
    const title = cleanText(item.title);
    const url = item.resultLink ?? (item.packageId ? `https://www.govinfo.gov/app/details/${item.packageId}` : undefined);
    if (!title || !url) continue;
    documents.push({
      source: 'govinfo',
      title,
      url,
      type: item.collectionName ?? item.collectionCode ?? 'govinfo document',
      date: item.dateIssued?.slice(0, 10),
      agencies: item.governmentAuthor ?? [],
      status:
        'as issued — govinfo serves historical editions alongside current ones; confirm this is the edition in force',
      identifier: item.granuleId ?? item.packageId,
      pdfUrl: item.download?.pdfLink,
    });
  }

  return {
    documents,
    total: res.data.count ?? documents.length,
    status: { source: 'govinfo', ok: true, count: documents.length },
  };
}

// --------------------------------------------------------- CourtListener

interface ClResult {
  caseName?: string;
  absolute_url?: string;
  court?: string;
  court_id?: string;
  dateFiled?: string;
  docketNumber?: string;
  citation?: string[];
  status?: string;
  snippet?: string;
  opinions?: { snippet?: string; download_url?: string }[];
}

async function searchCourtListener(
  query: string,
  opts: GovSearchOptions,
): Promise<{ documents: GovDocument[]; total: number; status: SourceStatus }> {
  const token = courtListenerToken();
  const url = `https://www.courtlistener.com/api/rest/v4/search/?${qs({
    q: query,
    type: 'o',
    order_by: opts.order === 'relevance' ? 'score desc' : 'dateFiled desc',
    filed_after: opts.dateFrom,
    filed_before: opts.dateTo,
  })}`;

  const res = await apiGetJson<{ count?: number | string; results?: ClResult[] }>(url, {
    timeout: opts.timeout,
    headers: token ? { authorization: `Token ${token}` } : {},
  });

  if (!res.ok) {
    const needsToken = res.status === 401 || res.status === 403;
    return {
      documents: [],
      total: 0,
      status: {
        source: 'courtlistener',
        ok: false,
        count: 0,
        note: needsToken
          ? 'case law needs a free COURTLISTENER_TOKEN (courtlistener.com/help/api/rest — sign up, then "Set up an API token")'
          : res.error,
      },
    };
  }

  const documents: GovDocument[] = [];
  for (const item of res.data.results ?? []) {
    const title = cleanText(item.caseName);
    if (!title) continue;
    const href = item.absolute_url ? `https://www.courtlistener.com${item.absolute_url}` : undefined;
    if (!href) continue;
    documents.push({
      source: 'courtlistener',
      title,
      url: href,
      type: 'Opinion',
      date: item.dateFiled,
      agencies: [item.court ?? item.court_id ?? 'court'].filter(Boolean),
      status: `${item.status ?? 'opinion'} as decided — may have been appealed, reversed or superseded; check later history`,
      abstract: clip(cleanText(item.snippet ?? item.opinions?.[0]?.snippet), 320),
      identifier: item.docketNumber,
      citation: item.citation?.[0],
    });
  }

  return {
    documents,
    total: Number(res.data.count) || documents.length,
    status: { source: 'courtlistener', ok: true, count: documents.length },
  };
}

/** Search US federal rulemaking, legislative material and case law. */
export async function govSearch(query: string, opts: GovSearchOptions = {}): Promise<GovSearchResult> {
  const started = Date.now();
  const sources = opts.sources?.length ? [...new Set(opts.sources)] : ALL_SOURCES;
  const limit = Math.max(1, Math.min(opts.limit ?? 10, 50));

  const runs = await runPool(sources, sources.length, async (source) => {
    switch (source) {
      case 'federalregister':
        return searchFederalRegister(query, { ...opts, limit });
      case 'govinfo':
        return searchGovinfo(query, { ...opts, limit });
      case 'courtlistener':
        return searchCourtListener(query, { ...opts, limit });
      default:
        return {
          documents: [] as GovDocument[],
          total: 0,
          status: { source: String(source), ok: false, count: 0, note: 'unknown source' },
        };
    }
  });

  const totals: Record<string, number> = {};
  const statuses: SourceStatus[] = [];
  for (const run of runs) {
    statuses.push(run.status);
    if (run.status.ok) totals[run.status.source] = run.total;
  }

  const seen = new Set<string>();
  const documents: GovDocument[] = [];
  const maxLen = Math.max(0, ...runs.map((r) => r.documents.length));
  for (let i = 0; i < maxLen && documents.length < limit; i++) {
    for (const run of runs) {
      const doc = run.documents[i];
      if (!doc || seen.has(doc.url) || documents.length >= limit) continue;
      seen.add(doc.url);
      documents.push(doc);
    }
  }

  log.debug('gov search', { query, sources, documents: documents.length });

  return { query, documents, sources: statuses, totals, caveat: GOV_CAVEAT, elapsedMs: Date.now() - started };
}
