# Code Review: saml-jackson-account-rekey
Date: 2026-11-16
Review round: 1

## Changes from Previous Round
Initial review (incremental on the Phase 2 self-R-check). Local LLM pre-screen and seeds unavailable (Ollama down); all three experts did full-diff review.

## Functionality Findings
- F1 Minor — rekey-accounts never checked that the CURRENT share-master version loads, though re-encryption uses it; the preview could pass and the apply fail after the prompt (`scripts/tenant-domain.ts`, verify pass and post-confirmation warm).
- F2 Minor — plan C1 step 5 (key provider initialised before the transaction) not implemented; a provider misconfiguration surfaced as "rekey-accounts failed (Error)".

## Security Findings
- S1 Major — candidates were selected by active membership only; an account filed under another tenant (`Account.tenantId`) came through that tenant's sign-in, and moving it would let the target's IdP assert an identity it never vouched for (`readRekeySnapshot`).
- S2 Minor — the worker's warm call let a `getKeyProvider()` initialisation error (naming configuration) reach the tenant-readable delivery `lastError`.
- S3 Minor — rekey audit rows carry only the self-asserted `--by`, no DB session user.
- S4 Minor — webhook-secret migration "ignores the warm report".

## Testing Findings
- M1 Major — planned unit cells for `rekey-accounts` flags/`--to`/stray flags and the CLI dispatch arm were missing.
- m1 Minor — NF3 negative assertions lacked a positive control.
- m2 Minor — no dedicated CAS cell for the `tenantId` / `providerAccountId` predicates.
- m3 Minor — RDS-shaped bind-attestation refusal asserted without its reason.
- m4 Minor — cloud-key warm test assumed the current version differs from the row version without a guard.
- m5 Minor — decorative `toBeTruthy`, unpinned negative control, tenant created before `try/finally` in `engineBoundClaim`.

## Adjacent Findings
- Security [Adjacent]: dual-membership/foreign-account integration cell — folded into S1's fix.

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
R1–R11 OK; R12 OK (registration set matches `USER_TENANT_REALIGNED`); R13–R41 OK; R42 OK (cold-key class, 4 members, D6); R43–R52 OK; R53–R54 F1; R55–R57 F2.

### Security expert
R1–R30 OK; R31 FAIL → S1 (candidate set scoped by membership, not account ownership); R32–R57 OK; RS1–RS6 OK. Minor notes S2–S4.

### Testing expert
R12 OK; R42 OK; R44/R50 OK; R57 OK; RT1 m5; RT2 OK; RT3 OK; RT4 m3; RT5 OK; RT6 OK; RT7 m2 (D5 noted); RT8 OK; RT9 m1; RT10 OK; RT11 M1.

## Environment Verification Report
- VE1 (real IdP sign-in after the move): `blocked-deferred` — Phase 1 constraint VE1; row-level properties (`(to, providerAccountId)` key, new-AAD decrypt, claim bindings) are `verified-local` by `src/__tests__/db-integration/tenant-account-rekey.integration.test.ts` (`npx vitest run --config vitest.integration.config.ts …`, exit 0).
- VE2 (cloud KMS): `verified-local` — `src/lib/crypto/share-master-keys.test.ts` and `src/__tests__/db-integration/cloud-key-provider-warm.integration.test.ts` drive the production key-provider module under `KEY_PROVIDER=aws-sm` with a stateful fake.

## Resolution Status
### S1 Major — candidates by account ownership
- Action: `readRekeySnapshot` splits active members' legacy accounts by `Account.tenantId`; accounts filed under another tenant are listed as "not moved" and never moved (not a refusal: no command re-files `Account.tenantId`); the step-9 re-read compares that set. README / README.ja state it. Deviation D7.
- Modified file: scripts/tenant-domain.ts (`readRekeySnapshot`, `rekeySnapshotKey`, the listing in `cmdRekeyAccounts`); tests: S1 describe and race (b2) in tenant-account-rekey.integration.test.ts, red-proven.
### S2 Minor — provider init error text in the worker
- Action: `warmShareMasterKeys` catches a provider initialisation / current-version failure and reports every given version unavailable.
- Modified file: src/lib/crypto/share-master-keys.ts; unit cells for an unknown provider and an invalid current version, red-proven.
### F1 Minor — current key version
- Action: the verify pass refuses when any candidate holds a token and the current version is unavailable; the apply pass includes the current version in its post-confirmation check.
- Modified file: scripts/tenant-domain.ts; F1 refused/allowed cells, red-proven.
### F2 Minor — provider init before the transaction
- Action: `cmdRekeyAccounts` initialises the key provider and reads the current version before building a client; a failure returns a fixed message naming the settings, class name only.
- Modified file: scripts/tenant-domain.ts; F2 cell (no client built, no provider name echoed), red-proven.
### S3 Minor — DB session user in the audit row — Skipped
- **Anti-Deferral check**: acceptable risk.
- **Justification**: Worst case — a tenant admin reading the audit row sees the operator's self-asserted label, not the database role that ran the command. Likelihood — every run; the gap is attribution depth, not a missing record. Cost to fix — a raw `session_user` read registered with the raw-SQL gate plus a new metadata key, for a fact the database's own connection log already records. The sibling operator move `realign` records the same shape (SYSTEM actor + `by`), so adding it here alone would make the two operator moves disagree.
- **Orchestrator sign-off**: acceptable-risk exception satisfied with the three values above.
### S4 Minor — webhook migration and the warm report — Rejected
- The script already exits 1 when any row is skipped (`main()`: "Some rows could not be migrated"), and an unloadable version skips its rows; the finding's premise ("exits successfully") does not hold.
### M1 Major, m1–m5 Minor — test cells
- Action: rekey-accounts flag/stray/`--to` cells and two process-level dispatch cells; NF3 positive control; `providerAccountId` CAS race (b3) and `tenant_id` race (b2, caught by the re-read since S1); RDS-shaped refusal reason asserted; current-version guard in the cloud-key test; decorative assertion dropped; negative control pinned to the cache-miss message; `engineBoundClaim` cleanup.
- Modified files: scripts/__tests__/tenant-domain-flags.test.ts, scripts/__tests__/tenant-domain-cli-dispatch.test.ts, src/__tests__/db-integration/{tenant-account-rekey,operator-scripts-rds-shaped,cloud-key-provider-warm,tenant-claim-cli-binding}.integration.test.ts, src/lib/crypto/share-master-keys.test.ts.

### Verification (round 1)
- `npx tsc --noEmit` 0; eslint on touched files 0; unit (972) 0; integration on the touched files (309) 0.
- `scripts/pre-pr.sh` via `check-pre-pr.sh run`: 94 passed, 1 failed — `Test`, only `scripts/__tests__/backup-db.test.mjs` Group B (6 cells: no `pg_restore` reachable from a git worktree's compose project; environmental, unchanged by this branch).
- Full `npm run test:integration` (before round 1): failures only in environment-bound files — S3/MinIO not running (`audit-anchor-*`, `team-rekey-pass`, `team-attachment-rekey`, `retention-gc-blob-orphans`) and this worktree database's cluster-role state (`retire-dcr-cleanup-worker`, `revoke-public-connect`, `audit-db-grants`, `bootstrap-rds-roles`: the retired `passwd_dcr_cleanup_worker` holds CONNECT on `passwd_sso_wt_954`). None touches this diff.
