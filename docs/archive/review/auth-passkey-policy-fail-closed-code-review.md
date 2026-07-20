# Code Review: auth-passkey-policy-fail-closed
Date: 2026-07-20
Review round: 1

## Changes from Previous Round
Initial code review of the committed implementation (`fix(auth): fail closed when passkey-enforcement fetch fails in session callback`).

## Summary
0 Critical, 0 Major, 2 Minor. All three experts independently verified the fix is correct and complete: the catch bundle drives `passkeyEnforcementBlocks → true` (blocks → exempt setup page), the happy path is unchanged, no consumer/type regression, and the tests assert real fail-closed behavior (four field values + real predicate, mutation-proven — the testing expert empirically confirmed a stale non-null `enabledAt` fails T1 even though the predicate alone would still return `true`). Both Minor findings are pre-existing and out of this diff's declared scope.

## Functionality Findings
- **F1 (Minor)** — Happy-path null-tenant fails open (`auth.ts:417,421`): on a *successful* fetch where `user.findUnique` returns null or `.tenant` is null, `requirePasskey ?? false` → `false`. Asymmetric with the catch path and `derivePasskeyState` (throws on null tenant). `User.tenantId` is a non-null FK with `onDelete: Restrict`, so only reachable on mid-session row disappearance or data corruption — low likelihood, **pre-existing** (this diff does not touch the happy path). Out of scope for C1 (catch-only).

## Security Findings
- **MIN-1 (Minor)** — same as Functionality F1 (perspective convergence). A distinct fail-open from the fetch-failure one; the session callback has no `tenantId` to look up a policy when the user row is null, so there is genuinely no tenant policy to enforce. Pre-existing, out of scope; recorded as a follow-up.
- **MIN-2 (Minor)** — Consumer `?? false` coupling (`auth-gate.ts:103-106`): `data?.user?.requirePasskey ?? false` is itself a fail-open default, safe only because the callback now always emits all four fields. Implicit untested cross-module invariant. Optional hardening (a documenting comment); not blocking.

## Testing Findings
No findings. T1/T2/T2b/T3 present and passing; real `passkeyEnforcementBlocks` imported (not mocked); four-field assertion empirically proven load-bearing for INV-2; `mockLoggerWarn` observable (RT1).

## Adjacent Findings
- Sec MIN-1 cross-references `passkey-enforcement.ts:109` (derivePasskeyState throw-on-null-tenant) — the parity target for the deferred follow-up.

## Quality Warnings
None. All findings carry specific file/line, concrete recommendation, and impact.

## Recurring Issue Check
### Functionality expert
- R38: ADDRESSED (core fix); residual happy-path null-tenant narrow, pre-existing, out of scope.
- R42: SATISFIED — two-grep derivation, M1 sole fail-open, M2 throws on DB error + null tenant (spot-checked).
- R43: SATISFIED — blocks more, never grants more; fail-safe.

### Security expert
- R38: fully closed for targeted path; both consumers traced; auth-gate tenant-resolution catch doesn't touch passkey fields; all-or-nothing bundle prevents partial fail-open. MIN-1 (unrelated fail-open) out of scope.
- R42: two-grep derivation sound + reproducible; M1 sole fail-open, M2–M5 verified.
- R43: clean — only block-more direction.
- RS3: diff touches only auth.ts catch + auth.test.ts + 2 docs; no forbidden patterns; assertions real + mutation-proving.

### Testing expert
- RT1: PASS — `mockLoggerWarn` hoisted stably, wired, observed by T3.
- RT5: PASS — `passkeyEnforcementBlocks` imported real, no `vi.mock`, no inline condition.
- RT7: PASS — `requirePasskeyEnabledAt === null` assertion catches a stale-enabledAt partial fail-open the predicate alone misses (empirically verified).
- RT8: PASS — T1 asserts four concrete field values + the real enforcement verdict; every field mutation fails a test.
- RT3: PASS — `FAIL_CLOSED` bundle defined once.

## Environment Verification Report
N/A — no environment constraints declared in Phase 1 (all contracts `verifiable-local` + `verifiable-CI`; the fail-closed path is exercised by mocked unit tests).

## Resolution Status

### F1 / MIN-1 (Minor) — Happy-path null-tenant fails open — FIXED
- Disposition: **Fixed in this PR** (user opted to close the follow-up rather than defer).
- Action: on the SUCCESS path, a null tenant (user row vanished mid-session / FK-orphaned) now throws inside the `withBypassRls` block, so it flows through the same fail-closed `catch` (installing the safe-blocking bundle) instead of defaulting `requirePasskey=false`. This aligns the session callback with `derivePasskeyState`'s throw-on-null-tenant stance. Since `User.tenantId` is a non-null FK (`onDelete: Restrict`), no legitimate user is affected — only the vanished-row / corruption cases, which SHOULD fail closed.
- Modified file: `src/auth.ts` (the `withBypassRls` return + downstream non-null field reads).
- Test: `src/auth.test.ts` — "fails closed when a successful fetch returns no tenant" (mock `user.findUnique → null`), asserts the four fail-closed fields + real `passkeyEnforcementBlocks === true`. Mutation-verified: reverting the throw fails the test.

### MIN-2 (Minor) — Consumer `?? false` coupling in auth-gate — FIXED (documented)
- Disposition: **Fixed in this PR** (documenting comment).
- Action: added a comment at `auth-gate.ts` documenting that the `?? false` / `?? null` fallbacks are fail-open and safe only because the session callback always emits all four passkey fields on both paths; if that contract ever changes, tighten to a fail-closed default.
- Modified file: `src/lib/proxy/auth-gate.ts` (comment above the `SessionInfo` construction).

Both findings were pre-existing; the user chose to fold both fixes into this PR. Both changes are fail-safe (tighten or document, never widen access).
