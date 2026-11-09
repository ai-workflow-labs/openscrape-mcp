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
| **A second small container, for search** | `search` needs a provider, and on a server there is no free one. See below. |

---

## Search needs its own container

This is the one part of a hosted deploy that fails quietly, so it is worth
understanding before the deploy rather than after.

`search` tries providers in order. On a datacentre IP, two of the three are
dead ends:

| | On a server |
|---|---|
| **DuckDuckGo** | Bot-checks a datacentre IP within a few queries. It is the no-config fallback and it is not dependable. |
| **Brave** | No free tier as of 9 Nov 2026 — $5 per 1000 requests, $5 monthly credit, card required. |
| **SearxNG** | Self-hosted. No key, no quota. Forwards each query to Google, Bing, Brave, DDG, Qwant and others, then merges and re-ranks. |

So `docker-compose.yml` runs SearxNG as a sidecar, and sets
`OPENSCRAPE_SEARXNG_URL=http://searxng:8080` in the compose file itself rather
than in `.env` — a deploy should not be able to end up with a running SearxNG
that nothing points at.

Three things about it that are easy to get wrong:

**SearxNG ships with its JSON API off.** Its default `search.formats` is
`[html]`, and there is no environment variable for it — only a settings file.
Without that file, every query comes back 403 or as an HTML page.
[`deploy/searxng/settings.yml`](deploy/searxng/settings.yml) is mounted at
`/etc/searxng/settings.yml` to turn JSON on. **This is the whole reason the
sidecar needs a config file** rather than a one-line `image:` entry.

**It is not published to a host port.** Only the openscrape container reaches
it, over the compose network. That is also why its bot limiter is switched off,
and why there is no Valkey container — Valkey exists to back that limiter.

**It needs a secret, and there is no safe default.**

```bash
echo "SEARXNG_SECRET=$(openssl rand -hex 32)" >> .env
```

Compose uses `${SEARXNG_SECRET:?...}`, so it refuses to start with a clear
message instead of bringing the stack up half-working.
`scripts/oracle-bootstrap.sh` generates this for you, on the instance.

Cost: roughly 150–250 MB of RAM. It does no rendering; the work is fanning
queries out to the upstream engines.

### Checking it, rather than assuming

`/health` does not cover search, because the MCP server does not talk to
SearxNG until someone calls `search`. Ask SearxNG directly, for JSON, which is
the exact thing openscrape asks for:

```bash
docker compose exec searxng wget -qO- 'http://127.0.0.1:8080/search?q=ping&format=json' | head -c 200
```

A JSON body with a `"results"` key means `search` works. HTML, or a 403, means
the settings file is not mounted. The container's own healthcheck runs this
same query, and so does the bootstrap script.

### Why the SSRF guard does not block it

`http://searxng:8080` is a private address, and this server deliberately
refuses private targets. It still works, and the reason is structural rather
than a special case: the guard lives in `fetchPage()`
([`src/core/fetcher/index.ts`](src/core/fetcher/index.ts)), the path every
*caller-supplied* URL takes — scrape, crawl, map, monitor. Search providers
call `httpFetch()` directly, so operator configuration is not subject to a
guard that exists to constrain callers.

The practical consequence: **do not set
`OPENSCRAPE_ALLOW_PRIVATE_TARGETS` to make search work.** It is not needed, and
it would let any token holder reach your private network and the cloud
metadata endpoint.

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

**Search is the gap in this path.** The blueprint deploys one service, so there
is no SearxNG sidecar, and `search` will report "no provider answered" while
every other tool works. Either point `OPENSCRAPE_SEARXNG_URL` at a SearxNG you
run elsewhere, or add a second Render service — which Render bills separately
and which needs an image of your own, because the JSON-API settings file cannot
be mounted into a plain `image:` deploy. [`render.yaml`](render.yaml) has the
sketch and the catch written out. Compose is the better-trodden path here.

### Running on 512 MB (free or Starter)

Use [`Dockerfile.slim`](Dockerfile.slim), which leaves Chromium out. Set
`dockerfilePath: ./Dockerfile.slim` in `render.yaml` and drop the `disk:` block
(free has no disks).

**It fits, measured rather than estimated.** Running the slim configuration and
then scraping a 239 KB Wikipedia article, mapping a 582-URL site and reading an
archived page:

```
rss at start: 109 MB
rss at end:   205 MB      (512 MB instance, Node capped at 384 MB)
```

For contrast, the full image with one Chromium page open is 450-600 MB, which is
why the free tier OOM-kills it on the first JavaScript-heavy page.

What the slim image gives up — and each one says so rather than returning
something empty:

| | |
|---|---|
| `screenshot` | refused: *"launching a browser is disabled, so a screenshot cannot be taken"* |
| `interact_*`, `profile_*` | unavailable |
| JS-rendered pages | server HTML plus *"browser rendering is disabled; only server HTML was fetched"* |

