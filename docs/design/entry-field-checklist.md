# Entry Field & Entry Type Addition Checklist

Due to the E2E encryption architecture, adding a field affects many layers.

---

## Field Storage Patterns

Before adding a field, determine **which storage pattern** to use.
The required changes differ significantly by pattern.

### Pattern 1: DB Column

The server can read the value. Enables filtering, sorting, and policy enforcement.

- Examples: `requireReprompt`, `expiresAt`, `isFavorite`, `isArchived`
- Add a column to the Prisma schema → send as plaintext in the API request body
- Add to `executePersonalEntrySubmit` / `executeTeamEntrySubmit` parameters
- Do not include in the encrypted blob (optionally duplicated in `overviewBlob`)

### Pattern 2: Blob-Only

The server must not know the value (E2E encryption principle). Used client-side only.

- Examples: `travelSafe`, `customFields`, `totp`, `generatorSettings`
- No DB column. Stored inside encrypted blobs (`fullBlob` + `overviewBlob`)
- **Must be added to all blob construction sites across all forms** — largest impact area
- On export: extract from decrypted blob. On import: rebuild into blob

### Pattern 3: Entry-Type Specific

Fields used only by a specific entry type.

- Examples: `cardNumber` (credit card), `privateKey` (SSH key)
- Add only within the relevant type's blob construction switch case
- No changes needed for other types

### Decision Criteria

| Question | Yes → | No → |
|----------|-------|------|
| Does the server use the value for filtering/policy? | DB Column | Blob-Only |
| Is it common to all entry types? | Pattern 1 or 2 | Pattern 3 |
| Is it acceptable for the server to see the plaintext? | DB Column OK | Blob-Only required |

---

## A. Blob-Only Field Addition Checklist

The pattern with the largest impact area. Affects all forms and all entry types.

### 1. Encrypted Blob Construction (Most Critical)

Add to both `fullBlob` and `overviewBlob`.

| # | File | Description |
|---|------|-------------|
| 1 | `src/lib/personal-entry-payload.ts` | `BuildPersonalEntryPayloadInput` + `fullBlob` + `overviewBlob` construction |
| 2 | `src/lib/team-entry-payload.ts` | `BuildTeamEntryPayloadInput` + `fullBlob` + `overviewBlob` construction |

#### Caveat: Personal non-login forms build blobs directly

The personal login form constructs blobs via `buildPersonalEntryPayload()`, but
**the 7 non-login forms build blobs directly with `JSON.stringify` inside `handleSubmit`**.
Modifying the payload function alone is insufficient — each form's `handleSubmit` blob must also be updated.

```
src/components/passwords/personal-secure-note-form.tsx
src/components/passwords/personal-credit-card-form.tsx
src/components/passwords/personal-identity-form.tsx
src/components/passwords/personal-passkey-form.tsx
src/components/passwords/personal-bank-account-form.tsx
src/components/passwords/personal-software-license-form.tsx
src/components/passwords/personal-ssh-key-form.tsx
```

#### Caveat: Team non-login forms go through `base.submitEntry`

Team non-login forms call `base.submitEntry(payloadInput)`.
For common fields, the safest pattern is to auto-inject them inside `submitEntry` in
`use-team-base-form-model.ts` via `{ ...payloadInput, fieldName }`.

### 2. Form State Management

| # | File | Description |
|---|------|-------------|
| 3 | `src/hooks/use-personal-login-form-state.ts` | Personal login: `useState` initialization + setter |
| 4 | `src/hooks/use-team-base-form-model.ts` | Team common: `useState` initialization + setter + `submitEntry` auto-injection |
| 5 | 7 personal non-login forms (listed above) | `useState` initialization + `handleSubmit` blob addition |

### 3. hasChanges Detection (Save Button Activation)

Snapshot comparison is used for change detection. Add the field to both baseline and current snapshots.

