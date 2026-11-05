/**
 * The checks that decide whether this is safe to expose to a team.
 *
 * Each one is an attack a token holder could run against the host the server
 * sits on. The cloud-metadata case is the one that matters most: on any cloud
 * VM, 169.254.169.254 hands out the instance's credentials to whoever asks,
 * so a scraper that will fetch arbitrary URLs is a credential leak unless it
 * refuses that address.
 *
 *   OPENSCRAPE_MODE=hosted npx tsx scripts/try-hosted-safety.ts
 */
import { scrape } from '../src/core/scrape.js';

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
    if (detail) console.log(`        ${detail}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}  ${detail}`);
  }
}

async function mustRefuse(label: string, url: string): Promise<void> {
  const r = await scrape(url, { maxAge: 0, timeout: 8000 });
  const refused = !r.success && Boolean(r.error);
  check(label, refused, refused ? r.error!.slice(0, 130) : `SUCCEEDED — ${r.markdown?.length ?? 0} chars returned`);
}

console.log(`OPENSCRAPE_MODE = ${process.env.OPENSCRAPE_MODE ?? '(unset)'}`);
console.log(`OPENSCRAPE_ALLOW_PRIVATE_TARGETS = ${process.env.OPENSCRAPE_ALLOW_PRIVATE_TARGETS ?? '(unset)'}\n`);

console.log('1. cloud metadata — the credential-theft case');
await mustRefuse('AWS/GCP/Azure metadata IP', 'http://169.254.169.254/latest/meta-data/');
await mustRefuse('GCP metadata by name', 'http://metadata.google.internal/computeMetadata/v1/');

console.log('\n2. the private network the server sits in');
await mustRefuse('loopback', 'http://127.0.0.1:6379/');
await mustRefuse('localhost by name', 'http://localhost:8080/');
await mustRefuse('RFC1918 10/8', 'http://10.0.0.1/');
await mustRefuse('RFC1918 192.168/16', 'http://192.168.1.1/admin');
await mustRefuse('RFC1918 172.16/12', 'http://172.16.0.1/');
await mustRefuse('link-local', 'http://169.254.1.1/');
await mustRefuse('IPv6 loopback', 'http://[::1]:6379/');
await mustRefuse('a .internal name', 'http://db.internal/');

console.log('\n3. non-http schemes');
await mustRefuse('file://', 'file:///etc/passwd');

console.log('\n4. a public URL still works — the guard must not break the product');
{
  const r = await scrape('https://example.com', { maxAge: 10 * 60 * 1000 });
  // Asserted on body text, not on "Example Domain" — that string is the page
  // title, which lives in metadata, so checking the markdown for it would be
  // testing the wrong field and would pass or fail for the wrong reason.
  check(
    'example.com scrapes fine',
    r.success && /documentation examples/.test(r.markdown ?? ''),
    `${r.markdown?.length ?? 0} chars, title "${r.metadata.title}"`,
  );
}

console.log('\n5. the guard is cached, not re-resolved per page');
{
  // Second call to the same host must not pay another DNS lookup. Measured
  // rather than asserted from the code, because a regression here shows up as
  // a slow crawl rather than as a failure.
  const t0 = Date.now();
  await scrape('https://example.com/a', { maxAge: 0, timeout: 8000 }).catch(() => undefined);
  const first = Date.now() - t0;
  const t1 = Date.now();
  await scrape('https://example.com/b', { maxAge: 0, timeout: 8000 }).catch(() => undefined);
  const second = Date.now() - t1;
  check('a repeat host is not slower', second <= first + 200, `first ${first}ms, second ${second}ms`);
}

if (process.env.OPENSCRAPE_MODE === 'hosted') {
  console.log('\n6. hosted mode turns off the dangerous capabilities');
  const { lockdownConfig, lockdownSummary } = await import('../src/core/policy/lockdown.js');
  const c = lockdownConfig();
  check('a policy is active', Boolean(c), lockdownSummary().slice(0, 120));
  check('local file reads off', c?.allowFileParse === false);
  check('executeJavascript off', c?.allowExecuteJavascript === false);
  check('private targets off', c?.allowPrivateTargets === false);
  check('robots.txt enforced', c?.requireRobots === true);

  const js = await scrape('https://example.com', {
    maxAge: 0,
    actions: [{ type: 'executeJavascript', script: 'return document.cookie' }],
  });
  check('an executeJavascript action is refused', !js.success, js.error?.slice(0, 110));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
