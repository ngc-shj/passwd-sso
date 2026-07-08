#!/usr/bin/env bash
# CI gate: every mutating-UI caller of a step-up-gated API route MUST handle the
# SESSION_STEP_UP_REQUIRED 403 by opening the reauth flow — not by surfacing a
# generic error. This closes the "server enforces step-up, client swallows it"
# class (a UX dead-end on a stale session, and the direct symptom that started
# docs/archive/review/step-up-client-policy-card-plan.md).
#
# WHY MARKER-BASED, NOT INFERENCE-BASED (plan F7):
# A pure grep cannot reliably resolve a client `fetchApi(...)` call to the gated
# (route, method) it hits — real callers use raw template literals
# (`/api/teams/${teamId}/policy`), prop-indirection (the path token lives in a
# DIFFERENT file), and helper→canonical-path gaps (`API_PATH.TENANT_POLICY`,
# `apiPath.tenantMemberById(id)`), none of which carry a textual route+method
# token. So coverage is declared explicitly with a stable id on BOTH ends:
#
#   Server (each gated handler, on the requireRecentCurrentAuthMethod call line
#           H or H-1):        // @stepup id:<STABLE_ID> method:<M>
#   Client (immediately above the gated fetchApi call):  // @stepup id:<STABLE_ID>
#           ...and a step-up "branch" must appear within ADJACENCY_WINDOW lines
#           below that client marker.
#
# The guard matches ids between the two sets; it never resolves a path. A gated
# server mutation with no client marker (`S \ C`) is the 付け漏れ/missed-member
# case and FAILS — that failure list IS the fix work-list.
#
# ACCEPTED CLIENT "BRANCH" TOKENS (adjacency check): the raw error constant
# `SESSION_STEP_UP_REQUIRED`, OR a call to the shared helper `handleStepUpError(`.
# After the commonization refactor (src/lib/http/handle-step-up-error.ts) most
# call sites use the helper and no longer contain the raw literal; the helper's
# own definition file is the one place the literal still lives. Both tokens count
# as "the client handles step-up here".
#
# Model: scripts/checks/check-permanent-delete-stepup.sh (pure text/filesystem
# scan, NO @prisma/client import — required so it survives the static-checks CI
# job that runs without `prisma generate`).
#
# CHECKS:
#   1. Coverage (server→client): every server id ∈ S must appear in client set C,
#      unless exempt-allowlisted. `S \ C` → FAIL (the付け漏れ case).
#   2. Handling (client marker → branch, ADJACENCY-scoped): for each client
#      `@stepup id:X` on line L, a branch token must appear within
#      ADJACENCY_WINDOW lines below L. A whole-FILE grep would false-PASS the live
#      mcp-client-card case (one handler branches, siblings do not) — so this is
#      strictly line-adjacency, parser-free, failing in the SAFE direction.
#   3. Anti-orphan (client→server): every client id must match a server id
#      (`C \ S` with no exempt) → FAIL (client marks a stale/renamed id).
#   4. Server marker completeness (LINE-BOUND, per call): every
#      requireRecentCurrentAuthMethod( call on line H must carry a
#      `@stepup id:… method:…` marker on line H or H-1. Per-file id uniqueness is
#      required so a two-gated-call file (e.g. mcp-clients/[id] PUT+DELETE) needs
#      two distinct-id markers, not one shared marker. (A commented-out call still
#      matches the call regex — left to code review, same as the sibling guard.)
#
# EXEMPT (scripts/checks/stepup-client-exempt.txt): a server id may be exempted
# from requiring a client marker when its recovery is custom / non-interactive.
# Each entry names the custom marker its handler file must still contain, and the
# guard fails (EXEMPT_MARKER_ABSENT) if that marker disappears (anti-drift).
#
# KNOWN LIMITATIONS (coverage granularity — same class as the sibling guards):
#   - Coverage is a SET comparison of server-ids vs client-ids. When several UI
#     call sites share ONE server id (e.g. 8 policy cards all hit tenant/policy
#     PATCH → id `tenant-policy-patch`), a marker+branch on ONLY ONE of them
#     satisfies `S \ C`. The guard proves "at least one UI handles this route",
#     not "every UI that calls it does". All 8 are wired in this PR (review-
#     verified) and the adjacency check still catches a marked-but-unbranched
#     site; per-call-site ids are the escalation if a future un-branched Nth
#     consumer of a shared id becomes a real regression.
#   - THROWER_WITHOUT_CATCHER (below) pairs `throwIfStepUp(` to a catcher only at
#     the EXISTENCE level, not per-call-site.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
# Scan roots / exempt file are overridable so the self-test
# (scripts/__tests__/check-step-up-client-coverage.test.mjs) can point the guard
# at fixtures. Production CI uses the defaults.
API_DIR="${STEPUP_CLIENT_GUARD_API_DIR:-$REPO_ROOT/src/app/api}"
CLIENT_DIR="${STEPUP_CLIENT_GUARD_CLIENT_DIR:-$REPO_ROOT/src}"
PATH_ROOT="${STEPUP_CLIENT_GUARD_PATH_ROOT:-$REPO_ROOT}"
EXEMPT_FILE="${STEPUP_CLIENT_GUARD_EXEMPT_FILE:-$REPO_ROOT/scripts/checks/stepup-client-exempt.txt}"

