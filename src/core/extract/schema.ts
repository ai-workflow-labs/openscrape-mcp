import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import { DOMParser } from '@xmldom/xmldom';
import * as xpath from 'xpath';
import { absolutize } from '../util/url.js';
import { log } from '../util/log.js';

/**
 * Declarative, rule-based extraction — the layer below `structured.ts`.
 *
 * `structured.ts` mines what a page already declares about itself (JSON-LD,
 * microdata, OpenGraph). Plenty of pages declare nothing, and for those the
 * honest free answer is a schema: name the repeating container, name the
 * fields inside it, and pull the records out. No model call, no API key, and
 * the same schema can be reused on every page of the same template.
 *
 * Firecrawl bills 4 extra credits per page for its JSON/extract formats. This
 * costs one HTTP request.
 */

export type FieldType = 'text' | 'html' | 'attribute' | 'regex' | 'number' | 'nested';
export type SelectorEngine = 'css' | 'xpath';
export type FieldTransform = 'none' | 'trim' | 'lower' | 'upper' | 'absolute' | 'collapse';

export interface FieldDef {
  /** Key this field gets in the output record. */
  name: string;
  /**
   * Selector relative to the record element. Omit it to read the record
   * element itself (useful for `regex` over the whole card).
   */
  selector?: string;
  /** Default `text`. */
  type?: FieldType;
  /** Attribute to read, for `type: "attribute"`. */
  attribute?: string;
  /** Regex source, for `type: "regex"`. */
  pattern?: string;
  /** Regex flags. `g` is implied when `all` is set. */
  flags?: string;
  /** Capture group to keep. Default 0 (the whole match). */
  group?: number;
  /** Read the regex input from the element's HTML instead of its text. */
  fromHtml?: boolean;
  /** Collect every match into an array instead of taking the first. */
  all?: boolean;
  /** Sub-schema, for `type: "nested"`. */
  fields?: FieldDef[];
  transform?: FieldTransform;
  /** Value used when nothing matched. Omit to leave the key out. */
  default?: string | number | null;
}

export interface ExtractionSchema {
  /** Free-form label, echoed back so saved schemas stay identifiable. */
  name?: string;
  /**
   * Selector for the repeating record container. Omit it to treat the whole
   * document as a single record.
   */
  baseSelector?: string;
  /** Default `css`. */
  engine?: SelectorEngine;
  fields: FieldDef[];
  /** Stop after this many records. */
  limit?: number;
}

export interface FieldStat {
  name: string;
  type: FieldType;
  selector: string;
  /** Records in which this field produced a value. */
  hits: number;
  /** Records in which the selector matched nothing, or matched only blanks. */
  misses: number;
}

export interface SchemaExtractionResult {
  name?: string;
  engine: SelectorEngine;
  baseSelector: string;
  /** How many elements the base selector matched, before `limit`. */
  baseMatches: number;
  records: Record<string, unknown>[];
  fieldStats: FieldStat[];
  /** Things worth saying out loud: unmatched selectors, rewrites, parse noise. */
  diagnostics: string[];
  elapsedMs: number;
}

/* -------------------------------------------------------------------------- */
/* DOM adapters                                                               */
/* -------------------------------------------------------------------------- */

type Handle = unknown;

interface SelectResult {
  nodes: Handle[];
  /** XPath expressions like `string(.//a/@href)` return a scalar, not nodes. */
  scalar?: string;
}

interface DomAdapter {
  engine: SelectorEngine;
  root(): Handle;
  select(scope: Handle, selector: string): SelectResult;
  /** True when the scope element itself satisfies the selector. */
  matchesSelf(scope: Handle, selector: string): boolean;
  text(node: Handle): string;
  html(node: Handle): string;
  attr(node: Handle, name: string): string | undefined;
  /** For diagnostics: a short human label for a node. */
  describe(node: Handle): string;
  /** Normalised selector, if the adapter had to rewrite it. */
  normalizeSelector?(selector: string, scoped: boolean): string;
}

