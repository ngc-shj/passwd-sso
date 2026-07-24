#!/usr/bin/env bash
# R32 boot smoke test for the esbuild-bundled worker artifacts.
#
# Production runs the workers as esbuild CJS bundles (`node dist/<worker>.js`),
# NOT via tsx. esbuild's default CommonJS output replaces `import.meta.url` with
# `undefined`, which previously made `createRequire(import.meta.url)` in
# src/lib/blob-store/runtime-module.ts throw ERR_INVALID_ARG_VALUE at module
# load — crashing the retention-gc worker on boot. The existing
# --validate-env-only unit tests run the tsx SOURCE (ESM, import.meta.url
# defined) and never exercised the shipped bundle, so the crash shipped green.
#
# This check bundles each worker with the EXACT esbuild command extracted from
# the Dockerfile (so it can never drift from what is actually shipped), then
# boots the bundle with --validate-env-only. That flag exits 0 after module
# load + env parse but before any DB connection — exercising the createRequire
# code path without external services. A non-zero exit means the shipped
# artifact does not boot.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/../.." && pwd))"
cd "$REPO_ROOT"

DOCKERFILE="Dockerfile"
echo "check-worker-bundle-smoke: REPO_ROOT=$REPO_ROOT"

[ -f "$DOCKERFILE" ] || { echo "OK ($DOCKERFILE not present)"; exit 0; }

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Extract every `npx esbuild scripts/<name>-worker.ts ... --outfile=dist/<name>.js`
# invocation from the Dockerfile, joining its backslash-continued lines into one.
# Using the Dockerfile as the source of truth means a change to the bundle format
# (e.g. adding --format=esm) is re-smoke-tested automatically.
mapfile -t ESBUILD_CMDS < <(
  awk '
    /npx esbuild scripts\/.*-worker\.ts/ { collecting=1; line="" }
    collecting {
      cont = ($0 ~ /\\[[:space:]]*$/)   # detect continuation BEFORE stripping
      stripped = $0
      sub(/\\[[:space:]]*$/, "", stripped)
      line = line " " stripped
      if (!cont) { print line; collecting=0 }
    }
  ' "$DOCKERFILE"
)

if [ "${#ESBUILD_CMDS[@]}" -eq 0 ]; then
  echo "ERROR: no 'npx esbuild scripts/*-worker.ts' invocations found in $DOCKERFILE"
  echo "This gate expects the worker bundles to be built by esbuild — re-verify the Dockerfile."
  exit 1
fi

# A worker bundle passes smoke when booting it with --validate-env-only exits 0.
# Each worker accepts a dedicated *_DATABASE_URL or falls back to DATABASE_URL;
# supply a syntactically-valid URL so the at-least-one-URL refine passes without
# opening a connection.
FAKE_DB_URL="postgresql://app:app@127.0.0.1:5432/passwd_sso"

fail=0
for raw in "${ESBUILD_CMDS[@]}"; do
  # Normalise whitespace and strip the leading `npx ` so we invoke the repo-local
  # esbuild binary directly (hermetic — no network fetch of a floating esbuild).
  cmd="$(echo "$raw" | tr -s ' ')"
  src="$(echo "$cmd" | grep -oE 'scripts/[a-zA-Z0-9_-]+-worker\.ts' | head -1)"
  outfile="$(echo "$cmd" | grep -oE 'dist/[a-zA-Z0-9_-]+\.js' | head -1)"
  if [ -z "$src" ] || [ -z "$outfile" ]; then
    echo "ERROR: could not parse src/outfile from esbuild line: $cmd"
    exit 1
  fi

  bundle="$TMP_DIR/$(basename "$outfile")"
  # Rebuild the esbuild argument list from the Dockerfile line, redirecting the
  # output into the temp dir. Drop the leading `npx` / `esbuild` tokens.
  args="$(echo "$cmd" | sed -E 's#^ *(RUN +)?npx +esbuild +##; s#--outfile=dist/[a-zA-Z0-9_-]+\.js#--outfile='"$bundle"'#')"

  # Test-only hook (RT7 red-proof): the self-test sets
  # WORKER_BUNDLE_SMOKE_ALIAS_OVERRIDE=<module>=<path> to alias a module into the
  # bundle — e.g. swap in a runtime-module that crashes on load — so the gate's
  # ability to go RED is verified in CI. Unset in production (never affects the
  # real bundle). Only a single --alias:<from>=<to> is appended.
  extra_alias=""
  if [ -n "${WORKER_BUNDLE_SMOKE_ALIAS_OVERRIDE:-}" ]; then
    extra_alias="--alias:${WORKER_BUNDLE_SMOKE_ALIAS_OVERRIDE}"
  fi

  echo "  bundling $src -> $(basename "$bundle")"
  # shellcheck disable=SC2086
  node_modules/.bin/esbuild $args $extra_alias >/dev/null

  # Boot the bundle with NODE_PATH pointed at the repo node_modules so the
  # `--external` packages (pg, @prisma/client, @prisma/adapter-pg) resolve —
  # Node resolves a bundle's requires relative to the bundle file's own dir, and
  # the temp dir has no node_modules. In the production image these packages are
  # COPYed alongside the bundle; NODE_PATH reproduces that reachability here.
  echo "  booting $(basename "$bundle") --validate-env-only"
  set +e
  out="$(timeout 30 env \
    NODE_ENV=production \
    NODE_PATH="$REPO_ROOT/node_modules" \
    RETENTION_GC_DATABASE_URL="$FAKE_DB_URL" \
    OUTBOX_WORKER_DATABASE_URL="$FAKE_DB_URL" \
    DATABASE_URL="$FAKE_DB_URL" \
    node "$bundle" --validate-env-only 2>&1)"
  status=$?
  set -e

  if [ "$status" -ne 0 ]; then
    echo "ERROR: $(basename "$bundle") failed --validate-env-only boot (exit $status)"
    echo "$out" | sed 's/^/    /'
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "FAIL: one or more worker bundles do not boot as shipped (R32)."
  exit 1
fi

echo "OK (all worker bundles boot with --validate-env-only)"
