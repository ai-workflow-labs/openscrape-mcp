#!/usr/bin/env bash
#
# Bootstrap OpenScrape on a fresh Oracle Cloud Always Free instance.
#
# The repository is PRIVATE, so there is no curl-pipe-to-bash one-liner: an
# unauthenticated fetch of a private repo returns 404, and a 404 piped into
# bash does nothing visible, which is a miserable way to start. Copy this file
# to the instance instead:
#
#   scp scripts/oracle-bootstrap.sh ubuntu@INSTANCE_IP:~
#   ssh ubuntu@INSTANCE_IP
#   sudo bash oracle-bootstrap.sh --domain scrape.yourdomain.com
#
#   sudo bash oracle-bootstrap.sh --no-tls          # testing only
#
# The clone itself also needs access. The script generates a deploy key on the
# instance and stops with instructions the first time, then picks up where it
# left off when you run it again. Safe to re-run: every step checks before it
# changes anything.
#
# Tested logic, untested host: this has not been run on an Oracle instance, so
# read it before running it as root.

set -euo pipefail

# SSH rather than HTTPS: a private clone over HTTPS needs a token in the URL or
# a credential helper on a headless box, and both are worse than a deploy key
# that can be revoked from the repository's own settings page.
REPO="git@github.com:ai-workflow-labs/openscrape-mcp.git"
DEPLOY_KEY="/root/.ssh/openscrape_deploy_ed25519"
APP_DIR="/opt/openscrape"
DOMAIN=""
USE_TLS=1
PORT=3100

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --no-tls) USE_TLS=0; shift ;;
    --port)   PORT="${2:-3100}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ $USE_TLS -eq 1 && -z "$DOMAIN" ]]; then
  cat >&2 <<'EOF'
Pass --domain <hostname> so TLS can be set up, or --no-tls to skip it.

Skipping TLS means the bearer tokens your team sends travel in clear text,
readable by anything on the network path. Only do that behind a tunnel, or
for a throwaway test.
EOF
  exit 2
