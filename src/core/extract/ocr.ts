import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { DATA_DIR } from '../util/paths.js';
import { log } from '../util/log.js';

/**
 * OCR for scanned PDFs and images, via tesseract.js.
 *
 * Everything here is optional at runtime. tesseract.js is a WASM build that
 * downloads its language data on first use, so on a locked-down or offline
 * machine it simply cannot run. That must never take the MCP server down with
 * it: the import is lazy and wrapped, and an unavailable engine returns a
 * message explaining exactly what to do rather than throwing.
 *
 * OCR is also slow — tens of seconds per page — so nothing calls it unless the
 * caller explicitly asks.
 */

export interface OcrOptions {
  /** tesseract language code(s), e.g. "eng", "eng+deu". Default "eng". */
  language?: string;
  /** Stop after this many PDF pages. Default 5. */
  maxPages?: number;
  /** Drop recognised pages below this mean confidence (0-100). Default 0. */
  minConfidence?: number;
  /** Render scale when rasterising PDF pages. Default 2 (≈144 dpi). */
  scale?: number;
}

export interface OcrPage {
  page: number;
  text: string;
  /** Mean confidence reported by tesseract, 0-100. */
  confidence: number;
  /** How the page bitmap was obtained. */
  source: 'rendered' | 'embedded-image' | 'image';
  width?: number;
  height?: number;
}

export interface OcrResult {
  /** False when the engine or its data could not be loaded. */
  available: boolean;
  text: string;
  pages: OcrPage[];
  /** Set when `available` is false, or when something was skipped. */
  message?: string;
  engine?: string;
  elapsedMs: number;
}

interface TesseractModule {
  createWorker: (
    langs?: string,
    oem?: number,
    options?: Record<string, unknown>,
  ) => Promise<TesseractWorker>;
}

interface TesseractWorker {
  recognize: (image: unknown) => Promise<{ data: { text?: string; confidence?: number } }>;
  terminate: () => Promise<unknown>;
}

const INSTALL_HINT =
  'OCR needs the optional "tesseract.js" package and its language data. ' +
  'Install it with `npm install tesseract.js`, and make sure the process can either reach ' +
  'the language-data CDN once or read a local copy (set OPENSCRAPE_TESSDATA to a directory ' +
  'holding e.g. eng.traineddata.gz).';

let cachedModule: TesseractModule | null | undefined;
let cachedLoadError: string | undefined;

/**
 * Lazy, failure-tolerant import. Called on every OCR entry point so the
 * module still type-checks and the server still starts when the package is
 * missing, broken, or built for a different platform.
 */
async function loadTesseract(): Promise<{ mod: TesseractModule | null; message?: string }> {
  if (cachedModule !== undefined) {
    return { mod: cachedModule, message: cachedLoadError };
  }
  try {
    const imported = (await import('tesseract.js')) as unknown as
      | TesseractModule
      | { default: TesseractModule };
    const mod = (imported as { default?: TesseractModule }).default ?? (imported as TesseractModule);
    if (typeof mod?.createWorker !== 'function') {
      cachedModule = null;
      cachedLoadError = `tesseract.js loaded but exposes no createWorker(). ${INSTALL_HINT}`;
      return { mod: null, message: cachedLoadError };
    }
    cachedModule = mod;
    cachedLoadError = undefined;
    return { mod };
  } catch (err) {
    cachedModule = null;
    cachedLoadError = `tesseract.js is not usable here (${String(err)}). ${INSTALL_HINT}`;
    log.debug('tesseract.js unavailable', cachedLoadError);
    return { mod: null, message: cachedLoadError };
  }
}

/** Cheap check for callers that want to tell the user before starting a slow job. */
export async function ocrAvailable(): Promise<{ available: boolean; message?: string }> {
  const { mod, message } = await loadTesseract();
  return { available: mod !== null, message };
}

function tessCacheDir(): string {
  const dir = process.env.OPENSCRAPE_TESSDATA || join(DATA_DIR, 'tessdata');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* a read-only cache dir is survivable; tesseract will re-download */
  }
  return dir;
}

async function withWorker<T>(
  language: string,
  run: (worker: TesseractWorker) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  const { mod, message } = await loadTesseract();
  if (!mod) return { ok: false, message: message ?? INSTALL_HINT };

  const cachePath = tessCacheDir();
  let worker: TesseractWorker | undefined;
  try {
    worker = await mod.createWorker(language, undefined, {
      cachePath,
      // tesseract.js logs progress; stdout is the JSON-RPC channel, so route it.
      logger: (m: { status?: string; progress?: number }) =>
        log.debug('ocr', `${m.status ?? ''} ${Math.round((m.progress ?? 0) * 100)}%`),
      errorHandler: (e: unknown) => log.warn('ocr worker error', String(e)),
    });
  } catch (err) {
    return {
      ok: false,
      message:
        `Could not start the OCR worker for language "${language}" (${String(err)}). ` + INSTALL_HINT,
    };
  }

  try {
    const value = await run(worker);
    return { ok: true, value };
  } catch (err) {
    return { ok: false, message: `OCR failed: ${String(err)}` };
  } finally {
    try {
      await worker?.terminate();
    } catch {
      /* nothing useful to do */
    }
  }
}

