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
#   4. Server marker completeness (LINE-BOUND, per call): every step-up gate call
#      (any primitive in STEPUP_PRIMITIVE_RE) on line H must carry a
#      `@stepup id:… method:…` marker on line H or H-1. Per-file id uniqueness is
#      required so a two-gated-call file (e.g. mcp-clients/[id] PUT+DELETE) needs
#      two distinct-id markers, not one shared marker. (A commented-out call still
#      matches the call regex — left to code review, same as the sibling guard.)
#   5. Manifest bijection (scripts/checks/stepup-route-paths.json, plan F2/C3):
#      the server-id set S must exactly equal the manifest's key set — both
#      directions. `MANIFEST_ID_MISSING`: a server id has no manifest entry (a
#      new gated route cannot merge without binding its path). `MANIFEST_ID_STALE`:
#      a manifest key has no matching server id (a renamed/removed route left a
#      stale binding). The manifest is parsed with plain grep/awk (no JSON
#      library — VE2), which is why it MUST stay one-id-per-line formatted: each
#      entry's opening `"<id>": { "method": "<M>", "pathTokens": [...] },` on a
#      single line. An empty `pathTokens` array is a forbidden pattern (vacuous
#      completeness, zero detection) and fails the same check.
#   6. Unmarked new-call-site detector (best-effort, plan F2/C3):
#      `UNMARKED_CALLSITE_CANDIDATE`. For each client file (non-test .ts/.tsx
#      under CLIENT_DIR, excluding API_DIR) and each `fetchApi(` occurrence at
#      line F, if any `pathTokens` entry of some manifest id X appears within
#      the argument window (line F through F+3) AND a mutating method literal
#      ("POST"|"PUT"|"PATCH"|"DELETE") matching X's manifest `method` appears
#      within F through F+10, the file must carry a `@stepup id:X` marker
#      somewhere in it. This is a NEW-CALL-SITE tripwire, not a coverage
#      re-check — an id already satisfying check 1 can still trip this on a
#      SECOND, unmarked call site in a different file. Escape hatch for a
#      confirmed false positive: `// @stepup-path-ok id:X` on or adjacent to the
#      call line, with a reason ≥10 chars (same discipline as the exempt file).
#      Residual (documented, unchanged from today's baseline — the detector only
#      ADDS detection): raw template-literal paths whose static fragments are
#      too generic, prop-indirection call sites (the path token lives in a
#      different file than the fetchApi call), and non-fetchApi transports
#      remain undetectable.
#
# EXEMPT (scripts/checks/stepup-client-exempt.txt): a server id may be exempted
# from requiring a client marker when its recovery is custom / non-interactive.
# Each entry names the custom marker its handler file must still contain, and the
# guard fails (EXEMPT_MARKER_ABSENT) if that marker disappears (anti-drift). A
# `@browser-redirect` entry is additionally checked against its route's actual
# recovery implementation and regression test (BROWSER_REDIRECT_RECOVERY_MISSING /
# BROWSER_REDIRECT_TEST_MISSING — see stepup-client-exempt.txt header).
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
#   - Check 6's detector residual: see item 6 above (SC1, plan scope contract).

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
# Scan roots / exempt file are overridable so the self-test
# (scripts/__tests__/check-step-up-client-coverage.test.mjs) can point the guard
# at fixtures. Production CI uses the defaults.
API_DIR="${STEPUP_CLIENT_GUARD_API_DIR:-$REPO_ROOT/src/app/api}"
CLIENT_DIR="${STEPUP_CLIENT_GUARD_CLIENT_DIR:-$REPO_ROOT/src}"
PATH_ROOT="${STEPUP_CLIENT_GUARD_PATH_ROOT:-$REPO_ROOT}"
EXEMPT_FILE="${STEPUP_CLIENT_GUARD_EXEMPT_FILE:-$REPO_ROOT/scripts/checks/stepup-client-exempt.txt}"
PATHS_FILE="${STEPUP_CLIENT_GUARD_PATHS_FILE:-$REPO_ROOT/scripts/checks/stepup-route-paths.json}"

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

