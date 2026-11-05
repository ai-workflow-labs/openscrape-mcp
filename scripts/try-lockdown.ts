/**
 * Proves the lockdown actually blocks, rather than merely reporting itself.
 *
 * Each case writes a config, reloads it, and tries the thing it forbids. A
 * security control is only worth having if the refusal can be demonstrated, so
 * every case asserts that the call FAILED, not that it printed a warning.
 *
 *   npx tsx scripts/try-lockdown.ts
 */
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LockdownConfig } from '../src/core/policy/lockdown.js';

const dir = mkdtempSync(join(tmpdir(), 'openscrape-lockdown-'));
const file = join(dir, 'lockdown.json');
process.env.OPENSCRAPE_LOCKDOWN = file;

// Imported after the env var is set; the module reads it on first use.
const { reloadLockdown, lockdownSummary } = await import('../src/core/policy/lockdown.js');
const { scrape } = await import('../src/core/scrape.js');

let pass = 0;
let fail = 0;

function write(config: LockdownConfig | string): void {
  writeFileSync(file, typeof config === 'string' ? config : JSON.stringify(config, null, 2), 'utf8');
  reloadLockdown();
}

async function expectRefused(label: string, url: string, opts = {}): Promise<void> {
  const r = await scrape(url, { maxAge: 0, ...opts });
  if (!r.success && r.error) {
    pass++;
    console.log(`  PASS  ${label}`);
    console.log(`        ${r.error.slice(0, 150)}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label} — the call SUCCEEDED and should not have`);
  }
}

async function expectAllowed(label: string, url: string, opts = {}): Promise<void> {
  const r = await scrape(url, { maxAge: 10 * 60 * 1000, ...opts });
  if (r.success) {
    pass++;
    console.log(`  PASS  ${label} (${r.markdown?.length ?? 0} chars)`);
  } else {
    fail++;
    console.log(`  FAIL  ${label} — refused but should have been allowed: ${r.error}`);
  }
}

console.log('1. allowedDomains is a whitelist');
write({ allowedDomains: ['example.com'] });
console.log(`  ${lockdownSummary()}`);
await expectAllowed('example.com is allowed', 'https://example.com');
await expectRefused('wikipedia.org is refused', 'https://en.wikipedia.org/wiki/Web_scraping');
await expectRefused('a lookalike host is refused', 'https://notexample.com');

console.log('\n2. subdomains of an allowed domain are allowed');
write({ allowedDomains: ['toscrape.com'] });
await expectAllowed('books.toscrape.com is allowed', 'https://books.toscrape.com');

console.log('\n3. blockedDomains overrides');
write({ blockedDomains: ['example.com'] });
await expectRefused('example.com is blocked', 'https://example.com');
await expectAllowed('anything else still works', 'https://books.toscrape.com');

console.log('\n4. allowedFormats');
write({ allowedFormats: ['markdown'] });
await expectRefused('rawHtml is refused', 'https://example.com', { formats: ['rawHtml'] });
await expectAllowed('markdown is allowed', 'https://example.com', { formats: ['markdown'] });

console.log('\n5. allowExecuteJavascript:false');
write({ allowExecuteJavascript: false });
await expectRefused('the executeJavascript action is refused', 'https://example.com', {
  actions: [{ type: 'executeJavascript', script: 'return 1' }],
});

console.log('\n6. allowActions:false');
write({ allowActions: false });
await expectRefused('any action is refused', 'https://example.com', {
  actions: [{ type: 'click', selector: 'a' }],
});

console.log('\n7. allowBrowser:false');
write({ allowBrowser: false });
await expectRefused('render:"browser" is refused', 'https://example.com', { render: 'browser' });
await expectRefused('a screenshot is refused', 'https://example.com', { formats: ['screenshot'] });

console.log('\n8. maxChars is a ceiling, not a default');
write({ maxChars: 200 });
const capped = await scrape('https://en.wikipedia.org/wiki/Web_scraping', {
  maxAge: 10 * 60 * 1000,
  maxChars: 50_000,
});
// The cap applies to the content; a truncation notice is then appended, which
// is how maxChars behaves everywhere in this tool. So the assertion is on the
// content before that marker, not on the whole string.
const content = (capped.markdown ?? '').split('\n\n---\n')[0] ?? '';
const announced = /maxChars reduced from 50000 to 200/.test(capped.warning ?? '');
const truncated = /\[truncated/.test(capped.markdown ?? '');
if (content.length <= 200 && announced && truncated) {
  pass++;
  console.log(`  PASS  50000 requested, content capped to ${content.length} chars, and it said so`);
} else {
  fail++;
  console.log(
    `  FAIL  content=${content.length} announced=${announced} truncated=${truncated} warning=${capped.warning}`,
  );
}

console.log('\n9. a broken config file fails CLOSED');
write('{ this is not json');
await expectRefused('everything is refused while the file is invalid', 'https://example.com');
console.log(`  ${lockdownSummary().slice(0, 150)}`);

console.log('\n10. a missing file named explicitly also fails closed');
rmSync(file);
reloadLockdown();
await expectRefused('a named-but-absent config refuses', 'https://example.com');

console.log(`\n${pass} passed, ${fail} failed`);
rmSync(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
