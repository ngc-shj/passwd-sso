# Plan Review: extension-dpop-sender-constrained

Date: 2026-05-24
Review round: 1

## Changes from Previous Round

Initial review.

## Functionality Findings

### F1 [Critical] — `POST /api/extension/token/refresh` silently strips `cnfJkt` from refreshed rows
- **File**: `src/app/api/extension/token/refresh/route.ts:114-141`
- **Evidence**: The refresh route writes a new ExtensionToken row directly (NOT via `issueExtensionToken`) and never carries `cnfJkt` forward.
- **Problem**: A sender-constrained BROWSER_EXTENSION token, after refresh (~idleMinutes - 2 min), gets replaced with a new row whose `cnfJkt = NULL`. Falls into legacy bearer-only path. Goal B silently downgrades within hours.
- **Impact**: Defeats Goal B for any token older than ~58 min. No audit signal — downgrade is invisible.
- **Fix**: Add contract (C10) "refresh-rotation preserves cnfJkt" with integration test. Requires F3 (ValidatedExtensionToken exposes cnfJkt).

### F2 [Critical] — Extension `attemptTokenRefresh` and `revokeCurrentTokenOnServer` bypass swFetch
- **File**: `extension/src/background/index.ts:441-490` (refresh) and `492-508` (revoke)
- **Evidence**: Both functions call `fetch()` directly with Bearer only; never invoke `swFetch`.
- **Problem**: Plan C8 attaches DPoP via `swFetch`, but refresh + revoke don't use `swFetch`. Refresh returns 401, `clearToken()` fires, user signed out ~58 min after connect.
- **Impact**: DPoP-aware extension appears broken to every user.
- **Fix**: Update C8 to enumerate ALL bearer-using fetch sites; extract `swFetchAuthenticated()` helper.

### F3 [Major] — `ValidatedExtensionToken` doesn't expose `cnfJkt`
- **File**: `src/lib/auth/tokens/extension-token.ts:18-26`
- **Fix**: Add `cnfJkt: string | null` to `ValidatedExtensionToken` and populate from the token row already loaded.

### F4 [Major] — Exchange response does not return `cnfJkt`
- **File**: `src/app/api/extension/token/exchange/route.ts:189-196`
- **Fix**: Add contract C3b "Exchange response carries cnfJkt": response schema additive, `TokenIssueResponseSchema` update, `SET_TOKEN` message extension, `SessionState` extension. Same applies to refresh.

### F5 [Major] — AUDIT_ACTION lacks signal for DPoP-bound vs legacy bearer issuance
- **File**: `src/lib/constants/audit/audit.ts:169-171`
- **Fix**: Decision required — Option A (metadata.cnfBound on existing actions) OR Option B (distinct EXTENSION_TOKEN_EXCHANGE_SUCCESS_DPOP action with R12 sync obligations).

### F6 [Major] — C5 "extract shared body" understates iOS divergence (lastUsedIp/UA)
- **File**: `src/lib/auth/tokens/extension-token.ts:129-157` + `src/lib/auth/tokens/mobile-token.ts:271-283`
- **Fix**: C5 specifies (a) helper file `src/lib/auth/tokens/dpop-validate.ts`, (b) clientKind-dependent options toggling lastUsedIp/UA update, (c) explicit no-cycle requirement.

### F7 [Major] — C9 `requestExtensionJkt` helper undeclared
- **File**: `src/components/extension/auto-extension-connect.tsx:50-76`
- **Fix**: Add contract C9a: file path, function signature, origin/source filter, reqId-match filter, timeout cleanup, forbidden patterns.

### F8 [Minor] — C4 doesn't explicitly state `clientKind` handling
- **Fix**: C4 acceptance: "clientKind continues to be omitted from create payload; default applies."

### F9 [Minor] — `extension-constants-sync.test.ts` doesn't assert new message-type constants
- **Fix**: Add test file to plan file list + two `expect(extractStringConst(...))` assertions in C7.

