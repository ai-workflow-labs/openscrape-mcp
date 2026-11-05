/**
 * Live proof for the schema / pattern / generator / llms.txt / OCR work.
 *
 *   npx tsx scripts/try-extract.ts            # everything
 *   npx tsx scripts/try-extract.ts schema     # one section
 *
 * Sections: tools, schema, xpath, patterns, generate, llmstxt, ocr
 */
import { writeFileSync, mkdtempSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scrape } from '../src/core/scrape.js';
import { fetchPage } from '../src/core/fetcher/index.js';
import { parseDocument } from '../src/core/parse/documents.js';
import {
  extractPatterns,
  extractWithSchema,
  generateSchema,
  type ExtractionSchema,
} from '../src/core/extract/schema.js';
import { generateLlmsTxt } from '../src/core/llmstxt.js';
import { ocrAvailable, ocrImage } from '../src/core/extract/ocr.js';

const only = process.argv.slice(2);
const want = (name: string) => only.length === 0 || only.includes(name);

const CACHE = 1_800_000;

function rule(title: string): void {
  console.log('\n' + '='.repeat(74));
  console.log(title);
  console.log('='.repeat(74));
}

async function html(url: string, onlyMain = false): Promise<{ html: string; url: string }> {
  const page = await scrape(url, { formats: ['rawHtml'], onlyMainContent: onlyMain, maxAge: CACHE });
  if (!page.success || !page.rawHtml) throw new Error(`fetch failed: ${page.error ?? page.metadata.statusCode}`);
  return { html: page.rawHtml, url: page.metadata.url };
}

function report(result: ReturnType<typeof extractWithSchema>, show = 4): void {
  console.log(
    `engine=${result.engine} base=${result.baseSelector} baseMatches=${result.baseMatches} ` +
      `records=${result.records.length} ${result.elapsedMs}ms`,
  );
  for (const s of result.fieldStats) {
    console.log(
      `  field ${s.name.padEnd(12)} ${String(s.type).padEnd(10)} ${s.hits} hit / ${s.misses} miss   ${s.selector}`,
    );
  }
  for (const d of result.diagnostics) console.log(`  ! ${d}`);
  console.log(JSON.stringify(result.records.slice(0, show), null, 1));
}

/* ---------------------------------------------------------- 0. Tool wiring */

if (want('tools')) {
  rule('0. registerExtractTools — the tools this module adds');
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { registerExtractTools } = await import('../src/mcp/tools/extract.js');
  const server = new McpServer({ name: 'extract-check', version: '0.0.1' });
  registerExtractTools(server);
  // Reach into the registry the way a client's tools/list would.
  const registered = (server as unknown as { _registeredTools: Record<string, { title?: string }> })
    ._registeredTools;
  for (const [name, tool] of Object.entries(registered)) {
    console.log(`  ${name.padEnd(18)} ${tool.title ?? ''}`);
  }
}

/* ------------------------------------------------------------------ 1. CSS */

if (want('schema')) {
  rule('1. Hand-written CSS schema — books.toscrape.com product cards');
  const page = await html('https://books.toscrape.com/');
  const schema: ExtractionSchema = {
    name: 'books listing',
    baseSelector: 'article.product_pod',
    fields: [
      { name: 'title', selector: 'h3 a', type: 'attribute', attribute: 'title' },
      { name: 'price', selector: '.price_color', type: 'regex', pattern: '[0-9.,]+' },
      { name: 'priceValue', selector: '.price_color', type: 'number' },
      { name: 'url', selector: 'h3 a', type: 'attribute', attribute: 'href' },
      { name: 'thumb', selector: 'img.thumbnail', type: 'attribute', attribute: 'src' },
      { name: 'stock', selector: '.availability', type: 'text' },
      { name: 'rating', selector: 'p.star-rating', type: 'attribute', attribute: 'class' },
    ],
    limit: 6,
  };
  report(extractWithSchema(page.html, page.url, schema));

  rule('1b. Nested sub-schema — quotes.toscrape.com, each quote plus its tag list');
  const q = await html('https://quotes.toscrape.com/');
  report(
    extractWithSchema(q.html, q.url, {
      name: 'quotes with nested tags',
      baseSelector: 'div.quote',
      limit: 3,
      fields: [
        { name: 'text', selector: 'span.text', type: 'text' },
        { name: 'author', selector: 'small.author', type: 'text' },
        {
          name: 'tags',
          selector: 'div.tags a.tag',
          type: 'nested',
          fields: [
            { name: 'tag', type: 'text' },
            { name: 'href', type: 'attribute', attribute: 'href' },
          ],
        },
      ],
    }),
    2,
  );

  rule('1c. Deliberate miss — honest reporting when a selector matches nothing');
  report(
    extractWithSchema(page.html, page.url, {
      name: 'wrong selectors on purpose',
      baseSelector: '.product-card',
      fields: [{ name: 'title', selector: 'h3', type: 'text' }],
    }),
  );
}

