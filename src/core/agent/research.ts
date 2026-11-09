/**
 * `deepResearch`: Firecrawl's `agent` endpoint, rebuilt as a bounded orchestrator.
 *
 * Firecrawl's agent is a research loop that an LLM drives: it decides what to
 * search, what to read, and then writes the answer. That design is why it
 * costs money and why it is billed "dynamically" — you are paying for an
 * unknown number of model calls you cannot see.
 *
 * This is the same shape with the model taken out of the middle. We do the
 * part that is mechanical — decomposing the question, fanning out across the
 * sources we already have, reading the promising pages with BM25 extraction so
 * each one contributes only its relevant passages, de-duplicating, and ranking
 * — and we hand the caller well-sourced, citation-carrying passages. The
 * synthesis belongs to whichever model called the tool. It is already a
 * language model; paying a second one to summarise for it is the part of
 * Firecrawl's bill that buys nothing.
 *
 * Three properties matter more than breadth here:
 *
 *  1. **Bounded.** Sub-queries, pages read, total characters and wall-clock
 *     time are all hard caps, checked before every step rather than hoped for.
 *     A research tool that can spend ten minutes and 200k characters is a tool
 *     that will eventually fill its caller's context and strand the answer.
 *  2. **Honest.** Web search can be throttled (DuckDuckGo rate-limits per IP)
 *     and an index can be down. Every source that could not be reached is
 *     returned in `gaps` with the reason and, where one exists, the fix. Zero
 *     sources is reported as a failed run, never as a finished one.
 *  3. **Attributable.** Every finding carries its URL and title. A passage
 *     without provenance cannot be cited, and an uncitable passage is worse
 *     than no passage: it reads like knowledge and cannot be checked.
 */
import { search, providerStatuses, type SearchResponse } from '../search/index.js';
import { scrape } from '../scrape.js';
import { searchCorpus, type CorpusHit } from '../crawl/store.js';
import { searchPapers } from '../indexes/papers.js';
import { developerSearch } from '../indexes/developer.js';
import { govSearch } from '../indexes/gov.js';
import { normalizeUrl } from '../util/url.js';
import { runPool } from '../util/pool.js';
import { log } from '../util/log.js';

export type ResearchSourceName = 'web' | 'corpus' | 'papers' | 'developer' | 'gov';

/**
 * Question shape, decided by keyword heuristics rather than a model call.
 * It only steers which sub-queries we generate and which indexes we consult,
 * so a misclassification costs a slightly worse sub-query, not a wrong answer.
 */
export type QuestionKind = 'comparison' | 'howto' | 'definition' | 'temporal' | 'factual';

export interface ResearchOptions {
  /** Hard cap on sub-queries. Default 4. */
  maxSubQueries?: number;
  /** Hard cap on pages scraped. Default 12. */
  maxPages?: number;
  /** Hard cap on characters across all findings. Default 40000. */
  maxChars?: number;
  /** Wall-clock deadline for the whole run, in ms. Default 90000. */
  deadlineMs?: number;
  /** Characters kept per page. Default 3500. */
  charsPerPage?: number;
  /** Web results requested per sub-query. Default 6. */
  resultsPerQuery?: number;
  /** Parallel page reads. Default 4. */
  concurrency?: number;
  /** Restrict gathering to these sources. Default: web + corpus + whichever index the question fits. */
  sources?: ResearchSourceName[];
  /** Keep only web results on these hostnames. */
  includeDomains?: string[];
  /** Drop web results on these hostnames. */
  excludeDomains?: string[];
  /** Serve pages from the local cache when younger than this (ms). Default 24h. */
  maxAge?: number;
  /** Per-page scrape timeout in ms. Default 20000. */
  timeout?: number;
  /**
   * Drop findings scoring below this (0..1). Default 0.3.
   *
   * Without a floor a loose full-text match on one shared word becomes a
   * "finding", which is how a research tool starts quietly answering questions
   * from pages that merely share vocabulary with them.
   */
  minScore?: number;
  /** 2-letter country code passed to web search. */
  country?: string;
  /** Language code passed to web search. */
  lang?: string;
}

export interface ResearchFinding {
  /** Where this passage came from. Never empty: a finding without a URL is not returned. */
  url: string;
  title: string;
  /** The relevant part of the page, not the page. */
  passage: string;
  /** 0..1. See `scoreFinding` for what goes into it. */
  score: number;
  source: ResearchSourceName;
  /** Which sub-query surfaced it. */
  subQuery: string;
  publishedDate?: string;
  /** True when the page was served from the local cache, i.e. cost nothing. */
  cached: boolean;
  chars: number;
}

