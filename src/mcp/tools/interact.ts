/**
 * MCP tools for persistent browser sessions, full-page scanning and logged-in
 * profiles. Firecrawl charges 2 credits per browser minute for `interact`;
 * these run a local Chromium and cost nothing.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  actOnSession,
  closeAllSessions,
  closeSession,
  errText,
  listSessions,
  openSession,
  readSession,
  recentlyClosedSessions,
  shutdownSessions,
  DEFAULT_IDLE_TIMEOUT_MS,
  type ActResult,
  type ReadFormat,
  type SessionAction,
  type SessionInfo,
} from '../../core/interact/session.js';
import { listProfiles, PROFILES_DIR } from '../../core/fetcher/browser.js';

export { shutdownSessions as shutdownInteract } from '../../core/interact/session.js';

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

/** Screenshots travel as real image blocks, never as base64 inside the text. */
function imageBlock(dataUrl: string): ContentBlock {
  const [meta, data] = dataUrl.split(',', 2);
  const mimeType = /data:([^;]+)/.exec(meta ?? '')?.[1] ?? 'image/png';
  return { type: 'image', data: data ?? '', mimeType };
}

function ok(blocks: ContentBlock[]) {
  return { content: blocks };
}

function fail(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

function secs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

function sessionLine(info: SessionInfo): string {
  const bits = [
    `session: ${info.id}`,
    info.label ? `label: ${info.label}` : '',
    `url: ${info.url || '(blank)'}`,
    info.title ? `title: ${info.title}` : '',
    info.profile ? `profile: ${info.profile}${info.headless ? '' : ' (visible window)'}` : 'profile: none (throwaway context)',
    `calls: ${info.calls} · idle ${secs(info.idleMs)} · auto-closes in ${secs(info.closesInMs)}`,
  ];
  return bits.filter(Boolean).join('\n');
}

const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('wait'), milliseconds: z.number().optional(), selector: z.string().optional() }),
  z.object({ type: z.literal('click'), selector: z.string(), all: z.boolean().optional() }),
  z.object({ type: z.literal('write'), selector: z.string().optional(), text: z.string() }),
  z.object({ type: z.literal('press'), key: z.string() }),
  z.object({
    type: z.literal('scroll'),
    direction: z.enum(['up', 'down']).optional(),
    amount: z.number().optional(),
    selector: z.string().optional(),
  }),
  z.object({ type: z.literal('scrape') }),
  z.object({ type: z.literal('screenshot'), fullPage: z.boolean().optional() }),
  z.object({ type: z.literal('executeJavascript'), script: z.string() }),
  z.object({ type: z.literal('navigate'), url: z.string() }),
  z.object({
    type: z.literal('scanFullPage'),
    maxScrolls: z.number().optional(),
    scrollDelay: z.number().optional(),
    stepRatio: z.number().optional(),
    stableRounds: z.number().optional(),
    settleAfter: z.number().optional(),
    scrollBackToTop: z.boolean().optional(),
  }),
]);

const readFormatEnum = z.enum(['markdown', 'text', 'html', 'rawHtml', 'links']);

function renderAct(result: ActResult): ContentBlock[] {
  const lines: string[] = [];
  for (const o of result.outcomes) {
    const head = `${o.ok ? 'OK ' : 'ERR'} [${o.index}] ${o.detail ?? o.type}`;
    lines.push(head);
    if (o.error) lines.push(`      error: ${o.error}`);
    if (o.value !== undefined) lines.push(`      value: ${preview(o.value)}`);
    if (o.screenshot) lines.push('      screenshot: returned as an image below');
    if (o.markdown) lines.push(`      markdown: ${o.markdown.length} chars (below)`);
  }
  if (result.failedAt !== undefined) {
    const skipped = result.outcomes.length;
    lines.push(
      `\nStopped at action ${result.failedAt}. Actions after it were NOT run (${skipped} of them reported above). The session is still open and sits at the URL below.`,
    );
  }
  lines.push('', sessionLine(result.info));

  const blocks: ContentBlock[] = [{ type: 'text', text: lines.join('\n') }];
  for (const o of result.outcomes) {
    if (o.markdown) blocks.push({ type: 'text', text: `\n--- markdown from action ${o.index} ---\n${o.markdown}` });
    if (o.screenshot) blocks.push(imageBlock(o.screenshot));
  }
  return blocks;
}

function preview(value: unknown): string {
  let s: string;
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  s = (s ?? 'undefined').replace(/\s+/g, ' ');
  return s.length > 400 ? s.slice(0, 400) + `… (+${s.length - 400} chars)` : s;
}

