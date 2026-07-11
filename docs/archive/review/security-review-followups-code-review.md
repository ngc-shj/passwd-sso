# Code Review: security-review-followups
Date: 2026-07-11
Review round: 1

## Changes from Previous Round
Initial Phase 3 review, incremental on top of the Phase 2 self-R-check baseline (which was clean except one R19 miss already fixed in 27d0c105). Local-LLM pre-screening: no issues. Ollama seeds: func/sec empty, test 4 Minor (all rejected with evidence). Three expert sub-agents (Sonnet) ran in parallel.

## Functionality Findings
No findings. All 7 contracts independently re-verified with live runs (guard exit 0, full suite green, manifest tests green). Implementation Checklist cross-check: every batch file present in the diff. One sub-Minor internal-consistency nit (reason-length counting differs between check-6 `tr -d` and exempt-file `${#reason}`) noted but not raised — both fail in the safe direction, plan specifies no canonical method.

## Security Findings

**S1 Minor: unbounded `client_id` written into MCP token-route audit metadata (pre-existing pattern this diff extends)**
- File: `src/app/api/mcp/token/route.ts` (refresh-grant audit metadata sites)
- Evidence: `clientIdValue = body.client_id` was written raw into replay/rotation audit metadata; body bounded only by the 1 MB JSON cap; `truncateMetadata` is all-or-nothing at `METADATA_MAX_BYTES` (10 KB). A replay attacker padding `client_id` past 10 KB collapses the ENTIRE audit entry (familyId/storedClientId/reason) into a `{_truncated}` stub — anti-forensics on the exact record C6 hardens.
- Impact: audit-quality degradation on a security event (Minor; the revocation control itself, keyed on familyId, is unaffected).
- Fix: cap the body value to `MCP_CLIENT_ID_MAX_LENGTH` (64, = McpClient.clientId VarChar) via a dedicated `auditClientId` used ONLY in audit metadata; rate-limit key and exchange client-match keep the full value. New regression test asserts a 20 KB client_id is capped to 64 and the forensic fields survive.
- Anti-Deferral: pre-existing in a changed file; fixed in-PR per the rule (~10 min).
- escalate: false

**S2 Minor: `@browser-redirect-recovery` proximity check satisfied by a decoy comment, not a verified redirect call (RT7 shape-c)**
- File: `scripts/checks/check-step-up-client-coverage.sh` (anchor check)
- Evidence: the awk anchor matched the case-insensitive word "redirect" anywhere in a ±5 window — a comment `// ...mentions redirect...` next to the marker passed while the actual return was a JSON 403. The self-test only proved the "no redirect token at all" case, not "decoy comment, no call".
- Impact: a future PR could regress an exempt route to a client-recovery dead-end while CI stays green (low likelihood — deleting a `redirect(` call usually removes the word too; low fix cost). All 3 current routes are correctly implemented.
- Fix: require an actual `redirect(` / `redirectToSignIn(` CALL on a non-comment line within ±3 lines (strip trailing line comments, skip comment-only lines). Moved the consent + mobile markers directly above their recovery calls (were 17 and 4 lines away). Added fixtures `(xii-decoy)` (FAIL on decoy comment) and `(xii-redirectToSignIn)` (PASS on helper call). Updated guard header, exempt-file header, and plan §C2 forbidden-pattern to the ±3/call-shape semantics.
- escalate: false

**S3 (verified clean, not a finding): reason-length filler-acceptance** — matches the plan's stated human-review trust level (SC3), same as route-manifest `handlerAuthReason`; the field forces reviewable text to exist, not adversarial-content defense. No action.

Verified clean (adversarial checks): C1 FIFO no transient-overshoot under Node run-to-completion (no await between size-check and set); C3 manifest duplicate-key non-exploitable (single first-wins shell consumer; JSON.parse collapse still satisfies completeness); R43 no boundary widening (84e57d24 and the S2 marker moves are comment-only); RS6 escape ordering intact; C6 no response-body leak; RS4 no PII in any committed file.