/** Something we could not reach, why, and what would fix it. */
export interface ResearchGap {
  /** `read` means the URL was found but the page itself would not open. */
  source: ResearchSourceName | 'read' | 'budget';
  what: string;
  why: string;
  /** Concrete remedy, e.g. an env var to set. Absent when there is none. */
  fix?: string;
}

export interface SourceCount {
  /** URLs this source contributed, before de-duplication. */
  candidates: number;
  /** URLs that survived de-duplication and were queued for reading. */
  queued: number;
  /** Findings that ended up in the result. */
  findings: number;
}

export interface ResearchPlan {
  kind: QuestionKind;
  /** Content terms extracted from the question, stopwords removed. */
  terms: string[];
  /** Quoted phrases, kept verbatim. */
  phrases: string[];
  /** Which specialised indexes the question matched, and why. */
  indexes: { index: ResearchSourceName; because: string }[];
}

export interface ResearchBudgetReport {
  subQueries: { used: number; limit: number };
  pagesRead: { used: number; limit: number };
  chars: { used: number; limit: number };
  time: { usedMs: number; limitMs: number };
  /** Which cap stopped the run, if any did. */
  stoppedBy?: 'subQueries' | 'pages' | 'chars' | 'deadline';
}

export interface ResearchResult {
  question: string;
  /** The sub-queries actually run, in order. */
  subQueries: string[];
  plan: ResearchPlan;
  findings: ResearchFinding[];
  sourceCounts: Record<ResearchSourceName, SourceCount>;
  /** Everything that could not be reached. Empty only when nothing failed. */
  gaps: ResearchGap[];
  budget: ResearchBudgetReport;
  /** False when no source produced a single finding — not a completed run. */
  ok: boolean;
  /** True when at least one web search provider answered. */
  webSearchWorked: boolean;
  /** Distinct URLs behind the findings. */
  uniqueSources: number;
  warnings: string[];
  elapsedMs: number;
}

// --------------------------------------------------------------- planning

const STOPWORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'all', 'also', 'am', 'an', 'and', 'any', 'are', 'as', 'at',
  'be', 'because', 'been', 'being', 'between', 'both', 'but', 'by', 'can', 'could', 'did', 'do', 'does',
  'doing', 'done', 'down', 'during', 'each', 'few', 'for', 'from', 'further', 'get', 'had', 'has', 'have',
  'having', 'he', 'her', 'here', 'hers', 'him', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its',
  'just', 'me', 'more', 'most', 'much', 'my', 'no', 'nor', 'not', 'now', 'of', 'off', 'on', 'once',
  'only', 'onto', 'or', 'other', 'our', 'out', 'over', 'own', 'per', 'please', 'same', 'she', 'should',
  'since', 'so', 'some', 'such', 'tell', 'than', 'that', 'the', 'their', 'them', 'then', 'there',
  'these', 'they', 'this', 'those', 'through', 'to', 'too', 'under', 'until', 'up', 'us', 'very', 'was',
  'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'will', 'with',
  'would', 'you', 'your',
]);

/** Words that mean "this is a literature question". */
const ACADEMIC_HINTS = [
  'study', 'studies', 'research', 'paper', 'papers', 'preprint', 'arxiv', 'pubmed', 'journal',
  'peer-reviewed', 'peer reviewed', 'meta-analysis', 'meta analysis', 'randomized', 'randomised',
  'clinical trial', 'cohort', 'evidence', 'citation', 'doi', 'literature', 'biomarker', 'in vitro',
  'efficacy', 'prevalence',
];

/** Words that mean "this is a code question". */
const DEVELOPER_HINTS = [
  'api', 'sdk', 'library', 'libraries', 'npm', 'pypi', 'crate', 'package', 'github', 'repo',
  'repository', 'typescript', 'javascript', 'python', 'rust', 'golang', 'java', 'kotlin', 'swift',
  'compile', 'compiler', 'runtime', 'framework', 'cli', 'docker', 'kubernetes', 'regex', 'stacktrace',
  'stack trace', 'exception', 'segfault', 'pull request', 'open source', 'implementation', 'function',
  'class', 'typeerror', 'build error',
];

/** Words that mean "this is a US law or regulation question". */
const GOV_HINTS = [
  'regulation', 'regulations', 'statute', 'statutory', 'cfr', 'u.s.c', 'usc', 'federal register',
  'rulemaking', 'final rule', 'proposed rule', 'compliance', 'fda', 'epa', 'sec filing', 'ftc',
  'osha', 'irs', 'congress', 'legislation', 'bill', 'executive order', 'court', 'lawsuit', 'docket',
  'legal requirement', 'law', 'laws',
];