| # | File | Description |
|---|------|-------------|
| 6 | `src/hooks/personal-login-form-derived.ts` | `buildPersonalInitialSnapshot` + `buildPersonalCurrentSnapshot` |
| 7 | `src/hooks/team-login-form-derived.ts` | `buildTeamInitialSnapshot` + `buildTeamCurrentSnapshot` |
| 8 | 7 personal non-login forms | `baselineSnapshot` + `currentSnapshot` in `useMemo` |

### 4. Submit Functions

| # | File | Description |
|---|------|-------------|
| 9 | `src/components/passwords/personal-login-submit.ts` | `SubmitPersonalLoginFormArgs` interface + function body |
| 10 | `src/components/team/team-login-submit.ts` | `SubmitTeamLoginArgs` interface + function body |
| 11 | `src/hooks/team-login-form-controller.ts` | Login submit handler builder (not needed if common fields are auto-injected via `base.submitEntry`) |

### 5. Type Definitions

| # | File | Description |
|---|------|-------------|
| 12 | `src/components/passwords/personal-login-form-types.ts` | `PersonalLoginFormInitialData` |
| 13 | `src/components/passwords/personal-password-edit-dialog-types.ts` | `PersonalPasswordEditData` |
| 14 | `src/components/team/team-entry-form-types.ts` | `TeamEntryFormEditData` |

### 6. Edit Dialogs (Data Loading)

| # | File | Description |
|---|------|-------------|
| 15 | `src/components/passwords/personal-password-edit-dialog-loader.tsx` | Extract field from decrypted blob (personal) |
| 16 | `src/components/passwords/personal-password-edit-dialog.tsx` | Pass `initialData` to each form (for all entry types) |
| 17 | `src/components/team/team-edit-dialog-loader.tsx` | Extract field from decrypted blob (team) |

### 7. Form Section Props

| # | File | Description |
|---|------|-------------|
| 18 | `src/hooks/personal-form-sections-props.ts` | Add field to `values` + `setters` |
| 19 | `src/hooks/team-form-sections-props.ts` | Same as above |
| 20 | `src/hooks/personal-login-form-presenter.ts` | UI props construction |
| 21 | `src/hooks/team-login-form-presenter.ts` | Same as above |

### 8. Translations

| # | File | Description |
|---|------|-------------|
| 22 | `src/hooks/entry-form-translations.ts` | Translation function definitions |
| 23 | `src/hooks/use-entry-form-translations.ts` | `useTranslations` wrapper |
| 24 | `src/lib/translation-types.ts` | Translation type definitions |
| 25 | `messages/en/*.json`, `messages/ja/*.json` | Add i18n keys |

### 9. Export / Import

| # | File | Description |
|---|------|-------------|
| 26 | `src/lib/export-format-common.ts` | `ExportEntry` interface + `basePasswdSsoMeta` + `passwdSsoCsvPayload` |
| 27 | `src/components/passwords/password-export.tsx` | Extract field from decrypted blob |
| 28 | `src/components/team/team-export.tsx` | Same as above (team) |
| 29 | `src/components/passwords/password-import-types.ts` | `ParsedEntry` interface |
| 30 | `src/components/passwords/password-import-parsers.ts` | Default values during parsing |
| 31 | `src/components/passwords/password-import-payload.ts` | Add field during blob construction |

### 10. UI Components (As Needed)

| # | File | Description |
|---|------|-------------|
| 32 | `src/components/passwords/entry-*-section.tsx` | New shared UI component |
| 33 | `src/components/passwords/password-detail-inline.tsx` | Add field to detail view |
| 34 | `src/components/passwords/entry-history-keys.ts` | History display keys (if applicable) |

### 11. Tests