What still works, verified by `npx tsx scripts/try-slim.ts`:

```
PASS  example.com                  156 chars, 566ms
PASS  a 239 KB article             412ms, rss 113 MB
PASS  says the browser was unavailable
PASS  screenshot refused with a reason
PASS  map                          10 of 582 urls
PASS  seo signals                  73 links, 211 words
PASS  archive read                 captured 5 Nov 2026
7 passed, 0 failed
```

So: HTTP scraping, `map`, `crawl`, `batch_scrape`, the whole SEO audit layer,
the archives, feeds, search, the research and paper indexes, and extraction
schemas. That is most of the tool surface.

### The free tier's two real costs

RAM is solvable, as above. These two are not:

**No persistent disk.** The SQLite index, the byte cache and the crawl corpus
live on disk, and on free there is none — so `/data` is container-local and
wiped on every restart and deploy. Consequences: the cache that makes a repeat
read 3 ms instead of 600 ms starts empty each time; `corpus_search`,
`seo_audit` and `link_graph` only see crawls from the current uptime; and a
crawl interrupted by a restart loses its frontier.

**It sleeps after 15 minutes idle.** Background crawls and monitors are killed
mid-run. Open MCP sessions die, so the next call returns *"Unknown or expired
session. Re-initialize."* — a well-behaved client reconnects, but some surface
it as a tool error. And the first request after a sleep waits for a cold start.

**Verdict.** Free is genuinely fine for *testing* — one or two people trying the
tools, confirming the URL works, checking the output shape. It is not fine as
the thing a team relies on daily, because the cache being wiped removes the main
speed advantage over Firecrawl, and the sleeping breaks exactly the long crawls
you would want a shared instance for. Starter ($7) fixes the disk; Standard
($25) fixes the RAM and lets the browser back in.

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

## Free options that actually meet the requirements

Render's free tier fails on two things that matter here: no persistent disk and
it sleeps. These do better.

| | Always on | Disk | RAM | Browser | Cost |
|---|---|---|---|---|---|
| **Oracle Cloud Always Free** (ARM) | yes | 200 GB | 12 GB* | yes | free, no time limit |
| **Your own machine + a tunnel** | while it is on | yours | yours | yes | free |
| **Google Cloud e2-micro** | yes | 30 GB HDD | 1 GB | slim only | free, no time limit |
| Render free | **no, sleeps** | **none** | 512 MB | slim only | free |
| Fly.io / Railway / Koyeb | — | — | — | — | no longer meaningfully free |

\* **Verify this number before planning around it.** Oracle's Always Free Arm
allowance was widely reported in mid-2026 to have been halved from 4 OCPU /
24 GB to 2 OCPU / 12 GB, and sources still disagree — some accounts apparently
kept the old allowance. Check Oracle's own Always Free page for your tenancy
rather than trusting a blog post, including this one. Even at the lower figure
it is far more machine than Render's $25 Standard plan.

### Oracle Cloud Always Free — the best free fit

A real VPS with root, a persistent 200 GB volume and enough RAM to run the
browser. Use the full [`Dockerfile`](Dockerfile), not the slim one.

Two things to know before you start:

- **It is ARM (Ampere A1).** `node:24-slim` is multi-arch and Playwright ships
  arm64 Chromium, so the image is expected to build — but it has not been built
  on arm64 here, so treat the first build as the test. Build on the instance
  itself rather than pushing an amd64 image to it.
- **"Out of Host Capacity" is common** in popular regions. If provisioning
  fails, try a different availability domain or a quieter region. This is the
  single most reported frustration with the free Arm tier.

#### Step 1 — provision the instance (console, you)

Oracle account signup and provisioning cannot be scripted from here; they need
your identity and a card for verification. In the console:

| Setting | Value | Why |
|---|---|---|
| Shape | **VM.Standard.A1.Flex** | The Arm shape with the free allowance. The AMD `E2.1.Micro` is also free but has 1 GB RAM, which rules out the browser. |
| OCPUs / memory | Up to your Always Free allowance | Reported as 2 OCPU / 12 GB since mid-2026; check your tenancy's own page. |
| Image | **Ubuntu 22.04 or 24.04 (aarch64)** | The script assumes `apt`. |
| Boot volume | 50–100 GB | Minimum is ~47 GB. The cache and crawl corpus live here. |
| SSH key | Paste your public key | Oracle does not offer password login. |

If provisioning fails with **"Out of Host Capacity"**, that is the free Arm
tier's well-known constraint, not a mistake on your part. Try another
availability domain, then another region.

#### Step 2 — open the VCN (console, you)

