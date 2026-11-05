# OpenScrape MCP — container image for a shared deployment.
#
# Two build stages so the runtime image carries no TypeScript toolchain:
# `build` compiles, `runtime` gets only dist/ and production dependencies.
#
# Base choice: node:24-slim rather than a Playwright image. The Playwright
# images pin their own Node version, and this server needs >= 22 for
# `node:sqlite` (DatabaseSync), so controlling the Node version matters more
# than inheriting pre-installed browser dependencies. Chromium and its system
# libraries are installed explicitly below.

# ---------------------------------------------------------------- build
FROM node:24-slim AS build

WORKDIR /app

# Dependencies first, so a source-only change does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune to production dependencies for copying into the runtime stage.
RUN npm prune --omit=dev --ignore-scripts

# ---------------------------------------------------------------- runtime
FROM node:24-slim AS runtime

ENV NODE_ENV=production \
    # Keeps the browser inside the image rather than in a home directory that
    # a mounted volume might shadow.
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    # Scraped data, the SQLite index and spill files. Mount a volume here.
    OPENSCRAPE_DATA_DIR=/data \
    # Shared deployment defaults: no local file reads, no page scripts, no
    # private network targets, robots.txt enforced. See src/core/policy.
    OPENSCRAPE_MODE=hosted \
    OPENSCRAPE_MCP_HOST=0.0.0.0 \
    OPENSCRAPE_MCP_PORT=3100

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# Chromium plus the system libraries it needs. `--with-deps` resolves the
# distro packages, which is the part that is tedious to maintain by hand.
RUN npx playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

# The data directory is owned by the unprivileged user the image runs as.
# Running a browser as root is avoidable, so it is avoided.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME ["/data"]
EXPOSE 3100

# Unauthenticated health, so an orchestrator can check liveness without a token.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.OPENSCRAPE_MCP_PORT||3100)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/mcp/http.js"]
