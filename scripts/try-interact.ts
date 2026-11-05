/**
 * Smoke test for persistent sessions, full-page scan and logged-in profiles.
 *   npx tsx scripts/try-interact.ts
 *
 * Everything here hits real sites and leaves nothing running: the script closes
 * every session and the shared browser before it exits.
 */
import {
  actOnSession,
  closeSession,
  closedSessionNote,
  listSessions,
  openSession,
  readSession,
  shutdownSessions,
} from '../src/core/interact/session.js';
import { browserFetch, getBrowserExtras, closeBrowser, listProfiles, PROFILES_DIR } from '../src/core/fetcher/browser.js';
import { extractFromHtml } from '../src/core/extract/pipeline.js';

let failures = 0;
function check(label: string, pass: boolean, detail = ''): void {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!pass) failures++;
}
function head(title: string): void {
  console.log(`\n=== ${title} ===`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
head('1. search box: type a query, press Enter, read the results page');
// ---------------------------------------------------------------------------
{
  const opened = await openSession({
    url: 'https://en.wikipedia.org/wiki/Main_Page',
    label: 'wikipedia search',
    idleTimeoutMs: 120_000,
    blockResources: false,
  });
  console.log(`opened ${opened.id} status=${opened.status} url=${opened.info.url}`);
  console.log(`title: ${opened.info.title}`);

  const act = await actOnSession(
    opened.id,
    [
      { type: 'click', selector: 'input[name="search"]' },
      { type: 'write', selector: 'input[name="search"]', text: 'Playwright (software)' },
      { type: 'press', key: 'Enter' },
      { type: 'wait', milliseconds: 2500 },
      { type: 'executeJavascript', script: 'document.title' },
      { type: 'screenshot' },
    ],
    { maxChars: 1500 },
  );
  for (const o of act.outcomes) {
    console.log(
      `  [${o.index}] ${o.ok ? 'ok ' : 'ERR'} ${o.detail}` +
        (o.error ? ` :: ${o.error}` : '') +
        (o.value !== undefined ? ` :: value=${JSON.stringify(o.value)}` : '') +
        (o.screenshot ? ` :: png ${Math.round(o.screenshot.length / 1366)}KB` : ''),
    );
  }
  check('all 6 actions ran', act.failedAt === undefined && act.outcomes.length === 6);
  check('screenshot came back', act.outcomes.some((o) => Boolean(o.screenshot)));

  const read = await readSession(opened.id, { formats: ['markdown', 'links'], maxChars: 1200, maxLinks: 5 });
  console.log(`\nafter search: url=${read.info.url}`);
  console.log(`title=${read.info.title}`);
  console.log(`markdown (${read.markdown?.length ?? 0} chars):\n${(read.markdown ?? '').slice(0, 700)}\n`);
  console.log(`first links: ${(read.links ?? []).join(' | ')}`);

  const movedOffMainPage = !/Main_Page$/.test(read.info.url);
  check('navigated away from the main page', movedOffMainPage, read.info.url);
  check(
    'results mention the query',
    /playwright/i.test(read.markdown ?? '') || /playwright/i.test(read.info.title ?? ''),
  );
  check('state survived across separate tool-level calls', read.info.calls >= 2, `calls=${read.info.calls}`);

  check('session closed cleanly', await closeSession(opened.id, 'test finished'));
}

// ---------------------------------------------------------------------------
head('2. full-page scan on a real infinite-scroll page (session action)');
// ---------------------------------------------------------------------------
const SCROLL_URL = 'https://quotes.toscrape.com/scroll';
{
  const opened = await openSession({ url: SCROLL_URL, label: 'scan', idleTimeoutMs: 120_000 });
  const before = await readSession(opened.id, { formats: ['text'], maxChars: 200_000 });
  const countQuotes = (text: string) => (text.match(/“|“/g) ?? []).length;
  const quotesBefore = countQuotes(before.text ?? '');

  const act = await actOnSession(opened.id, [{ type: 'scanFullPage', maxScrolls: 40, scrollDelay: 400 }]);
  const scan = act.outcomes[0]?.scan;
  console.log('scan report:', JSON.stringify(scan, null, 2));

  const after = await readSession(opened.id, { formats: ['text'], maxChars: 200_000 });
  const quotesAfter = countQuotes(after.text ?? '');
  console.log(`quotes on page: ${quotesBefore} → ${quotesAfter}`);

  check('scan reported scrolls', Boolean(scan && scan.scrolls > 0), `scrolls=${scan?.scrolls}`);
  check('document grew while scrolling', Boolean(scan && scan.grewBy > 0), `+${scan?.grewBy}px`);
  check('more content was actually loaded', quotesAfter > quotesBefore, `${quotesBefore} → ${quotesAfter}`);
  check(
    'stopped on its own, before the cap',
    scan?.stoppedBecause === 'height-stable',
    `stoppedBecause=${scan?.stoppedBecause}`,
  );
  await closeSession(opened.id, 'test finished');
}

// ---------------------------------------------------------------------------
head('3. full-page scan as a browserFetch option (and lazy images)');
// ---------------------------------------------------------------------------
{
  const plain = await browserFetch(SCROLL_URL);
  const scanned = await browserFetch(SCROLL_URL, { scanFullPage: { maxScrolls: 30, scrollDelay: 400 } });
  const mdOf = (buf: Buffer) => extractFromHtml(buf.toString('utf8'), SCROLL_URL, { onlyMainContent: true }).markdown;
  const plainMd = mdOf(plain.body);
  const scannedMd = mdOf(scanned.body);
  const report = getBrowserExtras(scanned)?.scan;
  console.log('scan report:', JSON.stringify(report));
  console.log(`markdown: ${plainMd.length} chars without scan → ${scannedMd.length} chars with scan`);
  check('browserFetch honours scanFullPage', Boolean(report), 'extras.scan present');
  check('scanned fetch returned more content', scannedMd.length > plainMd.length * 1.5);
  check('plain browserFetch still works unchanged', plain.status === 200 && plainMd.length > 100);

  // Lazy images: Wikipedia marks below-the-fold thumbnails loading="lazy", so the
  // browser holds off fetching them until they near the viewport. Decoded-image
  // growth is therefore the honest signal that the scan triggered lazy loading.
  const LAZY_URL = 'https://en.wikipedia.org/wiki/Cat';
  try {
    const lazy = await browserFetch(LAZY_URL, {
      formats: ['screenshot'],
      scanFullPage: { maxScrolls: 12, scrollDelay: 400 },
    });
    const r = getBrowserExtras(lazy)?.scan;
    console.log(`lazy-image page: ${JSON.stringify(r)}`);
    check(
      'scrolling made the browser fetch lazy images it had skipped',
      Boolean(r && r.imagesDecodedAfter > r.imagesDecodedBefore),
      r
        ? `${r.imagesAfter} <img> on the page, decoded ${r.imagesDecodedBefore} → ${r.imagesDecodedAfter}`
        : 'no report',
    );
  } catch (err) {
    console.log(`  (lazy-image page unreachable: ${String(err).slice(0, 120)})`);
  }
}

// ---------------------------------------------------------------------------
head('4. persistent profile: a cookie survives closing the browser');
// ---------------------------------------------------------------------------
{
  const PROFILE = 'smoketest';
  const first = await openSession({ url: 'https://example.com/', profile: PROFILE, idleTimeoutMs: 60_000 });
  console.log(`profile session ${first.id} on ${first.info.url} (profile=${first.info.profile})`);
  await actOnSession(first.id, [
    {
      type: 'executeJavascript',
      script: "document.cookie = 'openscrape_profile_test=yes; max-age=3600; path=/'; document.cookie",
    },
  ]);
  await closeSession(first.id, 'test finished');
  // Closing the persistent context is what flushes cookies to disk.
  const { closeProfileContexts } = await import('../src/core/fetcher/browser.js');
  const released = await closeProfileContexts();
  console.log(`released ${released} profile context(s)`);

  const second = await openSession({ url: 'https://example.com/', profile: PROFILE, idleTimeoutMs: 60_000 });
  const back = await actOnSession(second.id, [{ type: 'executeJavascript', script: 'document.cookie' }]);
  const cookie = String(back.outcomes[0]?.value ?? '');
  console.log(`cookie read back in a brand-new browser: ${JSON.stringify(cookie)}`);
  check('cookie persisted across browser restarts', cookie.includes('openscrape_profile_test=yes'), cookie);
  await closeSession(second.id, 'test finished');

  const profiles = listProfiles();
  console.log(`profiles dir: ${PROFILES_DIR}`);
  console.log(profiles.map((p) => `  ${p.name} (modified ${p.modified}, open=${p.open})`).join('\n'));
  check('profile is listed on disk', profiles.some((p) => p.name === PROFILE));
}

// ---------------------------------------------------------------------------
head('5. idle sessions close themselves');
// ---------------------------------------------------------------------------
{
  const doomed = await openSession({ url: 'https://example.com/', idleTimeoutMs: 5_000, label: 'idle test' });
  console.log(`opened ${doomed.id} with a 5s idle timeout; waiting 7s…`);
  await sleep(7_000);
  const live = await listSessions();
  const note = closedSessionNote(doomed.id);
  check('session is gone', !live.some((s) => s.id === doomed.id));
  check('and says why', Boolean(note?.reason.includes('idle')), note?.reason ?? 'no note');
}

// ---------------------------------------------------------------------------
head('6. shutdown leaves nothing behind');
// ---------------------------------------------------------------------------
{
  await openSession({ url: 'https://example.com/', label: 'shutdown a' });
  await openSession({ url: 'https://example.com/', profile: 'smoketest', label: 'shutdown b' });
  console.log(`${(await listSessions()).length} session(s) open before shutdown`);
  await shutdownSessions('smoke test over');
  check('all sessions closed by shutdownSessions', (await listSessions()).length === 0);
  await closeBrowser();
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
