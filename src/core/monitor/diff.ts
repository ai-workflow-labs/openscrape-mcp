import { createHash } from 'node:crypto';
import { diffLines, type ChangeObject } from 'diff';

/**
 * Content diffing for page monitoring.
 *
 * The expensive thing about change detection is not the comparison, it is the
 * output: returning a whole page on every check burns thousands of tokens to
 * say "the price moved". So a diff here is three bounded things — a count, a
 * one-line characterisation in plain English, and a few hunks of changed lines
 * with minimal context. Everything is capped, and truncation is reported
 * rather than hidden.
 */

export interface DiffOptions {
  /** Hard cap on the rendered diff. Default 2000. */
  maxDiffChars?: number;
  /** Unchanged lines to keep either side of a change. Default 1. */
  context?: number;
  /** Maximum hunks to render. Default 24. */
  maxHunks?: number;
}

export interface ContentDiff {
  changed: boolean;
  addedLines: number;
  removedLines: number;
  /** "+12 / -3 lines" */
  summary: string;
  /** Plain-English guess at what actually changed. */
  characterization: string;
  /** Rendered hunks: ` ctx`, `-old`, `+new`. Empty when nothing changed. */
  diff: string;
  truncated: boolean;
  /** Characters of diff dropped by the cap. */
  truncatedChars: number;
}

export const NO_CHANGE: ContentDiff = {
  changed: false,
  addedLines: 0,
  removedLines: 0,
  summary: 'no change',
  characterization: 'no change',
  diff: '',
  truncated: false,
  truncatedChars: 0,
};

/**
 * Canonical form used for both hashing and diffing. Trailing spaces and blank
 * runs change on nearly every dynamic page render, and treating them as
 * content would report a change on every single check.
 */
