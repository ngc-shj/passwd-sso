# Code Review: sso-claim-connection-binding
Date: 2026-10-25
Review round: 1

## Changes from Previous Round
Initial review. Local LLM seeds were unavailable (the server returned HTTP 400 on the full
diff), so all three experts reviewed the full diff.

## Functionality Findings
- F1 Major — `cmdRemove`'s revoke CAS omitted `provider` while its event recorded the
  pre-prompt provider; a `bind` committed during the confirmation prompt left a stale provider
  in the append-only history.
- F2 Major — a deployment that ran the legacy provider with Jackson's `dummy` or an encoded
  client id, `AUTH_REDIRECT_PROXY_URL`, and two or more connections has every SAML account at
  `saml-jackson`; after the upgrade only one connection keeps that id and the others' users are
  locked out, with no in-app recovery (a raw `UPDATE` breaks the token AAD).
- F3 Minor — a CRLF or BOM bind file was refused with a misleading control-character error.
- F4 Minor — the new binding flags were silently ignored outside `bind`.
- A1 [Adjacent] Minor — `--out`'s worktree check is decided on a path that `openSync` resolves
  again (R51).

## Security Findings
- S1 Critical (escalate: true) — Auth.js calls `signIn` before its account-link check, and the
  callback chose the user by the IdP-asserted email. An IdP admin behind one connection, asserting
  a victim's email together with their own bound claim, had the victim's membership and data moved
  into their tenant; Auth.js refused the session only after those writes had committed. The
  connection binding attests the connection, not the user, so it did not close this.
- S2 [Adjacent] Minor — a stored NULL claim beginning with `#` was written as a data line that the
  bind-file parser skips as a comment.