### F10 [Minor] — NFR4 "≤ 5 ms p99" overhead claim unsubstantiated for cold-path
- **Fix**: Split warm-path / cold-path SLOs.

## Security Findings

### S1 [Critical] — Refresh route silently STRIPS `cnfJkt` (DUPLICATE of F1)
- escalate: true — silent token downgrade nullifies entire plan
- Combined with F1; addressed by new contract C10.

### S2 [Critical] — CORS Allow-Headers does NOT advertise `DPoP`; preflight blocks
- **File**: `src/lib/http/cors.ts:67`
- **Evidence**: `corsHeaders` returns `"Access-Control-Allow-Headers": "Content-Type, Authorization"`.
- **Impact**: Entire DPoP-bound path non-functional from extension. Deployment-blocker.
- **Fix**: Add new contract C11 — `DPoP` in Allow-Headers + cors-gate.test.ts assertion.
- escalate: true — plan ships unrunnable extension code

### S3 [Major] — Backward-compat path = attacker-selectable downgrade
- **File**: Plan threat-model + NFR1/NFR2
- **Evidence**: NFR2 says cnfJkt-less bridge-codes still succeed. XSS issues bridge-code with empty body → bearer to exfil.
- **Impact**: "BROWSER_EXTENSION tokens sender-constrained" is FALSE for tokens attacker chooses.
- **Fix options**: (a) tenant kill-switch policy, (b) per-user upgrade detection, OR (c) document limitation in threat-model table.
- **USER DECISION REQUIRED** — apply, defer, or downgrade.

### S4 [Major] — htu canonicalization equivalence asserted, not enforced
- **File**: Plan C6 + `src/lib/auth/dpop/htu-canonical.ts:42-47`
- **Fix**: (1) Extract `canonicalHtuClient(serverUrl, route)` shared helper. (2) Add serverUrl validator in Options. (3) Smoke test confirming equivalence.

### S5 [Major] — Step-up gate behavior not pinned in plan
- **File**: `src/app/api/extension/bridge-code/route.ts:46`
- **Fix**: C2 invariants add "requireRecentCurrentAuthMethod unchanged regardless of cnfJkt." C2 forbidden patterns add: removal of the call.

### S6 [Minor] — Manual "Reset connection" should server-side revoke cnfJkt-bound tokens
- **Fix**: C6 lifecycle adds server-side revoke OR documents limitation.

### S7 [Minor] — iat skew + Nonce omission: same-payload-capture replay within 30s
- **Fix**: Update threat-model row for "Captured at network MITM" to clarify ~30s window.

### S8 [Minor] — Forbidden-pattern coverage for outer string compare in C5
- **Fix**: C5 forbidden patterns add: manual `===`/`!==` of row.cnfJkt vs proof.jkt outside verifier.

### S9 [Minor] — RFC 9449 sections cited verified accurate
- No drift. Pass.

### S10 [Minor] — VARCHAR(64) for cnf_jkt over-sized but consistent
- Pass. No finding.

## Testing Findings

### T1 [Critical] — Extension `dpop-key.test.ts` cannot run in current vitest config
- **File**: `extension/vitest.config.ts`
- **Fix**: Add `fake-indexeddb` to extension devDeps. Add `environmentMatchGlobs` or `import "fake-indexeddb/auto"` at top of test. Document IDB shim in plan.

### T2 [Critical] — Mocked `DpopVerifyResult` shape vs C5 error-code mismatch
- **File**: `src/lib/auth/tokens/mobile-token.ts:229`
- **Evidence**: iOS branch returns `EXTENSION_TOKEN_DPOP_INVALID` not `EXTENSION_TOKEN_INVALID`.
- **Fix**: (1) Reconcile C5 error union to include `EXTENSION_TOKEN_DPOP_INVALID`. (2) Use `it.each([...DPOP_VERIFY_ERROR...])` to enumerate all 7 failure codes.

