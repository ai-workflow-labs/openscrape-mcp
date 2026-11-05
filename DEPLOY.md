# Hosting OpenScrape for a team

This gives your team one MCP URL they add to their own Claude Code, Claude
Desktop or Codex, in place of Firecrawl.

Read the plan arithmetic first. It is the part that decides whether the deploy
works, and it is cheaper to read now than to debug after an OOM kill.

---

## What this needs from a host

| | Why |
|---|---|
| **Persistent disk** | The SQLite index, the byte cache and the crawl corpus live on disk. Without one, every restart throws away the cache that makes repeat reads nearly free, and in-flight crawls lose their frontier. |
| **2 GB RAM for browser use** | Chromium costs roughly 350–500 MB for one open page, on top of ~120 MB of Node. Plain HTTP scraping — most pages, and the fast path — fits in 512 MB. |
| **Always on** | Crawls and monitors run in the background. A host that sleeps on idle kills them. |
| **Not serverless** | Chromium, a persistent disk and long-running jobs rule out edge and function runtimes. |

---

## Render

Render works. The free tier does not, and it is worth being exact about why:

| Plan | RAM | Disk | Verdict |
|---|---|---|---|
| Free | 512 MB | none | **No.** No disk, sleeps after 15 min idle, and Chromium gets OOM-killed. |
| Starter ($7) | 512 MB | yes | **Testing only**, and only with the browser switched off (below). |
| Standard ($25) | 2 GB | yes | **The first comfortable tier.** Browser works, small team. |

### Deploy

1. Render → **New** → **Blueprint** → pick this repo. It reads
   [`render.yaml`](render.yaml), which already sets the Docker build, the
   `/data` disk, the health check and the hosted-mode defaults.

   The repo is private, so Render will ask to install its GitHub app on the
   `ai-workflow-labs` org the first time.

2. Generate one token per person:

```bash
for name in alice bob carol; do echo "$name:$(openssl rand -hex 24)"; done | paste -sd,
```

3. Paste the result into Render as `OPENSCRAPE_MCP_TOKENS`. The blueprint marks
   it `sync: false`, so Render prompts for it rather than reading a secret out
   of git.

4. After the first deploy, set `OPENSCRAPE_MCP_ALLOWED_HOSTS` to your Render
   hostname (e.g. `openscrape-mcp.onrender.com`). That turns on DNS-rebinding
   protection, which stops a web page in someone's browser driving the server.

### Testing on Starter (512 MB)

Switch the browser off so a JavaScript-heavy page returns server HTML with a
warning instead of being OOM-killed. Set this env var in Render:

```
OPENSCRAPE_LOCKDOWN_JSON={"allowBrowser":false,"maxCrawlPages":100}
```

Everything else keeps working: HTTP scraping, map, crawl, the SEO audit, the
archives, feeds, search. You lose `screenshot`, `interact_*`, and clean
extraction of pages that render client-side.

### Verify it

```bash
curl https://YOUR-APP.onrender.com/health
```

```json
{"ok":true,"server":"openscrape","transport":"streamable-http","sessions":0,"lockdown":true}
```

`lockdown: true` is the one to check. If it says `false`, hosted mode is not
active and the instance will read local files and run page scripts for anyone
holding a token.

---

## Any VPS, with Docker

Cheaper and less constrained than managed hosting. Hetzner CX22 (2 vCPU, 4 GB,
~€4/mo) is comfortable.

```bash
git clone https://github.com/ai-workflow-labs/openscrape-mcp.git
cd openscrape-mcp
cp .env.example .env    # put real tokens in it
docker compose up -d
```

It binds to `127.0.0.1:3100` on purpose. Put Caddy or nginx in front for TLS —
bearer tokens over plain HTTP are readable by anything on the path.

```caddyfile
scrape.yourcompany.com {
    reverse_proxy 127.0.0.1:3100
}
```

---

## Connecting a team member

**Claude Code**

```bash
claude mcp add --transport http openscrape https://YOUR-APP.onrender.com/mcp --header "Authorization: Bearer THEIR_TOKEN"
```

**Claude Desktop** — Settings → Connectors → Add custom connector, with the
same URL and header.

**Codex / Cursor** — any client that supports a remote MCP server over
Streamable HTTP. The URL is the `/mcp` path; auth is `Authorization: Bearer`.

Each person gets their **own** token. That is not bureaucracy: every log line
and every concurrency bucket is keyed by the name in the token, so "who started
forty crawls" has an answer, and removing one person does not re-key everyone.

---

## What the team shares, and what that means

One instance means **one cache and one crawl corpus**. That is mostly the point:
if one person crawls a client site, everyone else's scrape of the same page is a
cache hit instead of a request.

The consequence to know about: `corpus_search` searches everything the instance
has ever crawled, so it shows one person's crawled pages to the rest of the
team. For an agency team working on shared client sites that is usually
desirable. If you need separation, run a second instance with its own disk
rather than trying to partition one.

---

## How much load it takes

Measured on one laptop, which is roughly a 2-vCPU instance:

| | |
|---|---|
| HTTP scrape, cached | 3 ms |
| HTTP scrape, cold | 120–650 ms |
| Unchanged page via 304 | 31 ms |
| 20 pages, 8 concurrent | 459 ms (**43 pages/s**) |
| Browser escalation | 1–9 s, ~400 MB per page |

So the shape of the limit: **HTTP scraping is cheap and scales to tens of
requests per second**; the browser is the expensive path and the reason RAM is
the binding constraint. `OPENSCRAPE_MCP_PER_USER` (default 6) caps in-flight
calls per person so one enthusiastic user cannot starve the rest — excess
requests queue rather than fail, because a queued request is an honest delay
while a 429 usually surfaces in an MCP client as a broken tool.

If the instance is busy, raise RAM before raising concurrency.

---

## Before you share the URL

- `GET /health` reports `lockdown: true`.
- `OPENSCRAPE_MCP_TOKENS` is set, one entry per person.
- TLS is in front of it (Render does this for you).
- `OPENSCRAPE_MCP_ALLOWED_HOSTS` names your hostname.
- `OPENSCRAPE_ALLOW_PRIVATE_TARGETS` is **not** set, unless you genuinely want
  the instance reaching your internal network.

The last one matters more than it looks. Without the guard, any token holder can
have the server fetch `http://169.254.169.254/` and read the host's cloud
credentials. It is on by default; `npm run test:safety` proves it, covering
cloud metadata, every RFC1918 range, loopback, IPv6 loopback, link-local and
`.internal` names.
