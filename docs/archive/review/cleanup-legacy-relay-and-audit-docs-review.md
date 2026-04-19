# Plan Review: cleanup-legacy-relay-and-audit-docs

Date: 2026-04-19
Review rounds: 1, 2, 3, 4, 5 (rounds 1-3 converged; rounds 4-5 added after user-directed scope expansion to include F10 mcp/token route.ts fix; converged at round 5)

## Changes from Previous Round

Initial review.

## Functionality Findings

**F1 [Minor]: Build artifact `extension/dist/src/content/token-bridge.js` still references the legacy constant**
- File: plan §Repo-wide reference enumeration / §Step 2
- Evidence: `extension/dist/src/content/token-bridge.js:9,17` contains `LEGACY_MSG_TYPE = "PASSWD_SSO_TOKEN_RELAY"`. (Orchestrator pre-verified: `extension/dist/` is git-ignored AND not tracked — `git ls-files extension/dist/` returns empty.)
- Impact: Negligible — gitignored, untracked. Concern does not apply to tracked source.
- Disposition: see Resolution Status (rejected — verified non-applicable).

**F2 [Minor]: Plan §Step 5 placement of clarifying sentence in attack-vector table is ambiguous**
- File: plan line 113
- Fix: pin to "Insert as a paragraph immediately after the table at line 204 (between the table and `## File Map`)."

**F3 [Minor]: NIL_UUID JSDoc rewrite drops historical guidance about superseded usage**
- File: plan §F8 lines 84-88
- Fix: prepend "previously this constant was documented as the audit `userId` placeholder; that guidance was superseded in 2026-04 by `ANONYMOUS_ACTOR_ID` / `SYSTEM_ACTOR_ID`. The single residual call site (`src/app/api/mcp/token/route.ts:125`) is tracked as TODO(actorId-rename)."

**F4 [Minor]: Plan §Step 7 asserts `audit-delivery.ts` extension hook without verification**
- File: plan line 117
- Evidence: orchestrator pre-verified — file is at `src/workers/audit-delivery.ts` (NOT `src/lib/audit-delivery.ts`); it provides an `AuditDeliverer` interface for webhook/HEC/S3 sinks.
- Disposition: merged into M2 fix (Security S2) — the path correction is the same fix.

**F5 [Minor]: Steps 2-4 ordering risks broken intermediate commits if split**
- File: plan §Implementation steps 2-4 (lines 97-108)
- Fix: bundle Steps 1-4 into a single commit titled `refactor(extension): remove legacy PASSWD_SSO_TOKEN_RELAY postMessage path` (or commit consumers before exporter).

**F6 [Minor]: Parallel comment block in `extension/src/lib/constants.ts` not addressed**
- File: plan §Step 3 (line 102); codebase `extension/src/lib/constants.ts:1-12`
- Fix: append "Also touch up `extension/src/lib/constants.ts` lines 1-12: drop the 'New token bridge' framing on line 6 (the `TOKEN_BRIDGE_MSG_TYPE` line being deleted) and rephrase the 'Bridge code flow' comment to stand alone."

**F7-A [Adjacent / Minor]**: security claim in justification needs a behavioural test — routed to Security expert (covered by S1).

## Security Findings

**S1 [Major]: Test deletion drops the only coverage of cross-origin rejection in `handlePostMessage`**
- (Same root cause as T1 and F7-A — merged into M1.)
- File: plan §F3 / Step 4 (line 105)
- Evidence: `extension/src/__tests__/content/token-bridge.test.ts:96-106` is the only test asserting `event.origin !== window.location.origin`. The bridge-code describe block does NOT cover cross-origin, unknown message type, or `!event.data` rejection.
- Required fix: port three security tests to bridge-code shape:
  - `it("rejects bridge code message from a different origin", ...)` using `makeEvent({ type: BRIDGE_CODE_MSG_TYPE, code: VALID_CODE, expiresAt: 123 }, window, "https://evil.com")`
  - `it("rejects message with wrong type", ...)` (a `type: "OTHER_MSG"` case)
  - `it("does not respond to invalid messages (oracle prevention)", ...)`
