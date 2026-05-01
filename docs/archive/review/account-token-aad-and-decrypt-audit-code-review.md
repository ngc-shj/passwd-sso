# Code Review: account-token-aad-and-decrypt-audit
Date: 2026-05-01
Review round: 1

## Changes from Previous Round
Initial review.

## Functionality Findings

### F1 [Minor] Stale comments in test file describe pre-Phase-1 AAD shape
- File: `src/lib/auth/session/auth-adapter.test.ts:1258-1261`, also 1356-1357
- Evidence: Comment reads `"Phase 2 scope: AAD bytes today are 'provider:providerAccountId'."` Phase 1 shipped on the same branch and changed AAD to `userId:provider:providerAccountId`.
- Problem: Misleading documentation; future readers tracing tamper-detection logic may misinterpret.
- Fix: Update comments to current AAD shape.

### F2 [Minor] R19 mock alignment — two early getAccount test mocks missing `id`/`tenantId`
- File: `src/lib/auth/session/auth-adapter.test.ts:1119, 1135`
- Evidence: `getAccount` SELECT now requests `id` and `tenantId`, but `mockPrismaAccount.findFirst.mockResolvedValue({...})` in "returns account when found" and "converts null optional fields" omit them.
- Problem: Latent drift between mock and real Prisma return shape. No runtime failure today (these tests use plaintext mocks → audit path not entered), but copy-pasted future tests would inherit the gap.
- Fix: Add `id`/`tenantId` to both fixtures.

## Security Findings

### S1 [Minor → Major potential] AAD colon delimiter ambiguity
- File: `src/lib/crypto/account-token-crypto.ts:47-52`
- Evidence: `buildAad` builds `${userId}:${provider}:${providerAccountId}` UTF-8. `userId` is UUID (no colon). `provider` and `providerAccountId` are external strings with no syntactic constraint on `:`.
- Problem: If a provider ID containing `:` is registered (e.g., `"saml:acme"`), AAD bytes for `(userId="u1", provider="saml:acme", providerAccountId="sub99")` collide with `(userId="u1", provider="saml", providerAccountId="acme:sub99")` — the very Vector A pivot the AAD expansion was meant to close.
- Impact: Currently not exploitable in this codebase (provider set is `{google, credentials, nodemailer, saml-jackson-oidc}` — none contain `:`). Structurally possible if any future SAML/OIDC integration uses `:`-bearing IDs.
- Fix: Add a guard at `buildAad` time that throws if any field contains `":"`. Cheaper than re-engineering the encoding (length-prefix, hex, etc.) and gives a clear error at write time.

### S2 [Critical, escalate=true] Plaintext fallback bypasses AAD bind entirely
- File: `src/lib/crypto/account-token-crypto.ts:64-68` (`decryptAccountToken`); `src/lib/crypto/account-token-crypto.ts:166-168` (`decryptAccountTokenTriple` plaintext branch)
- Evidence: Both functions return the stored value verbatim when the `psoenc1:` sentinel is absent. No AAD check, no audit emission, no warning.
- Problem: A DB-write attacker (the explicit threat model that AAD expansion was designed to address) can write any plaintext string to `accounts.refresh_token` (e.g., a phished token), strip the sentinel, and `getAccount` returns it as a valid `refresh_token`. The Phase #1 AAD bind is silently bypassed; the Phase #2 audit emission does not fire because the plaintext path never enters the `try` block.
- Impact: The entire defense added by this PR is bypassable by an attacker who has the very capability the PR was scoped to defend against.
- Fix (dev-phase project): Remove the plaintext fallback. Any non-`psoenc1:`-prefixed value is treated as a CORRUPT failure (field returned as null, warn-log only). The migration script (`scripts/migrate-account-tokens-to-encrypted.ts`) reads plaintext via raw SQL and uses `encryptAccountToken` directly — it does not call `decryptAccountToken` on plaintext, so the script is unaffected.
- escalate: true
- escalate_reason: This bypasses the central security invariant of the PR. It is also tightly coupled to the dev-phase tradeoff articulated in the plan; closing it is consistent with the plan's stance that legacy/non-conforming rows are forced through re-OAuth in dev.

### S3 [Minor — informational, no action] errClass speculative leak via `err.constructor.name`
- File: `src/lib/auth/session/auth-adapter.ts:502`
- Note: Current Node LTS throws plain `Error` for GCM auth-tag failure. If a future runtime introduces typed crypto error classes whose names encode sensitive context, the field would surface them. Not actionable today.

