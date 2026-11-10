# OpenScrape MCP

A local MCP server that does Firecrawl's job on your own machine: no API key, no
credits, no per-page billing. Everything runs here, and nothing leaves the box
except the request to the site you are scraping.

See [FEATURES.md](FEATURES.md) for the full parity matrix against every
Firecrawl plan, including Enterprise.

## What works today

Verified by calling each tool over a real MCP handshake, not by reading the code.

**Reading pages**
- `scrape` — one URL to markdown, HTML, links, images, structured data, a summary, a screenshot, or just the part that answers a question
- `parse_file` — local PDF, DOCX, CSV, JSON, XML, Markdown, text
- `interact_open` / `_act` / `_read` / `_sessions` / `_stop` — a browser page kept alive across calls, so you can log in, fill a form and read the result
- `profile_list` / `profile_login` — a persistent browser profile, so pages you are signed into stay signed in

**Finding pages**
- `map` — a site's URLs, sitemaps first; `search` ranks them by relevance
- `search` / `search_providers` — web search over SearxNG → Brave → DuckDuckGo
- `search_papers` / `read_paper` — arXiv, PubMed, bioRxiv, Crossref, OpenAlex
- `developer_search` — GitHub repositories, issues and pull requests
- `gov_search` — US Federal Register and govinfo, with the currency caveat stated up front

**Crawling**
- `crawl` / `batch_scrape` — background jobs; `bfs`, `dfs` or `best-first`
- `crawl_status` / `crawl_jobs` / `crawl_control` — progress, and cancel / resume / delete / **recrawl**
- `crawl_export` — the whole crawl as JSONL, CSV or one Markdown file
- `corpus_search` — full-text search over everything crawled, with no new requests

**Reading the past**
- `archive_snapshots` — every capture of a URL, from Wayback and Common Crawl
- `archive_fetch` — read a page as it was on a given date, as clean markdown
- `archive_compare` — diff two dates of the same page, using the monitor's differ
- `archive_discover` — URLs a site used to have, from Common Crawl's index

**SEO audit** — over a stored crawl, with no new requests
- `seo_audit` — titles, meta descriptions, headings, canonicals, indexability, thin and near-duplicate content, image alt, orphans, broken links, redirect chains
- `link_graph` — inlinks per page, anchor text, click depth, orphans, dead ends
- `broken_links` — internal links pointing at error pages, plus redirect chains
- `duplicate_content` — near-identical pages a content hash cannot see

**Brand and media**
- `scrape` with `formats: ["branding"]` — logo, palette and fonts, ranked by how deliberately each was chosen
- `transcribe` / `transcribe_engines` — speech to text through a local whisper CLI or `@huggingface/transformers`

**Operator policy**
- `lockdown_status` — what this server is allowed to do, from a config file no tool can change

**Watching and researching**
- `monitor_create` / `_list` / `_get` / `_update` / `_delete` / `_run` — scheduled checks with real diffs
- `change_tracking` — has this page changed since last time, and how
- `research` — a bounded multi-source investigation that hands back sourced passages

**Also** a Firecrawl-shaped REST API (`npm run serve`), so Firecrawl's own SDKs
and MCP server can be pointed at this machine with a base-URL override.

## Three ideas doing most of the work

**1. The fetch ladder.** One ladder, climbed only as far as the page forces:

```
cache → 304 revalidate → plain HTTP → real browser → your logged-in profile → web archive
```

Each rung is tried only because the one below it came back unusable, and the
result tells you which rungs ran:

```
Fetch ladder: http (403) → browser (bot-wall:datadome) → 403
              → live page unreadable: bot wall (datadome)
              → archive: wayback capture from 15 Oct 2009
```

That is a real run against a page NYT retired and now guards with DataDome.
Firecrawl returns nothing for it; this returns the 2009 page, labelled
`ARCHIVED 15 Oct 2009 (17 years old)` in the header, in the warning, and in
`metadata.archive` — never passed off as live. Set `archiveFallback: false` and
the live failure stands instead, with `success: false` and the reason.

Staying low on the ladder is what makes it fast: a browser page costs roughly a
hundred times the CPU and memory of an HTTP GET. `example.com` takes 120 ms over
HTTP; forcing a browser took 9 seconds.