| # | File | Description |
|---|------|-------------|
| 35 | `src/hooks/personal-login-form-derived.test.ts` | Snapshot tests |
| 36 | `src/hooks/team-login-form-derived.test.ts` | Same as above |
| 37 | `src/hooks/personal-form-sections-props.test.ts` | Props construction tests |
| 38 | `src/hooks/team-form-sections-props.test.ts` | Same as above |
| 39 | `src/hooks/team-login-form-presenter.test.ts` | Presenter tests |
| 40 | `src/hooks/use-team-login-form-model.test.ts` | Model tests |
| 41 | `src/hooks/entry-form-translations.test.ts` | Translation key tests |
| 42 | `src/components/team/team-login-submit.test.ts` | Submit tests |
| 43 | `src/components/passwords/personal-login-submit.test.ts` | Submit tests |
| 44 | `src/components/passwords/password-import-*.test.ts` | Import tests |
| 45 | `src/lib/personal-entry-payload.test.ts` | Payload tests |

### Backward Compatibility with Existing Data

Fields added to encrypted blobs will not exist in previously saved entries.
Always provide a default value when reading.

```typescript
// Example: default when fieldName is absent in existing entries
const fieldValue = parsed.fieldName ?? defaultValue;
```

---

## B. DB Column Field Addition Checklist

Fields the server can read. Fewer changes required than blob-only fields.

### 1. Schema & Migration

| # | File | Description |
|---|------|-------------|
| 1 | `prisma/schema.prisma` | Add column to `PasswordEntry` / `TeamEntry` |
| 2 | Migration SQL | `ALTER TABLE` + update RLS policies (if needed) |

### 2. API Transmission

| # | File | Description |
|---|------|-------------|
| 3 | `src/components/passwords/personal-entry-submit.ts` | `ExecutePersonalEntrySubmitArgs` + API body |
| 4 | `src/components/team/team-entry-submit.ts` | `ExecuteTeamEntrySubmitArgs` + API body |
| 5 | `src/app/api/passwords/route.ts` / `[id]/route.ts` | Server-side handler DB writes |
| 6 | `src/app/api/teams/[teamId]/passwords/route.ts` etc. | Team-side handlers |

### 3. Form State, hasChanges & Type Definitions

Same as Section A items 2–5, but blob construction is not needed.

### 4. Export / Import

| # | File | Description |
|---|------|-------------|
| 7 | `src/lib/export-format-common.ts` | `ExportEntry` + export functions |
| 8 | `src/components/passwords/password-export.tsx` | Extract from API response (`raw.fieldName`) |
| 9 | `src/components/passwords/password-import-payload.ts` | Add field to API body |

---

## C. New Entry Type Addition Checklist

In addition to all items from Section A or B, the following are required.

### 1. Schema & Constants

| # | File | Description |
|---|------|-------------|
| 1 | `prisma/schema.prisma` | Add to `EntryType` enum |
| 2 | `src/lib/constants/entry-type.ts` | Add to `ENTRY_TYPE` + `ENTRY_TYPE_VALUES` |

### 2. New Form Creation

| # | File | Description |
|---|------|-------------|
| 3 | `src/components/passwords/personal-*-form.tsx` | New personal form |
| 4 | `src/components/team/team-*-form.tsx` | New team form |
| 5 | `src/components/entry-fields/*-fields.tsx` | New display component |

### 3. Dashboard & Sidebar

| # | File | Description |
|---|------|-------------|
| 6 | `src/components/passwords/password-dashboard.tsx` | Category filter + dropdown |
| 7 | `src/components/layout/sidebar-sections.tsx` | Sidebar category addition |
| 8 | `src/components/passwords/password-card.tsx` | Card display logic |
| 9 | `src/components/passwords/password-detail-inline.tsx` | Detail view section |

### 4. Dialog Integration

| # | File | Description |
|---|------|-------------|
| 10 | `src/components/passwords/personal-password-new-dialog.tsx` | New entry dialog |
| 11 | `src/components/passwords/personal-password-edit-dialog.tsx` | Edit entry dialog |
| 12 | `src/components/team/team-new-dialog.tsx` | Team new entry dialog |

### 5. Payload Construction

| # | File | Description |
|---|------|-------------|
| 13 | `src/lib/team-entry-payload.ts` | Add new `case` to `switch` (fullBlob + overviewData) |
| 14 | `src/components/team/team-entry-kind.ts` | Entry kind mapping |

### 6. Export / Import