/**
 * Encode raw pixels as an uncompressed BMP.
 *
 * Leptonica (inside tesseract) reads BMP, and writing one takes a header and a
 * row loop — no image-encoding dependency, which matters because this project
 * refuses to add heavy optional native packages just to OCR a scan.
 */
export function rawToBmp(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  channels: 1 | 3 | 4,
): Buffer {
  const rowBytes = width * 3;
  const padding = (4 - (rowBytes % 4)) % 4;
  const stride = rowBytes + padding;
  const pixelBytes = stride * height;
  const headerSize = 54;
  const out = Buffer.alloc(headerSize + pixelBytes);

  out.write('BM', 0, 'ascii');
  out.writeUInt32LE(headerSize + pixelBytes, 2);
  out.writeUInt32LE(headerSize, 10);
  out.writeUInt32LE(40, 14); // BITMAPINFOHEADER
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22); // positive: bottom-up rows
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(pixelBytes, 34);

  for (let y = 0; y < height; y++) {
    const srcRow = (height - 1 - y) * width * channels;
    let dst = headerSize + y * stride;
    for (let x = 0; x < width; x++) {
      const i = srcRow + x * channels;
      let r: number;
      let g: number;
      let b: number;
      if (channels === 1) {
        r = g = b = data[i] ?? 0;
      } else {
        r = data[i] ?? 0;
        g = data[i + 1] ?? 0;
        b = data[i + 2] ?? 0;
        if (channels === 4) {
          // Composite onto white; a scan's transparent areas are page, not ink.
          const a = (data[i + 3] ?? 255) / 255;
          r = Math.round(r * a + 255 * (1 - a));
          g = Math.round(g * a + 255 * (1 - a));
          b = Math.round(b * a + 255 * (1 - a));
        }
      }
      out[dst++] = b;
      out[dst++] = g;
      out[dst++] = r;
    }
  }
  return out;
}

/** OCR one already-encoded image (PNG, JPEG, BMP, TIFF, WEBP...). */
export async function ocrImage(image: Buffer, options: OcrOptions = {}): Promise<OcrResult> {
  const started = Date.now();
  const language = options.language ?? 'eng';
  const run = await withWorker(language, async (worker) => worker.recognize(image));

  if (!run.ok) {
    return { available: false, text: '', pages: [], message: run.message, elapsedMs: Date.now() - started };
  }
  const text = (run.value.data.text ?? '').trim();
  const confidence = Math.round(run.value.data.confidence ?? 0);
  return {
    available: true,
    text,
    pages: [{ page: 1, text, confidence, source: 'image' }],
    engine: `tesseract.js/${language}`,
    message: text ? undefined : 'OCR ran but recognised no text in this image.',
    elapsedMs: Date.now() - started,
  };
}

interface PageBitmap {
  page: number;
  image: Buffer;
  source: 'rendered' | 'embedded-image';
  width?: number;
  height?: number;
}

/**
 * Get a bitmap per page.
 *
 * Preferred route is unpdf's `renderPageAsImage`, which rasterises the real
 * page — but it needs a canvas implementation (`@napi-rs/canvas`) that is not
 * a dependency here. When that is missing we fall back to the images embedded
 * in the page, which is exactly what a scanned PDF is made of: one full-page
 * bitmap per page.
 */
interface EmbeddedImage {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  channels: 1 | 3 | 4;
}

/**
 * Pull the decoded image XObjects out of one page.
 *
 * unpdf ships `extractImages`, but it reads `page.objs.get(key)` in the form
 * that throws while the object is still being decoded ("Requesting object that
 * isn't resolved yet"), which is exactly what happens on the first read of a
 * scan. The callback form waits instead, so we drive pdf.js directly and keep
 * unpdf's version as a fallback.
 */
async function embeddedImages(page: {
  getOperatorList: () => Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
  objs: { get: (key: string, cb?: (value: unknown) => void) => unknown };
}): Promise<EmbeddedImage[]> {
  const { getResolvedPDFJS } = await import('unpdf');
  const { OPS } = (await getResolvedPDFJS()) as { OPS: Record<string, number> };
  const ops = await page.getOperatorList();

  const keys: string[] = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const op = ops.fnArray[i];
    if (op !== OPS.paintImageXObject && op !== OPS.paintImageXObjectRepeat) continue;
    const key = ops.argsArray[i]?.[0];
    if (typeof key === 'string' && !keys.includes(key)) keys.push(key);
  }

  const out: EmbeddedImage[] = [];
  for (const key of keys) {
    const value = await new Promise<unknown>((resolve) => {
      // A never-resolving object must not hang the whole OCR run.
      const timer = setTimeout(() => resolve(null), 15_000);
      try {
        page.objs.get(key, (v) => {
          clearTimeout(timer);
          resolve(v);
        });
      } catch {
        clearTimeout(timer);
        resolve(null);
      }
    });
    const img = value as { data?: Uint8Array; width?: number; height?: number } | null;
    if (!img?.data || !img.width || !img.height) continue;
    const channels = img.data.length / (img.width * img.height);
    // 1-bit packed bitmaps give a fractional ratio; they are not handled here.
    if (channels !== 1 && channels !== 3 && channels !== 4) continue;
    out.push({ data: img.data, width: img.width, height: img.height, channels });
  }
  return out;
}

