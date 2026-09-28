# Code Review: long-lived-client-login
Date: 2026-09-28
Review round: 1

## Changes from Previous Round
Initial review. Local LLM unavailable (pre-screen and seeds empty) — all three experts ran full-diff reviews.

## Functionality Findings
- F1 [Minor] Untracked probe migration `prisma/migrations/20260928061731_probe_noop/` left in the working tree (D-FIX-1). Same as T3 and the security adjacent note.
- Everything else verified: C1–C12 match the plan; every Implementation Checklist file is in the diff; CLI, e2e and the iOS AutoFill target need no changes; R26/R28 clean for the new toggles.

## Security Findings
- S1 [Major] `POST /api/vault/unlock/verify` gated client kinds by denylist (`=== "IOS_AUTOFILL"`), so a future `ExtensionTokenClientKind` would gain presence recording by default; the plan and the route comment state an allowlist. (R42)
- Traced and not reported: C2 is a weaker oracle than the existing offline path; `enforceAccessRestriction` with `tenantId: undefined` resolves the tenant rather than skipping; C1 compare fully consolidated; every `expiresAt` writer uses C3.

## Testing Findings
- T1 [Major] `refreshTokenSingleFlight` (extension) had no test driving two callers concurrently — the race it exists to prevent was untested.
- T2 [Major] Manual tests M1/M2/M3/M5 had no recorded execution or deferral.
- T3 [Minor] = F1.

## Adjacent Findings
- (Security → Functionality) Minor: probe migration directory — merged into F1.
- (Security) Minor, informational: `WrappedAuthHash.issuedAt` (iOS) is persisted but not read. Not a defect; C7 treats the cached hash as valid until the server hash changes.

## Quality Warnings
None (manual merge; Ollama unavailable).

## Recurring Issue Check
### Functionality expert
R1 no issue · R2 no issue · R3–R4 no issue · R5–R7 N/A · R8 no issue · R9–R11 N/A · R12 no issue · R13 N/A · R14 no issue · R15–R16 N/A · R17 no issue · R18 no issue · R19 no issue · R20–R23 N/A · R24 no issue · R25 no issue · R26 no issue · R27 N/A · R28 no issue · R29 no issue · R30–R33 N/A · R34 F1 · R35–R37 N/A · R38 no issue · R39 no issue · R40–R41 N/A · R42 no issue · R43–R47 N/A · R48 no issue · R49 no issue · R50–R57 N/A

### Security expert
R1 no issue · R3 no issue · R14 no contrary evidence · R24 no issue · R25/R39 no issue · R38 no issue · R42 S1 · R48 deliberate documented lockout divergence, no issue · R49 no issue · remaining R rules no match · RS1 no issue · RS2 no issue · RS3 no issue · RS4 no issue · RS5 no issue · RS6 no match

### Testing expert
RT1 no issue · RT4 no issue on existing tests (T1 is an untested race path) · RT5 no issue · RT7 no issue · RT8 no issue · RT9 no issue · RT10 no issue (hook: 0 findings) · RT11 no issue in tests (T3) · R14 not re-run · R19/R24/R42 no issue · R48 no issue · remaining R rules and RT2/RT3/RT6 no trigger

## Environment Verification Report
| Path | Classification | Evidence |
|---|---|---|
| VE1 iOS build/test | verified-local | xcodebuild test on macOS host (Xcode 26.6), exit 0 — deviation D-B4-5 and Phase 2 completion |
| VE2 Face ID ACL / M4 | blocked-deferred | Plan VE2; non-ACL logic verified by `PresenceRecorderTests`, `MobileAPIClientTests`, `VaultUnlockerTests`; device check in `long-lived-client-login-manual-test.md` M4 |
| VE3 SW termination / M1 | verified-local (hydrate unit tests) + blocked-deferred (manual stop) | Plan VE3; manual step in manual-test M1 |
| M2 | verified-CI for FR1 (`client-token-presence.integration.test.ts`, refresh with no sessions row); smoke deferred to manual-test M2 | |
| M3 | verified-local for logic (extension C10 alarm test, `AutoLockServiceTests`, options UI test); end-to-end deferred to manual-test M3 | |
| M5 | verified-local/CI for mechanism (C3/C4 unit, C4 real-DB sequence, refresh presence-gate tests); live scenario deferred to manual-test M5 | |

