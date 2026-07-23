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

// Docker excludes a whole directory subtree when a pattern matches an ancestor
// dir (e.g. `**/.terraform` excludes infra/terraform/.terraform/providers/x).
// So a path is matched if the pattern matches the path itself OR any ancestor.
function matchesPathOrAncestor(re, path) {
  const parts = path.split("/");
  for (let i = parts.length; i >= 1; i--) {
    if (re.test(parts.slice(0, i).join("/"))) return true;
  }
  return false;
}

function ignored(path) {
  let ig = false;
  for (const p of patterns) {
    const neg = p.startsWith("!");
    const pat = neg ? p.slice(1) : p;
    const re = globToRegExp(pat);
    // Negations (re-includes) apply to the exact path only, not ancestors.
    if (neg ? re.test(path) : matchesPathOrAncestor(re, path)) ig = !neg;
  }
  return ig;
}

// Must be EXCLUDED — root AND nested. Covers the whole git-ignored secret /
// artifact class that `COPY . .` would otherwise pull into the build context
// (env files, keys/certs, CLI vault mapping, Terraform state/tfvars/.terraform,
// local DBs). Nested cases (extension/.env, certificates/*.pem, infra/.terraform)
// were the successive re-review misses.
const mustExclude = [
  // env files
  ".env", ".env.local", ".env.production", ".env.development",
  ".env.bak", ".env.local.bak-20260101-000000",
  "extension/.env", "cli/.env", "extension/.env.production",
  "a/b/c/.env", "ios/.env.local",
  // keys / certs
  "certificates/localhost-key.pem", "certificates/localhost.pem",
  "a/b/tls.key", "server.crt", "x.cert", "id.p12", "id.pfx",
  "master.key", "config/encryption.key",
  // CLI vault mapping + local auth/review artifacts
  ".passwd-sso-env.json", "sub/dir/.passwd-sso-env.json",
  "docs/review-credentials.local.md", "load-test/setup/.load-test-auth.json",
  // Terraform working dir / state / real tfvars
  "infra/terraform/.terraform/providers/x", "infra/terraform/terraform.tfstate",
  "infra/terraform/terraform.tfstate.backup",
  "infra/terraform/envs/prod/terraform.tfvars", "x/secrets.tfvars.json",
  // local databases
  "data.db", "sub/cache.sqlite",
];
// Must remain INCLUDED (committed, non-secret placeholders) — root and nested.
const mustInclude = [
  ".env.example",
  "extension/.env.example",
  "scripts/__tests__/fixtures/env-drift/positive/.env.example",
  "infra/terraform/terraform.tfvars.example",
  "infra/terraform/envs/dev/terraform.tfvars.example",
];

const leaked = mustExclude.filter((f) => !ignored(f));
const dropped = mustInclude.filter((f) => ignored(f));

if (leaked.length) {
  console.error("ERROR: .dockerignore does NOT exclude git-ignored secret/artifact(s): " + leaked.join(", "));
  console.error("Mirror .gitignore's secret/artifact entries into .dockerignore recursively (see the file's comments).");
  process.exit(1);
}
if (dropped.length) {
  console.error("ERROR: .dockerignore over-excludes committed placeholder(s): " + dropped.join(", "));
  process.exit(1);
}
console.log("OK (static: .dockerignore excludes git-ignored secrets/artifacts at any depth, keeps *.example placeholders)");
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
  # Any git-ignored secret / artifact at ANY depth is a leak: env files, keys/
  # certs, CLI vault mapping, Terraform state/tfvars/.terraform, local DBs.
  # Exclude node_modules (third-party packages legitimately ship such fixtures)
  # and the committed *.example placeholders.
  # A .terraform dir anywhere in the tree is itself a leak; report it and prune.
  # node_modules is pruned silently (legit third-party fixtures).
  found=$(find "$SCAN_ROOT" \
    -type d -name node_modules -prune -o \
    -type d -name .terraform -print -prune -o \
    -type f \( \
        -name ".env" -o -name ".env.*" \
        -o -name "*.pem" -o -name "*.key" -o -name "*.crt" -o -name "*.cert" \
        -o -name "*.p12" -o -name "*.pfx" \
        -o -name ".passwd-sso-env.json" \
        -o -name "*.tfstate" -o -name "*.tfstate.*" \
        -o -name "*.tfvars" -o -name "*.tfvars.json" \
        -o -name "*.db" -o -name "*.sqlite" \
      \) ! -name ".env.example" ! -name "*.tfvars.example" -print \
    2>/dev/null || true)
  if [ -n "$found" ]; then
    echo "ERROR: git-ignored secret/artifact(s) present in the built tree $SCAN_ROOT (shipped via build context / image):"
    echo "$found"
    echo "Fix .dockerignore (recursive exclusion of the .gitignore secret class) and rebuild."
    exit 1
  fi
  echo "OK (bundle: $SCAN_ROOT has no git-ignored secret/artifact at any depth)"
else
  echo "OK (bundle: no built tree at $SCAN_ROOT to scan — static gate applies)"
fi
