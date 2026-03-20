# Plan: Unify Entry ID Format to UUID v4

## Objective

Eliminate the CUID v1 / UUID v4 ID format inconsistency in models where clients generate IDs before encryption (AAD binding). Change Prisma defaults from `@default(cuid())` to `@default(uuid(4))` for affected models, harden validation schemas for AAD-bound IDs, and verify that no Zod validations incorrectly reject UUID v4 IDs.

## Background

- Clients use `crypto.randomUUID()` (UUID v4) for IDs that must be known before encryption (AAD binding)
- Prisma schema uses `@default(cuid())` for all models, creating a mismatch
- CUID v1 is deprecated by its author due to host information leakage
- Existing CUID entries (aadVersion=0) cannot be converted without re-encryption
- The rotate-key endpoint already uses `.min(1)` as a workaround

## Requirements

### Functional
- All new records for affected models use UUID v4 as their ID
- Existing CUID v1 records remain valid and accessible
- All Zod validations accept both UUID v4 and CUID v1 formats for affected ID fields
- TeamPasswordEntry only accepts `aadVersion >= 1` for new creation (existing design constraint — aadVersion=0 entries are read-only legacy data)
- No data migration or re-encryption required
- All existing tests continue to pass

### Non-functional
- Zero downtime — PostgreSQL `ALTER COLUMN ... SET DEFAULT` does not acquire an exclusive table lock; it only modifies the catalog metadata
- No client-side code changes required (already generates UUID v4)
- Backward compatible with existing API consumers

## Scope

### In scope — 4 models (client-generated IDs, AAD-bound)
| Model | Client UUID generation | AAD scope |
|---|---|---|
| `PasswordEntry` | `personal-entry-save.ts`, `password-import-importer.ts` | PV (userId, entryId) |
| `TeamPasswordEntry` | `team-entry-submit.ts`, `team-password-service.ts` | OV (teamId, entryId) |
| `Team` | `team-create-dialog.tsx` | OV, IK (teamId) |
| `Attachment` | `attachment-section.tsx`, `team-attachment-section.tsx` | AT (entryId, attachmentId) |

### Out of scope — 35 models (server-only CUID, no mismatch)
All other models (User, Tenant, Session, Tag, Folder, etc.) remain `@default(cuid())`. Their IDs are generated server-side by Prisma and have no CUID/UUID inconsistency.

## Technical Approach

### Strategy: "New UUID, old CUID accepted"

1. **Prisma schema**: Change `@default(cuid())` → `@default(uuid(4))` for 4 models
2. **Validation hardening**: Make `createTeamE2ESchema.id` required; normalize attachment UUID casing
3. **Validation audit**: Verify all `.cuid()` validations only reference CUID-remaining models
4. **No data migration**: Existing CUID records stay as-is; new records get UUID v4
5. **No client changes**: Client already generates UUID v4

### Validation approach — no new helper needed

Audit result: All existing `.cuid()` validations reference models that remain CUID (Tag, Folder, User). The 4 migrated models' IDs are already validated with either `.uuid()` (entry creation schemas) or `.min(1)` (rotate-key, bulk operations). No validation changes are required for format acceptance.

## Implementation Steps

### Step 1: Update Prisma schema defaults

**File:** `prisma/schema.prisma`

Change `@default(cuid())` → `@default(uuid(4))` for:
- `PasswordEntry.id`
- `TeamPasswordEntry.id`
- `Team.id`
- `Attachment.id`

### Step 2: Generate Prisma migration

```bash
npm run db:migrate -- --name change-id-defaults-to-uuid
```

This migration only changes DEFAULT values — no data transformation, no column type change. The generated SQL should be `ALTER TABLE ... ALTER COLUMN ... SET DEFAULT gen_random_uuid()` (or equivalent) for each table.

**Checklist**: After generation, inspect the SQL file to confirm it contains ONLY `SET DEFAULT` statements — no `ALTER COLUMN ... TYPE`, no `DROP`, no data manipulation.

### Step 3: Make AAD-bound `id` fields required in team schemas

**File:** `src/lib/validations/team.ts`

1. Change `id: z.string().uuid().optional()` → `id: z.string().uuid()` in `createTeamE2ESchema` (line 55)
2. Change `id: z.string().uuid().optional()` → `id: z.string().uuid()` in `createTeamE2EPasswordSchema` (line 61)

**Rationale**: Both schemas have AAD-bound IDs. Client code always generates UUID v4 before encryption (`team-create-dialog.tsx` for teams, `team-entry-submit.ts` for entries). If `id` is omitted, the server generates a different ID, causing permanent AAD mismatch and decryption failure. This follows the same pattern as `createE2EPasswordSchema`'s refine for `aadVersion >= 1`.

### Step 4: Normalize attachment UUID casing

**Files:**
- `src/app/api/passwords/[id]/attachments/route.ts`
- `src/app/api/teams/[teamId]/passwords/[id]/attachments/route.ts`

Add `.toLowerCase()` to the `clientId` acceptance path:

For `passwords/[id]/attachments/route.ts`:
```typescript
const attachmentId = (clientId && UUID_RE.test(clientId))
  ? clientId.toLowerCase()   // normalize to match crypto.randomUUID() output
  : crypto.randomUUID();
```

For `teams/[teamId]/passwords/[id]/attachments/route.ts`: simplify the redundant dual-regex check (pre-validation with strict UUID v4 regex + loose `UUID_RE`) into a single path. Since `clientId` is already validated by the strict v4 regex at line 209, the loose regex at line 214 is redundant:
```typescript
const attachmentId = clientId
  ? clientId.toLowerCase()   // already validated as UUID v4 above
  : crypto.randomUUID();
```

