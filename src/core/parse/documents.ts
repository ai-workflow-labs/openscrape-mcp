import { htmlToMarkdown, markdownToText, tidy } from '../extract/markdown.js';
import { log } from '../util/log.js';

export type DocKind = 'pdf' | 'docx' | 'csv' | 'json' | 'xml' | 'text' | 'markdown' | 'html' | 'unknown';

export interface ParsedDocument {
  kind: DocKind;
  markdown: string;
  text: string;
  pages?: number;
  title?: string;
  warning?: string;
}

/** Opt-in extras. OCR is slow, so it never runs unless asked for. */
export interface ParseOptions {
  /** Run OCR when a PDF yields almost no text (a scan). */
  ocr?: boolean;
  /** tesseract language code(s), e.g. "eng", "eng+deu". */
  ocrLanguage?: string;
  /** Cap the pages sent to OCR. */
  ocrMaxPages?: number;
}

/** Sniffs the real type from magic bytes first, then content-type, then extension. */
export function detectKind(buffer: Buffer, contentType = '', url = ''): DocKind {
  const magic = buffer.subarray(0, 8);
  if (magic.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  // DOCX is a ZIP container; so is XLSX, so we also check the content type/extension.
  if (magic[0] === 0x50 && magic[1] === 0x4b) {
    if (/wordprocessingml|\.docx(\?|$)/i.test(contentType + ' ' + url)) return 'docx';
  }

  const ct = contentType.toLowerCase();
  if (ct.includes('pdf')) return 'pdf';
  if (ct.includes('wordprocessingml') || ct.includes('msword')) return 'docx';
  if (ct.includes('csv')) return 'csv';
  if (ct.includes('json')) return 'json';
  if (ct.includes('xml')) return 'xml';
  if (ct.includes('markdown')) return 'markdown';
  if (ct.includes('html')) return 'html';
  if (ct.startsWith('text/')) return 'text';

  const path = url.split('?')[0].toLowerCase();
  if (path.endsWith('.pdf')) return 'pdf';
  if (path.endsWith('.docx')) return 'docx';
  if (path.endsWith('.csv') || path.endsWith('.tsv')) return 'csv';
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.xml')) return 'xml';
  if (path.endsWith('.md') || path.endsWith('.markdown')) return 'markdown';
  if (path.endsWith('.txt')) return 'text';
  if (path.endsWith('.html') || path.endsWith('.htm')) return 'html';
  return 'unknown';
}

async function parsePdf(buffer: Buffer, opts: ParseOptions = {}): Promise<ParsedDocument> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const proxy = await getDocumentProxy(new Uint8Array(buffer));
  const { totalPages, text } = await extractText(proxy, { mergePages: false });
  const pages = Array.isArray(text) ? text : [String(text)];

  // A PDF usually knows its own title; the filename is a poor substitute.
  let title: string | undefined;
  try {
    const meta = (await proxy.getMetadata()) as { info?: { Title?: unknown } };
    const raw = meta?.info?.Title;
    if (typeof raw === 'string' && raw.trim() && !/^untitled$/i.test(raw.trim())) {
      title = raw.trim();
    }
  } catch {
    /* metadata is optional */
  }

  const body = pages
    .map((pageText, i) => {
      const cleaned = cleanPdfText(String(pageText));
      return cleaned ? `<!-- page ${i + 1} -->\n\n${cleaned}` : '';
    })
    .filter(Boolean)
    .join('\n\n');

  const md = tidy(body);
  const looksScanned = md.replace(/<!--[^>]*-->/g, '').trim().length < 50;

  if (looksScanned && opts.ocr) {
    const { ocrPdf } = await import('../extract/ocr.js');
    const ocr = await ocrPdf(buffer, { language: opts.ocrLanguage, maxPages: opts.ocrMaxPages });
    if (ocr.text) {
      const ocrMd = tidy(ocr.text);
      return {
        kind: 'pdf',
        markdown: ocrMd,
        text: markdownToText(ocrMd),
        pages: totalPages,
        title,
        warning: `Text recovered by OCR (${ocr.engine ?? 'tesseract.js'}, ${ocr.pages.length} page(s) in ${ocr.elapsedMs}ms).${ocr.message ? ' ' + ocr.message : ''}`,
      };
    }
    return {
      kind: 'pdf',
      markdown: md,
      text: markdownToText(md),
      pages: totalPages,
      title,
      warning: `This PDF produced almost no text and OCR did not recover any. ${ocr.message ?? ''}`.trim(),
    };
  }

  const warning = looksScanned
    ? 'This PDF produced almost no text, so it is probably a scan. Re-run with ocr:true to read it.'
    : undefined;

  return { kind: 'pdf', markdown: md, text: markdownToText(md), pages: totalPages, title, warning };
}