export function registerInteractTools(server: McpServer): void {
  server.registerTool(
    'interact_open',
    {
      title: 'Open a browser session',
      description:
        'Open a persistent browser session: one real Chromium page that stays alive across tool calls, so you can ' +
        'log in, navigate, fill forms and click through a wizard with all state preserved. Returns a session id for ' +
        'interact_act / interact_read / interact_stop. Sessions close themselves after an idle period (default 10 ' +
        'minutes), so always stop one when you are done. Pass `profile` to reuse a logged-in profile saved by profile_login.',
      inputSchema: {
        url: z.string().optional().describe('Navigate here immediately after opening.'),
        profile: z
          .string()
          .optional()
          .describe('Named persistent profile to reuse (cookies from an earlier sign-in). See profile_list.'),
        label: z.string().optional().describe('A short note to tell this session apart in interact_sessions.'),
        mobile: z.boolean().optional().describe('Emulate a phone.'),
        viewportWidth: z.number().optional().describe('Viewport width in px.'),
        viewportHeight: z.number().optional().describe('Viewport height in px.'),
        proxy: z.string().optional().describe('Proxy URL, e.g. http://user:pass@host:port.'),
        headers: z.record(z.string()).optional().describe('Extra request headers.'),
        idleTimeoutMinutes: z
          .number()
          .optional()
          .describe(`Close the session after this long with no calls. Default ${DEFAULT_IDLE_TIMEOUT_MS / 60_000} minutes.`),
        waitForSelector: z.string().optional().describe('After the first navigation, wait for this CSS selector.'),
        waitFor: z.number().optional().describe('Extra settle time after the first navigation, in ms.'),
        scanFullPage: z
          .boolean()
          .optional()
          .describe('Scroll to the bottom right after loading, to trigger infinite scroll and lazy images.'),
        blockResources: z
          .boolean()
          .optional()
          .describe('Drop images, media and fonts to save bandwidth. Default false for sessions.'),
        timeout: z.number().optional().describe('Navigation timeout in ms. Default 45000.'),
      },
    },
    async (args) => {
      try {
        const viewport =
          typeof args.viewportWidth === 'number' && typeof args.viewportHeight === 'number'
            ? { width: args.viewportWidth, height: args.viewportHeight }
            : undefined;
        const opened = await openSession({
          url: args.url as string | undefined,
          profile: args.profile as string | undefined,
          label: args.label as string | undefined,
          mobile: args.mobile as boolean | undefined,
          viewport,
          proxy: args.proxy as string | undefined,
          headers: args.headers as Record<string, string> | undefined,
          idleTimeoutMs:
            typeof args.idleTimeoutMinutes === 'number' ? args.idleTimeoutMinutes * 60_000 : undefined,
          waitForSelector: args.waitForSelector as string | undefined,
          waitFor: args.waitFor as number | undefined,
          scanFullPage: args.scanFullPage as boolean | undefined,
          blockResources: args.blockResources as boolean | undefined,
          timeout: args.timeout as number | undefined,
        });
        const lines = ['Session open.', sessionLine(opened.info)];
        if (opened.status !== undefined) lines.push(`http status: ${opened.status}`);
        if (opened.scan) {
          lines.push(
            `full-page scan: ${opened.scan.scrolls} step(s), height ${opened.scan.startHeight}→${opened.scan.endHeight}px, ` +
              `${opened.scan.imagesWithSrcBefore}→${opened.scan.imagesWithSrcAfter} images with a real src (${opened.scan.stoppedBecause})`,
          );
        }
        lines.push('', 'Next: interact_act to click/type, interact_read to read the page, interact_stop when done.');
        return ok([{ type: 'text', text: lines.join('\n') }]);
      } catch (err) {
        return fail(`Could not open a session: ${errText(err)}`);
      }
    },
  );

  server.registerTool(
    'interact_act',
    {
      title: 'Act on a browser session',
      description:
        'Run a list of actions against an open session: click, write, press, scroll, wait, navigate, ' +
        'executeJavascript, screenshot, scrape (returns markdown) and scanFullPage (scroll to the bottom to trigger ' +
        'infinite scroll and lazy images). Actions run in order and stop at the first failure; the report says exactly ' +
        'which ones ran. The page keeps its state afterwards.',
      inputSchema: {
        sessionId: z.string().describe('Session id from interact_open.'),
        actions: z.array(actionSchema).min(1).describe('Actions to run, in order.'),
        maxChars: z.number().optional().describe('Cap markdown returned by `scrape` actions. Default 4000.'),
        onlyMainContent: z
          .boolean()
          .optional()
          .describe('Strip nav/header/footer from `scrape` markdown. Default true.'),
      },
    },
    async (args) => {
      const id = String(args.sessionId);
      try {
        const result = await actOnSession(id, args.actions as SessionAction[], {
          maxChars: args.maxChars as number | undefined,
          onlyMainContent: args.onlyMainContent as boolean | undefined,
        });
        const blocks = renderAct(result);
        return { content: blocks, isError: result.failedAt !== undefined };
      } catch (err) {
        return fail(errText(err));
      }
    },
  );

  server.registerTool(
    'interact_read',
    {
      title: 'Read a browser session',
      description:
        "Inspect an open session: its current URL and title, plus the live page as clean markdown (or text, HTML, " +
        'links) through the same extraction pipeline `scrape` uses. Use `maxChars` to cap context use and ' +
        '`screenshot` for a picture of what the page looks like right now.',
      inputSchema: {
        sessionId: z.string().describe('Session id from interact_open.'),
        formats: z
          .array(readFormatEnum)
          .optional()
          .describe('What to return. Default ["markdown"]. "rawHtml" is the untouched DOM and is expensive.'),
        maxChars: z.number().optional().describe('Cap characters per text format. Default 8000.'),
        onlyMainContent: z.boolean().optional().describe('Strip nav/header/footer. Default true.'),
        maxLinks: z.number().optional().describe('Cap the number of links listed. Default 100.'),
        screenshot: z.boolean().optional().describe('Also return a PNG of the current page.'),
        screenshotFullPage: z.boolean().optional().describe('Capture the whole page rather than the viewport.'),
      },
    },
    async (args) => {
      const id = String(args.sessionId);
      try {
        const r = await readSession(id, {
          formats: args.formats as ReadFormat[] | undefined,
          maxChars: args.maxChars as number | undefined,
          onlyMainContent: args.onlyMainContent as boolean | undefined,
          maxLinks: args.maxLinks as number | undefined,
          screenshot: args.screenshot as boolean | undefined,
          screenshotFullPage: args.screenshotFullPage as boolean | undefined,
        });
        const parts = [sessionLine(r.info)];
        if (r.truncated) {
          parts.push(
            'truncated: ' +
              Object.entries(r.truncated)
                .map(([k, v]) => `${k} -${v} chars`)
                .join(', '),
          );
        }
        if (r.links) parts.push(`\n## Links (${r.links.length} of ${r.linkCount})\n${r.links.join('\n')}`);
        if (r.markdown) parts.push(`\n## Markdown\n${r.markdown}`);
        if (r.text) parts.push(`\n## Text\n${r.text}`);
        if (r.html) parts.push(`\n## HTML\n${r.html}`);
        if (r.rawHtml) parts.push(`\n## Raw HTML\n${r.rawHtml}`);

        const blocks: ContentBlock[] = [{ type: 'text', text: parts.join('\n') }];
        if (r.screenshot) blocks.push(imageBlock(r.screenshot));
        return ok(blocks);
      } catch (err) {
        return fail(errText(err));
      }
    },
  );

  server.registerTool(
    'interact_sessions',
    {
      title: 'List browser sessions',
      description:
        'List every open browser session with its URL, profile, age, idle time and how long until its idle timeout ' +
        'closes it. Also reports sessions that recently closed and why, so a stale session id can be explained.',
      inputSchema: {
        includeClosed: z.boolean().optional().describe('Also list recently closed sessions and why they closed.'),
      },
    },
    async (args) => {
      const live = await listSessions();
      const parts: string[] = [];
      parts.push(live.length ? `${live.length} open session(s):` : 'No open sessions.');
      for (const info of live) parts.push('', sessionLine(info));

      if (args.includeClosed) {
        const closed = recentlyClosedSessions();
        parts.push('', closed.length ? `Recently closed (${closed.length}):` : 'Nothing closed recently.');
        for (const c of closed) {
          parts.push(`  ${c.id} — ${c.reason} at ${c.at} (last url: ${c.lastUrl || 'n/a'}, ${c.calls} calls)`);
        }
      }
      return ok([{ type: 'text', text: parts.join('\n') }]);
    },
  );

  server.registerTool(
    'interact_stop',
    {
      title: 'Close a browser session',
      description:
        'Close one session (or all of them) and free its Chromium page. Always call this when finished: an idle ' +
        'session is a browser process sitting in memory. For a profile session this is also what flushes new ' +
        'cookies to disk, so stop the session after signing in.',
      inputSchema: {
        sessionId: z.string().optional().describe('Session to close. Omit and pass all=true to close every session.'),
        all: z.boolean().optional().describe('Close every open session.'),
        releaseProfiles: z
          .boolean()
          .optional()
          .describe('With all=true, also close the persistent profile browsers (flushes their cookies to disk).'),
      },
    },
    async (args) => {
      if (args.all) {
        if (args.releaseProfiles) {
          const before = (await listSessions()).length;
          await shutdownSessions('closed by request (interact_stop all)');
          return ok([
            { type: 'text', text: `Closed ${before} session(s) and released all persistent profile browsers.` },
          ]);
        }
        const n = await closeAllSessions('closed by request (interact_stop all)');
        return ok([{ type: 'text', text: `Closed ${n} session(s).` }]);
      }
      if (!args.sessionId) return fail('Pass a sessionId, or all=true to close every session.');
      const id = String(args.sessionId);
      const closed = await closeSession(id, 'closed by request');
      if (closed) return ok([{ type: 'text', text: `Session ${id} closed.` }]);
      const { closedSessionNote } = await import('../../core/interact/session.js');
      const note = closedSessionNote(id);
      return ok([
        {
          type: 'text',
          text: note
            ? `Session ${id} was already closed at ${note.at}: ${note.reason}`
            : `No session ${id} — nothing to close.`,
        },
      ]);
    },
  );

  server.registerTool(
    'profile_list',
    {
      title: 'List browser profiles',
      description:
        'List the persistent browser profiles on this machine. A profile is a real Chromium user-data directory, so ' +
        'cookies and logins saved in it survive restarts and can be reused by interact_open or a scrape. This is the ' +
        'main workaround for sites that block automated access: sign in once by hand with profile_login, then scrape ' +
        'as a logged-in user. Firecrawl cannot do this — it has no browser of yours to sign in with.',
      inputSchema: {},
    },
    async () => {
      const profiles = listProfiles();
      const lines = [`Profiles directory: ${PROFILES_DIR}`, ''];
      if (!profiles.length) {
        lines.push('No profiles yet. Create one with profile_login (opens a visible browser so you can sign in).');
      } else {
        for (const p of profiles) {
          lines.push(
            `  ${p.name} — last used ${p.modified ?? 'unknown'}${p.open ? `, OPEN NOW${p.visible ? ' (visible window)' : ''}` : ''}`,
          );
        }
      }
      return ok([{ type: 'text', text: lines.join('\n') }]);
    },
  );

  server.registerTool(
    'profile_login',
    {
      title: 'Sign in to a site by hand',
      description:
        'Open a VISIBLE Chromium window using a named persistent profile so the human at the keyboard can sign in ' +
        'themselves. Nothing is typed for them and no credentials pass through this server. Once they are signed in, ' +
        'call interact_stop on the returned session id: Chromium then writes the cookies into the profile directory, ' +
        'and later interact_open or scrape calls that pass the same `profile` browse as that logged-in user. ' +
        'Use this for sites that block automated access or require an account.',
      inputSchema: {
        profile: z.string().describe('Profile name to create or reuse, e.g. "work" (letters, digits, . _ - only).'),
        url: z.string().optional().describe("The site's sign-in page to open."),
        idleTimeoutMinutes: z
          .number()
          .optional()
          .describe('How long to leave the window open with no calls. Default 20 minutes — signing in by hand is slow.'),
        label: z.string().optional().describe('A short note for interact_sessions.'),
      },
    },
    async (args) => {
      const profile = String(args.profile);
      try {
        const opened = await openSession({
          profile,
          headful: true,
          url: args.url as string | undefined,
          label: (args.label as string | undefined) ?? `manual sign-in (${profile})`,
          idleTimeoutMs:
            typeof args.idleTimeoutMinutes === 'number' ? args.idleTimeoutMinutes * 60_000 : 20 * 60_000,
        });
        const visible = opened.info.headless === false;
        const lines = [
          visible
            ? `A visible Chromium window is open on profile "${profile}". Sign in in that window.`
            : `Profile "${profile}" was already open headless in this process, so no new window could be shown ` +
              '(Chromium locks a profile directory). Close that session first, then call profile_login again.',
          '',
          sessionLine(opened.info),
          '',
          `When the sign-in is done, call interact_stop with sessionId=${opened.id} — that is what saves the cookies to disk.`,
          `Then pass profile="${profile}" to interact_open to browse as that signed-in user.`,
        ];
        return ok([{ type: 'text', text: lines.join('\n') }]);
      } catch (err) {
        return fail(`Could not open profile "${profile}": ${errText(err)}`);
      }
    },
  );
}