function collapseWs(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function cssAdapter(html: string): DomAdapter {
  const $ = cheerio.load(html);
  return {
    engine: 'css',
    root: () => $.root()[0] as AnyNode,
    select(scope, selector) {
      const $scope = $(scope as AnyNode);
      return { nodes: $scope.find(selector).toArray() };
    },
    matchesSelf(scope, selector) {
      try {
        return $(scope as AnyNode).is(selector);
      } catch {
        return false;
      }
    },
    text: (n) => collapseWs($(n as AnyNode).text()),
    html: (n) => ($(n as AnyNode).html() ?? '').trim(),
    attr: (n, name) => $(n as AnyNode).attr(name),
    describe: (n) => describeCheerio(n as AnyNode),
  };
}

function describeCheerio(node: AnyNode): string {
  const el = node as Element;
  if (!el || el.type !== 'tag') return String((node as { type?: string }).type ?? 'node');
  const cls = typeof el.attribs?.class === 'string' ? '.' + el.attribs.class.trim().split(/\s+/).join('.') : '';
  const id = el.attribs?.id ? '#' + el.attribs.id : '';
  return `${el.tagName}${id}${cls}`.slice(0, 80);
}

/**
 * XPath needs a real XML document. Parsing raw HTML as XML fails on the first
 * unclosed `<br>`, and parsing it as `text/html` puts every element into the
 * XHTML namespace — which makes plain `//div` match nothing and forces users
 * to write namespace prefixes. So we let cheerio repair the markup, serialise
 * it as namespace-free XML, and hand that to xmldom. Ordinary XPath then works
 * exactly as written.
 */
function htmlToXml(html: string): string {
  const $ = cheerio.load(html);
  $('script, style, template, noscript').remove();
  $('*')
    .contents()
    .filter((_i, node) => node.type === 'comment')
    .remove();

  const validName = /^[A-Za-z_][A-Za-z0-9._-]*$/;
  for (const el of $('*').toArray()) {
    const attribs = (el as Element).attribs ?? {};
    for (const name of Object.keys(attribs)) {
      // Framework attributes (`@click`, `:class`, `[href]`, `#ref`) and
      // undeclared prefixes (`xlink:href`) are not well-formed XML names.
      if (name === 'xmlns' || name.startsWith('xmlns:') || !validName.test(name)) {
        delete attribs[name];
      }
    }
  }
  return $.html({ xmlMode: true });
}

function xpathAdapter(html: string, diagnostics: string[]): DomAdapter {
  const xml = htmlToXml(html);
  let errors = 0;
  let doc: unknown;
  try {
    doc = new DOMParser({
      onError: (level) => {
        if (level !== 'warning') errors++;
      },
    }).parseFromString(xml, 'text/xml');
  } catch (err) {
    throw new Error(
      `XPath engine could not parse this page as XML (${String(err)}). ` +
        'Try the css engine, which tolerates broken markup.',
    );
  }
  if (errors > 0) {
    diagnostics.push(`xmldom reported ${errors} non-fatal XML error(s); some branches may be missing.`);
  }

  const asNode = (h: Handle): Node => h as Node;

  const run = (scope: Handle, selector: string): SelectResult => {
    let out: unknown;
    try {
      out = xpath.select(selector, asNode(scope));
    } catch (err) {
      throw new Error(`Bad XPath expression ${JSON.stringify(selector)}: ${String(err)}`);
    }
    if (Array.isArray(out)) return { nodes: out as Handle[] };
    if (out === null || out === undefined) return { nodes: [] };
    if (typeof out === 'object') return { nodes: [out as Handle] };
    return { nodes: [], scalar: String(out) };
  };

  return {
    engine: 'xpath',
    root: () => doc,
    select: run,
    matchesSelf: () => false,
    text: (n) => collapseWs(String((n as { textContent?: string })?.textContent ?? '')),
    html: (n) => {
      const node = n as { toString?: () => string };
      return typeof node?.toString === 'function' ? node.toString() : '';
    },
    attr: (n, name) => {
      const node = n as { getAttribute?: (k: string) => string | null; nodeValue?: string | null };
      if (typeof node?.getAttribute === 'function') return node.getAttribute(name) ?? undefined;
      return node?.nodeValue ?? undefined;
    },
    describe: (n) => String((n as { nodeName?: string })?.nodeName ?? 'node').slice(0, 80),
    normalizeSelector(selector, scoped) {
      // `//div` inside a record means "anywhere in the document", which is
      // almost never what the author meant. Scope it and say so.
      if (scoped && selector.startsWith('//')) {
        diagnostics.push(`Scoped XPath "${selector}" to the record as ".${selector}".`);
        return '.' + selector;
      }
      return selector;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Value coercion                                                             */
/* -------------------------------------------------------------------------- */

/** Attributes that hold URLs and should come back absolute. */
const URL_ATTRS = new Set([
  'href',
  'src',
  'data-src',
  'data-lazy-src',
  'poster',
  'action',
  'cite',
  'formaction',
  'data-href',
  'data-url',
]);

/**
 * "$1,234.56", "1.234,56 €", "12 345,67", "-3,5" — all one number.
 *
 * The decimal separator is whichever of `.` or `,` comes last, which gets both
 * US and European formatting right without being told which is which.
 */
export function parseNumberLike(input: string): number | null {
  const match = /[-+]?\d[\d\s.,  ']*\d|[-+]?\d/.exec(input);
  if (!match) return null;
  let body = match[0].replace(/[\s  ']/g, '');
  const lastDot = body.lastIndexOf('.');
  const lastComma = body.lastIndexOf(',');

  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = lastDot > lastComma ? '.' : ',';
    const thousands = decimal === '.' ? ',' : '.';
    body = body.split(thousands).join('');
    if (decimal === ',') body = body.replace(',', '.');
  } else if (lastComma >= 0) {
    const tail = body.length - lastComma - 1;
    body = tail === 3 && body.split(',').length === 2 && /^[-+]?\d{1,3},\d{3}$/.test(body)
      ? body.replace(',', '')
      : body.replace(/,/g, tail <= 2 ? '.' : '');
  } else if (lastDot >= 0) {
    const tail = body.length - lastDot - 1;
    if (tail === 3 && /^[-+]?\d{1,3}(\.\d{3})+$/.test(body)) body = body.split('.').join('');
  }

  const n = Number(body);
  return Number.isFinite(n) ? n : null;
}

function applyTransform(value: string, transform: FieldTransform | undefined, baseUrl: string): string {
  switch (transform) {
    case 'lower':
      return value.toLowerCase();
    case 'upper':
      return value.toUpperCase();
    case 'collapse':
      return collapseWs(value);
    case 'absolute':
      return absolutize(value, baseUrl) ?? value;
    case 'trim':
      return value.trim();
    default:
      return value;
  }
}

/* -------------------------------------------------------------------------- */
/* Extraction                                                                 */
/* -------------------------------------------------------------------------- */

interface FieldContext {
  adapter: DomAdapter;
  baseUrl: string;
  diagnostics: string[];
  stats: Map<string, FieldStat>;
}

function statFor(ctx: FieldContext, path: string, field: FieldDef): FieldStat {
  const existing = ctx.stats.get(path);
  if (existing) return existing;
  const created: FieldStat = {
    name: path,
    type: field.type ?? 'text',
    selector: field.selector ?? '(record element)',
    hits: 0,
    misses: 0,
  };
  ctx.stats.set(path, created);
  return created;
}

function readValue(
  adapter: DomAdapter,
  node: Handle,
  field: FieldDef,
  baseUrl: string,
): string | number | null {
  const type = field.type ?? 'text';

  if (type === 'html') {
    const html = adapter.html(node);
    return html ? applyTransform(html, field.transform, baseUrl) : null;
  }

  if (type === 'attribute') {
    const name = field.attribute;
    if (!name) return null;
    const raw = adapter.attr(node, name);
    if (raw === undefined || raw === null || raw === '') return null;
    const absolute =
      field.transform === 'absolute' || (URL_ATTRS.has(name.toLowerCase()) && field.transform !== 'none')
        ? absolutize(raw, baseUrl) ?? raw.trim()
        : raw.trim();
    return applyTransform(absolute, field.transform === 'absolute' ? 'none' : field.transform, baseUrl);
  }

  const source = field.fromHtml ? adapter.html(node) : adapter.text(node);

  if (type === 'regex') {
    if (!field.pattern) return null;
    let re: RegExp;
    try {
      re = new RegExp(field.pattern, field.flags ?? '');
    } catch (err) {
      throw new Error(`Bad regex for field "${field.name}": ${String(err)}`);
    }
    const m = re.exec(source);
    if (!m) return null;
    const picked = m[field.group ?? 0];
    return picked === undefined ? null : applyTransform(picked, field.transform ?? 'trim', baseUrl);
  }

  if (type === 'number') {
    if (field.pattern) {
      const m = new RegExp(field.pattern, field.flags ?? '').exec(source);
      if (!m) return null;
      return parseNumberLike(m[field.group ?? 0] ?? '');
    }
    return parseNumberLike(source);
  }

  // text
  const text = source;
  return text ? applyTransform(text, field.transform ?? 'trim', baseUrl) : null;
}

function regexAll(field: FieldDef, source: string, baseUrl: string): string[] {
  if (!field.pattern) return [];
  const flags = field.flags?.includes('g') ? field.flags : (field.flags ?? '') + 'g';
  const re = new RegExp(field.pattern, flags);
  const out: string[] = [];
  for (const m of source.matchAll(re)) {
    const picked = m[field.group ?? 0];
    if (picked) out.push(applyTransform(picked, field.transform ?? 'trim', baseUrl));
  }
  return out;
}

function resolveField(ctx: FieldContext, record: Handle, field: FieldDef, path: string): unknown {
  const stat = statFor(ctx, path, field);
  const adapter = ctx.adapter;

  let nodes: Handle[] = [record];
  let scalar: string | undefined;

  if (field.selector) {
    const selector = adapter.normalizeSelector
      ? adapter.normalizeSelector(field.selector, true)
      : field.selector;
    const picked = adapter.select(record, selector);
    nodes = picked.nodes;
    scalar = picked.scalar;
    if (nodes.length === 0 && scalar === undefined && adapter.matchesSelf(record, selector)) {
      nodes = [record];
      ctx.diagnostics.push(
        `Field "${path}": selector "${field.selector}" matched the record element itself, not a descendant.`,
      );
    }
  }

  if (scalar !== undefined) {
    const value = applyTransform(scalar, field.transform ?? 'trim', ctx.baseUrl);
    if (value) {
      stat.hits++;
      return field.all ? [value] : value;
    }
    stat.misses++;
    return field.default ?? undefined;
  }

  if (nodes.length === 0) {
    stat.misses++;
    return field.default ?? undefined;
  }

  if ((field.type ?? 'text') === 'nested') {
    const sub = field.fields ?? [];
    if (sub.length === 0) {
      ctx.diagnostics.push(`Field "${path}" is nested but declares no sub-fields.`);
      stat.misses++;
      return undefined;
    }
    const build = (node: Handle) => {
      const obj: Record<string, unknown> = {};
      for (const sf of sub) {
        const value = resolveField(ctx, node, sf, `${path}.${sf.name}`);
        if (value !== undefined) obj[sf.name] = value;
      }
      return obj;
    };
    if (field.all === false) {
      const one = build(nodes[0]);
      const filled = Object.keys(one).length > 0;
      filled ? stat.hits++ : stat.misses++;
      return filled ? one : field.default ?? undefined;
    }
    const list = nodes.map(build).filter((o) => Object.keys(o).length > 0);
    list.length ? stat.hits++ : stat.misses++;
    return list.length ? list : field.default ?? undefined;
  }

  if (field.all) {
    const values: (string | number)[] = [];
    if ((field.type ?? 'text') === 'regex') {
      for (const node of nodes) {
        const source = field.fromHtml ? adapter.html(node) : adapter.text(node);
        values.push(...regexAll(field, source, ctx.baseUrl));
      }
    } else {
      for (const node of nodes) {
        const v = readValue(adapter, node, field, ctx.baseUrl);
        if (v !== null && v !== '') values.push(v);
      }
    }
    const unique = [...new Set(values)];
    unique.length ? stat.hits++ : stat.misses++;
    return unique.length ? unique : field.default ?? undefined;
  }

  for (const node of nodes) {
    const value = readValue(adapter, node, field, ctx.baseUrl);
    if (value !== null && value !== '') {
      stat.hits++;
      return value;
    }
  }
  stat.misses++;
  return field.default ?? undefined;
}

export function extractWithSchema(
  html: string,
  baseUrl: string,
  schema: ExtractionSchema,
): SchemaExtractionResult {
  const started = Date.now();
  const engine: SelectorEngine = schema.engine ?? 'css';
  const diagnostics: string[] = [];

  const adapter = engine === 'xpath' ? xpathAdapter(html, diagnostics) : cssAdapter(html);
  const baseSelectorRaw = (schema.baseSelector ?? '').trim();
  const baseSelector = adapter.normalizeSelector
    ? adapter.normalizeSelector(baseSelectorRaw, false)
    : baseSelectorRaw;

  let recordNodes: Handle[];
  if (!baseSelector) {
    recordNodes = [adapter.root()];
    diagnostics.push('No baseSelector given, so the whole document was treated as one record.');
  } else {
    const picked = adapter.select(adapter.root(), baseSelector);
    recordNodes = picked.nodes;
  }

  const baseMatches = recordNodes.length;
  const limit = schema.limit && schema.limit > 0 ? schema.limit : recordNodes.length;
  const used = recordNodes.slice(0, limit);

  const ctx: FieldContext = {
    adapter,
    baseUrl,
    diagnostics,
    stats: new Map(),
  };

  const records: Record<string, unknown>[] = [];
  for (const node of used) {
    const record: Record<string, unknown> = {};
    for (const field of schema.fields) {
      const value = resolveField(ctx, node, field, field.name);
      if (value !== undefined) record[field.name] = value;
    }
    if (Object.keys(record).length > 0) records.push(record);
  }

  if (baseMatches === 0 && baseSelector) {
    diagnostics.push(
      `baseSelector "${baseSelector}" (${engine}) matched 0 elements. Nothing else was tried.`,
    );
  } else if (records.length === 0) {
    diagnostics.push(
      `baseSelector matched ${baseMatches} element(s) but every field came back empty.`,
    );
    for (const node of used.slice(0, 3)) {
      diagnostics.push(`  record element looked like: <${adapter.describe(node)}>`);
    }
  }

  log.debug('schema extraction', {
    engine,
    baseSelector,
    baseMatches,
    records: records.length,
  });

  return {
    name: schema.name,
    engine,
    baseSelector: baseSelector || '(document)',
    baseMatches,
    records,
    fieldStats: [...ctx.stats.values()],
    // Per-record diagnostics repeat once per record; say each thing once.
    diagnostics: [...new Set(diagnostics)],
    elapsedMs: Date.now() - started,
  };
}

/* -------------------------------------------------------------------------- */
/* Built-in patterns                                                          */
/* -------------------------------------------------------------------------- */

export const PATTERN_KINDS = [
  'email',
  'phone',
  'price',
  'date',
  'url',
  'social',
  'postal',
] as const;
export type PatternKind = (typeof PATTERN_KINDS)[number];

export interface PatternHit {
  value: string;
  count: number;
  /** Extra detail: currency code, social network, postal country. */
  label?: string;
}

export interface PatternGroup {
  kind: PatternKind;
  /** What the pattern is, in words. */
  describes: string;
  hits: PatternHit[];
  /** Total raw matches before de-duplication. */
  matches: number;
  /** Candidates thrown out by validation. */
  rejected: number;
}

export interface PatternInput {
  text: string;
  /** Raw HTML, so `mailto:`/`href` values are not missed. */
  html?: string;
  baseUrl?: string;
}

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,24}\b/g;
const PHONE_RE =
  /(?:\+|00)?\d{1,3}[\s.\-/]?(?:\(\d{1,4}\)[\s.\-/]?)?\d{2,4}(?:[\s.\-/]?\d{2,4}){1,4}/g;
// Multi-character codes come first: alternation is ordered, so `$` must not
// win before `R$` has had a chance to match.
const CURRENCY_SYMBOLS =
  'R\\$|CHF|USD|EUR|GBP|JPY|INR|CAD|AUD|SEK|NOK|DKK|PLN|CZK|BRL|MXN|ZAR|\\$|€|£|¥|₹|₽|₩|₪|₺';
const PRICE_RE = new RegExp(
  `(?:(${CURRENCY_SYMBOLS})\\s?(\\d[\\d.,\\s\\u00a0]*\\d|\\d))|(?:(\\d[\\d.,\\s\\u00a0]*\\d|\\d)\\s?(${CURRENCY_SYMBOLS}))`,
  'gi',
);
const DATE_RE = new RegExp(
  [
    '\\b\\d{4}-\\d{2}-\\d{2}(?:[T ]\\d{2}:\\d{2}(?::\\d{2})?)?\\b',
    '\\b\\d{1,2}[/.]\\d{1,2}[/.]\\d{2,4}\\b',
    '\\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?\\s+\\d{1,2},?\\s+\\d{4}\\b',
    '\\b\\d{1,2}\\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?\\s+\\d{4}\\b',
  ].join('|'),
  'gi',
);
const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]}]+/gi;
const POSTAL_RES: { label: string; re: RegExp }[] = [
  { label: 'US ZIP', re: /\b\d{5}(?:-\d{4})?\b/g },
  { label: 'UK', re: /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/g },
  { label: 'Canada', re: /\b[A-CEGHJ-NPR-TVXY]\d[A-CEGHJ-NPR-TV-Z]\s?\d[A-CEGHJ-NPR-TV-Z]\d\b/g },
  { label: 'India PIN', re: /\b[1-9]\d{2}\s?\d{3}\b/g },
];
const SOCIAL_RES: { label: string; re: RegExp }[] = [
  { label: 'x/twitter', re: /(?:https?:\/\/)?(?:www\.)?(?:twitter|x)\.com\/(?!(?:home|share|intent|i|search)\b)([A-Za-z0-9_]{2,15})/gi },
  { label: 'github', re: /(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?)(?:\/|\b)/gi },
  { label: 'linkedin', re: /(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/(?:in|company)\/([A-Za-z0-9\-_%]{2,100})/gi },
  { label: 'instagram', re: /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?!(?:p|reel|explore|accounts|share)\b)([A-Za-z0-9_.]{2,30})/gi },
  // `facebook.com/sharer`, `/dialog`, `/tr` and friends are widgets, not profiles.
  { label: 'facebook', re: /(?:https?:\/\/)?(?:www\.)?facebook\.com\/(?!(?:sharer|share|dialog|plugins|tr|profile\.php|login|v\d)\b)([A-Za-z0-9.\-]{3,60})/gi },
  { label: 'youtube', re: /(?:https?:\/\/)?(?:www\.)?youtube\.com\/(?:@|c\/|channel\/|user\/)(?!(?:watch|embed)\b)([A-Za-z0-9_\-.]{2,60})/gi },
  { label: 'mastodon', re: /@([A-Za-z0-9_]{2,30})@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g },
];

/**
 * Luhn, same check `util/redact.ts` uses before masking a card. Needed here
 * for the opposite reason: a 16-digit run that passes Luhn is a payment card,
 * not a phone number and not a price, so we drop it from those groups rather
 * than reporting "€4 532 123 456 789 018".
 */
function looksLikeCardNumber(value: string): boolean {
  const n = value.replace(/\D/g, '');
  if (n.length < 13 || n.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = n.length - 1; i >= 0; i--) {
    let d = n.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

const IMAGE_TAIL = /\.(?:png|jpe?g|gif|webp|svg|ico|bmp|avif)$/i;

function validEmail(value: string): boolean {
  const lower = value.toLowerCase();
  // `logo@2x.png`, `sprite@3x.webp` and friends are not addresses.
  if (IMAGE_TAIL.test(lower)) return false;
  if (/@\d+x$/.test(lower)) return false;
  const [local, domain] = lower.split('@');
  if (!local || !domain || local.length > 64 || domain.length > 253) return false;
  if (domain.includes('..') || domain.startsWith('-')) return false;
  if (/^(?:example|test|localhost|sentry|wixpress)\./.test(domain)) return false;
  return true;
}

function validPhone(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 15) return false;
  if (looksLikeCardNumber(value)) return false;
  // Version strings, ids and timestamps masquerade as phone numbers.
  if (/^\d{4}-\d{2}-\d{2}/.test(value.trim())) return false;
  if (/^(\d)\1+$/.test(digits)) return false;
  // A real number is written with separators or a country prefix.
  if (!/[\s.\-/()+]/.test(value.trim()) && digits.length > 11) return false;
  return true;
}

function validPrice(amount: string): boolean {
  if (looksLikeCardNumber(amount)) return false;
  const digits = amount.replace(/\D/g, '');
  if (digits.length === 0 || digits.length > 12) return false;
  const n = parseNumberLike(amount);
  return n !== null && Number.isFinite(n);
}

function pushHit(map: Map<string, PatternHit>, value: string, label?: string): void {
  const key = label ? `${label}\u0000${value}` : value;
  const existing = map.get(key);
  if (existing) existing.count++;
  else map.set(key, { value, count: 1, label });
}

/** Real link targets: `href`, `src` and their lazy-loading variants. */
function linkValues(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/\b(?:href|src|data-href|data-src)\s*=\s*["']([^"']{2,500})["']/gi)) {
    out.push(m[1]);
  }
  return out;
}

/** `content="..."` holds canonical URLs — and also prose, so it is scanned, not resolved. */
function metaValues(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/\bcontent\s*=\s*["']([^"']{2,500})["']/gi)) out.push(m[1]);
  return out;
}

