# Code Review: bypass-model-grants-and-nesting-fail-closed
Date: 2026-10-20T09:43:43+09:00
Review round: 1

## Changes from Previous Round
Initial review.
- An external review (pasted by the user) and the Phase 2 self-R-check came before this round. Their fixes are in commits dd44f5682, 232efc4bd, 619b90832 and c2cdcdcf6.
- Local LLM pre-screening and seeds were unavailable: the 932KB diff made the server return HTTP 400. All three experts reviewed the full diff.
- The experts were told mid-run that plain `git diff` output is compressed by the rtk proxy, so they read diffs through `rtk proxy` or the Read tool.

## Functionality Findings
- **F1 [Major]** Script pools are not ended on `$disconnect` (`@prisma/adapter-pg` leaves an external pool open unless `disposeExternalPool` is set): about a 10 s exit hang, and a leaked pool per tenant-domain command. Affected: `scripts/tenant-domain.ts`, `migrate-account-tokens-to-encrypted.ts`, `manual-tests/mcp-replay-audit-verification.ts`.
- **F2 [Minor]** The notice sink logged through `getLogger()`, so a report carried the request context of whichever request first opened the pooled connection (`src/lib/db/pool-factory.ts`).
- **F3 [Minor]** check-bypass-rls printed only the count of the calls whose relation argument it cannot read, and its summary described only the staleness side of that blind spot.
- **F4 [Minor]** Two separately committed migrations left an intermediate state that breaks pre-change bypass code (22P02).
- **F5 [Minor]** `rls.bypass_notice_unparsed` reached no metric or alarm, so a format drift would read as zero reports.
- **F6 [Minor]** `withTenantRls` made two round trips (the tenant id, then the bypass pin).
- **F7 [Minor]** Comments described the pre-migration policy form: `assert-bypass-rls-active.ts`, `audit-chain-verify-worker.ts`, `audit-outbox-worker.ts`, plus the same mechanism in `health-outbox-depth.integration.test.ts` and `rls-cross-tenant-verify.sql`.

## Security Findings
- **S-1 [Major]** The `client_min_messages` guard could be passed with backslash escapes. `pg_split_opts` drops the backslash, so `client\_min\_messages` sets the parameter. Verified against the dev server: `-c client\_min\_messages=error` gives `SHOW client_min_messages` = `error`.
- **S-2 [Minor]** The docs dropped the still-true caveat that `logAuditAsync` inside a context is refused (`audit-refused`) and the outer transaction commits. C5 does not cover it.
- **S-3 [Minor]** The C5 per-site evidence list the plan requires was missing. It is listed below.
- **S-4 [Minor]** `tenant-boundary-matrix.md` cited `BYPASS_PURPOSE` by a line range in `src/lib/tenant-rls.ts`, but it moved to `tenant-rls-purpose.ts`.

## Testing Findings
- **T1 [Major]** `infra/terraform/monitoring.tf` was not in the ci.yml `app` paths-filter, so the E5 metric-filter test skipped infra-only PRs.
- **T2 [Major]** There was no report positive control through the `@/lib/prisma` singleton or a direct `createPool` pool (plan C6).
- **T3 [Minor]** The GUC name-value pairing was not pinned: swapped names or aliases stayed green.
- **T4 [Minor]** The `rls-verify-run` self-test fake wrote only to stdout, so dropping `2>&1` stayed green.
- **T5 [Minor]** The setup EXECUTE probe relied on `current_user` instead of naming `passwd_app`.
- **T6 [Minor]** `audit-outbox.test.ts` answered the four-column bypass-state read with two-column rows.
- **T7 [Minor]** The real-repo gate cell asserted the exit status without stderr. This is the most plausible cause of the one-off 647/648 red, which was not reproduced in solo or parallel runs.
- **T8 [Minor]** The plan's "side-effect rows at caught sites" cell was not written.

## Adjacent Findings
None.

