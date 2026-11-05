/**
 * Brand extraction: logo, colours, fonts.
 *
 * Firecrawl bills this as a `branding` format. Doing it locally has one real
 * difficulty: the interesting values are in CSS, and CSS is not in the HTML.
 * So this works in two tiers:
 *
 *   free      everything already in the document — theme-color, inline
 *             <style> blocks, style="" attributes, Google Fonts links, icons,
 *             manifest references, og:image, schema.org logo
 *   one hop   up to `maxStylesheets` same-origin stylesheets, fetched and
 *             scanned. Off by default, because it costs requests the caller
 *             did not ask for.
 *
 * Colour ranking is by weighted frequency rather than raw count. A colour
 * declared once in a CSS custom property is usually the brand colour; a colour
 * repeated forty times is usually a border. Declarations in `:root` and in
 * custom properties are therefore weighted up, and greys are weighted down,
 * because `#ccc` appearing most often says nothing about a brand.
 */
import type * as cheerio from 'cheerio';
import { absolutize } from '../util/url.js';
import { log } from '../util/log.js';

export interface BrandColour {
  /** Normalised to lowercase 6-digit hex where possible, else as written. */
  value: string;
  /** How many declarations mentioned it. */
  count: number;
  /** Ranking weight after the adjustments described above. */
  weight: number;
  /** Where it was found: 'theme-color', 'custom-property', 'inline', 'stylesheet'. */
  sources: string[];
}

export interface BrandFont {
  /** The family as written, quotes stripped. */
  family: string;
  count: number;
  /** True when it came from a Google Fonts <link>, which is a deliberate choice. */
  linked: boolean;
}

export interface BrandingResult {
  /** Best guess at the site's name. */
  name?: string;
  /** Candidate logos, best first. */
  logos: { url: string; kind: string }[];
  /** The browser-UI colour, which a site sets deliberately. Strongest signal. */
  themeColor?: string;
  colours: BrandColour[];
  fonts: BrandFont[];
  /** Favicons and app icons, largest declared size first. */
  icons: { url: string; sizes?: string; rel: string }[];
  /** Web app manifest, if the page references one. */
  manifest?: string;
  /** Stylesheets seen, and how many were actually read. */
  stylesheets: { found: number; read: number; urls: string[] };
  /** What limited the result, in plain words. */
  notes: string[];
}

const HEX = /#([0-9a-f]{3,8})\b/gi;
const RGB = /\brgba?\(\s*([\d.]+%?)\s*[, ]\s*([\d.]+%?)\s*[, ]\s*([\d.]+%?)/gi;
const CUSTOM_PROP = /--[\w-]+\s*:\s*([^;}]+)/g;
const FONT_FAMILY = /font-family\s*:\s*([^;}]+)/gi;

/** Three-digit hex and rgb() both normalise to six-digit hex, so they dedupe. */
function normaliseHex(raw: string): string | null {
  let h = raw.toLowerCase();
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!;
  else if (h.length === 4) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!; // #rgba -> drop alpha
  else if (h.length === 8) h = h.slice(0, 6);
  else if (h.length !== 6) return null;
  return `#${h}`;
}