/**
 * Ready-made extractors that need no schema at all: run them at any page and
 * see what is actually there. Every group reports how many candidates were
 * rejected by validation, so a thin result does not look like an empty page.
 */
export function extractPatterns(
  input: PatternInput,
  kinds: PatternKind[] = [...PATTERN_KINDS],
  limitPerKind = 50,
): PatternGroup[] {
  const text = input.text ?? '';
  const html = input.html ?? '';
  const hrefs = html ? linkValues(html) : [];
  const hrefBlob = [...hrefs, ...(html ? metaValues(html) : [])].join('\n');
  const wanted = new Set(kinds);
  const groups: PatternGroup[] = [];

  const finish = (
    kind: PatternKind,
    describes: string,
    map: Map<string, PatternHit>,
    matches: number,
    rejected: number,
  ) => {
    const hits = [...map.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    groups.push({ kind, describes, hits: hits.slice(0, limitPerKind), matches, rejected });
  };

  if (wanted.has('email')) {
    const map = new Map<string, PatternHit>();
    let matches = 0;
    let rejected = 0;
    const sources = [text, decodeURIComponent(hrefBlob.replace(/%(?![0-9a-f]{2})/gi, '%25'))];
    for (const source of sources) {
      for (const m of source.matchAll(EMAIL_RE)) {
        matches++;
        if (validEmail(m[0])) pushHit(map, m[0].toLowerCase());
        else rejected++;
      }
    }
    finish('email', 'email addresses in text and mailto: links', map, matches, rejected);
  }

  if (wanted.has('phone')) {
    const map = new Map<string, PatternHit>();
    let matches = 0;
    let rejected = 0;
    for (const m of text.matchAll(PHONE_RE)) {
      matches++;
      if (validPhone(m[0])) pushHit(map, collapseWs(m[0]));
      else rejected++;
    }
    for (const href of hrefs) {
      if (!/^tel:/i.test(href)) continue;
      matches++;
      const value = href.slice(4).trim();
      if (validPhone(value)) pushHit(map, value);
      else rejected++;
    }
    finish('phone', '9-15 digit phone numbers (card numbers excluded by Luhn)', map, matches, rejected);
  }

  if (wanted.has('price')) {
    const map = new Map<string, PatternHit>();
    let matches = 0;
    let rejected = 0;
    for (const m of text.matchAll(PRICE_RE)) {
      matches++;
      const currency = (m[1] ?? m[4] ?? '').trim();
      const amount = (m[2] ?? m[3] ?? '').trim();
      if (!validPrice(amount)) {
        rejected++;
        continue;
      }
      pushHit(map, collapseWs(m[0]), currency.toUpperCase() || undefined);
    }
    finish('price', 'amounts carrying a currency symbol or ISO code', map, matches, rejected);
  }

  if (wanted.has('date')) {
    const map = new Map<string, PatternHit>();
    let matches = 0;
    for (const m of text.matchAll(DATE_RE)) {
      matches++;
      pushHit(map, collapseWs(m[0]));
    }
    finish('date', 'ISO, numeric and written-month dates', map, matches, 0);
  }

  if (wanted.has('url')) {
    const map = new Map<string, PatternHit>();
    let matches = 0;
    for (const source of [text, hrefBlob]) {
      for (const m of source.matchAll(URL_RE)) {
        matches++;
        pushHit(map, m[0].replace(/[.,;:]+$/, ''));
      }
    }
    if (input.baseUrl) {
      for (const href of hrefs) {
        if (/^(?:https?:|mailto:|tel:|data:|#|javascript:)/i.test(href)) continue;
        // A relative link is a path, not a sentence.
        if (/\s|%20/.test(href)) continue;
        const abs = absolutize(href, input.baseUrl);
        if (abs) {
          matches++;
          pushHit(map, abs);
        }
      }
    }
    finish('url', 'absolute http(s) URLs, including resolved relative links', map, matches, 0);
  }

  if (wanted.has('social')) {
    const map = new Map<string, PatternHit>();
    let matches = 0;
    const blob = text + '\n' + hrefBlob;
    for (const { label, re } of SOCIAL_RES) {
      for (const m of blob.matchAll(re)) {
        matches++;
        const handle = label === 'mastodon' ? `@${m[1]}@${m[2]}` : m[1];
        if (!handle) continue;
        pushHit(map, handle, label);
      }
    }
    finish('social', 'handles for x, github, linkedin, instagram, facebook, youtube, mastodon', map, matches, 0);
  }

  if (wanted.has('postal')) {
    const map = new Map<string, PatternHit>();
    let matches = 0;
    for (const { label, re } of POSTAL_RES) {
      for (const m of text.matchAll(re)) {
        matches++;
        pushHit(map, collapseWs(m[0]), label);
      }
    }
    finish('postal', 'US ZIP, UK, Canadian and Indian postal codes (shape only)', map, matches, 0);
  }

  return groups;
}

/* -------------------------------------------------------------------------- */
/* Schema generator                                                           */
/* -------------------------------------------------------------------------- */

export interface GenerateSchemaOptions {
  /** Plain-language description of the wanted records, e.g. "product cards". */
  description?: string;
  /** A couple of values you can see on the page; used to anchor the container. */
  examples?: string[];
  /** A repeating container must have at least this many members. Default 3. */
  minRecords?: number;
  /** Cap on proposed fields. Default 8. */
  maxFields?: number;
}

export interface SchemaCandidate {
  selector: string;
  members: number;
  score: number;
  reasons: string[];
}

export interface GeneratedSchema {
  schema: ExtractionSchema;
  /** 0-1, from field coverage, structural similarity and member count. */
  confidence: number;
  candidates: SchemaCandidate[];
  coverage: { records: number; perField: Record<string, number> };
  sample: Record<string, unknown>[];
  notes: string[];
}

const SKIP_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'svg', 'path', 'head', 'meta', 'link', 'br', 'hr',
]);

/**
 * Classes that are generated rather than written: hashes and CSS-module
 * suffixes. A generated name changes on the next deploy, so a schema built on
 * one is worthless. The test is deliberately narrow — it must not reject
 * ordinary snake_case names like `price_color`, which are exactly what a
 * schema wants to hang on.
 */
function isStableClass(cls: string): boolean {
  if (cls.length < 2 || cls.length > 40) return false;
  if (/\d{3,}/.test(cls)) return false;
  if (/^(?:css|sc|jsx|emotion|styled)-/i.test(cls)) return false;
  // A trailing segment of 5+ characters containing a digit is a build hash.
  const tail = /[-_]{1,2}([A-Za-z0-9]{5,})$/.exec(cls)?.[1];
  if (tail && /\d/.test(tail)) return false;
  return true;
}

function classesOf(el: Element): string[] {
  const raw = typeof el.attribs?.class === 'string' ? el.attribs.class : '';
  return raw.trim().split(/\s+/).filter((c) => c && isStableClass(c));
}

function cssEscapeClass(cls: string): string {
  return cls.replace(/([^\w-])/g, '\\$1');
}

function signatureOf(el: Element): string {
  return `${el.tagName}|${classesOf(el).slice().sort().join('.')}`;
}

function tagMultiset($: cheerio.CheerioAPI, el: Element): Set<string> {
  const out = new Set<string>();
  $(el)
    .find('*')
    .slice(0, 120)
    .each((_i, d) => {
      const tag = (d as Element).tagName;
      if (tag && !SKIP_TAGS.has(tag)) out.add(tag);
    });
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const v of a) if (b.has(v)) inter++;
  return inter / (a.size + b.size - inter || 1);
}

