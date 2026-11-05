/**
 * Research index — academic literature from free public APIs.
 *
 * Firecrawl's Research Index is a paid lookup over paper metadata. Every
 * institution that owns that metadata already gives it away:
 *
 *  - arXiv       Atom API over physics/maths/CS preprints, full text as PDF.
 *  - PubMed      NCBI E-utilities over 37M biomedical citations.
 *  - bioRxiv     preprint servers' own JSON API (no server-side keyword
 *    /medRxiv    search, so we scan a recency window and filter locally).
 *  - Crossref    the DOI registry: 150M+ works, publisher-deposited metadata.
 *  - OpenAlex    an open index of works with citation counts and OA links.
 *
 * None of them needs a key. We query several in parallel, merge on DOI (then
 * title), and backfill citation counts from OpenAlex, which is the only one of
 * the five that publishes them for everything.
 */
import { XMLParser } from 'fast-xml-parser';
import { scrape } from '../scrape.js';
import { log } from '../util/log.js';
import { runPool } from '../util/pool.js';
import {
  apiGetJson,
  apiGetJsonRetrying,
  apiGetText,
  cleanText,
  clip,
  matchesAllTerms,
  NCBI_TOOL,
  normalizeDoi,
  qs,
  queryTerms,
  titleKey,
  type SourceStatus,
} from './index.js';

export type PaperSource = 'arxiv' | 'pubmed' | 'biorxiv' | 'medrxiv' | 'crossref' | 'openalex';

export interface Paper {
  /** Stable handle usable with `read_paper`: an arXiv id, a DOI, or `pmid:N`. */
  id: string;
  /** Which API this record came from. Merged records list every contributor. */
  sources: PaperSource[];
  title: string;
  authors: string[];
  /** Journal, conference or preprint server. */
  venue?: string;
  year?: number;
  /** ISO date when the source gives one more precise than the year. */
  date?: string;
  doi?: string;
  abstract?: string;
  /** Times cited, per OpenAlex. Absent means unknown, not zero. */
  citations?: number;
  /** Landing page for the work. */
  url: string;
  /** Direct full-text PDF when one is openly reachable. */
  pdfUrl?: string;
  /** e.g. "journal-article", "preprint", "Review". */
  type?: string;
  /** Preprint version, where the server tracks one. */
  version?: string;
  openAccess?: boolean;
}

export interface PaperSearchOptions {
  /** Which APIs to query. Default: arxiv, pubmed, openalex. */
  sources?: PaperSource[];
  /** Papers to return after merging. Default 10. */
  limit?: number;
  yearFrom?: number;
  yearTo?: number;
  /** Default "relevance". */
  sortBy?: 'relevance' | 'date' | 'citations';
  /** Fetch abstracts (an extra call for PubMed). Default true. */
  includeAbstracts?: boolean;
  /** Look up citation counts in OpenAlex for everything with a DOI. Default true. */
  enrichCitations?: boolean;
  /** bioRxiv/medRxiv only: how many days back to scan. Default 30. */
  preprintWindowDays?: number;
  timeout?: number;
}

export interface PaperSearchResult {
  query: string;
  papers: Paper[];
  sources: SourceStatus[];
  /** Total hits upstream reported, per source, before our limit. */
  totals: Record<string, number>;
  elapsedMs: number;
}

export interface PaperReadResult {
  paper?: Paper;
  /** Full text, when a PDF or HTML full text was openly reachable. */
  fullText?: string;
  fullTextSource?: string;
  fullTextPages?: number;
  notes: string[];
  elapsedMs: number;
}

const DEFAULT_SOURCES: PaperSource[] = ['arxiv', 'pubmed', 'openalex'];

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
});

/** fast-xml-parser hands back a string, an object with #text, or an array. */
function xmlText(node: unknown): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (Array.isArray(node)) return node.map(xmlText).join(' ');
  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (typeof obj['#text'] === 'string') return obj['#text'];
    // A mixed-content element (e.g. an abstract with inline <i>): join children.
    return Object.entries(obj)
      .filter(([key]) => !key.startsWith('@_'))
      .map(([, value]) => xmlText(value))
      .join(' ');
  }
  return '';
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function ncbiKey(): string | undefined {
  const key = process.env.NCBI_API_KEY?.trim();
  return key || undefined;
}

function openAlexKey(): string | undefined {
  const key = process.env.OPENALEX_API_KEY?.trim();
  return key || undefined;
}

// ---------------------------------------------------------------- arXiv

/**
 * arXiv wants a fielded boolean expression, not a bag of words. We AND the
 * query's terms across all fields, which behaves like a normal search box, and
 * pass a fielded query (`ti:`, `au:`, `cat:`…) straight through.
 */
function arxivSearchQuery(query: string, opts: PaperSearchOptions): string {
  const fielded = /\b(ti|au|abs|co|jr|cat|rn|id|all):/i.test(query);
  let expr = fielded
    ? query
    : queryTerms(query)
        .map((t) => (t.includes(' ') ? `all:"${t}"` : `all:${t}`))
        .join(' AND ');
  if (!expr) expr = `all:${query}`;

  if (opts.yearFrom || opts.yearTo) {
    const from = `${opts.yearFrom ?? 1991}01010000`;
    const to = `${opts.yearTo ?? new Date().getFullYear()}12312359`;
    expr = `(${expr}) AND submittedDate:[${from} TO ${to}]`;
  }
  return expr;
}