## Quality Warnings
None. Every finding carried a file, a line and evidence. F1, F2, S-1, T1, T3 and T4 were re-verified by the orchestrator, by reading the dependency source or by execution, before fixing.

## C5 per-site list (plan C5, S-3)
State-tightening writes inside RLS-context files: token, credential and lockout model writes, and `logAuditInTx` / `enqueueAuditInTx`. 48 files, extracted from production files that open an RLS context:

  - `scripts/tenant-domain.ts` (enqueueAuditInTx)
  - `src/app/api/admin/rotate-master-key/[rotationId]/approve/route.ts` (logAuditInTx)
  - `src/app/api/admin/rotate-master-key/[rotationId]/execute/route.ts` (logAuditInTx)
  - `src/app/api/admin/rotate-master-key/[rotationId]/revoke/route.ts` (logAuditInTx)
  - `src/app/api/admin/rotate-master-key/initiate/route.ts` (logAuditInTx)
  - `src/app/api/api-keys/[id]/route.ts` (.apiKey.update)
  - `src/app/api/api-keys/route.ts` (.apiKey.create)
  - `src/app/api/auth/passkey/reauth/verify/route.ts` (.session.update)
  - `src/app/api/emergency-access/[id]/approve/route.ts` (logAuditInTx)
  - `src/app/api/extension/key/reset/route.ts` (.extensionToken.updateMany)
  - `src/app/api/extension/token/refresh/route.ts` (.extensionToken.updateMany, .extensionToken.create)
  - `src/app/api/extension/token/route.ts` (.extensionToken.update)
  - `src/app/api/sessions/[id]/route.ts` (.session.deleteMany)
  - `src/app/api/sessions/route.ts` (.session.deleteMany)
  - `src/app/api/share-links/[id]/route.ts` (logAuditInTx)
  - `src/app/api/share-links/route.ts` (logAuditInTx)
  - `src/app/api/tenant/access-requests/[id]/approve/route.ts` (.serviceAccountToken.create)
  - `src/app/api/tenant/members/[userId]/clear-lockout/route.ts` (failedUnlockAttempts)
  - `src/app/api/tenant/operator-tokens/[id]/route.ts` (.operatorToken.update)
  - `src/app/api/tenant/operator-tokens/route.ts` (.operatorToken.create)
  - `src/app/api/tenant/service-accounts/[id]/tokens/[tokenId]/route.ts` (.serviceAccountToken.update)
  - `src/app/api/tenant/service-accounts/[id]/tokens/route.ts` (.serviceAccountToken.create)
  - `src/app/api/travel-mode/disable/route.ts` (failedUnlockAttempts, lockedUntil)
  - `src/app/api/user/mcp-tokens/[id]/route.ts` (.mcpAccessToken.update, .mcpRefreshToken.updateMany, .mcpAccessToken.updateMany, .delegationSession.updateMany)
  - `src/app/api/user/mcp-tokens/route.ts` (.mcpAccessToken.updateMany, .mcpRefreshToken.updateMany, .delegationSession.updateMany)
  - `src/app/api/vault/delegation/route.ts` (.delegationSession.create, .delegationSession.deleteMany, .delegationSession.updateMany)
  - `src/app/api/vault/recovery-key/recover/route.ts` (failedUnlockAttempts, logAuditInTx)
  - `src/app/api/vault/unlock/data/route.ts` (lockedUntil)
  - `src/app/api/vault/unlock/route.ts` (lockedUntil)
  - `src/app/api/vault/unlock/verify/route.ts` (lockedUntil, .extensionToken.update)
  - `src/app/api/webauthn/credentials/[id]/prf/route.ts` (.webAuthnCredential.update)
  - `src/app/api/webauthn/credentials/[id]/route.ts` (.webAuthnCredential.delete, .webAuthnCredential.update)
  - `src/app/api/webauthn/register/verify/route.ts` (.webAuthnCredential.create)
  - `src/auth.ts` (.session.updateMany, .extensionToken.updateMany, .apiKey.updateMany, .webAuthnCredential.updateMany)
  - `src/lib/audit/audit.ts` (logAuditInTx, enqueueAuditInTx)
  - `src/lib/auth/access/delegation.ts` (.delegationSession.updateMany)
  - `src/lib/auth/dpop/validate-token-dpop.ts` (.extensionToken.update)
  - `src/lib/auth/policy/account-lockout.ts` (lockedUntil, failedUnlockAttempts, logAuditInTx)
  - `src/lib/auth/session/auth-adapter.ts` (.session.delete, .session.update)
  - `src/lib/auth/session/session-concurrency.ts` (.session.deleteMany, .session.create)
  - `src/lib/auth/session/user-session-invalidation.ts` (.session.deleteMany, .extensionToken.updateMany, .apiKey.updateMany, .mcpAccessToken.updateMany, .mcpRefreshToken.updateMany, .delegationSession.updateMany, .operatorToken.updateMany)
  - `src/lib/auth/tokens/api-key.ts` (.apiKey.update)
  - `src/lib/auth/tokens/extension-token.ts` (.extensionToken.updateMany, .extensionToken.create)
  - `src/lib/auth/tokens/mobile-token.ts` (.extensionToken.updateMany, .extensionToken.create, .extensionToken.update)
  - `src/lib/auth/tokens/operator-token.ts` (.operatorToken.update)
  - `src/lib/auth/tokens/service-account-token.ts` (.serviceAccountToken.update)
  - `src/lib/mcp/oauth-server.ts` (.mcpAccessToken.create, .mcpRefreshToken.create, .mcpRefreshToken.updateMany, .mcpAccessToken.update, .mcpAccessToken.updateMany)
  - `src/lib/vault/vault-reset.ts` (failedUnlockAttempts, logAuditInTx)

