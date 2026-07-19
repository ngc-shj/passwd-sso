#!/usr/bin/env bash
# AC4.3 — CI gate: every route file containing `failClosedOnRedisError: true`
# MUST be covered by exactly one of three modes:
#
#   helper mode  — sibling test imports the shared contract helper
#                  (@/__tests__/helpers/fail-closed) AND calls
#                  `assertRedisFailClosed(` AND does NOT stub the production
#                  `checkRateLimitOrFail` mapping. This is the target state.
#   legacy mode  — route listed in fail-closed-legacy-direct.txt: a direct
#                  (pre-helper) test asserts the 503 behavior; the sibling
#                  test must still reference `redisErrored` in CODE.
#                  Migration to helper mode removes the entry (atomic).
#   debt mode    — route listed in fail-closed-test-debt.txt: no adequate
#                  test yet; tracked for a future tranche.
#
# Test classification is AST-BASED (scripts/checks/classify-fail-closed-test.mjs,
# ts-morph): comments, describe labels, and string literals never satisfy any
# criterion. History: the original pass criterion was a bare
# `grep -q "redisErrored"`; the PR #680 external review demonstrated it was
# false-green-able (comment / label / mapping-stubbed test — extension/
# bridge-code was already misclassified), and the first fix's tightened greps
# were still text-based. Text matching remains ONLY where its failure mode is
# fail-LOUD, not fail-green: route enumeration and the AC4.4/AC4.5 literal
# counts (a stray literal there breaks the count and fails CI visibly).
#
# Anti-drift rules (each is a distinct failure token, self-tested):
#   MAPPING_MOCKED_CONTRACT_TEST — helper call present but the test stubs
#     @/lib/security/rate-limit-audit / checkRateLimitOrFail (RT5 violation).
#   STALE_DEBT_ENTRY   — helper-mode test exists but the debt entry remains.
#   STALE_LEGACY_ENTRY — helper-mode test exists but the legacy entry remains.
#   LEGACY_DEBT_CONFLICT — route listed in BOTH legacy and debt files.
#   LEGACY_TEST_MISSING — legacy entry whose sibling test lost the
#     code-level redisErrored reference.
#   DANGLING_ENTRY — debt/legacy entry whose route no longer opts in
#     (flag removal must be a visible manifest diff, parent-plan M2).
#   CLASSIFIER_FAILURE — the AST classifier itself failed; the gate fails
#     closed rather than falling back to any text match.
#   MISSING_FAIL_CLOSED_TEST — no mode covers the route.
#
# Path-derivation rule (adjacent route.test.ts):
#   route_path: src/app/api/<X>/route.ts
#   test_path:  src/app/api/<X>/route.test.ts
# Alternative test path (legacy / __tests__ tree):
#   src/__tests__/api/<X>.test.ts

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
# FIXTURE_ROOT is a SINGLE override covering ALL inputs (route-scan root,
# debt file, legacy file) so the self-test can never mix fixture routes with
# the real repo's manifests or vice versa (test-F10, multi-input gate).
FIXTURE_ROOT="${FAIL_CLOSED_TEST_ROOT:-$REPO_ROOT}"
DEBT_FILE="${FAIL_CLOSED_TEST_DEBT_FILE:-$FIXTURE_ROOT/scripts/checks/fail-closed-test-debt.txt}"
LEGACY_FILE="${FAIL_CLOSED_TEST_LEGACY_FILE:-$FIXTURE_ROOT/scripts/checks/fail-closed-legacy-direct.txt}"
MANIFEST_FILE="${FAIL_CLOSED_TEST_MANIFEST_FILE:-$FIXTURE_ROOT/scripts/checks/fail-closed-manifest.txt}"
CLASSIFIER="$REPO_ROOT/scripts/checks/classify-fail-closed-test.mjs"

# Ratchet constants (C3/C5) — fixture-overridable so red fixtures (a 1-entry
# debt/17-entry legacy list vs the real-repo expectation) are executable
# without mutating the real manifests. Real-repo defaults: debt burns down to
# 0 (C3); legacy holds exactly 16 (13 routes + 3 lib members, C8d).
EXPECTED_DEBT_COUNT="${FAIL_CLOSED_EXPECTED_DEBT_COUNT:-0}"
EXPECTED_LEGACY_COUNT="${FAIL_CLOSED_EXPECTED_LEGACY_COUNT:-13}"

# CI-auditable: print effective scan paths on one line.
echo "check-fail-closed-routes-have-test: FIXTURE_ROOT=$FIXTURE_ROOT DEBT_FILE=$DEBT_FILE LEGACY_FILE=$LEGACY_FILE MANIFEST_FILE=$MANIFEST_FILE EXPECTED_DEBT_COUNT=$EXPECTED_DEBT_COUNT EXPECTED_LEGACY_COUNT=$EXPECTED_LEGACY_COUNT"

# sec-F6: env-pollution guard. Any override + CI=true requires an explicit
# fixture-mode acknowledgement, so a stray `export` leaking into a real CI
# run cannot silently point the gate at an empty fixture dir and green it.
if [ "${CI:-}" = "true" ]; then
  if [ -n "${FAIL_CLOSED_TEST_ROOT:-}" ] || [ -n "${FAIL_CLOSED_TEST_DEBT_FILE:-}" ] || [ -n "${FAIL_CLOSED_TEST_LEGACY_FILE:-}" ] || [ -n "${FAIL_CLOSED_TEST_MANIFEST_FILE:-}" ] || [ -n "${FAIL_CLOSED_EXPECTED_DEBT_COUNT:-}" ] || [ -n "${FAIL_CLOSED_EXPECTED_LEGACY_COUNT:-}" ]; then
    if [ "${FAIL_CLOSED_TEST_FIXTURE_MODE:-}" != "1" ]; then
      echo "ENV_POLLUTION_GUARD: FAIL_CLOSED_TEST_* / FAIL_CLOSED_EXPECTED_* override set under CI=true without FAIL_CLOSED_TEST_FIXTURE_MODE=1 — refusing to run against a possibly-unintended path."
      exit 1
    fi
  fi
