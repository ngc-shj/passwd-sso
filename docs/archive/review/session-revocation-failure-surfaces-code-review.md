# Code Review: session-revocation-failure-surfaces
Date: 2026-11-17
Review round: 1

## Changes from Previous Round
Initial review. The branch was rebased onto origin/main 8e42a9c35 before review. The local LLM pre-screen and seeds were unavailable (Ollama down), so each expert reviewed the full diff.

## Functionality Findings
The transaction semantics hold: every membership-ending transaction revokes inside itself, and the nested SCIM service transaction joins the route's context. Error mapping covers `UserAuthLockTimeoutError`, 40P01 and P2028 on every route that can hit them. There is no new import cycle (madge), and every Implementation Checklist file is in the diff.

| ID | Sev | Finding |
|----|-----|---------|
| F1 | Minor | `user-auth-serialization.ts` / `team-departure.ts` doc comments claim the user-auth lock is taken last in the transaction. It is taken last per departure call; directory sync (several calls) and SCIM PUT (D5) write after it |
| F2 | Minor | `tombstoneRevokedSessions` error log omits `context.extra`, so the passkey-revoke and directory-sync lines lose their subject ids |
| F3 | Minor | `lock-conflict-response.ts` doc does not list the user-auth lock timeout among CONFLICT cases |
| F4 | Minor (Adj) | `docs/operations/deployment.md` sign-off checklist still describes `#1047` as open |

## Security Findings
| ID | Sev | Finding |
|----|-----|---------|
| S1 | Major | Credentials left alive by departures made before this change are never revoked: every directory-sync departure, and every SCIM/team failure that was swallowed. `returnToTenant` revokes nothing, so a reactivation brings them back to life (API keys without expiry, unexpired sessions and tokens) |
| S2 | Minor | Directory-sync revocations leave no per-user record for departed users with no team memberships, since the `TEAM_MEMBER_TENANT_DEACTIVATE` rows exist only per ended team membership |

Verified with no finding: lock order and mint races, RLS reach and grants, the admin-reset reorder, the new 409 text (no cross-tenant disclosure), and the rule-9 gate as a declared tripwire.

## Testing Findings
| ID | Sev | Finding |
|----|-----|---------|
| T-1 | Minor | The "tombstones after the commit" unit cells compare against the transaction wrapper's invocation, not its completion. Red-proved: a tombstone moved inside the team DELETE callback leaves all 62 cells green |
| T-2 | Minor | SCIM `[id]` 409 cells (PUT, DELETE) do not assert that no tombstone was attempted |
| T-3 | Minor | The integration 409 cell "changing nothing" does not assert an empty audit outbox |

Every AC maps to a test that can fail for its stated reason. Triggers are dropped before create and in `finally`, and the race cells have positive controls.

## Adjacent Findings
- F4 (Functionality → Security): the deploy sign-off item describing the residual risk.

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
- R3: F3, F4
- R29: F1
- R49: F1
- Checked: R1, R2, R4, R5, R9, R10, R12, R14, R16, R17, R18, R20, R22, R25, R31, R34, R36, R37, R38, R40, R41, R42, R43, R44, R47, R48, R50, R52, R53, R57
- N/A: all others

### Security expert
- R3: S1
- R29: S2
- R34: S1
- R39: S1
- R46: note only (scope-blind `calleeName`, backstopped by the pinned set)
- R47: KNOWN LIMITS documented
- OK: R1, R2, R5, R6, R9, R10, R12, R14, R16, R17, R18, R19, R20, R22, R25, R31, R36, R37, R38, R40, R41, R42, R43, R44, R45, R48, R49, R50, R51, R52, R54, R55, R57
- N/A: all others
- RS1–RS6: N/A or OK (no new input surface)

### Testing expert
- R49: T-1
- RT7: T-1
- RT8: T-2, T-3
- Checked: R1, R2, R3, R5, R6, R9, R16, R17, R18, R19, R21, R29, R42, R44, R50, R53
- RT1: Checked
- RT2: Checked
- RT3: Checked
- RT4: Checked
- RT5: Checked
- RT6: Checked
- RT10: Checked
- RT11: Checked
- N/A: all others

## Environment Verification Report
- E1 (no real IdP): `blocked-deferred`. The constraint is recorded in the plan's Project context E1, with the justification in C6. The rollback holds whatever an IdP does with a 500 or a 409, which T1 shows against the real DB.
- E2 (worktree DB): `verified-local`.
  - `npm run test:integration -- session-revocation`: 3 files, 23 passed.
  - The impacted integration files pass.
  - Full integration: 1967 passed, 15 failed, all environmental:
    - the MinIO suites need `ANCHOR_TEST_S3_ENDPOINT`;
    - `retire-dcr-cleanup-worker`, `revoke-public-connect` and `audit-db-grants` fail because this worktree DB holds a stale CONNECT grant for the retired role `passwd_dcr_cleanup_worker` (`has_database_privilege` is true on `passwd_sso_wt_1047`, false on `passwd_sso`).

    No file in the diff touches roles, grants or S3. CI runs these on a fresh database with MinIO.

## Resolution Status
### Round 1
- S1 Major (leftover credentials revived on reactivation): fixed. `returnToTenant` revokes exactly the users it reactivates, scoped to the tenant and as its last step, in the return's transaction. SCIM REACTIVATE carries the revocation, and its audit row the counts. Directory sync collects it and tombstones it after the commit. Plan C2/C3 amended; deviation D8. Covered by unit cells in `team-departure.test.ts` and the integration describe "a reactivation revokes what an earlier departure left alive" (SCIM PATCH and directory sync; the other tenant survives). Red-proved by making `returnToTenant` revoke nothing.
  - Alternatives considered: a one-time operator cleanup script would also have covered the period while the member stays deactivated. In that period the proxy and token validators deny on membership, which `auth-gate.ts` fails closed on. The lazy revocation is chosen because it closes the reachable exposure, reactivation, without an operator step, and every future reactivation heals itself.
