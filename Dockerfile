# 3D Gen Studio — shared asset/project server.
#
# This image runs server.js with GENSTUDIO_MODE=server: the data routes, auth
# and the asset store only. It has no GPU, no ComfyUI, no Python sidecars and no
# third-party API keys — every user keeps those on their own machine. See
# serverMode.js for the exact route split.

# ---------------------------------------------------------------------------
# Builder: full toolchain. Produces the Vite bundle and a production-only
# node_modules with sqlite3 compiled for this base image, so the runtime image
# needs no compiler of its own.
# ---------------------------------------------------------------------------
FROM node:24-bookworm AS builder
WORKDIR /app

# sqlite3 is the only native dependency, and its published prebuilt binary is
# linked against glibc >= 2.38 while the bookworm runtime ships 2.36 — loading
# it there fails with "GLIBC_2.38 not found". Compiling from source binds it to
# the same Debian release the runtime stage uses, so the two cannot drift.
ENV npm_config_build_from_source=true
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# Reduce to production dependencies. dist/ is already built, so dropping the dev
# tree here keeps it out of the runtime image entirely.
RUN npm ci --omit=dev && npm cache clean --force

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime

# WORKDIR is load-bearing: storage.js derives DATA_DIR from process.cwd(), so
# the data volume must be mounted at exactly <workdir>/data.
WORKDIR /app

# Baked defaults, so a NAS/Container Manager import of the saved .tar comes up
# configured instead of needing every variable typed into the UI by hand. Each
# is a plain ENV, which is what makes it pre-fill in that dialog; anything the
# host sets (compose `environment:`, Container Manager, `docker run -e`) still
# wins over these at runtime.
#
# Override at build time with e.g.
#   docker compose build --build-arg GENSTUDIO_JWT_SECRET=<64 hex chars>
#
# NOTE: these values live in the image layers, so the saved .tar carries the
# signing secret and the first-run admin password to anyone who can read it.
# Fine for a private NAS; change them before the image travels further.
ARG GENSTUDIO_JWT_SECRET=123456Secret123456Secret123456
ARG GENSTUDIO_ADMIN_LOGIN=admin
ARG GENSTUDIO_ADMIN_PASSWORD=admin123
ARG TRUST_PROXY_HEADERS=0

ENV NODE_ENV=production \
    GENSTUDIO_MODE=server \
    PORT=3001 \
    GENSTUDIO_JWT_SECRET=${GENSTUDIO_JWT_SECRET} \
    GENSTUDIO_ADMIN_LOGIN=${GENSTUDIO_ADMIN_LOGIN} \
    GENSTUDIO_ADMIN_PASSWORD=${GENSTUDIO_ADMIN_PASSWORD} \
    TRUST_PROXY_HEADERS=${TRUST_PROXY_HEADERS}

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json version.json ./
COPY --chown=node:node server.js storage.js wikiStorage.js auth.js serverMode.js gateway.js dataStore.js uploadQueue.js logs.js meshPivot.js meshRigTransfer.js skinTransfer.js pgEmbedded.js ./
# The SQL engine. db/index.js chooses a driver at startup -- PostgreSQL here,
# SQLite on a desktop install -- and loads it by dynamic import, so the whole
# directory ships rather than a name-by-name list that would look complete.
# db/schema.pg.sql is read at runtime and travels with it.
COPY --chown=node:node db ./db
# The SQLite to PostgreSQL migration, run once per upgraded deployment (see
# docker-compose.yml for the exact command). It needs the sqlite3 module, which
# is why that dependency stays in the image even though the server itself never
# loads it when running on PostgreSQL.
COPY --chown=node:node tools/migrate-sqlite-to-postgres.mjs ./tools/
COPY --chown=node:node mcp ./mcp
COPY --chown=node:node wiki ./wiki

# Run unprivileged. Ownership is set by --chown on each COPY above rather than a
# trailing `chown -R /app`: that recursive form rewrites every one of the ~40k
# node_modules files into an extra image layer, which roughly doubles the image
# and adds minutes to the build. Only data/ needs creating here, so the volume
# inherits the right owner on first run.
RUN mkdir -p /app/data && chown node:node /app /app/data
USER node

EXPOSE 3001
VOLUME ["/app/data"]

# node:24 has a global fetch, so no curl is needed in the slim image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