async function searchArxiv(
  query: string,
  opts: PaperSearchOptions,
): Promise<{ papers: Paper[]; total: number; status: SourceStatus }> {
  const url =
    'http://export.arxiv.org/api/query?' +
    qs({
      search_query: arxivSearchQuery(query, opts),
      start: 0,
      max_results: Math.min((opts.limit ?? 10) * 2, 50),
      sortBy: opts.sortBy === 'date' ? 'submittedDate' : 'relevance',
      sortOrder: 'descending',
    });

  const res = await apiGetText(url, { accept: 'application/atom+xml', timeout: opts.timeout });
  if (!res.ok) {
    return { papers: [], total: 0, status: { source: 'arxiv', ok: false, count: 0, note: res.error } };
  }

  let feed: Record<string, unknown>;
  try {
    feed = (xml.parse(res.data) as Record<string, Record<string, unknown>>).feed ?? {};
  } catch {
    return {
      papers: [],
      total: 0,
      status: { source: 'arxiv', ok: false, count: 0, note: 'could not parse the Atom feed' },
    };
  }

  const total = Number(xmlText(feed['opensearch:totalResults'])) || 0;
  const papers: Paper[] = [];

  for (const entry of asArray(feed.entry as Record<string, unknown> | Record<string, unknown>[])) {
    const absUrl = xmlText(entry.id);
    const arxivId = /arxiv\.org\/abs\/(.+)$/.exec(absUrl)?.[1] ?? absUrl;
    const links = asArray(entry.link as Record<string, unknown> | Record<string, unknown>[]);
    const pdfLink = links.find((l) => l['@_title'] === 'pdf' || l['@_type'] === 'application/pdf');
    const published = xmlText(entry.published) || xmlText(entry.updated);
    const doi = normalizeDoi(xmlText(entry['arxiv:doi']));
    const primary = entry['arxiv:primary_category'] as Record<string, unknown> | undefined;
    const title = cleanText(xmlText(entry.title));
    if (!title) continue;

    papers.push({
      id: arxivId,
      sources: ['arxiv'],
      title,
      authors: asArray(entry.author as Record<string, unknown> | Record<string, unknown>[])
        .map((a) => xmlText(a.name))
        .filter(Boolean),
      venue: cleanText(xmlText(entry['arxiv:journal_ref'])) ?? `arXiv${primary ? ` (${primary['@_term']})` : ''}`,
      year: published ? new Date(published).getUTCFullYear() : undefined,
      date: published ? published.slice(0, 10) : undefined,
      doi,
      abstract: opts.includeAbstracts === false ? undefined : cleanText(xmlText(entry.summary)),
      url: absUrl.replace('http://', 'https://'),
      pdfUrl: pdfLink ? String(pdfLink['@_href']).replace('http://', 'https://') : `https://arxiv.org/pdf/${arxivId}`,
      type: 'preprint',
      openAccess: true,
    });
  }

  return { papers, total, status: { source: 'arxiv', ok: true, count: papers.length } };
}

// --------------------------------------------------------------- PubMed

/** Pull one PubMed record out of an efetch PubmedArticleSet entry. */
function pubmedArticle(article: Record<string, unknown>, includeAbstract: boolean): Paper | undefined {
  const citation = article.MedlineCitation as Record<string, unknown> | undefined;
  if (!citation) return undefined;
  const art = citation.Article as Record<string, unknown> | undefined;
  if (!art) return undefined;

  const pmid = xmlText(citation.PMID);
  const title = cleanText(xmlText(art.ArticleTitle));
  if (!title) return undefined;

  const journal = art.Journal as Record<string, unknown> | undefined;
  const issue = journal?.JournalIssue as Record<string, unknown> | undefined;
  const pubDate = issue?.PubDate as Record<string, unknown> | undefined;
  const year = Number(xmlText(pubDate?.Year)) || Number(/\d{4}/.exec(xmlText(pubDate?.MedlineDate))?.[0]) || undefined;

  const authors = asArray(
    (art.AuthorList as Record<string, unknown> | undefined)?.Author as
      | Record<string, unknown>
      | Record<string, unknown>[],
  )
    .map((a) => {
      const last = xmlText(a.LastName);
      const initials = xmlText(a.Initials);
      return last ? `${last}${initials ? ` ${initials}` : ''}` : xmlText(a.CollectiveName);
    })
    .filter(Boolean);

  let doi: string | undefined;
  let pmcid: string | undefined;
  for (const loc of asArray(art.ELocationID as Record<string, unknown> | Record<string, unknown>[])) {
    if (loc['@_EIdType'] === 'doi') doi = normalizeDoi(xmlText(loc));
  }
  const pubmedData = article.PubmedData as Record<string, unknown> | undefined;
  for (const id of asArray(
    (pubmedData?.ArticleIdList as Record<string, unknown> | undefined)?.ArticleId as
      | Record<string, unknown>
      | Record<string, unknown>[],
  )) {
    const kind = id['@_IdType'];
    if (kind === 'doi' && !doi) doi = normalizeDoi(xmlText(id));
    if (kind === 'pmc') pmcid = xmlText(id);
  }

  const abstractNode = art.Abstract as Record<string, unknown> | undefined;
  const abstract = includeAbstract
    ? cleanText(
        asArray(abstractNode?.AbstractText as unknown)
          .map((part) => {
            const label = (part as Record<string, unknown>)?.['@_Label'];
            const body = xmlText(part);
            return label ? `${String(label)}: ${body}` : body;
          })
          .join(' '),
      )
    : undefined;

  const types = asArray(
    (art.PublicationTypeList as Record<string, unknown> | undefined)?.PublicationType as unknown,
  ).map((t) => xmlText(t));

  return {
    id: doi ?? `pmid:${pmid}`,
    sources: ['pubmed'],
    title,
    authors,
    venue: cleanText(xmlText(journal?.Title)) ?? cleanText(xmlText(journal?.ISOAbbreviation)),
    year,
    doi,
    abstract,
    url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    pdfUrl: pmcid ? `https://www.ncbi.nlm.nih.gov/pmc/articles/${pmcid}/` : undefined,
    type: types.find((t) => t && t !== 'Journal Article') ?? types[0],
    openAccess: Boolean(pmcid),
  };
}