async function pageBitmaps(
  data: Uint8Array,
  maxPages: number,
  scale: number,
  notes: string[],
): Promise<PageBitmap[]> {
  const { getDocumentProxy, renderPageAsImage, extractImages } = await import('unpdf');
  const proxy = await getDocumentProxy(data);
  const total = Math.min(proxy.numPages ?? 1, maxPages);
  const out: PageBitmap[] = [];
  let renderWorks = true;

  for (let page = 1; page <= total; page++) {
    if (renderWorks) {
      try {
        const buf = await renderPageAsImage(proxy, page, { scale });
        out.push({ page, image: Buffer.from(buf), source: 'rendered' });
        continue;
      } catch (err) {
        renderWorks = false;
        notes.push(
          `Page rasterisation is unavailable (${String(err).slice(0, 160)}); ` +
            'falling back to the images embedded in each page. ' +
            'Install @napi-rs/canvas for full-page rendering.',
        );
      }
    }
    try {
      let images: EmbeddedImage[];
      try {
        images = await embeddedImages(
          (await proxy.getPage(page)) as unknown as Parameters<typeof embeddedImages>[0],
        );
      } catch (err) {
        notes.push(`Page ${page}: direct image read failed (${String(err).slice(0, 100)}); using unpdf.`);
        images = (await extractImages(proxy, page)) as EmbeddedImage[];
      }
      // A scan is one big image; ignore logos and separator rules.
      const best = images
        .filter((img) => img.width >= 200 && img.height >= 200)
        .sort((a, b) => b.width * b.height - a.width * a.height)[0];
      if (!best) continue;
      out.push({
        page,
        image: rawToBmp(best.data, best.width, best.height, best.channels),
        source: 'embedded-image',
        width: best.width,
        height: best.height,
      });
    } catch (err) {
      notes.push(`Page ${page}: could not obtain a bitmap (${String(err).slice(0, 120)}).`);
    }
  }
  return out;
}

/** OCR a (probably scanned) PDF, page by page. */
export async function ocrPdf(pdf: Buffer | Uint8Array, options: OcrOptions = {}): Promise<OcrResult> {
  const started = Date.now();
  const language = options.language ?? 'eng';
  const maxPages = Math.max(1, options.maxPages ?? 5);
  const minConfidence = options.minConfidence ?? 0;
  const notes: string[] = [];

  const probe = await ocrAvailable();
  if (!probe.available) {
    return { available: false, text: '', pages: [], message: probe.message, elapsedMs: Date.now() - started };
  }

  let bitmaps: PageBitmap[];
  try {
    // pdf.js detaches the ArrayBuffer it is given, so hand it a private copy.
    bitmaps = await pageBitmaps(new Uint8Array(pdf), maxPages, options.scale ?? 2, notes);
  } catch (err) {
    return {
      available: true,
      text: '',
      pages: [],
      message: `Could not read pages out of this PDF for OCR: ${String(err)}`,
      elapsedMs: Date.now() - started,
    };
  }

  if (bitmaps.length === 0) {
    return {
      available: true,
      text: '',
      pages: [],
      message:
        'No page bitmap could be produced, so there was nothing to OCR. ' +
        (notes.join(' ') ||
          'The PDF holds neither renderable pages nor embedded images of a usable size.'),
      elapsedMs: Date.now() - started,
    };
  }

  const run = await withWorker(language, async (worker) => {
    const pages: OcrPage[] = [];
    for (const bitmap of bitmaps) {
      const { data } = await worker.recognize(bitmap.image);
      const text = (data.text ?? '').trim();
      const confidence = Math.round(data.confidence ?? 0);
      if (confidence < minConfidence) {
        notes.push(`Page ${bitmap.page} dropped: confidence ${confidence} < ${minConfidence}.`);
        continue;
      }
      pages.push({
        page: bitmap.page,
        text,
        confidence,
        source: bitmap.source,
        width: bitmap.width,
        height: bitmap.height,
      });
    }
    return pages;
  });

  if (!run.ok) {
    return { available: false, text: '', pages: [], message: run.message, elapsedMs: Date.now() - started };
  }

  const pages = run.value;
  const text = pages
    .filter((p) => p.text)
    .map((p) => `<!-- page ${p.page} (ocr, confidence ${p.confidence}) -->\n\n${p.text}`)
    .join('\n\n')
    .trim();

  return {
    available: true,
    text,
    pages,
    engine: `tesseract.js/${language}`,
    message: notes.length ? notes.join(' ') : text ? undefined : 'OCR ran but recognised no text.',
    elapsedMs: Date.now() - started,
  };
}