/* ---------------------------------------------------------------- 2. XPath */

if (want('xpath')) {
  rule('2. XPath schema — news.ycombinator.com front page');
  const page = await html('https://news.ycombinator.com/');
  report(
    extractWithSchema(page.html, page.url, {
      name: 'hn front page',
      engine: 'xpath',
      baseSelector: '//tr[contains(@class,"athing")]',
      limit: 5,
      fields: [
        { name: 'rank', selector: './/span[@class="rank"]', type: 'number' },
        { name: 'title', selector: './/span[@class="titleline"]/a', type: 'text' },
        { name: 'url', selector: 'string(.//span[@class="titleline"]/a/@href)' },
        { name: 'site', selector: './/span[@class="sitestr"]', type: 'text' },
      ],
    }),
    5,
  );

  rule('2b. XPath with a document-absolute expression (auto-scoped, with a diagnostic)');
  report(
    extractWithSchema(page.html, page.url, {
      engine: 'xpath',
      baseSelector: '//tr[contains(@class,"athing")]',
      limit: 2,
      fields: [{ name: 'title', selector: '//span[@class="titleline"]/a', type: 'text' }],
    }),
    2,
  );
}

/* ------------------------------------------------------------- 3. Patterns */

if (want('patterns')) {
  for (const target of [
    'https://www.usa.gov/phone',
    'https://www.ietf.org/contact/',
    'https://books.toscrape.com/',
  ]) {
    rule(`3. Built-in patterns — ${target}`);
    const page = await scrape(target, {
      formats: ['rawHtml', 'text'],
      onlyMainContent: false,
      maxAge: CACHE,
    });
    if (!page.success) {
      console.log(`  fetch failed: ${page.error}`);
      continue;
    }
    const groups = extractPatterns(
      { text: page.text ?? '', html: page.rawHtml ?? '', baseUrl: page.metadata.url },
      undefined,
      8,
    );
    for (const g of groups) {
      console.log(
        `  ${g.kind.padEnd(7)} ${String(g.hits.length).padStart(3)} distinct / ${String(g.matches).padStart(4)} matches` +
          `${g.rejected ? ` / ${g.rejected} rejected` : ''}`,
      );
      for (const h of g.hits.slice(0, 6)) {
        console.log(`      ${h.value}${h.label ? ` [${h.label}]` : ''}${h.count > 1 ? ` x${h.count}` : ''}`);
      }
    }
  }
}

/* ------------------------------------------------------------ 4. Generator */

if (want('generate')) {
  const cases: { url: string; description?: string }[] = [
    { url: 'https://books.toscrape.com/', description: 'product cards with a title, price and link' },
    { url: 'https://quotes.toscrape.com/', description: 'quotes with their author' },
    { url: 'https://news.ycombinator.com/' },
  ];
  for (const c of cases) {
    rule(`4. Schema generator — ${c.url}${c.description ? ` ("${c.description}")` : ' (no hints at all)'}`);
    const page = await html(c.url);
    const g = generateSchema(page.html, page.url, { description: c.description, maxFields: 6 });
    console.log(`confidence=${g.confidence} verifiedRecords=${g.coverage.records}`);
    console.log('containers considered:');
    for (const cand of g.candidates.slice(0, 4)) {
      console.log(
        `  ${String(cand.score).padStart(6)}  ${cand.selector}  (${cand.members} members: ${cand.reasons.join(', ')})`,
      );
    }
    console.log('inferred schema:');
    console.log(JSON.stringify(g.schema));
    console.log('coverage:', JSON.stringify(g.coverage.perField));
    console.log('sample:');
    console.log(JSON.stringify(g.sample.slice(0, 2), null, 1));
    for (const n of g.notes) console.log(`  ! ${n}`);
  }

  rule('4b. Generator anchored by example values alone (no description)');
  const page = await html('https://quotes.toscrape.com/');
  const g = generateSchema(page.html, page.url, {
    examples: ['Albert Einstein', 'change'],
    maxFields: 5,
  });
  console.log(`confidence=${g.confidence} base=${g.schema.baseSelector}`);
  console.log(JSON.stringify(g.schema));
  console.log(JSON.stringify(g.sample.slice(0, 1), null, 1));
}

