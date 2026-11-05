import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Server-side request forgery guard.
 *
 * A scraper is, by definition, a thing that fetches whatever URL it is handed.
 * That is fine when the only caller is the person at the keyboard, but the
 * moment the engine is reachable over a network — the HTTP API — an attacker
 * can point it at `http://169.254.169.254/` or `http://127.0.0.1:6379/` and use
 * it as a proxy into the private network it runs in. This resolves the host
 * first and refuses addresses that are not publicly routable.
 */

interface Range {
  label: string;
  test(ip: string): boolean;
}

function v4(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  return nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? nums : null;
}

const BLOCKED: Range[] = [
  { label: 'loopback', test: (ip) => v4(ip)?.[0] === 127 || ip === '::1' },
  { label: 'this-network', test: (ip) => v4(ip)?.[0] === 0 },
  { label: 'private-10/8', test: (ip) => v4(ip)?.[0] === 10 },
  {
    label: 'private-172.16/12',
    test: (ip) => {
      const o = v4(ip);
      return o !== null && o[0] === 172 && o[1] >= 16 && o[1] <= 31;
    },
  },
  {
    label: 'private-192.168/16',
    test: (ip) => {
      const o = v4(ip);
      return o !== null && o[0] === 192 && o[1] === 168;
    },
  },
  {
    label: 'link-local-169.254/16 (cloud metadata)',
    test: (ip) => {
      const o = v4(ip);
      return o !== null && o[0] === 169 && o[1] === 254;
    },
  },
  {
    label: 'carrier-nat-100.64/10',
    test: (ip) => {
      const o = v4(ip);
      return o !== null && o[0] === 100 && o[1] >= 64 && o[1] <= 127;
    },
  },
  {
    label: 'benchmark-198.18/15',
    test: (ip) => {
      const o = v4(ip);
      return o !== null && o[0] === 198 && (o[1] === 18 || o[1] === 19);
    },
  },
  {
    label: 'ipv6-unique-local',
    test: (ip) => /^(f[cd])/i.test(ip),
  },
  {
    label: 'ipv6-link-local',
    test: (ip) => /^fe[89ab]/i.test(ip),
  },
  {
    label: 'ipv4-mapped-ipv6',
    test: (ip) => {
      const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
      return mapped !== undefined && BLOCKED.slice(0, 8).some((r) => r.test(mapped));
    },
  },
];

const BLOCKED_HOSTNAMES = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /^metadata\.google\.internal$/i,
];

export class BlockedAddressError extends Error {
  constructor(
    message: string,
    readonly host: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = 'BlockedAddressError';
  }
}

export interface SsrfCheckResult {
  ok: boolean;
  reason?: string;
  addresses?: string[];
}

/**
 * Per-host verdict cache.
 *
 * Without it, enforcing this on every fetch adds a DNS lookup per page, which
 * on a thousand-page crawl of one host is a thousand lookups to answer the
 * same question. Kept short deliberately: a long TTL would let a name that has
 * since been repointed at a private address keep its old pass. 60 seconds
 * bounds that window while still collapsing a crawl into one lookup.
 */
const verdictCache = new Map<string, { result: SsrfCheckResult; at: number }>();
const VERDICT_TTL_MS = 60_000;

/** Classifies a URL, reusing a recent verdict for the same host. */
export async function checkUrlCached(target: string): Promise<SsrfCheckResult> {
  let key: string;
  try {
    const u = new URL(target);
    key = `${u.protocol}//${u.hostname}`;
  } catch {
    return { ok: false, reason: 'unparseable URL' };
  }

  const hit = verdictCache.get(key);
  if (hit && Date.now() - hit.at < VERDICT_TTL_MS) return hit.result;

  const result = await checkUrlReachability(target);
  verdictCache.set(key, { result, at: Date.now() });

  // Bound the map so a crawl across many hosts cannot grow it without limit.
  if (verdictCache.size > 4096) {
    const oldest = verdictCache.keys().next().value;
    if (oldest !== undefined) verdictCache.delete(oldest);
  }
  return result;
}

/** Classifies a URL without throwing. */
export async function checkUrlReachability(target: string): Promise<SsrfCheckResult> {
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return { ok: false, reason: 'unparseable URL' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: `unsupported protocol ${u.protocol}` };
  }

  const host = u.hostname.replace(/^\[|\]$/g, '');

  if (BLOCKED_HOSTNAMES.some((re) => re.test(host))) {
    return { ok: false, reason: `hostname "${host}" is a private name` };
  }

  // Literal address: check it directly, no DNS needed.
  if (isIP(host)) {
    const hit = BLOCKED.find((r) => r.test(host));
    return hit ? { ok: false, reason: hit.label, addresses: [host] } : { ok: true, addresses: [host] };
  }

  let addresses: string[];
  try {
    const records = await lookup(host, { all: true });
    addresses = records.map((r) => r.address);
  } catch (err) {
    return { ok: false, reason: `DNS lookup failed for ${host}: ${String(err)}` };
  }
  if (addresses.length === 0) {
    return { ok: false, reason: `DNS returned no addresses for ${host}` };
  }

  // Every resolved address must be public: a name that resolves to both a
  // public and a private address is still a way into the private network.
  for (const address of addresses) {
    const hit = BLOCKED.find((r) => r.test(address));
    if (hit) {
      return { ok: false, reason: `${host} resolves to ${address} (${hit.label})`, addresses };
    }
  }

  return { ok: true, addresses };
}

/** Throws BlockedAddressError when the URL points inside the private network. */
export async function assertPublicUrl(target: string): Promise<void> {
  const result = await checkUrlReachability(target);
  if (!result.ok) {
    throw new BlockedAddressError(
      `Refusing to fetch ${target}: ${result.reason}. This guard protects the private network ` +
        'when the engine is reachable remotely. Allow it explicitly if you intended a local target.',
      target,
      result.reason ?? 'blocked',
    );
  }
}
