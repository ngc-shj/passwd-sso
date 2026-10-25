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

---

# Review round 4
Date: 2026-10-25
Scope: `312b8f2ac..HEAD` (6db9f1c57).

## Changes from Previous Round
- Resolved: S6, S7, S8, F-R3-1, F-R3-3, T13 (with T19 remaining), and T14–T18.
- F-R3-2 was resolved in the en README only. The ja table replaced a row instead of adding
  one (F-R4-1).
- Verified while checking:
  - MCP revocation covers every refresh family.
  - Delegation keys in Redis are gated on the DB `revokedAt`.
  - Kept team rows stay reachable through `TeamMember`.

## Findings
- Security:
  - S9 Minor (R43): migrated bridge codes mint target-tenant tokens without the target's
    passkey check at exchange.
  - S10 Minor: `USER_COLUMNS` misses `subjectUserId`, `targetUserId` and `requesterUserId`.
  - S11 Minor: the gate pins `data` keys but not the `where` scoping.
- Functionality:
  - F-R4-1 Major: the ja cause table lost the different-tenant row.
  - F-R4-2 Minor: the `unmapped` different-tenant heading sends the deactivated-row case to
    `add --from`.
  - F-R4-3 Minor: `--single-connection` is accepted silently on UNRESOLVED.
  - F-R4-4 Minor: the `OperatorToken` rows are not revoked. This converges with S10.
  - F-R4-5 Minor: CLAUDE.md lacks `bind` and `legacy-accounts`.
- Testing:
  - T19 Major: the gate silently skips client uses it cannot classify.
  - T20 Minor: three refusal arms have no sample.
  - T21 Minor: a stale doc pointer.
  - T22 Minor: D7 cites line numbers.
  - T23 Minor: two attested-pass integration cells are missing.

## Recurring Issue Check
### Security expert
R42 S10; R43 S9. The rest are clean.
### Functionality expert
R2/R3 F-R4-1, F-R4-2, F-R4-5; R41 F-R4-3; R42 F-R4-4; R49 F-R4-3. The rest are clean.
### Testing expert
R50 T19, T20; RT10 T23; R29 T20, T21, T22. The rest are clean.

## Decisions (round 4)
- F-R4-3: adopted. UNRESOLVED together with `--single-connection` refuses. The D11 no-op was an
  implementation choice, not a user decision, and the CLI's own rule is that a flag the
  operator wrote must take effect or stop the command.
- F-R4-5: the user approved the CLAUDE.md edit, and the orchestrator applied it.

## Resolution Status (round 4)
- F-R4-1 Major: the ja table has its different-tenant row back, so en and ja match row for row
  (8 rows). The new `readme-cause-table-parity.test.ts` pins the reason sequence and the stated
  counts, and it fails loudly when a table is missing. Red proof P1.
- T19 Major: the gate classifies every `tx` and `prisma` identifier in the callback by its
  parent chain. Only `tx.<model>.<method>(`, the `$executeRaw` tag, and a read-only helper
  argument are allowed; anything else throws. Each refused shape has a sample. Red proofs
  T19a–e.
- S9: bridge codes are consumed (`usedAt`) instead of moved, and are classified as REVOKE.
  Red proofs S9a and S9b.
- S10 / F-R4-4:
  - User columns are derived from `User` relations.
  - `operatorToken` joins `STRANDED_COUNTERS`, and the migration revokes it, as
    `invalidateUserSessions` does.
  - The other newly seen models are tenant-owned and are kept, each with a reason (D12):
    `AdminVaultReset`, `PersonalLogAccessGrant`, `AccessRequest`, `MasterKeyRotation`,
    `TeamInvitation` and `TeamPasswordEntryHistory`.
  - Red proofs O1, D1 and D2.
- S11: the gate asserts each write's `where`, which must hold the user column,
  `tenantId: existingTenantId`, and the null predicate for a revoke. This exposed a real
  defect: `account.updateMany` was scoped by `userId` alone, and it now carries the old tenant
  too (D12). Red proofs W1–W5.
- F-R4-2: `unmapped` splits the different-tenant heading. A refusal filed under the claim's own
  tenant gets the SCIM DELETE remedy. Red proofs U1 and U2.
- F-R4-3: UNRESOLVED together with `--single-connection` refuses
  (`ATTESTED_UNCONFIGURED`). Red proof L4.
- F-R4-5: the CLAUDE.md admin-script line lists `bind` and `legacy-accounts`, with the user's
  approval.
- T20–T23 and the D11 team observation are done.

---

# Review round 5
Date: 2026-10-25
Scope: `6db9f1c57..HEAD` (2a9af2a54).

