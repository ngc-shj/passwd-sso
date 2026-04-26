# Code Review: admin-operator-validation-and-audit-test
Date: 2026-04-27
Review rounds: 2
Branch: fix/admin-operator-validation-and-audit-test

## Changes from Previous Round
- Round 1: Initial review on the F2/T3/R18 baseline diff (4 files).
- Round 2: After applying all fixes including the out-of-scope ones (option D — full fix). Verified S1/S2/S3 in `maintenance-auth.ts` + `audit-chain-verify/route.ts`, T2 split, F1 message tightening, T3 cleanup of two extra test files. New finding T1 (Round 2) added.

## Scope summary

This PR addresses two minor cleanups carried over from the PR #398 (proxy-csrf-enforcement) review:

- **F2** (`src/app/api/admin/rotate-master-key/route.ts`): Replace ad-hoc `prisma.user.findUnique` operatorId validation with the shared `requireMaintenanceOperator` helper (active OWNER/ADMIN + deactivatedAt: null check), aligning with all other maintenance routes.
- **T3** (`src/app/api/internal/audit-emit/route.test.ts`): Remove redundant `vi.mock("@/lib/constants")` block and import the real `AUDIT_ACTION` / `AUDIT_SCOPE` constants.
- **R18 sync** (`scripts/checks/check-bypass-rls.mjs`): Narrow the `rotate-master-key/route.ts` allowlist after `prisma.user` access moved out of the file.

Files changed: 4. No new plan was required (Phase 2 direct).

## Functionality Findings

### F1 — Minor: Error message contract test assertion is weak
- **File**: `src/app/api/admin/rotate-master-key/route.test.ts:158`
- **Evidence**: Old error: `"operatorId does not match an existing user"`. New error (from `requireMaintenanceOperator`): `"operatorId is not an active tenant admin"`. Test asserts `expect(body.error).toContain("operatorId")` — passes with both strings.
- **Problem**: The assertion does not pin the new semantic ("active admin" rejection vs "user not found"); a future helper-message change that drops the word "operatorId" would silently regress.
- **Impact**: Low. The new where-clause assertion (`expect(where.role)... expect(where.deactivatedAt)`) covers the behavioral contract at the query level. Only the message check is weak.
- **Fix**: Tighten to `expect(body.error).toContain("active tenant admin")`.

## Security Findings

### S1 — Minor [Out of scope — different file]: `audit-chain-verify` inlines its own active-admin check instead of using `requireMaintenanceOperator`
- **File**: `src/app/api/maintenance/audit-chain-verify/route.ts:106-125`
- **Evidence**: All other maintenance routes consuming `operatorId` (`purge-history`, `purge-audit-logs`, `dcr-cleanup`, `audit-outbox-metrics`, `audit-outbox-purge-failed`) call `requireMaintenanceOperator`. `audit-chain-verify` has its own `tenantMember.findFirst` with the same role/deactivated filters but additionally cross-checks `userId + tenantId` (scoped variant).
- **Problem**: Divergent maintenance point — if "active admin" semantics evolve in `requireMaintenanceOperator`, this route will not pick it up.
- **Anti-Deferral check**: out of scope (different feature). File is NOT in this PR's diff.
- **Routing**: TODO(post-csrf-cleanup) — extend `requireMaintenanceOperator` with optional `tenantId` filter, then migrate this route. Track alongside group B work.

