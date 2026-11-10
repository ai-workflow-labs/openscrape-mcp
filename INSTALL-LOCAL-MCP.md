# Install OpenScrape as a local MCP connector

This guide installs OpenScrape on your own computer and registers it as a
**local MCP server**, so Claude Desktop and Claude Code can use its tools
(`scrape`, `crawl`, `map`, `search`, `seo_audit`, ...) in local development.
No API key and no per-page cost.

> A local MCP server is **not** a cloud connector. It will not appear in
> Claude's *Connectors* list. In Claude Desktop it shows up under
> **Settings -> Developer -> Local MCP servers**. In Claude Code it shows up in
> `claude mcp list`.

If you only want to call a shared, hosted copy instead, see [DEPLOY.md](DEPLOY.md).

---

## 1. Prerequisites

| Need | Version | Check | Install |
|---|---|---|---|
| Git | any recent | `git --version` | https://git-scm.com/downloads |
| Node.js | **22 or newer** | `node --version` | https://nodejs.org (LTS) |
| Python (only for local web search) | 3.11 or newer | `python --version` | https://www.python.org/downloads |

Python is only needed for step 5 (self-hosted search). Everything else works
without it.

---

## 2. Automatic install

Pick your OS, paste the whole block into a terminal, and run it. It will:

1. clone this repo into `~/openscrape-mcp` (skipped if it is already there),
2. install the npm dependencies and the Chromium browser used for JavaScript pages,
3. build the server,
4. add `openscrape` to Claude Desktop's `claude_desktop_config.json`
   (a `.bak` backup is written first, and your other MCP servers are kept),
5. register it with Claude Code too, if the `claude` CLI is installed.

Running it again is safe: it updates the entry instead of duplicating it.

### Windows (PowerShell)

```powershell
$ErrorActionPreference = "Stop"
$repo = Join-Path $HOME "openscrape-mcp"
$searx = "http://127.0.0.1:8080"

# 1-3. clone, install, build
if (-not (Test-Path $repo)) {
  git clone https://github.com/ai-workflow-labs/openscrape-mcp.git $repo
}
Set-Location $repo
npm install
npx playwright install chromium
npm run build

# 4. add to Claude Desktop (merges into the existing config, keeps a .bak)
$dist = (Join-Path $repo "dist\index.js") -replace '\\','/'
$cfg  = Join-Path $env:APPDATA "Claude\claude_desktop_config.json"
$tmp  = Join-Path $env:TEMP "add-openscrape.mjs"
@'
import fs from 'node:fs';
import path from 'node:path';
const [, , cfgPath, dist, searx] = process.argv;
let cfg = {};
if (fs.existsSync(cfgPath)) {
  fs.copyFileSync(cfgPath, cfgPath + '.bak');
  cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''));
}
cfg.mcpServers ??= {};
cfg.mcpServers.openscrape = { command: 'node', args: [dist], env: { OPENSCRAPE_SEARXNG_URL: searx } };
fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
console.log('openscrape added to ' + cfgPath);
'@ | Set-Content $tmp -Encoding utf8
node $tmp $cfg $dist $searx

# 5. add to Claude Code (optional, only if the CLI exists)
if (Get-Command claude -ErrorAction SilentlyContinue) {
  claude mcp remove openscrape --scope user 2>$null
  claude mcp add openscrape --scope user -e "OPENSCRAPE_SEARXNG_URL=$searx" -- node $dist
}

Write-Host "Done. Fully quit and reopen Claude Desktop."
```

### macOS / Linux (bash)