## Testing Findings
No findings. R19 fix (27d0c105) independently confirmed genuine + mutation-capable. Guard self-test failure fixtures all assert exit 1 + specific string; green fixtures non-vacuous. C4 round-trip through real parseCsvLine/splitCsvRows; CLI parity byte-identical. C5 mutation proof independently re-executed (rawSql flip → red → restore → green). All four Ollama seeds rejected with concrete evidence.

## Seed Finding Disposition
- Testing seed 1 (MAX_CACHE_ENTRIES duplication) — Rejected: plan C1 AC1 explicitly chose no production test seam; drift fails loud.
- Testing seed 2 (repo-root resolution fragile) — Rejected: identical to sibling route-policy-manifest.test.ts:51 convention.
- Testing seed 3 (spawnSync bash POSIX-only) — Rejected: no Windows CI job; guard is bash-only by design.
- Testing seed 4 (5k loop timeout) — Rejected: testTimeout is 10 s not 5 s; measured 441 ms (22× margin).
- Functionality/Security seeds — empty, no dispositions.

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
All R1-R42 baseline-clean (Phase 2 self-pass covered the full checklist; this round incremental). R19 re-confirmed fixed; R42 C3 bijection (48=48) + C5 candidate-set re-derived live. No deltas.

### Security expert
Deltas vs baseline: R34 → NEW S1 (pre-existing unbounded client_id in changed file); RT7 → NEW S2 (fixture-completeness gap on the decoy case). R42/RS1/RS6/R31/R36/R38 reconfirmed clean.

### Testing expert
RT1/RT3/RT5/RT6/RT7/RT8/RT9/R19/R42 reconfirmed; no new class findings. All seeds independently checked and rejected.

## Environment Verification Report
All 7 contracts verified-local (see testing expert table): C1 hibp test (11/11, 441 ms); C2/C3 guard exit 0 + self-test (28/28 after S2 fixtures); C4 app+CLI csv tests; C5 manifest test (11/11) + live mutation proof; C6 oauth-server + route + refresh-token tests (incl. new S1 anti-forensics case); C7 docs-only. VE1 (no E2E dep), VE2 (guards no prisma generate), VE3 (HIBP mocked) all held. Nothing blocked-deferred.

## Resolution Status

### S1 Minor — unbounded client_id in audit metadata
- Action: added `MCP_CLIENT_ID_MAX_LENGTH = 64` constant; derived `auditClientId` (capped copy) in the refresh grant; applied to all 3 refresh-block metadata sites (replay presentedClientId + fallback, rotation-revoked presentedClientId + fallback, rotate-success clientId). Rate-limit key and exchange client-match keep the full `clientIdValue`. Added regression test asserting a 20 KB client_id caps to 64 with forensic fields intact.
- Modified: `src/lib/constants/auth/mcp.ts`, `src/app/api/mcp/token/route.ts`, `src/app/api/mcp/token/route.test.ts`

### S2 Minor — decoy-comment bypass of the browser-redirect anchor check
- Action: tightened the awk anchor to require a `redirect(`/`redirectToSignIn(` call on a non-comment line within ±3 lines; moved consent + mobile `@browser-redirect-recovery` markers adjacent to their real recovery calls; added `(xii-decoy)` FAIL and `(xii-redirectToSignIn)` PASS fixtures; updated guard header, exempt-file header, and plan §C2.
- Modified: `scripts/checks/check-step-up-client-coverage.sh`, `scripts/checks/stepup-client-exempt.txt`, `src/app/api/mcp/authorize/consent/route.ts`, `src/app/api/mobile/authorize/route.ts`, `scripts/__tests__/check-step-up-client-coverage.test.mjs`, `docs/archive/review/security-review-followups-plan.md`

### S3 — verified clean, no action.

---

# Round 2 (incremental — R1 fix verification)
Date: 2026-07-11

## Changes from Previous Round
Reviewed the Round-1 fix commit a6928dfc (S1 client_id cap, S2 guard tightening). Security + Testing experts ran incrementally with an R43 boundary-widening check.

