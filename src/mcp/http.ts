/**
 * MCP over HTTP — the remote URL a team points their clients at.
 *
 * This is the transport that makes OpenScrape a shared service rather than a
 * per-laptop tool. It implements MCP's Streamable HTTP transport, so any MCP
 * client that supports a remote server works: Claude Code, Claude Desktop,
 * Codex, Cursor.
 *
 *   npm run mcp:http
 *   → http://127.0.0.1:3100/mcp
 *
 * Read this before exposing it, because the defaults are deliberately strict:
 *
 * **Tokens are per person, not one shared secret.** `OPENSCRAPE_MCP_TOKENS`
 * takes `name:token` pairs. Every log line and every rate-limit bucket is keyed
 * by that name, so "who is hammering the crawler" has an answer and revoking
 * one person does not re-key the whole team.
 *
 * **It refuses to bind a routable interface without tokens.** Exposing this
 * unauthenticated hands anyone a browser that runs on your network, so an
 * accident has to be impossible rather than merely unlikely.
 *
 * **DNS-rebinding protection is on when a host allowlist is given.** Without
 * it, a page in a team member's browser can drive a localhost MCP server.
 */
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  createServer,
  runStartupTasks,
  installProcessHandlers,
  SERVER_NAME,
  SERVER_VERSION,
} from './server.js';
import { lockdownActive, lockdownSummary } from '../core/policy/lockdown.js';
import { log } from '../core/util/log.js';

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

export interface McpHttpOptions {
  port?: number;
  host?: string;
  /** name -> token. Empty means no auth, which is only allowed on loopback. */
  tokens?: Map<string, string>;
  /** Hosts permitted in the Host header. Enables DNS-rebinding protection. */
  allowedHosts?: string[];
  /** Origins permitted in the Origin header. */
  allowedOrigins?: string[];
  /** Drop a session after this long with no request. Default 30 minutes. */
  sessionIdleMs?: number;
  /** Concurrent tool calls per person. Default 6. */
  perUserConcurrency?: number;
  /** Hard cap on sessions, so a loop cannot exhaust memory. Default 200. */
  maxSessions?: number;
}

/**
 * Parses `OPENSCRAPE_MCP_TOKENS`: `alice:tok1,bob:tok2`.
 *
 * A bare token with no name is accepted and labelled `shared`, because some
 * people will do that anyway and silently failing to parse their config is
 * worse than taking it and saying what it means.
 */
export function parseTokens(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw?.trim()) return map;

  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const at = trimmed.indexOf(':');
    if (at <= 0) {
      map.set('shared', trimmed);
      continue;
    }
    const name = trimmed.slice(0, at).trim();
    const token = trimmed.slice(at + 1).trim();
    if (name && token) map.set(name, token);
  }
  return map;
}

/** Constant-time comparison, so a token cannot be guessed byte by byte. */
function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/* ------------------------------------------------------------------ */
/* Per-person concurrency                                             */
/* ------------------------------------------------------------------ */

/**
 * One person must not be able to starve the rest.
 *
 * A browser page costs roughly a hundred times an HTTP GET, so a single
 * enthusiastic caller launching twenty crawls will push the machine into swap
 * and everyone's requests slow down together. This caps in-flight requests per
 * token and makes the excess wait rather than fail — a queued request is an
 * honest delay, while a 429 to an MCP client usually surfaces as a broken tool.
 */
class UserGate {
  private readonly inFlight = new Map<string, number>();
  private readonly waiting = new Map<string, (() => void)[]>();

  constructor(private readonly limit: number) {}

  async acquire(user: string): Promise<() => void> {
    const current = this.inFlight.get(user) ?? 0;
    if (current < this.limit) {
      this.inFlight.set(user, current + 1);
      return () => this.release(user);
    }

    await new Promise<void>((resolve) => {
      const queue = this.waiting.get(user) ?? [];
      queue.push(resolve);
      this.waiting.set(user, queue);
      log.debug('queued behind this user’s own requests', { user, inFlight: current });
    });
    return () => this.release(user);
  }

  private release(user: string): void {
    const queue = this.waiting.get(user);
    const next = queue?.shift();
    if (next) {
      next();
      return; // the slot passes straight to the waiter
    }
    const current = this.inFlight.get(user) ?? 1;
    if (current <= 1) this.inFlight.delete(user);
    else this.inFlight.set(user, current - 1);
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.inFlight);
  }
}

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

interface Session {
  id: string;
  user: string;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  createdAt: number;
  lastSeen: number;
}

/* ------------------------------------------------------------------ */
/* Request helpers                                                     */
/* ------------------------------------------------------------------ */