# Server-side step-up GATE PRIMITIVES that emit a SESSION_STEP_UP_REQUIRED 403.
# The class this guard polices is "route returns SESSION_STEP_UP_REQUIRED", NOT
# "route calls requireRecentCurrentAuthMethod" — anchoring on one function name
# misses the other primitives whose default errorCode is SESSION_STEP_UP_REQUIRED
# (src/lib/auth/session/step-up.ts, src/lib/auth/webauthn/recent-passkey-verification.ts).
# A gated route reached by a fetch-based UI caller must still recover client-side;
# a route reached only by browser redirect is exempted via the @browser-redirect
# sentinel (see stepup-client-exempt.txt).
#   requireRecentCurrentAuthMethod( — reauth with the session's current method
#   requireRecentSession(           — recent-session gate (default errorCode = 403 code)
#   requireRecentPasskeyVerification( — recent passkey gate (same default)
#   evaluateStepUpFreshness(        — token-parameterized freshness core; a route
#                                     calling it directly and hand-rolling the 403
#                                     must not be invisible to this guard
# ERE with a leading boundary group; used both to LIST gated files and to find
# each gated CALL line. Keep in sync with the primitives above.
STEPUP_PRIMITIVE_RE='(^|[^A-Za-z0-9_])(requireRecentCurrentAuthMethod|requireRecentSession|requireRecentPasskeyVerification|evaluateStepUpFreshness)\('

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
# Parallel newline-delimited "id<space>route-file" map (bash 3.2 has no
# associative arrays — same idiom as EXEMPT_MARKERS). Consumed by the
# @browser-redirect anti-drift check below (C2) to locate each exempt id's
# own route file without re-deriving it from scratch.
SERVER_ID_FILES=""

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
      echo "SERVER_MARKER_MISSING: $route:$H — step-up gate call has no '// @stepup id:… method:…' marker on its line or the line above."
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
    SERVER_ID_FILES="${SERVER_ID_FILES}${sid} ${route}
"
  done < <(grep -nE "$STEPUP_PRIMITIVE_RE" "$abs" | cut -d: -f1)