## Security Findings (Round 2)

**S1 / S2 — verified complete.** S1: all 3 refresh-grant metadata sites + the `?? auditClientId` fallback use the capped value; authorization_code grant has no equivalent site; constant matches schema VarChar(64); regression test confirmed non-vacuous (reverting the cap → `expected 20005 to be 64`). S2: marker relocations confirmed comment-only (line-filtered diff empty — R43 clean, no logic change); guard exit 0 on real tree; `//` and trailing-comment decoys correctly rejected.

**S4 (new in round 2) Minor: `/* … */` block-comment shape still bypassed the browser-redirect-recovery anchor check**
- File: `scripts/checks/check-step-up-client-coverage.sh` (awk anchor)
- Evidence: the Round-1 comment-skip recognized only `//` and `*`-continuation lines; a single-line C-style block comment `/* … redirect(x) … */` was neither skipped nor stripped, so its literal `redirect(` satisfied the call regex and passed. Plausible because the same route files use `/** */` JSDoc headers — a future author explaining an exemption in a block comment adjacent to the marker would silently satisfy the check. No shipped route affected (guard exit 0).
- Impact: same class/severity as S2 (latent guard-soundness gap; a future decoy-comment regression could keep CI green).
- Fix: comment-skip now also matches `/*`-opening lines; same-line `/* … */` spans are `gsub`-stripped before the call scan (open-on-one-line/close-on-another is documented as out of scope — route files use only single-line spans or JSDoc headers, both covered). Added fixture `(xii-block-decoy)` proving the block-comment decoy FAILs.
- escalate: false

## Testing Findings (Round 2)
No findings. S1 cap mutation-verified live (removed `.slice` → red); S2 fixtures' awk paths hand-traced; marker relocations broke no existing route.test.ts (64/64); 186/186 across all affected files. S4 fixture added and verified red-capable (29/29 guard self-tests).

## Recurring Issue Check (Round 2)
R43: PASS with delta — S1 narrows a boundary (no widening); S2 marker moves byte-identical; the delta surfaced S4 (the R1 fix closed only the `//`-decoy shape). RT7/RT8/R19 reconfirmed. S4 fixed in-round.

## Resolution Status (Round 2)

### S4 Minor — block-comment decoy bypass
- Action: extended the awk comment-skip to `/^(\/\/|\*|\/\*)/` and added `gsub(/\/\*.*\*\//,"",line)` before the call scan; added `(xii-block-decoy)` fixture (FAILs on a block-comment decoy). Guard exit 0 on real tree; self-tests 29/29.
- Modified: `scripts/checks/check-step-up-client-coverage.sh`, `scripts/__tests__/check-step-up-client-coverage.test.mjs`

## Convergence
Round 2 introduced S4 (Minor, fixed in-round). A Round 3 verifies the S4 fix.

---

# Round 3 (incremental — S4 fix verification + class-convergence)
Date: 2026-07-11

## Changes from Previous Round
Reviewed the Round-2 fix (5f00a7cd). Security expert ran the guard-soundness convergence check per triangulate Step 3-8 (the browser-redirect anchor class expanded twice: S2 → S4, so "no findings" alone is not a sufficient stop — the guard itself must be sound).

## Security Findings (Round 3)
No findings. S4 fix sound: guard exit 0 on real tree (all 3 routes single-line calls 0-1 lines from marker); 29/29 self-tests incl. (xii-block-decoy). R43 clean (guard-only diff, zero production code). Two remaining theoretical bypass shapes adversarially enumerated:
- interior line of a multi-line `/* */` block comment with no leading `*` — grep proves ZERO occurrences in any route.ts (JSDoc star-continuation is 100% consistent); documented inline in the script; backstopped by the independent `@browser-redirect-recovery-test` sibling-test contract.
- regex substring match (`myredirect(` sharing the suffix) — grep proves ZERO such identifiers in any route.ts.
Both accepted as out-of-scope with worst-case/likelihood/cost recorded (see the JSON residuals block in the round-3 raw output).