What the ladder deliberately will **not** do: retry a bot wall through a
different proxy, or reach for a login you did not name. Rotating IPs until a
site stops saying no is working around its refusal, not reading the web. A
public archive is a different source that is allowed to serve us; `profile` is
your own session, used only when you name it.

**2. Making the second read nearly free.** The cache stores raw bytes, so a new
output format needs no request. `ETag` / `If-Modified-Since` turn an unchanged
page into a 304 — GitHub raw went 615 ms → **31 ms**. And because parsing a
large page is the real cost once the download is gone, the *converted* result is
cached too, keyed by the body's hash: a 193 KB Wikipedia article went
1376 ms → **279 ms**. Re-crawling a finished job rewrites only what changed.

**3. Token discipline.** Your real cost is not only credits — it is the model
context a 47,000-character page eats:
- `query` returns only the parts of a page that answer a question (BM25 with
  stemming and a proximity bonus, no model call). Asking *"what does the standard
  plan cost per month"* against Firecrawl's pricing page returns
  `Standard: $83/month` first, from 5 of 20 chunks.
- `maxChars` caps the output and writes the rest to a file, reporting the path.
- `fitMarkdown` prunes navigation residue; `citations` turns inline links into a
  numbered reference list.
- `crawl_export` keeps a thousand-page crawl out of the conversation entirely.

## The SEO audit layer

Firecrawl has nothing like this, and neither does any other scraping API — it is
what you normally pay Ahrefs or Screaming Frog for.

One crawl stores, per page, what the extractor already parsed: canonical, H1s,
robots meta, hreflang, viewport, word count, image alt coverage, schema types, a
near-duplicate fingerprint, the redirect chain that reached it, and **every
outbound link with its anchor text**. That last one is the point — a crawl that
keeps only pages can tell you a page exists, but not that nothing links to it.

Then the audit runs over stored data, so it is free and instant:

```
# SEO audit · 24 pages · job crawl_6b71a454
0 error · 2 warning · 3 notice
Indexable 24 · noindex 0 · error pages 0 · orphans 0 · avg 180 words · with schema 0

## ! Groups of near-identical pages — 1
`near-duplicate` · Text fingerprints within 4 bits of each other.
- 2 pages, distance 0: https://books.toscrape.com/, .../catalogue/category/books_1/index.html
```

That is a real finding from a real run: one page served at two URLs with
identical text and no canonical tag on either. The crawler's own content hash
missed it because the markup differs slightly; the simhash caught it. The audit
took **5 ms**.

**On thresholds.** 60 characters for a title is a convention about where desktop
results truncate, not a published ranking rule. Every threshold here is an
option with a stated default, printed at the bottom of every report, and each
issue says what it found rather than claiming a penalty. A tool that tells you
"this will hurt your rankings" is guessing.

## Operator policy (lockdown)

An MCP server is driven by a model, and a model can be influenced by the pages
it reads. A lockdown file is the answer: limits checked below the tool layer,
which no tool parameter can lift.

Write `~/.openscrape/lockdown.json` (or point `OPENSCRAPE_LOCKDOWN` at one):

```json
{
  "allowedDomains": ["example.com", "docs.example.org"],
  "allowedFormats": ["markdown", "links", "query"],
  "maxChars": 20000,
  "maxCrawlPages": 200,
  "allowExecuteJavascript": false,
  "allowFileParse": false,
  "requireRobots": true,
  "note": "Research workstation. Ask ops to widen."
}
```

No file means nothing is restricted. Absent keys mean "no restriction". Two
behaviours worth knowing:

- **A broken file refuses everything.** If the file exists but is not valid
  JSON, every request is refused and the error says why. A security control
  that silently disables itself on a typo is worse than none, because the
  operator believes they are covered.
- **Private targets flip to deny** the moment any lockdown file exists, unless
  `allowPrivateTargets` is explicitly true.

Verified by `npx tsx scripts/try-lockdown.ts`: 15 checks, including that
`notexample.com` does not satisfy `allowedDomains: ["example.com"]`, that
`maxChars` is a ceiling rather than a default, and both fail-closed paths.

## Adaptive crawling

A page limit is a guess made before you know anything. With a query and
`adaptive: true`, the crawl watches what each page contributes and stops when
more pages stop helping — and tells you which of the two things happened:

