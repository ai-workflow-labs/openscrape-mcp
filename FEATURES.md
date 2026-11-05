# Feature parity target

**Current state: 53 MCP tools, 48/48 integration checks passing** (`npm test`),
verified by calling each tool over a real MCP handshake against live sites.

The fetch ladder is unified: cache → 304 → HTTP → browser → a logged-in profile
you named → public web archive, climbed only as far as the page forces, with the
rungs it used reported in `metadata.ladder`. An archived copy is labelled with
its capture date everywhere it surfaces and never presented as live; a page that
is both walled and unarchived returns `success: false` with the reason.


The goal: everything Firecrawl offers on **any** plan — including Scale and
Enterprise — running locally for free. Firecrawl's paid tiers mostly gate
*quantity* (credits, concurrency, rate limits) and *governance* (zero-data
retention, PII redaction, key lockdown). Locally, quantity is bounded only by
your machine and governance is the default, so those tiers collapse into config.

Status legend: **done** = built and tested · **next** = planned, not built ·
**n/a** = cannot be replicated, with the reason.

## 1. Scrape

| Firecrawl | Ours | Status |
|---|---|---|
| `markdown` | Readability + Turndown (GFM tables, fenced code) | done |
| `html` / `rawHtml` | cleaned + original | done |
| `links` / `images` | absolutised, deduped, `srcset` aware | done |
| `summary` | extractive TF summary, no LLM | done |
| `json` (4 extra credits/page) | JSON-LD + microdata + OpenGraph + meta, merged | done |
| `query` (4 extra credits/page) | BM25 + stemming + proximity over page chunks | done |
| `screenshot` | Playwright, viewport or full page | done |
| `onlyMainContent` | Readability, with a density fallback | done |
| `includeTags` / `excludeTags` | CSS selectors | done |
| Smart wait | DOM ready → network idle → hydration grace | done |
| JS rendering | `auto` escalates HTTP → browser only when needed | done |
| `actions` | click, write, press, scroll, wait, screenshot, JS, navigate, scrape | done |
| `mobile`, `headers`, `timeout`, `waitFor` | | done |
| `proxy` | any HTTP/HTTPS proxy, per request | done |
| `maxAge` caching | SQLite + content-addressed bodies | done |
| `redactPII` (Enterprise) | email, phone, card (Luhn), SSN, IBAN, Aadhaar, PAN | done |
| `zeroDataRetention` (Enterprise) | nothing written to disk | done |
| `changeTracking` | content hash + diff against last fetch | done |
| `branding` | logo, colour and font extraction, ranked by how deliberate each signal is | done |
| `audio` format | `transcribe`: local whisper CLI or @huggingface/transformers, no API. Dependency-free WAV decode (stereo, any sample rate); engine is an optional peer, and on Windows needs the MSVC redistributable | done, engine opt-in |
| `lockdown` (Enterprise) | `lockdown.json` pinning domains, formats, caps and capabilities; fails closed | done |
| Enhanced / stealth proxy pool | partly: stealth flags + your own proxies | n/a (their residential pool) |

**Beyond Firecrawl:** `maxChars` with disk spill (big pages don't flood model
context), `fitMarkdown` pruning, and `citations` (links become a numbered
reference list instead of repeating URLs inline).

## 2. Crawl, map, batch

| Firecrawl | Ours | Status |
|---|---|---|
| `map` (1 credit/call) | robots.txt + sitemap index + BFS link discovery | done |
| `map` with `search` | relevance-ranked URLs | done |
| `crawl` (1 credit/page) | async jobs, BFS / DFS / best-first | done |
| `includePaths` / `excludePaths` / `maxDepth` / `limit` | regex path scoping | done |
| Subdomain / external-link scoping | `allowSubdomains`, `allowExternal`, `allowBackwardLinks` | done |
| Crash recovery (`resume_state`) | frontier lives in SQLite; `crawl_control` resumes | done |
| Batch scrape | `batch_scrape`, one job for many URLs | done |
| Webhooks | HMAC-SHA256 signed, per event | done |
| Concurrency 2 → 100 by plan | memory-adaptive dispatcher, no plan cap | done |
| Queue 50k → 200k jobs | SQLite frontier, bounded only by disk | done |
| Content de-duplication | identical pages skipped by content hash | done |
| Rate limits 10/min → 10,000/min | none — your own machine | n/a, nothing to build |
| URL seeding from Common Crawl | `archive_discover`, over the CC index | done |
| Adaptive crawling (stop when answered) | `adaptive: true` with a query; reports why it stopped | done |

Measured on this machine: `map` of firecrawl.dev returned 1,411 URLs in 333 ms
from two sitemap files; a 6-page crawl finished in 4.2 s having discovered 892
URLs. Three crawls run concurrently in separate processes completed with no
lock contention.

**Beyond Firecrawl:** `corpus_search` does SQLite FTS5 full-text search over
every page crawled so far — phrases, `OR`, `NEAR` and prefix matching, with
highlighted snippets. Once a site is crawled, asking it a question costs one
local query and no requests at all.

**Politeness is real here.** We identify as `OpenScrape`, obey the `*` group in
robots.txt rather than impersonating Googlebot, and honour `Crawl-delay`. Hacker
News declares `Crawl-delay: 30`, so a 2-page crawl there genuinely takes 31 s —
the crawler says so up front instead of looking stuck.

## 2b. Performance: things Firecrawl bills you for

Firecrawl charges a credit per page every time, so re-reading a site costs the
same as reading it the first time. Locally, the interesting work is making the
*second* read nearly free.