const PRICE_TEXT = new RegExp(`(?:${CURRENCY_SYMBOLS})\\s?\\d|\\d\\s?(?:${CURRENCY_SYMBOLS})`, 'i');

function describeKeywords(description?: string): string[] {
  if (!description) return [];
  const stop = new Set(['the', 'and', 'for', 'with', 'all', 'each', 'every', 'from', 'that', 'this', 'their', 'its', 'get', 'list', 'page', 'records', 'record', 'items', 'item']);
  return [...new Set((description.toLowerCase().match(/[a-z][a-z-]{2,}/g) ?? []).filter((w) => !stop.has(w)))];
}

/** Singular/plural tolerant containment, so "products" matches `.product-card`. */
function keywordMatches(keyword: string, haystack: string): boolean {
  if (haystack.includes(keyword)) return true;
  if (keyword.endsWith('s') && haystack.includes(keyword.slice(0, -1))) return true;
  if (keyword.endsWith('ies') && haystack.includes(keyword.slice(0, -3) + 'y')) return true;
  return false;
}

interface Group {
  parent: Element;
  members: Element[];
  signature: string;
}

function findGroups($: cheerio.CheerioAPI, minRecords: number): Group[] {
  const groups: Group[] = [];
  const parents = [$.root()[0] as unknown as Element, ...($('*').toArray() as Element[])];
  for (const parent of parents) {
    const kids = $(parent)
      .children()
      .toArray()
      .filter((k) => (k as Element).tagName && !SKIP_TAGS.has((k as Element).tagName)) as Element[];
    if (kids.length < minRecords) continue;

    const bySignature = new Map<string, Element[]>();
    for (const kid of kids) {
      const sig = signatureOf(kid);
      const list = bySignature.get(sig);
      if (list) list.push(kid);
      else bySignature.set(sig, [kid]);
    }
    // Same tag, different classes still forms a repeating set worth considering.
    const byTag = new Map<string, Element[]>();
    for (const kid of kids) {
      const list = byTag.get(kid.tagName);
      if (list) list.push(kid);
      else byTag.set(kid.tagName, [kid]);
    }

    const seen = new Set<string>();
    for (const [signature, members] of [...bySignature, ...byTag]) {
      if (members.length < minRecords) continue;
      // The tag grouping often reproduces a signature grouping exactly.
      const key = `${members.length}|${kids.indexOf(members[0])}|${kids.indexOf(members[members.length - 1])}`;
      if (seen.has(key)) continue;
      seen.add(key);
      groups.push({ parent, members: unwrapSingleChildren($, members), signature });
    }
  }
  return groups;
}