## Resolution Status

### S1 [Major] clientKind denylist on the presence route
- Action: replaced with an allowlist `PRESENCE_CLIENT_KINDS = new Set<ExtensionTokenClientKind>(["BROWSER_EXTENSION", "IOS_APP"])`; added test "returns 403 for a client kind outside the presence allowlist" (asserts no presence write). Allow side still pinned by the existing BROWSER_EXTENSION success and IOS_APP acceptance tests. The old denylist would let the new fixture through (200), so the test distinguishes the two.
- Modified files: `src/app/api/vault/unlock/verify/route.ts`, `src/app/api/vault/unlock/verify/route.test.ts`

### T1 [Major] single-flight refresh untested under concurrency
- Action: added "single-flight: alarm refresh and a concurrent lazy GET_TOKEN share one refresh request" — refresh fetch held on a gate, alarm fires while the token is valid, `Date` advanced past expiry, `GET_TOKEN` takes the lazy branch, gate released; asserts exactly one refresh request and that `GET_TOKEN` returns the renewed token. Red-proven on a scratchpad copy of `extension/` (single-flight sharing removed → `expected null to be 'refreshed-tok'`); real source never mutated.
- Modified file: `extension/src/__tests__/background.test.ts`

### T2 [Major] Manual tests M1/M2/M3/M5 — Accepted (deferred to human run)
- Action: wrote `docs/archive/review/long-lived-client-login-manual-test.md` (pre-conditions, M1–M5 steps and expected results, adversarial scenarios, rollback) and classified every path above.
- Anti-Deferral check: deferred, not skipped — these need an interactive Chrome with the unpacked extension, a signed-in dev server, and real idle waits, which this unattended session cannot drive; the automated mechanism tests for each are listed above.
- Worst case: a regression that only shows in a real MV3 worker lifecycle (e.g. storage.session cleared on a worker stop in some Chrome version) ships unnoticed.
- Likelihood: low — hydrate logic is unit-tested and `chrome.storage.session` survival across worker stops is documented Chrome behaviour.
- Cost to fix: about 30 minutes of human time to run the checklist before merge.

### F1/T3 [Minor] untracked probe migration
- Action: must be deleted before merge; deletion from this session was denied by the permission layer, so it is left to the user. It is untracked and excluded from every commit.

---

# Review round 2 (2026-09-28)

## Changes from Previous Round
Commit "review(1)": S1 allowlist, T1 concurrency test, T2 manual-test checklist + accepted deferral. All three: resolved.

## Findings
- Functionality: No findings (manual-test labels, column names, grace window, revoke reasons and the iOS 422 eviction path verified against code).
- Security: No findings. R43 check against round 1: no widening — the allowlist is extensionally identical for the three existing kinds and fails closed for any future kind.
- Testing: No findings. T1 red-proof causal chain independently derived (`attemptTokenRefreshWith` entry guard); fake-timer restore in `finally`; `background.test.ts` 120/120, route test 10/10; `check-deny-only-guard.sh` 0 findings.

## Recurring Issue Check
- Functionality: R42 verified resolved; other rules no issue / not triggered.
- Security: R42 resolved, R43 no widening, RT4/RT7/RT8 satisfied, RS4 clean; other rules no new surface.
- Testing: RT4, RT7, RT8, R34, R42 satisfied; other rules not triggered.

## Termination
All three experts returned No findings in round 2. Open item outside the code: untracked `prisma/migrations/20260928061731_probe_noop/` awaits deletion by the user (session permission denied); manual checklist `long-lived-client-login-manual-test.md` awaits a human run before merge.

---

# Review rounds 3–4 (2026-09-28) — cache-rollback report fix (added to this branch at the user's request)