### S2 — Minor [Out of scope — different file]: `requireMaintenanceOperator` `findFirst` without orderBy yields non-deterministic tenantId
- **File**: `src/lib/auth/access/maintenance-auth.ts:29`
- **Evidence**: `prisma.tenantMember.findFirst({ where: { userId, role: { in: [OWNER, ADMIN] }, deactivatedAt: null } })` — no `orderBy`. A user who is OWNER of tenant A and ADMIN of tenant B returns an arbitrary row.
- **Problem**: For system-wide admin actions like `rotate-master-key` (which affects all tenants' shares), the audit-log tenantId attribution becomes indeterminate in multi-tenant deployments where one user holds admin in multiple tenants.
- **Anti-Deferral check**: out of scope (different file, predates this PR). File is NOT in diff.
- **Routing**: TODO(post-csrf-cleanup) — either add `orderBy: { createdAt: "asc" }` to the helper, or require explicit `tenantId` body param for system-wide admin endpoints. Track alongside group B/C work.

### S3 — Minor [Out of scope — different file]: `as MaintenanceOperator` cast bypasses type narrowing
- **File**: `src/lib/auth/access/maintenance-auth.ts:48`
- **Evidence**: `return { ok: true, operator: membership as MaintenanceOperator };` — Prisma returns `role: TenantRole` (broad enum), but the helper's return type narrows to `OWNER | ADMIN` only.
- **Anti-Deferral check**: out of scope (pre-existing in unchanged file).
- **Routing**: TODO(post-csrf-cleanup) — replace cast with explicit runtime check. Track alongside group B work.

### Recurring Issue checks (security-relevant)

- **RS1 timing-safe**: `verifyAdminToken` uses `timingSafeEqual` on SHA-256 hash. No regression.
- **RS2 rate limit**: `createRateLimiter({ windowMs: 60_000, max: 1 })` applied after auth. Correct.
- **RS3 input validation**: `operatorId: z.string().uuid()` at schema boundary. Correct.
- **R3 propagation (operatorId)**: All `operatorId`-consuming routes except `audit-chain-verify` (S1) now use `requireMaintenanceOperator`.
- **R18 narrowing**: `prisma.user` confirmed absent from `rotate-master-key/route.ts` post-fix; narrowing safe.
- **F2 regression check**: Old check accepted any UUID mapping to a user (deactivated, MEMBER, any tenant). New check strictly requires `role in [OWNER, ADMIN] AND deactivatedAt IS NULL`. Strictly stronger; no legitimate cases lost.

## Testing Findings

### T2 — Major: rotate-master-key rejection test bundles two filter assertions into one case
- **File**: `src/app/api/admin/rotate-master-key/route.test.ts:149-167`
- **Evidence**: Reference file `src/app/api/maintenance/purge-history/route.test.ts:140-171` has three separate rejection tests (generic null, MEMBER role, deactivated admin). The new test in this PR has one test combining `where.role` + `where.deactivatedAt` assertions.
- **Problem**: If `where.role` assertion fails first, `where.deactivatedAt` is never reached — less diagnostic and inconsistent with the established pattern.
- **Impact**: Both filters ARE asserted, so coverage is preserved; this is a test quality / debuggability issue, not a false-green.
- **Fix**: Split into two tests mirroring the reference pattern (MEMBER role rejection asserting `where.role`; deactivated admin rejection asserting `where.deactivatedAt`).

### T3 — Minor [Out of scope — different files]: Two other test files have the same redundant `vi.mock("@/lib/constants", importOriginal)` pattern
- **Files**: `src/app/api/auth/passkey/verify/route.test.ts:55`, `src/components/share/send-dialog.test.tsx:78`
- **Anti-Deferral check**: out of scope (different files). NOT in this PR's diff.
- **Routing**: TODO(post-csrf-cleanup) — apply the same T3 cleanup to those two files in a follow-up PR after individual inspection (some keys may be genuinely missing from real constants and need to remain stubs).

### Recurring Issue checks (testing-relevant)

- **RT1 mock-reality**: `mockTenantMemberFindFirst` returns `{ tenantId, role }` matching the real `select: { tenantId: true, role: true }` exactly.
- **RT3 shared constants**: T3 cleanup correctly imports real constants; no test rendered vacuous (`AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED` resolves to the same `"PASSKEY_ENFORCEMENT_BLOCKED"` string previously asserted as a literal).
- **R19 mock alignment**: All mocks aligned with the new helper's surface.
- **Test count baseline**: Net zero — one `it(` was renamed (no add/remove).

## Adjacent Findings

(See S1, S2, S3, T3 — all flagged with `[Out of scope — different file]` and routed to TODO(post-csrf-cleanup).)

## Quality Warnings

None. All findings include evidence, file:line, and concrete fixes.

## Recurring Issue Check (consolidated)

### Functionality expert
- R1-R30: Checked. R3 / R12 / R17 / R18 / R22 directly verified. No issue except F1 Minor (above).

### Security expert
- R1-R30: Checked. R3 (operatorId propagation), R18 (allowlist narrowing) verified.
- RS1 (timing-safe): Pass.
- RS2 (rate limit): Pass.
- RS3 (input validation): Pass.
- Findings: S1, S2, S3 (all Out of scope — diff-external).

### Testing expert
- R1-R30: Checked. R3 (mock pattern propagation) → T3.
- RT1 (mock-reality divergence): Pass.
- RT2 (testability): N/A — all touched code is unit-testable.
- RT3 (shared constants): Pass.
- Findings: T2 Major (in scope), T3 Minor (out of scope).

## Resolution Status

### F1 Minor — Error message contract assertion was weak
- **Action**: Tightened both new split tests in T2 to `expect(body.error).toContain("active tenant admin")` (was `.toContain("operatorId")`).
- **Modified file**: `src/app/api/admin/rotate-master-key/route.test.ts:158, 174`
- **Round 2 status**: Resolved (verified by Functionality expert).

### T2 Major — Rejection test bundled two filter assertions
- **Action**: Split the single rejection test into two — one asserting `where.role` (MEMBER role rejection), one asserting `where.deactivatedAt` (deactivated admin rejection). Mirrors `purge-history/route.test.ts:140-171` reference pattern.
- **Modified file**: `src/app/api/admin/rotate-master-key/route.test.ts:149-179`
- **Round 2 status**: Resolved (verified by Testing expert).

### S1 Minor — `audit-chain-verify` inlined operator validation
- **Action**: Migrated to `requireMaintenanceOperator(operatorId, { tenantId })` after extending the helper signature with optional `tenantId`. Removed inline `tenantMember.findFirst` block and now-unused `TENANT_ROLE` import. Added entry to `check-bypass-rls.mjs` (narrowed from `["tenantMember"]` to `[]` since only `$queryRawUnsafe` access remains).
- **Modified files**:
  - `src/app/api/maintenance/audit-chain-verify/route.ts:106-108` (replaced 18 lines of inline check)
  - `src/lib/auth/access/maintenance-auth.ts` (added `MaintenanceOperatorOptions` + `tenantId` filter)
  - `scripts/checks/check-bypass-rls.mjs:68` (narrowed allowlist)
- **Round 2 status**: Resolved (verified by Functionality + Security experts).

### S2 Minor — `findFirst` non-deterministic for multi-tenant admins
- **Action**: Added `orderBy: { createdAt: "asc" }` to the `requireMaintenanceOperator` query. Pins audit attribution to the operator's oldest admin membership when they hold admin in multiple tenants.
- **Modified file**: `src/lib/auth/access/maintenance-auth.ts:42-44`
- **Round 2 status**: Resolved. Security expert verified no new attack vector — caller cannot influence ordering, and the `tenantId`-filtered call site (audit-chain-verify) is unique-bound by `@@unique([tenantId, userId])`.

### S3 Minor — `as MaintenanceOperator` cast bypassed type narrowing
- **Action**: Replaced cast with explicit runtime narrowing. Throws `Error("requireMaintenanceOperator invariant violated: unexpected role X")` if the DB returns a row whose role is not OWNER/ADMIN despite the where filter. Defensive against schema/enum drift.
- **Modified file**: `src/lib/auth/access/maintenance-auth.ts:55-65`
- **Round 2 status**: Resolved. Security expert noted Minor observation N3 (named Error subclass possible per TS rules); accepted as-is — `src/lib/auth/` consistently uses `throw new Error(...)` with descriptive messages, no Error subclass convention exists.

### T3 Minor — Redundant `vi.mock("@/lib/constants")` cleanup
- **Action**:
  - In-scope (Round 1 file): removed redundant block from `src/app/api/internal/audit-emit/route.test.ts`, replaced literals with `AUDIT_ACTION` / `AUDIT_SCOPE` imports.
  - Out-of-scope files (Round 1 → fixed under option D in Round 2):
    - `src/app/api/auth/passkey/verify/route.test.ts:55-63` — removed (override values matched real constants AUTH_LOGIN/SESSION_REVOKE_ALL/EXTENSION_TOKEN_FAMILY_REVOKED, AUDIT_SCOPE.PERSONAL).
    - `src/components/share/send-dialog.test.tsx:78-87` — removed (override values matched real constants API_PATH.SENDS/SENDS_FILE).
- **Modified files**:
  - `src/app/api/internal/audit-emit/route.test.ts`
  - `src/app/api/auth/passkey/verify/route.test.ts`
  - `src/components/share/send-dialog.test.tsx`
- **Round 2 status**: Resolved. Testing expert verified no test became vacuous; all 24 affected tests pass.

### T1 Major (Round 2 — new) — `requireMaintenanceOperator` new options/orderBy/throw had no direct test
- **Action**: Created `src/lib/auth/access/maintenance-auth.test.ts` with 11 unit tests covering:
  - Default success (OWNER + ADMIN roles)
  - 400 NextResponse path
  - role / deactivatedAt where filters
  - `orderBy: { createdAt: "asc" }` presence
  - `tenantId` option forwarding (omitted, undefined, provided)
  - Runtime invariant throw on unexpected role
  - `BYPASS_PURPOSE.SYSTEM_MAINTENANCE` argument to `withBypassRls`
- **Modified file**: `src/lib/auth/access/maintenance-auth.test.ts` (new file, 12 tests including 1 setup test)
- **Status**: Resolved. 11/11 tests pass.

### N3 Minor (Round 2 — new) — Use named Error subclass
- **Anti-Deferral check**: acceptable risk
- **Justification**:
  - Worst case: future Error subclass convention adopted; this throw not migrated.
  - Likelihood: low — `src/lib/auth/` uses plain `throw new Error(...)` consistently, no codebase-wide subclass convention.
  - Cost to fix: ~10 LOC for new InvariantError subclass + integration; net negative if no other call sites adopt it.
- **Decision**: Skipped. Codebase convention takes precedence; revisit if a project-wide Error subclass policy is adopted.
- **Orchestrator sign-off**: Acceptable risk justified — codebase has no Error subclass convention; introducing one for a single defensive throw is over-engineering.

### S1/S2/S3/T3 — Pre-existing-in-unchanged-file resolution
All four findings were initially flagged as `[Out of scope — different file]` in Round 1. The user invoked option D (full fix in this PR) per the 30-minute Anti-Deferral rule. All have been resolved in scope.