```
fixed crawl, no query                     29 pages   5115ms
adaptive: "science fiction books"         10 pages    618ms
  Adaptive: answered after 8 pages: every query term found (science, fiction,
  book), best passage scored 2.19 at .../category/books/science-fiction_16/

adaptive: nonsense the site cannot answer  6 pages    990ms
  Adaptive: stopped after 4 pages: 4 pages in a row added nothing. Never
  found: zqxjkwv, flooberghast, quarter, dividend, yield. The site may not
  answer this.
```

The second case is the one that matters. A stopper that only ever reports
success tells you nothing; what you need is for it to say *I could not answer
this* rather than stopping quietly and letting you assume it did.

## Measured on one laptop

| | |
|---|---|
| example.com | 120 ms (3 ms cached) |
| Wikipedia, 239 KB | 642 ms (130 ms cached) |
| arXiv PDF, 11 pages | 931 ms (219 ms cached) |
| `map` of firecrawl.dev | 1,411 URLs in 333 ms |
| 6-page crawl | 4.2 s, 892 URLs discovered |
| re-crawl of the same 6 | 918 ms, 6/6 unchanged via 304 |
| 20 Wikipedia pages, 18.5 MB | 674 ms at 16 concurrent (~30 pages/s) |
| DataDome-walled page → archive copy | 3.4 s for the whole ladder |
| `seo_audit` over a 24-page crawl | **5 ms**, no network |
| transcribe 11 s of speech (whisper-tiny.en, CPU) | 6.2 s warm, 25.8 s first call |

Firecrawl's own published benchmark is a P95 of 3,387 ms. The crawler applies
per-host politeness and honours `Crawl-delay` on top of these figures, so the
throughput number is a ceiling, not how it treats a site.

## Install

```bash
npm install && npx playwright install chromium && npm run build
```

Transcription is optional and not installed by default, because its runtime is
288 MB and most callers never ask for a transcript:

```bash
npm i @huggingface/transformers
```

**On Windows this also needs the Microsoft Visual C++ Redistributable**, which
onnxruntime links against and Windows does not ship. Without it the package
installs fine and then fails to load, so `transcribe_engines` reports that
state specifically rather than claiming the package is missing:

```bash
winget install --id Microsoft.VCRedist.2015+.x64
```

Or skip all of it and point at a whisper CLI you already have, which needs
neither:

```bash
export OPENSCRAPE_WHISPER_CMD="whisper {input} --model base --output_format txt --output_dir {outdir}"
```

Playwright is optional — without it, JavaScript-heavy pages return only server
HTML and say so in a warning. Everything else works.

## Host it for a team

One instance, one URL, everyone's MCP client points at it — the Firecrawl
replacement your team actually shares. See **[DEPLOY.md](DEPLOY.md)** for
Render, a VPS, the plan arithmetic that decides whether it works, and the
checks to run before sharing the URL.

```bash
npm run mcp:http        # http://127.0.0.1:3100/mcp
```

```bash
claude mcp add --transport http openscrape https://your-host/mcp --header "Authorization: Bearer THEIR_TOKEN"
```

Tokens are per person (`OPENSCRAPE_MCP_TOKENS="alice:...,bob:..."`), so logs
and concurrency limits name a human and revoking one person does not re-key the
team. `OPENSCRAPE_MODE=hosted` switches off local file reads, page scripts and
private-network targets in one go, because getting six environment variables
individually right is not a thing people reliably do.

The server refuses to bind a routable interface with no token at all.

## Connect it to Claude Desktop

[INSTALL-LOCAL-MCP.md](INSTALL-LOCAL-MCP.md) has a one-paste script for Windows
and macOS/Linux that clones, builds and writes the config entry for you. By hand:
add this to `%APPDATA%\Claude\claude_desktop_config.json`, then restart Claude.
Use the absolute path to *your* clone — `node` resolves nothing relative here,
and a wrong path fails silently with the server simply absent from the list.

```json
{
  "mcpServers": {
    "openscrape": {
      "command": "node",
      "args": ["C:\\Users\\YOUR_NAME\\openscrape-mcp\\dist\\index.js"]
    }
  }
}
```

On macOS the config lives at
`~/Library/Application Support/Claude/claude_desktop_config.json`, and the path
looks like `/Users/you/openscrape-mcp/dist/index.js`.

For Claude Code:

```bash
claude mcp add openscrape -- node /absolute/path/to/openscrape-mcp/dist/index.js
```

## Testing

```bash
npm run check
```

