# Code Review: ios-signout-tenant-autolock

Date: 2026-06-12
Review round: 1 (converged)

## Changes from Previous Round

Initial code review. Scope: `git diff HEAD` (working tree vs ios-main a3415aca) — the
13-file feature. **Functionality: no findings. Security: no findings.** Testing: 1 Major
(T1 — missing manual-test doc), resolved by creating it (no code change).

## Functionality Findings

No findings. All 6 review areas PASS: clamp coherence (3 sites via `AutoLockLimits`,
user picker stays `[5,60]`, single precedence point with fail-closed getter);
`policyAuthoritative` threading (passphrase=true/biometric=false, applied before
`applyPersistedTimeout`, biometric no-op can't wipe a persisted policy; DEBUG path
correctly bypasses); Sign Out flow (body-level `confirmationDialog`, `signOut()` full
clear, `clearTenantPolicy()` single `.loggedOut` chokepoint for both manual + timeout);
`VaultUnlockData` defaulted-last init coexists with synthesized `Decodable`;
SettingsView org-enforced UI (enforced-value option load-bearing, disabled, hint,
`%lld minutes` plural); `AutoLockLimits` in Shared (D1), no duplicate consts.
R2/R3/R25/R27 all clean; DB/migration N/A.

## Security Findings

No findings. Sign Out reuses the existing `signOut()` unchanged (full clear); tenant
getter is fully fail-closed (0/negative/huge → nil → user setting, even stricter than
the plan's "clamp to 1440"); no new auth/token/network/crypto surface (one optional
decoded field on an already-consumed response); App Group UserDefaults is correct for a
non-secret policy int (client auto-lock is documented defense-in-depth, server idle
timeout is the boundary); confirmation dialog gates the irreversible local clear; no PII
in catalog/docs. RS1-RS4 N/A or defense-in-depth-present.

## Testing Findings

**T1 — Major — manual-test doc referenced by the plan was never created** — RESOLVED.
The plan named `ios-signout-tenant-autolock-plan-manual-test.md` but it didn't exist,
leaving the SwiftUI surfaces (Sign Out dialog, org-enforced Settings UI, RootView
threading) with no script. Created it (sections A Sign Out, B tenant override, C
biometric-retains-policy, adversarial/edge, rollback). No code change.

All other testing areas PASS: `applyTenantPolicy` 3 branches tested non-vacuously
(incl. the critical non-authoritative-nil RETAIN over a persisted value); threading +
decode tests drive the real `VaultUnlocker` with distinct non-colliding values;
clamp-test updates arithmetically correct, both old 60-assertions gone; cross-field
invariant proven; R19 init fan-out compiles (defaulted-last / both prod sites);
LocalizationCatalogTests auto-catches the 4 new keys; keychain-free / safe service
names; per-test UserDefaults isolation.

## Recurring Issue Check

### Functionality expert
R2 PASS (single `AutoLockLimits`), R3 PASS (all `UnlockResult(`/`VaultUnlockData(` sites), R25 PASS (tenant key persist/hydrate/clear symmetric), R27 PASS (`%lld minutes`). R1/R4–R24/R26/R28–R37: N/A (client-only, no DB/event/migration).

### Security expert
RS1/RS2/RS3 N/A (no comparison/endpoint; server validates, client re-validates fail-closed). RS4 PASS (no PII). DB/crypto/auth: N/A.

### Testing expert
R19 clean (init fan-out). RT1 (real VaultUnlocker), RT2 (branch-inverting assertions), RT3 (per-test isolation), RT4 (behavior-named), RT5 PASS. SwiftUI rendering → manual (T1 doc now present).

## Resolution Status

### T1 Major — missing manual-test doc — RESOLVED
- Action: created `docs/archive/review/ios-signout-tenant-autolock-plan-manual-test.md` (Sign Out, tenant override, biometric-retains-policy, adversarial, rollback). Placeholder URLs only (RS4).
- No production/test code change → 318 tests remain green.