### S4 [Minor — informational, no action] Pino JSON encoding mitigates log injection from `provider`/`providerAccountId`
- Note: Pino structured JSON escape-quotes strings. Risk surfaces only if a downstream aggregator passes raw text through. Operator-runbook concern, not a code-level fix.

### S5 [Minor — informational, no action] DoS via repeated TAMPERED audit
- Note: TAMPERED is the intended adversarial signal; rate-limiting is OAuth-callback-layer concern. SIEM alert on repeated TAMPERED from same `account.id` is the correct mitigation.

## Testing Findings

### T1 [Minor] Stale comment in TAMPERED audit test
- File: `src/lib/auth/session/auth-adapter.test.ts:1258`
- Same root cause as F1 — comment describes pre-Phase-1 AAD shape.
- Fix: Update comment to describe current AAD shape and that mismatch fires on userId AND providerAccountId.

### T2 [Minor] No adapter-layer test for KEY_UNAVAILABLE → no-audit path
- File: `src/lib/auth/session/auth-adapter.test.ts` (gap)
- Evidence: Adapter tests cover CORRUPT (no audit) and TAMPERED (audit). KEY_UNAVAILABLE classification is untested at the adapter layer.
- Problem: If the dispatch logic ever changes to fire audit on KEY_UNAVAILABLE (regression), no test catches it.
- Fix: Add a test that mocks `getMasterKeyByVersion` to throw, verifies no `OAUTH_ACCOUNT_TOKEN_DECRYPT_FAILURE` audit is emitted, and the field is returned as undefined.

### T3 [Minor] Sibling-preservation test does not assert audit count
- File: `src/lib/auth/session/auth-adapter.test.ts:1319-1374`
- Evidence: Test verifies `id_token` decrypts and `refresh_token` is undefined, but does not assert how many `OAUTH_ACCOUNT_TOKEN_DECRYPT_FAILURE` audits fired (should be exactly one — for the TAMPERED `refresh_token`).
- Fix: Add `expect(mockLogAudit.mock.calls.filter(c => c[0].action === "OAUTH_ACCOUNT_TOKEN_DECRYPT_FAILURE")).toHaveLength(1)`.

## Adjacent Findings

[Adjacent → Security] (from Functionality) `errClass` leak speculative — covered by S3.

## Quality Warnings
None.

## Recurring Issue Check

### Functionality expert
- R3 (propagation): pass — buildAad call sites all updated.
- R19 (mock alignment): partial — F2 above.
- Other R rules: not applicable to this diff.

### Security expert
- R3 (input validation at boundary): partial — S1 above (no validation in buildAad).
- R4 (no error message leak): pass — `err.message` sanitized.
- R10 (downgrade / fallback attack surface): fail — S2 above.
- Other R rules: not applicable.
- RS1 (timing-safe comparison): not applicable (no credential comparison in diff).
- RS2 (rate limiter on new routes): not applicable (no new route).
- RS3 (input validation at schema boundary): partial — S1 above (boundary is `buildAad`).

### Testing expert
- RT1 (mock-reality divergence): pass.
- RT2 (testability of recommendations): pass.
- RT3 (shared constants in tests): pass.
- R19 (exact-shape assertions): pass (uses `expect.objectContaining`).

## Resolution Status

### Round 1 fixes (commit 71733509)

- **S2 [Critical]** — Resolved. Removed plaintext fallback in `decryptAccountToken{,Triple}`. Non-sentinel values now classify as CORRUPT (no audit, field returned undefined). Module header documents removal.
- **S1 [Minor]** — Resolved. `buildAad` rejects `:` in any of `userId` / `provider` / `providerAccountId`. Static error message — no offending value echoed.
- **F1 / T1 [Minor]** — Resolved. Stale Phase-2-only AAD comments updated.
- **F2 [Minor]** — Resolved (partial — see Round 2 finding F-new-2). Two early `getAccount` test fixtures got `id`/`tenantId`.
- **T2 [Minor]** — Resolved. New test exercises KEY_UNAVAILABLE classification path with `vi.spyOn(getMasterKeyByVersion)`; verifies no audit emit and `try/finally spy.mockRestore()`.
- **T3 [Minor]** — Resolved. Sibling-preservation test asserts exactly one OAUTH audit event with metadata.field === "refresh_token".

