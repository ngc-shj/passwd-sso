# Coding Deviation Log: member-foothold-containment

- **C4 audit calls**: one `logAuditBulkInTx` per action instead of one combined call — `check-critical-audit-atomic` refuses a spread of `.map()` inside the bulk array.
- **C5 initiate / approve pre-reads**: the routes keep their pre-transaction target read and `isTenantRoleAbove` check (early 403/404 before the limiter, the email for the AAD); the same checks are repeated authoritatively on the locked rows inside the transaction.
- **C5 emergency-access control cell**: a committed deactivation of the owner surfaces as `TENANT_NOT_RESOLVED` from `withUserTenantRls` before the gate runs (existing behaviour, unchanged); the discriminating cells for that row are the held deactivation and the deleted session.
- **C5 PUT routes**: the service-account and MCP-client updates moved into a transaction so the gate can run when `isActive === true`.
- **C5 eligibility**: `computeApproveEligibility` gained `INITIATOR_UNAUTHORIZED`, fed by `creatorVerdicts` in the reset-vault GET; the history dialog hides Approve for it.
- **C7 webhook audit**: containment's `TENANT_WEBHOOK_DELETE` rows carry no `targetType`, matching the existing single DELETE route (`AUDIT_TARGET_TYPE` has no webhook entry).
- **C7 `containMemberInTx`** takes the actor's role to decide which kinds `remaining` counts; `containmentScope` copy (en/ja) no longer lists webhooks as uncovered.
- **C10 delivery readers**: no `claim-carry` key was needed (no `webhook_deliveries` read of a webhook table); 3 delivery, 13 management keys.
- **Simplify pass**: shared `footholdWriteErrorResponse` (catch arms of 12 routes), `creatorAuthorizedOf`, `holdsTenantAuthority` (one predicate for the gate, the verdicts and the reset routes); `departFromTenant` kept its original shape.
- **Side-fixes**: `scripts/checks/bearer-passkey-gate-manifest.json` (`containMemberInTx` call count), `rls-grant-evidence-baseline.txt` (`TENANT_WEBHOOK_DISPATCH` now evidenced), `team-key-version-guard.integration.test.ts` (new `deactivateScimUser` argument), `auth.test.ts` / `auth.bootstrap-migration.test.ts` (bootstrap tenant-row lock).

### Environment: 8 integration files fail in this worktree, unrelated to the diff — Pre-existing
- **Anti-Deferral check**: environment, not code. `audit-anchor-publisher-s3`, `audit-anchor-s3-destination`, `retention-gc-blob-orphans`, `team-attachment-rekey`, `team-rekey-pass` need MinIO (`ANCHOR_TEST_S3_ENDPOINT`), which is not running here; `retire-dcr-cleanup-worker`, `revoke-public-connect`, `audit-db-grants` fail on `passwd_dcr_cleanup_worker` holding CONNECT on the worktree database `passwd_sso_wt_1032` (created outside the migration that revokes it). None of these files or the code they exercise is in the diff; CI runs them with MinIO and a migration-created database.
- **Orchestrator sign-off**: 161/169 integration files pass, including every file this diff adds or touches.
