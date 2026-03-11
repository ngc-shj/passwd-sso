# Code Review: beforeunload-dirty-state
Date: 2026-03-11
Review round: 4

## Changes from Previous Round
Round 1 addressed: unused `act` import, test title mismatch, missing afterEach spy restore.
Round 2 covers full branch including post-review commits (SPA navigation guard, watchtower refactor).

## Functionality Findings

### F1 [Major] Dialog state not cleared when dirty becomes false (resolved)
- File: `src/hooks/use-navigation-guard.ts`
- Problem: If dialog is open and `dirty` changes to `false`, dialog stays open
- Action: Added useEffect to clear dialogOpen, pendingHref, and allowLeaveRef when dirty=false

### F2 [Major] allowLeaveRef never reset after confirmLeave (resolved)
- File: `src/hooks/use-navigation-guard.ts`
- Problem: allowLeaveRef stays true permanently after confirmLeave, disabling future guards
- Action: Fixed via same useEffect as F1

### F3 [Minor] onOpenChange type signature mismatch (skipped)
- Problem: cancelLeave is `() => void` but onOpenChange expects `(open: boolean) => void`
- Action: Skipped — TypeScript allows this (parameter bivariance), runtime behavior is correct

## Security Findings

### S1 [Minor] sessionStorage documentation inaccuracy (resolved)
- File: `docs/security/considerations/en.md`, `ja.md`
- Problem: "No keys currently stored" was incorrect — PRF-related items still exist
- Action: Updated to list `psso:prf-output`, `psso:prf-data`, `psso:webauthn-signin`

### S2 [Minor] allowLeaveRef not reset (duplicate of F2, resolved)

## Testing Findings

### T1 [Major] No tests for useNavigationGuard (resolved)
- File: `src/hooks/use-navigation-guard.test.ts` (new)
- Problem: Core SPA navigation guard logic was untested
- Action: Created 7 tests covering: dirty=false no intercept, internal link intercept, external link skip, cancelLeave, confirmLeave, dirty→false dialog clear, unmount cleanup

### T2 [Minor] returnValue assertion missing (skipped)
- Problem: jsdom `Event` doesn't simulate `BeforeUnloadEvent.returnValue` correctly
- Action: Skipped — environment limitation, not a code issue

### T3 [Minor] dirty=true→true rerender test missing (skipped)
- Problem: React useEffect deps guarantee this behavior
- Action: Skipped — over-testing

## Resolution Status
### F1 [Major] Dialog not cleared on dirty=false
- Action: Added useEffect with dirty dependency
- Modified file: src/hooks/use-navigation-guard.ts:28-33

### F2 [Major] allowLeaveRef never reset
- Action: Reset in same useEffect
- Modified file: src/hooks/use-navigation-guard.ts:31

### S1 [Minor] sessionStorage docs inaccuracy
- Action: Listed actual sessionStorage items
- Modified file: docs/security/considerations/en.md:358-362, ja.md:358-362

### T1 [Major] No useNavigationGuard tests
- Action: Created test file with 7 tests
- Modified file: src/hooks/use-navigation-guard.test.ts (new)

---

## Round 3: New commits (team import audit, team audit log decryption, team empty trash)

### Functionality Findings (Round 3)

#### F4 [Critical] TOCTOU between findMany/deleteMany in empty-trash (resolved in Round 4)
- File: `src/app/api/teams/[teamId]/passwords/empty-trash/route.ts`, `src/app/api/passwords/empty-trash/route.ts`
- Problem: findMany and deleteMany are separate operations; concurrent restore could cause audit log IDs to diverge from actually deleted entries
- Action: Initially accepted; later fixed by wrapping in `prisma.$transaction` inside single RLS call (see Round 4)

#### F5 [Minor] Empty trash dialog has no explicit cancel button (skipped)
- Action: Skipped — matches personal trash dialog pattern (consistent UX)

#### F6 [Minor] Empty trash button had no loading state (resolved)
- File: `src/components/team/team-trash-list.tsx`
- Action: Added `isEmptying` state with disabled button + Loader2 spinner

### Security Findings (Round 3)

#### S3 [Minor] Unvalidated from/to date strings in audit-logs API (skipped)
- File: `src/app/api/teams/[teamId]/audit-logs/route.ts`
- Action: Skipped — pre-existing code, out of scope for this branch

#### S4 [Minor] Import audit successCount+failedCount cross-field validation (skipped)
- File: `src/app/api/audit-logs/import/route.ts`
- Action: Skipped — pre-existing schema design, out of scope

