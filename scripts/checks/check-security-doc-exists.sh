#!/usr/bin/env bash
# CI check: assert that a fixed set of docs/security/*.md files exist, are
# non-empty, and contain all their required headings. One doc (the
# audit-anchor-verification doc) additionally requires a companion directory
# to exist.
#
# Data-driven: each doc is one {path, required-headings} tuple. bash-3.2
# compatible (no associative arrays) — tuples are parallel arrays indexed by
# position, following this repo's existing scripts/checks/*.sh idioms.
#
# Exit 0 = OK, Exit 1 = one or more checks failed.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# ── Doc registry (parallel arrays; index i in DOC_PATHS corresponds to the
#    heading list built from DOC_HEADINGS_<i> below) ────────────────────────
DOC_PATHS=(
  "docs/security/audit-anchor-verification.md"
  "docs/security/tenant-boundary-matrix.md"
  "docs/security/auth-surface-matrix.md"
  "docs/security/audit-chain-threat-model.md"
)

DOC_HEADINGS_0=(
  "## Overview"
  "## What you need to verify"
  "## Quick check via openssl"
  "## Full verification via CLI"
  "## v1 trust-zone caveat"
  "## Pause-window protection boundary"
)
DOC_HEADINGS_1=(
  "## RLS-enabled tables"
  "## Bypass surface"
  "## Worker roles and grants"
  "## Tenant-context GUC mechanism"
)
DOC_HEADINGS_2=(
  "## Auth surface grid"
  "## Token type matrix"
)
DOC_HEADINGS_3=(
  "## Chain construction"
  "## Attack tree"
  "## Retention-purge interaction"
  "## Residual risks"
)

# Per-doc optional-heading exemption: "## Overview" is an optional alias for
# the intro section on the audit-anchor-verification doc only (doc index 0).
# Every other doc/heading pair is a hard requirement.
is_optional_heading() {
  local doc_index="$1"
  local heading="$2"
  [ "$doc_index" = "0" ] && [ "$heading" = "## Overview" ]
}

fail=0

check_doc() {
  local doc_index="$1"
  local doc_rel="$2"
  shift 2
  local headings=("$@")
  local doc_path="$REPO_ROOT/$doc_rel"

  # ── File exists and is non-empty ──────────────────────────────────────────
  if [ ! -f "$doc_path" ]; then
    echo "FAIL: $doc_rel does not exist" >&2
    fail=1
    return
  elif [ ! -s "$doc_path" ]; then
    echo "FAIL: $doc_rel is empty" >&2
    fail=1
    return
  else
    echo "OK: $doc_rel exists and is non-empty"
  fi

  # ── Required headings ─────────────────────────────────────────────────────
  local heading
  for heading in "${headings[@]}"; do
    if grep -qF "$heading" "$doc_path"; then
      echo "OK: heading present: $doc_rel :: $heading"
    else
      if is_optional_heading "$doc_index" "$heading"; then
        echo "WARN: optional heading not found (non-fatal): $doc_rel :: $heading"
      else
        echo "FAIL: required heading not found: $doc_rel :: $heading" >&2
        fail=1
      fi
    fi
  done
}

check_doc 0 "${DOC_PATHS[0]}" "${DOC_HEADINGS_0[@]}"
check_doc 1 "${DOC_PATHS[1]}" "${DOC_HEADINGS_1[@]}"
check_doc 2 "${DOC_PATHS[2]}" "${DOC_HEADINGS_2[@]}"
check_doc 3 "${DOC_PATHS[3]}" "${DOC_HEADINGS_3[@]}"

# ── Per-doc special case: audit-anchor-verification's public-key archive
#    directory placeholder. Kept as a doc-specific check rather than a
#    generalized tuple field, since it's the only doc with this requirement.
PUBKEY_DIR="$REPO_ROOT/docs/security/audit-anchor-public-keys"
if [ -d "$PUBKEY_DIR" ]; then
  echo "OK: docs/security/audit-anchor-public-keys/ directory exists"
else
  echo "FAIL: docs/security/audit-anchor-public-keys/ directory not found" >&2
  fail=1
fi

# ── Result ──────────────────────────────────────────────────────────────────
if [ "$fail" -ne 0 ]; then
  echo "" >&2
  echo "check-security-doc-exists: FAILED. See errors above." >&2
  exit 1
fi

echo ""
echo "check-security-doc-exists: all checks passed."