```bash
npm test
```

`check` typechecks the project. `test` spawns the server over stdio exactly as a
client does and calls at least one tool from every family, asserting on the real
response — including the honest-failure paths, since a tool that invents an
answer when it has none is the failure mode that matters here. Current state:
**48 checks, 0 failures, 53 tools registered.** It hits live sites, so a site
outage shows up as a failure and a throttled search provider is reported as a
skip rather than a pass.

`npm test` deliberately does **not** transcribe anything: a real transcript
needs a 75 MB model download on first use, which has no business in a default
test run. It asserts only that `transcribe` refuses with an actionable reason
when no engine is usable. The real check is separate, against a file whose
contents are known:

```bash
npx tsx scripts/try-transcribe.ts path/to/speech.wav "the words you expect"
```

It compares on words rather than formatting and reports the match rate, because
a transcript you cannot check is not evidence that transcription works. Verified
here on an 11-second clip of a known speech:

```
engine:   transformers (Xenova/whisper-tiny.en)
audio:    11.0s
elapsed:  25.8s          (6.2s once the model is cached)
transcript:
  And so my fellow Americans ask not what your country can do for you,
  ask what you can do for your country.
expected words matched: 22/22 (100%)
```

The input was a 44.1 kHz **stereo** WAV with a `LIST` chunk before the data, so
that run also exercises the chunk walking, the downmix and the resample.

```bash
npx tsx scripts/try-wav.ts path/to/speech.wav
```

That one checks only the decoding path — chunk walking, stereo downmix,
resampling — which is where most "transcription is broken" reports actually
come from, and it needs no model at all.

## Try it without a client

```bash
npx tsx scripts/try.ts https://example.com
```

```bash
npx tsx scripts/mcp-check.ts
```

The first runs the scraper directly and prints a timing report; the second
spawns the built server over stdio exactly the way a client does, lists its
tools and calls them.

## Useful options

| Option | What it does |
|---|---|
| `formats` | `markdown` (default), `html`, `rawHtml`, `links`, `images`, `summary`, `json`, `screenshot`, `text`, `query` |
| `query` | Return only page sections relevant to this question |
| `maxChars` | Cap the output; overflow goes to a file |
| `maxAge` | Reuse the local cache when the copy is younger than this (ms) |
| `render` | `auto` (default), `http` to never launch a browser, `browser` to always |
| `onlyMainContent` | Strip nav/header/footer/sidebars. Default true |
| `actions` | Click, write, press, scroll, wait, screenshot, run JS, navigate |
| `fitMarkdown` | Prune leftover boilerplate blocks |
| `citations` | Links become numbered references |
| `profile` | Fetch through one of your saved logged-in browser profiles |
| `brandingStylesheets` | For `branding`: read up to N same-origin stylesheets |
| `collectSeo` | Collect per-page SEO signals and outbound links |
| `archiveFallback` | Serve a labelled archive copy when the live page is unreadable. Default true |
| `redactPII` | Mask emails, phones, cards, SSN, IBAN, Aadhaar, PAN |
| `zeroDataRetention` | Write nothing to disk |
| `proxy` | `http://user:pass@host:port` |

## Where data lives

`~/.openscrape/` — `openscrape.db` (SQLite index), `bodies/`
(content-addressed raw fetches), `pages/` (spilled full text). Override with
`OPENSCRAPE_DATA_DIR`. Set `OPENSCRAPE_DEBUG=1` for verbose logs on stderr.

## Security posture

The MCP server speaks stdio only — it opens no port, so there is no network
surface at all. That is the mode you should use.

The optional REST API does open a port, and is hardened accordingly:

- **Loopback by default.** It refuses to bind a routable interface without a
  bearer token (`OPENSCRAPE_API_KEY`).
- **SSRF guard.** Every URL is resolved before it is fetched and refused if it
  lands on a private, loopback or link-local address, so the API cannot be used
  as a proxy into the network it runs in. Verified refusing `127.0.0.1:6379`,
  `169.254.169.254` (cloud metadata), `localhost`, `192.168.0.0/16` and
  `metadata.google.internal`. Opt out per-deployment with
  `OPENSCRAPE_ALLOW_PRIVATE_TARGETS=1` if you really are scraping localhost.