async function searchPubmed(
  query: string,
  opts: PaperSearchOptions,
): Promise<{ papers: Paper[]; total: number; status: SourceStatus }> {
  const key = ncbiKey();
  const limit = Math.min(opts.limit ?? 10, 25);
  const base = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

  const searchUrl =
    `${base}/esearch.fcgi?` +
    qs({
      db: 'pubmed',
      term: query,
      retmode: 'json',
      retmax: limit,
      sort: opts.sortBy === 'date' ? 'date' : 'relevance',
      datetype: opts.yearFrom || opts.yearTo ? 'pdat' : undefined,
      mindate: opts.yearFrom ? `${opts.yearFrom}/01/01` : undefined,
      maxdate: opts.yearTo ? `${opts.yearTo}/12/31` : undefined,
      tool: NCBI_TOOL,
      api_key: key,
    });

  const search = await apiGetJson<{ esearchresult?: { count?: string; idlist?: string[] } }>(searchUrl, {
    timeout: opts.timeout,
  });
  if (!search.ok) {
    const note =
      search.status === 429
        ? 'rate-limited (3 requests/sec unauthenticated); set NCBI_API_KEY for 10/sec'
        : search.error;
    return { papers: [], total: 0, status: { source: 'pubmed', ok: false, count: 0, note } };
  }

  const ids = search.data.esearchresult?.idlist ?? [];
  const total = Number(search.data.esearchresult?.count) || 0;
  if (!ids.length) return { papers: [], total, status: { source: 'pubmed', ok: true, count: 0 } };

  // One efetch returns titles, journals, authors, DOIs and abstracts together.
  const fetchUrl =
    `${base}/efetch.fcgi?` +
    qs({ db: 'pubmed', id: ids.join(','), rettype: 'abstract', retmode: 'xml', tool: NCBI_TOOL, api_key: key });
  const fetched = await apiGetText(fetchUrl, { accept: 'application/xml', timeout: opts.timeout ?? 30_000 });
  if (!fetched.ok) {
    return {
      papers: [],
      total,
      status: {
        source: 'pubmed',
        ok: false,
        count: 0,
        note: `found ${total} hits but efetch failed: ${fetched.error}`,
      },
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = (xml.parse(fetched.data) as Record<string, Record<string, unknown>>).PubmedArticleSet ?? {};
  } catch {
    return {
      papers: [],
      total,
      status: { source: 'pubmed', ok: false, count: 0, note: 'could not parse the efetch XML' },
    };
  }

  const papers = asArray(parsed.PubmedArticle as Record<string, unknown> | Record<string, unknown>[])
    .map((a) => pubmedArticle(a, opts.includeAbstracts !== false))
    .filter((p): p is Paper => Boolean(p));

  return { papers, total, status: { source: 'pubmed', ok: true, count: papers.length } };
}

// ----------------------------------------------------- bioRxiv / medRxiv

interface BiorxivRecord {
  title?: string;
  authors?: string;
  doi?: string;
  date?: string;
  version?: string;
  type?: string;
  category?: string;
  abstract?: string;
  server?: string;
}

function isoDay(offsetDays: number): string {
  const d = new Date(Date.now() - offsetDays * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/**
 * bioRxiv and medRxiv publish their whole catalogue but offer no keyword
 * search endpoint, so there is no honest way to do a server-side query. We
 * page through a recency window and match locally — good for "what appeared
 * this month", not a substitute for a full-corpus search. The output says so.
 */
async function searchPreprintServer(
  server: 'biorxiv' | 'medrxiv',
  query: string,
  opts: PaperSearchOptions,
): Promise<{ papers: Paper[]; total: number; status: SourceStatus }> {
  const windowDays = Math.max(1, Math.min(opts.preprintWindowDays ?? 30, 365));
  const from = isoDay(windowDays);
  const to = isoDay(0);
  const terms = queryTerms(query);
  const pages = [0, 1, 2, 3, 4, 5, 6, 7];
  let scanned = 0;
  let total = 0;
  let failures = 0;

  const batches = await runPool(pages, 4, async (page) => {
    const url = `https://api.biorxiv.org/details/${server}/${from}/${to}/${page * 30}`;
    const res = await apiGetJson<{
      messages?: { status?: string; total?: string }[];
      collection?: BiorxivRecord[];
    }>(url, { timeout: opts.timeout });
    if (!res.ok) {
      failures++;
      return [] as BiorxivRecord[];
    }
    const message = res.data.messages?.[0];
    if (message?.total) total = Math.max(total, Number(message.total) || 0);
    const collection = res.data.collection ?? [];
    scanned += collection.length;
    return collection;
  });

  if (failures === pages.length) {
    return {
      papers: [],
      total: 0,
      status: { source: server, ok: false, count: 0, note: 'API unreachable' },
    };
  }

  const seen = new Set<string>();
  const papers: Paper[] = [];
  for (const rec of batches.flat()) {
    const title = cleanText(rec.title);
    if (!title || !rec.doi) continue;
    const doi = normalizeDoi(rec.doi);
    if (!doi || seen.has(doi)) continue;
    const haystack = `${title} ${rec.abstract ?? ''} ${rec.authors ?? ''} ${rec.category ?? ''}`;
    if (terms.length && !matchesAllTerms(haystack, terms)) continue;
    seen.add(doi);

    papers.push({
      id: doi,
      sources: [server],
      title,
      authors: (rec.authors ?? '')
        .split(';')
        .map((a) => a.trim())
        .filter(Boolean),
      venue: `${server === 'biorxiv' ? 'bioRxiv' : 'medRxiv'}${rec.category ? ` (${rec.category})` : ''}`,
      year: rec.date ? Number(rec.date.slice(0, 4)) : undefined,
      date: rec.date,
      doi,
      abstract: opts.includeAbstracts === false ? undefined : cleanText(rec.abstract),
      url: `https://doi.org/${doi}`,
      pdfUrl: `https://www.${server}.org/content/${doi}v${rec.version ?? '1'}.full.pdf`,
      type: rec.type ?? 'preprint',
      version: rec.version,
      openAccess: true,
    });
  }

  return {
    papers,
    total,
    status: {
      source: server,
      ok: true,
      count: papers.length,
      note:
        `keyword-matched locally over ${scanned} preprints posted since ${from}` +
        ` (the ${server} API has no server-side search)` +
        (failures ? `; ${failures}/${pages.length} pages failed` : ''),
    },
  };
}

// ------------------------------------------------------------- Crossref

interface CrossrefItem {
  DOI?: string;
  title?: string[];
  author?: { given?: string; family?: string; name?: string }[];
  issued?: { 'date-parts'?: number[][] };
  posted?: { 'date-parts'?: number[][] };
  'container-title'?: string[];
  'group-title'?: string;
  abstract?: string;
  'is-referenced-by-count'?: number;
  URL?: string;
  type?: string;
  link?: { URL?: string; 'content-type'?: string }[];
}

function crossrefDate(item: CrossrefItem): { year?: number; date?: string } {
  const parts = (item.posted ?? item.issued)?.['date-parts']?.[0];
  if (!parts?.length) return {};
  const [y, m, d] = parts;
  return {
    year: y,
    date: y ? `${y}-${String(m ?? 1).padStart(2, '0')}-${String(d ?? 1).padStart(2, '0')}` : undefined,
  };
}

/**
 * Crossref registers every DOI, including book blurbs and publisher front
 * matter that match a query but are not research. Repeating a filter name ORs
 * it, so this keeps the record types a literature search actually wants.
 */
const CROSSREF_TYPES = [
  'journal-article',
  'proceedings-article',
  'posted-content',
  'report',
  'dissertation',
  'book-chapter',
];

async function searchCrossref(
  query: string,
  opts: PaperSearchOptions,
): Promise<{ papers: Paper[]; total: number; status: SourceStatus }> {
  const filters: string[] = CROSSREF_TYPES.map((t) => `type:${t}`);
  if (opts.yearFrom) filters.push(`from-pub-date:${opts.yearFrom}-01-01`);
  if (opts.yearTo) filters.push(`until-pub-date:${opts.yearTo}-12-31`);

  const url =
    'https://api.crossref.org/works?' +
    qs({
      query,
      rows: Math.min((opts.limit ?? 10) * 2, 40),
      filter: filters.length ? filters.join(',') : undefined,
      sort: opts.sortBy === 'date' ? 'published' : opts.sortBy === 'citations' ? 'is-referenced-by-count' : 'relevance',
      order: 'desc',
      select:
        'DOI,title,author,issued,posted,container-title,group-title,abstract,is-referenced-by-count,URL,type,link',
    });

  const res = await apiGetJson<{ message?: { 'total-results'?: number; items?: CrossrefItem[] } }>(url, {
    timeout: opts.timeout,
  });
  if (!res.ok) {
    return { papers: [], total: 0, status: { source: 'crossref', ok: false, count: 0, note: res.error } };
  }

  const items = res.data.message?.items ?? [];
  const papers: Paper[] = [];
  for (const item of items) {
    const title = cleanText(item.title?.[0]);
    const doi = normalizeDoi(item.DOI);
    if (!title || !doi) continue;
    const { year, date } = crossrefDate(item);
    const pdf = item.link?.find((l) => l['content-type'] === 'application/pdf')?.URL;

    papers.push({
      id: doi,
      sources: ['crossref'],
      title,
      authors: (item.author ?? [])
        .map((a) => a.name ?? [a.given, a.family].filter(Boolean).join(' '))
        .filter(Boolean),
      venue: cleanText(item['container-title']?.[0]) ?? cleanText(item['group-title']),
      year,
      date,
      doi,
      abstract: opts.includeAbstracts === false ? undefined : cleanText(item.abstract),
      citations: item['is-referenced-by-count'],
      url: item.URL ?? `https://doi.org/${doi}`,
      pdfUrl: pdf,
      type: item.type,
    });
  }

  return {
    papers,
    total: res.data.message?.['total-results'] ?? papers.length,
    status: { source: 'crossref', ok: true, count: papers.length },
  };
}

// ------------------------------------------------------------- OpenAlex

interface OpenAlexWork {
  id?: string;
  doi?: string;
  title?: string;
  display_name?: string;
  publication_year?: number;
  publication_date?: string;
  cited_by_count?: number;
  type?: string;
  abstract_inverted_index?: Record<string, number[]>;
  authorships?: { author?: { display_name?: string } }[];
  primary_location?: {
    source?: { display_name?: string };
    landing_page_url?: string;
    pdf_url?: string;
  };
  best_oa_location?: { pdf_url?: string; landing_page_url?: string };
  open_access?: { is_oa?: boolean; oa_url?: string };
}

/** OpenAlex ships abstracts as a word → positions map, to sidestep licensing. */
function invertedAbstract(index: Record<string, number[]> | undefined): string | undefined {
  if (!index) return undefined;
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const pos of positions) words[pos] = word;
  }
  const text = words.filter(Boolean).join(' ').trim();
  return text || undefined;
}

function openAlexPaper(work: OpenAlexWork, includeAbstract: boolean): Paper | undefined {
  const title = cleanText(work.title ?? work.display_name);
  if (!title) return undefined;
  const doi = normalizeDoi(work.doi);
  const openAlexId = work.id?.split('/').pop();

  return {
    id: doi ?? openAlexId ?? title,
    sources: ['openalex'],
    title,
    authors: (work.authorships ?? []).map((a) => a.author?.display_name ?? '').filter(Boolean),
    venue: cleanText(work.primary_location?.source?.display_name),
    year: work.publication_year,
    date: work.publication_date,
    doi,
    abstract: includeAbstract ? invertedAbstract(work.abstract_inverted_index) : undefined,
    citations: work.cited_by_count,
    url: work.primary_location?.landing_page_url ?? (doi ? `https://doi.org/${doi}` : (work.id ?? '')),
    pdfUrl: work.best_oa_location?.pdf_url ?? work.primary_location?.pdf_url ?? work.open_access?.oa_url,
    type: work.type,
    openAccess: work.open_access?.is_oa,
  };
}

const OPENALEX_SELECT =
  'id,doi,title,publication_year,publication_date,cited_by_count,type,authorships,primary_location,best_oa_location,open_access,abstract_inverted_index';

async function searchOpenAlex(
  query: string,
  opts: PaperSearchOptions,
): Promise<{ papers: Paper[]; total: number; status: SourceStatus }> {
  const filters: string[] = [];
  if (opts.yearFrom || opts.yearTo) {
    filters.push(`publication_year:${opts.yearFrom ?? 1800}-${opts.yearTo ?? new Date().getFullYear()}`);
  }

  const url =
    'https://api.openalex.org/works?' +
    qs({
      search: query,
      per_page: Math.min((opts.limit ?? 10) * 2, 50),
      filter: filters.length ? filters.join(',') : undefined,
      sort:
        opts.sortBy === 'date'
          ? 'publication_date:desc'
          : opts.sortBy === 'citations'
            ? 'cited_by_count:desc'
            : undefined,
      select: OPENALEX_SELECT,
      api_key: openAlexKey(),
    });

  const res = await apiGetJsonRetrying<{ meta?: { count?: number }; results?: OpenAlexWork[] }>(url, {
    timeout: opts.timeout,
  });
  if (!res.ok) {
    const note =
      res.status === 429 || res.status === 403
        ? `${res.error} — OpenAlex shares one free daily budget per IP when unauthenticated; OPENALEX_API_KEY raises it`
        : res.error;
    return { papers: [], total: 0, status: { source: 'openalex', ok: false, count: 0, note } };
  }

  const papers = (res.data.results ?? [])
    .map((w) => openAlexPaper(w, opts.includeAbstracts !== false))
    .filter((p): p is Paper => Boolean(p));

  return {
    papers,
    total: res.data.meta?.count ?? papers.length,
    status: { source: 'openalex', ok: true, count: papers.length },
  };
}

/**
 * Backfill citation counts. arXiv, PubMed and the preprint servers do not
 * publish them; OpenAlex does, and takes up to 50 DOIs in one filter.
 */
async function enrichFromOpenAlex(papers: Paper[], timeout?: number): Promise<string | undefined> {
  const needing = papers.filter((p) => p.citations === undefined && p.doi).slice(0, 50);
  if (!needing.length) return undefined;

  const url =
    'https://api.openalex.org/works?' +
    qs({
      filter: `doi:${needing.map((p) => p.doi).join('|')}`,
      per_page: 50,
      select: 'doi,cited_by_count,best_oa_location,open_access,primary_location',
      api_key: openAlexKey(),
    });

  const res = await apiGetJsonRetrying<{ results?: OpenAlexWork[] }>(url, { timeout });
  if (!res.ok) return `citation counts unavailable (OpenAlex: ${res.error})`;

  const byDoi = new Map<string, OpenAlexWork>();
  for (const work of res.data.results ?? []) {
    const doi = normalizeDoi(work.doi);
    if (doi) byDoi.set(doi, work);
  }
  let matched = 0;
  for (const paper of needing) {
    const work = paper.doi ? byDoi.get(paper.doi) : undefined;
    if (!work) continue;
    matched++;
    paper.citations = work.cited_by_count;
    if (paper.openAccess === undefined) paper.openAccess = work.open_access?.is_oa;
    if (!paper.pdfUrl) paper.pdfUrl = work.best_oa_location?.pdf_url ?? work.open_access?.oa_url;
  }
  log.debug('openalex enrichment', { requested: needing.length, matched });
  return undefined;
}

// --------------------------------------------------------------- merging

/** Merge records for the same work, preferring the richest field from any source. */
function mergePapers(groups: Paper[][]): Paper[] {
  const byKey = new Map<string, Paper>();

  for (const paper of groups.flat()) {
    const key = paper.doi ?? `t:${titleKey(paper.title)}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...paper, sources: [...paper.sources] });
      continue;
    }
    for (const source of paper.sources) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
    }
    existing.title = existing.title.length >= paper.title.length ? existing.title : paper.title;
    if (paper.authors.length > existing.authors.length) existing.authors = paper.authors;
    existing.venue ??= paper.venue;
    existing.year ??= paper.year;
    existing.date ??= paper.date;
    existing.doi ??= paper.doi;
    existing.type ??= paper.type;
    existing.version ??= paper.version;
    existing.openAccess ??= paper.openAccess;
    if (paper.citations !== undefined && (existing.citations ?? -1) < paper.citations) {
      existing.citations = paper.citations;
    }
    if ((paper.abstract?.length ?? 0) > (existing.abstract?.length ?? 0)) existing.abstract = paper.abstract;
    // Prefer a real PDF over a landing page.
    if (paper.pdfUrl && (!existing.pdfUrl || (!/\.pdf/i.test(existing.pdfUrl) && /\.pdf/i.test(paper.pdfUrl)))) {
      existing.pdfUrl = paper.pdfUrl;
    }
    if (!existing.url) existing.url = paper.url;
    // An arXiv id or DOI beats an opaque OpenAlex key as the read handle.
    if (!existing.doi && paper.doi) existing.id = paper.doi;
  }

  return [...byKey.values()];
}

function sortPapers(papers: Paper[], sortBy: PaperSearchOptions['sortBy'], order: Map<string, number>): Paper[] {
  if (sortBy === 'date') {
    return papers.sort((a, b) => (b.date ?? String(b.year ?? '')).localeCompare(a.date ?? String(a.year ?? '')));
  }
  if (sortBy === 'citations') {
    return papers.sort((a, b) => (b.citations ?? -1) - (a.citations ?? -1));
  }
  // Relevance: keep each source's own ranking, interleaved by first appearance.
  return papers.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

/** Search academic literature across several free APIs at once. */
export async function searchPapers(query: string, opts: PaperSearchOptions = {}): Promise<PaperSearchResult> {
  const started = Date.now();
  const sources = opts.sources?.length ? opts.sources : DEFAULT_SOURCES;
  const limit = Math.max(1, Math.min(opts.limit ?? 10, 50));

  const runs = await runPool(sources, sources.length, async (source) => {
    switch (source) {
      case 'arxiv':
        return searchArxiv(query, opts);
      case 'pubmed':
        return searchPubmed(query, opts);
      case 'biorxiv':
      case 'medrxiv':
        return searchPreprintServer(source, query, opts);
      case 'crossref':
        return searchCrossref(query, opts);
      case 'openalex':
        return searchOpenAlex(query, opts);
      default:
        return {
          papers: [] as Paper[],
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

  // Interleave by rank so one source cannot monopolise the head of the list.
  const order = new Map<string, number>();
  const maxLen = Math.max(0, ...runs.map((r) => r.papers.length));
  let rank = 0;
  for (let i = 0; i < maxLen; i++) {
    for (const run of runs) {
      const paper = run.papers[i];
      if (paper && !order.has(paper.id)) order.set(paper.id, rank++);
    }
  }

  let merged = mergePapers(runs.map((r) => r.papers));
  merged = sortPapers(merged, opts.sortBy, order).slice(0, limit);

  if (opts.enrichCitations !== false && merged.length) {
    const note = await enrichFromOpenAlex(merged, opts.timeout);
    if (note) statuses.push({ source: 'openalex (citations)', ok: false, count: 0, note });
    if (opts.sortBy === 'citations') merged = sortPapers(merged, 'citations', order);
  }

  // Count per source only what survived the merge.
  for (const status of statuses) {
    if (!status.ok) continue;
    const survived = merged.filter((p) => p.sources.includes(status.source as PaperSource)).length;
    status.count = survived;
  }

  return { query, papers: merged, sources: statuses, totals, elapsedMs: Date.now() - started };
}

// ------------------------------------------------------------ read_paper

/** Work out what kind of identifier we were handed. */
function classifyId(raw: string): { kind: 'arxiv' | 'doi' | 'pmid' | 'url'; value: string } {
  const id = raw.trim();

  const pmid = /^(?:pmid:)?(\d{5,9})$/i.exec(id) ?? /pubmed\.ncbi\.nlm\.nih\.gov\/(\d{5,9})/.exec(id);
  if (pmid) return { kind: 'pmid', value: pmid[1] };

  const arxivUrl = /arxiv\.org\/(?:abs|pdf)\/([^\s?#]+?)(?:\.pdf)?$/i.exec(id);
  if (arxivUrl) return { kind: 'arxiv', value: arxivUrl[1] };
  if (/^arxiv:/i.test(id)) return { kind: 'arxiv', value: id.replace(/^arxiv:/i, '') };
  if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(id)) return { kind: 'arxiv', value: id };
  if (/^[a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d+)?$/.test(id)) return { kind: 'arxiv', value: id };

  const doi = normalizeDoi(id);
  if (doi) return { kind: 'doi', value: doi };

  return { kind: 'url', value: id };
}

async function paperByArxivId(arxivId: string, timeout?: number): Promise<Paper | undefined> {
  const res = await apiGetText(`http://export.arxiv.org/api/query?${qs({ id_list: arxivId, max_results: 1 })}`, {
    accept: 'application/atom+xml',
    timeout,
  });
  if (!res.ok) return undefined;
  try {
    const feed = (xml.parse(res.data) as Record<string, Record<string, unknown>>).feed ?? {};
    const entry = asArray(feed.entry as Record<string, unknown> | Record<string, unknown>[])[0];
    if (!entry) return undefined;
    const title = cleanText(xmlText(entry.title));
    if (!title) return undefined;
    const published = xmlText(entry.published);
    const primary = entry['arxiv:primary_category'] as Record<string, unknown> | undefined;
    return {
      id: arxivId,
      sources: ['arxiv'],
      title,
      authors: asArray(entry.author as Record<string, unknown> | Record<string, unknown>[])
        .map((a) => xmlText(a.name))
        .filter(Boolean),
      venue: cleanText(xmlText(entry['arxiv:journal_ref'])) ?? `arXiv${primary ? ` (${primary['@_term']})` : ''}`,
      year: published ? new Date(published).getUTCFullYear() : undefined,
      date: published ? published.slice(0, 10) : undefined,
      doi: normalizeDoi(xmlText(entry['arxiv:doi'])),
      abstract: cleanText(xmlText(entry.summary)),
      url: `https://arxiv.org/abs/${arxivId}`,
      pdfUrl: `https://arxiv.org/pdf/${arxivId}`,
      type: 'preprint',
      openAccess: true,
    };
  } catch {
    return undefined;
  }
}

