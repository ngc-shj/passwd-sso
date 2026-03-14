# Coding Deviation Log: p1-batch-structural
Created: 2026-03-14

## Deviations from Plan

### DEV-01: Item 11 — `EntrySaveScope` discriminated union not implemented

- **Plan description**: Use a discriminated union type `EntrySaveScope` as the mechanism to unify personal and team save paths:
  ```typescript
  type EntrySaveScope =
    | { scope: "personal"; userId: string }
    | { scope: "team"; teamId: string; teamKeyVersion: number; itemKeyVersion: number; encryptedItemKey?: { ciphertext: string; iv: string; authTag: string } };
  ```
- **Actual implementation**: A general-purpose `BuildEncryptedBodyParams` interface with `extra: Record<string, unknown>` and `optionals?: Record<string, unknown>` bags was used instead. No discriminated union. The shared helper (`buildEncryptedEntryBody`) is scope-agnostic; callers (`savePersonalEntry`, `saveTeamEntry`) pass scope-specific fields via `extra`/`optionals`.
- **Reason**: The discriminated union approach would have required the helper to conditionally branch on `scope`, leaking scope-specific AAD construction logic into the core module. The actual approach keeps AAD construction in each caller and passes the resulting `Uint8Array` into the core as plain parameters, which is simpler and avoids a conditional branch inside the shared helper.
- **Impact scope**: Internal implementation only. Public APIs (`savePersonalEntry`, `saveTeamEntry`) are unchanged. No behavioral difference. Test coverage maintained.

---

### DEV-02: Item 11 — Shared helper placed in `entry-save-core.ts`, not `entry-save.ts`

- **Plan description**: Step 3.1 specified "Create shared helper in `src/lib/entry-save.ts`".
- **Actual implementation**: Helper was placed in `src/lib/entry-save-core.ts`. The file also exports a second function `submitEntry()` (the fetch wrapper) alongside `buildEncryptedEntryBody`.
- **Reason**: The `entry-save.ts` name was avoided to prevent confusion with the existing `personal-entry-save.ts` / `team-entry-save.ts` files. The `-core` suffix signals that this is an internal building block, not a public save API. Adding `submitEntry` to the same file keeps the shared fetch logic co-located.
- **Impact scope**: File name only. Import paths in `personal-entry-save.ts` and `team-entry-save.ts` reflect the actual name.

---

### DEV-03: Item 7 — `VaultEntryFull` and `InlineDetailData` not updated to extend `FullEntryData`

- **Plan description**: Steps 7.4 and 7.5 specified updating `InlineDetailData` and `VaultEntryFull` to extend or use `Pick<FullEntryData, ...>`.
- **Actual implementation**: `VaultEntryFull` (in `password-card.tsx`) and `InlineDetailData` (in `password-detail-inline.tsx`) remain as standalone interfaces. `FullEntryData` was created in `src/types/entry.ts` as a canonical reference type but neither existing interface was refactored to derive from it. Only the field rename (`passphrase` → `sshPassphrase`, `comment` → `sshComment`) was applied to `VaultEntryFull`.
- **Reason**: The rename was the high-priority functional fix. The structural extension (`extends FullEntryData`) is a cosmetic/consistency improvement with higher refactoring risk (both interfaces have fields with different optionality and nullability than `FullEntryData`). Deferring the structural extension avoids accidental type narrowing regressions in a large component (`password-detail-inline.tsx`, ~1258 lines).
- **Impact scope**: `FullEntryData` exists as a canonical reference and can be used for future derivations. No runtime impact. The rename is applied and correct.

---

### DEV-04: Item 12 — `POST /api/extension/token` also updated to 201

- **Plan description**: Item 12 audit listed three target endpoints: `POST /api/sends`, `POST /api/share-links`, `POST /api/emergency-access`. `POST /api/extension/token` was not mentioned.
- **Actual implementation**: `POST /api/extension/token` was also changed from 200 to 201, with its test updated accordingly.
- **Reason**: During the audit sweep, `POST /api/extension/token` was found to create a persistent `ApiKey` record (DB insert), satisfying the plan's acceptance criterion ("Every POST route handler that creates a persistent resource must return 201"). This is a correct application of the Item 12 rule to an endpoint not explicitly listed in the plan's examples.
- **Impact scope**: One additional endpoint returned 201 instead of 200. Frontend uses `response.ok` (2xx check), so this is safe. Test updated to match.

---

### DEV-05: Item 10 — `encryptedFieldSchema` placed in `common.ts`, not in `entry.ts`

- **Plan description**: The plan assigned `entry.ts` to hold "password/entry schemas + constants". `encryptedFieldSchema` is used by both entry and team schemas.
- **Actual implementation**: `encryptedFieldSchema` was placed in `common.ts` alongside other shared constants. It is imported by both `entry.ts` and `team.ts`.
- **Reason**: `encryptedFieldSchema` is used across multiple domain files (`entry.ts`, `team.ts`, `share.ts`). Placing it in `entry.ts` would create a cross-domain import from `team.ts` → `entry.ts`, violating the domain separation goal of the split. `common.ts` is the correct home for shared primitives.
- **Impact scope**: No behavioral change. The schema definition is identical. All consumers import transitively from `@/lib/validations` via `index.ts`.
