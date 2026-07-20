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

### F1 / MIN-1 (Minor) — Happy-path null-tenant fails open
- Disposition: **Skipped — out of scope** (SC-followup-1).
- Anti-Deferral:
  - Worst case: a user whose `User` row disappears mid-session (or an FK-orphaned row from data corruption) gets `requirePasskey=false` on a *successful* fetch, bypassing passkey enforcement for that session.
  - Likelihood: very low — `User.tenantId` is a non-null FK with `onDelete: Restrict`; a null tenant on a successful query requires the user row to vanish mid-session or explicit data corruption. Not reachable via normal operation, and unrelated to the fetch-failure path this PR fixes.
  - Cost to fix: medium — needs a semantic decision (tenant-less vs FK-orphaned user) and alignment with `derivePasskeyState`'s throw-on-null-tenant stance; the session callback also lacks a `tenantId` to re-query by, so the fix is not a one-line default flip. Expanding this PR to cover it would broaden scope beyond C1 (catch-only) and both the functionality and security experts explicitly advised deferring.
  - Owner: follow-up issue (SC-followup-1), separate from this PR.

### MIN-2 (Minor) — Consumer `?? false` coupling in auth-gate
- Disposition: **Accepted — documented, no code change** (SC-followup-2).
- Anti-Deferral:
  - Worst case: a future edit to the session callback that omits `requirePasskey` on some path silently re-opens the fail-open via the consumer's `?? false`.
  - Likelihood: low — the callback currently always emits all four fields on both paths; the `SessionInfoSchema` Zod validation and the four-field-assertion tests would surface an omission.
  - Cost to fix: trivial (a documenting comment) but touches an unrelated file (`auth-gate.ts`) outside this PR's C1 scope; a comment there is not load-bearing and would be scope creep.
  - Owner: optional follow-up (SC-followup-2); not blocking.

Both findings are pre-existing and outside the C1 (catch-only) contract. No code changes applied this round.