async function paperByDoi(doi: string, timeout?: number): Promise<Paper | undefined> {
  const res = await apiGetJson<OpenAlexWork>(
    `https://api.openalex.org/works/doi:${encodeURIComponent(doi)}?${qs({
      select: OPENALEX_SELECT,
      api_key: openAlexKey(),
    })}`,
    { timeout },
  );
  if (res.ok) {
    const paper = openAlexPaper(res.data, true);
    if (paper) return paper;
  }
  // Crossref is the registry of record, so it is the right fallback.
  const cr = await apiGetJson<{ message?: CrossrefItem }>(
    `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
    { timeout },
  );
  if (!cr.ok || !cr.data.message) return undefined;
  const item = cr.data.message;
  const title = cleanText(item.title?.[0]);
  if (!title) return undefined;
  const { year, date } = crossrefDate(item);
  return {
    id: doi,
    sources: ['crossref'],
    title,
    authors: (item.author ?? []).map((a) => a.name ?? [a.given, a.family].filter(Boolean).join(' ')).filter(Boolean),
    venue: cleanText(item['container-title']?.[0]) ?? cleanText(item['group-title']),
    year,
    date,
    doi,
    abstract: cleanText(item.abstract),
    citations: item['is-referenced-by-count'],
    url: item.URL ?? `https://doi.org/${doi}`,
    pdfUrl: item.link?.find((l) => l['content-type'] === 'application/pdf')?.URL,
    type: item.type,
  };
}