/**
 * A grid item that only wraps one element adds nothing but a layout class.
 * `li.col-xs-6 > article.product_pod` is better described by the article: the
 * class is semantic, so the schema still works after a redesign of the grid.
 */
function unwrapSingleChildren($: cheerio.CheerioAPI, members: Element[]): Element[] {
  let current = members;
  for (let depth = 0; depth < 2; depth++) {
    const children = current.map((m) => {
      const kids = $(m)
        .children()
        .toArray()
        .filter((k) => (k as Element).tagName && !SKIP_TAGS.has((k as Element).tagName)) as Element[];
      return kids.length === 1 ? kids[0] : null;
    });
    if (children.some((c) => c === null)) return current;
    const kept = children as Element[];
    const shared = kept
      .map((c) => new Set(classesOf(c)))
      .reduce((acc, set) => new Set([...acc].filter((c) => set.has(c))));
    if (shared.size === 0) return current;
    current = kept;
  }
  return current;
}

function selectorForElement($: cheerio.CheerioAPI, el: Element): string {
  const id = el.attribs?.id;
  if (id && /^[A-Za-z][\w-]*$/.test(id)) return `#${id}`;
  const classes = classesOf(el);
  if (classes.length) return `${el.tagName}.${classes.slice(0, 2).map(cssEscapeClass).join('.')}`;
  return el.tagName;
}