fi

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\n\033[33m!!  %s\033[0m\n' "$*"; }

if [[ $EUID -ne 0 ]]; then
  echo "Run this with sudo." >&2
  exit 1
fi

log "Host"
echo "arch:   $(uname -m)        (expect aarch64 on Ampere A1)"
echo "memory: $(free -h | awk '/^Mem:/{print $2}')"
echo "disk:   $(df -h / | awk 'NR==2{print $4" free"}')"

# ---------------------------------------------------------------------------
# 1. The firewall nobody expects
# ---------------------------------------------------------------------------
# Oracle's Ubuntu images ship iptables rules that DROP everything except SSH,
# *in addition* to the VCN security list you configure in the console. Opening
# only the console side and finding the port still closed is the single most
# common Oracle Cloud failure. Both have to be open.
log "Opening ports 80 and 443 on the instance firewall"

if command -v netfilter-persistent >/dev/null 2>&1; then
  for port in 80 443; do
    if iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then
      echo "port $port already allowed"
    else
      # Inserted at position 6 to land above Oracle's catch-all REJECT rule
      # rather than below it, where it would never match.
      iptables -I INPUT 6 -p tcp --dport "$port" -m state --state NEW -j ACCEPT
      echo "port $port opened"
    fi
  done
  netfilter-persistent save >/dev/null 2>&1 || iptables-save > /etc/iptables/rules.v4
else
  warn "netfilter-persistent not found; check your firewall manually"
fi

warn "The VCN security list is separate and is NOT set by this script.
    Console -> Networking -> Virtual Cloud Networks -> your VCN -> Security Lists
    Add ingress: source 0.0.0.0/0, TCP, destination ports 80 and 443.
    Without this the instance stays unreachable no matter what runs on it."

# ---------------------------------------------------------------------------
# 2. Docker
# ---------------------------------------------------------------------------
log "Installing Docker"
if command -v docker >/dev/null 2>&1; then
  echo "docker present: $(docker --version)"
else
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq docker.io docker-compose-v2 git
  systemctl enable --now docker
  echo "installed: $(docker --version)"
fi

# ---------------------------------------------------------------------------
# 3. Swap
# ---------------------------------------------------------------------------
# Not for normal running — 12 GB is plenty. This is a cushion so that a page
# that balloons Chromium's memory gets slow instead of getting the container
# OOM-killed mid-crawl.
log "Swap"
if [[ -f /swapfile ]] || swapon --show | grep -q .; then
  echo "swap already configured: $(free -h | awk '/^Swap:/{print $2}')"
else
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "4G swap added"
fi

# ---------------------------------------------------------------------------
# 4. The application
# ---------------------------------------------------------------------------
log "Fetching OpenScrape"

# A deploy key for the clone. Read-only is enough — this box never pushes.
if [[ ! -f "$DEPLOY_KEY" ]]; then
  mkdir -p /root/.ssh && chmod 700 /root/.ssh
  ssh-keygen -t ed25519 -N "" -C "openscrape deploy key ($(hostname))" -f "$DEPLOY_KEY" >/dev/null
fi

export GIT_SSH_COMMAND="ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"

# Check access before cloning, so the failure is a clear instruction rather
# than git's "Repository not found", which for a private repo is what you get
# both when it does not exist and when you simply cannot see it.
if ! ssh -i "$DEPLOY_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new \
      -o BatchMode=yes -T git@github.com 2>&1 | grep -q 'successfully authenticated'; then
  cat <<KEYSETUP

------------------------------------------------------------------
This instance cannot read the repository yet. Add its key:

  https://github.com/ai-workflow-labs/openscrape-mcp/settings/keys

  "Add deploy key", title: $(hostname)
  Leave "Allow write access" UNCHECKED - this box only needs to read.

$(cat "${DEPLOY_KEY}.pub")

Then run this script again. It will carry on from here.
------------------------------------------------------------------

KEYSETUP
  exit 3
fi

if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone --depth 1 "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"

# Persist the key choice so later `git pull` in this directory works without
# the environment variable being set.
git config --local core.sshCommand "$GIT_SSH_COMMAND"

# ---------------------------------------------------------------------------
# 5. Tokens
# ---------------------------------------------------------------------------
# Generated here, on the box, rather than anywhere they could be copied through
# a chat window or a shell history on a laptop.
log "Tokens"
if [[ -f .env ]] && grep -q '^OPENSCRAPE_MCP_TOKENS=.\+' .env; then
  echo ".env already has tokens; leaving them alone"
  echo "(to add someone, edit .env and run: docker compose up -d)"
else
  read -rp "Names for the team, space separated (e.g. alice bob carol): " -a NAMES
  if [[ ${#NAMES[@]} -eq 0 ]]; then NAMES=(team); fi

  TOKENS=""
  echo
  echo "Give each person their own line. These are shown once."
  echo "-----------------------------------------------------------"
  for name in "${NAMES[@]}"; do
    tok="$(openssl rand -hex 24)"
    TOKENS+="${TOKENS:+,}${name}:${tok}"
    printf '%-10s %s\n' "$name" "$tok"
  done
  echo "-----------------------------------------------------------"
  echo

  cp -n .env.example .env 2>/dev/null || true
  # Replace the placeholder line rather than appending, so re-running does not
  # leave two definitions with the first one winning.
  if grep -q '^OPENSCRAPE_MCP_TOKENS=' .env; then
    sed -i "s|^OPENSCRAPE_MCP_TOKENS=.*|OPENSCRAPE_MCP_TOKENS=${TOKENS}|" .env
  else
    echo "OPENSCRAPE_MCP_TOKENS=${TOKENS}" >> .env
  fi
  chmod 600 .env
fi

# The SearxNG sidecar's session secret. Generated on the box like the tokens,
# and required: docker-compose.yml uses ${SEARXNG_SECRET:?...}, so compose
# refuses to start without it rather than bringing up a half-working stack.
#
# The placeholder from .env.example counts as unset. Matching on the real shape
# and not just the key means a .env copied from the example still gets a real
# secret here instead of deploying the word REPLACE_ME.
if grep -qE '^SEARXNG_SECRET=[0-9a-f]{32,}$' .env; then
  echo "SearxNG secret already set; leaving it alone"
else
  SEARX_SECRET="$(openssl rand -hex 32)"
  if grep -q '^SEARXNG_SECRET=' .env; then
    sed -i "s|^SEARXNG_SECRET=.*|SEARXNG_SECRET=${SEARX_SECRET}|" .env
  else
    echo "SEARXNG_SECRET=${SEARX_SECRET}" >> .env
  fi
  unset SEARX_SECRET
  echo "SearxNG secret generated"
fi
chmod 600 .env

# Hosted defaults, and the hostname allowlist that turns on DNS-rebinding
# protection.
grep -q '^OPENSCRAPE_MODE=' .env || echo 'OPENSCRAPE_MODE=hosted' >> .env
if [[ -n "$DOMAIN" ]]; then
  if grep -q '^OPENSCRAPE_MCP_ALLOWED_HOSTS=' .env; then
    sed -i "s|^OPENSCRAPE_MCP_ALLOWED_HOSTS=.*|OPENSCRAPE_MCP_ALLOWED_HOSTS=${DOMAIN}|" .env
  else
    echo "OPENSCRAPE_MCP_ALLOWED_HOSTS=${DOMAIN}" >> .env
  fi
fi

# ---------------------------------------------------------------------------
# 6. Build and run
# ---------------------------------------------------------------------------
# Built on the instance on purpose: this is ARM, and an amd64 image pushed here
# fails at runtime with an exec-format error that looks like a code bug.
log "Building the image (ARM build, first run takes a few minutes)"
docker compose build

log "Starting"
docker compose up -d

# ---------------------------------------------------------------------------
# 7. TLS
# ---------------------------------------------------------------------------
if [[ $USE_TLS -eq 1 ]]; then
  log "Caddy for TLS on $DOMAIN"
  if ! command -v caddy >/dev/null 2>&1; then
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
    apt-get update -qq
    apt-get install -y -qq caddy
  fi

  cat > /etc/caddy/Caddyfile <<CADDY
# Managed by openscrape oracle-bootstrap.sh
${DOMAIN} {
    reverse_proxy 127.0.0.1:${PORT}
}
CADDY

  systemctl reload caddy || systemctl restart caddy
  echo "Caddy will obtain a certificate automatically, provided ${DOMAIN}"
  echo "already resolves to this instance's public IP."
else
  warn "No TLS. Tokens will travel in clear text. Put a tunnel or a proxy in
    front before giving this URL to anyone."
fi

# ---------------------------------------------------------------------------
# 8. Verify
# ---------------------------------------------------------------------------
log "Health"
for i in $(seq 1 20); do
  if out="$(curl -fsS "http://127.0.0.1:${PORT}/health" 2>/dev/null)"; then
    echo "$out"
    break
  fi
  sleep 3
  [[ $i -eq 20 ]] && { warn "No health response. Check: docker compose logs --tail 50"; exit 1; }
done

if echo "${out:-}" | grep -q '"lockdown":true'; then
  echo "lockdown: active (local file reads, page scripts and private targets are off)"
else
  warn "lockdown is NOT active. Set OPENSCRAPE_MODE=hosted in .env and restart."
fi

# Search is checked separately because /health does not cover it, and because
# it fails in a quiet way: every other tool works while `search` returns "no
# provider answered". Asking for JSON is the whole point — SearxNG ships with
# its JSON API off, so a running container is not the same as a working
# provider. Engine fan-out on a cold start is slow, hence the retries.
log "Search provider"
SEARX_OK=0
for i in $(seq 1 10); do
  if docker compose exec -T searxng \
      wget -qO- 'http://127.0.0.1:8080/search?q=ping&format=json' 2>/dev/null \
      | grep -q '"results"'; then
    echo "searxng: answering JSON (search will work)"
    SEARX_OK=1
    break
  fi
  sleep 6
done
if [[ $SEARX_OK -eq 0 ]]; then
  warn "SearxNG is not answering JSON, so \`search\` will report no provider.
    Check:  docker compose logs --tail 50 searxng
    The JSON API is enabled by deploy/searxng/settings.yml, mounted at
    /etc/searxng/settings.yml — confirm it is really mounted:
      docker compose exec searxng grep -A3 formats /etc/searxng/settings.yml
    Everything else on the instance works without this."
fi

PUBLIC_IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo '<instance-ip>')"
URL="${DOMAIN:+https://$DOMAIN/mcp}"
URL="${URL:-http://$PUBLIC_IP:$PORT/mcp}"

log "Done"
cat <<DONE
MCP URL:  ${URL}

Each person adds it with their own token:

  claude mcp add --transport http openscrape ${URL} \\
    --header "Authorization: Bearer THEIR_TOKEN"

Useful afterwards:

  docker compose -f ${APP_DIR}/docker-compose.yml logs -f
  docker compose -f ${APP_DIR}/docker-compose.yml restart
  curl ${DOMAIN:+https://$DOMAIN}${DOMAIN:+/health}${DOMAIN:-http://127.0.0.1:$PORT/health}

Still to do by hand, in the Oracle console:
  VCN -> Security Lists -> ingress 0.0.0.0/0 TCP ports 80, 443
DONE
