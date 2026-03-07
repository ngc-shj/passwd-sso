# Plan: audit-metadata-standardize

## Objective

Standardize metadata fields across all `logAudit()` call sites so that every action type includes the fields necessary for audit trail analysis and cross-action consistency.

## Requirements

### Functional

1. **Emergency Access metadata unification (B)**: Add missing `ownerId` / `granteeId` to emergency access actions. Merge with existing metadata — never overwrite.
   - Routes where granteeId is available: add missing field(s) to existing metadata
   - Accept routes: do NOT add `granteeId` (redundant with `userId`)
   - Decline/reject routes: use `declinedBy`/`rejectedBy` (no grantee exists yet)

2. **EMERGENCY_VAULT_ACCESS granteeId (F)**: Add `granteeId` to metadata in `vault/entries/route.ts` (NOT vault/route.ts). targetType/targetId already exist — no change needed.

3. **Recovery Key keyVersion (D)**: Add `keyVersion` to the Prisma select in `vault/recovery-key/generate/route.ts`, then include it in metadata for both RECOVERY_KEY_CREATED and RECOVERY_KEY_REGENERATED.

4. **~~Team ENTRY_DELETE permanent flag (E)~~**: Already implemented at L317. No change needed.

5. **ADMIN_VAULT_RESET_INITIATE resetId (C)**: Capture the return value of `prisma.adminVaultReset.create()` and include `metadata: { resetId: record.id }`. Update test mock to include `id` field.

### Non-functional

- No runtime behavior changes beyond additional metadata fields in audit logs
- No new dependencies
- All existing tests must continue to pass

## Technical Approach

- Direct edits to existing route handlers
- **Merge** metadata fields — add to existing metadata objects, never replace
- Use existing variables already in scope (grant.ownerId, grant.granteeId, user.keyVersion, etc.)
- `withTenantRls<T>` is generic and returns callback value transparently — confirmed

## Implementation Steps

### Step 1: Emergency Access — add missing fields to existing metadata

1. `src/app/api/emergency-access/[id]/confirm/route.ts` — Has `{ granteeId, wrapVersion, keyVersion }`. Add `ownerId: grant.ownerId`
2. `src/app/api/emergency-access/[id]/request/route.ts` — Has `{ ownerId, waitDays }`. Add `granteeId: grant.granteeId`
3. `src/app/api/emergency-access/[id]/revoke/route.ts` — Has `{ granteeId, permanent }`. Add `ownerId: grant.ownerId` to both logAudit calls
4. `src/app/api/emergency-access/[id]/vault/entries/route.ts` — Has `{ ownerId, entryCount }`. Add `granteeId: grant.granteeId`

### Step 2: Emergency Access — PENDING state routes (granteeId is NULL)

5. `src/app/api/emergency-access/[id]/accept/route.ts` — Has `{ ownerId }`. No granteeId needed (userId = grantee). No change.
6. `src/app/api/emergency-access/accept/route.ts` — Same pattern. No change.
7. `src/app/api/emergency-access/[id]/decline/route.ts` — No metadata. Add `metadata: { ownerId: grant.ownerId, declinedBy: session.user.id }`
8. `src/app/api/emergency-access/reject/route.ts` — No metadata. Add `metadata: { ownerId: grant.ownerId, rejectedBy: session.user.id }`

### Step 3: Recovery Key keyVersion (D)

9. `src/app/api/vault/recovery-key/generate/route.ts` — Add `keyVersion: true` to Prisma select (User model has `keyVersion Int @default(0)`). Add `metadata: { keyVersion: user.keyVersion }` to both audit calls.

### Step 4: Admin Vault Reset resetId (C)

10. `src/app/api/tenant/members/[userId]/reset-vault/route.ts` — Capture `const resetRecord = await withTenantRls(...)`. Add `metadata: { resetId: resetRecord.id }` to logAudit call.
11. Update test: add `id: "reset-1"` to `mockPrismaAdminVaultReset.create` return value. Add logAudit metadata assertion.

### Verified — No changes needed

- `approve/route.ts`: Already has `{ ownerId, granteeId, earlyApproval }` (fixed in prior task)
- `vault/route.ts` (auto-activation): Already has `{ ownerId, granteeId, earlyApproval }` (fixed in prior task)
- `[id]/accept/route.ts`, `accept/route.ts`: userId = grantee, no redundant metadata needed
- Team `ENTRY_DELETE`: Already has `{ permanent }` flag

## Testing Strategy

- Run full test suite (`npx vitest run`) to ensure no regressions
- Verify with `tsc --noEmit` for type safety
- Update reset-vault test mock to include `id` field (T-2)
- Emergency access logAudit assertion tests are out of scope (T-1, separate task)

## Considerations & Constraints

- Auth.js `events.signIn` does not provide `req` — ip/userAgent limitation (known from prior work)
- System events intentionally lack ip/userAgent
- `metadata` in `logAudit` is typed as `Record<string, unknown>` — no type changes needed
- `withTenantRls<T>` returns callback value transparently (confirmed)
- `keyVersion` exists in User model at `prisma/schema.prisma` L82
- SCIM PUT vs PATCH metadata difference is legitimate and unchanged
