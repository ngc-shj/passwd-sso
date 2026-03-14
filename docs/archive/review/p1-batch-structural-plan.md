# Plan: P1 Batch — Structural Improvements (Items 7, 10, 11, 12)

## Objective

Batch implementation of four P1 refactoring items that share a common theme of type/schema consolidation and API consistency. Items 8 (VaultContext split) and 9 (password-detail-inline decomposition) are deferred to a separate PR due to their high risk and large consumer impact.

## Items

### Item 7: Unify Entry Type Definitions
### Item 10: Split validations.ts by Domain
### Item 11: Merge Personal/Team Entry Save Functions
### Item 12: Audit POST Endpoints for 201 Status Code

---

## Requirements

### Functional
1. **Item 7**: Create `src/types/entry.ts` with canonical `FullEntryData` interface. Rename `VaultEntryFull.passphrase` → `sshPassphrase` and `VaultEntryFull.comment` → `sshComment`. Derive component-specific types via `Pick<>`/`Omit<>`.
2. **Item 10**: Split `src/lib/validations.ts` (541 lines) into `src/lib/validations/` directory with domain-specific files. Re-export from `index.ts` for backward compatibility.
3. **Item 11**: Extract shared mechanics from `personal-entry-save.ts` and `team-entry-save.ts` into a private helper. Keep public APIs with distinct type signatures.
4. **Item 12**: Audit all POST routes creating resources and ensure they return 201. Update any returning 200 for resource creation.

### Non-Functional
1. Zero behavior change for existing routes and components
2. All imports must continue working via existing paths (re-exports)
3. `npx vitest run` and `npx next build` must pass

---

## Technical Approach

### Item 7: Unify Entry Type Definitions

1. Create `src/types/entry.ts` with `FullEntryData` — superset of all fields from `InlineDetailData`, `VaultEntryFull`, and `ExportEntry`
2. Fields unique to specific contexts (e.g., `tags`, `folderPath`, `isFavorite` for export) stay in derived types
3. Rename in `password-card.tsx`: `passphrase` → `sshPassphrase`, `comment` → `sshComment`
4. Update `InlineDetailData` and `VaultEntryFull` to extend or use `Pick<FullEntryData, ...>`
5. `ExportEntry` keeps its own shape (portable format with different TOTP representation) but shares field names

### Item 10: Split validations.ts

Create directory structure:
```
src/lib/validations/
  ├── index.ts          (re-exports everything)
  ├── entry.ts          (password/entry schemas + constants)
  ├── folder.ts
  ├── tag.ts
  ├── team.ts
  ├── send.ts
  ├── share.ts
  ├── api-key.ts
  ├── emergency-access.ts
  └── common.ts         (shared constants like field lengths)
```

All 76 import sites continue to work via `@/lib/validations` because `index.ts` re-exports everything.

### Item 11: Merge Entry Save Functions

Extract `buildEncryptedEntryBody()` as a private helper handling:
- Entry ID generation (create mode)
- `encryptData()` calls for blob and overview
- Common body field construction

Public APIs remain:
- `savePersonalEntry(params)` — calls helper with personal AAD + endpoint
- `saveTeamEntry(params)` — calls helper with team AAD + endpoint + team-specific fields

Use discriminated union for scope:
```typescript
type EntrySaveScope =
  | { scope: "personal"; userId: string }
  | { scope: "team"; teamId: string; teamKeyVersion: number; itemKeyVersion: number; encryptedItemKey?: { ciphertext: string; iv: string; authTag: string } };
```

### Item 12: Audit POST 201

Based on investigation, most POST creation routes already return 201. Audit remaining routes:
- `POST /api/sends` — check if it creates a resource
- `POST /api/share-links` — check if it creates a resource
- `POST /api/emergency-access` — check if it creates a resource
- Other POST routes that create resources

Frontend uses `response.ok` (2xx range), so 200→201 change is safe.

---

## Implementation Steps

1. **Item 10 first** — Split validations.ts (no dependencies on other items, unblocks cleaner imports)
2. **Item 7** — Create shared entry types (depends on understanding field names across codebase)
3. **Item 11** — Merge entry save functions (can use new entry types from Item 7)
4. **Item 12** — Audit POST 201 (independent, mechanical)

