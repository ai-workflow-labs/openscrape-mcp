/**
 * Guards the deploy config for search, which fails in the quietest way there is.
 *
 * The history: `search` worked on a laptop and would have been dead on every
 * hosted instance, because SearxNG was in no deploy file at all. DuckDuckGo
 * bot-checks a datacentre IP and Brave has no free tier, so SearxNG is not an
 * optimisation — it is the only working provider on a server. Nothing else
 * breaks when it is missing, which is why nobody notices.
 *
 * The checks that matter most are the two name cross-checks: the environment
 * variable in the deploy files is read out of the SOURCE rather than written
 * down twice. `.env.example` really did document `OPENSCRAPE_BRAVE_KEY` while
 * the code read `BRAVE_SEARCH_API_KEY`, so anyone following it set a variable
 * nothing read and got no error — a config typo is invisible in a way a code
 * typo is not.
 *
 * These are text checks, not YAML parsing: the repo has no YAML parser and one
 * is not worth a dependency for this. So they confirm the lines are present and
 * say what they should; they cannot confirm the file parses. `docker compose
 * config` does that, and the Docker plumbing — the mount path, the service
 * network — needs a real Docker daemon. deploy/searxng/settings.yml itself has
 * been loaded through SearxNG's own settings loader, which reported
 * formats=['html','json'], limiter=False and 353 engines merged.
 *
 *   npx tsx scripts/try-deploy-search.ts
 */
import { readFileSync } from 'node:fs';

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

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const settings = read('deploy/searxng/settings.yml');
const compose = read('docker-compose.yml');
const envExample = read('.env.example');
const bootstrap = read('scripts/oracle-bootstrap.sh');
const searxngSrc = read('src/core/search/searxng.ts');
const braveSrc = read('src/core/search/brave.ts');
const deployDoc = read('DEPLOY.md');

/** The `searxng:` service block, by indentation. */
function composeService(name: string): string {
  const lines = compose.split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start < 0) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^(\S|  \S)/.test(lines[i]!) && lines[i]!.trim() !== '') {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

console.log('1. the settings file turns the JSON API on');
{
  // SearxNG's default is formats: [html]. With JSON off every query answers 403
  // or hands back an HTML page, and there is no environment variable for this —
  // which is the entire reason a settings file is mounted at all.
  const formats = /formats:\s*\n((?:\s*-\s*\w+\s*\n)+)/.exec(settings)?.[1] ?? '';
  check('json is listed under search.formats', /-\s*json\b/.test(formats), formats.trim().replace(/\s+/g, ' '));
  check('html is still listed', /-\s*html\b/.test(formats));
  check('the bot limiter is off', /^\s*limiter:\s*false\s*$/m.test(settings));
  // A committed secret would be the same on every deployment that ever cloned
  // this repo.
  check('no secret_key is committed', !/^\s*secret_key:/m.test(settings));
  check('defaults are inherited rather than replaced', /^use_default_settings:\s*true\s*$/m.test(settings));
}

console.log('\n2. compose runs it, and points the server at it');
{
  const svc = composeService('searxng');
  check('a searxng service exists', svc.length > 0, `${svc.split('\n').length} lines`);
  check('it uses the official image', /image:\s*docker\.io\/searxng\/searxng/.test(svc));
  // Published to a host port, it would be an open SearxNG instance with its bot
  // limiter deliberately switched off.
  check('it publishes no host port', !/^\s{4}ports:/m.test(svc), svc.includes('ports:') ? 'found ports:' : 'none');
  check('the settings file is mounted', /deploy\/searxng:\/etc\/searxng/.test(svc));
  check('the secret is required, not defaulted', /SEARXNG_SECRET:\s*\$\{SEARXNG_SECRET:\?/.test(svc));
  check('its healthcheck asks for JSON', /format=json/.test(svc) && /results/.test(svc));
}

console.log('\n3. the env var names match what the code actually reads');
{
  // Read the names out of the source so the deploy files cannot drift from it.
  const searxVar = /process\.env\.([A-Z_]+)/.exec(searxngSrc)?.[1];
  const braveVar = /process\.env\.([A-Z_]+)/.exec(braveSrc)?.[1];
  check('found the SearxNG env var in the source', searxVar === 'OPENSCRAPE_SEARXNG_URL', String(searxVar));
  check('found the Brave env var in the source', braveVar === 'BRAVE_SEARCH_API_KEY', String(braveVar));

  check(
    'compose sets the name the code reads, to the service name',
    new RegExp(`${searxVar}:\\s*http://searxng:8080`).test(compose),
    searxVar,
  );
  check('.env.example documents the Brave name the code reads', envExample.includes(`${braveVar}=`), braveVar);
  // The name that was wrong before.
  check('.env.example no longer names OPENSCRAPE_BRAVE_KEY', !envExample.includes('OPENSCRAPE_BRAVE_KEY'));
  check('.env.example asks for SEARXNG_SECRET', /^SEARXNG_SECRET=/m.test(envExample));
}

console.log('\n4. the private-address guard is not weakened to make search work');
{
  // The SSRF guard sits in fetchPage(), the path caller-supplied URLs take;
  // provider calls go through httpFetch() and are exempt by design. So the
  // sidecar needs no exception — and granting one would open the private
  // network and the cloud metadata endpoint to any token holder.
  check(
    'compose does not set OPENSCRAPE_ALLOW_PRIVATE_TARGETS',
    !/OPENSCRAPE_ALLOW_PRIVATE_TARGETS\s*:/.test(compose),
  );
  check(
    'the bootstrap does not set it either',
    !/^\s*(echo\s+['"]?)?OPENSCRAPE_ALLOW_PRIVATE_TARGETS=1/m.test(bootstrap),
  );
  check('the guard still lives on the caller path', /assertUrlAllowed|checkUrlCached/.test(read('src/core/fetcher/index.ts')));
}

console.log('\n5. the bootstrap sets it up and checks it');
{
  check('it generates a SearxNG secret', /SEARXNG_SECRET=\$\{?SEARX_SECRET/.test(bootstrap) || /openssl rand -hex 32/.test(bootstrap));
  check('it treats the placeholder as unset', /SEARXNG_SECRET=\[0-9a-f\]\{32,\}/.test(bootstrap.replace(/\\/g, '')));
  check('it verifies search rather than assuming', /format=json/.test(bootstrap));
  check('it says search failing is not fatal to the rest', /Everything else on the instance works/.test(bootstrap));
}

console.log('\n6. it is written down where someone deploying will read it');
{
  check('DEPLOY.md has a search section', /## Search needs its own container/.test(deployDoc));
  check('it states the JSON default', /default .*search\.formats.* is\s*\n?`?\[html\]`?|default `\[html\]`/.test(deployDoc) || /`\[html\]`/.test(deployDoc));
  check('it explains why the SSRF guard allows it', /Why the SSRF guard does not block it/.test(deployDoc));
  check('the pre-share checklist mentions search', /SearxNG answers JSON/.test(deployDoc));
  check('the Render path admits the gap', /Search is the gap in this path/.test(deployDoc));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