```bash
set -e
REPO="$HOME/openscrape-mcp"
SEARX="http://127.0.0.1:8080"

# 1-3. clone, install, build
[ -d "$REPO" ] || git clone https://github.com/ai-workflow-labs/openscrape-mcp.git "$REPO"
cd "$REPO"
npm install
npx playwright install chromium
npm run build

# 4. add to Claude Desktop (merges into the existing config, keeps a .bak)
DIST="$REPO/dist/index.js"
case "$(uname)" in
  Darwin) CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json" ;;
  *)      CFG="$HOME/.config/Claude/claude_desktop_config.json" ;;
esac
TMP="$(mktemp -t add-openscrape.XXXXXX.mjs)"
cat > "$TMP" <<'EOF'
import fs from 'node:fs';
import path from 'node:path';
const [, , cfgPath, dist, searx] = process.argv;
let cfg = {};
if (fs.existsSync(cfgPath)) {
  fs.copyFileSync(cfgPath, cfgPath + '.bak');
  cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''));
}
cfg.mcpServers ??= {};
cfg.mcpServers.openscrape = { command: 'node', args: [dist], env: { OPENSCRAPE_SEARXNG_URL: searx } };
fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
console.log('openscrape added to ' + cfgPath);
EOF
node "$TMP" "$CFG" "$DIST" "$SEARX"

# 5. add to Claude Code (optional, only if the CLI exists)
if command -v claude >/dev/null 2>&1; then
  claude mcp remove openscrape --scope user 2>/dev/null || true
  claude mcp add openscrape --scope user -e "OPENSCRAPE_SEARXNG_URL=$SEARX" -- node "$DIST"
fi

echo "Done. Fully quit and reopen Claude Desktop."
```

After it finishes, **fully quit Claude Desktop** (right-click the tray or menu-bar
icon and choose Quit, not just close the window) and open it again.

---

## 3. Or do it by hand

If you prefer to add the entry yourself, build the project (steps 1-3 of the
script above), then add this to `claude_desktop_config.json` inside the top-level
`mcpServers` object. Use forward slashes in the path, even on Windows, and the
**absolute** path to your own clone.

```json
"openscrape": {
  "command": "node",
  "args": ["C:/Users/YOUR_NAME/openscrape-mcp/dist/index.js"],
  "env": { "OPENSCRAPE_SEARXNG_URL": "http://127.0.0.1:8080" }
}
```

Config file location:

| OS | Path |
|---|---|
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

Claude Code, one command:

```bash
claude mcp add openscrape --scope user -e OPENSCRAPE_SEARXNG_URL=http://127.0.0.1:8080 -- node /absolute/path/to/openscrape-mcp/dist/index.js
```

(`--scope user` makes it available in every project. Use `--scope project` to
write a `.mcp.json` that is shared through git instead.)

---

## 4. Verify

1. In Claude Desktop, open **Settings -> Developer -> Local MCP servers**.
   `openscrape` should be listed as **running**.
2. In Claude Code, run `claude mcp list`. `openscrape` should be connected.
3. Ask Claude: *"Use OpenScrape to scrape https://example.com"*. You should get
   the page back as markdown.

---

## 5. Optional: local web search (SearxNG)

`scrape`, `crawl`, `map`, `seo_audit` and the rest need nothing extra. The
`search` tool uses SearxNG when it is running. Without it, search falls back to
DuckDuckGo, which rate-limits quickly. Running your own SearxNG removes that
limit.

The entry above already points at `http://127.0.0.1:8080`, so once SearxNG is
running there, search works with no further change.

### Option A: Docker (works on every OS)

```bash
mkdir -p ~/searxng && cd ~/searxng
cat > settings.yml <<EOF
use_default_settings: true
server:
  secret_key: "$(openssl rand -hex 16)"
  limiter: false
  image_proxy: false
search:
  formats:
    - html
    - json
EOF
docker run -d --name searxng --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -v "$PWD/settings.yml:/etc/searxng/settings.yml" \
  searxng/searxng
```

`json` must be in `search.formats`, otherwise OpenScrape cannot read the results.

### Option B: Windows without Docker (PowerShell)

Needs Python 3.11 or newer. Two Windows problems are handled in the steps below:

- SearxNG's repo has four files with a `:` in their name (unused web-server
  templates). Windows cannot create them, so `git clone` of SearxNG fails with
  `invalid path ... :socket`. Do **not** turn off Git's NTFS safety checks to get
  around it. Download the source as a zip instead: Python's extractor renames
  those four files and carries on.
- SearxNG imports `pwd`, a Unix-only module. A small stand-in file inside the
  virtual environment fixes that without editing any SearxNG code.

