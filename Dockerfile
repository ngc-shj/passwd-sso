# Stage 1: Install dependencies
# Pin base image to digest for reproducible builds (update with: docker pull node:20-alpine)
FROM node:20-alpine@sha256:b88333c42c23fbd91596ebd7fd10de239cedab9617de04142dde7315e3bc0afa AS deps
RUN apk add --no-cache libc6-compat && apk upgrade --no-cache zlib libcrypto3 libssl3
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Stage 2: Build the application
FROM node:20-alpine@sha256:b88333c42c23fbd91596ebd7fd10de239cedab9617de04142dde7315e3bc0afa AS builder
WORKDIR /app
RUN apk upgrade --no-cache zlib libcrypto3 libssl3
ARG DATABASE_URL
ENV DATABASE_URL=$DATABASE_URL
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npx next build
RUN npx esbuild scripts/audit-outbox-worker.ts \
      --bundle --platform=node --target=node20 \
      --outfile=dist/audit-outbox-worker.js \
      --external:pg --external:@prisma/client --external:@prisma/adapter-pg \
      --tsconfig=tsconfig.json \
      --alias:@=./src

# Stage 3: Production image
FROM node:20-alpine@sha256:b88333c42c23fbd91596ebd7fd10de239cedab9617de04142dde7315e3bc0afa AS runner
WORKDIR /app
RUN apk upgrade --no-cache zlib libcrypto3 libssl3

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/dotenv ./node_modules/dotenv

# Upgrade npm and patch npm-bundled CVE deps in a single layer.
# - npm 11.12.1: drops bundled cross-spawn entirely and ships glob 13.x /
#   minimatch 10.x, closing CVE-2024-21538, CVE-2025-64756,
#   CVE-2026-26996/27903/27904.
# - tar >=7.5.11: closes CVE-2026-31802 (npm 11.12.1 already ships this; the
#   patch block is a guarded no-op but kept as a tripwire if a future bump
#   downgrades).
# - picomatch >=4.0.4: closes CVE-2026-33671 (still bundled at 4.0.3 nested
#   under tinyglobby in npm 11.12.1).
# Patch blocks fail-closed (exit 1) when expected directories disappear, so a
# silent npm-layout drift cannot reintroduce the CVEs.
# `--ignore-scripts` on the global npm upgrade limits root-execution blast
# radius if the registry is compromised. Cache is cleared at the end to avoid
# shipping the downloaded tarballs in the final layer.
RUN TAR_VER=7.5.11 && \
    PICOMATCH_VER=4.0.4 && \
    NPM_VER=11.12.1 && \
    npm install -g "npm@${NPM_VER}" --loglevel=error --ignore-scripts && \
    npm install prisma --no-save --ignore-scripts && \
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
    cd / && \
    npm cache clean --force >/dev/null 2>&1 && \
    rm -rf /root/.npm /tmp/* && \
    # Post-patch invariant assertion: fail the build if any expected version is missing.
    [ "$(npm -v)" = "${NPM_VER}" ] && \
    node -e "const v=require('/usr/local/lib/node_modules/npm/node_modules/tar/package.json').version;if(v<'${TAR_VER}'){console.error('tar still '+v);process.exit(1)}" && \
    node -e "const v=require('/usr/local/lib/node_modules/npm/node_modules/tinyglobby/node_modules/picomatch/package.json').version;if(v<'${PICOMATCH_VER}'){console.error('picomatch still '+v);process.exit(1)}"

# Copy @prisma runtime adapters (overlay on top of prisma's @prisma packages)
COPY --from=builder /app/node_modules/@prisma/adapter-pg ./node_modules/@prisma/adapter-pg
COPY --from=builder /app/node_modules/@prisma/client ./node_modules/@prisma/client

# Audit outbox worker (bundled by esbuild; pg + deps are external)
COPY --from=builder --chown=nextjs:nodejs /app/dist/audit-outbox-worker.js ./dist/audit-outbox-worker.js
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