/* ------------------------------------------------------------- 5. llms.txt */

if (want('llmstxt')) {
  // llmstxt.org is small and publishes a sitemap; example.com is the honest
  // edge case — one page, and a site that reveals no URLs at all.
  for (const site of ['https://llmstxt.org', 'https://example.com']) {
    rule(`5. llms.txt — ${site}`);
    try {
      const result = await generateLlmsTxt(site, {
        limit: 8,
        maxAge: CACHE,
        sitemapOnly: true,
      });
      console.log(
        `site=${result.siteName} mapped=${result.mapped} scraped=${result.scraped} ` +
          `failed=${result.failed.length} listed=${result.pages.length} ${result.elapsedMs}ms`,
      );
      if (result.warning) console.log(`! ${result.warning}`);
      for (const f of result.failed.slice(0, 3)) console.log(`  failed ${f.url}: ${f.error}`);
      console.log('-'.repeat(74));
      console.log(result.llmstxt);
      console.log('-'.repeat(74));
    } catch (err) {
      console.log(`  failed: ${String(err)}`);
    }
  }

  rule('5b. llms-full.txt variant (first 900 chars)');
  const full = await generateLlmsTxt('https://llmstxt.org', {
    limit: 3,
    full: true,
    sitemapOnly: true,
    maxAge: CACHE,
    maxCharsPerPage: 500,
  });
  console.log(`llms-full.txt is ${full.llmsfull?.length ?? 0} chars`);
  console.log((full.llmsfull ?? '').slice(0, 900));
}

/* ------------------------------------------------------------------ 6. OCR */

/**
 * Minimal PNG reader: non-interlaced, 8-bit, grayscale / RGB / RGBA / palette.
 * Only node:zlib is needed, so this check adds no dependency.
 */