fi

# Read a manifest file into a newline-delimited list (paths only, no
# comments, no blanks). bash 3.2 has no associative arrays; membership is
# tested with `grep -qxF`.
read_manifest() {
  local file="$1" out="" line
  if [ -f "$file" ]; then
    while IFS= read -r line; do
      line="${line%$'\r'}"
      line="${line## }"; line="${line%% }"
      [ -z "$line" ] && continue
      case "$line" in \#*) continue ;; esac
      out="${out}${line}
"
    done < "$file"
  fi
  printf '%s' "$out"
}

DEBT_LIST="$(read_manifest "$DEBT_FILE")"
LEGACY_LIST="$(read_manifest "$LEGACY_FILE")"

# NOTE: membership/lookup helpers use herestrings, NOT `printf | grep -q`
# pipelines — `grep -q` closes the pipe on first match, and under load
# (parallel vitest workers) printf then dies with SIGPIPE (141), which
# `set -o pipefail` turns into a spurious gate failure. No pipe, no race.
is_debt()   { grep -qxF "$1" <<<"$DEBT_LIST"; }
is_legacy() { grep -qxF "$1" <<<"$LEGACY_LIST"; }

# manifest_count <list> — number of non-empty entries in a read_manifest
# output string. Herestring, not a pipe (same SIGPIPE rationale as above).
manifest_count() {
  local list="$1"
  if [ -z "$list" ]; then
    echo 0
  else
    grep -c . <<<"$list"
  fi
}

# Enumerate opt-in routes. bash 3.2 has no `mapfile`.
fail=0
routes=()
while IFS= read -r route_line; do
  [ -n "$route_line" ] && routes+=("$route_line")
done < <(
  grep -rln 'failClosedOnRedisError: true' "$FIXTURE_ROOT/src/app/api" 2>/dev/null \
    | sed "s|^$FIXTURE_ROOT/||" \
    | sort
)

ROUTE_LIST=""
candidate_tests=()
for route in ${routes[@]+"${routes[@]}"}; do
  ROUTE_LIST="${ROUTE_LIST}${route}
"
  dir="$(dirname "$route")"
  rel_path="${route#src/app/api/}"
  rel_no_route="${rel_path%/route.ts}"
  candidate_tests+=("$FIXTURE_ROOT/$dir/route.test.ts")
  candidate_tests+=("$FIXTURE_ROOT/src/__tests__/api/${rel_no_route}.test.ts")
done

# Batch-classify every candidate sibling test with the AST classifier.
# A classifier failure fails the gate (never fall back to text matching).
CLASSIFY_OUT=""
if [ "${#candidate_tests[@]}" -gt 0 ]; then
  if ! CLASSIFY_OUT="$(node "$CLASSIFIER" ${candidate_tests[@]+"${candidate_tests[@]}"})"; then
    echo "CLASSIFIER_FAILURE: scripts/checks/classify-fail-closed-test.mjs failed — gate fails closed (no text fallback)."
    exit 1
  fi
fi

# lookup <abs-path> → record string ("exists=1 import=1 calls=2 mock=0 redis=1")
lookup() {
  awk -F'\t' -v p="$1" '$1 == p { print $2; exit }' <<<"$CLASSIFY_OUT"
}
# field <record> <key> → value (empty when record/key absent)
field() {
  awk -v k="$2" '{ for (i = 1; i <= NF; i++) { split($i, a, "="); if (a[1] == k) { print a[2]; exit } } }' <<<"$1"
}

# manifest_declared_count <repo-rel-path> → the limiter count declared for that
# path in the manifest (empty when the path is absent). Used to require a
# helper-mode member's contract test to cover EVERY limiter in a multi-limiter
# file, not just one — a single assertRedisFailClosed call in a count=2 file
# leaves the second limiter's fail-closed path untested (external review
# 2026-07-19, round 2).
manifest_declared_count() {
  [ -f "$MANIFEST_FILE" ] || return 0
  awk -F'\t' -v p="$1" '$1 == p { print $2; exit }' "$MANIFEST_FILE"
}

# assert_covers_all_limiters <route> <test-rel> <distinct> — fail when a
# helper-mode file asserts fewer DISTINCT limiters than its declared limiter
# count. `distinct` counts distinct `limiter:` argument symbols across the
# helper calls, so testing the SAME limiter twice does NOT satisfy a
# 2-limiter file (external review 2026-07-19, round 3). Sets `fail=1` and
# echoes HELPER_CALLS_BELOW_LIMITER_COUNT; returns 1 so the caller can
# `continue`. A missing/blank manifest count is treated as 1.
assert_covers_all_limiters() {
  local route="$1" test_rel="$2" distinct="$3" declared
  declared="$(manifest_declared_count "$route")"
  [ -n "$declared" ] || declared=1
  if [ "$distinct" -lt "$declared" ] 2>/dev/null; then
    echo "HELPER_CALLS_BELOW_LIMITER_COUNT: $route (manifest declares $declared fail-closed limiter(s) but ${test_rel} asserts only $distinct distinct limiter(s) — every limiter needs its own contract assertion; testing one limiter N times does not count)"
    fail=1
    return 1
  fi
  return 0
}