function containsAny(haystack: string, needles: string[]): string | undefined {
  for (const needle of needles) {
    // Word-boundary match so "law" does not fire on "lawn" or "flawed".
    const re = new RegExp(`(^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');
    if (re.test(haystack)) return needle;
  }
  return undefined;
}

/** Quoted phrases, kept verbatim so a plan never breaks the user's exact wording. */
function extractPhrases(question: string): string[] {
  const phrases: string[] = [];
  const re = /"([^"]{2,})"|'([^']{3,})'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(question)) !== null) {
    const phrase = (m[1] ?? m[2] ?? '').trim();
    if (phrase) phrases.push(phrase);
  }
  return phrases;
}

/** Content words, in the order the question used them. */
function extractTerms(question: string): string[] {
  const words = question
    .toLowerCase()
    .replace(/["']/g, ' ')
    .split(/[^a-z0-9+#._/-]+/)
    .map((w) => w.replace(/^[-._/]+|[-._/]+$/g, ''))
    .filter(Boolean);

  const seen = new Set<string>();
  const terms: string[] = [];
  for (const word of words) {
    if (word.length < 2) continue;
    if (STOPWORDS.has(word)) continue;
    if (seen.has(word)) continue;
    seen.add(word);
    terms.push(word);
  }
  return terms;
}

function classify(question: string): QuestionKind {
  const q = question.toLowerCase();
  if (/\bvs\.?\b|\bversus\b|\bcompared? (?:to|with)\b|\bdifference between\b|\balternatives?\b|\bbetter than\b/.test(q)) {
    return 'comparison';
  }
  if (/\bhow (?:to|do|does|can|should)\b|\bsteps? to\b|\bset ?up\b|\binstall\b|\bconfigure\b|\bimplement\b|\bfix\b/.test(q)) {
    return 'howto';
  }
  if (/^\s*(?:what|who)\s+(?:is|are|was|were)\b|\bdefinition of\b|\bmeaning of\b|\bexplain\b/.test(q)) {
    return 'definition';
  }
  if (/\blatest\b|\bcurrent(?:ly)?\b|\brecent(?:ly)?\b|\bnews\b|\bnow\b|\bthis year\b|\b20[2-9]\d\b|\bupdated?\b/.test(q)) {
    return 'temporal';
  }
  return 'factual';
}

/**
 * One sub-query per side of a comparison, each carrying the question's shared
 * context.
 *
 * "playwright vs puppeteer for web scraping in 2026" splits into two entities
 * and a tail of context words. Searching the bare entity ("playwright") would
 * return the whole topic rather than the part being compared, so each side is
 * reassembled as "<entity> <shared context>".
 */
function comparisonSubQueries(question: string): string[] {
  // `and` only splits when the question says "between X and Y"; otherwise it
  // is far more often conjunction than contrast.
  const splitter = /\bbetween\b/i.test(question)
    ? /\bvs\.?\b|\bversus\b|\bcompared? (?:to|with)\b|\band\b|,/i
    : /\bvs\.?\b|\bversus\b|\bcompared? (?:to|with)\b/i;

  const sides = question
    .split(splitter)
    .map((part) => extractTerms(part))
    .filter((terms) => terms.length > 0);
  if (sides.length < 2) return [];

  // The first one or two content words of a side name the thing; the rest is
  // context that belongs to every side.
  const entities = sides.map((terms) => terms.slice(0, 2));
  const entityWords = new Set(entities.flat());
  const context = extractTerms(question)
    .filter((t) => !entityWords.has(t) && t !== 'vs' && t !== 'versus' && t !== 'difference' && t !== 'between')
    .slice(0, 4);

  return entities.slice(0, 3).map((entity) => [...entity, ...context].join(' '));
}

/**
 * Decompose a question into sub-queries, deterministically.
 *
 * No model call: term extraction plus question-type templates. The point is
 * not cleverness, it is that the same question always produces the same plan,
 * which makes a bad plan debuggable instead of mysterious.
 */
export function planResearch(question: string, maxSubQueries = 4): ResearchPlan & { subQueries: string[] } {
  const kind = classify(question);
  const phrases = extractPhrases(question);
  const terms = extractTerms(question);
  const core = (phrases.length ? [...phrases, ...terms.slice(0, 5)] : terms.slice(0, 8)).join(' ').trim();

  const out: string[] = [];
  const push = (q: string): void => {
    const trimmed = q.trim().replace(/\s+/g, ' ');
    if (!trimmed) return;
    if (out.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) return;
    out.push(trimmed);
  };

  // The question's own keyword core always goes first: it is the one sub-query
  // we are certain is on topic.
  push(core || question.trim());

  switch (kind) {
    case 'comparison': {
      for (const side of comparisonSubQueries(question)) push(side);
      push(`${core} comparison differences`);
      break;
    }
    case 'howto':
      push(`${core} documentation`);
      push(`${core} example tutorial`);
      break;
    case 'definition':
      push(`${core} overview explained`);
      push(`${core} how it works`);
      break;
    case 'temporal':
      push(`${core} ${new Date().getUTCFullYear()}`);
      push(`${core} announcement changelog`);
      break;
    default:
      push(`${core} explained details`);
      break;
  }

  // One adversarial angle, always. The sources that say a thing works are easy
  // to find; the ones that say where it breaks are what makes a brief useful.
  push(`${core} limitations problems`);

  const indexes: ResearchPlan['indexes'] = [];
  const academic = containsAny(question, ACADEMIC_HINTS);
  if (academic) indexes.push({ index: 'papers', because: `question mentions "${academic}"` });
  const dev = containsAny(question, DEVELOPER_HINTS);
  if (dev) indexes.push({ index: 'developer', because: `question mentions "${dev}"` });
  const gov = containsAny(question, GOV_HINTS);
  if (gov) indexes.push({ index: 'gov', because: `question mentions "${gov}"` });

  return { kind, terms, phrases, indexes, subQueries: out.slice(0, Math.max(1, maxSubQueries)) };
}

// ---------------------------------------------------------------- gather

interface Candidate {
  key: string;
  url: string;
  title: string;
  /** Provider snippet or FTS excerpt. Used as the fallback passage. */
  snippet?: string;
  source: ResearchSourceName;
  subQuery: string;
  /** Pre-read priority, 0..1. */
  prior: number;
  publishedDate?: string;
}

/** Source priors: free-and-already-local first, then curated indexes, then the open web. */
const SOURCE_WEIGHT: Record<ResearchSourceName, number> = {
  corpus: 1.0,
  papers: 0.9,
  gov: 0.9,
  developer: 0.85,
  web: 0.8,
};

function dedupeKey(url: string): string {
  try {
    return normalizeUrl(url);
  } catch {
    return url;
  }
}

/**
 * Words `buildSubQueries` adds itself. They steer a web engine usefully but
 * are poison in a full-text query: OR-ing "limitations" against a local corpus
 * matches every page with a pricing table and calls it a research finding.
 */
const TEMPLATE_WORDS = new Set([
  'comparison', 'differences', 'documentation', 'example', 'tutorial', 'overview', 'explained',
  'works', 'announcement', 'changelog', 'details', 'limitations', 'problems',
]);

/**
 * FTS5 MATCH is a query language, not a string: a bare `C++` or a stray quote
 * is a syntax error that would surface as "no local results" and quietly
 * understate the corpus. Quote every term as a phrase and OR them together.
 *
 * OR is deliberate — recall first, then let the score floor do the filtering,
 * because an AND over seven terms finds nothing in a corpus of a few hundred
 * pages. The template words above are stripped so that filtering has a chance.
 */
function toFtsQuery(subQuery: string): string {
  const terms = extractTerms(subQuery)
    .filter((t) => t.length >= 3 && !TEMPLATE_WORDS.has(t))
    .slice(0, 8)
    .map((t) => `"${t.replace(/"/g, '')}"`);
  return terms.join(' OR ');
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function emptyCounts(): Record<ResearchSourceName, SourceCount> {
  const zero = (): SourceCount => ({ candidates: 0, queued: 0, findings: 0 });
  return { web: zero(), corpus: zero(), papers: zero(), developer: zero(), gov: zero() };
}

// ------------------------------------------------------------------ read

/**
 * Relevance, blended from three cheap signals:
 *   prior        — where the result ranked, and how trustworthy its source is
 *   termCoverage — how much of the sub-query the extracted passage covers
 *   matchRatio   — how much of the page BM25 considered relevant
 *
 * None of these is a semantic score and this function does not pretend
 * otherwise. It is a sort order, which is all a caller needs to read the best
 * passages first.
 */
/**
 * Coverage below this fraction of the question's distinctive terms is treated
 * as an accident rather than a match, and the score is scaled down hard.
 */
const TARGET_COVERAGE = 0.5;

function scoreFinding(prior: number, passage: string, subQuery: string, matchRatio: number | undefined): number {
  // Template words are excluded here for the same reason they are excluded
  // from the FTS query: a page that only contains "documentation" and
  // "details" has matched our boilerplate, not the user's question.
  const terms = extractTerms(subQuery).filter((t) => !TEMPLATE_WORDS.has(t));
  const lower = passage.toLowerCase();
  const covered = terms.length ? terms.filter((t) => lower.includes(t)).length / terms.length : 0;
  const ratio = matchRatio ?? 0;
  const base = 0.45 * prior + 0.35 * covered + 0.2 * Math.min(1, ratio);

  // Coverage gates the score instead of merely adding to it. Otherwise a
  // well-ranked page from a trusted source clears the relevance floor on
  // `prior` alone: asking about "zqxjkwv flooberghast quantum marmalade
  // protocol" scored a Wikipedia article 0.53 because it contains the word
  // "protocol". Matching one term out of five is not a finding.
  const coverageFactor = terms.length > 1 ? Math.min(1, covered / TARGET_COVERAGE) : 1;
  const score = base * coverageFactor;
  return Math.round(Math.min(1, Math.max(0, score)) * 100) / 100;
}

function tidy(text: string): string {
  return text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '').trim();
}