## Changes from Previous Round
- Resolved: S9, S10, F-R4-4, S11, F-R4-1, F-R4-3, T19–T23, and the `account.updateMany`
  scope.
- F-R4-2 is resolved for lowercase claims only (see N2 / F-R5-1 below).
- Verified while checking:
  - the reasons recorded for the kept tenant-owned models;
  - the four bypass grants that gained `operatorToken` are the minimum;
  - every consumer of `STRANDED_COUNTERS` handles the new key.

## Findings
- **Security**
  - N1 Minor (the S9 class): a moved extension or iOS token stays live in the target tenant
    without the target's passkey and lifetime checks until it is refreshed.
  - N2 Minor: the `filed_tenant_owns_claim` comparison is case-sensitive. Converges with
    F-R5-1 below.
- **Functionality**
  - F-R5-1 Major (= N2): a mixed-case claim is misbucketed under the `add --from` heading.
  - F-R5-2 Minor: the summary line merges two remedies.
  - F-R5-3 Minor: CLAUDE.md lacks `add`'s breaking change.
  - F-R5-4 Minor: a stale count in two comments.
- **Testing**
  - T24 Major: writes made through helpers or aliases are skipped.
  - T25 Major: nested writes and non-literal `data`/`where` are skipped.
  - T26–T29 Minor.

## Recurring Issue Check
### Security expert
R43 N1; R55/R57 N2. The rest are clean.
### Functionality expert
R2/R3 F-R5-3, F-R5-4; R34 F-R5-1. The rest are clean.
### Testing expert
R50/R3/R42 T24, T25; RT10 T28, T29; R50 ii T27. The rest are clean.

## Decisions (round 5)
- T24/T25: the gate refuses every shape it cannot read: an unclassified call, a non-literal
  `data`/`where`, a nested write, a spread. It no longer adds one sample per newly found
  spelling (memory: refuse the undecidable class outright).
- F-R5-3: the user approved the CLAUDE.md addition, and the orchestrator applied it.

## Resolution Status (round 5)
- N1: extension and iOS tokens are revoked by the migration, not moved, and sessions still move.
  The integration cells call the real `validateExtensionToken`: the old token gets
  `EXTENSION_TOKEN_REVOKED`, and the positive control gets a distinct DPoP refusal. Red proofs
  N1a and N1b.
- N2 / F-R5-1: `unmapped` compares in JS, using `normalizeTenantClaim` against the filed
  tenants' active claims, so the registry has one normaliser. The SQL `EXISTS` was removed.
  Cells cover mixed case, lowercase, row 7, a revoked claim, and no claim. Red proofs N2a and
  N2b.
- F-R5-2: the summary counts `deactivated-membership` separately, through the same predicate as
  the heading.
- F-R5-3: CLAUDE.md records `add`'s breaking flag requirement and `list --unbound`. The user
  approved this, and the orchestrator applied it.
- F-R5-4: the stale counts were removed from the comments.
- T24: every call, tagged template and `new` inside the callback must be a client call, a
  read-only helper, or an exact `PURE_CALLS` entry. Anything else throws. Red proofs T24a–e.
- T25: a write's argument, `data` and `where` must be object literals with no spread, and
  nested writes are refused. `NON_COUNTER_DATA_KEYS` pins the data keys of each non-counter
  write. Red proofs T25a–f.
- T26: rows are keyed on reason plus their code spans. The stated heading count must equal the
  number of `printGroup` calls, counted with ts-morph. Red proofs T26a and T26b.
- T27: the schema parser refuses a `User` relation it cannot read. Red proofs T27a and T27b.
- T28: operator tokens are seeded with the subject and the creator as different users, and a
  realign `leftBehind` cell counts by subject. Red proofs T28a and T28b.
- T29: the revoked-claim boundary is covered, and the heading-order assertion is unconditional.

---

# Review round 6
Date: 2026-10-25
Scope: `2a9af2a54..HEAD` (d6eec0613).

## Changes from Previous Round
Every round-5 finding was verified as resolved: N1, N2/F-R5-1, F-R5-2, F-R5-3, F-R5-4 and
T24–T29. On the migration gate, the testing expert concluded that it now refuses every shape
that can write inside the callback in this codebase, and that further node-kind refusals would
bring diminishing returns.

## Findings
- **Security**
  - S-R6-1 Minor (R43): `apiKey` still moves. A key minted under the bootstrap tenant's policy
    stays live in the target tenant for up to 365 days, without the target's passkey check.
    `invalidateUserSessions` revokes it.
  - S-R6-2 [Adjacent] Minor: enabling `requirePasskey` never re-checks existing API keys.
    Pre-existing; follow-up.
  - S-R6-3 [Adjacent] Minor: after the migration, a failure to tombstone the session cache is
    discarded silently.