for route in ${routes[@]+"${routes[@]}"}; do
  dir="$(dirname "$route")"
  adjacent_test="$FIXTURE_ROOT/$dir/route.test.ts"
  rel_path="${route#src/app/api/}"        # X/route.ts
  rel_no_route="${rel_path%/route.ts}"    # X
  alt_test="$FIXTURE_ROOT/src/__tests__/api/${rel_no_route}.test.ts"

  rec_adj="$(lookup "$adjacent_test")"
  rec_alt="$(lookup "$alt_test")"

  # Pick the sibling test that carries real helper calls, if any.
  contract_test=""
  contract_rec=""
  if [ "$(field "$rec_adj" calls)" != "" ] && [ "$(field "$rec_adj" calls)" -gt 0 ] 2>/dev/null; then
    contract_test="$adjacent_test"; contract_rec="$rec_adj"
  elif [ "$(field "$rec_alt" calls)" != "" ] && [ "$(field "$rec_alt" calls)" -gt 0 ] 2>/dev/null; then
    contract_test="$alt_test"; contract_rec="$rec_alt"
  fi

  if [ -n "$contract_test" ]; then
    # helper mode candidate — reject the RT5 stub anti-pattern outright.
    if [ "$(field "$contract_rec" mock)" = "1" ]; then
      echo "MAPPING_MOCKED_CONTRACT_TEST: $route (${contract_test#$FIXTURE_ROOT/} calls assertRedisFailClosed but stubs the production checkRateLimitOrFail mapping)"
      fail=1
      continue
    fi
    if [ "$(field "$contract_rec" import)" != "1" ]; then
      echo "MISSING_FAIL_CLOSED_TEST: $route (assertRedisFailClosed is called in ${contract_test#$FIXTURE_ROOT/} without importing it from @/__tests__/helpers/fail-closed — a local re-implementation does not count)"
      fail=1
      continue
    fi
    # Direct-result tier: the limiter argument must be the production singleton,
    # not a locally-built fake returning a fixed result.
    if [ "$(field "$contract_rec" resultfake)" = "1" ]; then
      echo "RESULT_HELPER_FAKE_LIMITER: $route (${contract_test#$FIXTURE_ROOT/} passes a locally-constructed fake to assertRedisFailClosedResult — it must probe the real limiter module, not a fixed-result object)"
      fail=1
      continue
    fi
    # Every declared limiter in the file must have its own contract assertion
    # (distinct limiter args, not just call count).
    if ! assert_covers_all_limiters "$route" "${contract_test#$FIXTURE_ROOT/}" "$(field "$contract_rec" distinct)"; then
      continue
    fi
    # Genuine helper-mode contract test: manifests must not linger.
    if is_debt "$route"; then
      echo "STALE_DEBT_ENTRY: $route (has a shared-helper contract test — remove its fail-closed-test-debt.txt entry in the same PR)"
      fail=1
      continue
    fi
    if is_legacy "$route"; then
      echo "STALE_LEGACY_ENTRY: $route (migrated to the shared-helper contract — remove its fail-closed-legacy-direct.txt entry in the same PR)"
      fail=1
      continue
    fi
    continue
  fi

  if is_legacy "$route"; then
    if is_debt "$route"; then
      echo "LEGACY_DEBT_CONFLICT: $route (listed in BOTH fail-closed-legacy-direct.txt and fail-closed-test-debt.txt — pick one)"
      fail=1
      continue
    fi
    if [ "$(field "$rec_adj" redis)" = "1" ] || [ "$(field "$rec_alt" redis)" = "1" ]; then
      continue # documented legacy-direct coverage (code-level reference)
    fi
    echo "LEGACY_TEST_MISSING: $route (listed in fail-closed-legacy-direct.txt but no sibling test references redisErrored in code)"
    fail=1
    continue
  fi

  if is_debt "$route"; then
    continue # documented debt — a redisErrored reference alone does NOT flip
             # a debt route to "tested" (that requires the shared-helper
             # contract; see extension/bridge-code false-green, PR #680 review).
  fi

  echo "MISSING_FAIL_CLOSED_TEST: $route (expected: assertRedisFailClosed contract in ${adjacent_test#$FIXTURE_ROOT/} or ${alt_test#$FIXTURE_ROOT/}, OR a fail-closed-legacy-direct.txt / fail-closed-test-debt.txt entry)"
  fail=1
done

# Whole-src enumeration primitive (Round 1 M8). Built here (before the
# dangling check) because debt/legacy manifests may list non-src/app/api
# members (the 3 lib fail-closed limiters registered in tranche 2); the
# api-only ROUTE_LIST would wrongly flag those as dangling. ENUM_LIST is the
# class-defining set across all of src, so it is the correct opt-in oracle
# for both the dangling check and the C5 manifest set-equality below.
ENUM_LIST=""
while IFS= read -r enum_line; do
  [ -n "$enum_line" ] && ENUM_LIST="${ENUM_LIST}${enum_line#$FIXTURE_ROOT/}
"
done < <(
  grep -rln 'failClosedOnRedisError: true' "$FIXTURE_ROOT/src" --include='*.ts' --include='*.tsx' 2>/dev/null \
    | grep -Ev '\.test\.tsx?$' \
    | grep -v '/src/__tests__/' \
    | sort
)