done < <(
  grep -rlE "$STEPUP_PRIMITIVE_RE" "$API_DIR" --include='route.ts' 2>/dev/null \
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
  # Sentinel exemption: a route reached ONLY by browser navigation/redirect has
  # no fetch-based UI caller to carry a client marker — its stale-session recovery
  # IS the server's own NextResponse.redirect to sign-in. Such an entry names the
  # literal marker `@browser-redirect` and is NOT held to the client-tree
  # anti-drift check (there is deliberately no client token). Guarded so a real
  # interactive route cannot silently opt out of client coverage with it.
  #
  # C2 hardening: sentinel presence in this allowlist alone used to be trusted at
  # face value. Now the guard verifies the exemption against the ACTUAL recovery
  # implementation and its regression test, closing the "someone deletes the
  # redirect but forgets to remove the exemption" gap:
  #   - BROWSER_REDIRECT_RECOVERY_MISSING: the id's own route file (from
  #     SERVER_ID_FILES) must contain the literal `@browser-redirect-recovery`
  #     marker, anchored (a redirect( / redirectToSignIn( CALL within ±3 lines)
  #     so the marker cannot float disconnected from the real conversion.
  #   - BROWSER_REDIRECT_TEST_MISSING: the sibling route.test.ts (same directory
  #     as the route file) must exist and contain the literal
  #     `@browser-redirect-recovery-test` marker, pinning a regression test.
  if [ "$emarker" = "@browser-redirect" ]; then
    route_rel="$(printf '%s' "$SERVER_ID_FILES" | grep -m1 "^${eid} " | cut -d' ' -f2-)"
    if [ -z "$route_rel" ]; then
      echo "STALE_EXEMPT: exempt id '$eid' has no matching server route file on record — remove it from stepup-client-exempt.txt."
      fail=1
      continue
    fi
    route_abs="$PATH_ROOT/$route_rel"

    recovery_line="$(grep -nF '@browser-redirect-recovery' "$route_abs" 2>/dev/null | head -n1 | cut -d: -f1 || true)"
    if [ -z "$recovery_line" ]; then
      echo "BROWSER_REDIRECT_RECOVERY_MISSING: $route_rel — exempt id '$eid' is marked @browser-redirect but the route file has no '// @browser-redirect-recovery' marker on its 403→redirect conversion."
      fail=1
    # The marker must anchor an ACTUAL redirect CALL, not merely the word
    # "redirect" — a decoy comment mentioning "redirect" must not satisfy it
    # (RS-review S2). Require a `redirect(` / `redirectToSignIn(` call shape on a
    # NON-comment line within ±3 of the marker (all 3 real sites sit within ±3).
    # Comment stripping runs BEFORE the call scan so no decoy comment mentioning
    # `redirect(` can pose as a real call:
    #   - a line starting with `//`, `*`, or `/*` is skipped outright;
    #   - same-line `/* … */` spans are removed (gsub), then a trailing `//`
    #     comment is removed (sub) — so `foo(); /* … redirect(x) … */` and
    #     `foo(); // … redirect(x)` both lose the decoy before matching.
    # A block comment that OPENS on one line and closes on another is not fully
    # handled (would need a state machine); route files use `/* */` only as
    # single-line spans or JSDoc `/** */` headers, both covered by the skip.
    elif ! awk -v l="$recovery_line" '
        NR!=l && NR>=l-3 && NR<=l+3 {
          line=$0
          stripped=line; sub(/^[[:space:]]+/,"",stripped)
          if (stripped ~ /^(\/\/|\*|\/\*)/) next
          gsub(/\/\*.*\*\//,"",line)
          sub(/\/\/.*/,"",line)
          if (line ~ /redirect(ToSignIn)?\(/) found=1
        }
        END{exit !found}' "$route_abs"; then
      echo "BROWSER_REDIRECT_RECOVERY_MISSING: $route_rel:$recovery_line — '@browser-redirect-recovery' marker has no redirect( / redirectToSignIn( CALL on a non-comment line within 3 lines; the marker must anchor the actual conversion, not a decoy comment mentioning the word."
      fail=1
    fi

    route_dir="$(dirname "$route_abs")"
    test_abs="$route_dir/route.test.ts"
    if [ ! -f "$test_abs" ] || ! grep -qF '@browser-redirect-recovery-test' "$test_abs" 2>/dev/null; then
      echo "BROWSER_REDIRECT_TEST_MISSING: $route_rel — exempt id '$eid' is marked @browser-redirect but its sibling route.test.ts is missing, or has no '// @browser-redirect-recovery-test' marker on the redirect regression test."
      fail=1
    fi
    continue
  fi
  # The named custom recovery marker must still appear in the client tree.
  if ! grep -rqF "$emarker" "$CLIENT_DIR" --include='*.tsx' --include='*.ts' 2>/dev/null; then
    echo "EXEMPT_MARKER_ABSENT: exempt id '$eid' names custom marker '$emarker' but it is not present anywhere in the client tree — the custom recovery flow was removed or renamed."
    fail=1
  fi
done < <(printf '%s' "$EXEMPT_MARKERS")

# ── Check 5: manifest bijection (server ids ⇔ stepup-route-paths.json keys) ──
# Parsed with plain grep/awk (no JSON library — VE2). Manifest keys are read
# with a strict one-line-per-id regex; PATHS_FILE MUST stay one-id-per-line
# formatted (documented in its own header) for this to work.
MANIFEST_IDS=""
if [ -f "$PATHS_FILE" ]; then
  MANIFEST_IDS="$( { grep -oE '^  "[A-Za-z0-9_-]+":' "$PATHS_FILE" || true; } | sed -E 's/^  "([A-Za-z0-9_-]+)":$/\1/')"
else
  echo "MANIFEST_ID_MISSING: $PATHS_FILE does not exist — every gated server id must have a manifest entry."
  fail=1
fi

# Manifest entry accessor: given an id, print its raw JSON line (empty if absent).
manifest_line_for() {
  grep -E "^  \"$1\": \{" "$PATHS_FILE" 2>/dev/null | head -n1 || true
}

while IFS= read -r sid; do
  [ -z "$sid" ] && continue
  if ! printf '%s' "$MANIFEST_IDS" | grep -qxF "$sid"; then
    echo "MANIFEST_ID_MISSING: server id '$sid' has no entry in $PATHS_FILE — add \"$sid\": { \"method\": \"<M>\", \"pathTokens\": [...] }."
    fail=1
    continue
  fi
  mline="$(manifest_line_for "$sid")"
  tokens_raw="$( { printf '%s' "$mline" | grep -oE '"pathTokens":[[:space:]]*\[[^]]*\]' || true; } | sed -E 's/"pathTokens":[[:space:]]*\[(.*)\]/\1/')"
  if [ -z "$(printf '%s' "$tokens_raw" | tr -d '[:space:]')" ]; then
    echo "MANIFEST_ID_MISSING: server id '$sid' has an empty pathTokens array in $PATHS_FILE — an empty binding vacuously satisfies completeness while detecting nothing (forbidden pattern)."
    fail=1
  fi
done < <(printf '%s' "$SERVER_IDS" | sort -u)

while IFS= read -r mid; do
  [ -z "$mid" ] && continue
  if ! printf '%s' "$SERVER_IDS" | grep -qxF "$mid"; then
    echo "MANIFEST_ID_STALE: manifest id '$mid' (in $PATHS_FILE) has no matching server @stepup marker — remove it or the route was renamed/removed."
    fail=1
  fi
done < <(printf '%s' "$MANIFEST_IDS" | sort -u)

# ── Check 6: unmarked new-call-site detector (best-effort, plan F2/C3) ───────
# For every fetchApi( call site in a client file, check whether its argument
# window (same line .. +3) contains a pathToken belonging to some manifest id
# X, AND whether a mutating method literal matching X's manifest method
# appears within the options window (same line .. +10). If so, the file must
# carry a `@stepup id:X` marker somewhere — otherwise it is an unmarked
# candidate call site for an already-covered id.
#
# Suppression escape hatch: `// @stepup-path-ok id:X <reason ≥10 chars>` on or
# immediately above the fetchApi( call line silences a confirmed false positive
# for that id at that call site.
MUTATING_METHOD_RE='"(POST|PUT|PATCH|DELETE)"'

while IFS= read -r hit; do
  [ -z "$hit" ] && continue
  cfile="${hit%%:*}"
  fline="${hit#*:}"
  fline="${fline%%:*}"
  rel="${cfile#"$PATH_ROOT"/}"

  # Skip fetchApi( occurrences inside a comment (JSDoc `*` continuation or a
  # `//` line comment) — a doc-example call site is not a real call site. This
  # is a line-prefix check only (parser-free, same philosophy as the rest of
  # this guard), not full comment-awareness.
  call_line_content="$(awk -v l="$fline" 'NR==l' "$cfile")"
  case "$(printf '%s' "$call_line_content" | sed -E 's/^[[:space:]]*//')" in
    '*'*|'//'*) continue ;;
  esac

  # This file's own client @stepup ids (cache per file would be an optimization;
  # correctness first — re-grep is cheap at this file count).
  file_marker_ids="$( { grep -oE '@stepup[[:space:]]+id:[A-Za-z0-9_-]+' "$cfile" 2>/dev/null || true; } \
    | sed -E 's/.*id:([A-Za-z0-9_-]+)/\1/' | sort -u)"

  arg_window="$(awk -v l="$fline" 'NR>=l && NR<=l+3' "$cfile")"
  opt_window="$(awk -v l="$fline" 'NR>=l && NR<=l+10' "$cfile")"

  while IFS= read -r mid; do
    [ -z "$mid" ] && continue
    # Exempt ids (check 1's allowlist) never require a standard client
    # `@stepup id:X` marker at all — their recovery is custom or non-interactive
    # (see stepup-client-exempt.txt). Without this skip, an exempt id's own
    # already-known, accepted call site (e.g. team-confirm-key-post's background
    # poller, operator-tokens-post's bespoke reauth flow) would be flagged as a
    # "new unmarked call site" even though it never carried a marker by design.
    is_exempt "$mid" && continue
    mline="$(manifest_line_for "$mid")"
    method="$( { printf '%s' "$mline" | grep -oE '"method":[[:space:]]*"[A-Z]+"' || true; } | sed -E 's/.*"([A-Z]+)"$/\1/')"
    tokens_raw="$( { printf '%s' "$mline" | grep -oE '"pathTokens":[[:space:]]*\[[^]]*\]' || true; } | sed -E 's/"pathTokens":[[:space:]]*\[(.*)\]/\1/')"

    # Mutating-method literal for THIS id's method must appear in the options
    # window — GET-only ids never trip a mutating-call-site candidate. Checked
    # before the token scan below (cheaper short-circuit).
    case "$method" in
      POST|PUT|PATCH|DELETE) ;;
      *) continue ;;
    esac
    printf '%s' "$opt_window" | grep -qE "\"$method\"" || continue

    # Word-boundary-aware match: a token must not be immediately followed by an
    # identifier character, so a shorter helper name (e.g. tenantMemberResetVault)
    # does not spuriously match a longer sibling identifier that shares it as a
    # prefix (tenantMemberResetVaultRevoke). Tokens are escaped for ERE metachars
    # (path fragments like "/api/tenant/policy" contain none that need escaping
    # beyond what grep -E treats literally here, but "?"/"."/"$" in a future token
    # would not be — escape defensively).
    token_hit=0
    while IFS= read -r tok; do
      [ -z "$tok" ] && continue
      esc_tok="$(printf '%s' "$tok" | sed -E 's/[][\.^$*+?(){}|/]/\\&/g')"
      if printf '%s' "$arg_window" | grep -qE "${esc_tok}([^A-Za-z0-9_]|\$)"; then
        token_hit=1
        break
      fi
    done < <( { printf '%s' "$tokens_raw" | grep -oE '"[^"]*"' || true; } | sed -E 's/^"(.*)"$/\1/')
    [ "$token_hit" -eq 1 ] || continue

    # Escape hatch: a suppression comment for this exact id near the call line.
    suppress_window="$(awk -v l="$fline" 'NR>=l-3 && NR<=l' "$cfile")"
    if printf '%s' "$suppress_window" | grep -qE "@stepup-path-ok[[:space:]]+id:${mid}([[:space:]]|$)"; then
      # Reason discipline: require >=10 chars of trailing text on that line.
      suppress_line="$(printf '%s' "$suppress_window" | grep -E "@stepup-path-ok[[:space:]]+id:${mid}" | head -n1)"
      reason="$(printf '%s' "$suppress_line" | sed -E "s/.*@stepup-path-ok[[:space:]]+id:${mid}//")"
      reason_len="$(printf '%s' "$reason" | tr -d '[:space:]' | wc -c | tr -d ' ')"
      if [ "$reason_len" -ge 10 ]; then
        continue
      fi
      echo "UNMARKED_CALLSITE_CANDIDATE: $rel:$fline — '@stepup-path-ok id:$mid' suppression has no (or too short) reason; state why this call site is not a real gap."
      fail=1
      continue
    fi

    if ! printf '%s' "$file_marker_ids" | grep -qxF "$mid"; then
      echo "UNMARKED_CALLSITE_CANDIDATE: $rel:$fline — fetchApi( call site matches gated id '$mid' ($method) by path token, but this file has no '@stepup id:$mid' marker. Add the marker + step-up handling, or suppress with '// @stepup-path-ok id:$mid <reason>' if this is a confirmed false positive."
      fail=1
    fi
  done < <(printf '%s' "$MANIFEST_IDS" | sort -u)
done < <(
  grep -rnE 'fetchApi\(' "$CLIENT_DIR" \
    --include='*.tsx' --include='*.ts' 2>/dev/null \
    | grep -v "$API_DIR/" \
    | grep -vE '\.test\.(tsx?|mjs):' \
    || true
)

if [ "$fail" -ne 0 ]; then
  echo
  echo "step-up client-coverage guard FAILED. See docs/archive/review/step-up-client-policy-card-plan.md (C1)."
  echo "Server: add '// @stepup id:<slug> method:<M>' on the requireRecentCurrentAuthMethod line."
  echo "Client: add '// @stepup id:<slug>' above the gated fetchApi and handle the 403 via"
  echo "        handleStepUpError(res, inlineReauth.triggerOnStaleError) (or the raw branch)."
  exit 1
fi

exit 0
