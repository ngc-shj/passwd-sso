#!/usr/bin/env bash
# Assert .dockerignore excludes every env/secret file from the build context so
# secrets never enter the image. Next.js `output: "standalone"` traces .env into
# .next/standalone, and `COPY . .` + `COPY --from=builder /app/.next/standalone`
# would otherwise carry it into the final image (2026-07 review, High). A secret
# in the build context also leaks into builder layers / remote build cache, so
# exclusion must be RECURSIVE (root AND nested, e.g. extension/.env — the miss
# the 2026-07 re-review caught).
#
# Two independent assertions:
#   1. Static: .dockerignore must exclude `.env` / `.env.*` at ANY depth (except
#      committed .env.example placeholders). Primary, docker-free gate.
#   2. Bundle: if an extracted image/builder tree is provided, it must contain no
#      real env file anywhere. Catches a stale/misconfigured build.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/../.." && pwd))"
FIXTURE_ROOT="${DOCKERIGNORE_SECRETS_ROOT:-$REPO_ROOT}"
cd "$FIXTURE_ROOT"

# Env-pollution guard (mirrors check-dockerfile-prisma-pin.sh): an override under
# real CI requires an explicit fixture-mode ack so a stray export cannot point
# the gate at an empty dir and green it.
if [ "${CI:-}" = "true" ] && [ -n "${DOCKERIGNORE_SECRETS_ROOT:-}" ]; then
  if [ "${DOCKERIGNORE_SECRETS_FIXTURE_MODE:-}" != "1" ]; then
    echo "ENV_POLLUTION_GUARD: DOCKERIGNORE_SECRETS_ROOT override set under CI=true without DOCKERIGNORE_SECRETS_FIXTURE_MODE=1 — refusing."
    exit 1
  fi
fi

echo "check-dockerignore-secrets: FIXTURE_ROOT=$FIXTURE_ROOT"

DOCKERIGNORE=".dockerignore"
[ -f "$DOCKERIGNORE" ] || { echo "ERROR: $DOCKERIGNORE not found — a missing dockerignore means COPY . . ships all env files"; exit 1; }

# ── 1. Static assertion: env files are excluded at any depth ─────────────────
# Evaluate the effective ignore state with Docker's "last matching pattern wins"
# semantics for a representative set of secret-bearing env paths (root + nested).
node - "$DOCKERIGNORE" <<'NODE'
const fs = require("fs");
const patterns = fs.readFileSync(process.argv[2], "utf8")
  .split("\n").map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));

// Translate a Docker ignore-glob to an anchored full-path RegExp.
//   `**/` → any depth prefix incl. none (so **/.env matches .env AND extension/.env)
//   `**`  → any chars incl. slashes
//   `*`   → any run of non-slash chars
function globToRegExp(glob) {
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    if (glob[i] === "*" && glob[i + 1] === "*" && glob[i + 2] === "/") {
      out += "(?:.*/)?"; i += 2; continue;
    }
    if (glob[i] === "*" && glob[i + 1] === "*") { out += ".*"; i += 1; continue; }
    if (glob[i] === "*") { out += "[^/]*"; continue; }
    out += glob[i].replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(out + "$");
}

function ignored(path) {
  let ig = false;
  for (const p of patterns) {
    const neg = p.startsWith("!");
    const pat = neg ? p.slice(1) : p;
    if (globToRegExp(pat).test(path)) ig = !neg;
  }
  return ig;
}

// Must be EXCLUDED (carry secrets) — root AND nested (extension/.env was the miss).
const mustExclude = [
  ".env", ".env.local", ".env.production", ".env.development",
  ".env.bak", ".env.local.bak-20260101-000000",
  "extension/.env", "cli/.env", "extension/.env.production",
  "a/b/c/.env", "ios/.env.local",
];
// Must remain INCLUDED (committed, non-secret placeholders) — root and nested.
const mustInclude = [
  ".env.example",
  "extension/.env.example",
  "scripts/__tests__/fixtures/env-drift/positive/.env.example",
];

const leaked = mustExclude.filter((f) => !ignored(f));
const dropped = mustInclude.filter((f) => ignored(f));

if (leaked.length) {
  console.error("ERROR: .dockerignore does NOT exclude secret env file(s): " + leaked.join(", "));
  console.error("Add `.env`, `.env.*`, `**/.env`, `**/.env.*` (with `!.env.example` and `!**/.env.example`).");
  process.exit(1);
}
if (dropped.length) {
  console.error("ERROR: .dockerignore over-excludes committed placeholder(s): " + dropped.join(", "));
  process.exit(1);
}
console.log("OK (static: .dockerignore excludes env secrets at any depth, keeps .env.example)");
NODE

# ── 2. Bundle assertion: no env file anywhere in a built tree ─────────────────
# Opt-in (DOCKERIGNORE_SECRETS_SCAN_BUNDLE=1). A LOCAL `next build` traces .env
# into .next/standalone regardless of .dockerignore (dockerignore only scopes the
# Docker build CONTEXT), so scanning a dev build would false-red. Point
# DOCKERIGNORE_SECRETS_IMAGE_ROOT at a tree extracted from a Docker-built image
# (builder OR runner) — the whole tree is scanned, not just .next/standalone, so
# a nested build-context leak like /app/extension/.env is caught. Defaults to
# .next/standalone for backward compat. CI static-checks has no such tree, so the
# static gate above is the always-on regression net.
SCAN_ROOT="${DOCKERIGNORE_SECRETS_IMAGE_ROOT:-.next/standalone}"
if [ "${DOCKERIGNORE_SECRETS_SCAN_BUNDLE:-0}" = "1" ] && [ -d "$SCAN_ROOT" ]; then
  # Any .env / .env.* other than .env.example, at ANY depth, is a leak.
  # Exclude node_modules (third-party packages legitimately ship .env fixtures).
  found=$(find "$SCAN_ROOT" -type d -name node_modules -prune -o \
    -type f \( -name ".env" -o -name ".env.*" \) ! -name ".env.example" -print 2>/dev/null || true)
  if [ -n "$found" ]; then
    echo "ERROR: secret env file(s) present in the built tree $SCAN_ROOT (shipped via build context / image):"
    echo "$found"
    echo "Fix .dockerignore (recursive **/.env exclusion) and rebuild."
    exit 1
  fi
  echo "OK (bundle: $SCAN_ROOT has no secret env file at any depth)"
else
  echo "OK (bundle: no built tree at $SCAN_ROOT to scan — static gate applies)"
fi