### T3 [Major] — Integration test "real verifier" requirement not pinned
- **File**: `src/__tests__/integration/mobile-dpop-flow.integration.test.ts:10-13`
- **Fix**: Add sentinel comment "// I-T3-1: real verifier sentinel — do NOT vi.mock('@/lib/auth/dpop/verify')" + use `jwkThumbprint()` to compute real thumbprint from generated key.

### T4 [Major] — Vacuous-pass guard asymmetric
- **Fix**: For SUCCESS: `toHaveBeenCalledTimes(1)` + `toHaveBeenCalledWith(expect.objectContaining({ expectedCnfJkt: <expected> }))`. For LEGACY (cnfJkt=null): `not.toHaveBeenCalled()`.

### T5 [Major] — Existing `extension-token` mock breaks when `validateExtensionTokenDpop` added
- **File**: `src/__tests__/lib/auth-or-token.test.ts:19-22`
- **Fix**: Plan must grep `vi.mock('@/lib/auth/tokens/extension-token')` and update. Recommend `vi.importActual` to spread real exports.

### T6 [Major] — Audit action coverage missing for new flows (DUPLICATE of F5)
- Combined with F5. Same decision required: Option A or B.

### T7 [Major] — Playwright cannot load Chrome extensions in current config
- **File**: `e2e/playwright.config.ts`
- **Fix options**: (a) New project entry using `launchPersistentContext` + extension build + `--load-extension`, OR (b) Downgrade ambition to stubbed-extension test.
- **USER DECISION REQUIRED** — scope of E2E coverage.

### T8 [Minor] — E2E selector phantom-match guard wrong surface
- **Fix**: Replace with network-observability assertion: `page.on('request', ...)` + `req.headers()['dpop']` check.

### T9 [Minor] — `npm run test:integration` discovery unverified
- **Fix**: Add to Pre-PR.

### T10 [Minor] — Extension boot test acceptance loose
- **Fix**: Tighten to 3 observations: (1) IDB store + non-extractable key, (2) SW restart reuses thumbprint, (3) DPoP header on /api/passwords.

### T11 [Minor] — `bridge-code-cnfJkt.test.ts` strict-mode assertion not specified
- **Fix**: Add `{cnfJkt: valid, unknown: 'x'} → 400` case.

### T12 [Minor] — Race-test for first-key generation singleton not in plan
- **Fix**: Add `Promise.all([getOrGenerate...(), getOrGenerate...()])` test with `toBe(1)` cardinality.

### T13 [Minor] — Manual test plan adversarial section under-scoped
- **Fix**: Add cross-tenant, replay across browsers, mid-session key rotation, iat-skew clock attack.

### T14 [Minor] — Test file location inconsistency note
- **Fix**: Note db-integration/ vs integration/ rationale.

## Adjacent Findings

### F-A1 [Adjacent — Testing]: Plan testing strategy lacks F1/F2 regression coverage
- Routed to Testing; covered by C10 integration test (F1 fix) and extension test for swFetch DPoP attachment (F2 fix).

### [Adjacent — Functionality from T2]: C5 error-code mismatch with iOS reality
- Routed to Functionality; covered by F1/F2 dependency on extending ValidatedExtensionToken (F3).

### [Adjacent — Security from T4]: Timing-uniform `unauthorized()` correct; internal verifier timing deltas may exist
- No action — existing verifier is timing-safe at the credential-comparison surface (verified at verify.ts:248).

## Quality Warnings

Ollama merge-findings flagged these for VAGUE / NO-EVIDENCE; each was traced to a concrete file:line during expert investigation:
- S3 — evidence: NFR1/NFR2 in plan; XSS attack vector documented in plan threat model (just not flagged as a residual)
- T4 — evidence: plan line 476
- F10 — evidence: plan §NFR4
- S6 — evidence: plan §C6 lifecycle
- S7 — evidence: verify.ts:106 (skew) + jti-cache.ts:47 (TTL)
- S8 — evidence: plan §C5 + verify.ts:248
- T8 — evidence: plan line 481
- T9-T14 — evidence: plan §Testing strategy / Pre-PR sections