function decodePng(buf: Buffer): { width: number; height: number; rgb: Buffer } {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let palette: Buffer | undefined;
  const idat: Buffer[] = [];

  for (let i = 8; i < buf.length; ) {
    const length = buf.readUInt32BE(i);
    const type = buf.subarray(i + 4, i + 8).toString('latin1');
    const body = buf.subarray(i + 8, i + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      colorType = body[9];
      if (body[12] !== 0) throw new Error('interlaced PNG is not supported here');
    } else if (type === 'PLTE') palette = Buffer.from(body);
    else if (type === 'IDAT') idat.push(Buffer.from(body));
    else if (type === 'IEND') break;
    i += 12 + length;
  }
  if (depth !== 8) throw new Error(`unsupported PNG bit depth ${depth}`);

  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  if (!channels) throw new Error(`unsupported PNG colour type ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);

  // Undo the per-scanline filters (PNG spec, section 9).
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const line = raw.subarray(rowStart + 1, rowStart + 1 + stride);
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[x] = value & 0xff;
    }
  }

  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0, o = 0; i < width * height; i++, o += 3) {
    if (colorType === 3) {
      const idx = pixels[i] * 3;
      rgb[o] = palette?.[idx] ?? 0;
      rgb[o + 1] = palette?.[idx + 1] ?? 0;
      rgb[o + 2] = palette?.[idx + 2] ?? 0;
    } else if (channels <= 2) {
      rgb[o] = rgb[o + 1] = rgb[o + 2] = pixels[i * channels];
    } else {
      rgb[o] = pixels[i * channels];
      rgb[o + 1] = pixels[i * channels + 1];
      rgb[o + 2] = pixels[i * channels + 2];
    }
  }
  return { width, height, rgb };
}

/**
 * A one-page PDF whose only content is one full-page bitmap — a synthetic
 * scan, which is exactly the case documents.ts hands to OCR.
 */
function imageOnlyPdf(rgb: Buffer, width: number, height: number): Buffer {
  const objects: Buffer[] = [];
  const push = (part: string | Buffer) =>
    objects.push(Buffer.isBuffer(part) ? part : Buffer.from(part, 'latin1'));
  const stream = deflateSync(rgb);
  const content = ['q', `${width} 0 0 ${height} 0 0 cm`, '/Im0 Do', 'Q', ''].join('\n');

  push(['1 0 obj', '<< /Type /Catalog /Pages 2 0 R >>', 'endobj', ''].join('\n'));
  push(['2 0 obj', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'endobj', ''].join('\n'));
  push(
    [
      '3 0 obj',
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ` +
        '/Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>',
      'endobj',
      '',
    ].join('\n'),
  );
  push(['4 0 obj', `<< /Length ${content.length} >>`, 'stream', `${content}endstream`, 'endobj', ''].join('\n'));
  push(
    Buffer.concat([
      Buffer.from(
        [
          '5 0 obj',
          `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
            `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${stream.length} >>`,
          'stream',
          '',
        ].join('\n'),
        'latin1',
      ),
      stream,
      Buffer.from(['', 'endstream', 'endobj', ''].join('\n'), 'latin1'),
    ]),
  );

  const header = Buffer.from('%PDF-1.4\n', 'latin1');
  const offsets: number[] = [];
  let cursor = header.length;
  for (const obj of objects) {
    offsets.push(cursor);
    cursor += obj.length;
  }
  const xref = [
    'xref',
    `0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.map((off) => `${String(off).padStart(10, '0')} 00000 n `),
    '',
  ].join('\n');
  const trailer = [
    'trailer',
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    'startxref',
    String(cursor),
    '%%EOF',
    '',
  ].join('\n');
  return Buffer.concat([header, ...objects, Buffer.from(xref + trailer, 'latin1')]);
}

if (want('ocr')) {
  rule('6. OCR availability');
  const probe = await ocrAvailable();
  console.log(`available=${probe.available}${probe.message ? ` message=${probe.message}` : ''}`);

  const IMAGE = 'https://tesseract.projectnaptha.com/img/eng_bw.png';
  rule(`6b. OCR an image — ${IMAGE}`);
  let image: Buffer | undefined;
  try {
    const got = await fetchPage(IMAGE, { render: 'http' });
    image = got.page.body;
    console.log(`fetched ${image.byteLength} bytes (${got.page.contentType})`);
  } catch (err) {
    console.log(`  could not fetch the test image: ${String(err)}`);
  }

  if (image) {
    const result = await ocrImage(image);
    console.log(`available=${result.available} ${result.elapsedMs}ms engine=${result.engine ?? '-'}`);
    if (result.message) console.log(`! ${result.message}`);
    console.log(`confidence=${result.pages[0]?.confidence ?? '-'}`);
    console.log('--- recognised text ---');
    console.log(result.text.slice(0, 600));
  }

  rule('6c. Scanned-PDF path through documents.ts (ocr opt-in)');
  if (!image) {
    console.log('  skipped: the test image could not be fetched');
  } else {
    try {
      const { width, height, rgb } = decodePng(image);
      const pdf = imageOnlyPdf(rgb, width, height);
      const dir = mkdtempSync(join(tmpdir(), 'openscrape-ocr-'));
      const path = join(dir, 'synthetic-scan.pdf');
      writeFileSync(path, pdf);
      console.log(`built a one-page image-only PDF from the ${width}x${height} bitmap:`);
      console.log(`  ${path} (${pdf.byteLength} bytes)`);

      const without = await parseDocument(pdf, 'application/pdf', path);
      console.log(`\nparseDocument without ocr -> ${without.markdown.length} chars of markdown`);
      console.log(`  warning: ${without.warning ?? '(none)'}`);

      const withOcr = await parseDocument(pdf, 'application/pdf', path, { ocr: true, ocrMaxPages: 1 });
      console.log(`\nparseDocument with ocr:true -> ${withOcr.markdown.length} chars of markdown`);
      console.log(`  warning: ${withOcr.warning ?? '(none)'}`);
      console.log('--- recognised text ---');
      console.log(withOcr.text.slice(0, 700));
    } catch (err) {
      console.log(`  scanned-PDF check could not run: ${String(err)}`);
    }
  }
}

console.log();