## Background
During M4 on a real device, every `POST /api/mobile/cache-rollback-report` returned 400. Root cause (pre-existing, not from this branch): `cacheVersionCounter` is seeded from 64 random bits (`BridgeKeyStore`), so it exceeds 2^53 ~99.95% of the time; sent as a JSON number it fails Zod 4 `int()` (safe-integer bound) and is already rounded by `JSON.parse`. All cache-rollback / forged-flag detections were being dropped.

## Round 3 — commit "fix(ios): send cache rollback counters as decimal strings"
- Functionality: No findings (all body construction sites updated; no numeric consumer of the metadata; no other 64-bit iOS→server field; single-flag-file drain, no backlog flood; older builds with safe counters still accepted).
- Security: S1 [Major, pre-existing in the changed file] rate limit keyed on client-chosen `deviceId` (unlimited buckets per token) and no `clientKind` restriction. Also verified: no ReDoS/BigInt DoS (regex bounds length before `BigInt`), union branches disjoint, number branch bounded by Zod's safe-integer check, R43 no widening.
- Testing: T4 [Major] no server test for the string `"0"` counters every `flag_forged` report sends.
- Found while writing tests: Zod 4 runs `.refine()` after a failed `.regex()`, so `BigInt("12a")` threw → 500; fixed by a single refine.

## Round 4 — commit "fix(security): bind cache-rollback rate limit to the token family and restrict it to iOS"
- S1 resolved: `clientKind !== "IOS_APP"` → 403 before access restriction, body parse, limiter and audit; limiter keyed on `${tenantId}:${familyId}` (tokenId rejected — rotates every refresh; a new family requires a full sign-in). Security R43: not a widening — the old key was effectively unbounded.
- T4 resolved: route test with string `"0"` counters; integration `flag_forged` sends strings.
- All three experts: No findings. Functionality confirmed only the iOS host app (IOS_APP token) sends the report; the AutoFill extension only writes the flag file.

## Verification
Route tests 27/27, real-DB integration 2/2, iOS xcodebuild test 818 pass on the macOS host, full pre-PR pass.

---

# Review rounds 5–6 (2026-09-28) — extension tenant-policy display (from user testing)

## Background
Browser testing showed the extension options page with the local 15-minute auto-lock while the tenant sets 1440 (iOS showed 1440). The extension cleared the tenant policy on every lock (pre-existing, harmless while lock also dropped the token) and only learned it from unlock data.

## Round 5 — commits "keep the tenant auto-lock policy across a vault lock", "load the tenant vault policy as soon as the extension connects"
- Functionality F1 [Major] / Security S1 [Major] (converged): `refreshTenantPolicy()` had no supersession guard — a response landing after a disconnect/reconnect revived the old connection's policy, and a same-lifetime reconnect kept it. F2 [Minor] stale GET_STATUS comment. F3 [Minor] hydrate refetch gate used AND across two independently nullable fields.
- Security adjacent: hydrate's cnfJkt-mismatch path cleared storage but left the in-memory token/policy.
- Testing T5 [Major] no test for the START_CONNECT fetch; F1 [Major] no test that a token switch clears the policy.

## Round 6 — commit "drop stale tenant-policy responses and discard unusable restored sessions"
- Fixes: `tokenAtStart` identity check before applying the response; OR gate; comment; `discardRestoredSession()` on both hydrate failure paths; tests for token switch, START_CONNECT (vi.doMock, doUnmock in finally), late response after CLEAR_TOKEN, cnfJkt mismatch. An existing hydrate fixture lacked `tokenCnfJkt` and passed only because of the in-memory leak — corrected.
- Functionality: No findings. Security: No findings (all interleavings of `discardRestoredSession` vs a concurrent connect traced; `hydrationSuperseded` check precedes the synchronous discard). Testing: T6 [Minor] the late-response test assumed, without asserting, that the status fetch was in flight.

## Tightening-only skip — Round 6
Findings applied directly (no Round 7 review):
- T6 [Minor] precondition assertion added (status fetch observed in flight before CLEAR_TOKEN) — `extension/src/__tests__/background.test.ts` — applied verbatim
Justification: test-only, inside the Round 6 fix scope, no security-boundary change.
