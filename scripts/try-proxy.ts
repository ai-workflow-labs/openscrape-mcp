/**
 * Exercises the proxy rotation pool without needing a real proxy.
 *
 * Run: npx tsx scripts/try-proxy.ts
 *
 * Everything written to stdout and stderr during the run is captured and
 * scanned at the end for the test password. That scan is the point of this
 * script as much as the rotation checks are: a proxy URL carries
 * `user:password@`, and leaking one into an MCP transcript is a real credential
 * disclosure.
 */
import {
  ProxyPool,
  isProxyTransportError,
  nextProxy,
  outcomeFromError,
  outcomeFromResponse,
  proxyId,
  reportProxyOutcome,
  setProxyPool,
} from '../src/core/fetcher/proxypool.js';
import { formatProxyCheck, formatProxyStatus } from '../src/mcp/tools/proxy.js';

// --- credentials under test -------------------------------------------------

const PASSWORD = 'sup3r-s3cret-p4ss';
const USERNAME = 'proxyuser';
const SECRET_URLS = [
  `http://${USERNAME}:${PASSWORD}@10.9.0.1:8080`,
  `http://${USERNAME}:${PASSWORD}@10.9.0.2:8080`,
  `http://${USERNAME}:${PASSWORD}@10.9.0.3:8080`,
];

// --- harness ----------------------------------------------------------------

let passed = 0;
const failures: string[] = [];
/** Everything printed anywhere, for the credential scan. */
let transcript = '';

const realStderr = process.stderr.write.bind(process.stderr);
process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
  transcript += String(chunk);
  return (realStderr as (...a: unknown[]) => boolean)(chunk, ...rest);
}) as typeof process.stderr.write;

function say(line = ''): void {
  transcript += line + '\n';
  console.log(line);
}

function ok(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++;
    say(`  PASS  ${label}${detail ? `  (${detail})` : ''}`);
  } else {
    failures.push(label);
    say(`  FAIL  ${label}${detail ? `  (${detail})` : ''}`);
  }
}

function eq<T>(label: string, actual: T, expected: T): void {
  ok(label, actual === expected, `got ${String(actual)}, want ${String(expected)}`);
}

function section(title: string): void {
  say();
  say(`== ${title}`);
}

/** Proxy urls -> short names, so assertions read as p0/p1/p2. */
function namer(urls: string[]) {
  return (url: string | null): string => {
    if (url === null) return 'null';
    const i = urls.indexOf(url);
    return i < 0 ? 'unknown' : `p${i}`;
  };
}

function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

// --- 1. zero proxies configured --------------------------------------------

section('1. zero proxies configured (the normal case)');
{
  const pool = new ProxyPool({ proxies: [] });
  eq('pool reports empty', pool.empty, true);
  eq('configured count is 0', pool.status().configured, 0);
  eq('pick() returns null', pool.pick('example.com'), null);
  ok('status text says "none configured"', formatProxyStatus(pool.status()).includes('none configured'));

  setProxyPool(pool);
  eq('nextProxy() returns null', nextProxy('https://example.com/page'), null);
  // Must be a harmless no-op: the direct-connection path calls it unconditionally.
  reportProxyOutcome(null, 'example.com', { ok: true });
  reportProxyOutcome('http://nobody:1', 'example.com', { ok: true });
  ok('reportProxyOutcome with no pool does not throw', true);

  const results = await pool.check(500);
  eq('check() returns no rows', results.length, 0);
  ok('check output says "none configured"', formatProxyCheck(results).includes('none configured'));
  setProxyPool(null);
}

// --- 2. round-robin ---------------------------------------------------------

section('2. rotation: round-robin');
{
  const clock = fakeClock();
  const pool = new ProxyPool({ proxies: SECRET_URLS, strategy: 'round-robin', now: clock.now });
  const name = namer(SECRET_URLS);
  const seen: string[] = [];
  for (let i = 0; i < 6; i++) {
    clock.advance(10);
    seen.push(name(pool.pick('news.example.com')));
  }
  eq('cycles p0,p1,p2,p0,p1,p2', seen.join(','), 'p0,p1,p2,p0,p1,p2');
}

// --- 3. least-recently-used -------------------------------------------------