async function paperByPmid(pmid: string, timeout?: number): Promise<Paper | undefined> {
  const url =
    'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?' +
    qs({ db: 'pubmed', id: pmid, rettype: 'abstract', retmode: 'xml', tool: NCBI_TOOL, api_key: ncbiKey() });
  const res = await apiGetText(url, { accept: 'application/xml', timeout: timeout ?? 30_000 });
  if (!res.ok) return undefined;
  try {
    const set = (xml.parse(res.data) as Record<string, Record<string, unknown>>).PubmedArticleSet ?? {};
    const article = asArray(set.PubmedArticle as Record<string, unknown> | Record<string, unknown>[])[0];
    return article ? pubmedArticle(article, true) : undefined;
  } catch {
    return undefined;
  }
}

/** bioRxiv/medRxiv expose abstract plus version history for their own DOIs. */
async function preprintDetails(doi: string, timeout?: number): Promise<Paper | undefined> {
  for (const server of ['biorxiv', 'medrxiv'] as const) {
    const res = await apiGetJson<{ collection?: BiorxivRecord[] }>(
      `https://api.biorxiv.org/details/${server}/${doi}`,
      { timeout },
    );
    if (!res.ok) continue;
    const records = res.data.collection ?? [];
    const rec = records[records.length - 1];
    const title = cleanText(rec?.title);
    if (!rec || !title) continue;
    return {
      id: doi,
      sources: [server],
      title,
      authors: (rec.authors ?? '')
        .split(';')
        .map((a) => a.trim())
        .filter(Boolean),
      venue: `${server === 'biorxiv' ? 'bioRxiv' : 'medRxiv'}${rec.category ? ` (${rec.category})` : ''}`,
      year: rec.date ? Number(rec.date.slice(0, 4)) : undefined,
      date: rec.date,
      doi,
      abstract: cleanText(rec.abstract),
      url: `https://doi.org/${doi}`,
      pdfUrl: `https://www.${server}.org/content/${doi}v${rec.version ?? '1'}.full.pdf`,
      type: rec.type ?? 'preprint',
      version: rec.version,
      openAccess: true,
    };
  }
  return undefined;
}

