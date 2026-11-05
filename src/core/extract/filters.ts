/**
 * Content filters that shrink a page before it ever reaches a model.
 *
 * The idea is borrowed from crawl4ai's "fit markdown": once a page is markdown,
 * most of what remains is still navigation residue, cookie notices and link
 * soup. Pruning it, or keeping only the parts that match a query, is the
 * cheapest token saving available — no LLM involved.
 */

const BOILERPLATE_PHRASES = [
  'accept all cookies',
  'we use cookies',
  'cookie policy',
  'privacy policy',
  'terms of service',
  'all rights reserved',
  'subscribe to our newsletter',
  'sign up for our newsletter',
  'follow us on',
  'share this article',
  'skip to content',
  'skip to main content',
  'enable javascript',
  'your browser is out of date',
  'advertisement',
  'back to top',
  'read more articles',
  'related articles',
  'you might also like',
];

export interface Block {
  text: string;
  kind: 'heading' | 'code' | 'list' | 'table' | 'quote' | 'paragraph';
  words: number;
  linkDensity: number;
}

/** Splits markdown into logical blocks, keeping fenced code intact. */
export function splitBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.split('\n');
  let buffer: string[] = [];
  let inFence = false;

  const flush = () => {
    const text = buffer.join('\n').trim();
    buffer = [];
    if (text) blocks.push(describe(text));
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (inFence) {
        buffer.push(line);
        inFence = false;
        flush();
        continue;
      }
      flush();
      inFence = true;
      buffer.push(line);
      continue;
    }
    if (inFence) {
      buffer.push(line);
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    buffer.push(line);
  }
  flush();
  return blocks;
}

