# Code Review: bootstrap-user-reactivation-into-claimed-tenant
Date: 2026-11-09
Review round: 1

## Changes from Previous Round
Initial review, incremental on the Phase 2 self-R-check (which fixed a README overstatement of the
ownership rule and added the remaining-refusal note to the tenant-context doc and CLI heading).
Seeds unavailable — full-diff review by three experts.

## Functionality Findings
- F1 [Major] After the delete, a bootstrap tenant with another active member does not refuse as
  `tenant_mismatch`: `assertBootstrapSingleMember` throws inside the migration, and the signIn
  callback's catch files `provider_error` with no claim, so the user leaves the `unmapped` report.
  README en/ja, the CLI heading and the `src/auth.ts` comment said "still refused" under the
  `tenant_mismatch` row.
- F2 [Minor] The OWNER case was written as "refused after the delete", but SCIM DELETE answers 403
  `SCIM_OWNER_PROTECTED`: there is no delete. The CLI heading named one exception, the README two.

## Security Findings
- S-1 [Minor] The CLI heading omitted the OWNER case (same as F2).
Verified: the DELETE removes only the target's row, mapping and team state and revokes in the target
only (M3); the move is the user's own authenticated sign-in; the producer member set re-derived from
code; the module-scope mocks touch no other cell; no executable production code changed.

## Testing Findings
No findings. Mock reset paths, outbox query scoping (`maxWorkers: 1`, fresh tenant, exact match),
the guarded `/recreat/i` negative, and the red-proof order were all verified.

## Adjacent Findings
None.

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
Claims in comments/docs checked against the code incl. thrown vs returned refusals (F1);
operator surfaces list the same exceptions (F2); stale-text grep over the whole live tree clean;
integration cell's mocks match the real seams.

### Security expert
Mocks hiding security behaviour: none. Revocation scope: tenant-scoped, pinned by M3.
Refusal metadata: `userId: null` pinned. Producer member set: re-derived, matches. Operator advice
weakening security: none.

### Testing expert
Vacuous negatives: none. Partial-mock trap: none. Mock state leak: none (resets in `finally`).
Shared-table sweeps: none (serial files, fresh tenants). Red-proof order consistent. Baseline green recorded.

## Environment Verification Report
N/A — no environment constraints declared in Phase 1. C2 `verified-local`
(`npm run test:integration -- tenant-claim-binding tenant-claim-cli`); CI pending the PR run.

## Resolution Status

### Round 1
- F1 [Major] — Action: README en/ja state the second-member case fails as `provider_error`
  (logged as `auth.bootstrap.migration_blocked`), leaves `unmapped`, and needs the other member to
  leave the bootstrap tenant first; the `src/auth.ts` comment says the same. Modified: `README.md`,
  `README.ja.md`, `src/auth.ts`.
- F2 / S-1 [Minor] — Action: README en/ja say an OWNER row cannot be removed this way (403
  `SCIM_OWNER_PROTECTED`); the CLI heading points to the README row for both exceptions instead of
  listing one. Modified: `README.md`, `README.ja.md`, `scripts/tenant-domain.ts`.
- Verification: README parity 5/5; `tenant-claim-cli` integration 190/190; lint and typecheck 0.

### Round 2
One reviewer, all three perspectives. Round-1 claims verified (row 6b throws → `provider_error`
with no claim, excluded from `unmapped` by reason and by the claim filter; OWNER → 403). New:
- S2 [Major, security] The advice "the other member must leave the bootstrap tenant first" turned a
  pre-existing defect into an operator procedure: the migration moved `passwordEntryHistory`,
  `emergencyAccessKeyPair` and `shareAccessLog` by tenant alone, and `assertBootstrapSingleMember`
  counts active members only, so a deactivated member's rows went to the claimed tenant.
  Action (user decision: fix in this PR): each of the three is scoped through its parent to the
  migrating user (`entry: { userId }`, `grant: { ownerId: userId }`, `share: { createdById: userId }`),
  matching the parent writes. Real-DB cell "row 6, a deactivated second member in the bootstrap
  tenant: their rows stay behind"; red-proved by restoring the tenant-only filters on a scratch
  worktree (all three tables move to the target). The AST guard
  (`src/auth.bootstrap-migration.test.ts`) now pins the parent filters; `src/auth.test.ts`, the
  `bootstrap-migration-set` helper comments and `docs/security/security-review.md` updated.
  Modified: `src/auth.ts`, tests above, `docs/security/security-review.md`.
- F3 [Minor] `src/lib/tenant-context.ts` still said "still refused after it". Action: reworded to
  point at the two cases named at the `src/auth.ts` refusal.
- F4 [Minor] "the other member must leave" named no supported action. Action: README en/ja say the
  bootstrap tenant's admin deactivates or removes that member first, and that their rows stay there.
- Verification: vitest 21636; lint/tsc 0; integration 1446 (MinIO); `next build` 0.

### Round 3
Security: the parent filters select exactly the rows whose parents move (a key pair of a grant the
user only receives stays with its grant, which the tenant-only move used to split); filters do not
depend on the parent's tenantId; the relation subqueries stay inside `AUTH_TENANT_CLAIM_MEMBERSHIP`'s
grant; no other tenant-only move remains. Functionality/testing: Prisma shapes valid; the AST guard
pins the filters by exact text; the new cell reds per table (whole-map comparison). Findings, all
Minor and comment-only:
- `src/lib/tenant/owning-column.ts` justified leaving data behind by the removed tenant-only move.
- `src/lib/tenant-context.ts` called the OWNER exception a deletion that does not admit the user.
- Two round-2 docblock edits were not rewrapped.

## Tightening-only skip — Round 3
Findings applied directly (no Round 4 review):
- [R3-S F1] [Minor] owning-column rationale restated as history — `src/lib/tenant/owning-column.ts` — applied
- [R3-FT F1] [Minor] the two exceptions named correctly — `src/lib/tenant-context.ts` — applied
- [R3-FT F2] [Minor] docblocks rewrapped — `src/__tests__/helpers/bootstrap-migration-set.ts`,
  `src/__tests__/db-integration/tenant-claim-binding.integration.test.ts` — applied
Justification: every finding is comment wording within Round 2's fix scope; no behaviour or
security-boundary change.

## Final state
Code review rounds: 3. Open findings: none.
