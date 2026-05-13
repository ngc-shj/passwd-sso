#!/usr/bin/env bash
# Enforce API error envelope conventions per docs/api/error-handling.md.
#
# Patterns checked:
#  (1) C5: legacy `{ error: "ACCESS_DENIED" }` string literal in production
#      code (must go through `errorResponse(API_ERROR.ACCESS_DENIED, ...)`).
#  (2) C2: prose English `error` value — `{ error: "<Sentence with space>" }`
#      in non-OAuth/SCIM routes (catches `audit-chain-verify:203`-style drift
#      and accidental Java-style messages).
#  (3) C2: lowercase-leading `{ error: "x..." }` outside OAuth/SCIM/MCP routes
#      (catches snake_case OAuth-style leakage into main API).
#  (4) C11: retired internal-jargon code names must not reappear anywhere
#      in `src/` (production or tests).
#  (5) C12: bare `NextResponse.json({ error: ... })` outside helper modules —
#      must go through `errorResponse()` helper. SCIM/OAuth envelopes and
#      documented carve-outs are excluded. Multi-line aware.
#  (6) C4: closed-list body context fields — `errorResponse(...)` MUST NOT
#      pass top-level body fields other than `details`, `lockedUntil`,
#      `currentKeyVersion`. Top-level `message`, `result`, `hint`, etc. are
#      forbidden; wrap them inside `details: { ... }`. Multi-line aware.
#  (7) C6: `details` MUST be an object (z.treeifyError tree shape), never a
#      bare string literal. Multi-line aware.
#  (8) C4 client-side: UI / hook / page / CLI / extension code MUST NOT call
#      `res.json()` inside an `if (!res.ok)` / `if (res.status === Nxx)` /
#      `if (res.status >= 4xx)` block — wire shape access goes through
#      `readApiErrorBody()` (or its CLI/extension mirror) so non-canonical
#      fields fail at compile time. Any variable name; block-form only.
#  (9) C4 client-side: same scope — MUST NOT use `.then((<r>) => <r>.json())`
#      Response-chain form. Convert to `await` form so rule 8 covers it.
#      Includes `.js` files in extension/src/ (parallel content-script impl).
set -euo pipefail

cd "$(dirname "$0")/../.."

violations=0

# (1) C5 — ACCESS_DENIED string literal outside tests
hits=$(grep -RnE 'NextResponse\.json\(\s*\{\s*error:\s*"ACCESS_DENIED"' src/ \
  --include='*.ts' --include='*.tsx' \
  | grep -v '\.test\.' | grep -v '/__tests__/' || true)
if [ -n "$hits" ]; then
  echo "FORBIDDEN: legacy ACCESS_DENIED string literal in production code (C5)"
  echo "$hits"
  violations=$((violations + 1))
fi

# (2) C2 — uppercase-leading English-prose string as `error` value
prose_hits=$(grep -RnE 'NextResponse\.json\(\s*\{\s*error:\s*"[A-Z][^"]*[[:space:]]' src/ \
  --include='*.ts' --include='*.tsx' \
  | grep -vE '/(scim|mcp)/' \
  | grep -v '\.test\.' | grep -v '/__tests__/' || true)
if [ -n "$prose_hits" ]; then
  echo "FORBIDDEN: English-prose error value in main API envelope (C2)"
  echo "$prose_hits"
  violations=$((violations + 1))
fi

# (3) C2 — lowercase-leading error value outside OAuth/SCIM/MCP
lc_hits=$(grep -RnE 'NextResponse\.json\(\s*\{\s*error:\s*"[a-z]' src/ \
  --include='*.ts' --include='*.tsx' \
  | grep -vE '/(scim|mcp)/' \
  | grep -v '\.test\.' | grep -v '/__tests__/' || true)
if [ -n "$lc_hits" ]; then
  echo "FORBIDDEN: snake_case error value in main API envelope (C2)"
  echo "$lc_hits"
  violations=$((violations + 1))
fi

# (4) C11 — retired internal-jargon code names
retired=(
  LEGACY_BODY_HASH_MISMATCH
  ATTACHMENT_CEK_MANIFEST_MISMATCH
  INVALID_IV_FORMAT
  INVALID_AUTH_TAG_FORMAT
  MOBILE_DPOP_INVALID
  MOBILE_REFRESH_REPLAY_DETECTED
  MOBILE_REFRESH_FAMILY_EXPIRED
  EXTENSION_TOKEN_FAMILY_EXPIRED
  LEGACY_ATTACHMENTS_RESIDUAL
  KEY_ESCROW_NOT_COMPLETED
)
retired_pat=$(IFS='|'; echo "${retired[*]}")
retired_hits=$(grep -RnE "\"(${retired_pat})\"" src/ \
  --include='*.ts' --include='*.tsx' || true)