- escalate: false

**S2 [Major]: Plan §F6 misstates compliance ceiling and omits existing audit-chain mechanism**
- File: plan §F6 / Step 7 (line 117)
- Evidence: codebase implements `src/lib/audit-chain.ts` (JCS canonicalization + hash-chain), `prisma/migrations/20260413110000_add_audit_chain/`, `src/app/api/maintenance/audit-chain-verify/route.ts`, dedicated integration tests. Path `audit-delivery.ts` does not exist at top level — actual file is `src/workers/audit-delivery.ts`. "WORM storage" is not implemented.
- Required fix: rewrite F6 paragraph to (1) cite existing audit-chain tamper-evidence + verify endpoint as already-implemented hardening; (2) use full path `src/workers/audit-delivery.ts`; (3) drop or qualify "immutable WORM storage".
- escalate: false

**S3 [Minor]: Plan understates XSS hardening impact**
- File: plan line 55
- Fix (optional): add commit message / §Risks sentence: "Removal converts a one-postMessage token leak under XSS into a multi-step exchange the attacker must complete before token expiry."

**S4 [Minor]: Worker dead-letter row writes 256-char raw `errorMsg` into `audit_logs.metadata` bypassing METADATA_BLOCKLIST**
- File: `src/workers/audit-outbox-worker.ts:451`; affected by F6 doc rewrite
- Fix: when rewriting `docs/security/security-review.md` §5, add: "AUDIT_OUTBOX_DEAD_LETTER metadata includes a 256-char truncated error string from the failing write; intended for operator diagnostics and bypasses the standard `METADATA_BLOCKLIST`. Adding blocklist scrubbing to `lastError` is tracked as a follow-up."

**S5 [Minor]: NIL_UUID JSDoc anti-enumeration guarantee should cite the schema invariant**
- File: plan §F8
- Fix: append to the JSDoc Secondary-use bullet: "This relies on the invariant that `users.id` is generated via `gen_random_uuid()` and therefore can never equal `NIL_UUID` (collision probability negligible)."

