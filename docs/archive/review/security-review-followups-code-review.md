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