```powershell
$dir  = Join-Path $HOME "searxng"
$zip  = Join-Path $env:TEMP "searxng.zip"
$tmpx = Join-Path $env:TEMP "searxng-extract"
if (Test-Path $dir) { throw "$dir already exists - delete it or pick another folder" }

# download the source and extract it with Python (renames the ':' files)
Invoke-WebRequest -UseBasicParsing "https://github.com/searxng/searxng/archive/refs/heads/master.zip" -OutFile $zip
if (Test-Path $tmpx) { Remove-Item -Recurse -Force $tmpx }
python -m zipfile -e $zip $tmpx
Move-Item (Join-Path $tmpx "searxng-master") $dir
Set-Location $dir

# virtual environment and dependencies
python -m venv venv
.\venv\Scripts\python.exe -m pip install -U pip setuptools wheel
.\venv\Scripts\python.exe -m pip install -r requirements.txt

# Windows stand-in for the Unix-only 'pwd' module
@'
from collections import namedtuple
struct_passwd = namedtuple('struct_passwd', 'pw_name pw_passwd pw_uid pw_gid pw_gecos pw_dir pw_shell')
def getpwuid(uid):
    return struct_passwd('user', '*', 0, 0, '', '', '')
def getpwnam(name):
    return struct_passwd(name, '*', 0, 0, '', '', '')
'@ | Set-Content (Join-Path $dir "venv\Lib\site-packages\pwd.py") -Encoding ascii

# settings: JSON output on, bound to localhost only
$secret = [guid]::NewGuid().ToString('N')
@"
use_default_settings: true
general:
  instance_name: "local-searxng"
search:
  formats:
    - html
    - json
server:
  bind_address: "127.0.0.1"
  port: 8080
  secret_key: "$secret"
  limiter: false
  image_proxy: false
"@ | Set-Content (Join-Path $dir "settings.yml") -Encoding utf8

# start script
@"
@echo off
cd /d "%USERPROFILE%\searxng"
set SEARXNG_SETTINGS_PATH=%USERPROFILE%\searxng\settings.yml
set PYTHONUTF8=1
venv\Scripts\python.exe -m searx.webapp
"@ | Set-Content (Join-Path $dir "start-searxng.cmd") -Encoding ascii
```

Start it with `%USERPROFILE%\searxng\start-searxng.cmd` and leave that window
open while you work. Check it with:

```powershell
Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:8080/search?q=test&format=json" | Select-Object StatusCode
```

A `200` means search is ready.

### Option C: skip SearxNG

Delete the `OPENSCRAPE_SEARXNG_URL` line from the config. Search then falls
back to DuckDuckGo, which throttles per IP, so heavy search use will get
rate-limited.

---

## 6. Update later

```bash
cd ~/openscrape-mcp
git pull
npm install
npm run build
```

Then fully restart Claude Desktop. The config entry does not need to change.

---

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| `openscrape` is not in the Local MCP servers list | You edited the wrong file, or did not fully quit Claude Desktop. Check the config path in section 3, confirm the JSON is valid, and quit from the tray icon. |
| Server shows as failed | Run `node dist/index.js` in the repo folder. If it errors, run `npm install && npm run build` and check `node --version` is 22 or newer. |
| `Cannot find module .../dist/index.js` | The path in the config is wrong, or the build did not run. Run `npm run build` and use the absolute path with forward slashes. |
| `git clone` of SearxNG fails with `invalid path ... :socket` (Windows) | Windows cannot create those four files. Use the zip method in section 5, Option B. Do not disable Git's NTFS protection. |
| SearxNG fails with `No module named 'pwd'` (Windows) | The stand-in `pwd.py` is missing. Create it in `venv\Lib\site-packages` as shown in section 5, Option B. |
| JavaScript-heavy pages come back nearly empty | Chromium is missing. Run `npx playwright install chromium`. |
| `search` returns "no provider answered" | SearxNG is not running, or DuckDuckGo is rate-limiting you. Start SearxNG (section 5), or wait a few minutes and retry. |
| `git clone` fails or asks for a password | The repo is public, so no login should be needed. Check the URL and your network or proxy. If the repo has been made private since, run `gh auth login` and ask the repo owner for access. |
| Edited the config by hand and Claude ignores it | A stray comma or a BOM broke the JSON. Paste the file into a JSON validator, or restore the `.bak` copy and use the automatic script. |

Set `OPENSCRAPE_DEBUG=1` in the `env` block for verbose logs.

---

## Security notes

- Never put real tokens or keys in this file or in `.env.example`.
- SearxNG is bound to `127.0.0.1` so only your own machine can reach it. Do not
  change that to `0.0.0.0` on a shared network.
- The local MCP server speaks stdio only and opens no network port. Its
  `parse_file` tool can read files on your own machine, which is fine locally.
  For anything shared between people, use the hosted mode in
  [DEPLOY.md](DEPLOY.md) instead.