No findings are dropped on quality grounds.

## Recurring Issue Check

### Functionality expert
- R1: checked (no reimplementation)
- R2: checked (NFR-1 noted in pre-screen)
- R3: F1, F2 (cnfJkt propagation gaps)
- R4: F5 (mutation lacks differentiated audit)
- R5: N/A
- R6: N/A
- R7: N/A (phantom-match guard mentioned)
- R8: N/A
- R9: N/A
- R10: related to F6 (circular dep risk)
- R11: N/A
- R12: related to F5
- R13: N/A
- R14: N/A
- R15: checked
- R16: N/A
- R17: F2, F6
- R18: N/A
- R19: checked
- R20: N/A
- R21: N/A at plan stage
- R22: F2 (inverted perspective)
- R23-R30: N/A or not applicable
- R31: N/A
- R32: checked (boot test mentioned)
- R33: N/A
- R34: F1, F2 (adjacent pre-existing pattern)
- R35: checked (Tier-2 manual test)
- R36-R37: N/A

### Security expert
- R1: checked; S4 flags missing extraction
- R2: checked
- R3: N/A (cookieless route by design)
- R4: checked
- R5: checked
- R6: checked
- R7: S8
- R8: checked
- R9: checked
- R10: checked
- R11: S1 (schema downstream)
- R12: checked
- R13: checked
- R14: checked
- R15-R16: N/A
- R17: checked
- R18: checked
- R19: S3 (workaround framing)
- R20-R22: N/A
- R23: N/A
- R24: N/A
- R25: N/A
- R26: N/A
- R27: S3 (deferral framed as tech decision)
- R28-R30: N/A
- R31: checked (plan location)
- R32: checked (no internal jargon)
- R33: N/A
- R34: S1, S7 (adjacent paths)
- R35: checked
- R36-R37: N/A
- RS1: checked
- RS2: checked
- RS3: S5
- RS4: checked

### Testing expert
- R1: OK
- R2: OK
- R3: OK
- R4: OK
- R5: OK
- R6: T6 (new audit actions)
- R7: T8 (wrong surface)
- R8: OK
- R9: OK
- R10: T13 (cross-tenant adversarial missing)
- R11: OK
- R12: T6
- R13: OK
- R14: OK
- R15: OK
- R16: T9 (minor)
- R17: N/A
- R18: OK
- R19: T5
- R20: N/A
- R21: OK
- R22: OK
- R23: OK
- R24: N/A
- R25: OK
- R26: OK
- R27: OK
- R28: OK
- R29: OK
- R30: OK
- R31: OK
- R32: T10 (boot test loose)
- R33: N/A
- R34: N/A
- R35: T13
- R36: N/A
- R37: OK
- RT1: T2
- RT2: T1, T7
- RT3: OK
- RT4: T4, T12
- RT5: T3

---

## Summary

- **Critical (5)**: F1/S1 (refresh-rotation strips cnfJkt), F2 (extension refresh/revoke bypass swFetch), S2 (CORS Allow-Headers missing DPoP), T1 (IDB unmockable), T2 (error-code mismatch).
- **Major (12)**: F3, F4, F5/T6 (decision needed), F6, F7, S3 (user decision), S4, S5, T3, T4, T5, T7 (user decision).
- **Minor (14)**: F8, F9, F10, S6, S7, S8, T8, T9, T10, T11, T12, T13, T14, F-A1.

**Decisions needed before Phase 2**:
1. **F5/T6 audit action**: Option A (metadata flag) or Option B (new action).
2. **S3 backward-compat**: defer to future plan / add tenant kill-switch / explicit limitation in threat-model.
3. **T7 Playwright E2E**: configure extension loader / downgrade to stubbed-extension test.

Cleanup (bash ~/.claude/hooks/tri-tmpdir.sh cleanup /tmp/tri-d1Uonz) deferred until after plan revision.
