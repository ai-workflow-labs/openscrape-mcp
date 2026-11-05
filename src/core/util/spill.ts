import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SPILL_DIR, ensureDataDirs } from './paths.js';
import { log } from './log.js';

export interface SpillResult {
  text: string;
  spilledTo?: string;
  truncatedChars?: number;
}

/**
 * Token discipline. A single long page can swallow tens of thousands of tokens
 * of model context, which is the real cost of scraping inside an assistant.
 * When content exceeds maxChars we return the head plus a pointer to the full
 * text on disk, so nothing is lost but the context stays small.
 */
export function spillIfLarge(
  text: string,
  maxChars: number | undefined,
  label: string,
): SpillResult {
  if (!maxChars || maxChars <= 0 || text.length <= maxChars) return { text };

  let path: string | undefined;
  try {
    ensureDataDirs();
    const hash = createHash('sha1').update(label).update(text).digest('hex').slice(0, 16);
    const slug = label.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60) || 'page';
    path = join(SPILL_DIR, `${slug}-${hash}.md`);
    writeFileSync(path, text, 'utf8');
  } catch (err) {
    log.warn('spill write failed', String(err));
  }

  // Cut on a paragraph boundary when one is close by, so the text reads cleanly.
  let cut = maxChars;
  const window = text.slice(Math.max(0, maxChars - 500), maxChars);
  const breakAt = window.lastIndexOf('\n\n');
  if (breakAt > 0) cut = Math.max(0, maxChars - 500) + breakAt;

  const head = text.slice(0, cut).trimEnd();
  const removed = text.length - cut;
  const notice = path
    ? `\n\n---\n_[truncated: ${removed.toLocaleString()} more characters. Full text saved to \`${path}\` — read that file if you need the rest.]_`
    : `\n\n---\n_[truncated: ${removed.toLocaleString()} more characters.]_`;

  return { text: head + notice, spilledTo: path, truncatedChars: removed };
}