- **Functionality**
  - F-R6-1 Minor: a stale count in a comment, and the empty-result message omits the new
    bucket.
  - A-R6-1 [Adjacent] Minor: an iOS refresh after the revocation logs a false replay.
    **Rejected by the orchestrator.** `src/app/api/mobile/token/refresh/route.ts` checks the
    token tenant's membership before `refreshIosToken`. The bootstrap membership is gone, so the
    request gets a 401 before the replay branch. The security expert found the same.
- **Testing**
  - T30 Minor: the realign cells clean up after their assertions instead of on test finish.

## Recurring Issue Check
### Security expert
R42/R43 S-R6-1. The rest are clean.
### Functionality expert
R2/R3 F-R6-1. The rest are clean.
### Testing expert
Test hygiene T30. The rest are clean.

## Resolution Status (round 6)
- S-R6-1: API keys are revoked by the migration, not moved. The integration cells call the real
  `validateApiKey`. A migrated key is refused with `API_KEY_REVOKED`. A key the boundary user
  holds is still accepted, and so is a key created after the migration, which is the positive
  control. A key that was already revoked keeps its original `revoked_at`. Red proofs S1a and
  S1b.
  - Parity with `invalidateUserSessions`: the migration revokes every credential type that
    function revokes. Those are extension tokens, API keys, MCP access tokens, MCP refresh
    tokens, delegation sessions, and operator tokens (matched by subject).
  - Sessions differ. They move instead of being deleted, because the proxy re-derives the
    passkey requirement from the tenant of the active membership.
  - WebAuthn credentials are kept by both paths.
- S-R6-2: follow-up issue, since the behaviour predates this branch.
- S-R6-3: tombstone failures are logged and sent to Sentry, the same way
  `invalidateUserSessions` does. Red proofs S3a and S3b.
- F-R6-1: the comment no longer states a count, and the empty-result message names all five
  classes. Red proof F1a.
- T30: `seedDeparted` registers cleanup with `onTestFinished`, and the redundant trailing
  deletes are gone. Red proofs T30a and T30b. With the hook removed, an injected failure leaked
  28 tenants.

---

# Review round 7
Date: 2026-10-25
Scope: `d6eec0613..HEAD` (52598f012).

## Changes from Previous Round
Every round-6 finding was verified as resolved: S-R6-1, S-R6-3, F-R6-1 and T30. The security
and functionality experts returned "No findings". The testing expert returned three Minors:
- T31: two realign cells still clean up after their assertions;
- T32: the empty-result labels are a hand list beside the summary's, and this drift has
  shipped twice;
- a D7 wording slip (T30b cell count).

## Recurring Issue Check
### Security expert
R42 parity, R43 (narrowed), logging hygiene, fail-open on revocation: all clean.
### Functionality expert
Member-set parity, docs ↔ code, the swallowed failure signal, test cleanup: all clean.
### Testing expert
R42 class closure: T31, T32. Positive controls, mock hoisting, red-proof bookkeeping: clean,
apart from the D7 wording.

## Tightening-only skip — Round 7
Findings applied directly (no round 8 review):
- T31 [Minor] The two realign cells register their cleanup with `onTestFinished`, and their
  trailing deletes are dropped. File: `src/__tests__/db-integration/tenant-claim-cli.integration.test.ts`.
- T32 [Minor] `UNMAPPED_SUMMARY_CLASSES` is one table that both arms of
  `formatUnmappedMessage` read. The empty-message cell iterates over it. The output text is
  unchanged. Red-proved on the scratch copy: an empty arm that stops reading the table fails the
  cell. Files: `scripts/tenant-domain.ts` and the same test file.
- D7 T30b wording now reads "14 `seedDeparted` calls in 13 cells".

Justification:
- Every finding falls inside the round-6 fix scope: the realign cleanup, the unmapped summary
  and the D7 table.
- All three are inline minors (test hygiene, message assembly with identical output, doc
  wording).
- None touches a security boundary.

## Follow-ups (not in this PR)
- S-R6-2: enabling `requirePasskey` never re-checks existing API keys. This predates the branch.
- F-R2-1 remedy: directory sync and SCIM should migrate a user who is active only in a
  sole-member bootstrap tenant. Draft: `scratchpad/followup-bootstrap-reactivation.md`.
- D9: a re-key command for the multi-connection legacy lockout. Draft:
  `scratchpad/followup-rekey.md`.

## Environment Verification Report
N/A: Phase 1 declared no environment constraints. The browser sign-in through two live Jackson
connections (`sso-claim-connection-binding-manual-test.md`) has not been executed; it is
manual.