**Networking → Virtual Cloud Networks → your VCN → Security Lists → Default**

Add an ingress rule: source `0.0.0.0/0`, protocol TCP, destination ports
`80,443`.

This is separate from the instance's own firewall, and both must be open. The
script handles the instance side; only you can do this side. Opening one and
not the other is the most common way an Oracle deployment ends up unreachable
while looking perfectly healthy from inside the box.

#### Step 3 — point a DNS record at it

An `A` record for e.g. `scrape.yourdomain.com` → the instance's public IP. This
has to resolve *before* step 4, because Caddy proves domain control to get a
certificate and cannot do that for a name that does not point at it yet.

#### Step 4 — run the bootstrap (one command, on the instance)

The repository is private, so there is no `curl | bash` one-liner: an
unauthenticated fetch of a private repo returns 404, and a 404 piped into bash
does nothing visible, which is a miserable way to start. Copy the script over
instead.

```bash
scp scripts/oracle-bootstrap.sh ubuntu@YOUR_INSTANCE_IP:~
```

```bash
ssh ubuntu@YOUR_INSTANCE_IP
```

```bash
sudo bash oracle-bootstrap.sh --domain scrape.yourdomain.com
```

The clone needs access too. The script generates a deploy key **on the
instance** and stops the first time, printing the key and the link to add it.
Add it, run the same command again, and it carries on from where it stopped.
That key only needs to read, so leave "Allow write access" unchecked — the
server never pushes.

Read the script before running it as root.

[`scripts/oracle-bootstrap.sh`](scripts/oracle-bootstrap.sh) does: the instance
firewall, Docker, a 4 GB swap cushion, clone, per-person token generation
(printed once, on the box, never through a chat window), the hostname allowlist,
an ARM-native image build, Caddy with automatic TLS, and a health check that
confirms `lockdown: true` before telling you it worked.

It is idempotent — re-running it adds people or picks up changes without
rebuilding what is already there.

**Not tested on an Oracle instance from here.** The logic is checked (syntax,
argument handling, the root guard firing before any mutation) but it has never
run on Ampere hardware, so read it and expect to fix something.

### Your own machine plus a tunnel — fastest to a working URL

If the desktop is on most of the day, this is free, needs no cloud signup, and
has more RAM and disk than any free tier. A Cloudflare named tunnel gives a
stable HTTPS URL on a domain you control:

```bash
npm run mcp:http
```

```bash
cloudflared tunnel --url http://127.0.0.1:3100
```

The honest limitation: when the machine sleeps or reboots, the team's MCP URL
stops answering and any running crawl dies. Fine for a few people who know
that; not something to hand to a team as infrastructure.

### Google Cloud e2-micro — works, but slim only

Verified against Google's own free-tier pages on 9 Nov 2026: one e2-micro per
month, **1 GB RAM**, 30 GB standard persistent disk, 1 GB/month egress, and only
in `us-west1`, `us-central1` or `us-east1`. No end date, but Google reserves the
right to change the limits on 30 days' notice.

1 GB RAM rules out the browser, so use [`Dockerfile.slim`](Dockerfile.slim) —
which peaks at 205 MB. The SearxNG sidecar wants another 150–250 MB, so the
pair lands near 450 MB and still fits, though not with much spare once a large
crawl is running. If it gets tight, drop the sidecar and point
`OPENSCRAPE_SEARXNG_URL` at a SearxNG somewhere else.

Two more constraints: the free persistent disk is standard HDD (slow for SQLite
under load), and egress is about 1 GB/month. Scraped pages are *inbound* so they
do not count, and MCP responses are markdown, so 1 GB goes further than it
sounds — but `crawl_export` of a large crawl would eat into it, and so would
SearxNG's own outbound queries, which are small but constant.

Wanting the browser on Google Cloud means a paid machine — e2-small is the first
with 2 GB. At that point Oracle's Always Free tier gives more machine for
nothing, which is why it is the recommendation above.

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
- `SEARXNG_SECRET` is a real random value, not the placeholder from
  `.env.example`.
- SearxNG answers JSON (the one-line check above). `/health` does **not** tell
  you this, and search is the one tool that fails without saying much.
- TLS is in front of it (Render does this for you).
- `OPENSCRAPE_MCP_ALLOWED_HOSTS` names your hostname.
- `OPENSCRAPE_ALLOW_PRIVATE_TARGETS` is **not** set, unless you genuinely want
  the instance reaching your internal network. It is **not** needed for the
  SearxNG sidecar — see above for why.

The last one matters more than it looks. Without the guard, any token holder can
have the server fetch `http://169.254.169.254/` and read the host's cloud
credentials. It is on by default; `npm run test:safety` proves it, covering
cloud metadata, every RFC1918 range, loopback, IPv6 loopback, link-local and
`.internal` names.
