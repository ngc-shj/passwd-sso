# Coding Deviation Log: unify-validation-limits
Created: 2026-03-16

## Deviations from Plan

### D1: Prisma schema model name discrepancy
- **Plan description**: `Send.sendName`, `Send.sendFilename` as Prisma model fields
- **Actual implementation**: Prisma model is `PasswordShare`, not `Send`. `prisma-sync.test.ts` uses correct model name `PasswordShare`
- **Reason**: Plan was based on API domain naming ("Send"), but Prisma schema uses `PasswordShare`
- **Impact scope**: `prisma-sync.test.ts` only

### D2: `accessPasswordHash` excluded from crypto hex pattern matching
- **Plan description**: All `*Hash` fields should match `HEX_HASH_LENGTH = 64`
- **Actual implementation**: `PasswordShare.accessPasswordHash` (VarChar(128)) excluded from pattern test
- **Reason**: This field stores HMAC-peppered SHA-256 hash, intentionally VarChar(128), not a standard 32-byte hex hash
- **Impact scope**: `prisma-sync.test.ts`

### D3: `hexHash` case-insensitive change affected existing test
- **Plan description**: Spec enhancement for hex validation (documented as intentional)
- **Actual implementation**: `vault/admin-reset/route.test.ts` test "returns 400 for uppercase hex token" changed to expect 200, since `hexHash` uses `/^[0-9a-f]+$/i`
- **Reason**: `hexString()` helper is case-insensitive by design; uppercase hex is valid
- **Impact scope**: `vault/admin-reset/route.test.ts`

### D4: `tenant/policy/route.test.ts` mock update
- **Plan description**: Not explicitly covered in plan
- **Actual implementation**: Changed `vi.mock("@/lib/validations/common")` from manual partial mock to `importOriginal` pattern to include new `MAX_CIDRS` export
- **Reason**: Old mock only exported `pinLengthSchema`; new `MAX_CIDRS` constant caused runtime error
- **Impact scope**: `tenant/policy/route.test.ts`

### D5: `common.server.ts` pagination constants moved to common.ts
- **Plan description**: `HISTORY_PAGE_SIZE`, `NOTIFICATION_PAGE_*` in `common.server.ts`
- **Actual implementation**: These remain importable from `common.server.ts` as planned
- **Reason**: No deviation
- **Impact scope**: N/A

---
