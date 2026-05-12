# Plan Review: unify-api-error-handling

Date: 2026-05-12
Review round: 1

## Changes from Previous Round

Initial review.

## Functionality Findings

### F1 — Major — Consumer-flow walkthrough paths are phantom

- File: plan §C2 Consumer walkthroughs (lines reference paths in src/lib/api/, src/components/auth/passphrase-input.tsx, src/components/passwords/key-version-conflict-dialog.tsx)
- Evidence: `src/lib/api/` directory does not exist; `src/lib/http/toast-api-error.ts` is the actual location. `passphrase-input.tsx` and `key-version-conflict-dialog.tsx` do not exist in repo; actual `lockedUntil` consumer is `src/components/vault/vault-lock-screen.tsx`.
- Problem: Plan reviewers MUST verify each consumer above has the listed fields satisfied; phantom paths make this un-verifiable.
- Fix: Replace with verified paths: Consumer A → `src/lib/http/toast-api-error.ts`; Consumer C → `src/components/vault/vault-lock-screen.tsx`; Consumer D → identify actual `currentKeyVersion` reader (only test site found in survey: `src/app/api/webauthn/credentials/[id]/prf/route.test.ts:152-165`).

### F2 — Major — `ITEM_KEY_VERSION_DOWNGRADE` wire shape claim is fictional

- File: plan §C2 Invariants (`currentKeyVersion` paired with CONFLICT or ITEM_KEY_VERSION_DOWNGRADE)
- Evidence: `src/lib/services/team-password-service.ts:361` throws `TeamPasswordServiceError(API_ERROR.ITEM_KEY_VERSION_DOWNGRADE, 400)` — no `currentKeyVersion` body field. Only `src/app/api/webauthn/credentials/[id]/prf/route.ts:223` returns `currentKeyVersion` (paired with `API_ERROR.CONFLICT`, status 409).
- Problem: Contract claims a wire shape no production route emits; violates "no behavioral change" non-functional req if interpreted as additive.
- Fix: Drop `ITEM_KEY_VERSION_DOWNGRADE` from the `currentKeyVersion`-pairing line in C2; document it as bare-code response with status 400.

### F3 — Major — audit-chain-verify:204 has bigger envelope violation than 422

- File: `src/app/api/maintenance/audit-chain-verify/route.ts:201-205`
- Evidence: returns `{ error: \`Seed row for chain_seq ${fromSeq - 1} not found — partial verification requires the preceding row\` }` (raw English template literal as `error` value). Status 422.
- Problem: C6 only discusses 422 vs 400; misses that the `error` field itself violates C2 invariant "always a member of API_ERROR". C2's forbidden-pattern grep (`error:\s*"[a-z]`) is lowercase-leading only — uppercase "Seed..." slips through.
- Fix: Add to C6 scope: convert audit-chain-verify:204 to `errorResponse(API_ERROR.<new code>, 422 or 400)` with a proper enum member (e.g., new `CHAIN_SEED_NOT_FOUND`). Extend C2's forbidden-pattern grep to catch uppercase strings containing whitespace.

### F4 — Major — RFC 6749 §5.2 vs §4.1.2.1 citation error

- File: plan "Technical approach" envelope table row 2 + C9
- Evidence: RFC 6749 §5.2 (token endpoint) defines: `invalid_request`, `invalid_client`, `invalid_grant`, `unauthorized_client`, `unsupported_grant_type`, `invalid_scope`. The plan adds `access_denied` and `temporarily_unavailable` to §5.2, but those are defined in §4.1.2.1 (authorization endpoint). `slow_down` is RFC 8628 §3.5.
- Problem: R29 (External spec citation accuracy). Once codified in `docs/api/error-handling.md`, wrong §5.2 will mislead authors. Critical when citation drives a security decision (the C9 disposition rests on it).
- Fix: Split citation: "token endpoint per RFC 6749 §5.2 (six codes listed); authorization endpoint per RFC 6749 §4.1.2.1 (`access_denied`, `temporarily_unavailable`, `server_error`); device flow per RFC 8628 §3.5." Fix C9 's `temporarily_unavailable` citation from §5.2 to §4.1.2.1.

### F5 — Major — ACCOUNT_LOCKED is 403, not 423

