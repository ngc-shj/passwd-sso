#!/usr/bin/env bash
# rls-verify-run.sh — wrapper around a psql invocation of
# scripts/rls-cross-tenant-verify.sql that asserts the WARNING set each
# RLS-MARKER-delimited region of the SQL promises.
#
# #911 put every policy's bypass branch behind
# `(SELECT public.rls_bypass_admits('<table>'))`, which RAISE WARNINGs (and,
# in report mode, still admits) a read of a table the session's
# app.bypass_tables grant does not name. Two regions of
# rls-cross-tenant-verify.sql make claims about that WARNING that only the
# psql client side can check (a DO block cannot read back its own RAISE
# WARNING text):
#   - Block 4 (RLS-MARKER:block=4-start .. block=4-end): every table is
#     granted, so this region must raise none.
#   - Block 4b (RLS-MARKER:block=report table=<t>, .. block=report-end):
#     each marker withholds exactly one table's grant, so the region between
#     it and the next marker must raise rls_bypass_not_granted for that one
#     table and no other.
# A gate whose assertion lives only in bash output-matching (not the SQL
# itself) is otherwise invisible to someone reading the .sql file in
# isolation — this file is that other half, kept separate because psql
# cannot inspect its own stderr stream.
#
# Two usage modes:
#
#  1. Standalone (ci.yml, pre-pr.sh): `rls-verify-run.sh -- <command...>`
#     runs <command>, merges its stdout+stderr (matching the `2>&1` capture
#     every existing caller already used), prints the merged output, and
#     exits non-zero if <command> failed OR a WARNING-set mismatch was
#     found. Use this to wrap the psql invocation itself, e.g.:
#       scripts/rls-verify-run.sh -- psql -v ON_ERROR_STOP=1 "$URL" \
#         -v expected_tables="$EXPECTED_TABLES" -f scripts/rls-cross-tenant-verify.sql
#
#  2. Sourced (rls-cross-tenant-negative-test.sh): source this file and call
#     `rls_verify_check "$captured_output"` against output the caller already
#     captured through its own connection helper (psql_safe). Returns the
#     mismatch text on stdout (empty string = no mismatch). Most negative-test
#     cases mutate rls_negative_test to fail in Block 1-4, well before any
#     RLS-MARKER line is ever emitted — rls_verify_check is a no-op on such
#     output (no markers found), so it does not interfere with those cases'
#     existing per-code assertions.

rls_verify_check() {
  local combined="$1"
  local mismatch=""

  if grep -q 'RLS-MARKER:block=4-start' <<<"$combined"; then
    local region
    region=$(sed -n '/RLS-MARKER:block=4-start/,/RLS-MARKER:block=4-end/p' <<<"$combined")
    if grep -q 'rls_bypass_not_granted' <<<"$region"; then
      mismatch+=$'\n'"Block 4 (full grant): expected no rls_bypass_not_granted WARNING, got:"$'\n'"$(grep 'rls_bypass_not_granted' <<<"$region")"
    fi
  fi

  if grep -q 'RLS-MARKER:block=report table=' <<<"$combined"; then
    local tables t
    tables=$(grep -oE 'RLS-MARKER:block=report table=[a-z_0-9]+' <<<"$combined" | sed -E 's/.*table=//')
    while IFS= read -r t; do
      [[ -z "$t" ]] && continue
      local region got
      region=$(awk -v marker="RLS-MARKER:block=report table=$t" '
        index($0, marker) { flag=1; next }
        /RLS-MARKER:block=report / { if (flag) exit }
        /RLS-MARKER:block=report-end/ { if (flag) exit }
        flag
      ' <<<"$combined")
      got=$(grep -oE 'rls_bypass_not_granted table=[a-z_0-9]+' <<<"$region" \
        | sed -E 's/.*table=//' | sort -u | paste -sd, -)
      if [[ "$got" != "$t" ]]; then
        mismatch+=$'\n'"report block (left out '$t'): expected WARNING set {$t}, got {${got:-none}}"
      fi
    done <<<"$tables"
  fi

  printf '%s' "$mismatch"
}

# Standalone mode only when executed directly, not when sourced.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  set -uo pipefail

  if [[ "${1:-}" == "--" ]]; then
    shift
  fi
  if [[ $# -lt 1 ]]; then
    echo "usage: rls-verify-run.sh -- <command...>" >&2
    exit 2
  fi

  out=$("$@" 2>&1)
  ec=$?

  printf '%s\n' "$out"

  mismatch=$(rls_verify_check "$out")
  if [[ -n "$mismatch" ]]; then
    printf '\nrls-verify-run.sh: WARNING-set mismatch:%s\n' "$mismatch" >&2
    exit 1
  fi

  exit "$ec"
fi