#### S5 [Minor] withBypassRls defence-in-depth comment (skipped)
- Action: Skipped — pre-existing pattern, out of scope

### Testing Findings (Round 3)

#### T4 [Critical] No test for team empty-trash endpoint (resolved)
- Action: Created `src/__tests__/api/teams/team-empty-trash.test.ts` with 6 tests (401, 403, re-throw, happy path, empty trash, DB error)

#### T5 [Major] Pre-migration ItemKey null guard not tested in audit-logs (resolved)
- Action: Added test case in `audit-logs.test.ts` for entries with null ItemKey fields

#### T6 [Minor] Team import test missing toast assertion (resolved)
- Action: Added `mockToastSuccess` assertion in `use-import-execution.test.ts`

#### T7 [Major] Frontend role derivation fails for empty trash list (accepted)
- Problem: `canEmptyTrash` derives role from entries; if trash is empty, button is hidden even for OWNER
- Action: Accepted — empty trash with 0 entries is a no-op; button not needed when list is empty

## Resolution Status (Round 3)

### F6 [Minor] Empty trash loading state
- Action: Added isEmptying state, disabled button, Loader2 spinner
- Modified file: src/components/team/team-trash-list.tsx

### T4 [Critical] No test for team empty-trash
- Action: Created test file with 6 tests
- Modified file: src/__tests__/api/teams/team-empty-trash.test.ts (new)

### T5 [Major] Pre-migration ItemKey null guard
- Action: Added test case asserting entries with null ItemKey are excluded from entryOverviews
- Modified file: src/__tests__/api/teams/audit-logs.test.ts

### T6 [Minor] Team import toast assertion
- Action: Added mockToastSuccess assertion
- Modified file: src/components/passwords/use-import-execution.test.ts

---

## Round 4: TOCTOU fix + personal trash loading state

Changes reviewed:
- `e00c6fe5` fix: add loading state to personal empty trash button
- `15843a17` fix: wrap empty-trash findMany+deleteMany in $transaction

### Functionality Findings (Round 4)

#### F4 [Critical] TOCTOU race — RESOLVED
- Previously accepted; now fixed by wrapping findMany+deleteMany in `prisma.$transaction` inside single `withUserTenantRls`/`withTeamTenantRls` call
- Both personal and team routes updated consistently

#### F7 [Minor] DialogTrigger missing `disabled={isEmptying}` (skipped)
- Problem: Theoretically possible to re-open dialog during emptying
- Action: Skipped — `isEmptying` state persists across dialog re-open, confirmation button is disabled

#### F8 [Minor] Individual delete/restore buttons lack loading state (skipped)
- Problem: No `disabled` during handleDeletePermanently/handleRestore
- Action: Skipped — pre-existing pattern, out of scope for this branch

### Security Findings (Round 4)

No new Critical/Major findings. TOCTOU fix verified: `$transaction` runs within the same `withTenantRls` RLS context. Authorization checks (session + `requireTeamPermission`) remain intact.

#### S6 [Info] Team route missing `withRequestLog` wrapper (noted)
- File: `src/app/api/teams/[teamId]/passwords/empty-trash/route.ts`
- Action: Noted — consistent with other team route patterns; not a security issue

### Testing Findings (Round 4)

#### T8 [Major] Personal test mocks `prisma.auditLog.create` instead of `logAudit` (resolved)
- File: `src/app/api/passwords/empty-trash/route.test.ts`
- Problem: Tests spied on internal Prisma call rather than module boundary (`logAudit`), fragile and inconsistent with team test pattern
- Action: Rewrote test to mock `@/lib/audit` with `mockLogAudit`, removed `mockAuditCreate`/`mockPrismaUser`/`mockWithBypassRls`

#### T9 [Minor] `findMany` arguments not asserted (skipped)
- Action: Skipped — `deleteMany` assertion with `id: { in: [...] }` implicitly verifies findMany produced correct IDs

#### T10 [Minor] Empty-trash test doesn't assert `deleteMany` called when `findMany` returns `[]` (skipped)
- Action: Skipped — Prisma always executes deleteMany even with empty `in:[]`; early-return guard is not planned

## Resolution Status (Round 4)

### F4 [Critical] TOCTOU race in empty-trash
- Action: Wrapped findMany+deleteMany in `prisma.$transaction` inside single RLS call
- Modified files: src/app/api/passwords/empty-trash/route.ts, src/app/api/teams/[teamId]/passwords/empty-trash/route.ts

### T8 [Major] Personal test audit mock pattern
- Action: Rewrote to mock `logAudit` at module boundary, consistent with team test
- Modified file: src/app/api/passwords/empty-trash/route.test.ts
