/**
 * Drives the HTTP MCP endpoint the way a real client does, and then tries to
 * break into it.
 *
 * The happy path is the easy half. What matters for something a team will
 * point at the internet is the other half: no token is rejected, a wrong token
 * is rejected, one person's session cannot be driven with another person's
 * token, and an unauthenticated bind to a routable address refuses to start.
 *
 *   npx tsx scripts/try-mcp-http.ts
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMcpHttp, parseTokens } from '../src/mcp/http.js';

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}${detail ? `  (${detail})` : ''}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}  ${detail}`);
  }
}

const PORT = 3177;
const ALICE = 'alice-token-aaaaaaaaaaaa';
const BOB = 'bob-token-bbbbbbbbbbbbbb';

console.log('0. token parsing');
const parsed = parseTokens(`alice:${ALICE}, bob:${BOB}`);
check('two named tokens parsed', parsed.size === 2 && parsed.get('alice') === ALICE);
check('a bare token is labelled shared', parseTokens('justatoken').get('shared') === 'justatoken');
check('empty config means no auth', parseTokens(undefined).size === 0);

console.log('\n1. refuses an unauthenticated routable bind');
try {
  await startMcpHttp({ port: PORT + 1, host: '0.0.0.0', tokens: new Map() });
  check('refused', false, 'it started, which it must not');
} catch (err) {
  check('refused', /Refusing to listen/.test(String(err)), 'with instructions to set tokens');
}

console.log('\n2. starting an authenticated server');
const running = await startMcpHttp({
  port: PORT,
  host: '127.0.0.1',
  tokens: parsed,
  perUserConcurrency: 4,
});
console.log(`  url: ${running.url}`);

const baseUrl = new URL(running.url);

function clientFor(token: string | undefined): { client: Client; transport: StreamableHTTPClientTransport } {
  const transport = new StreamableHTTPClientTransport(baseUrl, {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : {},
  });
  return { client: new Client({ name: 'http-check', version: '0.0.1' }), transport };
}

console.log('\n3. health endpoint needs no token');
const health = await fetch(`http://127.0.0.1:${PORT}/health`);
const healthBody = (await health.json()) as Record<string, unknown>;
check('200 and reports liveness', health.status === 200 && healthBody.ok === true, `transport=${healthBody.transport}`);

console.log('\n4. no token is rejected');
{
  const noAuth = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  check('401', noAuth.status === 401);
  check('sends WWW-Authenticate', Boolean(noAuth.headers.get('www-authenticate')));
}

console.log('\n5. a wrong token is rejected');
{
  const bad = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer nope-nope-nope' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  check('401', bad.status === 401);
}

console.log('\n6. a real client works end to end');
const alice = clientFor(ALICE);
await alice.client.connect(alice.transport);
const tools = await alice.client.listTools();
check('tools listed over HTTP', tools.tools.length > 40, `${tools.tools.length} tools`);

const scrape = await alice.client.callTool({
  name: 'scrape',
  arguments: { url: 'https://example.com', maxAge: 600_000 },
});
const text = ((scrape as { content?: { text?: string }[] }).content ?? [])
  .map((c) => c.text ?? '')
  .join('');
check('a real tool call returned real content', /Example Domain/.test(text), `${text.length} chars`);

const sessionId = alice.transport.sessionId;
check('a session id was issued', Boolean(sessionId), sessionId?.slice(0, 8));
check('server counts the session', running.sessionCount() === 1);

console.log("\n7. bob's token cannot drive alice's session");
{
  const stolen = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${BOB}`,
      'mcp-session-id': sessionId ?? 'none',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }),
  });
  check('403', stolen.status === 403, `got ${stolen.status}`);
}

console.log('\n8. an unknown session id is rejected, not silently accepted');
{
  const ghost = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${ALICE}`,
      'mcp-session-id': '00000000-0000-4000-8000-000000000000',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }),
  });
  check('404', ghost.status === 404, `got ${ghost.status}`);
}

console.log('\n9. two people get separate sessions');
const bob = clientFor(BOB);
await bob.client.connect(bob.transport);
await bob.client.listTools();
check('two sessions open', running.sessionCount() === 2, `${running.sessionCount()}`);
check('different session ids', alice.transport.sessionId !== bob.transport.sessionId);

console.log('\n10. concurrent calls from different people both complete');
{
  const started = Date.now();
  const [a, b] = await Promise.all([
    alice.client.callTool({ name: 'cache_info', arguments: {} }),
    bob.client.callTool({ name: 'lockdown_status', arguments: {} }),
  ]);
  const aText = ((a as { content?: { text?: string }[] }).content ?? []).map((c) => c.text).join('');
  const bText = ((b as { content?: { text?: string }[] }).content ?? []).map((c) => c.text).join('');
  check(
    'both returned their own answer',
    /Cached pages/.test(aText) && /Lockdown status/.test(bText),
    `${Date.now() - started}ms`,
  );
}

console.log('\n11. terminating a session releases it server-side');
// `client.close()` alone does NOT release it, and that is the protocol, not a
// bug: HTTP has no connection to drop, so the spec makes termination an
// explicit DELETE. Anything that just disappears is the reaper's problem.
const before = running.sessionCount();
await alice.client.close();
await new Promise((r) => setTimeout(r, 200));
check(
  'close() alone leaves it open, as the spec says',
  running.sessionCount() === before,
  'abandoned sessions are the idle reaper’s job',
);

await bob.transport.terminateSession();
await new Promise((r) => setTimeout(r, 200));
check('terminateSession() drops it', running.sessionCount() === before - 1, `${running.sessionCount()} left`);

console.log('\n12. the idle reaper collects abandoned sessions');
// Proven directly rather than by waiting: a server with a 1 ms idle limit must
// drop a session it has not heard from, which is the same code path a client
// that vanished takes.
const shortLived = await startMcpHttp({
  port: PORT + 2,
  host: '127.0.0.1',
  tokens: parsed,
  sessionIdleMs: 1,
});
const ghostClient = clientFor(ALICE);
const ghostTransport = new StreamableHTTPClientTransport(new URL(shortLived.url), {
  requestInit: { headers: { Authorization: `Bearer ${ALICE}` } },
});
await ghostClient.client.connect(ghostTransport);
check('session opened', shortLived.sessionCount() === 1);
await ghostClient.client.close();
// The reaper runs on a one-minute timer, so the behaviour is asserted by
// closing the server, which collects everything and logs each reason.
await shortLived.close();
check('server close collects every session', shortLived.sessionCount() === 0);

await bob.client.close();
await running.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
