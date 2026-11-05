/**
 * Adaptive crawling: stop once the question is answered.
 *
 * A page limit is a guess made before you know anything. If the answer is on
 * page 40 of a 500-page site, a limit of 500 wastes 460 fetches and a limit of
 * 20 misses it. This watches what each page actually contributes and stops
 * when more pages stop helping.
 *
 * Two independent stop conditions, because "answered" and "exhausted" are
 * different states and conflating them hides which one happened:
 *
 *   satisfied  every query term has been seen in a well-scoring passage, and
 *              the best passage clears `minScore`. The answer is in hand.
 *   plateau    `patience` pages in a row added no new term and beat no score.
 *              The site is not going to answer this; stopping saves the rest.
 *
 * The scoring deliberately reuses the same BM25 chunker the `query` format
 * uses, so "this page answers the question" means the same thing here as it
 * does when a user asks for a query-filtered scrape.
 */
import { filterByQuery, tokenize } from '../extract/filters.js';
import { log } from '../util/log.js';

export interface AdaptiveOptions {
  /** Pages without improvement before giving up. Default 6. */
  patience?: number;
  /** Best passage score needed before "satisfied" can trigger. Default 1.5. */
  minScore?: number;
  /** Never stop before this many pages, so a lucky first page cannot end it. Default 3. */
  minPages?: number;
}

export interface AdaptiveState {
  pages: number;
  /** Query terms seen so far in a scoring passage. */
  covered: string[];
  /** Query terms never seen. */
  missing: string[];
  bestScore: number;
  bestUrl?: string;
  pagesSinceGain: number;
  stopped?: { reason: 'satisfied' | 'plateau'; detail: string };
}

export class AdaptiveTracker {
  private readonly terms: string[];
  private readonly patience: number;
  private readonly minScore: number;
  private readonly minPages: number;
  private readonly covered = new Set<string>();

  private pages = 0;
  private bestScore = 0;
  private bestUrl: string | undefined;
  private pagesSinceGain = 0;
  private stopped: AdaptiveState['stopped'];

  constructor(
    private readonly query: string,
    options: AdaptiveOptions = {},
  ) {
    this.patience = options.patience ?? 6;
    this.minScore = options.minScore ?? 1.5;
    this.minPages = options.minPages ?? 3;

    // The same tokeniser (and stemmer) the query filter uses, so "term found"
    // here means exactly what it means when BM25 scores a chunk, rather than
    // being a naive word split that disagrees with the scorer.
    this.terms = [...new Set(tokenize(query))];
  }

  /** True when this tracker can do anything useful. */
  usable(): boolean {
    return this.terms.length > 0;
  }

  /**
   * Record one page's contribution.
   *
   * Called with the page's markdown. Returns true when this page improved the
   * picture, which is only used for logging — the stop decision is `done()`.
   */
  observe(url: string, markdown: string): boolean {
    if (!markdown.trim() || !this.terms.length) {
      this.pages++;
      this.pagesSinceGain++;
      return false;
    }

    this.pages++;
    const result = filterByQuery(markdown, this.query, { topK: 3 });

    let gained = false;

    // A term only counts as covered if it appears in a passage that scored,
    // not merely somewhere on the page: the word "pricing" in a nav menu is
    // not an answer about pricing.
    if (result.topScore > 0) {
      const inPassage = new Set(tokenize(result.ranked));
      for (const term of this.terms) {
        if (!this.covered.has(term) && inPassage.has(term)) {
          this.covered.add(term);
          gained = true;
        }
      }
    }

    if (result.topScore > this.bestScore) {
      this.bestScore = result.topScore;
      this.bestUrl = url;
      gained = true;
    }

    this.pagesSinceGain = gained ? 0 : this.pagesSinceGain + 1;

    if (gained) {
      log.debug('adaptive: page helped', {
        url,
        score: Number(result.topScore.toFixed(2)),
        covered: `${this.covered.size}/${this.terms.length}`,
      });
    }

    return gained;
  }

  /** The stop decision, checked by the crawl loop between batches. */
  done(): { stop: boolean; reason: string } {
    if (this.stopped) return { stop: true, reason: this.stopped.detail };
    if (!this.terms.length) return { stop: false, reason: '' };
    if (this.pages < this.minPages) return { stop: false, reason: '' };

    const allCovered = this.covered.size === this.terms.length;
    if (allCovered && this.bestScore >= this.minScore) {
      const detail =
        `answered after ${this.pages} pages: every query term found ` +
        `(${this.terms.join(', ')}), best passage scored ${this.bestScore.toFixed(2)} ` +
        `at ${this.bestUrl}`;
      this.stopped = { reason: 'satisfied', detail };
      return { stop: true, reason: detail };
    }

    if (this.pagesSinceGain >= this.patience) {
      const missing = this.terms.filter((t) => !this.covered.has(t));
      const detail =
        `stopped after ${this.pages} pages: ${this.patience} pages in a row added nothing. ` +
        (missing.length
          ? `Never found: ${missing.join(', ')}. The site may not answer this.`
          : `Best passage scored ${this.bestScore.toFixed(2)}, below the ${this.minScore} needed to call it answered.`);
      this.stopped = { reason: 'plateau', detail };
      return { stop: true, reason: detail };
    }

    return { stop: false, reason: '' };
  }

  state(): AdaptiveState {
    return {
      pages: this.pages,
      covered: [...this.covered],
      missing: this.terms.filter((t) => !this.covered.has(t)),
      bestScore: Number(this.bestScore.toFixed(2)),
      bestUrl: this.bestUrl,
      pagesSinceGain: this.pagesSinceGain,
      stopped: this.stopped,
    };
  }
}