| # | File | Description |
|---|------|-------------|
| 15 | `src/lib/export-format-common.ts` | Add new type branch to JSON/CSV export |
| 16 | `src/components/passwords/password-import-parsers.ts` | Import parser |
| 17 | `src/components/passwords/password-import-payload.ts` | Blob builder |

### 7. Translations / i18n

| # | File | Description |
|---|------|-------------|
| 18 | `messages/en/Dashboard.json` | Category names (`catXxx`, `newXxx`) |
| 19 | `messages/ja/Dashboard.json` | Same as above |
| 20 | `messages/en/[TypeForm].json` | Form labels (new file) |
| 21 | `messages/ja/[TypeForm].json` | Same as above |

### 8. History Keys

| # | File | Description |
|---|------|-------------|
| 22 | `src/components/passwords/entry-history-keys.ts` | `DISPLAY_KEYS`, `SENSITIVE_KEYS` |

---

## Common Pitfalls

### 1. Direct Blob Construction in Non-Login Forms

The 7 personal non-login forms do not use `buildPersonalEntryPayload()`.
They build blobs directly with `JSON.stringify({ ... })` inside `handleSubmit`.
Modifying the payload function alone will not propagate changes to these forms.

### 2. Missing Field Passthrough in Team `submitEntry`

Team non-login forms call `base.submitEntry(payloadInput)`, but common fields
may not be included in `payloadInput`.
Auto-inject common fields inside `submitEntry` in `use-team-base-form-model.ts` for safety.

### 3. Missing Field in hasChanges Snapshots

Login forms use snapshot functions in `*-derived.ts`.
Non-login forms use `useMemo` in their own files.
Updating only one side will break save button activation.

### 4. Missing initialData Passthrough in Edit Dialogs

Personal and team edit dialogs have **separate loaders** that extract fields from decrypted blobs:

- Personal: `personal-password-edit-dialog-loader.tsx` → `personal-password-edit-dialog.tsx`
- Team: `team-edit-dialog-loader.tsx`

Both loaders must extract the field. Updating only one side means the other vault type
silently reverts to the default value on re-edit.

### 5. Export/Import Round-Trip Data Loss

Even if export correctly extracts a field from the blob,
the import side's `ParsedEntry` and blob builder must also handle it —
otherwise data is lost during round-trip.

### 6. Confusing DB Column with Blob-Only

`requireReprompt` is a DB column → does not need to be in the blob.
`travelSafe` is blob-only → must be added to all blob construction sites.
Mixing up the pattern leads to either unnecessary additions or critical omissions.

---

## Existing Field Pattern Classification

| Field | Pattern | Storage | Notes |
|-------|---------|---------|-------|
| `requireReprompt` | DB Column | `PasswordEntry.requireReprompt` | Used by server for policy enforcement |
| `expiresAt` | DB Column | `PasswordEntry.expiresAt` | Used by server for filtering |
| `isFavorite` | DB Column | `PasswordEntry.isFavorite` | Used by server for sorting |
| `isArchived` | DB Column | `PasswordEntry.isArchived` | Used by server for filtering |
| `travelSafe` | Blob-Only | `fullBlob` + `overviewBlob` | Server must not know |
| `customFields` | Blob-Only | `fullBlob` only | Login type specific |
| `totp` | Blob-Only | `fullBlob` only | Login type specific |
| `generatorSettings` | Blob-Only | `fullBlob` only | Login type specific |
| `passwordHistory` | Blob-Only | `fullBlob` only | Login type specific |
| `cardNumber` etc. | Type-Specific | `fullBlob` + `overviewBlob` (partial) | Credit card only |

---

## Verification Steps

1. `npx tsc --noEmit` — no type errors
2. `npx vitest run` — all tests pass
3. Manual testing:
   - Create new entry → field value is saved
   - Edit entry → field value is restored
   - Change field → save button becomes active
   - No field change → save button stays disabled
   - Export → field value is included in output
   - Import → field value is restored
   - Existing entry (without field) → works correctly with default value