section('3. rotation: least-recently-used');
{
  const clock = fakeClock();
  const pool = new ProxyPool({ proxies: SECRET_URLS, strategy: 'round-robin', now: clock.now });
  const name = namer(SECRET_URLS);

  clock.advance(10);
  eq('prime p0 via round-robin', name(pool.pick('a.example.com', 'round-robin')), 'p0');
  clock.advance(10);
  eq('prime p1 via round-robin', name(pool.pick('a.example.com', 'round-robin')), 'p1');

  clock.advance(10);
  eq('lru picks the never-used p2', name(pool.pick('a.example.com', 'least-recently-used')), 'p2');
  clock.advance(10);
  eq('lru then picks the oldest-used p0', name(pool.pick('a.example.com', 'least-recently-used')), 'p0');
  clock.advance(10);
  eq('lru then picks p1', name(pool.pick('a.example.com', 'least-recently-used')), 'p1');
}

// --- 4. lowest-latency ------------------------------------------------------

section('4. rotation: lowest-latency');
{
  const clock = fakeClock();
  const pool = new ProxyPool({ proxies: SECRET_URLS, strategy: 'lowest-latency', now: clock.now });
  const name = namer(SECRET_URLS);

  pool.report(SECRET_URLS[0], { ok: true, latencyMs: 300 });
  pool.report(SECRET_URLS[1], { ok: true, latencyMs: 100 });
  eq('unmeasured proxy is tried first', name(pool.pick('a.example.com')), 'p2');

  pool.report(SECRET_URLS[2], { ok: true, latencyMs: 900 });
  eq('then the fastest wins', name(pool.pick('a.example.com')), 'p1');
  pool.report(SECRET_URLS[1], { ok: true, latencyMs: 100 });
  eq('and keeps winning', name(pool.pick('a.example.com')), 'p1');

  // Median, not last value: one slow outlier must not disqualify a fast proxy.
  pool.report(SECRET_URLS[1], { ok: true, latencyMs: 4000 });
  eq('median ignores a single outlier', name(pool.pick('a.example.com')), 'p1');
  eq('p1 median latency is the median, not the last sample', pool.status().proxies[1].medianLatencyMs, 100);
}

// --- 5. sticky-per-host -----------------------------------------------------

section('5. rotation: sticky-per-host');
{
  const clock = fakeClock();
  const pool = new ProxyPool({ proxies: SECRET_URLS, strategy: 'sticky-per-host', now: clock.now });
  const name = namer(SECRET_URLS);

  const a1 = name(pool.pick('shop.example.com'));
  clock.advance(10);
  const a2 = name(pool.pick('shop.example.com'));
  eq('same host keeps the same proxy', a2, a1);

  const b = name(pool.pick('forum.example.net'));
  const c = name(pool.pick('wiki.example.org'));
  ok('a second host gets a different proxy', b !== a1, `${a1} vs ${b}`);
  ok('a third host gets a third proxy', c !== a1 && c !== b, `${a1}/${b}/${c}`);
  eq('first host is still pinned', name(pool.pick('shop.example.com')), a1);

  // A site-level block makes the pinned session worthless, so it is released.
  pool.report(SECRET_URLS[SECRET_URLS.findIndex((u) => name(u) === a1)], {
    ok: false,
    kind: 'blocked',
    host: 'shop.example.com',
    blockReason: 'rate-limited',
  });
  const a3 = name(pool.pick('shop.example.com'));
  ok('a block releases the sticky pin', a3 !== a1, `${a1} -> ${a3}`);
}

// --- 6. circuit breaking ----------------------------------------------------