export async function deepResearch(question: string, options: ResearchOptions = {}): Promise<ResearchResult> {
  const started = Date.now();

  const maxSubQueries = Math.max(1, Math.min(options.maxSubQueries ?? 4, 10));
  const maxPages = Math.max(1, Math.min(options.maxPages ?? 12, 40));
  const maxChars = Math.max(2000, Math.min(options.maxChars ?? 40_000, 400_000));
  const deadlineMs = Math.max(5_000, Math.min(options.deadlineMs ?? 90_000, 600_000));
  const charsPerPage = Math.max(400, Math.min(options.charsPerPage ?? 3500, maxChars));
  const resultsPerQuery = Math.max(1, Math.min(options.resultsPerQuery ?? 6, 20));
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 10));
  const maxAge = options.maxAge ?? 24 * 60 * 60 * 1000;
  const timeout = options.timeout ?? 20_000;
  const minScore = Math.max(0, Math.min(options.minScore ?? 0.3, 1));

  const deadline = started + deadlineMs;
  const timeLeft = (): number => deadline - Date.now();
  const expired = (): boolean => timeLeft() <= 0;

  const gaps: ResearchGap[] = [];
  const warnings: string[] = [];
  const counts = emptyCounts();
  let stoppedBy: ResearchBudgetReport['stoppedBy'];

  const trimmed = question.trim();
  const plan = planResearch(trimmed, maxSubQueries);
  const { subQueries, ...planOnly } = plan;

  if (!trimmed) {
    return {
      question,
      subQueries: [],
      plan: planOnly,
      findings: [],
      sourceCounts: counts,
      gaps: [{ source: 'budget', what: 'nothing to research', why: 'the question was empty' }],
      budget: {
        subQueries: { used: 0, limit: maxSubQueries },
        pagesRead: { used: 0, limit: maxPages },
        chars: { used: 0, limit: maxChars },
        time: { usedMs: Date.now() - started, limitMs: deadlineMs },
      },
      ok: false,
      webSearchWorked: false,
      uniqueSources: 0,
      warnings: ['Empty question: nothing to research.'],
      elapsedMs: Date.now() - started,
    };
  }

  // Which sources are in play. By default: the web, the local corpus, and any
  // index the question actually matched — we do not call the paper APIs for a
  // question about a JavaScript bug.
  const wanted = new Set<ResearchSourceName>(
    options.sources?.length
      ? options.sources
      : (['web', 'corpus', ...plan.indexes.map((i) => i.index)] as ResearchSourceName[]),
  );

  const candidates = new Map<string, Candidate>();
  const addCandidate = (c: Candidate): void => {
    counts[c.source].candidates++;
    const existing = candidates.get(c.key);
    if (!existing) {
      candidates.set(c.key, c);
      return;
    }
    // Same URL from two sub-queries or two sources: keep the stronger prior,
    // and prefer a local-corpus provenance because reading it is free.
    if (c.prior > existing.prior) {
      candidates.set(c.key, { ...c, snippet: c.snippet ?? existing.snippet });
    } else if (!existing.snippet && c.snippet) {
      existing.snippet = c.snippet;
    }
  };

  // ---- 1. local corpus: free, instant, no network at all.
  if (wanted.has('corpus')) {
    let corpusHits = 0;
    for (const subQuery of subQueries) {
      if (expired()) break;
      const fts = toFtsQuery(subQuery);
      if (!fts) continue;
      let hits: CorpusHit[] = [];
      try {
        hits = searchCorpus(fts, { limit: resultsPerQuery });
      } catch (err) {
        gaps.push({
          source: 'corpus',
          what: 'local crawl corpus',
          why: `FTS query failed: ${message(err)}`,
        });
        break;
      }
      corpusHits += hits.length;
      hits.forEach((hit, i) => {
        addCandidate({
          key: dedupeKey(hit.url),
          url: hit.url,
          title: hit.title ?? hit.url,
          snippet: hit.snippet || undefined,
          source: 'corpus',
          subQuery,
          prior: SOURCE_WEIGHT.corpus / (1 + i * 0.2),
        });
      });
    }
    if (corpusHits === 0) {
      gaps.push({
        source: 'corpus',
        what: 'local crawl corpus',
        why: 'nothing already crawled locally matches this question',
        fix: 'run `crawl` on a relevant site first; afterwards this source answers for free',
      });
    }
  }

  // ---- 2. web search, one sub-query at a time.
  //
  // Sequential on purpose. DuckDuckGo — the zero-config end of the chain —
  // rate-limits per IP, and firing four searches at once is the reliable way
  // to get all four throttled instead of one.
  let webSearchWorked = false;
  if (wanted.has('web')) {
    const ready = providerStatuses().filter((p) => p.status.ready);
    if (ready.length === 0) {
      gaps.push({
        source: 'web',
        what: 'web search',
        why: 'no search provider is configured or reachable',
        fix: 'set OPENSCRAPE_SEARXNG_URL to a SearxNG instance (unlimited, no card), or BRAVE_SEARCH_API_KEY (metered, $5 of credit a month)',
      });
    } else {
      const failures: string[] = [];
      for (const subQuery of subQueries) {
        if (expired()) {
          stoppedBy = 'deadline';
          failures.push(`"${subQuery}" was not searched: deadline reached`);
          break;
        }
        let res: SearchResponse;
        try {
          res = await search(subQuery, {
            limit: resultsPerQuery,
            sources: ['web'],
            includeDomains: options.includeDomains,
            excludeDomains: options.excludeDomains,
            country: options.country,
            lang: options.lang,
            timeout: Math.min(timeout, Math.max(3000, timeLeft())),
          });
        } catch (err) {
          failures.push(`"${subQuery}": ${message(err)}`);
          continue;
        }
        if (res.results.length === 0) {
          const why = res.attempts
            .filter((a) => a.status !== 'ok')
            .map((a) => `${a.provider} ${a.status}${a.reason ? ` (${a.reason})` : ''}`)
            .join('; ');
          failures.push(`"${subQuery}": ${why || 'no results'}`);
          continue;
        }
        webSearchWorked = true;
        res.results.forEach((r, i) => {
          addCandidate({
            key: dedupeKey(r.url),
            url: r.url,
            title: r.title || r.url,
            snippet: r.description || undefined,
            source: 'web',
            subQuery,
            prior: SOURCE_WEIGHT.web / (1 + i * 0.12),
            publishedDate: r.publishedDate,
          });
        });
      }
      if (failures.length) {
        const throttled = failures.some((f) => /429|rate|throttl|too many/i.test(f));
        gaps.push({
          source: 'web',
          what: `web search for ${failures.length} of ${subQueries.length} sub-quer${failures.length === 1 ? 'y' : 'ies'}`,
          why: failures.join(' | '),
          fix: throttled || !webSearchWorked
            ? 'The keyless providers throttle per IP. For unthrottled search set OPENSCRAPE_SEARXNG_URL to a SearxNG instance (unlimited, no card), or BRAVE_SEARCH_API_KEY (metered, $5 of credit a month).'
            : undefined,
        });
      }
    }
  }

  // ---- 3. specialised indexes, once each on the primary sub-query.
  const primary = subQueries[0] ?? trimmed;

  if (wanted.has('papers') && !expired()) {
    try {
      const res = await searchPapers(primary, { limit: resultsPerQuery, timeout: Math.max(3000, Math.min(timeout, timeLeft())) });
      res.papers.forEach((p, i) => {
        addCandidate({
          key: dedupeKey(p.url),
          url: p.url,
          title: p.title,
          snippet: p.abstract,
          source: 'papers',
          subQuery: primary,
          prior: SOURCE_WEIGHT.papers / (1 + i * 0.15),
          publishedDate: p.date ?? (p.year ? String(p.year) : undefined),
        });
      });
      for (const s of res.sources.filter((s) => !s.ok)) {
        gaps.push({ source: 'papers', what: `paper index "${s.source}"`, why: s.note ?? 'unavailable' });
      }
      if (res.papers.length === 0) {
        gaps.push({ source: 'papers', what: 'paper index', why: 'no papers matched the primary sub-query' });
      }
    } catch (err) {
      gaps.push({ source: 'papers', what: 'paper index', why: message(err) });
    }
  }

  if (wanted.has('developer') && !expired()) {
    try {
      const res = await developerSearch(primary, { limit: resultsPerQuery, timeout: Math.max(3000, Math.min(timeout, timeLeft())) });
      res.hits.forEach((h, i) => {
        addCandidate({
          key: dedupeKey(h.url),
          url: h.url,
          title: h.title,
          snippet: h.description ?? h.snippet,
          source: 'developer',
          subQuery: primary,
          prior: SOURCE_WEIGHT.developer / (1 + i * 0.15),
          publishedDate: h.updated,
        });
      });
      for (const s of res.sources.filter((s) => !s.ok)) {
        gaps.push({
          source: 'developer',
          what: `developer index "${s.source}"`,
          why: s.note ?? 'unavailable',
          fix: res.unauthenticated ? 'set GITHUB_TOKEN to raise the GitHub rate limit' : undefined,
        });
      }
      if (res.hits.length === 0) {
        gaps.push({ source: 'developer', what: 'developer index', why: 'no repositories, issues or PRs matched' });
      }
    } catch (err) {
      gaps.push({ source: 'developer', what: 'developer index', why: message(err) });
    }
  }

  if (wanted.has('gov') && !expired()) {
    try {
      const res = await govSearch(primary, { limit: resultsPerQuery, timeout: Math.max(3000, Math.min(timeout, timeLeft())) });
      res.documents.forEach((d, i) => {
        addCandidate({
          key: dedupeKey(d.url),
          url: d.url,
          title: d.title,
          snippet: d.abstract,
          source: 'gov',
          subQuery: primary,
          prior: SOURCE_WEIGHT.gov / (1 + i * 0.15),
          publishedDate: d.date,
        });
      });
      for (const s of res.sources.filter((s) => !s.ok)) {
        gaps.push({ source: 'gov', what: `government index "${s.source}"`, why: s.note ?? 'unavailable' });
      }
      if (res.documents.length === 0) {
        gaps.push({ source: 'gov', what: 'government index', why: 'no US federal documents matched' });
      } else {
        warnings.push(res.caveat);
      }
    } catch (err) {
      gaps.push({ source: 'gov', what: 'government index', why: message(err) });
    }
  }

  // ---- 4. read. Best-prior first, hard-capped by pages, chars and the clock.
  const ranked = [...candidates.values()].sort((a, b) => b.prior - a.prior);
  const queue = ranked.slice(0, maxPages);
  const skippedForPages = ranked.length - queue.length;
  if (skippedForPages > 0) stoppedBy ??= 'pages';
  for (const c of queue) counts[c.source].queued++;

  if (expired()) stoppedBy ??= 'deadline';

  interface Read {
    candidate: Candidate;
    passage?: string;
    cached: boolean;
    matchRatio?: number;
    /** The page could not be fetched or parsed at all. */
    error?: string;
    /**
     * The page was read fine and contained nothing relevant to the sub-query.
     * That is an answer, not a failure, and it outranks any provider snippet:
     * we have seen the whole page, so we do not fall back to a one-line
     * excerpt that happens to share a word with the question.
     */
    noMatch?: boolean;
  }

  const reads: Read[] =
    queue.length === 0 || expired()
      ? queue.map((candidate) => ({ candidate, cached: false, error: expired() ? 'deadline reached before reading' : undefined }))
      : await runPool(queue, concurrency, async (candidate): Promise<Read> => {
          if (expired()) return { candidate, cached: false, error: 'deadline reached before reading' };
          try {
            const page = await scrape(candidate.url, {
              formats: ['query'],
              query: candidate.subQuery,
              maxChars: charsPerPage,
              maxAge,
              fitMarkdown: true,
              onlyMainContent: true,
              timeout: Math.max(3000, Math.min(timeout, timeLeft())),
            });
            if (!page.success) {
              return { candidate, cached: false, error: page.error ?? page.metadata.blockReason ?? 'scrape failed' };
            }
            const body = page.query || page.markdown || page.text;
            const match = page.metadata.queryMatch;
            return {
              candidate: { ...candidate, title: page.metadata.title || candidate.title },
              passage: body ? tidy(body).slice(0, charsPerPage) : undefined,
              cached: page.metadata.cached,
              matchRatio: match && match.total > 0 ? match.matched / match.total : undefined,
              noMatch: body ? undefined : true,
            };
          } catch (err) {
            return { candidate, cached: false, error: message(err) };
          }
        });

  let pagesRead = 0;
  let charsUsed = 0;
  const findings: ResearchFinding[] = [];
  const unreadable: string[] = [];
  const irrelevant: string[] = [];
  const belowFloor: string[] = [];
  const budgetSkipped: string[] = [];

  // Score first, then fill the character budget best-first, so a cap that bites
  // drops the weakest passages rather than whichever happened to come last.
  const scored = reads
    .map((read) => {
      if (read.passage) pagesRead++;
      if (read.error) unreadable.push(`${read.candidate.url} — ${read.error}`);
      if (read.noMatch) {
        pagesRead++;
        irrelevant.push(read.candidate.url);
        return undefined;
      }
      // A page we could not reach still has its provider snippet, which carries
      // a real URL and a real excerpt. That is a weaker finding, not a fake
      // one, so it goes in at a discount rather than being invented away.
      const passage = read.passage ?? (read.candidate.snippet ? tidy(read.candidate.snippet) : undefined);
      const fromSnippet = !read.passage;
      if (!passage) return undefined;
      const prior = fromSnippet ? read.candidate.prior * 0.55 : read.candidate.prior;
      return {
        read,
        passage,
        fromSnippet,
        score: scoreFinding(prior, passage, read.candidate.subQuery, read.matchRatio),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== undefined)
    .filter((x) => {
      if (x.score >= minScore) return true;
      belowFloor.push(`${x.read.candidate.url} (${x.score.toFixed(2)})`);
      return false;
    })
    .sort((a, b) => b.score - a.score);

  for (const item of scored) {
    const remaining = maxChars - charsUsed;
    if (remaining <= 200) {
      budgetSkipped.push(item.read.candidate.url);
      stoppedBy ??= 'chars';
      continue;
    }
    const passage = item.passage.length > remaining ? item.passage.slice(0, remaining).trimEnd() + '…' : item.passage;
    charsUsed += passage.length;
    counts[item.read.candidate.source].findings++;
    findings.push({
      url: item.read.candidate.url,
      title: item.read.candidate.title,
      passage,
      score: item.score,
      source: item.read.candidate.source,
      subQuery: item.read.candidate.subQuery,
      publishedDate: item.read.candidate.publishedDate,
      cached: item.read.cached,
      chars: passage.length,
    });
  }

  if (unreadable.length) {
    gaps.push({
      source: 'read',
      what: `${unreadable.length} page(s) could not be read`,
      why: unreadable.slice(0, 8).join(' | ') + (unreadable.length > 8 ? ` | …and ${unreadable.length - 8} more` : ''),
      fix: 'a site that refuses automated access has to be read by hand; nothing here tries to work around it',
    });
  }
  if (irrelevant.length) {
    gaps.push({
      source: 'read',
      what: `${irrelevant.length} page(s) were read but held nothing relevant`,
      why: `BM25 found no passage matching the sub-query in ${irrelevant.slice(0, 8).join(', ')}` +
        (irrelevant.length > 8 ? ` and ${irrelevant.length - 8} more` : ''),
    });
  }
  if (belowFloor.length) {
    gaps.push({
      source: 'read',
      what: `${belowFloor.length} passage(s) were too weak to report`,
      why: `they scored below the ${minScore} relevance floor: ${belowFloor.slice(0, 8).join(', ')}` +
        (belowFloor.length > 8 ? ` and ${belowFloor.length - 8} more` : ''),
      fix: 'lower minScore to see them, but a weak match usually means the question needs different sources',
    });
  }
  if (skippedForPages > 0) {
    gaps.push({
      source: 'budget',
      what: `${skippedForPages} candidate URL(s) were never opened`,
      why: `the page budget (${maxPages}) was reached first`,
      fix: 'raise maxPages, or narrow the question',
    });
  }
  if (budgetSkipped.length) {
    gaps.push({
      source: 'budget',
      what: `${budgetSkipped.length} passage(s) were dropped`,
      why: `the character budget (${maxChars}) was full`,
      fix: 'raise maxChars, or lower charsPerPage to fit more sources',
    });
  }
  if (expired()) stoppedBy ??= 'deadline';
  if (stoppedBy === 'deadline') {
    gaps.push({
      source: 'budget',
      what: 'the run was cut short',
      why: `the ${deadlineMs}ms deadline expired`,
      fix: 'raise deadlineMs, or lower maxSubQueries/maxPages so the run fits',
    });
  }

  const uniqueSources = new Set(findings.map((f) => dedupeKey(f.url))).size;
  const ok = findings.length > 0;
  if (!ok) {
    warnings.push(
      'No sources were reached, so this is NOT a completed research run. ' +
        'Nothing below should be treated as an answer — see the gaps for what failed and how to fix it.',
    );
  }

  log.debug('research done', {
    question: trimmed,
    subQueries: subQueries.length,
    candidates: candidates.size,
    pagesRead,
    findings: findings.length,
    chars: charsUsed,
    ms: Date.now() - started,
  });

  return {
    question: trimmed,
    subQueries,
    plan: planOnly,
    findings,
    sourceCounts: counts,
    gaps,
    budget: {
      subQueries: { used: subQueries.length, limit: maxSubQueries },
      pagesRead: { used: pagesRead, limit: maxPages },
      chars: { used: charsUsed, limit: maxChars },
      time: { usedMs: Date.now() - started, limitMs: deadlineMs },
      stoppedBy,
    },
    ok,
    webSearchWorked,
    uniqueSources,
    warnings,
    elapsedMs: Date.now() - started,
  };
}