# The number of lines below a client `@stepup id:X` marker within which a branch
# token must appear. After the helper refactor the branch sits 0–1 lines below
# the marked fetchApi call; the largest real marker→branch gap in the fixed set
# is well under 20 (a fetchApi with a multi-line options object, then the
# `!res.ok` block). 40 is that measured max plus generous margin.
ADJACENCY_WINDOW="${STEPUP_CLIENT_GUARD_WINDOW:-40}"

# Client "branch present" tokens (extended regex, OR-joined). The paren is a
# bracket-expression `[(]` not `\(` so it survives awk's -v un-escaping (a `\(`
# passed via -v becomes a bare `(` = invalid regex group-open in awk).
#   SESSION_STEP_UP_REQUIRED — raw constant (body-reuse call sites)
#   handleStepUpError(       — shared Response→reauth helper (most call sites)
#   throwIfStepUp(           — non-hook adapter layer: converts the 403 into a
#                              typed StepUpRequiredError for a component to catch
#   isStepUpRequiredError(   — component consumer catching that typed error
BRANCH_TOKEN_RE='SESSION_STEP_UP_REQUIRED|handleStepUpError[(]|throwIfStepUp[(]|isStepUpRequiredError[(]'

fail=0

# ── Exempt allowlist ────────────────────────────────────────────────────────
# Format per line:  <server-id>  <custom-marker-token>  # reason (>=10 chars)
# The custom-marker-token must appear somewhere in CLIENT_DIR (anti-drift). bash
# 3.2 has no associative arrays — keep parallel newline-delimited lists.
EXEMPT_IDS=""
EXEMPT_MARKERS=""
EXEMPT_PARSE_FAIL=0
if [ -f "$EXEMPT_FILE" ]; then
  while IFS= read -r raw; do
    raw="${raw%$'\r'}"
    trimmed="${raw#"${raw%%[![:space:]]*}"}"
    [ -z "$trimmed" ] && continue
    case "$trimmed" in \#*) continue ;; esac

    # id = first field; marker = second field; reason = text after `#`.
    body="${raw%%#*}"
    id="$(printf '%s' "$body" | awk '{print $1}')"
    marker="$(printf '%s' "$body" | awk '{print $2}')"
    reason=""
    case "$raw" in *#*) reason="${raw#*#}" ;; esac
    reason="${reason#"${reason%%[![:space:]]*}"}"
    reason="${reason%"${reason##*[![:space:]]}"}"

    if [ -z "$id" ] || [ -z "$marker" ]; then
      echo "EXEMPT_MALFORMED: '$raw' — each entry needs '<id> <custom-marker> # reason'."
      EXEMPT_PARSE_FAIL=1
      continue
    fi
    if [ "${#reason}" -lt 10 ]; then
      echo "EXEMPT_NO_REASON: $id has no (or too short) justification — every exemption MUST state why a standard client marker does not apply."
      EXEMPT_PARSE_FAIL=1
    fi
    EXEMPT_IDS="${EXEMPT_IDS}${id}
"
    EXEMPT_MARKERS="${EXEMPT_MARKERS}${id} ${marker}
"
  done < "$EXEMPT_FILE"
fi
if [ "$EXEMPT_PARSE_FAIL" -ne 0 ]; then
  exit 1
fi

is_exempt() {
  printf '%s' "$EXEMPT_IDS" | grep -qxF "$1"
}

# ── Collect SERVER markers (set S) and enforce completeness ──────────────────
# Server marker line:  // @stepup id:<id> method:<M>
# For every requireRecentCurrentAuthMethod( call on line H, require a marker on
# line H or H-1 carrying an id and a method:. Also collect id → S.
SERVER_IDS=""
declare_ids_seen=""

while IFS= read -r route; do
  [ -z "$route" ] && continue
  abs="$PATH_ROOT/$route"
  [ -f "$abs" ] || continue

  # Per-file id-uniqueness set (reset per file).
  file_ids=""

  # Each call line H (boundary regex rejects DISABLED_… / bare identifiers).
  while IFS= read -r H; do
    [ -z "$H" ] && continue
    # Look at line H and H-1 for a server marker with id: and method:.
    marker_line="$(awk -v h="$H" 'NR==h-1 || NR==h' "$abs" \
      | grep -oE '@stepup[[:space:]]+id:[A-Za-z0-9_-]+[[:space:]]+method:[A-Za-z]+' \
      | head -n1 || true)"
    if [ -z "$marker_line" ]; then
      echo "SERVER_MARKER_MISSING: $route:$H — requireRecentCurrentAuthMethod call has no '// @stepup id:… method:…' marker on its line or the line above."
      fail=1
      continue
    fi
    sid="$(printf '%s' "$marker_line" | sed -E 's/.*id:([A-Za-z0-9_-]+).*/\1/')"

    # Per-file id uniqueness (a marker must not cover two distinct calls).
    if printf '%s' "$file_ids" | grep -qxF "$sid"; then
      echo "SERVER_MARKER_DUP_ID: $route:$H — id '$sid' is used by more than one requireRecentCurrentAuthMethod call in this file; each gated call needs a distinct id."
      fail=1
    fi
    file_ids="${file_ids}${sid}
"

    # Global id uniqueness across all server files.
    if printf '%s' "$declare_ids_seen" | grep -qxF "$sid"; then
      echo "SERVER_MARKER_DUP_ID_GLOBAL: $route:$H — id '$sid' is already declared by another route file; ids must be globally unique."
      fail=1
    fi
    declare_ids_seen="${declare_ids_seen}${sid}
"

    SERVER_IDS="${SERVER_IDS}${sid}
"
  done < <(grep -nE '(^|[^A-Za-z0-9_])requireRecentCurrentAuthMethod\(' "$abs" | cut -d: -f1)

done < <(
  grep -rlE '(^|[^A-Za-z0-9_])requireRecentCurrentAuthMethod\(' "$API_DIR" --include='route.ts' 2>/dev/null \
    | sed "s|^$PATH_ROOT/||" \
    | sort
)

# ── Collect CLIENT markers (set C) and enforce adjacency handling ────────────
# Client marker line:  // @stepup id:<id>   (no method: — that's the server form)
# Grep every `@stepup id:X` in client .tsx/.ts that is NOT a server marker (no
# `method:`), across CLIENT_DIR excluding the api route tree and test files.
CLIENT_IDS=""

while IFS= read -r hit; do
  [ -z "$hit" ] && continue
  # hit format: <file>:<lineno>:<content>
  cfile="${hit%%:*}"
  rest="${hit#*:}"
  clineno="${rest%%:*}"
  content="${rest#*:}"

  # Skip server-form markers (they carry method:) — those belong to set S.
  case "$content" in *method:*) continue ;; esac

  cid="$(printf '%s' "$content" | grep -oE '@stepup[[:space:]]+id:[A-Za-z0-9_-]+' | sed -E 's/.*id:([A-Za-z0-9_-]+).*/\1/' | head -n1)"
  [ -z "$cid" ] && continue

  CLIENT_IDS="${CLIENT_IDS}${cid}