- File: plan status-code table line 107 + C7
- Evidence: `src/app/api/vault/unlock/route.ts:47-48` returns status **403**; `:105-107` also 403; `src/app/api/travel-mode/disable/route.ts:36-37` also 403.
- Problem: Plan's status table says "423 ACCOUNT_LOCKED (currently uses 423; verify under C7)" — wrong. Internal inconsistency between table and C7.
- Fix: Drop 423 row entry for ACCOUNT_LOCKED. Update C7: "Current status: 403 (3 sites). Documented as canonical."

### F6 — Minor — Cache-Control: no-store in C5 is a wire change

- File: plan §C5 Invariants
- Evidence: current code at `src/lib/auth/policy/access-restriction.ts:242,262,282` and `src/lib/proxy/api-route.ts:114` returns no Cache-Control header. Plan introduces `Cache-Control: no-store`.
- Problem: Contradicts "no behavioral change visible" non-functional requirement.
- Fix: Either drop the header from C5 OR explicitly call it out as additive in "Considerations / risks".

### F7 — Minor — `details: unknown` type conflates wire shape vs helper input

- File: plan §C2 type union
- Evidence: `src/lib/http/api-response.ts:30` — `details?: Record<string, unknown>` (helper input). Wire shape has `details: <tree>` where tree is `unknown`.
- Problem: Plan reviewers confuse two distinct things.
- Fix: Add example distinguishing the two: `errorResponse(API_ERROR.VALIDATION_ERROR, 400, { details: z.treeifyError(err) })` → wire `{ error: "VALIDATION_ERROR", details: <tree> }`.

### F8 — Minor — ApiErrors i18n-coverage test absent

