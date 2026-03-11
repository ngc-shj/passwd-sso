# Stage 1: Install dependencies
# Pin base image to digest for reproducible builds (update with: docker pull node:20-alpine)
FROM node:20-alpine@sha256:b88333c42c23fbd91596ebd7fd10de239cedab9617de04142dde7315e3bc0afa AS deps
RUN apk add --no-cache libc6-compat && apk upgrade --no-cache zlib
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Stage 2: Build the application
FROM node:20-alpine@sha256:b88333c42c23fbd91596ebd7fd10de239cedab9617de04142dde7315e3bc0afa AS builder
WORKDIR /app
RUN apk upgrade --no-cache zlib
ARG DATABASE_URL
ENV DATABASE_URL=$DATABASE_URL
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npx next build

# Stage 3: Production image
FROM node:20-alpine@sha256:b88333c42c23fbd91596ebd7fd10de239cedab9617de04142dde7315e3bc0afa AS runner
WORKDIR /app
RUN apk upgrade --no-cache zlib

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

# Install prisma CLI + all deps for migrate deploy
# Patch npm-bundled tar to >=7.5.11 (CVE-2026-31802)
RUN TAR_VER=7.5.11 && \
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
      echo "WARNING: tar directory not found at ${TAR_DIR}, skipping patch" >&2; \
    fi

# Copy @prisma runtime adapters (overlay on top of prisma's @prisma packages)
COPY --from=builder /app/node_modules/@prisma/adapter-pg ./node_modules/@prisma/adapter-pg
COPY --from=builder /app/node_modules/@prisma/client ./node_modules/@prisma/client

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