function baseSelectorFor($: cheerio.CheerioAPI, group: Group): string | null {
  const { members } = group;
  // Derived from the members, not group.parent, because single-child wrappers
  // may have been unwrapped since the group was formed.
  const parent = ($(members[0]).parent()[0] ?? group.parent) as Element;
  const tag = members[0].tagName;
  const shared = members
    .map((m) => new Set(classesOf(m)))
    .reduce((acc, set) => new Set([...acc].filter((c) => set.has(c))));

  const sharedList = [...shared].slice(0, 3).map(cssEscapeClass);
  const candidates: string[] = [];
  if (sharedList.length) candidates.push(`${tag}.${sharedList.join('.')}`, `.${sharedList.join('.')}`);
  candidates.push(tag);

  const parentIsRoot = !(parent as Element).tagName;
  const parentSel = parentIsRoot ? '' : selectorForElement($, parent);

  for (const cand of candidates) {
    const qualified = parentSel ? `${parentSel} > ${cand}` : cand;
    for (const sel of [cand, qualified]) {
      let hits: number;
      try {
        hits = $(sel).length;
      } catch {
        continue;
      }
      if (hits >= members.length && hits <= Math.max(members.length * 1.5, members.length + 2)) {
        return sel;
      }
    }
  }
  // Nothing clean: fall back to the qualified form and let the caller see the count.
  if (sharedList.length) {
    const cand = `${tag}.${sharedList.join('.')}`;
    return parentSel ? `${parentSel} > ${cand}` : cand;
  }
  return parentSel ? `${parentSel} > ${tag}` : null;
}

interface FieldCandidate {
  selector: string;
  role: string;
  type: FieldType;
  attribute?: string;
  pattern?: string;
  presence: number;
  distinct: number;
  values: string[];
  depth: number;
  /** True when the chosen selector matches more than this one element. */
  ambiguous: boolean;
}

/**
 * Structural identity of a descendant inside its record, so the same element
 * reached by `.thumbnail`, `img` and `img.thumbnail` is recognised as one
 * field instead of three.
 */
function pathWithin($: cheerio.CheerioAPI, record: Element, el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node !== record) {
    const index = $(node).parent().children().toArray().indexOf(node);
    parts.unshift(`${node.tagName}:${index}`);
    node = ($(node).parent()[0] ?? null) as Element | null;
  }
  return parts.join('/');
}

/** Best relative selector for one element: shortest that still finds only it. */
function relativeSelector(
  $: cheerio.CheerioAPI,
  record: Element,
  el: Element,
): { selector: string; ambiguous: boolean } | null {
  const classes = classesOf(el);
  const options: string[] = [];
  for (const cls of classes.slice(0, 2)) options.push(`.${cssEscapeClass(cls)}`);
  if (classes.length) options.push(`${el.tagName}.${cssEscapeClass(classes[0])}`);
  options.push(el.tagName);

  // A bare tag is often ambiguous (`a` appears twice in a product card), so
  // offer ancestor-qualified forms like `h3 a` before giving up on precision.
  let ancestor = ($(el).parent()[0] ?? null) as Element | null;
  for (let up = 0; up < 2 && ancestor && ancestor !== record; up++) {
    const ancestorClasses = classesOf(ancestor);
    const prefix = ancestorClasses.length
      ? `${ancestor.tagName}.${cssEscapeClass(ancestorClasses[0])}`
      : ancestor.tagName;
    options.push(`${prefix} ${classes.length ? `${el.tagName}.${cssEscapeClass(classes[0])}` : el.tagName}`);
    ancestor = ($(ancestor).parent()[0] ?? null) as Element | null;
  }

  let fallback: { selector: string; ambiguous: boolean } | null = null;
  for (const selector of [...new Set(options)]) {
    let matched: Element[];
    try {
      matched = $(record).find(selector).toArray() as Element[];
    } catch {
      continue;
    }
    if (matched.length === 1 && matched[0] === el) return { selector, ambiguous: false };
    if (!fallback && matched.includes(el)) fallback = { selector, ambiguous: true };
  }
  return fallback;
}

function nameFromRole(role: string, classes: string[], used: Set<string>): string {
  const byRole: Record<string, string> = {
    heading: 'title',
    link: 'url',
    image: 'image',
    price: 'price',
    date: 'date',
  };
  // A class name beats a generic role label when there is one.
  const semantic = classes.find((c) => /^[a-z][a-z-]{2,}$/i.test(c) && !/^(?:col|row|grid|flex|text|item|wrapper)/i.test(c));
  let base = semantic && (role === 'text' || role === 'linktext') ? undefined : byRole[role];
  if (!base) {
    const cls = classes.find((c) => /^[a-z][a-z-]{2,}$/i.test(c));
    base = cls
      ? cls.replace(/^(?:js|is|has)-/, '').replace(/[-_]+/g, '_').toLowerCase()
      : 'field';
  }
  let name = base;
  let n = 2;
  while (used.has(name)) name = `${base}${n++}`;
  used.add(name);
  return name;
}