- File: plan "Known risks" #2
- Evidence: only `src/__tests__/audit-i18n-coverage.test.ts` exists (for `AuditLog.json`). No ApiErrors-specific coverage test. The `messages-consistency.test.ts` (Testing's T2) does enforce locale parity but not per-namespace coverage from the TS map.
- Problem: TS-side `satisfies` enforces map populated; JSON-side has no compile-time enforcement. Missing JSON key → `t()` echoes key string to UI.
- Fix: Add `src/__tests__/api-errors-i18n-coverage.test.ts` to Testing strategy: for every value in `API_ERROR_I18N`, assert presence in both en+ja ApiErrors JSON.

### F9 — Minor — Wrong directory in file path

- File: plan §C5 (`src/lib/policy/access-restriction.ts`)
- Evidence: actual path `src/lib/auth/policy/access-restriction.ts`.
- Fix: replace all references.

### F10 — Minor — RFC 6750 §3.1 in C9 TODO is wrong scope

- File: plan §C9 TODO marker
- Evidence: RFC 6750 §3.1 is the WWW-Authenticate Bearer challenge header (resource-server error format), not OAuth token/revoke endpoint body.
- Fix: Drop RFC 6750 §3.1 from the TODO; cite RFC 6749 §5.2 + RFC 7009 §2.2.

### F11 — Minor — well-known endpoint inconsistency

- File: plan "Technical approach" table vs C1 Invariants
- Evidence: `/api/mcp/.well-known/oauth-authorization-server` appears in C1 §Invariants but not in the technical-approach table.
- Fix: align both sides.

## Security Findings

### S1 — Minor — ACCOUNT_LOCKED status documentation

(Same as F5; merged.)

### S2 — Minor — RFC citation accuracy + RFC 7009 §2.2 "always 200" rule

- Problem: C9 cites RFC 6749 §5.2 codes incorrectly (overlaps F4). Additionally, RFC 7009 §2.2 says revoke "MUST respond with HTTP status code 200 if the token has been revoked successfully or if the client submitted an invalid token" — a 429 wire response itself is a non-compliance.
- Fix: Rewrite C9 RFC analysis: cite §5.2 codes correctly; note RFC 7009 §2.2 "always 200" rule; frame existing 429 as deliberate abuse-mitigation deviation; drop `temporarily_unavailable`/`slow_down` recommendation.

### S3 — Minor — SESSION_STEP_UP_REQUIRED is 401, deviates from RFC 9470

- Evidence: RFC 9470 (Step Up Authentication Challenge Protocol) recommends 403 + `WWW-Authenticate: insufficient_user_authentication`. Plan documents 401 as canonical.
- Problem: A naïve bearer-token client receiving 401 may discard session and re-authenticate at AAL1, defeating step-up. Documentation-correctness issue.
- Fix: Add footnote in `docs/api/error-handling.md`: "401 used today, deviates from RFC 9470; clients MUST dispatch on code, not HTTP status; migration to 403 tracked separately."

### S4 — Minor — Anonymous-route enumeration codes (share links)

- Evidence: `share-links/verify-access/route.ts:95` (`SHARE_PASSWORD_INCORRECT` 403), `share-links/[id]/content/route.ts:30` (`SHARE_PASSWORD_REQUIRED` 401), `NOT_FOUND` 410 for revoked/max-views.
- Problem: Codifying these distinct codes in a public spec accelerates enumeration tool-building. Pre-existing behavior; not changed by plan.
- Fix: Add one-line note to `docs/api/error-handling.md` § "Adding a new error code": codes on pre-auth/anonymous-callable routes should err toward generality.

### S5 — Minor — applyCorsHeaders wrapper preservation in C5

- Evidence: `src/lib/proxy/api-route.ts:111` wraps the access-restriction 403 in `applyCorsHeaders(request, ...)`. C5 migration to `errorResponse(...)` must preserve this wrapping or browser cross-origin clients lose CORS headers.
- Fix: Add to C5 Invariants: "existing `applyCorsHeaders(request, ...)` wrapping MUST be preserved".

### S6 — Minor — Generic i18n copy for INVALID_CHALLENGE

- Evidence: plan Scenario 2 proposes "The security key challenge expired. Please retry." (en) — same information that was just removed from the wire.
- Fix: Use generic copy: "Security key registration could not be completed. Please retry." (en) / equivalent ja. Don't differentiate expired/replayed/missing-from-redis.

## Testing Findings

### T1 — Critical — Hardcoded code-count assertion will break

- File: `src/lib/http/api-error-codes.test.ts:121`
- Evidence: `expect(Object.keys(API_ERROR).length).toBe(147)` — hardcoded count. Inline comment at :119-120 documents this as a manual-update tripwire.
- Problem: Plan adds 2 codes (ACCESS_DENIED, INVALID_CHALLENGE); count becomes 149. Vitest fails. Plan's "tests pass without modification" claim is wrong for this file.
- Fix: Add to Testing strategy: update count from 147 → 149 (or current at PR time).

### T2 — Major — `messages-consistency.test.ts` is the runtime guard

- File: `src/i18n/messages-consistency.test.ts:62` — "keeps key sets aligned between locales per namespace"
- Problem: Plan calls out TS-side `satisfies` constraint but not this runtime guard. A reviewer misses the diagnostic source.
- Fix: Add to Testing strategy C5/C6: "verify messages-consistency.test.ts passes — adding `accessDenied` + `invalidChallenge` to BOTH en+ja ApiErrors JSON is required."

### T3 — Major — Inline mocks of api-error-codes will drift

- Evidence: 15+ test files inline-mock `@/lib/http/api-error-codes` with curated subsets. `src/app/api/webauthn/register/verify/route.test.ts:92` mocks only 5 codes — does NOT include `INVALID_CHALLENGE`. After C6, production reads `API_ERROR.INVALID_CHALLENGE === undefined` under this mock.
- Problem: Production calls `errorResponse(API_ERROR.INVALID_CHALLENGE, ...)` → `error` field becomes `undefined` (or stringified). New C6 test could falsely pass.
- Fix: Add to Testing strategy C6: update webauthn mock to include `INVALID_CHALLENGE: "INVALID_CHALLENGE"`. Assert against literal `"INVALID_CHALLENGE"` to protect against drift.

### T4 — Major — Existing webauthn tests need updating

- File: `src/app/api/webauthn/register/verify/route.test.ts` (expired-challenge test, line ~413-422)
- Evidence: existing test asserts `expect(json.error).toBe("VALIDATION_ERROR")` for the expired-challenge path. C6 converts this path to INVALID_CHALLENGE.
- Problem: Test fails after C6 if not updated. Plan's "add new test" wording implies no existing modification.
- Fix: Add to Testing strategy C6: "update existing assertion in route.test.ts (expired-challenge test) from VALIDATION_ERROR → INVALID_CHALLENGE; leave the other two VALIDATION_ERROR assertions (`verifyRegistration throws`, `verified === false`) unchanged."

### T5 — Minor — C8 OpenAPI enum test file location

- File: existing `src/lib/openapi-spec.test.ts` (asserts `schema.required` at :158)
- Fix: Name the file in C8 acceptance — add an `it(...)` block inside the existing `describe("components.schemas")` group. Also assert closure (enum ⊆ API_ERROR values).

### T6 — Minor — Build command should be `scripts/pre-pr.sh`

- Evidence: project's canonical pre-PR command is `scripts/pre-pr.sh` (with 11+ static checks). Plan uses `npm run lint && npx vitest run && npx next build` — bypasses several CI gates.
- Fix: Replace plan's command with `scripts/pre-pr.sh MUST pass`.

### T7 — Minor — Grep checklist not test-enforced

- Problem: Plan's "Non-functional req #2" says "MUST be enforceable by grep/ESLint pattern" but no grep gate is added to `pre-pr.sh`.
- Fix: Add a small shell-script check (`scripts/checks/check-api-error-codes.sh`) to pre-pr.sh, covering at minimum the C5 ACCESS_DENIED literal grep and C2's lowercase-leading + C2's new uppercase-with-whitespace pattern (from F3 fix). 5-line shell; closes Non-functional req #2.

## Adjacent Findings

- [Adjacent] (from Functionality, routes to Testing): C2 forbidden pattern `error:\s*"[a-z]` doesn't catch uppercase English strings. Extending the regex is testing-design adjacent.
- [Adjacent] (from Functionality, routes to Security): C6's `details: "Challenge expired..."` string may have been intentional for developer hints; removing without preserving observability could degrade.
- [Adjacent] (from Testing, informational): 15 inline mocks of api-error-codes are a structural drift risk; out of scope for this plan but warrants a follow-up.

## Quality Warnings

None.

## Recurring Issue Check

### Functionality expert (F1-F11)

- R1: Checked — no issue (plan/spec split appropriate)
- R2: Checked — no issue (scope-decision lock explicit)
- R3: Finding F4, F10
- R4: Checked — no issue
- R5: Finding F7
- R6: Checked — no issue
- R7: Checked — no issue
- R8: Finding F3
- R9: Checked — no issue
- R10: Finding F1
- R11-R18: Checked — no issue
- R19-R22: Checked — no issue
- R23: Finding F11
- R24: Checked — no issue
- R25: Finding F9
- R26-R28: Checked — no issue
- R29: Findings F4, F10
- R30-R32: Checked — no issue
- R33: Finding F6
- R34-R37: Checked — no issue

### Security expert (S1-S6)

- R1-R19: Checked — no issue or N/A
- R20: Findings S4, S6
- R21: Finding S4
- R22: Finding S3
- R23: Findings S1, S3
- R24-R28: Checked — no issue
- R29: Finding S2
- R30: Finding S5
- R31-R37: Checked — no issue or N/A
- RS1-RS4: N/A or Checked — no issue

### Testing expert (T1-T7)

- R1-R37: see below
- RT1 (Mock-reality divergence): Findings T3, T4
- RT2 (Testability): Finding T5
- RT3 (Shared constants in tests): not hit (wire-string assertion is correct)
- RT4 (Race-test vacuous-pass): N/A
- RT5 (Production primitive in test call path): N/A
- R19 (Test mock alignment): Finding T3
- i18n-coverage: Findings T2, F8
- Build-verification command: Finding T6
- Hardcoded count tripwire: Finding T1

## Round 1 Summary

- Functionality: Critical 0 / Major 5 / Minor 6
- Security: Critical 0 / Major 0 / Minor 6
- Testing: Critical 1 / Major 3 / Minor 3

Total unique findings (after dedup of F5↔S1, F4↔S2 overlap): Critical 1 / Major 7 / Minor 13

All findings actionable. Plan to be updated in Round 2.

---

# Plan Review: unify-api-error-handling (Round 2)

Date: 2026-05-12
Review round: 2

## Changes from Previous Round

Plan updated per Round 1 findings: F1-F11, S1-S6, T1-T7 addressed.

## Functionality Findings (Round 2)

### F1 (partially resolved)

Consumer A and Consumer C paths corrected. BUT Consumer B (share-password-gate.tsx:67) is still phantom (line 67 reads `accessToken`, not `error`; the override pattern is only in tests). Consumer E's `proxy.test.ts` assertion of `retryAfterMs` does not exist. Consumer F path is wrong direction.

### F2 (partially resolved)

C2 main-envelope correctly excises `ITEM_KEY_VERSION_DOWNGRADE` from `currentKeyVersion` pairing. BUT C8 OpenAPI schema (line 363) still says `currentKeyVersion: Present only on CONFLICT or ITEM_KEY_VERSION_DOWNGRADE`.

### F12 (Major, new in round 2) — `SESSION_STEP_UP_REQUIRED` is 403, not 401

- Production sites: `src/lib/auth/session/step-up.ts:48`, `src/lib/auth/webauthn/recent-passkey-verification.ts:52,56` all return **403** via `errorResponse(errorCode, 403)`.
- Plan claims 401 in status table line 116 and prose line 140.
- The "RFC 9470 deviation" block was written backwards: RFC 9470 §3 actually specifies **401 + WWW-Authenticate**, not 403. Plan's R29 violation.

### F13 (Major, new in round 2) — `retryAfterMs` body field is documented but never emitted

- Verified at `src/lib/http/api-response.ts:58-64`: the `rateLimited()` helper emits ONLY the `Retry-After` HTTP header (seconds, ceiling-rounded), never spreads into the body.
- All call sites pass `retryAfterMs` through `rateLimited()`. No body emission exists.
- C2 ContextField union, C8 OpenAPI schema, and Consumer E's `proxy.test.ts` reference are all fabricated.

### F14 (Major, new in round 2) — `lockedUntil` is `string | null`, not `string`

- Prisma-typed `LockoutStatus.lockedUntil: Date | null` (per `src/lib/auth/policy/account-lockout.ts:112,117`). After `JSON.stringify`, the wire shape is `string | null`.
- Consumer C's `formatLockedUntil(lockedUntil: string | null | undefined, ...)` at `vault-lock-screen.tsx:27` already tolerates null.
- C2's stricter `{ lockedUntil: string }` contradicts runtime reality.

### F15 (Major, new in round 2) — C5 migration silently drops `Cache-Control: no-store` at `api-route.ts:115`

- Actual code at `src/lib/proxy/api-route.ts:111-117` sets `headers: { "Cache-Control": "no-store" }` today.
- C5 proposed `errorResponse(API_ERROR.ACCESS_DENIED, 403)` (3-arg) which would emit no Cache-Control.
- Risk #7's claim "current code... does not set this header" is wrong for the proxy site.

### F16 (Minor, new in round 2) — C5 vs C6 count arithmetic disagree (also T8)

- C5: "149 after C5+C6"
- C6: "147 + 3 = 150" but then sets target to 149
- Correct arithmetic: 147 + 3 = 150.

### F17 (Minor, new in round 2) — Plan claims "193 codes" but actual is 147

- Plan Objective: "193 codes"; Risk #4: "~196 codes (193 + 3 new)"
- Actual count: 147 (asserted at `api-error-codes.test.ts:121`).

## Security Findings (Round 2)

**No new findings**. All Round 1 findings (S1-S6) correctly resolved.

## Testing Findings (Round 2)

### T1-T7 (Resolution verification): all resolved

### T8 (Major, new in round 2) — Arithmetic disagreement (same as F16)

### T9 (Major, new in round 2) — Audit-chain-verify test must be ADDED, not "updated"

- Verified: `src/app/api/maintenance/audit-chain-verify/route.test.ts` does not exercise the `fromSeq` seed-row branch (grep for "fromSeq" / "seed" returns zero hits).
- Plan's "update or add" lets implementer skip the test. Change to "ADD".

### T10 (Major, new in round 2) — C8 closure assertion is tautological

- Under planned construction `enum: Object.values(API_ERROR)`, both directions of subset check are tautological.
- Pick one: drop the closure assertion (planned construction makes it impossible to fail) OR justify via comment.

### T11 (Minor, new in round 2) — messages-consistency.test.ts line :62 → :63

- Verified at the file: the `it("keeps key sets aligned between locales per namespace", ...)` block starts at line **63**, not 62.

### T12 (Minor, new in round 2) — C5 "8 test files" not enumerated

- Plan does not list which 8 files; reviewer cannot verify the claim mechanically.

### T13 (Minor, new in round 2) — Literal-vs-enum rule should propagate to new test

- C6:310 documents the rationale for webauthn; should be cross-referenced for the new audit-chain-verify test added under T9.

## Round 2 Summary

- Functionality: Critical 0 / Major 5 / Minor 2 (F1 partial, F2 partial, F12, F13, F14, F15, F16, F17)
- Security: Critical 0 / Major 0 / Minor 0 (all resolved)
- Testing: Critical 0 / Major 3 / Minor 3 (T8, T9, T10, T11, T12, T13)

Plan severity: 7 Major findings — several are fabrications (F12, F13, F17) caught by the experts' actual-code verification. Plan to be substantially updated in Round 3 before locking the gate.

All Round 2 findings to be addressed.

---

# Plan Review: unify-api-error-handling (Round 3)

Date: 2026-05-12
Review round: 3

## Changes from Previous Round

Round 2 findings (F12-F17, T8-T13) applied. New cascade findings discovered during Round 3.

## Findings (Round 3)

### Functionality

- F12-F17 verified resolved (status table 403, retryAfterMs removed from C2, lockedUntil null-tolerant, Cache-Control per-site, count 147).
- **F18 (Major)**: C4 invariants still listed `retryAfterMs` as a permitted body field — cascade from F13 incomplete propagation. **FIXED** in Round 3: C4 now explicitly enumerates 3 body fields + the `Retry-After` header.
- **F19 (Minor)**: C2 invariant "two above" wording. **FIXED**: now explicit "details, lockedUntil, currentKeyVersion".
- **F20 (Minor)**: C5 Invariant still cited "8 test files". **FIXED**: now references the Testing-strategy enumeration.
- **F21 (Minor)**: AUDIT_ACTION path. **FIXED**: `src/lib/audit/audit.ts` → `src/lib/constants/audit/audit.ts`.
- **F22 (Minor)**: access-restriction.ts audit emission line ranges. **FIXED**: function call at 176/252/272, AUDIT_ACTION arg at 177/253/273, response at 242/262/282.
- **F23 (Minor)**: access-restriction.test.ts path. **FIXED**: `src/__tests__/lib/access-restriction.test.ts` (the file exists; the `src/lib/access-restriction.test.ts` path is wrong).
- **F24 (Minor)**: api-route.test.ts ACCESS_DENIED sites. **FIXED**: now includes :272 (4 sites: 210, 227, 250, 272).
- **F25 (Minor)**: audit-chain-verify prose line. **FIXED**: :204 → :203 (template literal line; status line is at 204).

### Testing

- T8-T13 verified resolved.
- **T14 (Major)**: same as F18 cascade. **FIXED**.
- **T15 (Major)**: C10 outline §3.2 still listed `retryAfterMs`. **FIXED**: now lists 3 body fields plus the `Retry-After` header.
- **T16 (Minor)**: C4 Acceptance "four fields". **FIXED**: "three body fields plus the `Retry-After` header for RATE_LIMIT_EXCEEDED".
- **T17 (Minor)**: C8 test label "shape-and-length". **FIXED**: "set-equality".
- **T18 (Minor)**: C2 "two above" wording (same as F19). **FIXED**.

### Security

No Round 3 review needed — Round 2 security findings were 0, and Round 3 changes are all cascade citation fixes with no security surface.

## Round 3 Summary

All Round 1 + Round 2 + Round 3 findings resolved. Plan is internally consistent, all citations verified against actual code, all contracts have actionable acceptance criteria.

- Functionality: Critical 0 / Major 0 / Minor 0 (Round 3 fixes applied)
- Security: Critical 0 / Major 0 / Minor 0 (clean since Round 2)
- Testing: Critical 0 / Major 0 / Minor 0 (Round 3 fixes applied)

Plan is ready for Go/No-Go gate transition. Contracts to be flipped to `locked`.