**Rationale**: `crypto.randomUUID()` returns lowercase. If a client sends uppercase UUID, it gets embedded in AAD as-is. Future re-encryption with lowercase UUID causes AAD mismatch (authTag verification failure). The team route's dual regex is a maintenance hazard — one inconsistent change could silently cause AAD mismatch.

### Step 5: Audit Zod validations — confirm no further changes needed

Verify each `.cuid()` in the codebase references a CUID-remaining model:

**`entry.ts`** — Tag/Folder references (correct):
- `tagIds: z.array(z.string().cuid())` — Tag is CUID ✓
- `folderId: z.string().cuid()` — Folder is CUID ✓

**`team.ts`** — TeamTag/TeamFolder/User references (correct):
- `tagIds: z.array(z.string().cuid())` — TeamTag is CUID ✓
- `teamFolderId: z.string().cuid()` — TeamFolder is CUID ✓
- `parentId: z.string().cuid()` — TeamTag self-ref, CUID ✓
- `userId: z.string().cuid()` — User is CUID ✓

**`tag.ts`** — `parentId: z.string().cuid()` — Tag self-ref, CUID ✓
**`folder.ts`** — `parentId: z.string().cuid()` — Folder self-ref, CUID ✓
**`breakglass.ts`** — `targetUserId: z.string().cuid()` — User is CUID ✓

**Already using `.uuid()` or `.min(1)`** (correct):
- `entry.ts` / `team.ts` — `id: z.string().uuid()` for entry creation ✓
- `vault/rotate-key/route.ts` — `id: z.string().min(1)` ✓
- `teams/[teamId]/rotate-key/route.ts` — `id: z.string().min(1)` ✓
- `common.ts` — `bulkIdsSchema` / `bulkArchiveSchema` — `.min(1)` ✓
- `share.ts` — `passwordEntryId: z.string().min(1)` ✓

### Step 6: Comprehensive grep for missed `.cuid()` on migrated models

Search all `.cuid()` usages across source files. For each, verify it references a CUID-remaining model (Tag, Folder, User, TeamTag, TeamFolder). Flag any that reference PasswordEntry, TeamPasswordEntry, Team, or Attachment IDs.

Additionally, verify that `attachment-section.tsx` and `team-attachment-section.tsx` always send `clientId` to the server in all code paths (new upload, drag-and-drop, etc.).

### Step 7: Update test fixtures for dual format coverage

Review test files for the 4 migrated models. Specific updates needed:

1. **`vault/rotate-key/route.test.ts`**: Add UUID v4 format test case alongside existing CUID fixture (`"tz4a98xxat96iws9zmbrgj3a"`)
2. **`teams/[teamId]/rotate-key/route.test.ts`**: Add UUID v4 format test case
3. **`bulk-trash/archive/restore` tests**: Replace at least one `"p1"`/`"p2"` fixture with UUID v4 format
4. **`team-password-service.test.ts`**: Add UUID v4 variant for `TEAM_ID` and `PASSWORD_ID`
5. **`validations.test.ts`**: Update `createTeamE2ESchema` and `createTeamE2EPasswordSchema` test blocks — add UUID v4 `id` to `valid` objects, add test case verifying rejection when `id` is omitted

Ensure both UUID v4 and CUID v1 formats are tested to validate backward compatibility.

### Step 8: Run verification

```bash
npx vitest run
npx next build
```

## Testing Strategy

1. **Existing test suite**: All tests must pass — validates no regressions from schema default change
2. **Build verification**: `npx next build` must succeed — catches SSR/bundling issues
3. **Migration safety**: Inspect the generated Prisma migration SQL to confirm it is default-only (checklist in Step 2)
4. **Dual format coverage**: Specific test files updated in Step 7 to cover both UUID v4 and CUID v1 IDs
5. **Validation hardening**: `createTeamE2ESchema` now requires `id` — existing tests that omit `id` must be updated

## Considerations & Constraints

### AAD binding makes ID conversion impossible for existing data
- `aadVersion >= 1` entries have their ID baked into AAD ciphertext
- Changing the ID would make existing ciphertext undecryptable
- This is why we accept both formats rather than migrating existing data

### Prisma `@default(uuid(4))` behavior
- Prisma 7 generates UUID v4 server-side as fallback when client doesn't provide an ID
- Verified: `Ln.generate(4)` calls `Mn()` which produces standard UUID v4
- This default is rarely used since clients always provide IDs for these 4 models

### CUID v1 deprecation
- CUID v1 author recommends migration to CUID2 or other alternatives
- CUID v1 leaks host information (PID, hostname) — inappropriate for a security application
- After this change, no new CUID v1 values will be generated for these 4 models

### FK integrity
- Tag/Folder IDs referenced by PasswordEntry remain CUID — their `.cuid()` validations are correct
- PasswordEntry/Team/Attachment IDs referenced by other tables (PasswordEntryHistory, ShareAccessLog, etc.) use FK constraints — the DB enforces integrity regardless of ID format

### PostgreSQL lock behavior
- `ALTER COLUMN ... SET DEFAULT` modifies only `pg_attrdef` catalog — no table rewrite, no exclusive lock
- Safe to run without maintenance window

### Risk: Missed `.cuid()` validation
- If any API endpoint validates a migrated model's ID with `.cuid()`, UUID v4 IDs will be rejected (400 error)
- Step 6 mitigates this with a comprehensive grep
- Post-deploy: monitor for 400 response spikes on endpoints involving these 4 models