function proposeFields(
  $: cheerio.CheerioAPI,
  members: Element[],
  opts: GenerateSchemaOptions,
  notes: string[],
): FieldDef[] {
  const maxFields = opts.maxFields ?? 8;
  const examples = (opts.examples ?? []).map((e) => e.trim()).filter(Boolean);
  const candidates = new Map<string, FieldCandidate>();
  const sampleSize = Math.min(members.length, 12);

  interface Proposal {
    role: string;
    type: FieldType;
    attribute?: string;
    pattern?: string;
    value: string;
  }

  for (let i = 0; i < sampleSize; i++) {
    const record = members[i];
    const descendants = $(record).find('*').toArray().slice(0, 200) as Element[];
    for (const el of descendants) {
      const tag = el.tagName;
      if (!tag || SKIP_TAGS.has(tag)) continue;

      const $el = $(el);
      const text = collapseWs($el.text());
      const depth = $el.parentsUntil(record).length;
      const proposals: Proposal[] = [];

      if (/^h[1-6]$/.test(tag)) {
        if (text) proposals.push({ role: 'heading', type: 'text', value: text });
      } else if (tag === 'a') {
        const href = $el.attr('href');
        if (href) proposals.push({ role: 'link', type: 'attribute', attribute: 'href', value: href });
        // Listing markup often truncates the visible text and keeps the full
        // string in `title`; that attribute is then the better field. Offer
        // both and let scoring choose, because the same template truncates
        // some rows and not others.
        const title = $el.attr('title');
        if (title) proposals.push({ role: 'heading', type: 'attribute', attribute: 'title', value: title });
        if (text && text.length < 200) {
          // A link that *is* the heading should be filed as one.
          const inHeading = /^h[1-6]$/.test((($el.parent()[0] ?? {}) as Element).tagName ?? '');
          proposals.push({ role: inHeading ? 'heading' : 'linktext', type: 'text', value: text });
        }
      } else if (tag === 'img') {
        const attribute = $el.attr('src') ? 'src' : 'data-src';
        const value = $el.attr(attribute);
        if (value) proposals.push({ role: 'image', type: 'attribute', attribute, value });
      } else if (tag === 'time' && $el.attr('datetime')) {
        proposals.push({ role: 'date', type: 'attribute', attribute: 'datetime', value: $el.attr('datetime') ?? '' });
      } else if (text && PRICE_TEXT.test(text) && text.length < 60) {
        // Store the value the field would really produce, so a wrapper that
        // repeats its child's price is recognised as the same field.
        const pattern = '[0-9][0-9.,]*';
        const amount = new RegExp(pattern).exec(text)?.[0] ?? text;
        proposals.push({ role: 'price', type: 'regex', pattern, value: amount });
      } else if (text && text.length <= 400 && $el.children().length <= 3) {
        proposals.push({ role: 'text', type: 'text', value: text });
      }

      if (proposals.length === 0) continue;
      const resolved = relativeSelector($, record, el);
      if (!resolved) continue;
      const path = pathWithin($, record, el);

      for (const p of proposals) {
        if (!p.value) continue;
        // One entry per (element, role, attribute): the same element reached by
        // three different selectors is still one field.
        const key = `${path}|${p.role}|${p.attribute ?? ''}`;
        const entry = candidates.get(key) ?? {
          selector: resolved.selector,
          role: p.role,
          type: p.type,
          attribute: p.attribute,
          pattern: p.pattern,
          presence: 0,
          distinct: 0,
          values: [],
          depth,
          ambiguous: resolved.ambiguous,
        };
        entry.presence++;
        entry.values.push(p.value.slice(0, 120));
        candidates.set(key, entry);
      }
    }
  }

  // A wrapper that contains only one meaningful child reports the same value
  // as that child. Keep the deeper, more specific one.
  const byValue = new Map<string, { path: string; key: string }[]>();
  for (const [key, c] of candidates) {
    const path = key.split('|')[0];
    const signature = `${c.role}|${c.attribute ?? ''}|${c.values.join('\u0000')}`;
    const list = byValue.get(signature);
    if (list) list.push({ path, key });
    else byValue.set(signature, [{ path, key }]);
  }
  for (const list of byValue.values()) {
    if (list.length < 2) continue;
    const deepest = list.reduce((a, b) => (b.path.length > a.path.length ? b : a));
    for (const entry of list) {
      if (entry.key !== deepest.key && deepest.path.startsWith(entry.path)) {
        candidates.delete(entry.key);
      }
    }
  }

  // When a `title` attribute carries the untruncated heading, the visible-text
  // candidate for the same element (and for its heading parent) is redundant.
  for (const [key, c] of [...candidates]) {
    if (c.role !== 'heading' || c.attribute !== 'title') continue;
    const path = key.split('|')[0];
    const titleLength = c.values.join('').length;
    for (const [otherKey, other] of [...candidates]) {
      if (otherKey === key || other.role !== 'heading' || other.attribute) continue;
      const otherPath = otherKey.split('|')[0];
      if (path.startsWith(otherPath) && other.values.join('').length <= titleLength) {
        candidates.delete(otherKey);
      }
    }
  }

  const exampleHit = (values: string[]) =>
    examples.some((ex) => values.some((v) => v.toLowerCase().includes(ex.toLowerCase())));

  const keywords = describeKeywords(opts.description);

  const scored = [...candidates.values()]
    .map((c) => {
      c.distinct = new Set(c.values).size;
      const presenceRatio = c.presence / sampleSize;
      let score = presenceRatio * 40 + Math.min(c.distinct / sampleSize, 1) * 25;
      if (c.role === 'heading') score += 30;
      if (c.role === 'link') score += 22;
      if (c.role === 'price') score += 24;
      if (c.role === 'linktext') score += 14;
      if (c.role === 'image') score += 10;
      if (c.role === 'date') score += 8;
      if (exampleHit(c.values)) score += 40;
      if (keywords.some((k) => keywordMatches(k, c.selector.toLowerCase()))) score += 12;
      // Constant text across every record is a label, not data.
      if (c.distinct === 1 && c.presence >= sampleSize && (c.role === 'text' || c.role === 'linktext')) {
        score -= 35;
      }
      if (c.ambiguous) score -= 12;
      score -= Math.max(0, c.depth - 3) * 3;
      return { c, score };
    })
    .filter(({ c, score }) => c.presence >= Math.max(1, Math.ceil(sampleSize * 0.5)) && score > 0)
    .sort((a, b) => b.score - a.score);

  const used = new Set<string>();
  const takenSelectors = new Set<string>();
  const fields: FieldDef[] = [];

  // Two passes: the best field per role first, so a schema covers title, url,
  // price and image before it spends slots on a second link.
  const seenRoles = new Set<string>();
  const bestPerRole = scored.filter(({ c }) => {
    if (seenRoles.has(c.role)) return false;
    seenRoles.add(c.role);
    return true;
  });
  const ordered = [...bestPerRole, ...scored];

  for (const { c } of ordered) {
    if (fields.length >= maxFields) break;
    const key = `${c.selector}|${c.attribute ?? ''}`;
    if (takenSelectors.has(key)) continue;
    takenSelectors.add(key);
    const classes = c.selector.replace(/^[a-z]+/i, '').split('.').filter(Boolean);
    const name = nameFromRole(c.role, classes, used);
    const field: FieldDef = { name, selector: c.selector, type: c.type };
    if (c.attribute) field.attribute = c.attribute;
    if (c.pattern) field.pattern = c.pattern;
    fields.push(field);
    if (c.ambiguous) {
      notes.push(`Field "${name}" selector \`${c.selector}\` matches several elements per record; the first is used.`);
    }
  }

  if (examples.length) {
    const found = examples.filter((ex) =>
      scored.some(({ c }) => c.values.some((v) => v.toLowerCase().includes(ex.toLowerCase()))),
    );
    const missing = examples.filter((ex) => !found.includes(ex));
    if (missing.length) {
      notes.push(`Example value(s) not located inside the chosen container: ${missing.join(', ')}`);
    }
  }

  return fields;
}

