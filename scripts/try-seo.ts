/**
 * Smoke test for the per-page SEO signals.
 *
 *   npx tsx scripts/try-seo.ts [url]
 */
import { scrape } from '../src/core/scrape.js';

const url = process.argv[2] ?? 'https://en.wikipedia.org/wiki/Web_scraping';
const r = await scrape(url, { collectSeo: true, formats: ['markdown'], maxAge: 0 });
const s = r.seo;

console.log(`${url}\n[${r.metadata.statusCode} ${r.metadata.renderedWith} ${r.metadata.elapsedMs}ms]\n`);
if (!s) {
  console.log('no seo signals returned');
  process.exit(1);
}

console.log(`title        ${s.titleLength} chars · ${JSON.stringify(s.title)}`);
console.log(`description  ${s.descriptionLength} chars · ${JSON.stringify(s.description)}`);
console.log(`h1           ${s.h1.length} · ${JSON.stringify(s.h1.slice(0, 3))}`);
console.log(`h2 count     ${s.h2Count}`);
console.log(`canonical    ${s.canonical ?? '(none)'}  self=${s.canonicalIsSelf}`);
console.log(`robots       ${s.robotsMeta ?? '(none)'}  noindex=${s.noindex}`);
console.log(`lang         ${s.lang ?? '(none)'}  viewport=${s.viewport ? 'yes' : 'no'}`);
console.log(`hreflang     ${s.hreflang.length}`);
console.log(`words        ${s.wordCount}`);
console.log(`images       ${s.images.total} total · ${s.images.missingAlt} missing alt · ${s.images.emptyAlt} alt=""`);
console.log(`links        ${s.links.length} unique · ${s.internalLinks} internal · ${s.externalLinks} external · ${s.nofollowLinks} nofollow`);
console.log(`schema       ${s.structuredTypes.join(', ') || '(none)'}`);
console.log(`og           title=${s.ogTitle ? 'yes' : 'no'} desc=${s.ogDescription ? 'yes' : 'no'} image=${s.ogImage ? 'yes' : 'no'}`);
console.log(`twitter      ${s.twitterCard ?? '(none)'}`);
console.log(`simhash      ${s.simhash}`);

console.log('\nfirst 8 internal links with anchor text:');
for (const l of s.links.filter((x) => x.internal).slice(0, 8)) {
  console.log(`  ${JSON.stringify(l.anchor.slice(0, 40)).padEnd(44)} -> ${l.url.slice(0, 80)}`);
}

process.exit(0);
