# Stage 1: Install dependencies
# Pin base image to digest for reproducible builds (update with: docker pull node:24-alpine)
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS deps
# deps/builder are intermediate — only the runner stage ships. Patching here
# would be discarded. apk upgrade only happens in the runner stage.
RUN apk add --no-cache libc6-compat
WORKDIR /app
# `.npmrc` carries `legacy-peer-deps=true` so the next-auth@beta peerOptional
# on @simplewebauthn/browser@^9 does not block our v11 direct dep (the
# v9-pinned next-auth WebAuthn code paths are blocked at static-check time —
# see scripts/pre-pr.sh `no-authjs-builtin-webauthn-provider`). Without
# copying this file, `npm ci` inside the build fails with ERESOLVE.
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts
# Generate the Prisma client so docker-compose worker services that use
# `target: deps` can resolve `.prisma/client/default` at runtime. The builder
# stage regenerates this for the production image — the duplication is OK
# because builder copies node_modules from deps then overwrites .prisma/.
# DATABASE_URL is required by prisma.config.ts but no DB connection is opened.
ARG DATABASE_URL=postgresql://build:build@localhost:5432/passwd_sso
COPY prisma ./prisma
COPY prisma.config.ts ./prisma.config.ts
RUN DATABASE_URL="$DATABASE_URL" npx prisma generate

# Stage 1b: Dedicated Prisma CLI install (isolated closure).
# The runner needs the Prisma CLI (the `migrate` compose service runs
# `npx prisma migrate deploy`), but installing it in the runner re-resolves the
# WHOLE app dependency tree and fails ERESOLVE on @hookform/resolvers ⇄ valibot
# — and cherry-picking prisma's deep transitive deps (effect, mysql2, postgres,
# @prisma/*) out of the app node_modules is fragile. Instead resolve prisma's
# OWN closure in isolation here (with .npmrc → legacy-peer-deps), pinned to the
# lockfile version, and COPY the self-contained tree into the runner.
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS prisma-cli
WORKDIR /prisma-cli
COPY .npmrc ./
# PRISMA_VER is kept in lockstep with package-lock.json by
# scripts/checks/check-dockerfile-prisma-pin.
RUN PRISMA_VER=7.9.0 && \
    npm init -y >/dev/null 2>&1 && \
    npm install "prisma@${PRISMA_VER}" --ignore-scripts --loglevel=error && \
    node -e "const v=require('/prisma-cli/node_modules/prisma/package.json').version;if(v!=='${PRISMA_VER}'){console.error('prisma pin failed: got '+v+', expected ${PRISMA_VER}');process.exit(1)}" && \
    node node_modules/prisma/build/index.js --version >/dev/null

# Stage 2: Build the application
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS builder
WORKDIR /app
# DATABASE_URL is needed only for `prisma generate` to satisfy env("DATABASE_URL")
# in prisma.config.ts — no actual DB connection is opened at build time. A dummy
# default keeps standalone `docker build` working, and callers can override via
# `--build-arg`. We intentionally do NOT persist it as ENV to avoid leaking any
# overridden value into `docker history` / image metadata, and to keep it out
# of later RUN layers.
ARG DATABASE_URL=postgresql://build:build@localhost:5432/passwd_sso
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN DATABASE_URL="$DATABASE_URL" npx prisma generate
RUN npx next build
RUN npx esbuild scripts/audit-outbox-worker.ts \
      --bundle --platform=node --target=node24 \
      --outfile=dist/audit-outbox-worker.js \
      --external:pg --external:@prisma/client --external:@prisma/adapter-pg \
      --tsconfig=tsconfig.json \
      --alias:@=./src
RUN npx esbuild scripts/retention-gc-worker.ts \
      --bundle --platform=node --target=node24 \
      --outfile=dist/retention-gc-worker.js \
      --external:pg --external:@prisma/client --external:@prisma/adapter-pg \
      --tsconfig=tsconfig.json \
      --alias:@=./src

