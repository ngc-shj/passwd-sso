# Coding Deviation Log: scim-team-role-raise-approval

## D1 — Key deletion inlined in both arms, not a shared helper

A shared `deleteTeamMemberKeys` helper was flagged by `check-team-rotation-input-lock.mjs` (its
lock check follows callers one level up in the same file) and merged the two delete sites into one
counted write. Each arm keeps its own `teamMemberKey.deleteMany`, guarded by `rows.length > 0`, so
the gate sees both under `lockGroupWrite` and `EXPECTED.memberWrites` moves 19 → 21 (the hold CAS
and the hold's key delete; the reordered `toBecomePending` delete is the same site moved).

## D2 — No new integration cell 8 (OWNER in a raise)

The plan called it "kept as the existing cell", but the integration file has none. The refusal is
covered by the service unit test ("throws ScimOwnerProtectedError when an existing active member has
OWNER role") and the route test ("returns 403 when patch would modify an owner"), both unchanged.

## D3 — `audit-log-reference.md` rows corrected beyond C2

Besides the two rows C2 names, the `TEAM_MEMBER_SCIM_PENDING_WITHDRAW` / `_REMOVE` metadata (listed
as `userId`; the code emits `scimTokenId`, the user is `targetId`) and the ROLE_UPDATE display column
("roleChange template", which applies only to `TEAM_ROLE_UPDATE`) were wrong in a file this change
edits; corrected.

## Red-proof (RT7)

Scratch worktree at `290360e25` (`git worktree add --detach`, `node_modules` symlinked, `.env`
exported into the shell, not copied), compose workers stopped, each mutant applied to
`src/lib/services/scim-group-service.ts`, then
`npx vitest run --config vitest.integration.config.ts src/__tests__/db-integration/scim-team-admission-approval.integration.test.ts`:

| Mutant | Red cells |
|--------|-----------|
| M1 raise applied in place (all non-equal adds to the role-update arm) | A10 ×2, R1/R2 ×2, R3, R4, R6, R7 (8 of 46) |
| M2 hold deletes keys from the pre-read before its CAS | A7d, R9 (the two race cells) |
| M3 hold keeps the keys | R1/R2 ×2, R7 |

Unmodified tree: 46/46.
