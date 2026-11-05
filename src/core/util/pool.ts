import { availableParallelism, freemem, totalmem } from 'node:os';
import { log } from './log.js';

/** Runs `worker` over `items` with at most `concurrency` in flight. */
export async function runPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const width = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: width }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

/** A sensible default: busy enough to saturate a link, gentle enough to stay responsive. */
export function defaultConcurrency(): number {
  const cpus = availableParallelism();
  return Math.max(2, Math.min(12, cpus * 2));
}

/**
 * Memory-adaptive throttle, borrowed from crawl4ai's dispatcher idea.
 *
 * A browser-backed crawl can exhaust RAM long before it exhausts bandwidth, and
 * when that happens the whole machine suffers rather than just the crawl. This
 * reports how many workers should currently be active so a long crawl can give
 * memory back under pressure instead of being killed.
 */
export class AdaptiveLimiter {
  private current: number;
  private lastCheck = 0;
  private readonly min: number;
  private readonly max: number;

  constructor(max = defaultConcurrency(), min = 1) {
    this.max = Math.max(1, max);
    this.min = Math.max(1, Math.min(min, this.max));
    this.current = this.max;
  }

  /** Current worker budget, re-evaluated at most once a second. */
  limit(): number {
    const now = Date.now();
    if (now - this.lastCheck < 1000) return this.current;
    this.lastCheck = now;

    const freeRatio = freemem() / Math.max(totalmem(), 1);
    const heap = process.memoryUsage().heapUsed / 1_048_576;

    let next = this.current;
    if (freeRatio < 0.12 || heap > 2048) next = Math.max(this.min, Math.floor(this.current / 2));
    else if (freeRatio < 0.2 || heap > 1024) next = Math.max(this.min, this.current - 1);
    else if (this.current < this.max) next = this.current + 1;

    if (next !== this.current) {
      log.debug('concurrency adjusted', {
        from: this.current,
        to: next,
        freeRatio: freeRatio.toFixed(2),
        heapMb: Math.round(heap),
      });
      this.current = next;
    }
    return this.current;
  }
}

/** Per-host politeness: never hit one origin harder than `perHost` at a time. */
export class HostGate {
  private active = new Map<string, number>();
  private nextFree = new Map<string, number>();

  constructor(
    private readonly perHost = 3,
    private readonly delayMs = 0,
  ) {}

  canStart(host: string, delayOverrideMs?: number): boolean {
    if ((this.active.get(host) ?? 0) >= this.perHost) return false;
    const gap = delayOverrideMs ?? this.delayMs;
    if (gap > 0 && Date.now() < (this.nextFree.get(host) ?? 0)) return false;
    return true;
  }

  start(host: string, delayOverrideMs?: number): void {
    this.active.set(host, (this.active.get(host) ?? 0) + 1);
    const gap = delayOverrideMs ?? this.delayMs;
    if (gap > 0) this.nextFree.set(host, Date.now() + gap);
  }

  finish(host: string): void {
    const n = (this.active.get(host) ?? 1) - 1;
    if (n <= 0) this.active.delete(host);
    else this.active.set(host, n);
  }
}