function describe(text: string): Block {
  const kind: Block['kind'] = /^\s*```/.test(text)
    ? 'code'
    : /^#{1,6}\s/.test(text)
      ? 'heading'
      : /^\s*\|/.test(text)
        ? 'table'
        : /^\s*>/.test(text)
          ? 'quote'
          : /^\s*([-*+]|\d+\.)\s/m.test(text)
            ? 'list'
            : 'paragraph';

  const linkChars = [...text.matchAll(/\[([^\]]*)\]\([^)]*\)/g)].reduce(
    (sum, m) => sum + m[0].length,
    0,
  );
  const words = (text.match(/\S+/g) ?? []).length;
  return { text, kind, words, linkDensity: linkChars / Math.max(text.length, 1) };
}

export interface PruneOptions {
  /** Blocks shorter than this many words are suspect. Default 6. */
  minWords?: number;
  /** Above this share of link characters a block is treated as navigation. Default 0.55. */
  maxLinkDensity?: number;
  /** Drop blocks containing known boilerplate phrases. Default true. */
  dropBoilerplate?: boolean;
}

export interface PruneReport {
  markdown: string;
  removedBlocks: number;
  removedChars: number;
}

/** "Fit markdown": drops navigation residue and boilerplate, keeps real content. */
export function pruneMarkdown(markdown: string, opts: PruneOptions = {}): PruneReport {
  const minWords = opts.minWords ?? 6;
  const maxLinkDensity = opts.maxLinkDensity ?? 0.55;
  const dropBoilerplate = opts.dropBoilerplate !== false;

  const blocks = splitBlocks(markdown);
  const kept: string[] = [];
  let removedBlocks = 0;
  let removedChars = 0;

  for (const block of blocks) {
    // Structure is cheap and valuable: always keep it.
    if (block.kind === 'heading' || block.kind === 'code' || block.kind === 'table') {
      kept.push(block.text);
      continue;
    }

    const lower = block.text.toLowerCase();
    const isBoilerplate =
      dropBoilerplate && BOILERPLATE_PHRASES.some((phrase) => lower.includes(phrase));

    const isLinkSoup = block.linkDensity > maxLinkDensity && block.words < 40;
    const isStub = block.words < minWords && block.kind !== 'list';

    if (isBoilerplate || isLinkSoup || isStub) {
      removedBlocks++;
      removedChars += block.text.length;
      continue;
    }
    kept.push(block.text);
  }

  return { markdown: kept.join('\n\n').trim(), removedBlocks, removedChars };
}

/* ------------------------------------------------------------------ */
/* BM25 query filter                                                   */
/* ------------------------------------------------------------------ */

const STOPWORDS = new Set(
  'a an and are as at be been but by for from has have how in into is it its of on or that the this to was were what when where which who why will with you your'.split(
    ' ',
  ),
);

/**
 * Light suffix stripping. Without it "plan" misses "plans" and "cost" misses
 * "costs", which is exactly the kind of near-miss that makes a retrieval
 * filter return the wrong paragraph.
 */
function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 5 && /(ses|xes|zes|ches|shes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed') && !w.endsWith('eed')) w = w.slice(0, -2);
  if (w.length > 4 && w.endsWith('ly')) w = w.slice(0, -2);
  return w;
}

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? [])
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

export interface QueryFilterOptions {
  /** How many of the best-matching chunks to keep. Default 10. */
  topK?: number;
  /** Rough chunk size in characters. Blocks are never split. Default 500. */
  targetChars?: number;
  /** Keep chunks scoring at least this fraction of the best score. Default 0.35. */
  minScoreRatio?: number;
}

export interface QueryFilterResult {
  /** Matching chunks in the page's own reading order. */
  markdown: string;
  /** The same chunks, best match first. Better when answering a question. */
  ranked: string;
  matchedChunks: number;
  totalChunks: number;
  topScore: number;
}

/**
 * Groups blocks into chunks of roughly `targetChars`, but never splits a block.
 * Fixed "N blocks per chunk" windows score badly on real pages, where one
 * block can be a 4,000-character table and the next a six-word heading.
 */
function buildChunks(blocks: Block[], targetChars: number): { text: string; index: number }[] {
  const chunks: { text: string; index: number }[] = [];
  let current: string[] = [];
  let currentChars = 0;
  let startIndex = 0;

  const flush = () => {
    if (current.length === 0) return;
    chunks.push({ text: current.join('\n\n'), index: startIndex });
    current = [];
    currentChars = 0;
  };

  blocks.forEach((block, i) => {
    if (current.length === 0) startIndex = i;
    // A block bigger than the target stands alone.
    if (block.text.length >= targetChars) {
      flush();
      chunks.push({ text: block.text, index: i });
      startIndex = i + 1;
      return;
    }
    current.push(block.text);
    currentChars += block.text.length;
    if (currentChars >= targetChars) flush();
  });
  flush();
  return chunks;
}

/**
 * Largest share of distinct query terms found inside any 24-token window.
 * Returns 0..1.
 */
function bestWindowCoverage(doc: string[], queryTerms: string[]): number {
  if (doc.length === 0 || queryTerms.length === 0) return 0;
  const wanted = new Set(queryTerms);
  const width = 24;
  let best = 0;

  for (let start = 0; start < doc.length; start += 8) {
    const window = doc.slice(start, start + width);
    const found = new Set<string>();
    for (const token of window) if (wanted.has(token)) found.add(token);
    best = Math.max(best, found.size);
    if (best === wanted.size) break;
  }
  return best / wanted.size;
}

/**
 * Okapi BM25 over the page's own chunks. Answers "show me only the parts of
 * this page that are about X" without a model call.
 */
export function filterByQuery(
  markdown: string,
  query: string,
  opts: QueryFilterOptions = {},
): QueryFilterResult {
  const topK = opts.topK ?? 10;
  const minScoreRatio = opts.minScoreRatio ?? 0.35;
  const targetChars = opts.targetChars ?? 500;

  const blocks = splitBlocks(markdown);
  if (blocks.length === 0) {
    return { markdown: '', ranked: '', matchedChunks: 0, totalChunks: 0, topScore: 0 };
  }

  const chunks = buildChunks(blocks, targetChars);
  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0) {
    return {
      markdown,
      ranked: markdown,
      matchedChunks: chunks.length,
      totalChunks: chunks.length,
      topScore: 0,
    };
  }

  const docs = chunks.map((c) => tokenize(c.text));
  const avgLen = docs.reduce((sum, d) => sum + d.length, 0) / Math.max(docs.length, 1);
  const N = docs.length;

  const docFreq = new Map<string, number>();
  for (const term of queryTerms) {
    let n = 0;
    for (const doc of docs) if (doc.includes(term)) n++;
    docFreq.set(term, n);
  }

  const k1 = 1.5;
  const b = 0.75;

  const scored = chunks.map((chunk, i) => {
    const doc = docs[i];
    const counts = new Map<string, number>();
    for (const t of doc) counts.set(t, (counts.get(t) ?? 0) + 1);

    let score = 0;
    let hits = 0;
    for (const term of queryTerms) {
      const tf = counts.get(term) ?? 0;
      if (tf === 0) continue;
      hits++;
      const n = docFreq.get(term) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      const norm = tf * (k1 + 1);
      const denom = tf + k1 * (1 - b + (b * doc.length) / Math.max(avgLen, 1));
      score += idf * (norm / denom);
    }
    // Covering more of the question beats hammering one term.
    const coverage = hits / queryTerms.length;
    // Terms that appear close together usually mean the chunk is about the
    // question, not merely sharing vocabulary with it.
    const proximity = bestWindowCoverage(doc, queryTerms);
    return { ...chunk, score: score * (0.5 + 0.5 * coverage) * (1 + 0.6 * proximity) };
  });

  const topScore = Math.max(...scored.map((s) => s.score), 0);
  if (topScore <= 0) {
    return { markdown: '', ranked: '', matchedChunks: 0, totalChunks: N, topScore: 0 };
  }

  const byRelevance = scored
    .filter((s) => s.score >= topScore * minScoreRatio)
    .sort((a, b2) => b2.score - a.score)
    .slice(0, topK);

  const dedupe = (list: typeof byRelevance): string => {
    const seen = new Set<string>();
    const parts: string[] = [];
    for (const chunk of list) {
      for (const block of chunk.text.split('\n\n')) {
        const key = block.trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        parts.push(key);
      }
    }
    return parts.join('\n\n').trim();
  };

  const inDocOrder = [...byRelevance].sort((a, b2) => a.index - b2.index);

  return {
    markdown: dedupe(inDocOrder),
    ranked: dedupe(byRelevance),
    matchedChunks: byRelevance.length,
    totalChunks: N,
    topScore,
  };
}

/* ------------------------------------------------------------------ */
/* Citations                                                           */
/* ------------------------------------------------------------------ */

export interface CitationResult {
  markdown: string;
  references: string[];
}

/**
 * Converts inline links into numbered citations plus a reference list.
 * On a link-heavy page this alone cuts the markdown size substantially, since
 * every URL is written once instead of once per mention.
 */
export function withCitations(markdown: string): CitationResult {
  const order: string[] = [];
  const indexOf = new Map<string, number>();

  const replaced = markdown.replace(
    /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (_match, label: string, url: string) => {
      let n = indexOf.get(url);
      if (n === undefined) {
        order.push(url);
        n = order.length;
        indexOf.set(url, n);
      }
      const text = label.trim();
      return text ? `${text} [${n}]` : `[${n}]`;
    },
  );

  if (order.length === 0) return { markdown, references: [] };

  const references = order.map((url, i) => `[${i + 1}] ${url}`);
  return {
    markdown: `${replaced.trim()}\n\n## References\n\n${references.join('\n')}`,
    references,
  };
}