section('6. circuit breaking: bench, grow, probe, recover');
{
  const clock = fakeClock();
  const pool = new ProxyPool({
    proxies: SECRET_URLS,
    strategy: 'round-robin',
    maxConsecutiveFailures: 3,
    cooldownMs: 1000,
    now: clock.now,
  });
  const name = namer(SECRET_URLS);
  const p0 = SECRET_URLS[0];
  const stateOf = (i: number) => pool.status().proxies[i].state;

  pool.report(p0, { ok: false, kind: 'proxy-error', error: 'connect ECONNREFUSED 10.9.0.1:8080' });
  eq('1 failure: still in service', stateOf(0), 'ok');
  pool.report(p0, { ok: false, kind: 'proxy-error', error: 'connect ECONNREFUSED 10.9.0.1:8080' });
  eq('2 failures: still in service', stateOf(0), 'ok');
  pool.report(p0, { ok: false, kind: 'proxy-error', error: 'connect ECONNREFUSED 10.9.0.1:8080' });
  eq('3 failures: benched', stateOf(0), 'benched');
  eq('failure counter', pool.status().proxies[0].failures, 3);

  const picks = new Set<string>();
  for (let i = 0; i < 9; i++) {
    clock.advance(10);
    picks.add(name(pool.pick('a.example.com')));
  }
  ok('benched proxy is never handed out', !picks.has('p0'), `picked ${[...picks].join(',')}`);
  eq('available count drops to 2', pool.status().available, 2);

  clock.advance(500);
  eq('still benched inside the cooldown', stateOf(0), 'benched');
  clock.advance(600);
  eq('cooldown expired: on probation', stateOf(0), 'probation');

  const probed = new Set<string>();
  for (let i = 0; i < 6; i++) {
    clock.advance(10);
    probed.add(name(pool.pick('a.example.com')));
  }
  ok('probation proxy is offered a trial run', probed.has('p0'), `picked ${[...probed].join(',')}`);

  // One failed trial re-opens the breaker at once, with a longer cooldown.
  pool.report(p0, { ok: false, kind: 'proxy-error', error: 'socket hang up' });
  eq('failed probe re-benches immediately', stateOf(0), 'benched');
  eq('bench count grew', pool.status().proxies[0].benchCount, 2);
  clock.advance(1100);
  eq('cooldown doubled, so still benched', stateOf(0), 'benched');
  clock.advance(1000);
  eq('second cooldown expired: on probation', stateOf(0), 'probation');

  pool.report(p0, { ok: true, latencyMs: 120 });
  eq('a good probe returns it to service', stateOf(0), 'ok');
  eq('bench count reset', pool.status().proxies[0].benchCount, 0);
  eq('consecutive failures reset', pool.status().proxies[0].consecutiveFailures, 0);
}

// --- 7. proxy failure vs site block are tracked separately ------------------

section('7. proxy-broken vs target-blocked tracked separately');
{
  const clock = fakeClock();
  const pool = new ProxyPool({
    proxies: SECRET_URLS,
    strategy: 'round-robin',
    maxConsecutiveFailures: 3,
    cooldownMs: 1000,
    blockCooldownMs: 60_000,
    now: clock.now,
  });
  const name = namer(SECRET_URLS);
  const p0 = SECRET_URLS[0];

  for (let i = 0; i < 3; i++) {
    pool.report(p0, {
      ok: false,
      kind: 'blocked',
      host: 'walled.example.com',
      blockReason: 'cloudflare-403',
    });
  }
  const h0 = pool.status().proxies[0];
  eq('3 site blocks: NOT benched', h0.state, 'ok');
  eq('block counter', h0.blocks, 3);
  eq('proxy failure counter untouched', h0.failures, 0);
  eq('consecutive failure counter untouched', h0.consecutiveFailures, 0);
  eq('per-host block history recorded', h0.hostBlocks.length, 1);
  eq('per-host block count', h0.hostBlocks[0].count, 3);
  eq('per-host block reason from detectBlock', h0.hostBlocks[0].lastReason, 'cloudflare-403');

  const walled = new Set<string>();
  for (let i = 0; i < 9; i++) {
    clock.advance(10);
    walled.add(name(pool.pick('walled.example.com')));
  }
  ok('blocked proxy is kept off that host', !walled.has('p0'), `picked ${[...walled].join(',')}`);

  const elsewhere = new Set<string>();
  for (let i = 0; i < 9; i++) {
    clock.advance(10);
    elsewhere.add(name(pool.pick('other.example.net')));
  }
  ok('same proxy still serves other hosts', elsewhere.has('p0'), `picked ${[...elsewhere].join(',')}`);

  // The per-host cooldown grows with repeat blocks too: 3 blocks at a 60s base
  // means 240s before this proxy is offered to this host again.
  clock.advance(250_000);
  const later = new Set<string>();
  for (let i = 0; i < 9; i++) {
    clock.advance(10);
    later.add(name(pool.pick('walled.example.com')));
  }
  ok('host cooldown expires and it is retried', later.has('p0'), `picked ${[...later].join(',')}`);

  // When every proxy is blocked on a host we still make progress rather than
  // refusing to fetch at all.
  for (const url of SECRET_URLS) {
    pool.report(url, {
      ok: false,
      kind: 'blocked',
      host: 'hostile.example.com',
      blockReason: 'datadome',
    });
  }
  ok('all-blocked host still gets a proxy', pool.pick('hostile.example.com') !== null);
}

// --- 8. outcome classification helpers -------------------------------------