# ── Non-route member coverage (external-review Major, 2026-07-19) ──────────
# The route loop above enumerates ONLY src/app/api, so the non-route members
# of the fail-closed class (lib limiters + auth.config) never had their
# sibling test classified — the manifest pinned their opt-in flag but nothing
# verified a live fail-closed test still exists. Deleting/weakening such a
# test left the gate green (test-drift false-green). This block closes that
# gap: every ENUM_LIST member outside src/app/api is classified through the
# SAME helper/legacy/debt modes as a route, using an explicit member→test
# map (the set is small, frozen, and pinned by EXPECTED_LEGACY_COUNT; the
# contract test is not always adjacent — SCIM's lives in with-scim-auth).
#
# Map format: "<member-path>|<test-path>" per line. A member enumerated here
# but absent from the map fails NON_ROUTE_COVERAGE_UNMAPPED (a new non-route
# opt-in must declare where its fail-closed test lives — no silent bypass).
NON_ROUTE_TEST_MAP="src/auth.config.ts|src/auth.config.test.ts
src/lib/scim/rate-limit.ts|src/lib/scim/with-scim-auth.test.ts
src/lib/security/rate-limiters.ts|src/lib/security/rate-limiters.test.ts"

non_route_test_for() {
  # Echo the mapped test path for member $1, or empty if unmapped.
  awk -F'|' -v m="$1" '$1 == m { print $2; exit }' <<<"$NON_ROUTE_TEST_MAP"
}