/**
 * Phrases that mean we fetched a wall, not a paper.
 *
 * Publishers rarely answer a PDF request with an honest 403. They answer 200
 * with an identity-provider hop, a cookie wall or a "sign in for access" page,
 * and a naive reader records that as the full text. Returning a 200-byte
 * interstitial as a paper's contents is worse than returning nothing, so we
 * check what came back and say "paywalled" when that is what happened.
 */
const INTERSTITIAL_MARKERS = [
  "required part of this site couldn't load",
  'required part of this site couldn’t load',
  'enable javascript',
  'verify you are human',
  'are you a robot',
  'just a moment',
  'access denied',
  'sign in to continue',
  'sign in to read',
  'institutional access',
  'purchase this article',
  'get access to this article',
  'subscribe to read',
  'checking your browser',
];

/** Minimum body we will call a paper's full text. */
const MIN_FULL_TEXT_CHARS = 1200;

function fullTextProblem(markdown: string, finalUrl: string, pages: number | undefined): string | undefined {
  const body = markdown.trim();
  const lower = body.toLowerCase();

  const marker = INTERSTITIAL_MARKERS.find((m) => lower.includes(m));
  if (marker) return `the publisher returned an access wall ("${marker}")`;

  // An identity-provider hop means we never reached the document.
  if (/[./-](?:idp|login|signin|sign-in|auth|sso|openathens)[./-]|[?&]redirect_uri=|\/transit\?|shibboleth|wayf/i.test(finalUrl)) {
    return `redirected to a sign-in host (${new URL(finalUrl).host})`;
  }
  if (body.length < MIN_FULL_TEXT_CHARS && !pages) {
    return `only ${body.length} characters came back, which is a landing page rather than the text`;
  }
  return undefined;
}