section('8. outcome classification (shares detectBlock\'s verdict)');
{
  const good = outcomeFromResponse(200, null, 'a.example.com', 50);
  eq('200 with no block -> ok', good.ok, true);

  const blocked = outcomeFromResponse(403, 'cloudflare-403', 'a.example.com', 50);
  eq('detectBlock verdict -> blocked', blocked.ok === false ? blocked.kind : 'ok', 'blocked');

  const rateLimited = outcomeFromResponse(429, 'rate-limited', 'a.example.com', 50);
  eq('429 -> blocked, not a proxy fault', rateLimited.ok === false ? rateLimited.kind : 'ok', 'blocked');

  const proxyAuth = outcomeFromResponse(407, null, 'a.example.com', 50);
  eq('407 -> the proxy\'s fault', proxyAuth.ok === false ? proxyAuth.kind : 'ok', 'proxy-error');

  const thrown = outcomeFromError(
    new Error(`connect ECONNREFUSED via http://${USERNAME}:${PASSWORD}@10.9.0.1:8080`),
    'a.example.com',
    30,
  );
  eq('thrown error -> proxy-error', thrown.ok === false ? thrown.kind : 'ok', 'proxy-error');
  const thrownMsg =
    thrown.ok === false && thrown.kind === 'proxy-error' ? (thrown.error ?? '') : '';
  ok('outcomeFromError redacts credentials in the message', !thrownMsg.includes(PASSWORD), thrownMsg);

  ok('ECONNREFUSED is a transport error', isProxyTransportError(new Error('connect ECONNREFUSED')));
  ok('plain 404 text is not', !isProxyTransportError(new Error('not found')));
}

// --- 9. health check against unreachable proxies ---------------------------

section('9. health check against unreachable proxies (no real proxy available)');
let checkText = '';
{
  // Port 1 and port 9 on loopback: nothing listens, so this is the
  // broken-proxy path, which must report rather than throw.
  const dead = [
    `http://${USERNAME}:${PASSWORD}@127.0.0.1:1`,
    `http://${USERNAME}:${PASSWORD}@127.0.0.1:9`,
  ];
  const pool = new ProxyPool({ proxies: dead, checkUrl: 'https://api.ipify.org?format=json' });
  let threw = false;
  let results: Awaited<ReturnType<ProxyPool['check']>> = [];
  try {
    results = await pool.check(2500);
  } catch (err) {
    threw = true;
    say(`  (check threw: ${String(err)})`);
  }
  ok('check() does not throw on unreachable proxies', !threw);
  eq('one row per proxy', results.length, 2);
  ok('both reported broken', results.every((r) => !r.ok), results.map((r) => r.ok).join(','));
  ok('each row carries an error', results.every((r) => Boolean(r.error)));
  ok('no egress IP invented', results.every((r) => r.egressIp === undefined));
  eq('failures recorded on the pool', pool.status().proxies[0].failures, 1);

  checkText = formatProxyCheck(results);
  say();
  say(checkText);

  const status = formatProxyStatus(pool.status());
  say();
  say(status);
  transcript += JSON.stringify(pool.status());

  ok(
    'scrub() removes a password from arbitrary text',
    !pool.scrub(`ProxyAgent failed for http://${USERNAME}:${PASSWORD}@127.0.0.1:1`).includes(PASSWORD),
  );
  ok(
    'scrub() removes a bare password too',
    !pool.scrub(`auth rejected, password was ${PASSWORD}`).includes(PASSWORD),
  );
}

// --- 10. credential redaction: the hard requirement ------------------------