- S2 Minor: fixed. The `directory-sync.credentials-revoked` log carries `departedUserIds` / `returnedUserIds`.
  - Anti-Deferral for the per-user audit row: a new audit action costs the full R12 surface (action groups, en/ja i18n, webhook groups, tests) for a record the sync log row and this structured line already attribute.
  - Worst case: an admin sees a teamless user's revocation in logs rather than in the audit UI.
  - Likelihood: every sync that deactivates a teamless user.
  - Cost to fix: a new action and its R12 surface, about 1 h.
- F1 Minor: fixed (doc comments in `user-auth-serialization.ts` and `team-departure.ts`).
- F2 Minor: fixed. The tombstone log spreads `context.extra`, spread first so it cannot overwrite the helper's own fields; pinned; recorded in D1.
- F3 Minor: fixed (`lock-conflict-response.ts`).
- F4 Minor: fixed. The `deployment.md` attestation item keeps its original meaning (the issue is filed) and adds that from the fixing release the revocation commits with the departure. A reviewer's rewrite into a "production runs the fix" precondition was not kept, because it would have changed the enforce-flip deploy policy.
- T-1 Minor: fixed. The transaction doubles record a commit marker after the callback resolves, and team DELETE, SCIM PUT/PATCH/DELETE/POST and directory sync assert commit before tombstone. Each is red-proved by moving the tombstone inside the callback.
- T-2 Minor: fixed (the SCIM `[id]` 409 cells assert no tombstone).
- T-3 Minor: fixed (the integration 409 cell asserts an empty outbox; its released pair asserts one `SCIM_USER_DEACTIVATE`).

Verification:
- `npx tsc --noEmit`: 0.
- `npx vitest run` (full, 24890 passed): 0.
- `npx next build`: 0.
- eslint on the touched files: 0.
- Rule-9 gate, check-bypass-rls, check-raw-sql-usage: 0.
- `npm run test:integration -- session-revocation team-tenant-departure departed-member-operator-scripts team-key-version-guard user-auth-serialization directory-sync scim` (13 files, 290 passed): 0.

### Round 2
Reviewed commit 185541da7. Findings:
- F5 (Functionality, Major) / S3 (Security, Major): credential residue from earlier departures is revived by any admission, not only a return. Fixed in 787a8f24c by migration C9 (`20261116200000_revoke_departed_member_credential_residue`). It revokes the ten models wherever the (user, tenant) pair has no active membership, under the same per-user credential lock, idempotently. Plan C9; deviation D9.
- F6 (Minor): fixed. Sentry `extra` precedence now matches the log.
- F7 (Minor) / S4 (Minor): fixed. The directory-sync log caps each id list at 100, with counts and `userIdsTruncated`.
- T-1 (Minor, continuing): fixed. The SCIM `[id]` commit marker is on the outermost `withTenantRls`.
- Bridge code stamped with `User.tenantId`: first recorded as no gap (D10), then fixed in round 3 (F3).

Between rounds 2 and 3:
- Merged origin/main (#1062) in 627963b21; conflicts resolved with both sides kept.
- `TEAM_MEMBER_REMOVE` now commits inside the removal's transaction and is pinned in `check-critical-audit-atomic` (35e2d67e4, D11). This was a handoff from the #1062 session.

### Round 3
Reviewed 787a8f24c, the 627963b21 merge resolution and 35e2d67e4. Findings:
- F1 (Security, Major) / F8 (Functionality, Major): during a rolling deploy, old-release instances create residue after the one-time migration has run. Fixed: `getSessionAndUser` binds a session to a tenant where its user holds an active membership, compared against the membership and never the `User.tenantId` column. A failed lookup propagates. This covers every `auth()`, including the route-handler-auth paths.
  - Sessions are neutralised by the binding, reactivations by `returnToTenant` (D8), and tokens are already checked against their own tenant.
  - One path remains: an old-release SCIM DELETE whose revocation fails during the rollout, followed by a later same-tenant re-creation. It is recorded with an Anti-Deferral entry in D12.
  - The C9 over-claim is corrected.
- F2 (Security, Minor): a session stamped before the credential lock with a just-departed tenant. Covered by the binding, which makes it dead (D12).
- F3 (Security, Minor): fixed. The bridge code resolves the tenant of the active membership and uses it for every stamp. No membership → 401 with `no_active_membership`.
- F9 (Functionality, Minor): fixed. A NOTICE gives the lock-set size, and the header states the lock-table bound.
- Q-1, Q-2, Q-3 (Testing, Major) and Q-4, Q-5, Q-6 (Minor): fixed.
  - Q-1: a second connection observes the migration's per-user locks.
  - Q-2: a failing in-transaction `TEAM_MEMBER_REMOVE` audit fails the DELETE.
  - Q-3: operator tokens are seeded with subject ≠ creator.
  - Q-4: no-audit assertions now target `logAuditInTx`.
  - Q-5: a misleading cell title is renamed.
  - Q-6: lower bounds on the first-run report.
- Each is red-proved; the red-proof table is in the deviation log.

Verification:
- `npx tsc --noEmit`: 0.
- Full `npx vitest run` (24954 passed): 0.
- `npx next build`: 0.
- eslint: 0.
- 36 static gates: 0.
- `npm run test:integration` on the session and revocation suites (17 files, 218 passed) and the bypass-grant suites (29 passed): 0.