function rgbToHex(r: string, g: string, b: string): string | null {
  const channel = (v: string): number | null => {
    const pct = v.endsWith('%');
    const n = Number.parseFloat(pct ? v.slice(0, -1) : v);
    if (!Number.isFinite(n)) return null;
    const scaled = pct ? (n / 100) * 255 : n;
    return Math.max(0, Math.min(255, Math.round(scaled)));
  };
  const rr = channel(r);
  const gg = channel(g);
  const bb = channel(b);
  if (rr === null || gg === null || bb === null) return null;
  return `#${[rr, gg, bb].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Near-grey and near-white/black carry no brand information. */
function greyness(hex: string): number {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const saturation = max === 0 ? 0 : (max - min) / max;
  // 1 = fully grey, 0 = fully saturated.
  return 1 - saturation;
}

class ColourTally {
  private readonly map = new Map<string, BrandColour>();

  add(value: string, source: string, weight: number): void {
    const existing = this.map.get(value);
    if (existing) {
      existing.count++;
      existing.weight += weight;
      if (!existing.sources.includes(source)) existing.sources.push(source);
      return;
    }
    this.map.set(value, { value, count: 1, weight, sources: [source] });
  }

  scanCss(css: string, source: string): void {
    // Custom properties first and weighted highest: a design system declares
    // its palette here, which is exactly what "branding" means.
    for (const m of css.matchAll(CUSTOM_PROP)) {
      const body = m[1] ?? '';
      for (const h of body.matchAll(HEX)) {
        const hex = normaliseHex(h[1] ?? '');
        if (hex) this.add(hex, 'custom-property', 6);
      }
      for (const c of body.matchAll(RGB)) {
        const hex = rgbToHex(c[1] ?? '', c[2] ?? '', c[3] ?? '');
        if (hex) this.add(hex, 'custom-property', 6);
      }
    }

    // A framework stylesheet declares its whole default palette thousands of
    // times, so raw frequency inside one is close to meaningless. Occurrences
    // in fetched CSS therefore count for a fraction of an inline one, and the
    // custom properties above stay the strongest signal either way.
    const perHit = source === 'stylesheet' ? 0.15 : 1;
    for (const h of css.matchAll(HEX)) {
      const hex = normaliseHex(h[1] ?? '');
      if (hex) this.add(hex, source, perHit);
    }
    for (const c of css.matchAll(RGB)) {
      const hex = rgbToHex(c[1] ?? '', c[2] ?? '', c[3] ?? '');
      if (hex) this.add(hex, source, perHit);
    }
  }

  ranked(limit: number): BrandColour[] {
    return [...this.map.values()]
      .map((c) => ({
        ...c,
        // Greys get most of their weight removed rather than all of it: a grey
        // really can be a brand colour, it just needs more evidence.
        weight: Number((c.weight * (1 - greyness(c.value) * 0.8)).toFixed(2)),
      }))
      .sort((a, b) => b.weight - a.weight || b.count - a.count)
      .slice(0, limit);
  }
}

export interface BrandingOptions {
  /** Fetch up to this many same-origin stylesheets. Default 0 (none). */
  maxStylesheets?: number;
  /** Colours to return. Default 12. */
  maxColours?: number;
  timeout?: number;
}

/**
 * Extracts branding from an already-parsed document.
 *
 * `fetchCss` is injected rather than imported so this module makes no network
 * calls of its own — the caller decides whether a stylesheet hop is allowed,
 * which keeps the lockdown and the fetch ladder in charge of every request.
 */
export async function extractBranding(
  $: cheerio.CheerioAPI,
  baseUrl: string,
  options: BrandingOptions = {},
  fetchCss?: (url: string) => Promise<string | null>,
): Promise<BrandingResult> {
  const maxStylesheets = options.maxStylesheets ?? 0;
  const maxColours = options.maxColours ?? 12;
  const notes: string[] = [];
  const tally = new ColourTally();

  const meta = (name: string): string | undefined => {
    const v =
      $(`meta[name="${name}" i]`).first().attr('content') ??
      $(`meta[property="${name}" i]`).first().attr('content');
    return v?.trim() || undefined;
  };

  /* -------------------------------------------------------------- */
  /* Name                                                           */
  /* -------------------------------------------------------------- */

  let name = meta('og:site_name') || meta('application-name');
  if (!name) {
    // A title is usually "Page — Brand"; the brand is the last segment.
    const title = $('title').first().text().trim();
    const parts = title.split(/\s+[|–—·-]\s+/);
    if (parts.length > 1) name = parts[parts.length - 1]?.trim();
    else if (title) name = title;
  }

  /* -------------------------------------------------------------- */
  /* Theme colour: deliberate, so it leads                          */
  /* -------------------------------------------------------------- */

  const themeRaw = meta('theme-color') || meta('msapplication-TileColor');
  let themeColor: string | undefined;
  if (themeRaw) {
    const hex = HEX.exec(themeRaw);
    HEX.lastIndex = 0;
    themeColor = hex ? (normaliseHex(hex[1] ?? '') ?? undefined) : themeRaw;
    if (themeColor) tally.add(themeColor, 'theme-color', 20);
  }

  /* -------------------------------------------------------------- */
  /* Logos and icons                                                */
  /* -------------------------------------------------------------- */

  /**
   * Logo candidates are ranked, not just collected.
   *
   * The naive selector `img[src*="logo"]` matches a "logo cloud" — the grid of
   * *other* companies' logos on a landing page — and those are usually far more
   * numerous than the site's own mark. So a candidate found in the header or
   * declared in schema.org outranks one found anywhere else, and a URL that
   * looks like a partner grid is pushed to the bottom rather than dropped,
   * since a site really can keep its own logo in a folder called `clients`.
   */
  const NOT_OURS = /logocloud|logo-cloud|clients?|partners?|customers?|brands?|sponsors?|press|testimonial|avatar/i;

  const candidates: { url: string; kind: string; score: number }[] = [];
  const seenLogo = new Set<string>();
  const pushLogo = (raw: string | undefined, kind: string, score: number): void => {
    const abs = absolutize(raw, baseUrl);
    if (!abs || seenLogo.has(abs)) return;
    seenLogo.add(abs);
    candidates.push({ url: abs, kind: NOT_OURS.test(abs) ? `${kind}, but the URL looks like a third-party logo grid` : kind, score: NOT_OURS.test(abs) ? score - 50 : score });
  };

  // schema.org Organization logo is the only machine-readable declaration of
  // "this is our logo", so it goes first.
  $('script[type="application/ld+json"]').each((_i, el) => {
    const raw = $(el).contents().text();
    if (!raw.trim()) return;
    try {
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (!node || typeof node !== 'object') return;
        const obj = node as Record<string, unknown>;
        const logo = obj.logo;
        if (typeof logo === 'string') pushLogo(logo, 'schema.org logo', 100);
        else if (logo && typeof logo === 'object') {
          const u = (logo as Record<string, unknown>).url;
          if (typeof u === 'string') pushLogo(u, 'schema.org logo', 100);
        }
        if (Array.isArray(obj['@graph'])) walk(obj['@graph']);
      };
      walk(JSON.parse(raw));
    } catch {
      /* malformed JSON-LD is not a branding problem */
    }
  });

  // Then images, by how strongly their position says "this is the site's mark".
  // A header or a masthead link is the strongest; a bare src match is weakest.
  const byPlacement: [string, string, number][] = [
    ['header a[href="/"] img, nav a[href="/"] img', 'image in the masthead home link', 90],
    ['header img, [role="banner"] img', 'image in the header', 80],
    ['header [class*="logo" i] img, nav [class*="logo" i] img', 'header element classed as a logo', 85],
    ['[class*="logo" i] img, img[class*="logo" i]', 'element classed as a logo', 50],
    ['img[alt*="logo" i]', 'image with "logo" in its alt text', 45],
    ['img[src*="logo" i]', 'image with "logo" in its filename', 30],
  ];
  for (const [selector, kind, score] of byPlacement) {
    $(selector).each((_i, el) => {
      const $el = $(el);
      pushLogo($el.attr('src') ?? $el.attr('data-src'), kind, score);
    });
  }

  // An inline SVG has no URL to return, so it is reported as a presence.
  if ($('header svg, [class*="logo" i] svg, svg[class*="logo" i]').length) {
    candidates.push({
      url: '(inline <svg> in the page, no separate file)',
      kind: 'inline svg in the header or a logo element',
      score: 60,
    });
  }

  const icons: { url: string; sizes?: string; rel: string }[] = [];
  $('link[rel*="icon" i], link[rel="apple-touch-icon" i], link[rel="mask-icon" i]').each((_i, el) => {
    const $el = $(el);
    const abs = absolutize($el.attr('href'), baseUrl);
    if (!abs) return;
    icons.push({ url: abs, sizes: $el.attr('sizes'), rel: ($el.attr('rel') ?? 'icon').toLowerCase() });
    const colour = $el.attr('color');
    if (colour) {
      const hex = HEX.exec(colour);
      HEX.lastIndex = 0;
      const norm = hex ? normaliseHex(hex[1] ?? '') : null;
      if (norm) tally.add(norm, 'mask-icon', 8);
      // A mask-icon is a monochrome brand mark, so it is a good logo candidate.
      if (($el.attr('rel') ?? '').toLowerCase().includes('mask-icon')) {
        pushLogo($el.attr('href'), 'mask-icon (monochrome brand mark)', 70);
      }
    }
  });
  // Largest declared size first; an unsized icon sorts last.
  const sizeOf = (s?: string): number => Number.parseInt(s?.split('x')[0] ?? '0', 10) || 0;
  icons.sort((a, b) => sizeOf(b.sizes) - sizeOf(a.sizes));

  if (!candidates.length) {
    const og = absolutize(meta('og:image'), baseUrl);
    if (og) {
      candidates.push({
        url: og,
        kind: 'og:image (social preview, not necessarily a logo)',
        score: 10,
      });
    } else if (icons[0]) {
      candidates.push({
        url: icons[0].url,
        kind: 'favicon (fallback: no logo was declared anywhere)',
        score: 5,
      });
    }
  }

  const logos = candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(({ url, kind }) => ({ url, kind }));

  if (candidates.length && (candidates[0]?.score ?? 0) < 50) {
    notes.push(
      'No strong logo signal: nothing in the header and no schema.org logo, so the candidates above are guesses.',
    );
  }

  /* -------------------------------------------------------------- */
  /* Fonts                                                          */
  /* -------------------------------------------------------------- */

  const fontTally = new Map<string, BrandFont>();
  const addFont = (family: string, linked: boolean): void => {
    const clean = family
      .trim()
      .replace(/^['"]|['"]$/g, '')
      .trim();
    if (!clean) return;
    const generic = /^(inherit|initial|unset|revert|serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-[a-z-]+|-apple-system|blinkmacsystemfont)$/i;
    if (generic.test(clean)) return;
    // `var(--font-x)` is a reference to a family, not a family. Reporting it as
    // a font name would be reporting the plumbing.
    if (/^var\(/i.test(clean)) return;
    // A fallback stack is full of fonts nobody chose; the ones worth naming are
    // either linked web fonts or the first family in a declaration, both of
    // which are already weighted above by `linked` and by declaration order.
    if (/\bfallback$/i.test(clean)) return;
    const key = clean.toLowerCase();
    const existing = fontTally.get(key);
    if (existing) {
      existing.count++;
      existing.linked = existing.linked || linked;
      return;
    }
    fontTally.set(key, { family: clean, count: 1, linked });
  };

  // A Google Fonts link is an explicit choice, so those are marked.
  $('link[href*="fonts.googleapis.com"], link[href*="fonts.gstatic.com"], link[href*="use.typekit"]').each(
    (_i, el) => {
      const href = $(el).attr('href') ?? '';
      for (const m of href.matchAll(/family=([^&:]+)/g)) {
        for (const fam of (m[1] ?? '').split('|')) addFont(decodeURIComponent(fam.replace(/\+/g, ' ')), true);
      }
    },
  );

  /* -------------------------------------------------------------- */
  /* CSS: inline first, then optionally one hop                     */
  /* -------------------------------------------------------------- */

  let inlineCss = '';
  $('style').each((_i, el) => {
    inlineCss += '\n' + $(el).contents().text();
  });
  $('[style]').each((_i, el) => {
    inlineCss += '\n' + ($(el).attr('style') ?? '');
  });
  if (inlineCss.trim()) {
    tally.scanCss(inlineCss, 'inline');
    for (const m of inlineCss.matchAll(FONT_FAMILY)) {
      for (const fam of (m[1] ?? '').split(',')) addFont(fam, false);
    }
  }

  const sheetUrls: string[] = [];
  $('link[rel="stylesheet" i][href]').each((_i, el) => {
    const abs = absolutize($(el).attr('href'), baseUrl);
    if (abs && !sheetUrls.includes(abs)) sheetUrls.push(abs);
  });

  let read = 0;
  if (maxStylesheets > 0 && fetchCss) {
    const origin = (() => {
      try {
        return new URL(baseUrl).origin;
      } catch {
        return '';
      }
    })();
    // Same-origin only: a third-party CDN stylesheet is usually a framework,
    // whose palette is not this site's brand.
    const candidates = sheetUrls.filter((u) => u.startsWith(origin)).slice(0, maxStylesheets);
    const skipped = sheetUrls.length - candidates.length;

    for (const url of candidates) {
      try {
        const css = await fetchCss(url);
        if (!css) continue;
        read++;
        tally.scanCss(css, 'stylesheet');
        for (const m of css.matchAll(FONT_FAMILY)) {
          for (const fam of (m[1] ?? '').split(',')) addFont(fam, false);
        }
      } catch (err) {
        log.debug('branding: stylesheet fetch failed', { url, error: String(err) });
      }
    }
    if (read > 0) {
      notes.push(
        'Stylesheets were read, which also surfaces the default palette of whatever CSS framework the site uses ' +
          '(Tailwind and Bootstrap ship dozens of colours a site never uses). Colours sourced from ' +
          '`custom-property` or `theme-color` are the ones the site chose deliberately.',
      );
    }
    if (skipped > 0) {
      notes.push(`${skipped} cross-origin stylesheet(s) were not read; only same-origin CSS is scanned.`);
    }
    if (sheetUrls.length > candidates.length + skipped) {
      notes.push(`Only the first ${maxStylesheets} stylesheet(s) were read.`);
    }
  } else if (sheetUrls.length) {
    notes.push(
      `${sheetUrls.length} stylesheet(s) were found but not read, so colours and fonts come only from the HTML. ` +
        `Pass brandingStylesheets to fetch up to that many.`,
    );
  }

  const colours = tally.ranked(maxColours);
  if (!colours.length) {
    notes.push('No colours were declared in the HTML itself.');
  }
  const fonts = [...fontTally.values()].sort(
    (a, b) => Number(b.linked) - Number(a.linked) || b.count - a.count,
  );
  if (!fonts.length) notes.push('No non-generic font families were declared in the HTML.');

  return {
    name,
    logos,
    themeColor,
    colours,
    fonts,
    icons: icons.slice(0, 10),
    manifest: absolutize($('link[rel="manifest" i]').first().attr('href'), baseUrl) ?? undefined,
    stylesheets: { found: sheetUrls.length, read, urls: sheetUrls.slice(0, 10) },
    notes,
  };
}