**Assertion that none runs a nested-capable best-effort side effect:** `scripts/checks/check-rls-nesting.mjs` passes over every RLS callback (596 callbacks, 600 context calls) and its type-resolved call closure, which is a superset of these sites.

**What that does not follow:** the gate's stated limits (header: iterator protocol, implicit conversions, Proxy traps, decorators, library-invoked own functions). Work detached past the outer commit is detection-only (R4/D2).

**The list is file-level:** a site reached only through a called function is covered by the gate's closure, not by this list.

## Recurring Issue Check
### Functionality expert
- R3: F1. R24: F4. R29: F3, F7. R34: F7. R41: F5. R49: F3.
- Every other R1-R57 rule: OK or N/A, as reported in the expert's output.

### Security expert
- R29: S-4. R42: S-3. R47/R48: S-1. R49: S-2.
- Every other R1-R57 rule and RS1-RS6: OK or N/A.

### Testing expert
- R19/RT1: T6. R33: T1. R42/RT5: T2. RT7: T1, T3, T4.
- Every other R1-R57 rule and RT1-RT11: OK or N/A. RT8 and RT11 are deferred entries in the deviation log.

## Environment Verification Report
- **Integration suite:** verified-local. `npm run test:integration` was run with the compose workers stopped.
- **RLS verify and negative test (14 cases):** verified-local on a scratch database.
- **CloudWatch metric, alarm and canary:** blocked-deferred to the staging manual test (`bypass-model-grants-and-nesting-fail-closed-manual-test.md`). No AWS environment is reachable from the development host.

## Resolution Status
### F1 [Major] Script pools not ended
- Action: `createPrismaClient(pool, options, { ownsPool })` passes `disposeExternalPool` to the adapter, and the three scripts pass `ownsPool: true`. The app singleton and the workers keep the default, because they end their own pools and a second end throws.
- Tests: integration cells for `ownsPool` true (the pool ends) and false (it does not).
- Modified files: `src/lib/db/pool-factory.ts`, the three scripts, `rls-bypass-grants.integration.test.ts`.

### F2 [Minor] Sink logs under a stale request context
- Action: both sinks use the base logger.
- Tests: a cell runs the notice inside `requestContext.run(child({requestId}))` and asserts no `requestId` on the line. Red-proven against `getLogger()`.