const MAX_BODY_BYTES = 8 * 1024 * 1024;

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.byteLength;
    // Bounded, so a large or endless body cannot exhaust memory.
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buf);
  }
  if (!chunks.length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** A JSON-RPC shaped error, which is what an MCP client knows how to show. */
function rpcError(res: ServerResponse, status: number, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null });
}

/* ------------------------------------------------------------------ */
/* The server                                                          */
/* ------------------------------------------------------------------ */

export interface RunningMcpHttp {
  url: string;
  port: number;
  close: () => Promise<void>;
  sessionCount: () => number;
}

export async function startMcpHttp(options: McpHttpOptions = {}): Promise<RunningMcpHttp> {
  // `PORT` is what Render, Railway, Fly and Heroku inject, and a service that
  // ignores it never becomes reachable on those hosts. Our own variable wins
  // when both are set, so a local override still works.
  const port =
    options.port ?? Number(process.env.OPENSCRAPE_MCP_PORT ?? process.env.PORT ?? 3100);

  // Those platforms also route to the container from outside, so binding to
  // loopback there would make the service unreachable while looking healthy.
  // The token requirement below is what keeps that safe, not the bind address.
  const platformHosted = Boolean(process.env.PORT || process.env.RENDER || process.env.FLY_APP_NAME);
  const host =
    options.host ?? process.env.OPENSCRAPE_MCP_HOST ?? (platformHosted ? '0.0.0.0' : '127.0.0.1');
  const tokens = options.tokens ?? parseTokens(process.env.OPENSCRAPE_MCP_TOKENS);
  const sessionIdleMs = options.sessionIdleMs ?? Number(process.env.OPENSCRAPE_MCP_IDLE_MS ?? 30 * 60_000);
  const maxSessions = options.maxSessions ?? Number(process.env.OPENSCRAPE_MCP_MAX_SESSIONS ?? 200);
  const perUser = options.perUserConcurrency ?? Number(process.env.OPENSCRAPE_MCP_PER_USER ?? 6);

  const allowedHosts =
    options.allowedHosts ??
    process.env.OPENSCRAPE_MCP_ALLOWED_HOSTS?.split(',').map((h) => h.trim()).filter(Boolean);
  const allowedOrigins =
    options.allowedOrigins ??
    process.env.OPENSCRAPE_MCP_ALLOWED_ORIGINS?.split(',').map((o) => o.trim()).filter(Boolean);

  // The one refusal that is not negotiable. Everything this server can do —
  // drive a browser, read files, run page scripts — becomes anonymous if it
  // listens on a routable address with no token.
  if (!isLoopback(host) && tokens.size === 0) {
    throw new Error(
      `Refusing to listen on ${host} with no authentication.\n\n` +
        `Set OPENSCRAPE_MCP_TOKENS to one or more name:token pairs, for example:\n` +
        `  OPENSCRAPE_MCP_TOKENS="alice:$(openssl rand -hex 24),bob:$(openssl rand -hex 24)"\n\n` +
        `Or bind to 127.0.0.1 and put a tunnel or reverse proxy in front.`,
    );
  }

  const sessions = new Map<string, Session>();
  const gate = new UserGate(perUser);

  const authenticate = (req: IncomingMessage): { ok: true; user: string } | { ok: false; reason: string } => {
    if (tokens.size === 0) return { ok: true, user: 'local' };

    const header = req.headers.authorization ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match) return { ok: false, reason: 'missing Authorization: Bearer <token> header' };

    const given = match[1]!.trim();
    for (const [name, expected] of tokens) {
      if (tokenMatches(given, expected)) return { ok: true, user: name };
    }
    return { ok: false, reason: 'token not recognised' };
  };

  const closeSession = async (id: string, why: string): Promise<void> => {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    log.info('mcp session closed', { id: id.slice(0, 8), user: session.user, why });
    try {
      await session.transport.close();
      await session.server.close();
    } catch (err) {
      log.debug('error closing session', String(err));
    }
  };

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? host}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // Health is unauthenticated on purpose: a load balancer or uptime check
    // should not need a credential, and it reveals nothing but liveness.
    if (path === '/health' && req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        server: SERVER_NAME,
        version: SERVER_VERSION,
        transport: 'streamable-http',
        sessions: sessions.size,
        lockdown: lockdownActive(),
      });
      return;
    }

    if (path !== '/mcp') {
      rpcError(res, 404, -32601, `No endpoint at ${path}. The MCP endpoint is POST /mcp.`);
      return;
    }

    const auth = authenticate(req);
    if (!auth.ok) {
      // WWW-Authenticate tells a compliant client how to retry.
      res.setHeader('WWW-Authenticate', 'Bearer realm="openscrape"');
      rpcError(res, 401, -32001, `Unauthorized: ${auth.reason}`);
      return;
    }
    const user = auth.user;
    const sessionId = (req.headers['mcp-session-id'] as string | undefined)?.trim();

    // Existing session: route to its transport.
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        rpcError(res, 404, -32001, 'Unknown or expired session. Re-initialize.');
        return;
      }
      // A session belongs to the token that opened it. Without this check a
      // leaked session id would let one token drive another's session.
      if (session.user !== user) {
        rpcError(res, 403, -32001, 'This session belongs to a different token.');
        return;
      }

      session.lastSeen = Date.now();

      if (req.method === 'DELETE') {
        await closeSession(sessionId, 'client requested');
        res.writeHead(204).end();
        return;
      }

      const body = req.method === 'POST' ? await readJsonBody(req) : undefined;
      const release = await gate.acquire(user);
      try {
        await session.transport.handleRequest(req, res, body);
      } finally {
        release();
      }
      return;
    }

    // No session id: only an initialize request may open one.
    if (req.method !== 'POST') {
      rpcError(res, 400, -32000, 'Expected POST with an initialize request, or an Mcp-Session-Id header.');
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      rpcError(res, 400, -32700, `Could not read request body: ${String(err)}`);
      return;
    }

    if (!isInitializeRequest(body)) {
      rpcError(
        res,
        400,
        -32000,
        'No Mcp-Session-Id header and this is not an initialize request. Start with initialize.',
      );
      return;
    }

    if (sessions.size >= maxSessions) {
      rpcError(res, 503, -32000, `Too many open sessions (${sessions.size}). Try again shortly.`);
      return;
    }

    // A fresh McpServer per session. The tool registrations are cheap; the
    // heavy state (SQLite, browser, crawl engine) is module-level and shared,
    // which is deliberate — see mcp/server.ts.
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, {
          id,
          user,
          server,
          transport,
          createdAt: Date.now(),
          lastSeen: Date.now(),
        });
        log.info('mcp session opened', { id: id.slice(0, 8), user, sessions: sessions.size });
      },
      onsessionclosed: (id) => {
        void closeSession(id, 'transport closed');
      },
      ...(allowedHosts?.length || allowedOrigins?.length
        ? { enableDnsRebindingProtection: true, allowedHosts, allowedOrigins }
        : {}),
    });

    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) void closeSession(id, 'transport onclose');
    };

    await server.connect(transport);

    const release = await gate.acquire(user);
    try {
      await transport.handleRequest(req, res, body);
    } finally {
      release();
    }
  };

  const http = createHttpServer((req, res) => {
    void handler(req, res).catch((err) => {
      log.error('mcp http handler failed', String(err));
      if (!res.headersSent) rpcError(res, 500, -32603, `Internal error: ${String(err)}`);
      else res.end();
    });
  });

  // Idle sessions hold a server object and possibly a browser context each, so
  // a client that disconnects without a DELETE must not leak one forever.
  const reaper = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastSeen > sessionIdleMs) {
        void closeSession(id, `idle for ${Math.round((now - session.lastSeen) / 60_000)} min`);
      }
    }
  }, 60_000);
  reaper.unref();

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, host, () => {
      http.removeListener('error', reject);
      resolve();
    });
  });

  const shown = isLoopback(host) ? `http://127.0.0.1:${port}/mcp` : `http://${host}:${port}/mcp`;

  log.info(`openscrape mcp ready on ${shown}`);
  log.info(
    tokens.size > 0
      ? `auth: ${tokens.size} token(s) for ${[...tokens.keys()].join(', ')}`
      : 'auth: NONE (loopback only)',
  );
  log.info(`limits: ${perUser} concurrent call(s) per person, ${maxSessions} sessions max`);
  log.info(lockdownSummary());

  // The combination that bites: reachable by the team, and no policy limiting
  // what a tool call may do to the host it runs on.
  if (!isLoopback(host) && !lockdownActive()) {
    log.warn(
      'No lockdown file. This server can read local files (parse_file) and run ' +
        'arbitrary page scripts (executeJavascript) on behalf of anyone holding a token. ' +
        'Write a lockdown.json before sharing this URL — see lockdown_status.',
    );
  }

  return {
    url: shown,
    port,
    sessionCount: () => sessions.size,
    close: async () => {
      clearInterval(reaper);
      for (const id of [...sessions.keys()]) await closeSession(id, 'server shutting down');
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

const entry = (process.argv[1] ?? '').replace(/\\/g, '/');
if (/\/mcp\/http\.(ts|js)$/.test(entry)) {
  runStartupTasks();
  const running = await startMcpHttp();
  installProcessHandlers(async () => {
    await running.close();
  });
}
