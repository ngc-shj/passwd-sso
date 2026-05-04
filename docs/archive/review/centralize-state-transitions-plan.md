# Plan: Centralize EmergencyAccess / AccessRequest state transitions + add transition matrix tests

Issue: `https://github.com/ngc-shj/passwd-sso/issues/436`
Branch: `refactor/centralize-state-transitions`
Approach: **contract-first**. The matrix and the helper signature ARE the SSoT; everything else (route migrations, tests, CI gates) is mechanical derivation.

## Project context

- Web app (Next.js 16 + Prisma 7 + PostgreSQL 16, multi-tenant SaaS, E2E-encrypted vault)
- Tests: Vitest unit + real-DB integration (`npm run test:integration`) + GitHub Actions CI
- R35 Tier-2 applies (auth flow + authorization changes)

## Objective

The Issue's goal in one sentence: **make the (from, to, actor) matrix the single source of truth for state transitions, and route every status mutation through one helper that consults it.**

Non-goals (per Issue's "Out of scope"):
- UI state visualization
- Adding new states
- Changing transition semantics

## Locked contracts (the spec; pseudo-code below is derivation)

These invariants are LOCKED. Implementation MUST satisfy them; tests MUST verify them. Pseudo-code further down restates them concretely but the contracts here are authoritative when in conflict.

**C1 — Matrix is SSoT.** The `(from, to, actor)` matrix is a typed exhaustive `Record` and is the only place that encodes which transitions are permitted for which actor. Adding a status enum value or actor enum value MUST produce a TypeScript compile error in the matrix definition.

**C2 — Helper signature.** A single function per resource:
- `transition({ db, where, to, actor, extraData? }): Promise<{ ok: true } | { ok: false }>`
- `bulkTransition({ db, where, to, actor, extraData? }): Promise<{ updated: number }>`

The helper does not impose scope shape (`tenantId` is NOT special). Routes pass whatever WHERE predicate they already use. Failure-discrimination (`reason`) is NOT exposed; routes keep their existing API_ERROR codes (400 INVALID_STATUS / 400 GRANT_NOT_PENDING / 410 INVITATION_ALREADY_USED) for `count == 0`.

**C3 — Scope-required-under-bypass.** When called inside `withBypassRls`, the helper MUST runtime-assert that `where` contains ≥1 of `{ ownerId | granteeId | granteeEmail | tokenHash }`. Throws otherwise. Defense-in-depth above the existing `getTenantRlsContext() !== undefined` check.

**C4 — Helper is RLS/transaction-passive.** Helper does NOT start a `$transaction`. Helper does NOT establish or change RLS context. Helper inherits both from caller via the `prisma` proxy in `src/lib/prisma.ts`. Helper is fully `await`-internal (single `updateMany`); no fire-and-forget (R9).

**C5 — Audit emission stays at the caller.** Helper does NOT call `logAuditAsync`. Routes/lib functions emit audit AFTER `transition() === { ok: true }` and only on the success path. The vault auto-promote case (lib function) emits audit only on the post-refetch success path; concurrent loser does not emit.

**C6 — Atomicity-on-failure for transactional callers.** A caller already inside `prisma.$transaction(async tx => ...)` MUST `throw` (not `return`) on `{ ok: false }` from `transition()`. Returning early does not abort the transaction; subsequent commits (e.g., SA-token creation) would still run. The outer `try/catch` maps the throw to the existing API_ERROR code.

**C7 — PR #433/S1+S2 invariants preserved.** The `REQUESTED → STALE (SYSTEM)` matrix row exists. The bulk STALE-marker (vault key rotation) preserves both `keyVersion: null` filter arm AND clears `ownerEphemeralPublicKey: null` via `extraData`. Three regression tests assert this directly.

**C8 — CI guard is structural, not regex.** The "no inline `data: { status }` outside state.ts" check uses an AST-based traversal (ts-morph). Self-tested with known-good and known-bad fixtures. Wired into the always-on `ci.yml` lint job (NOT path-scoped `ci-integration.yml`). Allowed files: `src/lib/emergency-access/emergency-access-state.ts`, `src/lib/access-request/access-request-state.ts`.

## Go / No-Go gate (Phase 1 → Phase 2)

Implementation does NOT start until ALL of the following are confirmed:

- [ ] Plan + review committed on the feature branch (Phase 1 deliverable)
- [ ] No new Critical findings open against the contracts (C1-C8)
- [ ] No DB schema migration is implied by this PR (verified — matrix is application-side, no enum changes)
- [ ] Context-helper layering verified: `prisma` proxy at `src/lib/prisma.ts:145-174` is unchanged; this PR does NOT touch the proxy
- [ ] `api-error-codes.ts` has `GRANT_REVOKED` added (single new code; PR adds it)
- [ ] Manual-test artifact `centralize-state-transitions-manual-test.md` skeleton exists with R35 Tier-2 sections (filled in during Phase 2)

If any item fails, Phase 1 is reopened — do NOT begin code edits.

## Contract (SSoT)

### Actor types

```ts
// src/lib/emergency-access/emergency-access-state.ts
export type EaActor = "OWNER" | "GRANTEE" | "SYSTEM";

// src/lib/access-request/access-request-state.ts
export type ArActor = "ADMIN" | "SYSTEM";
```

Each actor enum is local to its module. Each value is referenced by ≥1 matrix cell (compile-time exhaustiveness assertion below).

### Transition matrix

Matrix is a TS-exhaustive `Record<from, Record<to, ReadonlyArray<Actor>>>`. Empty array = forbidden. Adding a new status or actor forces compile-time updates.

#### Emergency-access (derived from each route's actual authorization code, not from route file names)

| from        | to         | actors permitted | Driving routes (verified by reading the route's authorization predicate) |
|-------------|------------|------------------|-----------------------------------------------------------------|
| PENDING     | ACCEPTED   | GRANTEE          | `accept` (tokenHash + granteeEmail), `[id]/accept` (granteeEmail) |
| PENDING     | REJECTED   | GRANTEE          | `reject` (tokenHash + granteeEmail), `[id]/decline` (granteeEmail) |
| PENDING     | REVOKED    | OWNER            | `[id]/revoke` permanent=true (ownerId)                            |
| ACCEPTED    | IDLE       | OWNER            | `[id]/confirm` (ownerId — owner escrows wrapped secretKey)        |
| ACCEPTED    | REVOKED    | OWNER            | `[id]/revoke` permanent=true (ownerId)                            |
| IDLE        | REQUESTED  | GRANTEE          | `[id]/request` (granteeId)                                        |
| IDLE        | STALE      | SYSTEM           | vault key rotation (`emergency-access-server.ts`)                 |
| IDLE        | REVOKED    | OWNER            | `[id]/revoke` permanent=true (ownerId)                            |
| STALE       | IDLE       | OWNER            | `[id]/confirm` (ownerId — owner re-escrows post-rotation)         |
| STALE       | REVOKED    | OWNER            | `[id]/revoke` permanent=true (ownerId)                            |
| REQUESTED   | ACTIVATED  | OWNER, SYSTEM    | `[id]/approve` (OWNER, ownerId); `[id]/vault` auto-promote (SYSTEM, granteeId) |
| REQUESTED   | IDLE       | OWNER            | `[id]/revoke` permanent=false (ownerId — resume to IDLE)          |
| **REQUESTED** | **STALE**  | **SYSTEM**       | **vault key rotation (PR #433/S1 invariant)**                     |
| REQUESTED   | REVOKED    | OWNER            | `[id]/revoke` permanent=true (ownerId)                            |
| ACTIVATED   | STALE      | SYSTEM           | vault key rotation                                                |
| ACTIVATED   | REVOKED    | OWNER            | `[id]/revoke` permanent=true (ownerId)                            |
| REVOKED     | (terminal) | -                |                                                                   |
| REJECTED    | (terminal) | -                |                                                                   |

The bolded `REQUESTED → STALE (SYSTEM)` row is the PR #433/S1 invariant (REQUESTED grants must become STALE on key rotation, otherwise an in-flight grantee can wait out `waitExpiresAt` and unwrap the owner's pre-rotation secretKey). Removing this row is a security regression.

The `[id]/vault` route currently does this transition without CAS (straight `update()`). Migration ADDS CAS via the helper; this is a side-effect bug fix (race-window closure), not a behavior change for users.

#### Access-request

| from     | to       | actors permitted | Driving routes |
|----------|----------|------------------|----------------|
| PENDING  | APPROVED | ADMIN            | `[id]/approve` |
| PENDING  | DENIED   | ADMIN            | `[id]/deny`    |
| PENDING  | EXPIRED  | SYSTEM           | (future cron — registered, no current call site; out-of-scope per Issue) |
| APPROVED | (terminal) | - |  |
| DENIED   | (terminal) | - |  |
| EXPIRED  | (terminal) | - |  |

### Helper signature

```ts
// src/lib/emergency-access/emergency-access-state.ts
import type { EmergencyAccessStatus, Prisma } from "@prisma/client";
import type { TxOrPrisma } from "@/lib/prisma";    // existing alias — DO NOT redefine (R1)

export async function transition(args: {
  db: TxOrPrisma;
  where: Prisma.EmergencyAccessGrantWhereInput;   // route's EXISTING scope predicate, untouched
  to: EmergencyAccessStatus;
  actor: EaActor;
  extraData?: Omit<Prisma.EmergencyAccessGrantUpdateInput, "status">;
}): Promise<{ ok: true } | { ok: false }>;
```

Same shape for `src/lib/access-request/access-request-state.ts`, swapping `EmergencyAccessGrantWhereInput` / `EmergencyAccessGrantUpdateInput` / `EmergencyAccessStatus` / `EaActor` for the AccessRequest equivalents.

**Why this signature is the contract**:
- `where` is whatever the route already passes to its inline `updateMany`. The helper does NOT prescribe a scope shape (no `tenantId: string` requirement). 6 emergency-access routes intentionally use `withBypassRls` and CAS by `ownerId` / `granteeEmail` / `granteeId` / `tokenHash` — the helper inherits that scope.
- Return is `{ ok: true } | { ok: false }`. No `reason` discrimination, no failure-path `findUnique`. Routes keep their existing `count === 0` → existing API_ERROR mapping (400 INVALID_STATUS, 400 GRANT_NOT_PENDING, 410 INVITATION_ALREADY_USED). F-R5 ("no behavioral change") holds.
- Helper is fully `await`-internal (single `updateMany` call) — no fire-and-forget (R9).

### Helper internals

```ts
// Derive allowed-from set from the matrix for the given (to, actor)
const allowedFroms: EmergencyAccessStatus[] = (Object.entries(MATRIX) as [
  EmergencyAccessStatus,
  Record<EmergencyAccessStatus, ReadonlyArray<EaActor>>,
][])
  .filter(([_from, perms]) => perms[args.to].includes(args.actor))
  .map(([from]) => from);

if (allowedFroms.length === 0) return { ok: false };

// Defense-in-depth: when called inside withBypassRls, require an explicit
// per-resource scope predicate. Prevents accidental "where: { id }" alone
// from succeeding under bypass scope (S12/S13).
if (isBypassRlsActive() && !hasResourceScope(args.where)) {
  throw new Error(
    "transition: under withBypassRls, where must include one of " +
      "{ ownerId | granteeId | granteeEmail | tokenHash }",
  );
}

const result = await args.db.emergencyAccessGrant.updateMany({
  where: { ...args.where, status: { in: allowedFroms } },
  data: { ...args.extraData, status: args.to },
});
return result.count >= 1 ? { ok: true } : { ok: false };
```

`hasResourceScope(where)` returns true if `where` contains at least one of `ownerId`, `granteeId`, `granteeEmail`, or `tokenHash` (string or object form). `isBypassRlsActive()` is a new export from `src/lib/tenant-rls.ts` that returns true when the active `getTenantRlsContext()` is the bypass variant. (For `bulkTransition`, the same check applies.)

`bulkTransition` is the same shape: when `where` lacks `id` (i.e., matches multiple rows), `result.count` may be > 1; routes that need bulk semantics use `result.count` from a typed `{ updated: number }` variant. To minimise surface area, we expose ONE function and document that bulk usage is "any `where` that matches multiple rows". The variant for vault-reset / emergency-access-server returns `{ updated: number }` instead of `{ ok: boolean }`. Concretely:

```ts
export async function bulkTransition(args: {
  db: TxOrPrisma;
  where: Prisma.EmergencyAccessGrantWhereInput;
  to: EmergencyAccessStatus;
  actor: EaActor;
  extraData?: Omit<Prisma.EmergencyAccessGrantUpdateInput, "status">;
}): Promise<{ updated: number }>;
```

### Derived consts

`STALE_ELIGIBLE_STATUSES` becomes dead code post-migration (its only consumer, `markGrantsStaleForOwner`, is replaced by `bulkTransition` which derives the set internally — F19). **Decision**: delete the export entirely. Keep the invariant assertion in the test suite as a regression guard against matrix narrowing:

```ts
// In emergency-access-state.test.ts
test("matrix derivation for (STALE, SYSTEM) yields the PR #433/S1 invariant set", () => {
  const derived = ALL_STATUSES.filter(from => MATRIX[from].STALE.includes("SYSTEM"));
  expect(derived.sort()).toEqual(["IDLE", "REQUESTED", "ACTIVATED"].sort());
});
```

## Implementation steps

1. **Author the matrix** as the typed exhaustive `Record` in `src/lib/emergency-access/emergency-access-state.ts`. Include all 16 cells from the table above. Add a TypeScript exhaustiveness assertion: `const _exhaust: Record<EmergencyAccessStatus, Record<EmergencyAccessStatus, ReadonlyArray<EaActor>>> = MATRIX;` — adding a new status to the schema produces a compile error here.

2. **Replace the existing `canTransition` / `fromStatusesFor` 2-arg legacy** in this same file with new exports derived from the matrix. Then `grep -rn "canTransition\|fromStatusesFor" src/ --include='*.ts' | grep -v 'state.ts\|state.test.ts'` and update each consumer:
   - 12 emergency-access routes use `fromStatusesFor` (legacy 2-arg). After this PR, they call `transition({ db, where, to, actor, extraData })` instead — they no longer import `fromStatusesFor`.
   - `STALE_ELIGIBLE_STATUSES` export is REMOVED (zero post-migration callers — `emergency-access-server.ts` is fully replaced by `bulkTransition` in step 5; F19). The invariant lives in test code instead.
   - Old `canTransition(from, to)` 2-arg has zero callers (verified by grep). Removed.

3. **Migrate emergency-access route handlers** (no new `$transaction` scopes; pass `db: tx` if route already wraps, else `db: prisma`). **All call sites stay inside their existing `withBypassRls` / `withUserTenantRls` wrapper** — the helper inherits the wrapper via the `prisma` proxy in `src/lib/prisma.ts`. Do NOT remove the wrapper as part of "simplification" (F18). Each route's WHERE clause stays as-is — only the `data: { status }` and the `status: { in: ... }` predicate move into the helper:

   - `accept/route.ts:64` — already in `withBypassRls(prisma, () => prisma.$transaction(async tx => ...))`; pass `db: tx`. `where: { tokenHash: hashToken(token), granteeEmail: ... }` (the existing predicate). actor=GRANTEE, to=ACCEPTED.
   - `reject/route.ts:45` — pass `db: prisma`. `where: { tokenHash, granteeEmail }`. actor=GRANTEE, to=REJECTED.
   - `[id]/accept/route.ts:70` — already in `prisma.$transaction`; `db: tx`. `where: { id, granteeEmail }`. actor=GRANTEE, to=ACCEPTED.
   - `[id]/decline/route.ts:43` — `db: prisma`. `where: { id, granteeEmail }`. actor=GRANTEE, to=REJECTED.
   - `[id]/approve/route.ts:42` — `db: prisma`. `where: { id, ownerId: session.user.id }`. actor=OWNER, to=ACTIVATED. extraData=`{ activatedAt: new Date() }` (preserves existing field).
   - `[id]/request/route.ts:52` — `db: prisma`. `where: { id, granteeId: session.user.id }`. actor=GRANTEE, to=REQUESTED. extraData=`{ requestedAt: new Date(), waitExpiresAt: ... }`.
   - `[id]/confirm/route.ts:64` — `db: prisma`. `where: { id, ownerId: session.user.id }`. actor=OWNER, to=IDLE. extraData=`{ encryptedSecretKey, secretKeyIv, ..., keyVersion }`.
   - `[id]/revoke/route.ts:47` (permanent branch) — `db: prisma`. `where: { id, ownerId }`. actor=OWNER, to=REVOKED. extraData=`{ revokedAt, encryptedSecretKey: null, secretKeyIv: null, secretKeyAuthTag: null, ownerEphemeralPublicKey: null, hkdfSalt: null }` (preserves the existing crypto-clear).
   - `[id]/revoke/route.ts:98` (resume-IDLE branch, `permanent=false`) — `db: prisma`. `where: { id, ownerId }`. actor=OWNER, to=IDLE. extraData=`{ requestedAt: null, waitExpiresAt: null }`.
   - `[id]/vault/route.ts:48` (auto-promote) — extracted to a new lib function `src/lib/emergency-access/vault-auto-promote.ts` (testable at lib level — see Tests §). The route handler calls this function instead of inlining logic. The lib function takes `(granteeId, grantId, now: Date)` and returns either `{ ok: true; grant: <crypto-fields> }` or `{ ok: false; reason: "not_eligible" | "revoked" | "no_escrow" }`. Internally it: (1) fetches grant under `withBypassRls`, (2) checks REQUESTED + waitExpiresAt elapsed, (3) calls `transition({ db: prisma, where: { id, granteeId }, to: ACTIVATED, actor: SYSTEM, extraData: { activatedAt: now } })`, (4) if ok refetches grant and re-validates `revokedAt: null`, (5) emits `EMERGENCY_ACCESS_ACTIVATE` audit ONLY on success path. **Behavior change**: today this is `update()` (no CAS) → after migration, double-promote races resolve correctly. Side-effect bug fix.
     - **Audit emit ordering (S3)**: helper-internal — audit is emitted from the lib function, not the route, gated on `ok: true` after refetch passes.
     - **Crypto-field race (F5/S15)**: refetch ordering is enforced inside the lib function. The `revokedAt: null` check precedes the `encryptedSecretKey` presence check — if revoked, return `{ ok: false; reason: "revoked" }` mapped to `errorResponse(API_ERROR.GRANT_REVOKED, 403)` (NEW error code; add to `api-error-codes.ts`). If never escrowed, return `no_escrow` mapped to existing `KEY_ESCROW_NOT_COMPLETED, 400`.
     - **Testability**: this extraction is what enables T17's lib-level race test without an HTTP harness.

4. **Migrate access-request route handlers**:
   - `[id]/approve/route.ts:100` — already in `withTenantRls + prisma.$transaction`; `db: tx`. `where: { id, tenantId: actor.tenantId }`. actor=ADMIN, to=APPROVED. extraData=`{ approvedById, approvedAt }`. The secondary `tx.accessRequest.update({ data: { grantedTokenId, grantedTokenTtlSec } })` at line 137 is NOT a status mutation; stays inline (comment why). **CRITICAL — F17**: on `{ ok: false }` from `transition()`, the route MUST `throw new Error("Already processed or wrong tenant")` to abort the surrounding transaction (matches today's behavior at line 110). Returning early via `errorResponse(...)` from inside the tx callback does NOT roll back — the SA-token creation at line 125 would still commit and the API would over-issue tokens. The outer `try/catch` at line 145 maps the throw back to the existing `API_ERROR.CONFLICT, 409` response.
   - `[id]/deny/route.ts:56` — `db: prisma`. `where: { id, tenantId: actor.tenantId }`. actor=ADMIN, to=DENIED. extraData=`{ approvedById, approvedAt }`.

5. **Migrate bulk-mutation lib sites** to `bulkTransition()`:
   - `src/lib/vault/vault-reset.ts:58` — currently inside `prisma.$transaction([op1, op2, ...])` array form. **Change to callback form** (`prisma.$transaction(async tx => ...)`) so `await bulkTransition({ db: tx, where: { ownerId }, to: REVOKED, actor: SYSTEM, extraData: { revokedAt: new Date() } })` can be inserted. Add an integration test that injects a failure mid-transaction and asserts EA grants are NOT marked REVOKED (atomicity invariant).
   - `src/lib/emergency-access/emergency-access-server.ts:29` — caller is the vault key-rotation flow; already accepts a `tx` parameter. Replace with `bulkTransition({ db: tx, where: { ownerId, OR: [{ keyVersion: { lt: newKeyVersion } }, { keyVersion: null }] }, to: STALE, actor: SYSTEM, extraData: { ownerEphemeralPublicKey: null } })`. **Both clauses are critical**: (a) the `keyVersion: null` arm catches early-era grants without keyVersion tracking (omitting it leaks pre-keyVersion grants past rotation — F14 / PR #433/S1 regression); (b) the `ownerEphemeralPublicKey: null` extraData defeats `unwrapSecretKeyAsGrantee()` ECDH derivation against still-present wrapping ciphertext (omitting it removes minimum-clear defense — F15 / PR #433/S2 regression). Both invariants are guarded by integration tests that load existing `emergency-access-server` fixtures and assert post-rotation state.

6. **Document non-status mutations as out of scope**: `src/auth.ts:140` mutates `tenantId`, NOT `status`. Add comment `// not a state transition — tenantId reassignment, see ../auth/email-uniqueness-design.md`.

## Tests

### Unit (Vitest, no DB)

A single test file per module. The matrix table in this plan is itself the test fixture — re-encode it verbatim in the test as `EXPECTED_TRANSITIONS` so the test fails when MATRIX (the implementation) drifts from the documented (this-plan) matrix (T15 fix — avoid tautology where MATRIX tests itself):

```ts
// 1. Fixture-based matrix assertion — uses Prisma's enum + a hand-written expected table
import { EmergencyAccessStatus } from "@prisma/client";
import { MATRIX, canTransition, EaActor } from "./emergency-access-state";

const ALL_STATUSES = Object.values(EmergencyAccessStatus) as EmergencyAccessStatus[];
const EA_ACTORS: ReadonlyArray<EaActor> = ["OWNER", "GRANTEE", "SYSTEM"];
const allFromTos = ALL_STATUSES.flatMap(from => ALL_STATUSES.map(to => [from, to] as const));

// EXPECTED_TRANSITIONS is the matrix-table from this plan, transcribed verbatim.
// Drift from MATRIX implementation surfaces as test failure.
const EXPECTED_TRANSITIONS: Record<EmergencyAccessStatus, Record<EmergencyAccessStatus, ReadonlyArray<EaActor>>> = {
  PENDING:   { ACCEPTED: ["GRANTEE"], REJECTED: ["GRANTEE"], REVOKED: ["OWNER"], IDLE: [], STALE: [], REQUESTED: [], ACTIVATED: [], PENDING: [] },
  ACCEPTED:  { IDLE: ["OWNER"], REVOKED: ["OWNER"], PENDING: [], REJECTED: [], STALE: [], REQUESTED: [], ACTIVATED: [], ACCEPTED: [] },
  IDLE:      { REQUESTED: ["GRANTEE"], STALE: ["SYSTEM"], REVOKED: ["OWNER"], PENDING: [], ACCEPTED: [], REJECTED: [], ACTIVATED: [], IDLE: [] },
  STALE:     { IDLE: ["OWNER"], REVOKED: ["OWNER"], PENDING: [], ACCEPTED: [], REJECTED: [], REQUESTED: [], ACTIVATED: [], STALE: [] },
  REQUESTED: { ACTIVATED: ["OWNER", "SYSTEM"], IDLE: ["OWNER"], STALE: ["SYSTEM"], REVOKED: ["OWNER"], PENDING: [], ACCEPTED: [], REJECTED: [], REQUESTED: [] },
  ACTIVATED: { STALE: ["SYSTEM"], REVOKED: ["OWNER"], PENDING: [], ACCEPTED: [], REJECTED: [], IDLE: [], REQUESTED: [], ACTIVATED: [] },
  REVOKED:   { PENDING: [], ACCEPTED: [], REJECTED: [], IDLE: [], STALE: [], REQUESTED: [], ACTIVATED: [], REVOKED: [] },
  REJECTED:  { PENDING: [], ACCEPTED: [], REJECTED: [], IDLE: [], STALE: [], REQUESTED: [], ACTIVATED: [], REVOKED: [] },
};

test.each(allFromTos)("matrix permits exactly the documented (%s, %s, actor) tuples", (from, to) => {
  for (const actor of EA_ACTORS) {
    const expected = EXPECTED_TRANSITIONS[from][to].includes(actor);
    expect(canTransition(from, to, actor)).toBe(expected);
  }
});

// 2. Drift detector: project EA_STATUS const matches Prisma enum
expect(Object.values(EA_STATUS).sort()).toEqual(ALL_STATUSES.sort());

// 3. Critical security invariant — guards against accidental matrix narrowing
test("REQUESTED → STALE is permitted (SYSTEM) — PR #433/S1 invariant", () => {
  expect(canTransition("REQUESTED", "STALE", "SYSTEM")).toBe(true);
  expect(STALE_ELIGIBLE_STATUSES).toContain("REQUESTED");
});

// 4. STALE_ELIGIBLE_STATUSES is the derived projection of matrix → STALE for SYSTEM
expect(STALE_ELIGIBLE_STATUSES.sort()).toEqual(["IDLE", "REQUESTED", "ACTIVATED"].sort());

// 5. Actor exhaustiveness: every EaActor value appears in ≥1 matrix cell
for (const actor of EA_ACTORS) {
  const used = ALL_STATUSES.some(from =>
    ALL_STATUSES.some(to => MATRIX[from][to].includes(actor))
  );
  expect(used, `${actor} must appear in matrix`).toBe(true);
}
```

Same shape for `access-request-state.test.ts`.

### Integration (real Postgres, `npm run test:integration`)

One file per module, exercising the helper end-to-end:

```ts
// 1. Success path — fresh row, allowed transition → ok, status updated
// 2. Wrong from-state → not ok, status unchanged
// 3. Wrong scope (e.g., wrong ownerId) → not ok, status unchanged (validates the route's scope predicate flows through verbatim)
// 4. Concurrency: race two transition() calls past PENDING — exactly one ok, one not ok. Loop 100×.
//    Pattern: for (let i = 0; i < 100; i++) {
//      const row = await tx.emergencyAccessGrant.create({ data: { status: PENDING, ... } });
//      const [a, b] = await Promise.all([transition(...), transition(...)]);
//      expect([a.ok, b.ok].sort()).toEqual([false, true]);
//      await tx.emergencyAccessGrant.delete({ where: { id: row.id } });
//    }
// 5. Vault-reset atomicity (S4 / T16): vault-reset.ts gains an optional `__testHook?: (tx) => Promise<void>` parameter
//    (test-only injection point, gated by NODE_ENV check). Test passes a hook that throws after bulkTransition runs;
//    asserts EA grants are NOT marked REVOKED (rolled back). Documented as a test-only hook in vault-reset.ts JSDoc.
// 6. Vault auto-promote race (F5/S3/T17): test the EXTRACTED lib function `vault-auto-promote.ts:autoPromoteIfElapsed(granteeId, grantId, now)`
//    via raceTwoClients (existing helper at src/__tests__/db-integration/helpers.ts). Seed a REQUESTED grant with waitExpiresAt
//    in the past; race two calls; assert exactly one returns ok and exactly one EMERGENCY_ACCESS_ACTIVATE audit row.
//    NO HTTP harness needed — test is at lib level.
// 7. bulkTransition coverage (T18): seed N grants in mixed statuses (some IDLE, some REQUESTED, some ACTIVATED, some REVOKED)
//    for one ownerId; call bulkTransition({ to: STALE, actor: SYSTEM }); assert eligible rows updated, REVOKED untouched,
//    `updated === <count of eligible>`, AND ownerEphemeralPublicKey === null on all updated rows (F15 invariant).
// 8. bulkTransition keyVersion: null guard (F14): seed grant with keyVersion: null; call bulkTransition for keyVersion: lt newVersion;
//    assert the null-keyVersion row IS marked STALE (proves the OR clause is preserved).
```

`ci-integration.yml`'s paths filter must include `src/app/api/emergency-access/**`, `src/lib/emergency-access/**`, `src/lib/access-request/**`, `src/lib/vault/**`. Adding these paths to the workflow IS in scope of this PR (T9).

### Pre-migration baseline tests (T5 / T14)

The "pre-migration baseline" is captured at PLAN time, not at code-commit time, to avoid the single-PR contradiction T14 flagged. Procedure: for each of the 10 migrated routes, copy the EXACT `logAuditAsync({...})` call shape from the route's source-as-of-base-commit into an explicit fixture in `src/__tests__/fixtures/audit-shapes.ts`:

```ts
// src/__tests__/fixtures/audit-shapes.ts (NEW file, committed in same PR as migration)
// Frozen audit-event shapes captured from the routes' pre-migration source.
// Used by route tests to assert no shape drift during the centralize-state-transitions PR.
export const PRE_MIGRATION_AUDIT_SHAPES = {
  EA_REVOKE: { action: AUDIT_ACTION.EMERGENCY_ACCESS_REVOKE, targetType: ..., metadata: { permanent: true, ... } },
  EA_REVOKE_RESUME: { action: AUDIT_ACTION.EMERGENCY_ACCESS_REVOKE, targetType: ..., metadata: { permanent: false, ... } },
  EA_APPROVE: { ... },
  // ... 10 entries, one per migrated route
} as const;
```

Each route test asserts `expect(logAuditAsync).toHaveBeenCalledWith(expect.objectContaining(PRE_MIGRATION_AUDIT_SHAPES.EA_REVOKE))`. Because the fixture is committed alongside the migration, the assertion captures the pre-migration shape (read from base-commit source) and proves the post-migration code emits the same shape.

## Constraints and risk acknowledgements

- **Helper does NOT impose `tenantId` predicate**: emergency-access defenses are per-route (`ownerId`, `granteeEmail`, `granteeId`, `tokenHash`). The helper is policy-free; it adds the `status: { in: ... }` predicate on top of whatever scope the route passes.
- **Helper does NOT call `findUnique`**: failure-path tests stay unchanged. Routes keep their existing API_ERROR codes (400 INVALID_STATUS, 400 GRANT_NOT_PENDING, 410 INVITATION_ALREADY_USED). F-R5 holds.
- **Helper does NOT start `$transaction`**: routes that currently commit immediately keep doing so; routes that wrap in `$transaction` pass `db: tx`. R9 (fire-and-forget tx-boundary) preserved because the helper is fully `await`-internal.
- **Helper does NOT log audit events**: routes continue to call `logAuditAsync` AFTER `transition() === ok`.
- **`[id]/vault` is the only route with a behavior change**: from non-CAS `update()` to CAS `transition()`. This is a side-effect bug fix (closes a double-promote race that today returns the wrapped secretKey to two grantees in pathological timing). Documented in PR description and manual-test artifact.
- **CI guard (S5 / S14)**: `scripts/check-state-mutation-centralization.sh` uses an **allowlist** approach with an **AST-based** check (NOT a regex — regex misses `data: {status:...}` without space, multi-line, shorthand `{...rest, status}`, `set: { ... }` form, etc.). Implementation: `ts-morph` traverses every `.ts` file in `src/` (excluding `__tests__/`); for each `CallExpression` matching `prisma.emergencyAccessGrant.update*()` or `prisma.accessRequest.update*()` (resolved via type), inspect the `data` argument's object literal; flag if `status` is set anywhere in the data tree. Allowed files: `src/lib/emergency-access/emergency-access-state.ts` and `src/lib/access-request/access-request-state.ts`. Wired into `ci.yml` lint job (always-on, NOT path-scoped `ci-integration.yml`). Self-test: a fixture file containing a known-bad pattern is checked into `scripts/__fixtures__/` and the script's own test asserts the script fails on it AND passes on a known-good fixture.
- **Runtime context check (S9)**: `transition()` asserts `getTenantRlsContext() !== undefined` (or in test/seed envs the assertion is skipped). This catches "raw prisma without any RLS wrap" mechanically. Bypass ctx is acceptable.

## Manual test plan (R35 Tier-2)

A separate `centralize-state-transitions-manual-test.md` artifact at PR time, with sections:
- Pre-conditions (placeholder fixtures, RS4 — no PII)
- Steps for each migrated route (positive path + audit-row assertion)
- Adversarial scenarios: cross-tenant id (tenant A admin attacks tenant B request), token replay on already-approved request, double-promote race on `[id]/vault`, race between `[id]/revoke` (permanent) and `[id]/vault` auto-promote
- Rollback: revert the PR. No data migration to undo.

## Migration / rollback

Single atomic PR (helper + matrix + route migrations + tests + CI guard + ci-integration.yml paths). No data migration. Rollback = revert.

## Open questions / deferrals

- **EXPIRED status (out of scope per Issue)**: `PENDING → EXPIRED (SYSTEM)` registered in matrix but no caller. A future PR adds the cron. TODO marker `// TODO(centralize-state-transitions-followup): no caller transitions to EXPIRED yet — implement cron in a follow-up PR`.
- **`expiresAt` precondition on `PENDING → APPROVED`**: pre-existing latent issue (admin can approve already-expired requests). NOT regressed by this PR. Documented as a separate follow-up.