- **No local file reads over HTTP.** `POST /v1/parse` returns 403 unless
  `OPENSCRAPE_ALLOW_FILE_PARSE=1` is set, because it would otherwise read any
  path on the machine. Use the MCP `parse_file` tool instead.
- **TLS certificates are verified**, for both HTTP and browser fetches.
  `skipTlsVerification` is an explicit per-request opt-in.
- **Proxy credentials are redacted** everywhere they could be printed.

Three of those were holes in earlier versions of this code, found and closed
during development: TLS verification was disabled for every request, the REST
API had no SSRF guard, and `/v1/parse` would read any file. If you pulled an
early copy, update it.

What this still is not: SOC 2, an external penetration test, or software with
150,000 users exercising it. It is new code. `executeJavascript` actions run
arbitrary JavaScript in the browser, which is fine locally and must never be
exposed.

## Privacy

Nothing leaves the machine except the request to the site being scraped. No API
key, no account, no vendor logs. Zero-data-retention is the default posture
rather than an enterprise add-on, and PII redaction (`redactPII`) covers email,
phone, card numbers via Luhn, SSN, IBAN, Aadhaar and PAN.

## Honest limits

- **Hard bot walls.** Cloudflare Turnstile, DataDome and PerimeterX are detected
  and reported, not defeated. Firecrawl's real moat is its residential proxy
  pool. What you have instead is the top of the ladder: a logged-in browser
  profile you named (`profile_login`), your own proxies, and the web archives —
  which turn many walled pages into readable content, dated and labelled. For a
  page that is walled *and* never archived, this returns `success: false` and
  says why. That is the honest answer, and it is the one case where a Firecrawl
  subscription still buys something this cannot.
- **Free search providers rate-limit.** DuckDuckGo throttles per IP — it worked
  here (10 results in 802 ms) and then stopped for a while, and Mojeek answers a
  suspected bot with a CAPTCHA. Both are detected and reported rather than
  retried into the ground, but neither is dependable on a hot IP. Brave is no
  longer a free fallback either: as of a check on 2026-11-09 it is metered at
  $5/1000 requests with $5 of credit a month (~1000 requests) and requires a card
  on file. The one option that is genuinely unlimited and needs no card is
  self-hosting SearxNG: `docker run -d -p 8080:8080 searxng/searxng`, then set
  `OPENSCRAPE_SEARXNG_URL=http://localhost:8080`. Two things that are not
  obvious until they cost you an hour:

  - SearxNG ships with its **JSON API disabled**. Add `json` to `search.formats`
    in its `settings.yml` or every query comes back as HTML and the provider
    reports the instance as misconfigured. Turn its `limiter` off too on a
    loopback instance — it is bot protection meant for public instances, and the
    only client it can throttle here is you.
  - **No Docker?** It is a Python app, so it runs from source:
    `git clone --depth 1 https://github.com/searxng/searxng`,
    `pip install -r requirements.txt`, then `python -m searx.webapp` with
    `SEARXNG_SETTINGS_PATH` pointing at your settings file. On Windows two extra
    steps apply: clone with sparse-checkout excluding `utils/templates`, whose
    filenames contain `:` and are rejected by NTFS, and patch the unconditional
    `import pwd` in `searx/valkeydb.py`, which is Unix-only and otherwise stops
    `webapp.py` from loading. Both are small; neither affects searching.

  Note that `OPENSCRAPE_SEARXNG_URL` is read on the operator's side, not from
  tool input, so it is exempt from the SSRF guard by design. A sidecar SearxNG on
  `127.0.0.1` therefore works in hosted mode without relaxing
  `OPENSCRAPE_ALLOW_PRIVATE_TARGETS` for anything else.
- **Keyless index limits.** PubMed allows 3 requests/second, GitHub 10/minute
  (and refuses code search outright); free keys lift both. govinfo and
  CourtListener need a free key to answer at all.
- **Scale.** Bounded by your bandwidth, CPU and RAM — not by a plan, but not
  infinite either.
- **Alexandria.** Firecrawl's licensed data catalogue cannot be reproduced; it is
  a commercial dataset, not a scraping technique.
- **Transcription needs a model.** Everything else here runs with no download
  beyond npm. Speech recognition cannot: it needs either a whisper CLI or a
  288 MB ONNX runtime, and on Windows a system C++ runtime as well. The WAV
  decoding path is dependency-free and handles stereo and arbitrary sample
  rates, so only the model itself is the cost.