/** PDF text extraction leaves hard-wrapped lines and hyphen splits behind. */
function cleanPdfText(raw: string): string {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/-\n(\p{Ll})/gu, '$1')
    .replace(/([^\n.!?:;])\n(?=\p{Ll})/gu, '$1 ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function parseDocx(buffer: Buffer): Promise<ParsedDocument> {
  const mammoth = await import('mammoth');
  const result = await mammoth.convertToHtml({ buffer });
  const md = htmlToMarkdown(result.value);
  const messages = result.messages
    .filter((m) => m.type === 'warning')
    .map((m) => m.message)
    .slice(0, 3);
  return {
    kind: 'docx',
    markdown: md,
    text: markdownToText(md),
    warning: messages.length ? messages.join('; ') : undefined,
  };
}

/** Delimited data becomes a GFM table so the model can read it directly. */
function parseCsv(text: string): ParsedDocument {
  const delimiter = text.includes('\t') && !text.includes(',') ? '\t' : ',';
  const rows = splitCsv(text, delimiter).filter((r) => r.some((c) => c.trim() !== ''));
  if (rows.length === 0) return { kind: 'csv', markdown: '', text: '' };

  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill('')];
  const esc = (c: string) => c.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();

  const header = pad(rows[0]).map(esc);
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.slice(1).map((r) => `| ${pad(r).map(esc).join(' | ')} |`),
  ];
  const md = lines.join('\n');
  return { kind: 'csv', markdown: md, text: rows.map((r) => r.join('\t')).join('\n') };
}

/** Minimal RFC-4180 reader: handles quoted fields, escaped quotes and newlines. */
function splitCsv(input: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Turns a non-HTML document into markdown. HTML is handled by the extraction
 * pipeline instead, since it needs the full DOM treatment.
 */
export async function parseDocument(
  buffer: Buffer,
  contentType = '',
  url = '',
  options: ParseOptions = {},
): Promise<ParsedDocument> {
  const kind = detectKind(buffer, contentType, url);
  try {
    switch (kind) {
      case 'pdf':
        return await parsePdf(buffer, options);
      case 'docx':
        return await parseDocx(buffer);
      case 'csv':
        return parseCsv(buffer.toString('utf8'));
      case 'json': {
        const text = buffer.toString('utf8');
        let pretty = text;
        try {
          pretty = JSON.stringify(JSON.parse(text), null, 2);
        } catch {
          /* leave as-is */
        }
        const md = '```json\n' + pretty + '\n```';
        return { kind, markdown: md, text: pretty };
      }
      case 'xml': {
        const text = buffer.toString('utf8');
        return { kind, markdown: '```xml\n' + text + '\n```', text };
      }
      case 'markdown': {
        const md = tidy(buffer.toString('utf8'));
        return { kind, markdown: md, text: markdownToText(md) };
      }
      case 'text': {
        const text = tidy(buffer.toString('utf8'));
        return { kind, markdown: text, text };
      }
      default: {
        const text = buffer.toString('utf8');
        const printable = text.replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '').length / Math.max(text.length, 1);
        if (printable > 0.85) {
          const md = tidy(text);
          return { kind: 'text', markdown: md, text: markdownToText(md) };
        }
        return {
          kind: 'unknown',
          markdown: '',
          text: '',
          warning: `Unsupported binary content type "${contentType || 'unknown'}" (${buffer.byteLength} bytes).`,
        };
      }
    }
  } catch (err) {
    log.warn('document parse failed', { kind, error: String(err) });
    return {
      kind,
      markdown: '',
      text: '',
      warning: `Failed to parse ${kind}: ${String(err)}`,
    };
  }
}
