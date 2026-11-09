# Coding Deviation Log: bootstrap-user-reactivation-into-claimed-tenant

## D1 — C2 seeded credentials come from `seedBootstrapMember`

The cell asserts the bootstrap tenant's session (exactly one, from `seedOwnedRows`) and its
extension token (`validateSeededExtensionToken` → `EXTENSION_TOKEN_DPOP_INVALID`, i.e. live) survive
the SCIM DELETE, instead of seeding a separate API key. Same observable: the route's revocation
stayed in the target.

## D2 — The C2 sign-in assertion checks memberships and the column, not every moved table

Step 6 asserts the active membership is the target's only one and `User.tenantId` names the target.
The per-table move is already pinned by the row-6 migration cells, which run the same migration
body; repeating `movedTo` here would re-test that body, not the remedy.

## Red-proof (RT7)

Scratch worktree at the committed tree (`git worktree add --detach`, `node_modules` symlinked, the
repo's `.env` exported into the shell, not copied); each mutant applied, the cell run with
`npx vitest run --config vitest.integration.config.ts src/__tests__/db-integration/tenant-claim-binding.integration.test.ts -t "deleted with SCIM DELETE"`,
then the worktree reset.

| Mutant | First failing assertion |
|--------|-------------------------|
| M1 engine refusal reduced to `!user` | step 5: the sync result (`toMatchObject({ success: true, usersCreated: 0, usersRefused: 1 })`) |
| M2 `deactivateScimUser` keeps the mapping | step 4: `{ members: 0, mappings: 1 }` vs `{ members: 0, mappings: 0 }` |
| M3 DELETE invalidation widened to `{ allTenants: true }` | step 4: bootstrap session count 0, expected 1 |

Unmodified tree: the cell passes (`npm run test:integration -- tenant-claim-binding tenant-claim-cli`,
246/246).

## C1 forbidden patterns

`rg -n 'sync recreates|recreates it|No producer can reactivate|SCIM, directory sync, its admins'` over
the six member-set files and `rg -n '作り直' README.ja.md`: no matches.

## D3 — Production behaviour change: the bootstrap migration's tenant-only moves (code review S2)

The plan's R4 ("no behaviour change") no longer holds. Code review round 2 found that the migration
moved password history, emergency-access key pairs and share access logs by tenant alone, carrying a
deactivated bootstrap member's rows into the claimed tenant. The user chose to fix it in this PR
(2026-11-09). Each move is now scoped through its parent to the migrating user. Red-proof: on a
scratch worktree at `df8f12b3d` with the three parent filters removed, the cell "row 6, a
deactivated second member in the bootstrap tenant: their rows stay behind" fails at the departed
member's placement, with `passwordEntryHistory`, `emergencyAccessKeyPair` and `shareAccessLog` all
filed under the target.