# Stage 3: Production image
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS runner
WORKDIR /app
RUN apk upgrade --no-cache zlib libcrypto3 libssl3 musl musl-utils

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
# .prisma (generated client) is COPYed AFTER the prisma-cli node_modules below,
# so the generated client always wins over the CLI stage's tree.
COPY --from=builder /app/node_modules/dotenv ./node_modules/dotenv

# Upgrade npm and patch npm-bundled CVE deps in a single layer.
# NPM_VER=11.16.0 matches the npm bundled with node:24-alpine (24.18.0) and the
# release.yml PUBLISH_NPM_VERSION pin — the `npm install -g` is a no-op version-lock,
# not a real upgrade, so a future base-image bump that ships a different npm is
# caught by the post-patch `npm -v` assertion.
# - npm 11.16.0: drops bundled cross-spawn entirely and ships glob 13.x /
#   minimatch 10.x, closing CVE-2024-21538, CVE-2025-64756,
#   CVE-2026-26996/27903/27904.
# - tar >=7.5.19: closes CVE-2026-31802 (fixed in 7.5.11) AND the newer
#   CVE-2026-59873 (gzip-bomb DoS, fixed 7.5.19) / CVE-2026-59874 (malformed
#   tar-header DoS, fixed 7.5.18). npm 11.16.0 ships tar 7.5.15 under its own
#   node_modules, so the patch block below force-upgrades it.
# - picomatch >=4.0.4: closes CVE-2026-33671. npm 11.16.0 already bundles 4.0.4
#   (nested under tinyglobby), so the patch is a no-op skip — kept as a
#   fail-closed tripwire in case a future npm regresses it.
# - sigstore >=4.1.1: closes CVE-2026-48815 (certificateOIDs verification
#   constraints silently dropped). npm 11.16.0 already bundles 4.1.1, so the
#   patch is a no-op skip — kept as a fail-closed tripwire.
# - brace-expansion >=5.0.7: closes CVE-2026-13149 (exponential-time DoS;
#   bundled at 5.0.6 under npm 11.16.0). The app's own copy is already pinned
#   via the package.json overrides block; this patches npm's bundled copy.
# Patch blocks fail-closed (exit 1) when expected directories disappear, so a
# silent npm-layout drift cannot reintroduce the CVEs.
# `--ignore-scripts` on the global npm upgrade limits root-execution blast
# radius if the registry is compromised. Cache is cleared at the end to avoid
# shipping the downloaded tarballs in the final layer.
# PRISMA_VER is pinned to the package-lock.json `prisma` version (the CLI the
# `migrate` compose service runs); a floating `latest` here breaks build
# reproducibility and risks CLI/generated-client skew. Kept in lockstep with the
# lockfile by scripts/checks/check-dockerfile-prisma-pin.sh.
RUN TAR_VER=7.5.19 && \
    PICOMATCH_VER=4.0.4 && \
    SIGSTORE_VER=4.1.1 && \
    BE_VER=5.0.7 && \
    NPM_VER=11.16.0 && \
    npm install -g "npm@${NPM_VER}" --loglevel=error --ignore-scripts && \
    TAR_DIR=/usr/local/lib/node_modules/npm/node_modules/tar && \
    if [ -d "$TAR_DIR" ]; then \
      CURRENT=$(node -p "require('${TAR_DIR}/package.json').version") && \
      if [ "$(printf '%s\n' "$TAR_VER" "$CURRENT" | sort -V | head -n1)" != "$TAR_VER" ]; then \
        cd "$TAR_DIR" && \
        npm pack "tar@${TAR_VER}" --quiet && \
        tar xzf "tar-${TAR_VER}.tgz" --strip-components=1 && \
        rm -f "tar-${TAR_VER}.tgz" && \
        node -e "const v=require('./package.json').version;if(v!=='${TAR_VER}'){console.error('tar patch failed: got '+v);process.exit(1)}"; \
      else \
        echo "tar ${CURRENT} already >= ${TAR_VER}, skipping patch"; \
      fi; \
    else \
      echo "ERROR: tar directory not found at ${TAR_DIR}; npm layout changed, re-verify patch path" >&2 && exit 1; \
    fi && \
    PICOMATCH_DIR=/usr/local/lib/node_modules/npm/node_modules/tinyglobby/node_modules/picomatch && \
    if [ -d "$PICOMATCH_DIR" ]; then \
      CURRENT=$(node -p "require('${PICOMATCH_DIR}/package.json').version") && \
      if [ "$(printf '%s\n' "$PICOMATCH_VER" "$CURRENT" | sort -V | head -n1)" != "$PICOMATCH_VER" ]; then \
        cd "$PICOMATCH_DIR" && \
        npm pack "picomatch@${PICOMATCH_VER}" --quiet && \
        tar xzf "picomatch-${PICOMATCH_VER}.tgz" --strip-components=1 && \
        rm -f "picomatch-${PICOMATCH_VER}.tgz" && \
        node -e "const v=require('./package.json').version;if(v!=='${PICOMATCH_VER}'){console.error('picomatch patch failed: got '+v);process.exit(1)}"; \
      else \
        echo "picomatch ${CURRENT} already >= ${PICOMATCH_VER}, skipping patch"; \
      fi; \
    else \
      echo "ERROR: picomatch directory not found at ${PICOMATCH_DIR}; npm layout changed, re-verify patch path" >&2 && exit 1; \
    fi && \
    SIGSTORE_DIR=/usr/local/lib/node_modules/npm/node_modules/sigstore && \
    if [ -d "$SIGSTORE_DIR" ]; then \
      CURRENT=$(node -p "require('${SIGSTORE_DIR}/package.json').version") && \
      if [ "$(printf '%s\n' "$SIGSTORE_VER" "$CURRENT" | sort -V | head -n1)" != "$SIGSTORE_VER" ]; then \
        cd "$SIGSTORE_DIR" && \
        npm pack "sigstore@${SIGSTORE_VER}" --quiet && \
        tar xzf "sigstore-${SIGSTORE_VER}.tgz" --strip-components=1 && \
        rm -f "sigstore-${SIGSTORE_VER}.tgz" && \
        node -e "const v=require('./package.json').version;if(v!=='${SIGSTORE_VER}'){console.error('sigstore patch failed: got '+v);process.exit(1)}"; \
      else \
        echo "sigstore ${CURRENT} already >= ${SIGSTORE_VER}, skipping patch"; \
      fi; \
    else \
      echo "ERROR: sigstore directory not found at ${SIGSTORE_DIR}; npm layout changed, re-verify patch path" >&2 && exit 1; \
    fi && \
    BE_DIR=/usr/local/lib/node_modules/npm/node_modules/brace-expansion && \
    if [ -d "$BE_DIR" ]; then \
      CURRENT=$(node -p "require('${BE_DIR}/package.json').version") && \
      if [ "$(printf '%s\n' "$BE_VER" "$CURRENT" | sort -V | head -n1)" != "$BE_VER" ]; then \
        cd "$BE_DIR" && \
        npm pack "brace-expansion@${BE_VER}" --quiet && \
        tar xzf "brace-expansion-${BE_VER}.tgz" --strip-components=1 && \
        rm -f "brace-expansion-${BE_VER}.tgz" && \
        node -e "const v=require('./package.json').version;if(v!=='${BE_VER}'){console.error('brace-expansion patch failed: got '+v);process.exit(1)}"; \
      else \
        echo "brace-expansion ${CURRENT} already >= ${BE_VER}, skipping patch"; \
      fi; \
    else \
      echo "ERROR: brace-expansion directory not found at ${BE_DIR}; npm layout changed, re-verify patch path" >&2 && exit 1; \
    fi && \
    cd / && \
    npm cache clean --force >/dev/null 2>&1 && \
    rm -rf /root/.npm /tmp/* && \
    # Post-patch invariant assertion: fail the build if any expected version is missing.
    [ "$(npm -v)" = "${NPM_VER}" ] && \
    node -e "const v=require('/usr/local/lib/node_modules/npm/node_modules/tar/package.json').version,c=v.split('.').map(Number),m='${TAR_VER}'.split('.').map(Number);for(let i=0;i<m.length;i++){const a=c[i]||0;if(a>m[i])break;if(a<m[i]){console.error('tar still '+v);process.exit(1)}}" && \
    node -e "const v=require('/usr/local/lib/node_modules/npm/node_modules/tinyglobby/node_modules/picomatch/package.json').version,c=v.split('.').map(Number),m='${PICOMATCH_VER}'.split('.').map(Number);for(let i=0;i<m.length;i++){const a=c[i]||0;if(a>m[i])break;if(a<m[i]){console.error('picomatch still '+v);process.exit(1)}}" && \
    node -e "const v=require('/usr/local/lib/node_modules/npm/node_modules/sigstore/package.json').version,c=v.split('.').map(Number),m='${SIGSTORE_VER}'.split('.').map(Number);for(let i=0;i<m.length;i++){const a=c[i]||0;if(a>m[i])break;if(a<m[i]){console.error('sigstore still '+v);process.exit(1)}}" && \
    node -e "const v=require('/usr/local/lib/node_modules/npm/node_modules/brace-expansion/package.json').version,c=v.split('.').map(Number),m='${BE_VER}'.split('.').map(Number);for(let i=0;i<m.length;i++){const a=c[i]||0;if(a>m[i])break;if(a<m[i]){console.error('brace-expansion still '+v);process.exit(1)}}"

# Prisma CLI: COPY the self-contained closure from the dedicated `prisma-cli`
# stage (isolated npm install with .npmrc), NOT a runner-side `npm install`
# (which re-resolves the whole app tree → ERESOLVE) and NOT a cherry-pick from
# the app node_modules (misses deep transitive deps like `effect`). This brings
# the CLI + its non-@prisma transitive deps (effect, mysql2, postgres, …) into
# the runner's node_modules.
COPY --from=prisma-cli /prisma-cli/node_modules ./node_modules

# The CLI-stage COPY above overwrites @prisma/* with the CLI's set, which lacks
# the app-runtime packages (driver-adapter-utils, generated client). Overlay the
# builder's COMPLETE @prisma/* — it is a superset (CLI deps: config/engines/dev,
# AND app runtime: adapter-pg/client/driver-adapter-utils) — plus the generated
# client, so the worker + app can resolve the adapter at runtime.
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# Audit outbox worker (bundled by esbuild; pg + deps are external)
COPY --from=builder --chown=nextjs:nodejs /app/dist/audit-outbox-worker.js ./dist/audit-outbox-worker.js
# Retention-GC worker (bundled by esbuild; pg + deps are external)
COPY --from=builder --chown=nextjs:nodejs /app/dist/retention-gc-worker.js ./dist/retention-gc-worker.js
COPY --from=builder /app/node_modules/pg ./node_modules/pg
COPY --from=builder /app/node_modules/pg-connection-string ./node_modules/pg-connection-string
COPY --from=builder /app/node_modules/pg-int8 ./node_modules/pg-int8
COPY --from=builder /app/node_modules/pg-pool ./node_modules/pg-pool
COPY --from=builder /app/node_modules/pg-protocol ./node_modules/pg-protocol
COPY --from=builder /app/node_modules/pg-types ./node_modules/pg-types
COPY --from=builder /app/node_modules/pgpass ./node_modules/pgpass
COPY --from=builder /app/node_modules/postgres-array ./node_modules/postgres-array
COPY --from=builder /app/node_modules/postgres-bytea ./node_modules/postgres-bytea
COPY --from=builder /app/node_modules/postgres-date ./node_modules/postgres-date
COPY --from=builder /app/node_modules/postgres-interval ./node_modules/postgres-interval
COPY --from=builder /app/node_modules/split2 ./node_modules/split2
COPY --from=builder /app/node_modules/xtend ./node_modules/xtend

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