## Round 2 Findings

### F-new-1 / N1 [Minor] Stale comment in auth-adapter.ts contradicts S2 fix
- File: `src/lib/auth/session/auth-adapter.ts:479-484`
- Evidence: Comment block reads `"Legacy plaintext rows pass through unchanged via the sentinel check inside the triple helper."` This is the pre-S2 behavior. Post-fix, plaintext rows classify as CORRUPT and the field returns undefined.
- Fix: Replace the comment to describe the post-fix behavior.

### F-new-2 [Minor] R19 fixture incompleteness — round-trip test missing id/tenantId
- File: `src/lib/auth/session/auth-adapter.test.ts` round-trip test (line ~1181)
- Evidence: Five `getAccount` fixtures got `id`/`tenantId` in Round 1 (corrupt, success-undefined-fields, TAMPERED, sibling, KEY_UNAVAILABLE). The round-trip test fixture was missed.
- Impact: Test passes (no-tamper path doesn't read those fields), but fixture doesn't reflect real Prisma SELECT shape.
- Fix: Add `id` and `tenantId` to the round-trip test fixture.

### T-new-1 [Minor] userId colon-guard branch untested
- File: `src/lib/crypto/account-token-crypto.test.ts`
- Evidence: "buildAad rejects fields containing the ':' delimiter" test exercises `provider` and `providerAccountId`, not `userId`.
- Impact: No production risk (userId is UUID-sourced); defense-in-depth test gap only.
- Fix: Add a third `expect(...).toThrow(/reserved delimiter/)` for userId.

### T-new-2 [Minor] No regression test for linkAccount propagating buildAad throw
- File: `src/lib/auth/session/auth-adapter.test.ts`
- Evidence: No test verifies that `linkAccount` with a `:`-containing provider propagates the `buildAad` error.
- Impact: Behavior is correct (throw propagates naturally), but no regression guard.
- Fix: Add a test that calls `linkAccount` with a `:`-containing provider and asserts `rejects.toThrow(/reserved delimiter/)`.

### N2 [Informational, no fix] SAML NameID URN format may contain colons
- Note: BoxyHQ SAML Jackson exposes an OIDC interface; the `providerAccountId` is the OIDC `sub` claim, not the raw SAML NameID. Standard OIDC `sub` is alphanumeric or email. URN-format SAML NameIDs are the format identifier, not typical subject values. Risk is theoretical for this deployment.
- If a real deployment hits this, two paths: (a) percent-encode fields before AAD construction, or (b) document SAML subjects must be colon-free. Defer to that point.

### S2 secondary [Informational, no action] CORRUPT vs TAMPERED audit asymmetry
- A DB-write attacker who writes plaintext (no `psoenc1:` sentinel) classifies as CORRUPT → no audit emit. The attacker gains nothing (field returns undefined → user re-OAuths) but their action is silent in the audit log.
- Acceptable trade-off: auditing all CORRUPT events would create alert fatigue from genuine storage corruption. Operational signal (forced re-OAuth) is the out-of-band detection.

## Round 2 Resolution Status

- **F-new-1 / N1 [Minor]** — Resolved. Comment in `auth-adapter.ts:479-484` updated to describe post-fix behavior (non-sentinel → CORRUPT, no plaintext fallback).
- **F-new-2 [Minor]** — Resolved. Round-trip test fixture got `id: "acc-roundtrip"` and `tenantId: "tenant-1"`.
- **T-new-1 [Minor]** — Resolved. Added third assertion in colon-guard test exercising `userId` branch.
- **T-new-2 [Minor]** — Resolved. New test "propagates buildAad delimiter rejection to caller" verifies linkAccount surfaces the validation throw and skips the DB write.
- **N2 [Informational]** — Deferred. SAML URN-format subjects deemed unlikely in practice (OIDC `sub` from Jackson is alphanumeric/email). Re-address if a real deployment hits this.
- **S2 secondary [Informational]** — Accepted as design trade-off (auditing all CORRUPT events would create alert fatigue from genuine storage corruption).

## Round 2 Termination

All Round 1 findings verified. Round 2 surfaced 4 Minor follow-ups (all fixed) + 2 Informational (no fix). No Critical or Major findings in Round 2. Loop terminating per Step 3-8.