| Technique | What it does | Measured here |
|---|---|---|
| Raw-fetch cache | caches bytes, not results, so a new format needs no request | Wikipedia 642 ms → 130 ms |
| Conditional requests | `ETag` / `If-Modified-Since`; an unchanged page answers 304 | GitHub raw 615 ms → **31 ms** |
| Extraction cache | caches the *converted* result, content-addressed by body hash | Wikipedia (193 KB) 1376 ms → **279 ms** |
| Incremental re-crawl | re-runs a job's URLs, rewrites only what changed | 6-page crawl 2268 ms → **918 ms**, 6/6 unchanged |

The extraction cache matters more than it sounds. Once a 304 removes the
download, parsing a large page *is* the cost — so the key is the body's hash
plus the options that affect conversion, which means a changed page can never
hit a stale entry.

`crawl_control` with `action: "recrawl"` refreshes a finished crawl; pages that
answer 304 are left untouched and reported as `unchanged`.

**Connection reuse.** Dispatchers are pooled per (proxy, TLS, timeout) shape
with HTTP/2 enabled, instead of being rebuilt per request — a fresh agent each
time throws away keep-alive, so every page pays a new TCP and TLS handshake.
Fetching 20 Wikipedia pages (18.5 MB) on one host: 7,851 ms sequential,
2,245 ms at 8 concurrent, **674 ms at 16 concurrent (~30 pages/s)**. The
crawler still applies per-host politeness and `Crawl-delay` on top of this;
the raw figure is the ceiling, not how it treats a site.

## 3. Search and indexes

| Firecrawl | Ours | Status |
|---|---|---|
| `search` (2 credits/10 results) | SearxNG → Brave API → DuckDuckGo fallback chain | done |
| `sources: news / images` | same chain | done |
| Developer Index | GitHub API | done |
| Research Index | arXiv, PubMed, bioRxiv, Crossref, OpenAlex (all free APIs) | done |
| Government & Legal Index | govinfo + Federal Register APIs | done |
| Alexandria catalogue | — | n/a (licensed proprietary dataset) |
| Their pre-built web index | our SQLite FTS5 index over what we crawl | partial |

## 4. Other endpoints

| Firecrawl | Ours | Status |
|---|---|---|
| `parse` (PDF, DOCX…) | PDF, DOCX, CSV, TSV, JSON, XML, MD, TXT | done |
| OCR for scanned PDFs | tesseract.js | done |
| `interact` (2 credits/browser minute) | persistent Playwright sessions | done |
| `monitor` (1–7 credits/page/check) | scheduled re-fetch + diff + notify | done |
| `agent` (5 free runs/day) | `research`: map + search + scrape orchestration, synthesis by the calling model | done |
| llms.txt generator | `generate_llmstxt`, from map + per-page titles | done |
| RSS / Atom / JSON Feed | `feed_discover`, `feed_read`, `feed_timeline` | done, Firecrawl has no equivalent |
| Historical copies of a page | `archive_fetch`, `archive_snapshots`, `archive_compare` over Wayback + Common Crawl | done, **Firecrawl cannot do this at all** |
| On-page SEO audit | `seo_audit` over a stored crawl | done, **Firecrawl cannot do this at all** |
| Internal link graph | `link_graph` — inlinks, anchor text, orphans, dead ends | done, **Firecrawl cannot do this at all** |
| Broken links + redirect chains | `broken_links` | done, **Firecrawl cannot do this at all** |
| Near-duplicate detection | `duplicate_content`, simhash over extracted text | done, **Firecrawl cannot do this at all** |

## 5. Governance and ops

| Firecrawl tier feature | Ours |
|---|---|
| Zero-data retention (Enterprise only) | default posture; nothing leaves the machine |
| PII redaction (all tiers) | `redactPII` flag — done |
| Signed webhooks (all tiers) | HMAC-SHA256 — done |
| Key scoping / lockdown (Enterprise) | local `lockdown.json`, enforced below the tool layer — done |
| IP allowlist / dedicated IPs (Enterprise) | your own machine and proxies — n/a by construction |
| SSO, SAML, SCIM (Enterprise) | n/a — single-user local tool |
| SOC 2, pen testing (all tiers) | n/a — no vendor in the path |
| Credits, rollover, pay-as-you-go | n/a — no credits exist |

## 6. Ideas taken from crawl4ai

Read and evaluated at <https://github.com/unclecode/crawl4ai>. Adopted:

- **Fit markdown** — prune boilerplate blocks after conversion. *done*
- **BM25 content filter** — keep only query-relevant chunks. *done, with
  stemming and a proximity bonus added*
- **Citations** — links as a numbered reference list. *done*
- **Best-first deep crawl** — score URLs so a 50-page limit spends itself on the
  50 pages that matter. *done*
- **Adaptive crawling** — stop once the query is answerable. *done, with a
  plateau detector so it also stops when the site will never answer*
- **URL seeding from sitemaps and Common Crawl.** *done*
- **`scan_full_page`** — scroll to trigger infinite feeds and lazy images. *done*
- **Memory-adaptive dispatcher** — back off concurrency under RAM pressure. *done*
- **Persistent browser profiles** — scrape pages you are logged into. *done, and
  wired into the fetch ladder as a rung*
- **CSS / XPath / regex extraction schemas** plus a schema generator. *done*
- **Cache modes** as an explicit enum rather than only `maxAge`. *skipped:
  `maxAge`, `revalidate` and `storeInCache` already cover every mode the enum
  names, and a second way to say the same thing is a way to say it wrongly.*

Deliberately skipped: their LLM extraction strategies (the calling model does
this better and for free), cosine-similarity chunking (BM25 is enough and needs
no embedding model), and C4A-script (the `actions` array already covers it).