### F3 [Minor] Unreadable-argument calls not printed
- Action: the success output lists each site and states that their reach is unknown in both directions.
- Tests: the unit cell asserts the site line. Red-proven by removing the print.

### F4 [Minor] Split migrations
- Action: `20261019000001` is merged into `20261019000000` (one transaction).
- Dev DB: the `20261019000001` row was deleted from `_prisma_migrations` and the checksum of `20261019000000` updated; `migrate status` is up to date.
- Verified: a fresh database applies the migration, with 57 policies, 56 sub-SELECT tenant branches and no bare cast.
- References and D5 updated.

### F5 [Minor] Unparsed reports unmetered
- Action: a second metric filter counts `rls.bypass_notice_unparsed` on `RlsBypassNotGranted`, so the existing alarm fires. The unparsed line is rate-limited.
- Tests: the unparsed line matches its filter; the filter is bound to the three log groups; it fires once per window. Both cells red-proven.

### F6 [Minor] Two round trips
- Action: `setTenantGucs(tx, tenantId)` sets the tenant id, `bypass_rls='off'` and `bypass_tables=''` in one statement, replacing `pinBypassOff`.
- Tests: exactly one statement before the callback, with the pairing pinned.

### F7 [Minor] Stale comments
- Action: all five places describe the current form and mechanism. The `check-rls-nesting` header and failure text were also updated: a swallowed refusal now fails the request.

### S-1 [Major] Escaped `client_min_messages`
- Action: the startup options are unescaped as `pg_split_opts` does before matching.
- Tests: two deny cells (an escaped underscore, an escaped letter) and an allow cell (an escaped space in `application_name`). Both deny cells were red-proven against the un-normalised match.
- Remaining: a role-level or database-level setting is invisible here. That is the SC5 canary, as stated in the docstring.

### S-2 [Minor] Audit-emit caveat
- Action: restored in `security-review.md`, `tenant-boundary-matrix.md` and the `tenant-rls.ts` docblock.

### S-3 [Minor] C5 per-site list
- Action: listed above, with its evidence and limits.

### S-4 [Minor] Stale citation
- Action: cited by file, with no line range.

### T1 [Major] CI path filter
- Action: `infra/terraform/monitoring.tf` added to the ci.yml `app` filter, with a comment naming the test that reads it.

### T2 [Major] Attach-point positive controls
- Action: integration cells report through the `@/lib/prisma` singleton (with an allow pair) and through a direct `createPool` pool.
- Unit: `src/__tests__/lib/prisma.test.ts` asserts the pool's `connect` listener. Red-proven by removing the attach.

### T3 [Minor] GUC pairing
- Action: `writtenGucs()` maps each set_config name to its value, and the reader test pins `current_setting(<guc>) AS <column>` for each column. Red-proven by swapping names and aliases.

### T4 [Minor] Wrapper self-test stdout-only
- Action: the fake writes its canned output to stderr. Red-proven by dropping `2>&1` (4 cells red).

### T5 [Minor] Probe role
- Action: `passwd_app` is named explicitly.

### T6 [Minor] Two-column fake rows
- Action: `bypassStateRow()` builds full four-column rows.

### T7 [Minor] Real-repo cell diagnosability
- Action: `expect(r.status, r.stderr)`.

### T8 [Minor] Caught-site side-effect cell
- Action: an Anti-Deferral entry in the deviation log. No production handler catches `INVALID_RLS_NESTING`, and the generic rollback cell covers a caught refusal.

### Citation gate (Step 3-6)
- `verify-references.sh --base main --strict`: the code-review, deviation and manual-test docs are clean.
- The 37 hits are in the plan (27) and the plan-review log (10). They cite main as it stood when the plan was written, mostly as a basename plus a line number. They are the record of what the plan was reviewed against, not living claims about the branch, so they are left unchanged. The plan's living statements (C1–C8) cite by subject.

