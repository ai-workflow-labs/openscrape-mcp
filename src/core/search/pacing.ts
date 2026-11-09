/**
 * Request pacing that survives concurrent callers.
 *
 * Every scraped search provider needs the same thing: a minimum gap between
 * requests, because hitting a free search endpoint in a tight loop is the one
 * reliable way to earn a bot wall that then sticks for minutes.
 *
 * The obvious implementation is wrong in a way that hides well:
 *
 *   let nextAllowedAt = 0;
 *   async function pace() {
 *     const wait = nextAllowedAt - Date.now();
 *     if (wait > 0) await sleep(wait);
 *     nextAllowedAt = Date.now() + GAP;
 *   }
 *
 * That paces sequential calls correctly and does nothing whatsoever for
 * concurrent ones. Three callers arriving in the same tick all read the same
 * `nextAllowedAt`, all compute a wait of zero, all push the timestamp forward,
 * and all fire together — which is precisely the situation the gap exists to
 * prevent, and precisely what an agent issuing several searches at once does.
 *
 * The fix is to serialise the *reservation*, not just the sleep: each caller
 * queues behind the previous one before claiming its slot.
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface Pacer {
  /** Resolves when the caller may make its request. */
  wait(): Promise<void>;
  /** Push every queued caller back, e.g. after seeing a bot wall. */
  penalise(ms: number): void;
  /** When the next slot opens, as an epoch ms. For tests and status output. */
  nextSlot(): number;
}

export function createPacer(minGapMs: number): Pacer {
  let nextAllowedAt = 0;
  let queue: Promise<void> = Promise.resolve();

  return {
    wait(): Promise<void> {
      const mine = queue.then(async () => {
        const delay = nextAllowedAt - Date.now();
        if (delay > 0) await sleep(delay);
        nextAllowedAt = Date.now() + minGapMs;
      });
      // A rejected link must not break the chain for everyone behind it.
      queue = mine.catch(() => undefined);
      return mine;
    },

    penalise(ms: number): void {
      nextAllowedAt = Math.max(nextAllowedAt, Date.now() + ms);
    },

    nextSlot(): number {
      return nextAllowedAt;
    },
  };
}