### Detailed Steps

#### Step 1: Split validations.ts (Item 10)
1. Create `src/lib/validations/` directory
2. Move constants to `common.ts`
3. Move entry schemas to `entry.ts`
4. Move folder schemas to `folder.ts`
5. Move tag schemas to `tag.ts`
6. Move team schemas to `team.ts`
7. Move send schemas to `send.ts`
8. Move share schemas to `share.ts`
9. Move emergency-access schemas to `emergency-access.ts`
10. Move API key schemas to `api-key.ts`
11. Create `index.ts` with re-exports
12. Delete original `validations.ts`
13. Verify all 76 import sites still work

#### Step 2: Create shared entry types (Item 7)
1. Create `src/types/entry.ts` with `FullEntryData` interface
2. Rename `passphrase` → `sshPassphrase`, `comment` → `sshComment` in `password-card.tsx`
3. Update all render sites in `password-card.tsx` that use `passphrase`/`comment`
4. Update `InlineDetailData` to reference shared types
5. Update `VaultEntryFull` to reference shared types
6. Verify `ExportEntry` field names align (they already use `sshPassphrase`/`sshComment`)

#### Step 3: Merge entry save functions (Item 11)
1. Create shared helper in `src/lib/entry-save.ts`
2. Refactor `personal-entry-save.ts` to use shared helper
3. Refactor `team-entry-save.ts` to use shared helper
4. Verify all call sites still work

#### Step 4: Audit POST 201 (Item 12)
1. Audit all POST routes for resource creation returning 200
2. Update to return 201
3. Verify frontend uses `response.ok` (not `=== 200`)

---

## Testing Strategy

1. **Existing tests must pass** — no new behavior, just reorganization
2. **Build verification** — `npx next build` catches any import resolution issues
3. **Item 10**: No new tests needed (re-export preserves API surface)
4. **Item 7**: Build-time type checking catches field rename issues
5. **Item 11**: Existing save function tests must pass. Add test for shared helper if non-trivial logic extracted.
6. **Item 12**: Update any test assertions that check for `status: 200` on creation endpoints

---

## Considerations & Constraints

- **Item 7 — field rename is client-side only**: `passphrase`/`comment` are property names in client-side TypeScript interfaces used after decryption. They are NOT API payload keys or DB column names. The encrypted blob stores these fields as JSON inside the ciphertext — the server never sees the plaintext field names. The rename only affects: (a) the TypeScript interface definition, (b) render sites in `password-card.tsx` that destructure or access these fields. No API contract or data migration is needed.
- **Item 10**: `validations.ts` is imported by 76 files — `index.ts` re-export is critical for zero-breakage migration. The file contains only Zod schema definitions and constants with no top-level side effects.
- **Item 7**: `ExportEntry` has a different TOTP representation (`totp: string | null` + `totpConfig`) — do NOT force into the same type
- **Item 11**: Do NOT change `aadVersion` behavior — existing `aadVersion: 0` read path must remain
- **Item 12**: Only change status codes for true resource creation POSTs, not action endpoints (like `/api/vault/unlock`). Frontend uses `response.ok` (2xx range check), confirmed by investigation. Update any test assertions that hardcode `status === 200` for creation endpoints. Update OpenAPI spec if v1 creation endpoints change. Load-test files (`vault-unlock.js`, `passwords-generate.js`, `mixed-workload.js`) check `status === 200` for action endpoints only — no update needed.
- **Item 12 — acceptance criterion**: Every POST route handler that creates a persistent resource (DB insert) must return `{ status: 201 }`. POST routes that perform actions (unlock, verify, trigger) retain `{ status: 200 }`.
- **Item 7 — rename exclusion**: `shareDataSchema.passphrase` and `shareDataSchema.comment` in `validations.ts` are API-level field names for share link functionality, NOT the same as the SSH-related `passphrase`/`comment` in `VaultEntryFull`. These must NOT be renamed.
- **Items 8, 9 deferred**: VaultContext split (48 consumers, Medium-High risk) and password-detail-inline decomposition (1258 lines, UI regression risk) are separate PRs