if [ -n "$retired_hits" ]; then
  echo "FORBIDDEN: retired internal-jargon error code name (C11)"
  echo "$retired_hits"
  violations=$((violations + 1))
fi

# (5) Post-C12 — bare `NextResponse.json({ error: ... })` outside helper modules.
# Multi-line aware via perl. Excludes:
#  - SCIM/OAuth envelopes (own RFCs)
#  - Helper modules (`src/lib/http/api-response.ts` defines errorResponse itself;
#    auth/session/csrf.ts was migrated in Round 2)
#  - Documented carve-outs (dcr-cleanup stub, vault/delegation/check CLI envelope,
#    admin/rotate-master-key, apple-app-site-association)
c12_hits=$(
  find src/app/api src/app/s src/lib \
    -name '*.ts' -o -name '*.tsx' 2>/dev/null \
    | grep -v '\.test\.' | grep -v '/__tests__/' \
    | grep -vE '/(scim|mcp)/' \
    | grep -vE '(maintenance/dcr-cleanup/route|vault/delegation/check/route|admin/rotate-master-key/route|apple-app-site-association/route|src/lib/http/api-response)\.ts$' \
    | xargs -r perl -0777 -ne '
      while (/NextResponse\.json\(\s*\{[\s\S]*?\berror\s*:/g) {
        my $pos = pos($_);
        my $line = (substr($_, 0, $pos) =~ tr/\n/\n/) + 1;
        print "$ARGV:$line: " . substr($_, $-[0], 80) . "\n";
      }
    ' 2>/dev/null || true
)
if [ -n "$c12_hits" ]; then
  echo "FORBIDDEN: bare NextResponse.json({error:...}) — must use errorResponse() helper (C12)"
  echo "$c12_hits"
  violations=$((violations + 1))
fi

# (6) C4 — closed-list body context fields. `errorResponse(...)` accepts only
# `details`, `lockedUntil`, `currentKeyVersion` as top-level body keys.
# Common violation: `{ message: ... }`, `{ result: ... }`, `{ hint: ... }`,
# `{ reason: ... }`. Multi-line aware. Inner keys inside `details: { ... }`
# are NOT enforced (developers are free to shape the details object).
c4_hits=$(
  find src/app/api src/app/s src/lib \
    -name '*.ts' -o -name '*.tsx' 2>/dev/null \
    | grep -v '\.test\.' | grep -v '/__tests__/' \
    | grep -vE '/(scim|mcp)/' \
    | xargs -r perl -0777 -ne '
      while (/errorResponse\([^,]+,\s*\d+\s*,\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g) {
        my $body = $1;
        my $pos = pos($_);
        my $line = (substr($_, 0, $pos) =~ tr/\n/\n/) + 1;
        # Strip nested objects (e.g., details: { ... }) so we only inspect top-level keys.
        my $top = $body;
        $top =~ s/\{[^{}]*\}//g;
        # Find top-level keys.
        while ($top =~ /\b([a-zA-Z_]\w*)\s*:/g) {
          my $key = $1;
          next if $key eq "details" || $key eq "lockedUntil" || $key eq "currentKeyVersion";
          print "$ARGV:$line: forbidden top-level body key \"$key\"\n";
        }
      }
    ' 2>/dev/null || true
)
if [ -n "$c4_hits" ]; then
  echo "FORBIDDEN: top-level body context field outside C4 closed list — wrap inside details: { ... }"
  echo "$c4_hits"
  violations=$((violations + 1))
fi

# (7) C6 — `details` MUST be an object, never a bare string literal.
c6_hits=$(
  find src/app/api src/app/s src/lib \
    -name '*.ts' -o -name '*.tsx' 2>/dev/null \
    | grep -v '\.test\.' | grep -v '/__tests__/' \
    | grep -vE '/(scim|mcp)/' \
    | xargs -r perl -0777 -ne '
      while (/errorResponse\([^)]*?\bdetails:\s*"[^"]+"/g) {
        my $pos = pos($_);
        my $line = (substr($_, 0, $pos) =~ tr/\n/\n/) + 1;
        print "$ARGV:$line: details must be an object (z.treeifyError tree), not a string\n";
      }
    ' 2>/dev/null || true
)
if [ -n "$c6_hits" ]; then
  echo "FORBIDDEN: string-typed details payload — wrap as { details: { message: \"...\" } } (C6)"
  echo "$c6_hits"
  violations=$((violations + 1))
fi

# (8) C4 client-side — UI / hook / non-API page code must NOT call `res.json()`
# inside an `if (!res.ok)` block. The wire shape (MainApiErrorBody) MUST be
# accessed through `readApiErrorBody(res)` so accessing `body.message` or any
# non-canonical field is a TypeScript compile error. Catches F8-class
# regressions where the server moves a field under `details` but the consumer
# still reads it directly. Multi-line aware.
c4_client_hits=$(
  while IFS= read -r f; do
    # Two-stage detection: locate `if (!res.ok)` opens, then inspect the
    # following block for `await res.json()`. Single-stage block-matching
    # regex was unreliable; line-based scan with following-line lookahead
    # is more robust.
    perl -ne '
      # Matches error-path entry shapes for ANY response variable name:
      #   if (!X.ok)                — generic error branch
      #   if (X.status === Nxx)     — specific HTTP code branch (4xx / 5xx)
      #   if (X.status >= 4xx)      — range error branch
      # The matching variable name is captured and reused to check body access
      # (X.json()) inside the block. Single-statement `if (...) stmt;` form is
      # ignored (no block to track). `} else if (...)` is treated as
      # continuation when already inside a tracked block.
      if (/^\s*(?:\}\s*else\s+)?if\s*\(\s*(?:!\s*([a-zA-Z_][a-zA-Z0-9_]*)\.ok|([a-zA-Z_][a-zA-Z0-9_]*)\.status\s*(?:===\s*[45]\d\d|>=?\s*4\d\d))\s*\)\s*\{\s*$/) {
        if (!$in_block) {
          $var = $1 // $2;
          $start = $.;
          $in_block = 1;
          $depth = 0;
          $block = "";
        }
      }
      if ($in_block) {
        $block .= $_;
        $depth += () = /\{/g;
        $depth -= () = /\}/g;
        if ($depth <= 0 && $block =~ /\{/) {
          if ($block =~ /\bawait\s+\Q$var\E\.json\(/) {
            print "$ARGV:$start: error-path $var.json() bypass — use readApiErrorBody()\n";
          }
          $in_block = 0;
        }
      }
    ' "$f"
  done < <(
    # Scope: UI (components/hooks/app), CLI (cli/src), extension (extension/src)
    # — every consumer surface that talks to the main API.
    # Includes `.js` files in extension/src because extension content scripts
    # are deployed as parallel `.js` (production) + `-lib.ts` (test) per the
    # codebase convention (see `feedback_extension_parallel_impl`).
    {
      find src/components src/hooks src/app \
        \( -name '*.ts' -o -name '*.tsx' \) 2>/dev/null
      find cli/src extension/src \
        \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' \) 2>/dev/null
    } \
      | grep -v '\.test\.' | grep -v '/__tests__/' \
      | grep -vE '/app/api/'
  ) 2>/dev/null || true
)
if [ -n "$c4_client_hits" ]; then
  echo "FORBIDDEN: consumer reads error body via res.json() — use readApiErrorBody() helper (C4)"
  echo "$c4_client_hits"
  violations=$((violations + 1))
fi

# (9) C4 client-side — `.then()` chain bypass detection. The canonical
# error-body access path is `await readApiErrorBody(res)`; `.then()` chains
# that pass the Response to a `.json()` call bypass Gate rule 8 (which only
# matches `await res.json()`). Flag any `.then((<r>) => ...<r>.json()...)`
# in UI / hook / page / CLI / extension code (including `.js` content scripts).
c9_hits=$(
  {
    find src/components src/hooks src/app \
      \( -name '*.ts' -o -name '*.tsx' \) 2>/dev/null
    find cli/src extension/src \
      \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' \) 2>/dev/null
  } \
    | grep -v '\.test\.' | grep -v '/__tests__/' \
    | grep -vE '/app/api/' \
    | xargs -r perl -ne '
      # Reset line counter per file so reported line numbers are file-local.
      if (eof) { close ARGV; }
      if (/\.then\(\s*\(([a-zA-Z_]\w*)\)\s*=>/) {
        my $v = $1;
        # Single-line callback form: the .json() call appears on the same
        # line as the .then(...). Multi-line callbacks (rare) escape this
        # rule but are caught by Gate rule 8 once `await` form is required.
        if (/\b\Q$v\E\.json\(/) {
          print "$ARGV:$.: .then(($v) => $v.json()) bypass — convert to await form\n";
        }
      }
    ' 2>/dev/null || true
)
if [ -n "$c9_hits" ]; then
  echo "FORBIDDEN: .then() chain with .json() — use await form so readApiErrorBody gate covers it (C4)"
  echo "$c9_hits"
  violations=$((violations + 1))
fi

if [ "$violations" -gt 0 ]; then
  echo ""
  echo "✗ $violations API error code violation(s). See docs/api/error-handling.md."
  exit 1
fi

echo "✓ API error code conventions OK"
