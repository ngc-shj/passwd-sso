# Code Review: unify-entry-id-to-uuid
Date: 2026-03-21
Review rounds: 2 (initial review from commits 1-3, then full branch review after commits 4-5)

## Round 1 (Commits 1-3: 4-model UUID defaults)

### CF1 (Major → Resolved): teams/route.ts optional guard remnant
- **File**: `src/app/api/teams/route.ts:127`
- **Action**: `...(clientId ? { id: clientId } : {})` → `id: clientId`

### CF2 (Minor → Resolved): UUID_RE not v4-specific
- **File**: `src/app/api/passwords/[id]/attachments/route.ts:174`
- **Action**: Changed to UUID v4 regex

### CT1-CT3 (Major/Minor → Resolved): Test assertion gaps
- Added `updateMany` where clause assertions to bulk and rotate-key tests
- Added `response.id` assertion to attachment tests

## Round 2 (Commits 4-5: Full UUID unification + native uuid type)

### Changes from Previous Round
Scope expanded: all 39 models → UUID v4, all validations .cuid()→.uuid(), native PostgreSQL uuid type conversion

## Functionality Findings

### F1 [Critical] scim_external_mappings.internal_id not converted
- **Status:** Not applicable — table empty after DB reset
- **Note:** If SCIM data exists at migration time, internal_id must be updated via user/team mapping tables

### F2 [Major] createTeamE2E*.id optional→required (API breaking)
- **Status:** By design — optional was a latent bug (AAD mismatch on omission)

### F3 [Minor] Attachment route validation asymmetry
- **Status:** Deferred — functionally equivalent

## Security Findings

### S1 [Critical → Resolved] RLS policy rebuild replace() fragile
- **Problem:** Dynamic `replace()` on `pg_policies.qual` depends on PostgreSQL internal text representation which varies across versions. Failure leaves tables without RLS policies.
- **Action:** Replaced with static DROP/CREATE for all 38 policies
- **Modified file:** `prisma/migrations/20260321110000_.../migration.sql`

### S2 [Major] md5()::uuid bootstrap tenant ID predictable
- **Status:** By design — deterministic generation required for idempotent bootstrap

### S5 [Minor → Resolved] operatorId .min(1) → .uuid()
- **Modified files:** `rotate-master-key/route.ts`, `purge-history/route.ts`

### S6 [Minor → Resolved] team rotate-key userId .min(1) → .uuid()
- **Modified file:** `teams/[teamId]/rotate-key/route.ts`

## Testing Findings

### T1 [Major → Resolved] CUID IDs in rotate-key/data tests
- **Modified files:** `vault/rotate-key/data/route.test.ts`, `teams/[teamId]/rotate-key/data/route.test.ts`

### T2 [Major → Resolved] Bulk 101-item tests using non-UUID strings
- **Action:** Changed `id-${i}` to UUID v4 format in 6 bulk test files

### T3 [Major] Missing non-UUID rejection tests
- **Status:** Deferred — unit tests in `common.test.ts` cover UUID validation

### T4 [Minor] Duplicate test in vault/rotate-key
- **Status:** Deferred — low impact

### T5 [Minor] fixtures.ts non-UUID IDs
- **Status:** Deferred — mock data not validated by Zod

## Adjacent Findings
None

## Additional Fix
- Renamed `team_policies` RLS policy from `tenant_isolation` to `team_policies_tenant_isolation` for naming consistency with all other tables
