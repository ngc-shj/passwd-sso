#!/usr/bin/env bash
# Assert .dockerignore excludes every env/secret file from the build context so
# secrets never enter the image. Next.js `output: "standalone"` traces .env into
# .next/standalone, and `COPY . .` + `COPY --from=builder /app/.next/standalone`
# would otherwise carry it into the final image (2026-07 review, High).
#
# Two independent assertions:
#   1. Static: .dockerignore must exclude `.env` and `.env.*` (except the
#      committed placeholder). This is the primary, docker-free gate.
#   2. Bundle: if a built .next/standalone tree is present, it must contain no
#      real env file. This catches a stale/misconfigured local build.
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

# ── 1. Static assertion: env files are excluded ──────────────────────────────
# Evaluate the effective ignore state with Docker's "last matching pattern wins"
# semantics for a representative set of secret-bearing env filenames.
node - "$DOCKERIGNORE" <<'NODE'
const fs = require("fs");
const patterns = fs.readFileSync(process.argv[2], "utf8")
  .split("\n").map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));

function ignored(path) {
  let ig = false;
  for (const p of patterns) {
    const neg = p.startsWith("!");
    const pat = neg ? p.slice(1) : p;
    const re = pat.includes("*")
      ? new RegExp("^" + pat.replace(/\./g, "\\.").replace(/\*/g, "[^/]*") + "$")
      : new RegExp("^" + pat.replace(/\./g, "\\.") + "$");
    if (re.test(path)) ig = !neg;
  }
  return ig;
}

// Must be EXCLUDED (carry secrets).
const mustExclude = [
  ".env", ".env.local", ".env.production", ".env.development",
  ".env.bak", ".env.local.bak-20260101-000000",
];
// Must remain INCLUDED (committed, non-secret placeholder).
const mustInclude = [".env.example"];

const leaked = mustExclude.filter((f) => !ignored(f));
const dropped = mustInclude.filter((f) => ignored(f));

if (leaked.length) {
  console.error("ERROR: .dockerignore does NOT exclude secret env file(s): " + leaked.join(", "));
  console.error("Add `.env` and `.env.*` (with `!.env.example`) to .dockerignore.");
  process.exit(1);
}
if (dropped.length) {
  console.error("ERROR: .dockerignore over-excludes committed placeholder(s): " + dropped.join(", "));
  process.exit(1);
}
console.log("OK (static: .dockerignore excludes env secrets, keeps .env.example)");
NODE

# ── 2. Bundle assertion: no env file in a built standalone tree ───────────────
# Opt-in only (DOCKERIGNORE_SECRETS_SCAN_BUNDLE=1). A LOCAL `next build` traces
# .env into .next/standalone regardless of .dockerignore (dockerignore only
# scopes the Docker build context), so scanning a dev build would false-red.
# Run this against a tree extracted from a Docker-BUILT image, where the fixed
# .dockerignore has already kept .env out of the context. CI's static-checks job
# has no .next/standalone (fresh checkout), so the static gate above is the
# always-on regression net.
if [ "${DOCKERIGNORE_SECRETS_SCAN_BUNDLE:-0}" = "1" ] && [ -d ".next/standalone" ]; then
  # Any .env* other than .env.example inside the traced standalone output is a leak.
  found=$(find .next/standalone -type f \( -name ".env" -o -name ".env.*" \) \
    ! -name ".env.example" 2>/dev/null || true)
  if [ -n "$found" ]; then
    echo "ERROR: secret env file(s) present in .next/standalone (would ship in the image):"
    echo "$found"
    echo "Rebuild after fixing .dockerignore / removing the traced .env."
    exit 1
  fi
  echo "OK (bundle: .next/standalone has no secret env file)"
else
  echo "OK (bundle: no .next/standalone present to scan — static gate applies)"
fi