"

  # Adjacency: a branch token within ADJACENCY_WINDOW lines below the marker.
  if ! awk -v L="$clineno" -v W="$ADJACENCY_WINDOW" -v re="$BRANCH_TOKEN_RE" \
      'NR>L && NR<=L+W && $0 ~ re {found=1} END{exit !found}' "$cfile"; then
    rel="${cfile#"$PATH_ROOT/"}"
    echo "CLIENT_BRANCH_MISSING: $rel:$clineno — '@stepup id:$cid' has no step-up branch (SESSION_STEP_UP_REQUIRED or handleStepUpError()) within $ADJACENCY_WINDOW lines below it."
    fail=1
  fi
done < <(
  grep -rnE '@stepup[[:space:]]+id:' "$CLIENT_DIR" \
    --include='*.tsx' --include='*.ts' 2>/dev/null \
    | grep -v "$API_DIR/" \
    | grep -vE '\.test\.(tsx?|mjs):' \
    || true
)

# ── Check 1: Coverage (S \ C) ────────────────────────────────────────────────
while IFS= read -r sid; do
  [ -z "$sid" ] && continue
  if printf '%s' "$CLIENT_IDS" | grep -qxF "$sid"; then
    continue
  fi
  if is_exempt "$sid"; then
    continue
  fi
  echo "MISSING_CLIENT_MARKER: server id '$sid' is a step-up-gated mutation with no client @stepup marker — its UI caller does not handle the SESSION_STEP_UP_REQUIRED 403 (or the marker is missing). Add the client branch + marker, or exempt with reason."
  fail=1