/**
 * Fetch one paper: its metadata and abstract always, and its full text when a
 * PDF or OA landing page is openly reachable. `scrape()` already parses PDFs,
 * so reading a paper is the same operation as reading a page.
 */
export async function readPaper(
  id: string,
  opts: { fullText?: boolean; maxChars?: number; timeout?: number } = {},
): Promise<PaperReadResult> {
  const started = Date.now();
  const notes: string[] = [];
  const { kind, value } = classifyId(id);

  let paper: Paper | undefined;
  if (kind === 'arxiv') {
    paper = await paperByArxivId(value, opts.timeout);
    if (!paper) notes.push(`arXiv has no record for "${value}"`);
  } else if (kind === 'pmid') {
    paper = await paperByPmid(value, opts.timeout);
    if (!paper) notes.push(`PubMed has no record for PMID ${value}`);
  } else if (kind === 'doi') {
    // 10.1101 and 10.64898 are the Cold Spring Harbor preprint prefixes.
    if (/^10\.(1101|64898)\//.test(value)) paper = await preprintDetails(value, opts.timeout);
    paper ??= await paperByDoi(value, opts.timeout);
    if (!paper) notes.push(`no metadata found for DOI ${value} in OpenAlex or Crossref`);
  }

  if (kind === 'url') {
    notes.push(`"${id}" is not an arXiv id, DOI or PMID — reading it as a plain URL`);
  }

  // arXiv and PubMed do not publish citation counts; OpenAlex does.
  if (paper && paper.citations === undefined && paper.doi) {
    const note = await enrichFromOpenAlex([paper], opts.timeout);
    if (note) notes.push(note);
  }

  // Full text: the paper's PDF if we have one, otherwise whatever the id points at.
  let fullText: string | undefined;
  let fullTextSource: string | undefined;
  let fullTextPages: number | undefined;

  if (opts.fullText !== false) {
    // The PDF first, then the landing page: a publisher that gates the PDF
    // often leaves the HTML article readable.
    const candidates = [...new Set([paper?.pdfUrl, paper?.url, kind === 'url' ? value : undefined].filter(Boolean))] as string[];

    if (!candidates.length) {
      notes.push('no openly reachable full text for this record');
    }

    const failures: string[] = [];
    for (const target of candidates) {
      const result = await scrape(target, {
        formats: ['markdown'],
        onlyMainContent: true,
        maxChars: opts.maxChars,
        timeout: opts.timeout ?? 60_000,
        maxAge: 86_400_000,
        parseDocuments: true,
      });

      if (!paper && result.success) {
        paper = {
          id,
          sources: [],
          title: result.metadata.title ?? id,
          authors: result.metadata.author ? [result.metadata.author] : [],
          url: result.metadata.url,
          abstract: clip(result.metadata.description, 1200),
        };
      }

      if (!result.success || !result.markdown?.trim()) {
        failures.push(
          `${target} — ${result.error ?? result.metadata.blockReason ?? 'no text returned'}`,
        );
        continue;
      }

      const problem = fullTextProblem(result.markdown, result.metadata.url, result.metadata.pages);
      if (problem) {
        failures.push(`${target} — ${problem}`);
        continue;
      }

      fullText = result.markdown;
      fullTextSource = result.metadata.url;
      fullTextPages = result.metadata.pages;
      if (result.metadata.blockReason) {
        notes.push(`full text came back behind a bot wall (${result.metadata.blockReason}) — may be partial`);
      }
      break;
    }

    if (!fullText && failures.length) {
      notes.push(
        `full text not openly reachable (the abstract above is real, the full text is not included): ${failures.join('; ')}`,
      );
    }
  }

  return { paper, fullText, fullTextSource, fullTextPages, notes, elapsedMs: Date.now() - started };
}