section('10. credential redaction across every output path');
{
  const id = proxyId(SECRET_URLS[0]);
  say(`  identifier for p0: ${id}`);
  ok('proxyId has no password', !id.includes(PASSWORD));
  ok('proxyId has no username', !id.includes(USERNAME));
  ok('proxyId is host:port#hash', /^10\.9\.0\.1:8080#[0-9a-f]{8}$/.test(id));
  ok(
    'two proxies get distinct ids',
    proxyId(SECRET_URLS[0]) !== proxyId(SECRET_URLS[1]),
  );
  ok('proxyId is stable', proxyId(SECRET_URLS[0]) === id);
  eq('check table shows no password', checkText.includes(PASSWORD), false);
}

// --- 11. configuration from the environment and a file ---------------------

section('11. loading from OPENSCRAPE_PROXIES and OPENSCRAPE_PROXY_FILE');
{
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'openscrape-proxy-'));
  const listFile = join(dir, 'proxies.txt');
  writeFileSync(
    listFile,
    [
      '# a comment line',
      '',
      `http://${USERNAME}:${PASSWORD}@10.9.0.4:8080`,
      '10.9.0.5:3128', // bare host:port, scheme implied
      `http://${USERNAME}:${PASSWORD}@10.9.0.1:8080`, // duplicate of the env entry
      'not a proxy at all',
    ].join('\n'),
    'utf8',
  );

  const saved = {
    list: process.env.OPENSCRAPE_PROXIES,
    file: process.env.OPENSCRAPE_PROXY_FILE,
    strategy: process.env.OPENSCRAPE_PROXY_STRATEGY,
  };
  process.env.OPENSCRAPE_PROXIES = `${SECRET_URLS[0]}, ${SECRET_URLS[1]}`;
  process.env.OPENSCRAPE_PROXY_FILE = listFile;
  process.env.OPENSCRAPE_PROXY_STRATEGY = 'sticky-per-host';

  try {
    setProxyPool(null);
    const pool = new ProxyPool();
    const status = pool.status();
    eq('env (2) + file (2 new, 1 duplicate, 1 junk) = 4', status.configured, 4);
    eq('strategy comes from the environment', status.strategy, 'sticky-per-host');
    eq('sources are named, not their contents', status.sources.join(','), 'env:OPENSCRAPE_PROXIES,file');
    eq(
      'bare host:port was normalised',
      status.proxies.map((p) => p.label).join(','),
      '10.9.0.1:8080,10.9.0.2:8080,10.9.0.4:8080,10.9.0.5:3128',
    );

    setProxyPool(pool);
    const chosen = nextProxy('https://shop.example.com/cart');
    ok('nextProxy() hands back a proxy URL', typeof chosen === 'string' && chosen.startsWith('http'));
    reportProxyOutcome(chosen, 'https://shop.example.com/cart', outcomeFromResponse(200, null, '', 180));
    eq(
      'reportProxyOutcome credited the right proxy',
      pool.status().proxies.filter((p) => p.successes === 1).length,
      1,
    );
    reportProxyOutcome(chosen, 'https://shop.example.com/cart', {
      ok: false,
      kind: 'blocked',
      blockReason: 'rate-limited',
    });
    eq(
      'block was attributed to the request host',
      pool.status().proxies.find((p) => p.blocks === 1)?.hostBlocks[0]?.host,
      'shop.example.com',
    );

    const rendered = formatProxyStatus(pool.status());
    say();
    say(rendered);
    ok('rendered table has no password', !rendered.includes(PASSWORD));
    transcript += JSON.stringify(pool.status());
  } finally {
    process.env.OPENSCRAPE_PROXIES = saved.list;
    process.env.OPENSCRAPE_PROXY_FILE = saved.file;
    process.env.OPENSCRAPE_PROXY_STRATEGY = saved.strategy;
    if (saved.list === undefined) delete process.env.OPENSCRAPE_PROXIES;
    if (saved.file === undefined) delete process.env.OPENSCRAPE_PROXY_FILE;
    if (saved.strategy === undefined) delete process.env.OPENSCRAPE_PROXY_STRATEGY;
    setProxyPool(null);
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- 12. the hard requirement: nothing leaked, anywhere, all run ----------

section('12. whole-run credential scan');
{
  // `transcript` holds every console line, every stderr log line, every
  // rendered table and a JSON dump of each status object produced above.
  say(`  scanned ${transcript.length} characters of output`);
  const leakedPassword = transcript.includes(PASSWORD);
  const leakedUserinfo = transcript.includes(`${USERNAME}:${PASSWORD}`);
  ok('the password never appears in any output of this run', !leakedPassword);
  ok('the user:pass pair never appears in any output of this run', !leakedUserinfo);
  if (leakedPassword) {
    const at = transcript.indexOf(PASSWORD);
    say(
      `  leak context: ...${transcript
        .slice(Math.max(0, at - 200), at + 60)
        .split(PASSWORD)
        .join('<<<PASSWORD>>>')}...`,
    );
  }
}

// --- summary ----------------------------------------------------------------

say();
say(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) say(`  - ${f}`);
}
say();
say('No real working proxy was available in this environment: rotation, health');
say('tracking and circuit breaking were exercised against fake proxy URLs, and');
say('the health-check path against unreachable loopback ports.');

process.stderr.write = realStderr as typeof process.stderr.write;
process.exit(failures.length ? 1 : 0);