**Guard-soundness class (S2 → S4) declared CLOSED** — no third expansion materialized under adversarial enumeration; residuals empirically absent + test-contract-backstopped.

## Orchestrator convergence hardening (belt-and-suspenders)
The round-3 optional low-cost hardening (word-boundary anchor) was applied to remove the substring-match residual structurally rather than only documenting it: the call regex is now `(^|[^A-Za-z0-9_])redirect(ToSignIn)?\(` so a foreign identifier ending in `redirect(` cannot spoof a real call (`NextResponse.redirect(` still matches — `.` is a boundary). Fixture `(xii-substring-decoy)` pins `myredirect(` as a FAIL. 30/30 self-tests, guard exit 0.

## Recurring Issue Check (Round 3)
- R43: PASS — guard-only, no production code touched.
- R42-①b (class-expansion convergence): the twice-expanded browser-redirect anchor class is CLOSED. The guard is mutation-verified red-capable for every decoy shape encountered (// , trailing-comment, single-line /* */, foreign-substring), wired into pre-pr.sh + CI static-checks. The one remaining shape (multi-line block-comment interior) is empirically absent (grep 0) and test-contract-backstopped — documented, not silently open.

## Resolution Status (Round 3)
### Convergence hardening — substring-match residual
- Action: added a left word-boundary to the anchor call regex; added `(xii-substring-decoy)` fixture (FAILs on `myredirect(`). Guard exit 0; self-tests 30/30.
- Modified: `scripts/checks/check-step-up-client-coverage.sh`, `scripts/__tests__/check-step-up-client-coverage.test.mjs`

## Final Convergence
Phase 3 converged after 3 rounds: R1 (2 Minor S1/S2 fixed), R2 (1 Minor S4 fixed), R3 (0 findings, class CLOSED + belt-and-suspenders hardening). All findings resolved; guard-soundness class mechanically closed and mutation-verified.

---

# Round 4 (user-reported finding — post-push)
Date: 2026-07-11

## Changes from Previous Round
After push, the user reported a genuine gap in the Round-1 S1 fix: `auditClientId` only length-capped `client_id` when it was a string (`typeof clientIdValue === "string" ? slice : clientIdValue`). The JSON body is only cast to `Record<string,string>` (route.ts:57), not actually string-typed, so an attacker can send `client_id` as a huge object/array. Since replay detection runs before client matching, a replayed token + a huge non-string `client_id` puts the huge value into `presentedClientId`, re-opening the exact metadata-truncation anti-forensics vector S1 was written to close.

## Security Finding

**S5 (user-reported) Medium: non-string `client_id` bypasses the audit length cap**
- File: `src/app/api/mcp/token/route.ts` (refresh_token grant; auth_code grant shares the same non-string-body class)
- Root cause: `.slice()` is string-only, so the cap silently no-ops on a non-string value that the `Record<string,string>` cast does not actually guarantee.
- Fix (per the user's directive): validate `refresh_token` / `client_id` / (optional) `client_secret` as strings at the boundary and return `invalid_request` for any non-string; then `auditClientId = clientIdValue.slice(0, MCP_CLIENT_ID_MAX_LENGTH)` unconditionally. The same boundary check was added symmetrically to the `authorization_code` grant (same changed file, same class — its non-string values would otherwise garble the rate-limit key / exchange).
- Regression tests (both input paths, per the user's requirement): (1) JSON body with a non-string `client_id` (nested object serializing >10 KB) → 400 `invalid_request`, exchange and audit both never run; (2) form-encoded (always string-typed) valid path still caps at 64 in replay audit. Mutation-verified: removing the boundary check turns test (1) red.
- escalate: false

## Recurring Issue Check (Round 4)
- R34 (same class in sibling code): the auth_code grant carried the same non-string-body exposure; fixed in the same commit rather than left half-guarded.
- RT7/RT8: the JSON-body denial test asserts BOTH the 400 status AND that the guarded operations (exchange, audit) did not run — mutation-verified red-capable.

## Resolution Status (Round 4)
### S5 Medium — non-string client_id bypasses the audit cap
- Action: boundary string-validation for refresh_token/client_id/client_secret (both grants) → invalid_request on non-string; unconditional `.slice(0, 64)` for `auditClientId`. Added JSON-body-rejection + form-encoded-cap regression tests.
- Modified: `src/app/api/mcp/token/route.ts`, `src/app/api/mcp/token/route.test.ts`

## Process note (orchestrator)
The mutation-proof for S5's test again used `git checkout --` to restore, which reverted the uncommitted S5 fix (identical to deviation-log process note 1). Re-applied immediately, re-verified 96/96 green, residue-grepped clean. Repeat lesson: commit before mutation-testing, or mutate a scratch copy.

---

# Round 5 (user-reported finding — post-push)
Date: 2026-07-11

## Changes from Previous Round
User reported that S5's fix protected the audit metadata (via `.slice`) but NOT the rate-limit key: `mcp:token:${client_id}` still concatenated the raw (string-only-validated, length-unbounded) `client_id`, so an attacker could create arbitrarily large / numerous keys in the rate-limit backend (memory / bandwidth / log amplification) in both grants.

## Security Finding

**S6 (user-reported) Medium: attacker-controlled client_id used as an unbounded-length rate-limit key**
- File: `src/app/api/mcp/token/route.ts` (both `authorization_code` and `refresh_token` grants)
- Fix: added a length bound to the boundary check in BOTH grants — `client_id.length === 0 || client_id.length > MCP_CLIENT_ID_MAX_LENGTH` → `invalid_request` (a valid McpClient.clientId is VarChar(64), so a legitimate client is never rejected). This bounds the rate-limit key at `mcp:token:` + 64. Chose reject-at-boundary over hashing the key: (a) the length bound already makes the key finite, so hashing adds no DoS benefit (distinct inputs still map to distinct buckets); (b) every other rate-limit key in the codebase uses a plaintext trusted id (`userId`/`tenantId`/normalized IP via `rateLimitKeyFromIp`) with no hashing — `client_id` is a public OAuth identifier (`mcpc_` prefix), not a secret, so hashing only this one would be inconsistent (YAGNI). User confirmed the no-hash decision given no truncation-collision.
- Truncation-collision note (user question): because oversized values are now REJECTED rather than truncated, two distinct oversized client_ids can no longer collide onto the same 64-char audit value — forensic attribution stays 1:1. The `auditClientId = clientIdValue.slice(0, 64)` is now a no-op defense-in-depth guard (documented as such).
- Regression tests (both grants, both input paths): oversized string client_id → 400 + no rate-limiter/exchange/audit call; refresh grant at exactly the 64-char limit → accepted (boundary condition, reject is `> MAX` not `>= MAX`). Mutation-verified via scratch-backup (not `git checkout`): removing both length bounds turns the 3 oversized-reject tests red.
- escalate: false

## Recurring Issue Check (Round 5)
- R34: length bound applied symmetrically to both grants (same class, same commit).
- RT8: oversized-reject tests assert 400 AND that the guarded sinks (rate limiter key, exchange, audit) did not run — mutation-verified.

## Resolution Status (Round 5)
### S6 Medium — unbounded-length rate-limit key
- Action: `client_id.length` bounded (non-empty, ≤ 64) at the boundary of both grants; removed the now-redundant `!client_id`/`!clientIdValue` truthiness checks (subsumed by `length === 0`); `auditClientId` slice re-documented as a no-op defense-in-depth guard that also rules out truncation collisions.
- Modified: `src/app/api/mcp/token/route.ts`, `src/app/api/mcp/token/route.test.ts`

## Process note
Mutation-proof this round used a scratch `.bak` copy + `cp` restore (NOT `git checkout --`), avoiding the uncommitted-work-revert mishap from process notes 1 and the Round-4 note. Restore verified clean (both length bounds present, 98/98 green).