**S6 [Minor / Adjacent]: RFC 4122 vs RFC 9562 — pre-existing citation**
- File: `src/lib/constants/app.ts:10` (NOT in this PR's diff)
- Disposition: see Resolution Status (Adjacent — pre-existing, recorded for future PR; no change required by this PR).

**S7 [Minor]: Plan does not preserve `extension_token_legacy_issuance` telemetry note in F4 doc rewrite**
- File: plan §Step 5 (F4)
- Fix: when rewriting "Migration period" + "legacy-POST telemetry paragraph", retain one sentence: "Telemetry `event: extension_token_legacy_issuance` on `POST /api/extension/token` continues to be emitted; the legacy POST endpoint cleanup is tracked separately."

## Testing Findings

**T1 [Major]: Coverage regression for shared `handlePostMessage` guards (same root cause as S1)**
- (Merged into M1 — see S1.)

**T2 [Minor]: Stale line-range claim in Step 4 for `token-bridge-js-sync.test.ts`**
- File: plan §Step 4 second bullet
- Fix: reword to "Remove `TOKEN_BRIDGE_MSG_TYPE` from the import statement (line 3) and delete the `it(\"keeps hardcoded legacy MSG_TYPE aligned …\")` test case (lines 8–11)."

**T3 [Minor]: JSDoc rewrite direction in Step 4 is wrong (past tense vs. forward-looking)**
- File: plan §Step 4 third bullet
- Fix: replace "change to past tense or remove" with "rewrite to describe the BRIDGE_CODE_MSG_TYPE coverage that remains".

## Adjacent Findings

- **F7-A → Security**: covered by S1 (M1).
- **S6 → Functionality** (the citation is pre-existing in unchanged file): not applied in this PR; tracked as informational.

## Quality Warnings

None. merge-findings did not flag any [VAGUE], [NO-EVIDENCE], or [UNTESTED-CLAIM] entries.

## Recurring Issue Check

### Functionality expert
- R1 (Shared utility reimplementation): Checked — N/A. No new utilities.
- R2 (Constants hardcoded): Checked — no issue.
- R3 (Pattern propagation + Flagged-instance enumeration): Checked — verified all 8 active references; F1 covers the build-artifact non-issue.
- R4 (Event dispatch gaps): N/A.
- R5 (Missing transactions): N/A.
- R6 (Cascade delete orphans): N/A.
- R7 (E2E selector breakage): N/A — no E2E in repo.
- R8 (UI pattern inconsistency): N/A.
- R9 (Transaction boundary for fire-and-forget): N/A.
- R10 (Circular module dependency): Checked — N/A.
- R11 (Display group ≠ subscription group): N/A.
- R12 (Enum/action group coverage gap): N/A.
- R13 (Re-entrant dispatch loop): N/A — covered by §F5 doc.
- R14 (DB role grant completeness): N/A.
- R15 (Hardcoded env values in migrations): N/A.
- R16 (Dev/CI environment parity): N/A.
- R17 (Helper adoption coverage): N/A.
- R18 (Allowlist/safelist sync): N/A.
- R19 (Test mock alignment + Exact-shape assertion obligation): Checked — N/A.
- R20 (Multi-statement preservation in mechanical edits): N/A.
- R21 (Subagent completion vs verification): N/A.
- R22 (Perspective inversion for helpers): N/A.
- R23 (Mid-stroke input mutation): N/A.
- R24 (Migration additive+strict split): N/A.
- R25 (Persist/hydrate symmetry): N/A.
- R26 (Disabled-state visible cue): N/A.
- R27 (Numeric range in user-facing strings): N/A.
- R28 (Toggle label grammatical consistency): N/A.
- R29 (External spec citation accuracy): Checked — no issue (RFC 4122 §4.1.7 reference is pre-existing and accurate).
- R30 (Markdown autolink footguns): Checked — no issue.

### Security expert
- R1 (Shared utility reimplementation): N/A.
- R2 (Constants hardcoded): Checked — no issue.
- R3 (Pattern propagation + Flagged-instance enumeration): Checked — verified.
- R4–R28: N/A (same scope justification as Functionality).
- R29 (External spec citation accuracy): Checked — RFC 4122 citation accurate (pre-existing); RFC 9562 supersedes (Finding S6).
- R30 (Markdown autolink footguns): Checked — no issue.
- RS1 (Timing-safe comparison): N/A — no credential comparison introduced or modified.
- RS2 (Rate limiter on new routes): N/A — no new routes.
- RS3 (Input validation at boundaries): N/A — no new request parameters.

### Testing expert
- R1 (Shared utility reimplementation): N/A.
- R2 (Constants hardcoded): Checked — no issue.
- R3 (Pattern propagation + Flagged-instance enumeration): Checked — verified.
- R4–R28: N/A.
- R29 (External spec citation accuracy): Checked — no spec citations introduced.
- R30 (Markdown autolink footguns): Checked — no issue.
- RT1 (Mock-reality divergence): Checked — existing stubs remain valid after deletions.
- RT2 (Testability verification): Checked — proposed migrated tests callable in existing jsdom environment.
- RT3 (Shared constant in tests): Checked — no leftover literal `"PASSWD_SSO_TOKEN_RELAY"` in tests.

## Resolution Status

### M1 (S1 + T1 + F7-A) [Major] Coverage regression on shared `handlePostMessage` guards — Resolved
- Action: Plan §F3 / Implementation step 4 first bullet rewritten to require porting three guard tests (cross-origin, wrong-type, oracle-prevention) to bridge-code shape BEFORE deleting the legacy describe block. Testing strategy section updated with new test count math (10 retained vs. 14 current).
- Modified: docs/archive/review/cleanup-legacy-relay-and-audit-docs-plan.md §Implementation steps step 4, §Testing strategy.

### M2 (S2 + F4) [Major] F6 doc rewrite must mention audit-chain mechanism + correct path — Resolved
- Action: Plan §F5–F7 Technical approach + §Implementation steps step 7 rewritten. Now mandates that the security-review.md replacement paragraph cites (a) audit-chain tamper-evidence + verify endpoint, (b) full path `src/workers/audit-delivery.ts`, (c) qualifies WORM as "not implemented". F4 path correction subsumed.
- Modified: docs/archive/review/cleanup-legacy-relay-and-audit-docs-plan.md §Technical approach §F5–F7, §Implementation steps step 7.

### F1 [Minor] Build artifact `extension/dist/src/content/token-bridge.js` — Skipped (verified non-applicable)
- **Anti-Deferral check**: "acceptable risk" — verified non-applicable.
- **Justification**:
  - Worst case: a developer running a stale `extension build` sees `LEGACY_MSG_TYPE` in the dist file after the cleanup PR merges.
  - Likelihood: low — `extension/dist/` is gitignored AND not tracked (`git ls-files extension/dist/` returns empty; `.gitignore` includes `extension/dist/`). The artifact never enters any commit; no reviewer ever sees it via diff or `git status` post-cleanup.
  - Cost to fix: trivial in absolute terms but addresses a non-issue. Adding the recommended note would add maintenance instruction for a path that is already gitignored.
- **Orchestrator sign-off**: Verified via `grep -E '^extension/dist|/extension/dist' .gitignore` (matches `extension/dist/`) and `git ls-files extension/dist/` (empty). The "acceptable risk" exception applies — the three quantitative values are stated above. Per the project's gitignore + tracking state, the build artifact concern does not apply.

### F2 [Minor] Pin clarifying-sentence placement — Resolved
- Action: Plan §Implementation steps step 5 third sub-bullet now specifies "Insert one sentence as a paragraph immediately following the table (between the table and the next `## File Map` heading)" with explicit wording "After the 2026-04 cleanup the postMessage column is no longer reachable from any in-tree code; the column is retained for historical comparison."
- Modified: docs/archive/review/cleanup-legacy-relay-and-audit-docs-plan.md §Implementation steps step 5.

### F3 [Minor] NIL_UUID JSDoc rewrite drops historical guidance — Resolved
- Action: Plan §Technical approach §F8 now starts with "**Note**: previously this constant was documented as the audit `userId` placeholder; that guidance was superseded in 2026-04 by `ANONYMOUS_ACTOR_ID` / `SYSTEM_ACTOR_ID`. The single residual call site (`src/app/api/mcp/token/route.ts:125`) is tracked as TODO(actorId-rename)."
- Modified: docs/archive/review/cleanup-legacy-relay-and-audit-docs-plan.md §Technical approach §F8–F9.

### F5 [Minor] Steps 2-4 commit grouping — Resolved
- Action: Plan §Implementation steps now begins with explicit commit-grouping note: "Steps 2–4 MUST land in a single commit titled `refactor(extension): remove legacy PASSWD_SSO_TOKEN_RELAY postMessage path`."
- Modified: docs/archive/review/cleanup-legacy-relay-and-audit-docs-plan.md §Implementation steps preamble.

### F6 [Minor] Parallel comment block in `extension/src/lib/constants.ts` — Resolved
- Action: Plan §Implementation steps step 3 first sub-bullet expanded to also touch the `extension/src/lib/constants.ts` (lines 1–12) comment block, dropping "New token bridge" framing.
- Modified: docs/archive/review/cleanup-legacy-relay-and-audit-docs-plan.md §Implementation steps step 3.

### S3 [Minor] XSS hardening commit-message addition — Resolved
- Action: Plan §Risks now opens with `R0 (security hardening, not a risk)` paragraph capturing the XSS-asymmetry framing, instructing it be carried into the PR commit message body.
- Modified: docs/archive/review/cleanup-legacy-relay-and-audit-docs-plan.md §Risks.

### S4 [Minor] Worker dead-letter raw error message in metadata — Resolved
- Action: Plan §Technical approach §F5–F7 + §Implementation steps step 7 both now require adding one sentence in security-review.md noting the 256-char raw `lastError` bypasses METADATA_BLOCKLIST and that scrubbing is tracked as a follow-up.
- Modified: docs/archive/review/cleanup-legacy-relay-and-audit-docs-plan.md §Technical approach §F5–F7, §Implementation steps step 7.

### S5 [Minor] NIL_UUID anti-enumeration invariant — Resolved
- Action: Plan §Technical approach §F8 Secondary-use bullet now appends "This relies on the invariant that `users.id` is generated via `gen_random_uuid()` (UUIDv4) and therefore can never equal `NIL_UUID` — collision probability negligible."
- Modified: docs/archive/review/cleanup-legacy-relay-and-audit-docs-plan.md §Technical approach §F8–F9.

### S6 [Minor / Adjacent] RFC 4122 vs RFC 9562 — Skipped (out of scope, pre-existing)
- **Anti-Deferral check**: "out of scope (different feature)" — Adjacent to Functionality expert; pre-existing in unchanged file.
- **Justification**: The RFC 4122 §4.1.7 citation lives at `src/lib/constants/app.ts:10` in the existing JSDoc. PR-A only modifies the body of that JSDoc (lines 9–17 wholesale rewrite per F8), so technically the citation is being rewritten. However, the new wording does NOT cite an RFC at all (it describes use cases without standard references), so there is no NEW citation to verify. The original RFC 4122 §4.1.7 reference is preserved unchanged in the JSDoc opening line. Updating to RFC 9562 §5.9 (which supersedes RFC 4122) is a separate documentation refresh that touches every RFC 4122 citation in the repo, not just this one. TODO marker: `TODO(rfc-9562-refresh): replace RFC 4122 citations across the codebase with RFC 9562 references where applicable.` (To be added in a separate sweep PR; not grep-blocked by this PR.)
- **Orchestrator sign-off**: Verified the F8 rewrite preserves the existing RFC 4122 §4.1.7 line as-is (only adds new content below the line); no new RFC citation introduced. Out-of-scope status accepted.

### S7 [Minor] Preserve `extension_token_legacy_issuance` telemetry note — Resolved
- Action: Plan §Implementation steps step 5 third sub-bullet rewritten to require the F4 paragraph rewrite to retain the sentence about telemetry on the legacy POST endpoint continuing to feed the eventual endpoint-removal decision.
- Modified: docs/archive/review/cleanup-legacy-relay-and-audit-docs-plan.md §Implementation steps step 5.

### T2 [Minor] Line-range precision for `token-bridge-js-sync.test.ts` — Resolved
- Action: Plan §Implementation steps step 4 second sub-bullet now distinguishes "Remove `TOKEN_BRIDGE_MSG_TYPE` from the import statement (line 3)" and "delete the `it("keeps hardcoded legacy MSG_TYPE aligned …")` test case (lines 8–11)".
- Modified: docs/archive/review/cleanup-legacy-relay-and-audit-docs-plan.md §Implementation steps step 4.

### T3 [Minor] JSDoc rewrite direction in Step 4 — Resolved
- Action: Plan §Implementation steps step 4 third sub-bullet now reads "Rewrite the file's leading JSDoc (lines 11–14): replace 'covers the legacy string constant in the bundled JS' with 'covers `BRIDGE_CODE_MSG_TYPE` in the bundled JS' (forward-looking; do NOT use past tense)".
- Modified: docs/archive/review/cleanup-legacy-relay-and-audit-docs-plan.md §Implementation steps step 4.

---

## Round 2 Findings (all Minor; all wording-precision)

- **F8 (round 2) [Minor]**: §F8 wholesale rewrite originally dropped the RFC 4122 §4.1.7 first-line citation, contradicting S6 Skip justification. Resolved by prepending `> Nil UUID (RFC 4122 §4.1.7).` as the first line of the JSDoc replacement block.
- **S8 (round 2) [Minor]**: §F8 anti-enumeration wording said "collision probability negligible" — actually **structural impossibility** (UUIDv4 forces version=4 + variant=10, NIL_UUID has both zero). Resolved by replacing the trailing clause with structural-impossibility wording.
- **S9 (round 2) [Minor]**: §F8 secondary-use bullet relied on transitive FK invariant not stated. Resolved by appending "carries through `webAuthnCredential.userId` (and any other table) via the FK constraint to `users.id`."
- **S10 (round 2) [Minor]**: R0 in §Risks ambiguous about server-side single-use enforcement. Resolved by adding `/api/extension/token/exchange` reference and explicit "single-use enforcement is server-side, not in the extension".
- **T4 (round 2) [Minor]**: Net test count math was 14→10 instead of 15→11 (off by one in both terms). Resolved by correcting to "8 (bridge-code-specific) + 3 (shared-guard) = 11 cases retained, vs. the current 15".
- **T5 (round 2) [Minor]**: Ported test names duplicated deleted-block strings. Resolved by renaming to "rejects bridge code message from a different origin" / "rejects bridge code message with wrong type" / "does not respond to bridge code messages with invalid type (oracle prevention)".
- **T6 (round 2) [Trivial]**: Oracle-prevention test assertion list incomplete. Resolved by tightening to "assert `chrome.runtime.sendMessage` not called AND `mockFetch` not called".

## Round 3 Findings

All three experts returned **No findings**. The plan converged at Round 3.

- Functionality round 3: F8 (round 2) Resolved. No new issues.
- Security round 3: S8/S9/S10 (round 2) all Resolved. No new issues.
- Testing round 3: T4/T5/T6 (round 2) all Resolved. No new issues.

---

## Scope Expansion (post-Round-3, user-directed)

User flagged that the previously-Skipped S6-related entry "MCP refresh-token replay audit `userId` consistency fix" (`src/app/api/mcp/token/route.ts:125`) violated the anti-deferral 30-minute rule and should be pulled into this PR. Plan amended to add **F10**:

- `src/app/api/mcp/token/route.ts:125`: replace `userId: NIL_UUID` with `userId: resolveAuditUserId(null, "system")` and add `actorType: ACTOR_TYPE.SYSTEM`. Remove `NIL_UUID` from the file's import (no other use site).
- `src/app/api/mcp/token/route.test.ts:272-278`: extend the `expect.objectContaining({...})` block to assert `userId: SYSTEM_ACTOR_ID` and `actorType: "SYSTEM"`. (Import already exists at line 38.)
- §F8 JSDoc rewrite simplified: prescription is now "MUST NOT be used as audit `userId` placeholder" with no exception caveat (since F10 removes the one violator).
- Separate commit: `fix(mcp): use SYSTEM_ACTOR_ID for MCP_REFRESH_TOKEN_REPLAY audit (was NIL_UUID)`.

## Round 4 Findings (F10 focus)

- Functionality round 4: **No findings**. Verified F10 source/test line numbers, helper signature, enum value, §F8/§Out-of-scope consistency.
- Security round 4: **No findings**. Audit-log readers unaffected; SENTINEL_ACTOR_IDS exclusion impact is **positive** (replay events now properly grouped under `actorType=SYSTEM` instead of appearing as phantom `00000000-...` user); RLS path unchanged; metadata preservation confirmed; test addition catches regression.
- Testing round 4: **T-F10-1 [Minor]** — plan instructed to "add `SYSTEM_ACTOR_ID` import" but it already exists at `route.test.ts:38` (used by T3.1 ROTATE test). Plan would have caused duplicate-import error.

### T-F10-1 Resolution
- Action: amended plan step 11 to "Verified pre-existing: `SYSTEM_ACTOR_ID` is already imported at `route.test.ts:38` (used by the T3.1 `MCP_REFRESH_TOKEN_ROTATE` test at lines 312–337) — do NOT add a duplicate import."
- Modified: docs/archive/review/cleanup-legacy-relay-and-audit-docs-plan.md §Implementation steps step 11.

## Round 5 Findings

Testing round 5 (focused on T-F10-1 verification): **No findings**. Plan amendment confirmed; no conflicting "add import" wording elsewhere.

Plan converged at Round 5. Phase 1 complete.
