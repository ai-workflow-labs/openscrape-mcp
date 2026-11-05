/**
 * Manual smoke test for the research orchestrator.
 *
 *   npx tsx scripts/try-research.ts "how does firecrawl price its credits"
 *   npx tsx scripts/try-research.ts "playwright vs puppeteer for scraping" --pages 6
 *   npx tsx scripts/try-research.ts "firecrawl pricing credits" --sources corpus
 *
 * The third form is the interesting one: `--sources corpus` researches
 * entirely from pages already crawled locally, with no web search at all.
 *
 * Flags: --sub N  --pages N  --chars N  --deadline MS  --per-page N
 *        --sources a,b  --min-score N  --full
 */
import { deepResearch, planResearch } from '../src/core/agent/research.js';
import type { ResearchOptions, ResearchSourceName } from '../src/core/agent/research.js';

const argv = process.argv.slice(2);
const positional: string[] = [];
const flags = new Map<string, string>();

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg.startsWith('--')) {
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      flags.set(name, next);
      i++;
    } else {
      flags.set(name, 'true');
    }
  } else {
    positional.push(arg);
  }
}

const question = positional.join(' ') || 'how does firecrawl price its credits';
const num = (name: string): number | undefined => {
  const raw = flags.get(name);
  return raw === undefined ? undefined : Number(raw);
};

const options: ResearchOptions = {
  maxSubQueries: num('sub'),
  maxPages: num('pages'),
  maxChars: num('chars'),
  deadlineMs: num('deadline'),
  charsPerPage: num('per-page'),
  minScore: num('min-score'),
  sources: flags.get('sources')?.split(',').map((s) => s.trim()) as ResearchSourceName[] | undefined,
};

const plan = planResearch(question, options.maxSubQueries ?? 4);
console.log(`question:  ${question}`);
console.log(`kind:      ${plan.kind}`);
console.log(`terms:     ${plan.terms.join(', ')}`);
console.log(`indexes:   ${plan.indexes.map((i) => `${i.index} (${i.because})`).join(', ') || '(none matched)'}`);
console.log(`plan:      ${plan.subQueries.map((q, i) => `\n  ${i + 1}. ${q}`).join('')}`);
console.log();

const res = await deepResearch(question, options);

console.log('--- budget ---------------------------------------------------');
console.log(`sub-queries: ${res.budget.subQueries.used}/${res.budget.subQueries.limit}`);
console.log(`pages read:  ${res.budget.pagesRead.used}/${res.budget.pagesRead.limit}`);
console.log(`characters:  ${res.budget.chars.used}/${res.budget.chars.limit}`);
console.log(`wall clock:  ${res.budget.time.usedMs}ms/${res.budget.time.limitMs}ms`);
console.log(`stopped by:  ${res.budget.stoppedBy ?? '(within every budget)'}`);
console.log(`web search:  ${res.webSearchWorked ? 'answered' : 'UNAVAILABLE'}`);
console.log();

console.log('--- per-source (findings/queued/candidates) ------------------');
for (const [name, c] of Object.entries(res.sourceCounts)) {
  if (c.candidates === 0 && c.findings === 0) continue;
  console.log(`  ${name.padEnd(10)} ${c.findings}/${c.queued}/${c.candidates}`);
}
console.log();

console.log(`--- findings (${res.findings.length}, ${res.uniqueSources} unique URL(s)) -----------------`);
res.findings.forEach((f, i) => {
  console.log(`\n${i + 1}. [${f.score.toFixed(2)}] ${f.title}`);
  console.log(`   ${f.url}`);
  console.log(`   source=${f.source} sub="${f.subQuery}" chars=${f.chars}${f.cached ? ' cached' : ''}`);
  const body = f.passage.replace(/\s+/g, ' ');
  console.log(`   ${flags.has('full') ? f.passage : body.slice(0, 260) + (body.length > 260 ? '…' : '')}`);
});
console.log();

console.log(`--- not reached (${res.gaps.length}) ---------------------------------------`);
for (const g of res.gaps) {
  console.log(`  [${g.source}] ${g.what}`);
  console.log(`      why: ${g.why}`);
  if (g.fix) console.log(`      fix: ${g.fix}`);
}
for (const w of res.warnings) console.log(`\n  ⚠ ${w}`);

console.log();
if (!res.ok) {
  console.error('NOT a completed research run: zero findings. The gaps above are the honest answer.');
  process.exitCode = 1;
} else {
  console.log(`OK — ${res.findings.length} finding(s) from ${res.uniqueSources} source(s) in ${res.elapsedMs}ms.`);
}