while IFS= read -r member; do
  [ -z "$member" ] && continue
  case "$member" in src/app/api/*) continue ;; esac  # routes handled above

  member_test="$(non_route_test_for "$member")"
  if [ -z "$member_test" ]; then
    echo "NON_ROUTE_COVERAGE_UNMAPPED: $member (opts into failClosedOnRedisError: true outside src/app/api but declares no fail-closed test in the gate's non-route map — add a <member>|<test> entry so its coverage is verified)"
    fail=1
    continue
  fi

  member_rec="$(node "$CLASSIFIER" "$FIXTURE_ROOT/$member_test" 2>/dev/null | awk -F'\t' 'NR==1{print $2}')"
  if [ -z "$member_rec" ]; then
    echo "CLASSIFIER_FAILURE: classifying $member_test for non-route member $member failed — gate fails closed."
    exit 1
  fi

  # Helper mode: a real fail-closed contract call (assertRedisFailClosed /
  # ...SilentDrop / ...Result — the classifier counts all three tiers as
  # `calls`), imported, with the production mapping NOT stubbed. Symmetric
  # with the route loop: a helper-migrated member must not linger in the
  # debt/legacy manifests (STALE_* forces atomic removal in the same PR).
  if [ "$(field "$member_rec" calls)" != "" ] && [ "$(field "$member_rec" calls)" -gt 0 ] 2>/dev/null; then
    if [ "$(field "$member_rec" mock)" = "1" ]; then
      echo "MAPPING_MOCKED_CONTRACT_TEST: $member (${member_test} calls the fail-closed helper but stubs the production checkRateLimitOrFail mapping)"
      fail=1
      continue
    fi
    if [ "$(field "$member_rec" resultfake)" = "1" ]; then
      echo "RESULT_HELPER_FAKE_LIMITER: $member (${member_test} passes a locally-constructed fake to assertRedisFailClosedResult — it must probe the real limiter module, not a fixed-result object)"
      fail=1
      continue
    fi
    if ! assert_covers_all_limiters "$member" "$member_test" "$(field "$member_rec" distinct)"; then
      continue
    fi
    if is_debt "$member"; then
      echo "STALE_DEBT_ENTRY: $member (has a shared-helper fail-closed contract test — remove its fail-closed-test-debt.txt entry in the same PR)"
      fail=1
      continue
    fi
    if is_legacy "$member"; then
      echo "STALE_LEGACY_ENTRY: $member (migrated to a shared-helper fail-closed contract — remove its fail-closed-legacy-direct.txt entry in the same PR)"
      fail=1
      continue
    fi
    continue
  fi

  # Legacy mode: the member is in the legacy manifest and its mapped test
  # carries a code-level redisErrored reference. Absence of either → drift.
  if is_legacy "$member"; then
    if [ "$(field "$member_rec" redis)" = "1" ]; then
      continue
    fi
    echo "LEGACY_TEST_MISSING: $member (fail-closed-legacy-direct.txt lists it but ${member_test} no longer references redisErrored in code — fail-closed test drift)"
    fail=1
    continue
  fi

  # Not helper-covered and not legacy-registered: a non-route opt-in with no
  # recognized coverage mode.
  echo "MISSING_FAIL_CLOSED_TEST: $member (non-route opt-in with no shared-helper contract in ${member_test} and no fail-closed-legacy-direct.txt entry)"
  fail=1
done <<EOF
$ENUM_LIST
EOF

# DANGLING_ENTRY — manifest entries whose file no longer opts into
# fail-closed (or no longer exists). Forces flag removal to be a visible,
# reviewable manifest diff (parent-plan M2 blind spot). Validated against the
# whole-src ENUM_LIST so a legitimately-opted-in lib member is not flagged.
check_dangling() {
  local list="$1" name="$2" entry
  while IFS= read -r entry; do
    [ -z "$entry" ] && continue
    if ! grep -qxF "$entry" <<<"$ENUM_LIST"; then
      echo "DANGLING_ENTRY: $entry ($name lists it but the file no longer contains failClosedOnRedisError: true — remove the entry, or restore the opt-in)"
      fail=1
    fi
  done <<EOF
$list
EOF
}
check_dangling "$DEBT_LIST" "fail-closed-test-debt.txt"
check_dangling "$LEGACY_LIST" "fail-closed-legacy-direct.txt"

# C3/C5 re-entry ratchets — exact equality, both growth AND shrink require
# editing the constant in the same diff (a future debt/legacy entry, or a
# migration removing one, is always a reviewable script diff). Per the
# fixture-executability rules (Round 2 F-R2-1/S2-6) these run in fixture mode
# too — only the repo-wide AC4.4/AC4.5/manifest-sum aggregates below skip
# under FIXTURE_ROOT overrides.
debt_count="$(manifest_count "$DEBT_LIST")"
if [ "$debt_count" -ne "$EXPECTED_DEBT_COUNT" ]; then
  echo "EXPECTED_DEBT_COUNT FAIL: expected $EXPECTED_DEBT_COUNT debt entries in ${DEBT_FILE#$FIXTURE_ROOT/}; found $debt_count"
  fail=1
fi
legacy_count="$(manifest_count "$LEGACY_LIST")"
if [ "$legacy_count" -ne "$EXPECTED_LEGACY_COUNT" ]; then
  echo "EXPECTED_LEGACY_COUNT FAIL: expected $EXPECTED_LEGACY_COUNT legacy entries in ${LEGACY_FILE#$FIXTURE_ROOT/}; found $legacy_count"
  fail=1
fi

# ---------------------------------------------------------------------------
# C5 — class manifest pinning + whole-src enumeration.
#
# Whole-src enumeration (Round 1 M8): every file under src (any lane) that
# opts into `failClosedOnRedisError: true`, excluding test files and the
# src/__tests__ support tree (helper/ast-guard comments discuss the literal
# without being class members — accepted residual, Round 2 S2-7).
# ---------------------------------------------------------------------------
# Emits `<file>\t<count>` per argument path — batchable so the manifest's ~65
# per-file AST counts cost ONE node startup (+ ts-morph load) instead of ~65,
# which was ~13s of the gate's runtime (CI timeout, external review round 7
# follow-up). A missing/unreadable file yields count 0.
AST_COUNT_SCRIPT='
import { readFileSync } from "node:fs";
import { Project, SyntaxKind, Node } from "ts-morph";
const project = new Project({ useInMemoryFileSystem: true, skipFileDependencyResolution: true });
for (const file of process.argv.slice(1)) {
  let text;
  try { text = readFileSync(file, "utf8"); } catch { process.stdout.write(file + "\t0\n"); continue; }
  const sf = project.createSourceFile("/virtual/x.ts", text, { overwrite: true });
  let count = 0;
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    const name = Node.isPropertyAccessExpression(expr) ? expr.getName() : expr.getText();
    if (name !== "createRateLimiter") continue;
    const arg0 = call.getArguments()[0];
    if (!arg0 || !Node.isObjectLiteralExpression(arg0)) continue;
    const prop = arg0.getProperty("failClosedOnRedisError");
    if (!prop || !Node.isPropertyAssignment(prop)) continue;
    const init = prop.getInitializer();
    if (init && init.getKind() === SyntaxKind.TrueKeyword) count++;
  }
  sf.forget();
  process.stdout.write(file + "\t" + count + "\n");
}
'
# Batch-compute AST counts for many files at once → newline table of
# "<abs-path>\t<count>". Empty input yields empty output.
ast_count_batch() {
  [ "$#" -gt 0 ] || return 0
  (cd "$REPO_ROOT" && node --input-type=module -e "$AST_COUNT_SCRIPT" -- "$@")
}

MANIFEST_LIST=""
manifest_paths_seen=""
if [ -f "$MANIFEST_FILE" ]; then
  # Pass 1: parse + validate every manifest line, collecting the valid
  # (path, count) pairs. AST counts are NOT computed here — they are batched
  # into a single node call after the loop (external review round 7 follow-up:
  # a per-line ast_count spawned ~65 node processes, ~13s of gate runtime).
  manifest_line_no=0
  manifest_valid_paths=()
  manifest_valid_counts=()
  while IFS= read -r manifest_line || [ -n "$manifest_line" ]; do
    manifest_line_no=$((manifest_line_no + 1))
    manifest_line="${manifest_line%$'\r'}"
    [ -z "$manifest_line" ] && continue
    case "$manifest_line" in \#*) continue ;; esac
    # bash-native tab split (no grep -P dependency, portable to bash 3.2 /
    # BSD grep): absence of a tab leaves both halves equal to the whole line.
    m_path="${manifest_line%%$'\t'*}"
    m_count="${manifest_line#*$'\t'}"
    if [ "$m_path" = "$manifest_line" ]; then
      echo "MANIFEST_PARSE_ERROR: ${MANIFEST_FILE#$FIXTURE_ROOT/}:$manifest_line_no missing a tab separator ('$manifest_line')"
      fail=1
      continue
    fi
    case "$m_count" in
      ''|*[!0-9]*)
        echo "MANIFEST_PARSE_ERROR: ${MANIFEST_FILE#$FIXTURE_ROOT/}:$manifest_line_no non-numeric count ('$manifest_line')"
        fail=1
        continue
        ;;
    esac
    MANIFEST_LIST="${MANIFEST_LIST}${m_path}
"
    manifest_paths_seen="${manifest_paths_seen}${m_path}=${m_count}
"
    manifest_valid_paths+=("$m_path")
    manifest_valid_counts+=("$m_count")
  done < "$MANIFEST_FILE"

  # Batch AST-count all valid manifest files in ONE node call, into a lookup.
  MANIFEST_AST_OUT=""
  if [ "${#manifest_valid_paths[@]}" -gt 0 ]; then
    manifest_abs=()
    for m_path in "${manifest_valid_paths[@]}"; do
      manifest_abs+=("$FIXTURE_ROOT/$m_path")
    done
    MANIFEST_AST_OUT="$(ast_count_batch "${manifest_abs[@]}")"
  fi

  # Pass 2: compare grep count (cheap, per-file) and the batched AST count.
  idx=0
  while [ "$idx" -lt "${#manifest_valid_paths[@]}" ]; do
    m_path="${manifest_valid_paths[$idx]}"
    m_count="${manifest_valid_counts[$idx]}"
    idx=$((idx + 1))
    abs_path="$FIXTURE_ROOT/$m_path"
    grep_count=0
    if [ -f "$abs_path" ]; then
      grep_count="$(grep -c 'failClosedOnRedisError: true' "$abs_path" || true)"
    fi
    file_ast_count="$(awk -F'\t' -v p="$abs_path" '$1 == p { print $2; exit }' <<<"$MANIFEST_AST_OUT")"
    [ -n "$file_ast_count" ] || file_ast_count=0
    if [ "$grep_count" -gt "$file_ast_count" ]; then
      echo "MANIFEST_COMMENT_LITERAL: $m_path (grep count $grep_count exceeds AST-authoritative count $file_ast_count — the literal appears in a comment/string; reword it, D4 rule)"
      fail=1
    elif [ "$file_ast_count" -ne "$m_count" ]; then
      echo "MANIFEST_COUNT_MISMATCH: $m_path (manifest says $m_count; AST-authoritative count is $file_ast_count)"
      fail=1
    fi
  done
fi

# ENUM_LIST (whole-src opt-in set) is built earlier, before the dangling
# check, and reused here for the C5 manifest set-equality.
while IFS= read -r enum_path; do
  [ -z "$enum_path" ] && continue
  if ! grep -qxF "$enum_path" <<<"$MANIFEST_LIST"; then
    echo "MANIFEST_MISSING_ROUTE: $enum_path (opts into failClosedOnRedisError: true but has no fail-closed-manifest.txt entry)"
    fail=1
  fi
done <<EOF
$ENUM_LIST
EOF

while IFS= read -r manifest_path; do
  [ -z "$manifest_path" ] && continue
  if ! grep -qxF "$manifest_path" <<<"$ENUM_LIST"; then
    echo "MANIFEST_STALE_ROUTE: $manifest_path (fail-closed-manifest.txt lists it but the file no longer opts in, or is gone)"
    fail=1
  fi
done <<EOF
$MANIFEST_LIST
EOF

# ---------------------------------------------------------------------------
# C6 — structural stub-detection gate (SC1). Enumerate ALL test files under
# src (both lanes) PLUS setupFiles derived from the vitest configs, batch-
# classify, and reject any non-exempt production-mapping stub.
# ---------------------------------------------------------------------------
FROZEN_STUB_EXEMPTIONS='src/app/api/tenant/members/[userId]/reset-vault/route.test.ts
src/app/api/tenant/operator-tokens/route.test.ts
src/app/api/tenant/scim-tokens/route.test.ts
src/app/api/tenant/service-accounts/route.test.ts'

is_stub_exempt() { grep -qxF "$1" <<<"$FROZEN_STUB_EXEMPTIONS"; }

STUB_TEST_FILES=""
if [ -n "${FAIL_CLOSED_TEST_ROOT:-}" ]; then
  # Fixture mode: temp fixture trees are not git repos — use find.
  while IFS= read -r stub_line; do
    [ -n "$stub_line" ] && STUB_TEST_FILES="${STUB_TEST_FILES}${stub_line#$FIXTURE_ROOT/}
"
  done < <(find "$FIXTURE_ROOT/src" \( -name '*.test.ts' -o -name '*.test.tsx' \) 2>/dev/null | sort)
else
  while IFS= read -r stub_line; do
    [ -n "$stub_line" ] && STUB_TEST_FILES="${STUB_TEST_FILES}${stub_line}
"
  done < <(git -C "$REPO_ROOT" ls-files 'src' | grep -E '\.test\.tsx?$' | sort)
fi

# Config-seam guard (Round 2 S2-4/F-R2-3; extended round 6): any reference in a
# vitest config to a fail-closed-critical module is fail-loud, because a
# resolve.alias redirect swaps the module for a fake while every import binding
# still looks production-legitimate. Two modules are guarded:
#   - rate-limit-audit — the checkRateLimitOrFail mapping (503 envelope).
#   - security/rate-limiters — the direct-result limiter singleton
#     (v1ApiKeyLimiter); aliasing it defeats the resultfake allowlist the same
#     way mocking the module does (external review 2026-07-19, round 6).
# `security/rate-limiters` (the path segment) is matched, not a bare
# `rate-limiter`, to avoid false-positives on unrelated limiter helpers.
SETUP_FILES=""
for vitest_config in "$FIXTURE_ROOT/vitest.config.ts" "$FIXTURE_ROOT/vitest.integration.config.ts"; do
  [ -f "$vitest_config" ] || continue
  if grep -q 'rate-limit-audit' "$vitest_config"; then
    echo "STUB_CONFIG_SEAM: ${vitest_config#$FIXTURE_ROOT/} references rate-limit-audit (resolve.alias / setupFiles redirect evasion)"
    fail=1
  fi
  if grep -q 'security/rate-limiters' "$vitest_config"; then
    echo "STUB_CONFIG_SEAM: ${vitest_config#$FIXTURE_ROOT/} references security/rate-limiters (resolve.alias redirect swaps the direct-result limiter for a fake)"
    fail=1
  fi
  while IFS= read -r setup_entry; do
    [ -z "$setup_entry" ] && continue
    SETUP_FILES="${SETUP_FILES}${setup_entry}
"
  done < <(
    # Extract setupFiles path literals across BOTH the inline form
    # (`setupFiles: "x.ts"` / `setupFiles: ["x.ts"]`) and the MULTILINE array
    # form, where the paths sit on lines after `setupFiles:` (external review
    # 2026-07-19, round 2 — the old same-line grep missed multiline arrays and
    # a stub parked in an unlisted setup file evaded the C6 scan). awk enters
    # a collecting state at `setupFiles`, harvests every .ts/.tsx string
    # literal, and stops at the closing `]` (array form) or end of the same
    # logical line (inline scalar form).
    awk '
      /setupFiles/ { collecting = 1; inline_only = ($0 !~ /\[/) }
      collecting {
        line = $0
        while (match(line, /"[^"]+\.tsx?"|'"'"'[^'"'"']+\.tsx?'"'"'/)) {
          lit = substr(line, RSTART, RLENGTH)
          gsub(/^["'"'"']|["'"'"']$/, "", lit)
          print lit
          line = substr(line, RSTART + RLENGTH)
        }
        if (inline_only || $0 ~ /\]/) collecting = 0
      }
    ' "$vitest_config"
  )
done

# Resolve setupFiles path literals (relative to the config's directory) to
# fixture/repo-relative paths and fold them into the scan list. SETUP_FILE_SET
# records exactly which scanned files are GLOBAL setup files — a rate-limiters
# module mock in one of these replaces the limiter for EVERY test, so it is
# rejected there (below); a per-file mock in an ordinary test only affects that
# file's own unrelated limiter and is legitimate.
SETUP_FILE_SET=""
while IFS= read -r setup_rel; do
  [ -z "$setup_rel" ] && continue
  case "$setup_rel" in
    ./*) setup_rel="${setup_rel#./}" ;;
  esac
  STUB_TEST_FILES="${STUB_TEST_FILES}${setup_rel}
"
  SETUP_FILE_SET="${SETUP_FILE_SET}${setup_rel}
"
done <<EOF
$SETUP_FILES
EOF

is_setup_file() { grep -qxF "$1" <<<"$SETUP_FILE_SET"; }

if [ -n "$STUB_TEST_FILES" ]; then
  stub_files_array=()
  while IFS= read -r stub_rel; do
    [ -z "$stub_rel" ] && continue
    stub_files_array+=("$FIXTURE_ROOT/$stub_rel")
  done <<EOF
$STUB_TEST_FILES
EOF
  if [ "${#stub_files_array[@]}" -gt 0 ]; then
    if ! STUB_CLASSIFY_OUT="$(node "$CLASSIFIER" "${stub_files_array[@]}")"; then
      echo "CLASSIFIER_FAILURE: scripts/checks/classify-fail-closed-test.mjs failed during the C6 stub scan — gate fails closed."
      fail=1
    else
      # Single-pass evaluation: the classifier already emitted one record per
      # file, so a per-file bash loop calling awk 3-4× (≈4000 subshells over
      # ~1000 files) was the gate's dominant cost (CI timeout, external review
      # round 7 follow-up). One awk pass over the classifier output emits only
      # the offending `TOKEN<TAB>relpath` lines; the bash loop below then
      # iterates findings (usually zero), not every file. `FROZEN_STUB_EXEMPTIONS`
      # and `SETUP_FILE_SET` are passed in as newline sets for O(1) membership.
      STUB_FINDINGS="$(awk -F'\t' \
        -v root="$FIXTURE_ROOT/" \
        -v exempt="$FROZEN_STUB_EXEMPTIONS" \
        -v setups="$SETUP_FILE_SET" '
        BEGIN {
          n = split(exempt, a, "\n"); for (i = 1; i <= n; i++) if (a[i] != "") EX[a[i]] = 1
          m = split(setups, b, "\n"); for (i = 1; i <= m; i++) if (b[i] != "") SU[b[i]] = 1
        }
        {
          path = $1; rec = $2
          rel = path; sub("^" root, "", rel)
          mock = dyn = modmock = 0
          nf = split(rec, f, " ")
          for (i = 1; i <= nf; i++) {
            split(f[i], kv, "=")
            if (kv[1] == "mock") mock = kv[2]
            else if (kv[1] == "dynspec") dyn = kv[2]
            else if (kv[1] == "resultmodulemock") modmock = kv[2]
          }
          if (dyn == 1) print "DYNSPEC\t" rel
          if (mock == 1 && !(rel in EX)) print "MAPPING\t" rel
          if (modmock == 1 && (rel in SU)) print "MODULEMOCK\t" rel
        }
      ' <<<"$STUB_CLASSIFY_OUT")"
      while IFS=$'\t' read -r token stub_rel; do
        [ -z "$token" ] && continue
        case "$token" in
          DYNSPEC)
            echo "STUB_DYNAMIC_SPECIFIER: $stub_rel (vi.mock/vi.doMock with a non-literal specifier)" ;;
          MAPPING)
            echo "STUB_MOCKED_RATE_LIMIT_AUDIT: $stub_rel (mocks the production rate-limit-audit mapping — not in the frozen exemption list)" ;;
          MODULEMOCK)
            echo "STUB_MOCKED_RATE_LIMITERS_MODULE: $stub_rel (a global setup file mocks security/rate-limiters — swaps the direct-result limiter for a fake across every test)" ;;
        esac
        fail=1
      done <<EOF
$STUB_FINDINGS
EOF
    fi
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo
  echo "Fix the reported routes: author an assertRedisFailClosed contract test,"
  echo "or register the route in fail-closed-test-debt.txt (untested) /"
  echo "fail-closed-legacy-direct.txt (pre-helper direct test), and keep the"
  echo "manifests in sync with the tests (stale/dangling entries fail)."
  echo "See docs/archive/review/fail-closed-tranche1-plan.md and AC4.3."
  exit 1
fi

# AC4.4/AC4.5/manifest-sum are whole-repo invariants (an exact expected
# limiter/callsite count for THIS codebase) — meaningless against an
# isolated fixture tree, so they are skipped whenever FIXTURE_ROOT is
# overridden (self-test scope is the mode/anti-drift/manifest/stub criteria
# above, not these repo-wide counts; the "real repo, no overrides" self-test
# case still exercises them).
if [ -n "${FAIL_CLOSED_TEST_ROOT:-}" ] || [ -n "${FAIL_CLOSED_TEST_DEBT_FILE:-}" ] || [ -n "${FAIL_CLOSED_TEST_LEGACY_FILE:-}" ] || [ -n "${FAIL_CLOSED_TEST_MANIFEST_FILE:-}" ] || [ -n "${FAIL_CLOSED_EXPECTED_DEBT_COUNT:-}" ] || [ -n "${FAIL_CLOSED_EXPECTED_LEGACY_COUNT:-}" ]; then
  exit 0
fi

# AC4.4 / AC4.5 — limiter / branch count parity. Plan locks 50 limiter
# instantiations (46 from rate-limit-fail-closed-on-redis-plan + 4 new for
# A04-4 master-key rotation dual-approval: initiate/approve/execute/revoke,
# each with its own per-actor limiter).
# A future PR that silently drops a limiter from one of the multi-limiter
# files would leave the file-count gate above passing but break the
# per-limiter coverage. Per-line grep guards against this.
# 53 incl. the SSH agent sign-authorize limiter (vault/ssh/sign-authorize).
# 54 incl. the iOS bridge-code limiter (mobile/authorize, per-user fail-closed).
# 58 incl. 4 from rate-limiter-fail-closed-and-get-purge (OWASP M4/M5/M6):
#   auth callbackRateLimiter + magicLinkIpLimiter, mobile autofill mintLimiter,
#   tenant breakglassRateLimiter. (v1ApiKeyLimiter lives in src/lib, not counted here.)
# 61 incl. 3 mint limiters from owasp-rereview-stepup-and-failclosed (OWASP M3):
#   tenant scim-tokens create, operator-tokens create, service-accounts create.
#   (The SCIM runtime limiter from that PR lives in src/lib/scim, not counted here.)
# 63 incl. the 2 admin-vault-reset trigger limiters (adminResetLimiter +
#   targetResetLimiter, tenant/members/[userId]/reset-vault) — destructive
#   privileged action, found by the rateLimited() audit during that PR.
# 69 incl. 6 maintenance limiters converted from fail-open + global key to
#   fail-closed + per-tenant key (purge-history, purge-audit-logs,
#   audit-outbox-metrics, audit-outbox-purge-failed, dcr-cleanup,
#   audit-chain-verify) — external-review hygiene: a Redis outage must not
#   shed the throttle on destructive/privileged maintenance ops.
EXPECTED_LIMITER_COUNT=69
limiter_count=$(grep -rh 'failClosedOnRedisError: true' "$REPO_ROOT/src/app/api" | wc -l)
if [ "$limiter_count" -ne "$EXPECTED_LIMITER_COUNT" ]; then
  echo "AC4.4 FAIL: expected $EXPECTED_LIMITER_COUNT 'failClosedOnRedisError: true' instantiations; found $limiter_count"
  echo "If you intentionally added/removed an opt-in limiter, update EXPECTED_LIMITER_COUNT in this script AND the plan's C4 table."
  exit 1
fi

# C5 — manifest-sum cross-check (repo-only, skipped under overrides above):
# the sum of src/app/api manifest entries must equal EXPECTED_LIMITER_COUNT,
# so the AST-per-file primitive and the AC4.4 aggregate cannot drift apart
# silently.
manifest_sum=$(
  awk -F'\t' '
    !/^[[:space:]]*#/ && NF == 2 && $1 ~ /^src\/app\/api\// { s += $2 }
    END { print s + 0 }
  ' "$MANIFEST_FILE"
)
if [ "$manifest_sum" -ne "$EXPECTED_LIMITER_COUNT" ]; then
  echo "MANIFEST_COUNT_MISMATCH: fail-closed-manifest.txt src/app/api sum is $manifest_sum; expected $EXPECTED_LIMITER_COUNT (must equal AC4.4's EXPECTED_LIMITER_COUNT)"
  exit 1
fi

# AC4.5 — at least one `checkRateLimitOrFail` callsite per limiter. The two
# routes with the same limiter checked at multiple sites (tenant/access-requests,
# mcp/token) push the callsite count above the limiter count; that's the
# documented deviation. After the helper migration the raw `.redisErrored`
# branches no longer appear in route handlers — the inline check is hidden
# behind `checkRateLimitOrFail()` so we gate on the helper callsite count.
EXPECTED_MIN_CALLSITE_COUNT=50
callsite_count=$(grep -rh 'checkRateLimitOrFail(' "$REPO_ROOT/src/app/api" | wc -l)
if [ "$callsite_count" -lt "$EXPECTED_MIN_CALLSITE_COUNT" ]; then
  echo "AC4.5 FAIL: expected at least $EXPECTED_MIN_CALLSITE_COUNT 'checkRateLimitOrFail(' callsites; found $callsite_count"
  exit 1
fi

exit 0