done < <(printf '%s' "$SERVER_IDS" | sort -u)

# ── Check 3: Anti-orphan (C \ S) ─────────────────────────────────────────────
while IFS= read -r cid; do
  [ -z "$cid" ] && continue
  if printf '%s' "$SERVER_IDS" | grep -qxF "$cid"; then
    continue
  fi
  if is_exempt "$cid"; then
    continue
  fi
  echo "ORPHAN_CLIENT_MARKER: client id '$cid' has no matching server @stepup marker (renamed/stale route id, or a typo). Remove or correct it."
  fail=1
done < <(printf '%s' "$CLIENT_IDS" | sort -u)

# ── Thrower↔catcher pairing (typed-error adapter layer) ──────────────────────
# `throwIfStepUp(` counts as a client "branch" token, but on its own it only
# RAISES a StepUpRequiredError — it does not prove any consumer catches it and
# opens reauth. A gated adapter that throws with no catcher would reopen the
# phantom-delete class (row optimistically removed, error swallowed). So: if the
# thrower token appears anywhere in the client tree, at least one catcher
# (`isStepUpRequiredError(`) MUST also appear. This is an existence-level pairing
# (not per-call-site), which is the proportionate guard against "throws but
# nobody catches". Per-call-site pairing would need call-site ids — deferred.
if grep -rqE 'throwIfStepUp[(]' "$CLIENT_DIR" --include='*.tsx' --include='*.ts' 2>/dev/null; then
  if ! grep -rqE 'isStepUpRequiredError[(]' "$CLIENT_DIR" --include='*.tsx' --include='*.ts' 2>/dev/null; then
    echo "STEPUP_THROWER_WITHOUT_CATCHER: throwIfStepUp() is used (a layer raises StepUpRequiredError) but no consumer catches it with isStepUpRequiredError() — the typed step-up error would surface as a generic failure. Add an isStepUpRequiredError() branch that opens reauth."
    fail=1
  fi
fi

# ── Exempt anti-drift: each exempt id's named custom marker must still exist ──
while IFS= read -r line; do
  [ -z "$line" ] && continue
  eid="$(printf '%s' "$line" | awk '{print $1}')"
  emarker="$(printf '%s' "$line" | awk '{print $2}')"
  [ -z "$eid" ] && continue

  # The exempt id must still be a real server id (else the exemption is stale).
  if ! printf '%s' "$SERVER_IDS" | grep -qxF "$eid"; then
    echo "STALE_EXEMPT: exempt id '$eid' has no matching server @stepup marker — remove it from stepup-client-exempt.txt."
    fail=1
    continue
  fi
  # The named custom recovery marker must still appear in the client tree.
  if ! grep -rqF "$emarker" "$CLIENT_DIR" --include='*.tsx' --include='*.ts' 2>/dev/null; then
    echo "EXEMPT_MARKER_ABSENT: exempt id '$eid' names custom marker '$emarker' but it is not present anywhere in the client tree — the custom recovery flow was removed or renamed."
    fail=1
  fi
done < <(printf '%s' "$EXEMPT_MARKERS")

if [ "$fail" -ne 0 ]; then
  echo
  echo "step-up client-coverage guard FAILED. See docs/archive/review/step-up-client-policy-card-plan.md (C1)."
  echo "Server: add '// @stepup id:<slug> method:<M>' on the requireRecentCurrentAuthMethod line."
  echo "Client: add '// @stepup id:<slug>' above the gated fetchApi and handle the 403 via"
  echo "        handleStepUpError(res, inlineReauth.triggerOnStaleError) (or the raw branch)."
  exit 1
fi

exit 0