/**
 * Infer a reusable schema from a page by looking at its structure.
 *
 * Deterministic: find sibling elements that repeat with the same shape, score
 * them (how many, how similar, do they carry a heading/link/price, do they
 * contain the caller's example values, do their class names echo the caller's
 * description), then propose a field per distinctive descendant. No model is
 * involved, so the same page always yields the same schema.
 */
export function generateSchema(
  html: string,
  baseUrl: string,
  opts: GenerateSchemaOptions = {},
): GeneratedSchema {
  const minRecords = Math.max(2, opts.minRecords ?? 3);
  const notes: string[] = [];
  const $ = cheerio.load(html);
  $('script, style, noscript, template, svg, head, iframe').remove();
  $('*')
    .contents()
    .filter((_i, n) => n.type === 'comment')
    .remove();

  const keywords = describeKeywords(opts.description);
  const examples = (opts.examples ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean);
  const groups = findGroups($, minRecords);

  const scoredGroups = groups
    .map((group) => {
      const members = group.members;
      const sample = members.slice(0, 8);
      const sets = sample.map((m) => tagMultiset($, m));
      let similarity = 1;
      if (sets.length > 1) {
        let total = 0;
        let pairs = 0;
        for (let i = 0; i < sets.length; i++) {
          for (let j = i + 1; j < sets.length; j++) {
            total += jaccard(sets[i], sets[j]);
            pairs++;
          }
        }
        similarity = pairs ? total / pairs : 1;
      }

      const texts = sample.map((m) => collapseWs($(m).text()));
      const avgLen = texts.reduce((a, b) => a + b.length, 0) / Math.max(texts.length, 1);
      const distinctTexts = new Set(texts).size;
      const hasHeading = sample.some((m) => $(m).find('h1,h2,h3,h4,h5,h6').length > 0);
      const hasLink = sample.some((m) => $(m).find('a[href]').length > 0);
      const hasImage = sample.some((m) => $(m).find('img').length > 0);
      const hasPrice = texts.some((t) => PRICE_TEXT.test(t));

      const reasons: string[] = [];
      let score = Math.log2(members.length + 1) * 10 + similarity * 45;
      reasons.push(`${members.length} siblings`, `similarity ${similarity.toFixed(2)}`);

      if (avgLen < 12) {
        score -= 30;
        reasons.push('members nearly empty');
      } else if (avgLen > 4000) {
        score -= 15;
        reasons.push('members very large');
      } else {
        score += Math.min(avgLen / 60, 12);
      }
      if (distinctTexts <= 1) {
        score -= 40;
        reasons.push('all members identical');
      }
      // A container identified by a written class name survives a redesign of
      // the surrounding layout far better than one identified by tag alone.
      const sharedClasses = sample
        .map((m) => new Set(classesOf(m)))
        .reduce((acc, set) => new Set([...acc].filter((c) => set.has(c))));
      if (sharedClasses.size > 0) {
        score += 8;
        reasons.push(`shared class .${[...sharedClasses][0]}`);
      }
      if (hasHeading) { score += 14; reasons.push('heading'); }
      if (hasLink) { score += 10; reasons.push('link'); }
      if (hasImage) { score += 5; reasons.push('image'); }
      if (hasPrice) { score += 10; reasons.push('price-like text'); }

      const descriptor = (
        group.signature +
        ' ' +
        (group.parent as Element).tagName +
        ' ' +
        ((group.parent as Element).attribs?.class ?? '') +
        ' ' +
        ((group.parent as Element).attribs?.id ?? '')
      ).toLowerCase();
      const keywordHits = keywords.filter((k) => keywordMatches(k, descriptor)).length;
      if (keywordHits) {
        score += keywordHits * 18;
        reasons.push(`description match x${keywordHits}`);
      }

      if (examples.length) {
        const blob = texts.join('\n').toLowerCase() + '\n' + sample.map((m) => $(m).html() ?? '').join('\n').toLowerCase();
        const exHits = examples.filter((ex) => blob.includes(ex)).length;
        if (exHits) {
          score += (exHits / examples.length) * 60;
          reasons.push(`${exHits}/${examples.length} examples inside`);
        } else {
          score -= 25;
        }
      }

      const inChrome = $(members[0]).parents('nav, footer, header, aside').length > 0;
      if (inChrome) {
        score -= 25;
        reasons.push('inside nav/header/footer');
      }

      return { group, score, similarity, reasons };
    })
    .sort((a, b) => b.score - a.score);

  const candidates: SchemaCandidate[] = [];
  for (const entry of scoredGroups.slice(0, 6)) {
    const sel = baseSelectorFor($, entry.group);
    candidates.push({
      selector: sel ?? `${entry.group.members[0].tagName} (no stable selector)`,
      members: entry.group.members.length,
      score: Math.round(entry.score * 10) / 10,
      reasons: entry.reasons,
    });
  }

  if (scoredGroups.length === 0) {
    notes.push(
      `No element had ${minRecords} or more similarly-shaped sibling elements. ` +
        'This page may not be a listing, or the records may be rendered by JavaScript — ' +
        'retry with render:"browser", or lower minRecords.',
    );
    return {
      schema: { name: opts.description?.slice(0, 60), fields: [] },
      confidence: 0,
      candidates,
      coverage: { records: 0, perField: {} },
      sample: [],
      notes,
    };
  }

  // Walk the ranked candidates until one actually extracts something.
  let best: GeneratedSchema | null = null;
  for (const entry of scoredGroups.slice(0, 5)) {
    const baseSelector = baseSelectorFor($, entry.group);
    if (!baseSelector) continue;
    const localNotes: string[] = [];
    const fields = proposeFields($, entry.group.members, opts, localNotes);
    if (fields.length === 0) continue;

    const schema: ExtractionSchema = {
      name: opts.description?.slice(0, 60),
      baseSelector,
      engine: 'css',
      fields,
    };
    const check = extractWithSchema(html, baseUrl, schema);
    const perField: Record<string, number> = {};
    for (const stat of check.fieldStats) {
      perField[stat.name] = check.records.length
        ? Math.round((stat.hits / Math.max(check.baseMatches, 1)) * 100) / 100
        : 0;
    }
    const filledRatio =
      Object.values(perField).reduce((a, b) => a + b, 0) / Math.max(Object.keys(perField).length, 1);
    const confidence =
      Math.round(
        Math.min(
          1,
          filledRatio * 0.55 +
            entry.similarity * 0.25 +
            Math.min(check.records.length / 10, 1) * 0.2,
        ) * 100,
      ) / 100;

    const result: GeneratedSchema = {
      schema,
      confidence,
      candidates,
      coverage: { records: check.records.length, perField },
      sample: check.records.slice(0, 3),
      notes: [...notes, ...localNotes, ...check.diagnostics.slice(0, 3)],
    };
    if (check.records.length > 0) {
      best = result;
      break;
    }
    best ??= result;
  }

  if (!best) {
    notes.push(
      'Repeating containers were found but none produced usable fields. ' +
        `Best container tried: ${candidates[0]?.selector ?? 'n/a'}.`,
    );
    return {
      schema: {
        name: opts.description?.slice(0, 60),
        baseSelector: candidates[0]?.selector,
        engine: 'css',
        fields: [],
      },
      confidence: 0,
      candidates,
      coverage: { records: 0, perField: {} },
      sample: [],
      notes,
    };
  }

  return best;
}
