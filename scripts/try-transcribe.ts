/**
 * End-to-end transcription against a file whose contents are known.
 *
 *   npx tsx scripts/try-transcribe.ts <file.wav>
 *
 * The sample used while building this was a 44.1 kHz stereo WAV of JFK's
 * "ask not what your country can do for you" line. Known content matters: a
 * transcript you cannot check is not evidence that transcription works.
 */
import { transcribeFile, availableEngines } from '../src/core/parse/audio.js';

const file = process.argv[2];
if (!file) {
  console.log('usage: npx tsx scripts/try-transcribe.ts <audio file>');
  process.exit(1);
}

const expected = process.argv[3];

console.log(`engines: ${JSON.stringify(await availableEngines())}`);
console.log(`file: ${file}\n`);

const started = Date.now();
const r = await transcribeFile(file, { model: process.env.WHISPER_MODEL });

console.log(`ok:       ${r.ok}`);
console.log(`engine:   ${r.engine ?? '-'} (${r.via ?? '-'})`);
if (r.durationMs) console.log(`audio:    ${(r.durationMs / 1000).toFixed(1)}s`);
console.log(`elapsed:  ${((Date.now() - started) / 1000).toFixed(1)}s`);

if (!r.ok) {
  console.log(`\nerror:\n${r.error}`);
  process.exit(1);
}

console.log(`chars:    ${r.text.length}`);
console.log(`\ntranscript:\n  ${r.text}`);

if (expected) {
  // Compared on words, lowercased and stripped of punctuation: a transcript is
  // correct if it says the same thing, not if it formats it the same way.
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const want = norm(expected);
  const got = new Set(norm(r.text));
  const hit = want.filter((w) => got.has(w));
  const ratio = want.length ? hit.length / want.length : 0;
  console.log(`\nexpected words matched: ${hit.length}/${want.length} (${(ratio * 100).toFixed(0)}%)`);
  const missed = want.filter((w) => !got.has(w));
  if (missed.length) console.log(`missed: ${[...new Set(missed)].join(', ')}`);
  process.exit(ratio >= 0.8 ? 0 : 1);
}

process.exit(0);
