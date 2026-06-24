# Coding Deviation Log: admin-stepup-nostore-hardening

## Deviations (manually recorded)

### D1 — New test fixtures use UUIDv4 instead of plan's `"entry-1"` placeholder
- **Files**: `src/app/api/share-links/route.test.ts`, `src/app/api/sends/route.test.ts` (new files)
- **Reason**: the `passwordEntryId` field is validated by Zod `.uuid()`; the plan's conceptual `"entry-1"` placeholder would fail validation. Used a valid UUIDv4 (`a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d`), matching the convention in sibling tests (e.g. `vault/delegation/route.test.ts`).

### D2 — Pre-existing lint warning fixed (root cause, not in original scope)
- **File**: `src/app/api/tenant/policy/route.ts:942`
- **Reason**: C3 added the step-up gate to `handlePATCH`, putting the whole file in diff scope (CLAUDE.md "Fix ALL errors"). A pre-existing `no-unused-vars` warning (`tx` param of the outer `withBypassRls` callback, shadowed and unused) was fixed at root cause by dropping the unused param — NOT suppressed (per `feedback_no_suppress_warnings`).

### D3 — R2 hardcoded-reuse hook false positive (deliberate skip)
- **Anti-Deferral check**: out of scope (false positive — not a real shared-constant violation)
- **Justification**: the R2 hook flagged `"tenant-1"` and a UUID literal in the two new test files as matching a `TENANT_ID`/`ENTRY_ID_1` constant. Those "constants" are LOCAL `const` declarations inside unrelated test files (`purge-history/route.test.ts`, `vault/delegation/route.test.ts`), not shared exports. Sibling tests in the same directories (`share-links/[id]/route.test.ts:62`, `sends/file/route.test.ts:88`) use the identical inline `"tenant-1"` literal. There is no shared exported test-fixture constant; importing another test's private fixture would create cross-test coupling. Following local convention is correct.
- **Orchestrator sign-off**: confirmed — test-fixture string collision across independently-authored test files is the documented R2 caveat, not a violation.