export function normalizeContent(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function hashContent(text: string): string {
  return createHash('sha256').update(normalizeContent(text)).digest('hex');
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

type RowKind = ' ' | '+' | '-';

interface Row {
  kind: RowKind;
  text: string;
  /** Line number in the new content (removed rows carry the line they sat at). */
  line: number;
}

function splitLines(value: string): string[] {
  const parts = value.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function toRows(parts: ChangeObject<string>[]): Row[] {
  const rows: Row[] = [];
  let line = 0;
  for (const part of parts) {
    for (const text of splitLines(part.value)) {
      if (part.added) {
        line++;
        rows.push({ kind: '+', text, line });
      } else if (part.removed) {
        rows.push({ kind: '-', text, line: line + 1 });
      } else {
        line++;
        rows.push({ kind: ' ', text, line });
      }
    }
  }
  return rows;
}

function clip(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

function renderHunks(rows: Row[], context: number, maxHunks: number): string[] {
  const keep = new Array<boolean>(rows.length).fill(false);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!.kind === ' ') continue;
    for (let j = Math.max(0, i - context); j <= Math.min(rows.length - 1, i + context); j++) {
      keep[j] = true;
    }
  }

  const hunks: string[] = [];
  let i = 0;
  while (i < rows.length && hunks.length < maxHunks) {
    if (!keep[i]) {
      i++;
      continue;
    }
    const start = i;
    while (i < rows.length && keep[i]) i++;
    const slice = rows.slice(start, i);
    const head = `@@ line ${slice[0]!.line} @@`;
    hunks.push([head, ...slice.map((r) => `${r.kind}${clip(r.text, 200)}`)].join('\n'));
  }
  return hunks;
}

/* ------------------------------------------------------------------ */
/* Characterisation                                                    */
/* ------------------------------------------------------------------ */

const NUMBER_RE = /(?:[$€£¥₹]\s?)?\d[\d,]*(?:\.\d+)?\s?%?/g;
const MONTHS = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i;

function labelFor(token: string): string {
  if (/^[$€£¥₹]/.test(token.trim())) return 'price';
  if (/%\s*$/.test(token)) return 'percentage';
  if (/^\d{4}-\d{2}-\d{2}/.test(token)) return 'date';
  return 'number';
}

function words(line: string): string[] {
  return line.toLowerCase().split(/[^a-z0-9$€£¥₹%.-]+/i).filter(Boolean);
}

/** Rough overlap, used only to decide whether two lines are the "same" line edited. */
function similarity(a: string, b: string): number {
  const wa = new Set(words(a));
  const wb = new Set(words(b));
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.max(wa.size, wb.size);
}

/** Describes one edited line, e.g. `price changed from $99 to $89`. */
function describePair(before: string, after: string): string | null {
  const beforeNums = before.match(NUMBER_RE) ?? [];
  const afterNums = after.match(NUMBER_RE) ?? [];

  for (let i = 0; i < Math.min(beforeNums.length, afterNums.length); i++) {
    const b = beforeNums[i]!.trim();
    const a = afterNums[i]!.trim();
    if (b !== a) {
      const label =
        /\b(date|updated|published|expires)\b/i.test(before) || MONTHS.test(before)
          ? 'date'
          : labelFor(b);
      return `${label} changed from ${b} to ${a}`;
    }
  }

  if (beforeNums.length !== afterNums.length && (beforeNums.length || afterNums.length)) {
    return `numbers changed (${beforeNums.length} to ${afterNums.length}) on "${clip(after, 48)}"`;
  }

  // Report the words that actually differ, not the head of the line: on a long
  // line the edit is usually nowhere near the start.
  const bw = before.trim().split(/\s+/);
  const aw = after.trim().split(/\s+/);
  let head = 0;
  while (head < bw.length && head < aw.length && bw[head] === aw[head]) head++;
  let tail = 0;
  while (
    tail < bw.length - head &&
    tail < aw.length - head &&
    bw[bw.length - 1 - tail] === aw[aw.length - 1 - tail]
  ) {
    tail++;
  }

  const bMid = clip(bw.slice(head, bw.length - tail).join(' '), 48);
  const aMid = clip(aw.slice(head, aw.length - tail).join(' '), 48);
  if (!bMid && !aMid) return null;
  if (!bMid) return `text added: "${aMid}"`;
  if (!aMid) return `text removed: "${bMid}"`;
  return `text changed from "${bMid}" to "${aMid}"`;
}

/**
 * Turns the raw change list into one short sentence. Deliberately heuristic:
 * it never calls a model, so it reports shape (a number moved, a line was
 * added) and stays concrete rather than guessing at meaning.
 */
export function characterize(parts: ChangeObject<string>[]): string {
  const notes: string[] = [];
  let addedOnly = 0;
  let removedOnly = 0;
  let firstAdded = '';
  let firstRemoved = '';

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (!part.removed) continue;
    const next = parts[i + 1];

    const removedLines = splitLines(part.value);
    const addedLines = next?.added ? splitLines(next.value) : [];
    if (next?.added) i++; // consume the paired addition

    const paired = Math.min(removedLines.length, addedLines.length);
    for (let k = 0; k < paired; k++) {
      const before = removedLines[k]!;
      const after = addedLines[k]!;
      if (!before.trim() && !after.trim()) continue;
      if (similarity(before, after) < 0.34) {
        // Not the same line edited: count as a separate removal plus addition.
        removedOnly++;
        addedOnly++;
        if (!firstRemoved) firstRemoved = before;
        if (!firstAdded) firstAdded = after;
        continue;
      }
      if (notes.length < 3) {
        const note = describePair(before, after);
        if (note) notes.push(note);
      }
    }

    for (let k = paired; k < removedLines.length; k++) {
      if (!removedLines[k]!.trim()) continue;
      removedOnly++;
      if (!firstRemoved) firstRemoved = removedLines[k]!;
    }
    for (let k = paired; k < addedLines.length; k++) {
      if (!addedLines[k]!.trim()) continue;
      addedOnly++;
      if (!firstAdded) firstAdded = addedLines[k]!;
    }
  }

  // Additions with no adjacent removal were not visited above.
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (!part.added) continue;
    if (parts[i - 1]?.removed) continue;
    for (const line of splitLines(part.value)) {
      if (!line.trim()) continue;
      addedOnly++;
      if (!firstAdded) firstAdded = line;
    }
  }

  if (notes.length < 3) {
    if (addedOnly && !removedOnly) {
      notes.push(
        `${addedOnly} line${addedOnly === 1 ? '' : 's'} added, starting "${clip(firstAdded, 60)}"`,
      );
    } else if (removedOnly && !addedOnly) {
      notes.push(
        `${removedOnly} line${removedOnly === 1 ? '' : 's'} removed, starting "${clip(firstRemoved, 60)}"`,
      );
    } else if (addedOnly || removedOnly) {
      notes.push(`${addedOnly} line${addedOnly === 1 ? '' : 's'} added and ${removedOnly} removed`);
    }
  }

  return notes.length ? notes.join('; ') : 'content changed';
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export function diffContent(
  previous: string,
  current: string,
  options: DiffOptions = {},
): ContentDiff {
  const maxDiffChars = Math.max(0, options.maxDiffChars ?? 2000);
  const context = Math.max(0, options.context ?? 1);
  const maxHunks = Math.max(1, options.maxHunks ?? 24);

  const before = normalizeContent(previous);
  const after = normalizeContent(current);
  if (before === after) return { ...NO_CHANGE };

  const parts = diffLines(before, after);
  const rows = toRows(parts);
  const addedLines = rows.filter((r) => r.kind === '+').length;
  const removedLines = rows.filter((r) => r.kind === '-').length;

  const hunks = renderHunks(rows, context, maxHunks);
  const full = hunks.join('\n\n');

  let diff = full;
  let truncated = false;
  let truncatedChars = 0;
  if (maxDiffChars === 0) {
    diff = '';
    truncated = full.length > 0;
    truncatedChars = full.length;
  } else if (full.length > maxDiffChars) {
    diff = full.slice(0, maxDiffChars).replace(/\n[^\n]*$/, '');
    truncated = true;
    truncatedChars = full.length - diff.length;
  }

  return {
    changed: true,
    addedLines,
    removedLines,
    summary: `+${addedLines} / -${removedLines} lines`,
    characterization: characterize(parts),
    diff,
    truncated,
    truncatedChars,
  };
}
