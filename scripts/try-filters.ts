import { scrape } from '../src/core/scrape.js';

const url = process.argv[2] ?? 'https://en.wikipedia.org/wiki/Web_scraping';

const plain = await scrape(url, { formats: ['markdown'], maxAge: 600_000 });
const fit = await scrape(url, { formats: ['markdown'], maxAge: 600_000, fitMarkdown: true });
const cited = await scrape(url, { formats: ['markdown'], maxAge: 600_000, citations: true });
const queried = await scrape(url, {
  formats: ['query'],
  maxAge: 600_000,
  query: process.argv[3] ?? 'is web scraping legal, court cases and lawsuits',
});

const show = (label: string, chars: number, base: number) => {
  const pct = base ? Math.round((1 - chars / base) * 100) : 0;
  console.log(`${label.padEnd(22)} ${String(chars).padStart(7)} chars  ${pct > 0 ? '-' + pct + '%' : ''}`);
};

const base = plain.markdown?.length ?? 0;
show('plain markdown', base, 0);
show('fitMarkdown', fit.markdown?.length ?? 0, base);
show('citations', cited.markdown?.length ?? 0, base);
show('query filter', queried.query?.length ?? 0, base);

console.log(`\npruned chars: ${fit.metadata.prunedChars}`);
console.log(`references:   ${cited.references?.length}`);
console.log(`query match:  ${JSON.stringify(queried.metadata.queryMatch)}`);
console.log(`\n--- query excerpt (first 700 chars) ---\n`);
console.log((queried.query ?? '(empty)').slice(0, 700));