- R51 (`--out`) and R49 (`emitAuthLoginFailure`'s optional binding) re-examined, not raised.

## Testing Findings
- T1 Major — the Jackson image drift test did not run on PRs changing only its inputs (tfvars
  re-tags, the probe matrix).
- T2 Major — the existing CLI integration suite passed only when the developer's `.env`
  configured no claim provider; the provider-env key list was hand-written three times.
- T3 Minor — existing-user allow assertions held before the sign-in ran; no real-DB
  existing-user × unregistered-claim cell.
- T4 Minor — D7's B2 red proofs had no unmutated baseline and no test names.
- T5 Minor — `jackson-probe` had no timeout and no record of registering it as a required check.
- T6 Minor — one unknown-ref unit test could pass without a real ref.
- T7 Minor — grid strict cells presented a provider the env did not configure.

## Adjacent Findings
- A1 (functionality, R51 `--out`): the security expert re-examined the same point independently
  and did not raise it.
- S2 (security → functionality): fixed with the bind-file findings.

## Quality Warnings
None. Every finding carried file, line and evidence.

## Recurring Issue Check
### Functionality expert
R2 clean; R3 F1; R6 N/A; R17 clean; R34 F1; R41 F2; R48 clean; R51 F1, A1; R57 clean.
R1, R5, R7, R9, R12, R14, R15, R16, R18, R19, R24, R25, R29, R31, R33, R35, R36, R37, R42, R55
clean per the Phase 2 self-check, not re-run.

### Security expert
R1/R2/R17 clean; R3 S1; R5/R9 clean; R14 clean; R24 clean; R25 clean; R29 clean; R31 clean;
R42 claim-path member set complete, the user-identity path was the omitted member (S1);
R43/R52 S1; R47/R48 clean; R49 S1 (README strict-mode guarantee); R51 noted; R55/R57 clean.
RS1 clean; RS2 N/A; RS3 clean; RS4 clean; RS5 N/A; RS6 clean.

### Testing expert
R1/RT3 T2; R16 T2; R29 T4; R33 T1; R42 pass; R50 partial (T5); R3, R12, R14, R18, R19, R24,
R35, R36, R48, R55 clean per the self-check.
RT1 pass; RT2 pass; RT3 T2; RT4 pass; RT5 pass; RT6 pass; RT7 mostly pass (T4); RT8 pass;
RT9 pass; RT10 pass; RT11 partially mitigated.

## Environment Verification Report
N/A — no environment constraints declared in Phase 1. The browser sign-in through two live
connections is covered by `sso-claim-connection-binding-manual-test.md`, not yet executed.

## Resolution Status
### S1 Critical — sign-in subject chosen by the asserted email before Auth.js's link check
- Action: an OAuth/OIDC sign-in resolves its subject through the adapter's `getUserByAccount`
  first. It follows an email match only where `allowsDangerousEmailAccountLinking` holds (Google
  with a domain restriction; the same predicate builds the Google provider). Otherwise it refuses
  with `account_not_linked` before any write. Real-DB deny and allow cells; red proofs S1a–S1d in
  D7.
- Modified file: `src/auth.ts` (`resolveOAuthSignInSubject`, the `signIn` callback),
  `src/auth.config.ts` (`allowsDangerousEmailAccountLinking`), `src/lib/audit/auth-failure.ts`.

### F1 Major — `remove` CAS without provider
- Action: the revoke CAS includes `provider: existing.provider`; a concurrent rebind is refused
  and writes no event.
- Modified file: `scripts/tenant-domain.ts` (`cmdRemove`).

### F2 Major — multi-connection legacy upgrade lockout
- Action: the user chose to document this as a breaking consequence in this PR and to file the
  account re-key command as a follow-up issue. The README upgrade section (en/ja) opens with
  the known lockout: who is affected, what happens, why a raw `UPDATE` is not a recovery, to
  leave those `bind --from-members` lines empty, and the two options (stay on the previous
  version, or re-provision). Plan C6 records it, and D9 records the decision.
- Modified file: `README.md`, `README.ja.md`, the plan's C6.

### T1 Major — drift test not run on input-only PRs
- Action: `jackson-probe` runs the drift test after `npm ci`, and the `app` filter gains
  `ci-integration.yml` and `infra/terraform/**/terraform.tfvars.example`.
- Modified file: `.github/workflows/ci-integration.yml`, `.github/workflows/ci.yml`.

### T2 Major — CLI suite depended on the developer's provider env
- Action: one shared `stubClaimProviderEnv` (its key list is compile-time complete against
  `jackson-providers.ts`) asserts the derived mode; all three suites use it. Red-proved by
  running the pre-fix suite under an exported Google + Jackson + strict env (30/102 red).
- Modified file: `src/__tests__/helpers/tenant-claim-fixtures.ts` and the three suites.

### Minor findings
- F3: a CRLF or BOM bind file is refused up front with a message naming it.
- F4: per-subcommand accepted-flag sets; `--accept-unused-provider` with `--unbound` refused.
- S2: a claim starting with `#` is listed under a "Not written" note instead of a data line.
- T3: delta assertions and existing-user × unregistered-claim cells.
- T4: B2 re-run with baselines and test names. M7 (`PROVIDER_REF_INFO` changed) had survived;
  a recorded vector now catches it.
- T5: `timeout-minutes: 15`; the manual-test file gains the required-check registration step.
- T6: the test asserts the mapping kind and the ref shape first.
- T7: strict uses connections alpha and bravo, off uses alpha alone.

### A1 [Adjacent] Minor — `--out` path re-resolved by `openSync` — Skipped
- **Anti-Deferral check**: acceptable risk.
- **Justification**:
  - Worst case: a local principal who can write to a directory the operator named swaps the
    parent between the check and the open, so the bind file lands inside the git worktree.
  - Likelihood: low. It needs write access on the operator's own host, to a path the operator
    chose. `O_EXCL` already refuses an existing file or symlink at the final component.
  - Cost to fix: an `openat`-style descriptor walk, which Node does not expose.
  - The check exists to keep the file out of git, not to defend against a local adversary. The
    security expert re-examined it independently and did not raise it.
- **Orchestrator sign-off**: the worktree refusal is a guard against operator error, and both
  experts agree the residual race needs local write access.

### Discovered during the fixes — bootstrap migration (rows 6 / 9a) fails on a real DB
The migration creates the target's active membership while the bootstrap one is still active,
which `tenant_members_one_active_per_user` refuses. This is pre-existing on `main` and is
recorded in D8.
- Action: the migration deletes the bootstrap membership, then `create`s the target one in the
  same transaction. A membership row the user already holds in the target can only be a
  deactivated one. The migration is refused before any write with `tenant_mismatch`, filed
  under the target tenant, so the user keeps the bootstrap tenant. This mirrors the established
  policy that a sign-in never reactivates a membership (row 4's `update: {}`, `tenant-domain
  realign`'s `REALIGN_WARNING`, and R6-S2 and F-R7-2 in
  `audit-tenant-adjudicator-code-review.md`). Real-DB cells cover rows 9a, 6 and 6b and the
  deactivated row. Red proofs R2-M1 to R2-M2c are in D7.
- Modified file: `src/auth.ts` (`claimedTenantMembership`).

---

# Review round 2
Date: 2026-10-25
Scope: `770d7cd66..HEAD` (c83e128a8 round-1 fixes, 3bfca8a88 bootstrap migration + lockout docs).

## Changes from Previous Round
Every round-1 finding was verified as resolved: S1, F1, F3, F4, S2, T1–T7, and the bootstrap
migration fix. No fix widened a boundary (R43). New findings are below.

## Security Findings
- S3 Critical (escalate: true), new. The round-1 lockout text (D9) let the operator keep
  `AUTH_JACKSON_ID` pointing at one connection's own client. The pre-upgrade
  `saml-jackson` accounts of the other connections' users then stay resolvable through that
  client. Its IdP can assert such a user's `providerAccountId` with no claim, which takes the
  existing-user allow, and sign in as them. The text also offered staying on the previous
  version as safe, which leaves the same takeover open from every connection.
- S4 Minor, new. `account_not_linked` is the signature of both the S1 attack and the D9
  lockout, and no operator surface showed it.
- S5 Minor, new. The active-session note at `resolveOAuthSignInSubject` and in D8 omitted the
  allowed case: a non-linking provider whose email names no user, which Auth.js then links to
  the session user.

## Functionality Findings
- F-R2-1 Major, new. The deactivated-target-row refusal has no working remedy, so a user who
  reaches it stays stuck:
  - directory sync creates the row deactivated and refuses to reactivate it
    (`ACTIVE_IN_ANOTHER_TENANT`) while the bootstrap membership is active;
  - SCIM reactivation is refused by `tenant_members_one_active_per_user`;
  - `realign` takes only users who are active nowhere.

  This is a regression from `main`, where the same case converged by accident.
- F-R2-2 Minor, new. The valueless-flag check runs before the stray-flag check.
- F-R2-3 Minor, new. `bind --from-members` suggests `saml-jackson` only while that provider
  is still configured.

## Testing Findings
- T8 Major, new. The bootstrap-migration cells seed and assert 5 of about 17 moved tables.
- T9 Major, new. Sixteen `signIn` unit cells give OIDC accounts no `type`, so after S1 they
  exercise the email-lookup arm.
- T10 Minor, new. The no-change snapshot has no positive control in the same file.
- T11 Minor, new. D7 claimed more for the row-6b cell than it shows, and that claim was never
  red-proved.
- T12 Minor, new. The `SUBCOMMAND_FLAGS` derivation is regex-based and does not see a case
  that passes `flags` straight to a handler.

## Recurring Issue Check
### Functionality expert
R2 clean; R3 F-R2-1; R6 N/A; R17 clean; R34 clean; R41 F-R2-1; R42 complete; R43 clean;
R48 clean; R49 F-R2-3; R51 A1 skipped; R57 boundary stated.
### Security expert
R1/R2/R17 clean; R3 clean; R9 clean; R14/R24/R25 clean; R42 S4 (readers of
`account_not_linked`); R43 no widening; R48 clean; R49 S3, S5; R52 S3; R55/R57 clean;
RS1/RS3/RS4 clean.
### Testing expert
R1/RT3 T9; R3 T8; R42 T8; RT1/RT2/RT4/RT5/RT6/RT8/RT9 pass; RT7 T10, T11; RT10 T10;
RT11 holds; R50 T12; R29 T11; R16/R33 clean.

## User decisions (round 2)
- S3: correct the README, and add a read-only `tenant-domain` check. The check refuses when the
  legacy provider is configured and `saml-jackson` accounts span more than one tenant.
- F-R2-1: keep the refusal and correct the false remedy claim in the code comment, D8 and the
  docs. Directory sync and SCIM migrating a bootstrap-only user is a follow-up issue.

## Resolution Status (round 2)
### S3 Critical — legacy `saml-jackson` rows resolvable through a kept legacy client
- Action:
  - README en/ja "Known lockout" is rewritten. In the affected class, do not configure
    `AUTH_JACKSON_ID`/`SECRET` after the upgrade, and list every connection in
    `AUTH_JACKSON_CONNECTIONS`. Staying on the previous version keeps the takeover open from
    every connection.
  - New read-only `tenant-domain legacy-accounts`. It exits 1 when the legacy provider is
    configured and `saml-jackson` accounts span more than one group, where "no active tenant"
    counts as its own group. It also exits 1 when the provider config cannot be read. It exits
    0 with a statement otherwise.
  - The runbook runs it before strict is set.
  - Red proofs L1–L3b are in D7.
- Modified file: `scripts/tenant-domain.ts`, `scripts/lib/tenant-domain-binding.ts`,
  `src/lib/tenant-rls-grants.ts` (`TENANT_LEGACY_ACCOUNT_READ`), `README.md`, `README.ja.md`.

### F-R2-1 Major — deactivated-target-row refusal has no remedy
- Action: per the user's decision, the refusal is kept. The comment in `src/auth.ts` and D8 now
  state that no producer can reactivate this user today. The one working step is also
  documented: the target tenant deletes the row through SCIM, and the user signs in before the
  next directory sync. The follow-up issue is drafted, and producer-side migration goes there.

### T8 Major — migration cells covered 5 of the moved tables
- Action: `MOVED_TABLES` lists the 18 tables read off the migration transaction, and each one
  is seeded and asserted, with third-tenant boundary rows. The deny cells use the same
  snapshot. Red proofs T8a–T8c are in D7. No real defect was found.

### T9 Major — OIDC unit cells had no account type
- Action: 17 cells now use `type: "oidc"` with a `providerAccountId`, and `type` is required in
  the helper at compile time and at runtime. The two cells that survived the T9 mutation now
  assert which user the membership was written for.

### Minor findings
- S4: `alerts.md` gains an `account_not_linked` entry with a query, which was run read-only.
- S5: the comment and D8 now name the third active-session case.
- F-R2-2: the stray-flag check runs before the valueless-flag check.
- F-R2-3: the README states when `saml-jackson` is suggested.
- T10: both own-account allow cells assert that the snapshot changed.
- T11: the 6b cell is red-proved, and D7 is reworded.
- T12: the derivation test fails on an unrecognised `flags` use and names the case.

---

# Review round 3
Date: 2026-10-25
Scope: `3bfca8a88..HEAD` (312b8f2ac).

## Changes from Previous Round
- Resolved: S3 (README part), S4, S5, F-R2-1, F-R2-2, F-R2-3, T9, T10, T11 and T12.
- Partly resolved: S3, through the `legacy-accounts` verdict, and T8.
- Verified while checking: an `AUTH_JACKSON_CONNECTIONS` entry id can never equal
  `saml-jackson`, and the SCIM DELETE remedy deletes only target-tenant rows.

## Findings
- **S6 Major / F-R3-1 Major (converged), with S8 [Adjacent] Minor.**
  - Defect: `legacy-accounts` treats a tenant as a stand-in for a connection. No account
    records its connection, so the verdict is wrong in both directions.
  - False pass: one tenant reached through two connections, or users who are active nowhere.
  - False refusal: a single-connection deployment with a departed SAML user or a bootstrap
    user, where the prescribed remedy locks out every SAML user.
- **S7 Minor.** The verdict depends on the environment the CLI loads, not the one the app
  runs with.
- **F-R3-2 Minor.** The README cause table lacks the deactivated-target-row
  `tenant_mismatch`, and the SCIM DELETE remedy appears only in a code comment and in D8.
- **F-R3-3 Minor.** Two messages are worded for the wrong context.
- **T13 Major.**
  - Defect: `MOVED_TABLES` is a hand-written list, tied neither to the migration body nor to
    `STRANDED_COUNTERS`.
  - [Adjacent]: eight `STRANDED_COUNTERS` models are not moved by the migration, and nothing
    records why: `delegationSession`, `extensionBridgeCode`, `mcpAccessToken`,
    `mcpAuthorizationCode`, `mcpRefreshToken`, `mobileBridgeCode`, `teamMemberKey` and
    `teamPasswordFavorite`.
  - Why it is in scope: on `main` the migration never succeeded, so this branch is what
    makes the gap reachable.
- **T14 Major.** The global precondition in the `legacy-accounts` cells, together with
  seeding outside `try`, turns every later run red once a seed fails.
- **T15–T18 Minor.**
  - T15: once-queue hygiene.
  - T16: `dispatchBind` is not scanned.
  - T17: no allow cell for a deactivated row in another tenant.
  - T18: the boundary row is not red-proved, and its seed runs outside `try`.

## Recurring Issue Check
### Security expert
R42 S6; R49 S6, S7; R50 S7; R52 S6. R43: no widening. Output is escaped. The rest are clean.
### Functionality expert
R3 F-R3-2; R41 F-R3-1; R42 F-R3-2; R49 F-R3-1. The rest are clean.
### Testing expert
R3/R42 T13; RT7 T18; RT10 T17; R50 T13, T14. The rest are clean.

## User decision (round 3)
`legacy-accounts` decides on the operator's attestation (`--single-connection`), not on the
tenant grouping, which the command now prints as evidence only. This replaces the round-2
tenant-span condition.

## Resolution Status (round 3)
### S6 Major / F-R3-1 Major / S8 Minor / S7 Minor / F-R3-3 Minor — `legacy-accounts` verdict
- Action: the command now decides on the operator's attestation, as the user decided.
  - NONE (exit 0): no `saml-jackson` accounts exist.
  - UNRESOLVED (exit 0): the legacy provider is not configured in the CLI's env. The message
    ends with an instruction to confirm the app's runtime env as well.
  - UNATTESTED (exit 1): the legacy provider is configured, accounts exist, and no
    `--single-connection` was given.
  - ATTESTED (exit 0): the same, with `--single-connection`.
  - The per-tenant grouping is printed as evidence and decides nothing. The refusal text is
    phrased in terms of connections, and `readAppEnv`'s refusal names the command.
  - Red proofs L1–L3 and T17 are in D7.
- Modified file: `scripts/lib/tenant-domain-binding.ts`, `scripts/tenant-domain.ts`,
  `scripts/lib/tenant-domain-flags.ts`, README en/ja.

### T13 Major — migration member set, and eight unmoved models
- Action: each of the eight models was decided from existing code (D11).
  - Moved: `extensionBridgeCode` and `mobileBridgeCode`. Their exchange mints an
    `extension_tokens` row under the code's tenant, and that table is already moved.
  - Revoked: `mcpAccessToken`, `mcpRefreshToken` and `delegationSession`. They are bound to a
    tenant-owned MCP client that is not moved; `invalidateUserSessions` revokes the same three.
  - Marked used: `mcpAuthorizationCode`.
  - Kept, with reasons recorded in `NOT_MIGRATED`: `teamMemberKey` and `teamPasswordFavorite`.
    They are written under the team's tenant, and teams are not moved.
  - A ts-morph gate (`src/auth.bootstrap-migration.test.ts`) reads the migration transaction
    body. It requires the writes to equal `STRANDED_COUNTERS` minus `NOT_MIGRATED`, plus the
    non-counter writes, and it refuses loudly when nothing matches. The integration seeders are
    typed from the same set.
  - Red proofs B1–B3 are in D7.
- Modified file: `src/auth.ts`, `src/auth.bootstrap-migration.test.ts`,
  `src/__tests__/helpers/bootstrap-migration-set.ts`, the binding integration suite.

### T14 Major — `legacy-accounts` cells and the shared DB
- Action: every seed runs inside `try`, with cleanup in `finally`. The precondition is still a
  hard failure, and its message is now actionable. Red proof T14 is in D7. The cross-run
  persistence was not reproduced: `afterAll` cleanup already swept the leak. The in-run cascade
  was reproduced and is fixed.

### Minor findings
- F-R3-2: the README cause table now has eight causes, including the deactivated-target-row
  `tenant_mismatch` and its SCIM DELETE remedy.
- T15: the once-queues are reset per cell, and the unexpected-error cell asserts its emit.
- T16: the body of `dispatchBind` is scanned too.
- T17: an allow cell for an active-in-A, deactivated-in-B user.
- T18: `seedBoundary` runs inside `try`. The boundary assertion was red-proved with a
  time-bounded predicate in place of the tenant condition, because dropping the condition would
  have touched shared dev rows.
