const TRACKING_PARAMS = [
  /^utm_/i, /^fbclid$/i, /^gclid$/i, /^gbraid$/i, /^wbraid$/i, /^msclkid$/i,
  /^mc_eid$/i, /^mc_cid$/i, /^_hsenc$/i, /^_hsmi$/i, /^igshid$/i, /^ref_src$/i,
  /^vero_id$/i, /^yclid$/i, /^twclid$/i, /^ttclid$/i, /^s_kwcid$/i,
];

/** Resolve a possibly-relative href against a base. Returns null when unusable. */
export function absolutize(href: string | undefined, base: string): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (!trimmed) return null;
  if (/^(javascript:|mailto:|tel:|data:|blob:|about:|#)/i.test(trimmed)) return null;
  try {
    return new URL(trimmed, base).toString();
  } catch {
    return null;
  }
}

/**
 * Canonical form used for cache keys and crawl de-duplication:
 * lowercase host, no default port, no fragment, tracking params dropped,
 * query params sorted, trailing slash removed from non-root paths.
 */
export function normalizeUrl(input: string): string {
  const u = new URL(input);
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) {
    u.port = '';
  }
  const keep: [string, string][] = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (TRACKING_PARAMS.some((re) => re.test(k))) continue;
    keep.push([k, v]);
  }
  keep.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  u.search = '';
  for (const [k, v] of keep) u.searchParams.append(k, v);
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

export function sameRegistrableDomain(a: string, b: string): boolean {
  try {
    const ha = new URL(a).hostname.replace(/^www\./, '');
    const hb = new URL(b).hostname.replace(/^www\./, '');
    return ha === hb || ha.endsWith('.' + hb) || hb.endsWith('.' + ha);
  } catch {
    return false;
  }
}

export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function originOf(value: string): string {
  return new URL(value).origin;
}
