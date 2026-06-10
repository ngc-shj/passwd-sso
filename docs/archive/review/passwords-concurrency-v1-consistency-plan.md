# Plan: passwords-concurrency-v1-consistency

Branch: `fix/passwords-concurrency-v1-consistency`
Worktree: `passwd-sso-ord`

## Project context

- Type: web app (Next.js 16 + Prisma 7 + PostgreSQL 16 + RLS).
- Test infrastructure: unit (vitest, co-located `route.test.ts`, `vi.mock` + `$transaction` mock convention) + real-DB integration (`npm run test:integration`, has a `raceTwoClients` concurrency helper at `src/__tests__/db-integration/helpers.ts:297`) + E2E + CI/CD (`scripts/pre-pr.sh`).
- Verification environment constraints:
  - **VE1**: the C1 lost-update guarantee is only observable under genuine concurrency against a real Postgres (mocked `$transaction` cannot exercise row-lock serialization). The authoritative test is a `raceTwoClients` db-integration test; unit tests cover only the call-shape (FOR UPDATE issued, snapshot sourced from the in-tx read).

## Objective

Remediate the 4 follow-up findings from the post-`#530` security review — all **Low** severity, none merge-blocking, all pre-existing (not introduced by `#530`). No Prisma schema migration (C1 uses row-level locking, not a new `version` column; C4's column already exists). No client-facing contract change.

## Requirements

Functional: no change to request/response shapes. C1 makes the password-entry history snapshot + update atomic and lost-update-safe for concurrent PUTs to the same entry. C2 applies the tenant access restriction to the SA-token path of `/api/v1/vault/status`. C3 stops rejecting valid `tagIds` that merely contain duplicates. C4 throttles the API-key `lastUsedAt` write.

Non-functional: C1 must not regress single-PUT latency materially (one extra `SELECT … FOR UPDATE` on a PK row inside an already-open tx); must hold the lock for the minimal span (read → snapshot → update within one tenant-scoped tx).

## Technical approach

No schema change, no migration. C1 consolidates the per-handler transaction boundaries and adds a PK-row `FOR UPDATE` lock as the snapshot source. C2/C3/C4 are localized edits reusing existing helpers/constants/patterns (`enforceAccessRestriction`, team's `Set` dedupe precedent, SA-token throttle precedent).

## Contracts

### C1 — Password-entry history snapshot is atomic and lost-update-safe (personal + v1 + team)

- Files: `src/app/api/passwords/[id]/route.ts` (personal PUT, currently 3 separate `withUserTenantRls` calls at :94 read, :146-172 snapshot, :203-209 update), `src/app/api/v1/passwords/[id]/route.ts` (v1 PUT, existing read at :117-130 separate from the snapshot+update tx at :198-228), `src/lib/services/team-password-service.ts` (`updateTeamPassword`, snapshot+update in one tx at :508-540 but sourcing the snapshot from the caller-supplied `input.existingEntry` read OUTSIDE the tx) + the three corresponding test files + one new db-integration test (personal is sufficient as the representative concurrency proof; team/v1 share the identical mechanism).
- Root cause (verified, R3 — same class in all THREE handlers): the history snapshot writes blob/IV/authTag/keyVersion/aadVersion read OUTSIDE the snapshot/update transaction (`existing.*` in personal/v1, `input.existingEntry.*` in team). Two concurrent PUTs both read the same committed state, both snapshot the same old blob, last-writer-wins → the intermediate version is absent from history. Personal additionally has a single-thread window (snapshot and update are two distinct transactions).
- Signature / mechanism — for ALL THREE handlers, when the blob is changing (`encryptedBlob` present / `isFullUpdate`), perform snapshot + update inside ONE tenant-scoped transaction (`withUserTenantRls`/`withTenantRls` already open a tx; team's `prisma.$transaction` is already one — do NOT nest a second `$transaction`):
  1. Lock + re-read the current row as the snapshot source, using a **parameterized `$queryRaw` tagged template** (NOT `$queryRawUnsafe`; `id`/`passwordId` is an already-validated uuid route param, bound as a parameter — no injection surface):
     - personal/v1: `` const [cur] = await tx.$queryRaw<Row[]>`SELECT encrypted_blob, blob_iv, blob_auth_tag, key_version, aad_version FROM password_entries WHERE id = ${id}::uuid FOR UPDATE` ``
     - team: the analogous `SELECT ... FROM team_password_entries WHERE id = ${passwordId}::uuid AND team_id = ${teamId}::uuid FOR UPDATE` (the `team_id` predicate mirrors the existing `update where: { id, teamId }` — defense-in-depth symmetry, F3/S-info) covering team's snapshot columns (encrypted_blob, blob_iv, blob_auth_tag, aad_version, team_key_version, item_key_version, encrypted_item_key, item_key_iv, item_key_auth_tag).
     - The PK row lock serializes concurrent PUTs to the same entry; the second waits until the first commits, then reads the first's committed blob as ITS snapshot source. RLS GUC is already set by the tenant wrapper; the `id` filter + RLS scope the row. `cur` is the authoritative pre-update state — the early `existing`/`existingEntry` read is retained ONLY for 404/ownership/version-validation, never as the snapshot source.
  2. `…History.create({ data: { entryId, tenantId, changedById, encryptedBlob: cur.encrypted_blob, … } })` — the CRYPTO-METADATA fields (blob/iv/authTag/keyVersion/aadVersion and team's item-key columns) come from `cur`; the NON-past-state fields stay as before: `tenantId` from `existing`/`existingEntry` (tenant is invariant for an entry), and team's `changedById` = the CURRENT updater `userId` (it records who created this version, not a past actor). Do NOT source `tenantId`/`changedById` from `cur`.
  3. existing trim-to-20 logic, unchanged, in the same tx.
  4. `…passwordEntry.update({ where: { id }, data: updateData, … })` — in the same tx; the held lock guarantees no interleaved writer.
  - The metadata-only path (no blob change) keeps its current single `update` (no snapshot, no lock needed) — unchanged.
  - Snapshot row-shape parity: each `$queryRaw` SELECT column list MUST cover every PAST-STATE crypto-metadata field that handler's `…History.create` writes — and ONLY those (NOT `tenant_id`/`changed_by_id`, per step 2); map snake_case columns to the create's camelCase fields explicitly (a missing crypto column → a null/undefined snapshot field is a silent data bug).
- Invariants:
  - (app-enforced) for any entry (personal/v1/team), a blob-changing PUT records the immediately-preceding committed blob in history, even under concurrent PUTs — no snapshot is lost.
  - (app-enforced) snapshot and update are atomic (same tx): a crash between them cannot leave a snapshot without its update or vice-versa.
- Forbidden patterns:
  - pattern: `encryptedBlob: existing.encryptedBlob` and `encryptedBlob: existingEntry.encryptedBlob` (snapshot sourced from the outside-tx read) — reason: the lost-update root cause.
  - pattern: `\$queryRawUnsafe` in these handlers — reason: use parameterized tagged templates for the FOR UPDATE read.
- Acceptance:
  - Unit (3 test files — personal/v1/team): the tx/prisma mock additionally exposes `$queryRaw` returning the current row (v1's `vi.mock("@/lib/prisma")` factory and personal's `txMock` literal must gain a `$queryRaw` key — they lack it today). Assert: (primary, FIELD-LEVEL per F4) EVERY crypto-metadata field the snapshot writes (blob, iv, authTag, keyVersion, aadVersion, and team's item-key columns) comes from the `$queryRaw` result, by giving the `$queryRaw` mock row values DISTINCT PER FIELD from the early `existing`/`existingEntry` fixture — a payload-level "sourced from $queryRaw" check would miss a regression that leaves only SOME fields as `existing.*`; assert each field individually equals its `cur` value; (SQL-text guard, RT1) capture the `$queryRaw` tagged-template SQL fragments (first arg = `TemplateStringsArray`, precedent `purge-audit-logs/route.test.ts:186`) and assert they contain `FOR UPDATE` and the correct table + crypto column names — mocks cannot validate SQL otherwise; (secondary) `$queryRaw` is invoked before `…History.create`; (negative) metadata-only PUT issues neither `$queryRaw` nor snapshot. Existing snapshot/trim tests stay green.
  - db-integration — **lock semantics (RT5 primary): race `updateTeamPassword`** (the ONLY one of the three that is a raceable service; personal/v1 snapshot+update are inline in their route handlers and `raceTwoClients` races service/direct-DB callbacks, not HTTP handlers — verified). Structure (per-entry to avoid the trim-to-20 conflict, T5): loop ≥50 iterations; EACH iteration seeds a FRESH team entry with an initial blob `v0`, then `raceTwoClients` runs two concurrent blob-changing `updateTeamPassword(E_i, blob=vA)` and `(E_i, blob=vB)`. After each race assert, for THAT entry (its history has at most 2 rows — far below the 20-row trim, so the trim never fires and "cumulative 2*N" is NOT used): (a) **exactly 2 history rows**; (b) **content guard — the two snapshot blobs are exactly `{v0, firstWriter}`** where `firstWriter ∈ {vA,vB}` and `firstWriter != v0` (this is the direct lost-update detector: if the lock were absent both writers snapshot `v0`, giving history `{v0, v0}` — the `firstWriter != v0` assertion fails); (c) final entry blob = the other of {vA,vB}. ALSO assert across iterations that both "A-wins" and "B-wins" occur (RT4 both-outcomes). Race-setup precondition (T6): both `updateTeamPassword` calls must be PURE blob changes with `teamKeyVersion`/`aadVersion`/`itemKeyVersion` held constant at the seeded entry's values — `updateTeamPassword` rejects a `teamKeyVersion` mismatch with 409 (`:476`) and gates version changes on the (outside-tx) `existingEntry` (`:427-431`); a version bump on either writer would 409 instead of racing. Identify `v0` vs `firstWriter` by BLOB VALUE (not `changedAt`, which is ms-precision and can tie on simultaneous writes). The identical SQL mechanism in personal/v1 (R3) is covered by the unit field-level + SQL-text guards PLUS the column-validity check below.
  - db-integration — **SQL validity for the inline handlers (closes T2/RT1 for personal+v1)**: a small test that executes the exact personal AND v1 `$queryRaw … FOR UPDATE` SELECT statements against a seeded real `password_entries` row via `createPrismaForRole` + GUC, asserting they run and return the expected columns (catches column-name/`::uuid`-cast typos that the unit mock cannot).
- Rationale for team as the lock-semantics representative: extracting personal's inline update into a service purely to make it raceable is a larger refactor than this Low-severity fix warrants; team's pre-existing `updateTeamPassword` service exercises the identical FOR-UPDATE-then-snapshot primitive, so it is the authoritative lock proof, while personal/v1's real SQL is validated by the column-validity test and their wiring by the unit SQL-text guard.
- Consumer-flow walkthrough: the client (web/extension/CLI) reads `{ ..., updatedAt }` from the PUT response and the history list from `GET /history`; no field changes — consumers see the same shapes, only with complete history under contention.

### C2 — v1 vault/status applies tenant access restriction to SA tokens

- Files: `src/app/api/v1/vault/status/route.ts` (+ `route.test.ts`).
- Signature: replace the `if (userId) { enforceAccessRestriction(req, userId, tenantId) }` gate with an `else` that calls `enforceAccessRestriction(req, SYSTEM_ACTOR_ID, tenantId, ACTOR_TYPE.SERVICE_ACCOUNT)` — exactly the form `src/app/api/tenant/access-requests/route.ts:150-156` uses. Imports: `SYSTEM_ACTOR_ID` from `@/lib/constants/app`, `ACTOR_TYPE` from `@/lib/constants/audit/audit`. (`enforceAccessRestriction`'s 4-arg signature `(req, userId, tenantIdOverride?, actorType?)` already supports this; its sentinel guard at access-restriction.ts:243 fails closed when `tenantIdOverride` is absent — we always pass `tenantId`, so it evaluates the tenant policy, not the fail-closed branch.)
- Invariants: (app-enforced) every authenticated path of `/api/v1/vault/status` — human and SA — is subject to the tenant's IP/network access restriction; no token type is exempt.
- Forbidden patterns: none grep-able; enforced by test.
- Acceptance: unit test — SA token (`userId` null) under a denying `enforceAccessRestriction` mock returns the denial response (not `{ initialized: false }`); SA token under an allowing mock still returns `{ initialized: false, keyVersion: null }`; the human path is unchanged. Assert `enforceAccessRestriction` is called with `SYSTEM_ACTOR_ID` + `ACTOR_TYPE.SERVICE_ACCOUNT` on the SA path.

### C3 — tagIds ownership check dedupes before length comparison

- Files (4 sites, all using `prisma.tag`/`tx.tag` + `userId`): `src/app/api/passwords/[id]/route.ts:134-141`, `src/lib/services/personal-password-service.ts:56-59`, `src/app/api/v1/passwords/route.ts:143-146`, `src/app/api/v1/passwords/[id]/route.ts:152-158` (+ their tests).
- Signature: in each site, `const uniqueTagIds = [...new Set(tagIds)]`, query `where: { id: { in: uniqueTagIds }, userId }`, compare `ownedCount !== uniqueTagIds.length`. Mirror the team precedent comment at `team-password-service.ts:120-122`. (DRY note: a shared helper is tempting at 4 sites, but they diverge on db-handle — `prisma` vs `tx` vs the service's `db` param — and error mapping — `validationError` vs `{ ok:false, reason }` vs `{ error }`. The 2-line Set normalization is inlined per site to avoid coupling heterogeneous callers; recorded as an accepted DRY exception. If a reviewer prefers extraction, a `dedupeTagIds(tagIds): string[]` pure util is the minimal shared piece.)
- Invariants: (app-enforced) a PUT/POST with duplicate but owned `tagIds` succeeds; a PUT/POST referencing any non-owned tag still fails. Behavior matches team entries.
- Forbidden patterns:
  - pattern: `ownedCount !== tagIds.length` / `count !== tagIds.length` in the 4 personal/v1 sites — reason: raw-length comparison is the false-reject bug.
- Acceptance: per-site unit test — `tagIds: ["t1","t1"]` where `t1` is owned → success (no `Invalid tagIds`/`INVALID_TAGS`/`TAGS_NOT_OWNED`); `tagIds: ["t1","t2-unowned"]` → still rejected.

### C4 — API-key lastUsedAt write is throttled

- Files: `src/lib/auth/tokens/api-key.ts` (validateApiKey, select at :81-91 + update at :116-122), `src/lib/constants/auth/api-key.ts` (new throttle constant) (+ `api-key.test.ts`).
- Signature:
  - `src/lib/constants/auth/api-key.ts`: `export const API_KEY_LAST_USED_THROTTLE_MS = 5 * MS_PER_MINUTE;` (import `MS_PER_MINUTE` from `../time`, mirroring `service-account.ts:1,46`). A dedicated constant — NOT a reuse of `SA_TOKEN_LAST_USED_THROTTLE_MS` — because the two are independent per-token-class policies that may diverge; both derive from `MS_PER_MINUTE` so there is no magic-number duplication (R2 satisfied).
  - validateApiKey: add `lastUsedAt: true` to the findUnique `select`; wrap the best-effort update in the same throttle the SA token uses (`service-account-token.ts:114-125`): `const shouldUpdate = !key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > API_KEY_LAST_USED_THROTTLE_MS; if (shouldUpdate) { void withBypassRls(...).catch(()=>{}) }`. Uses `Date.now()` to match the SA-token precedent verbatim (the validator has no injected clock); the unit test drives it with `vi.useFakeTimers`/an injected `lastUsedAt` fixture rather than a time provider.
- Invariants: (app-enforced) `lastUsedAt` is written at most once per `API_KEY_LAST_USED_THROTTLE_MS` per key; high-frequency v1 API calls do not amplify DB writes. Parity with SA tokens.
- Forbidden patterns: none grep-able; enforced by test.
- Acceptance: unit test — recent `lastUsedAt` (within throttle) ⇒ no `apiKey.update`; null or stale `lastUsedAt` ⇒ update issued. Use fake timers or an injected `lastUsedAt` fixture; assert via the `withBypassRls`/update mock call count. (R19: the existing `api-key.test.ts` `findUnique` mocks return rows WITHOUT `lastUsedAt`; once `lastUsedAt` is added to the production `select`, those fixtures must include `lastUsedAt` — a missing value reads as "stale ⇒ always update", silently masking the throttle. Update every `validateApiKey` fixture.)

## Go/No-Go Gate

| ID  | Subject                                                    | Status  |
|-----|------------------------------------------------------------|---------|
| C1  | Atomic + lost-update-safe history snapshot (row lock)      | locked  |
| C2  | v1 vault/status SA-token tenant access restriction         | locked  |
| C3  | tagIds dedupe before ownership length check (4 sites)      | locked  |
| C4  | API-key lastUsedAt throttle (parity with SA tokens)        | locked  |

## Testing strategy

- Unit: C1 (both route tests, $queryRaw mock + ordering + source-distinctness), C2 (SA path denial/allow), C3 (4 sites, dup-owned success + unowned reject), C4 (throttle skip/perform).
- db-integration (`npm run test:integration`, real Postgres): C1 `raceTwoClients` lost-update test (≥50 iters, both-outcomes guard, zero-lost-snapshot assertion). `ci-integration.yml` triggers on `src/app/api/**` + `src/lib/auth/**` — run locally before push.
- Gates: `npx vitest run`, `npx next build`, `npm run lint`, `scripts/pre-pr.sh` (32 checks), `npm run test:integration`.
- No `*-manual-test.md` (R35): the diff touches no deployment artifact (no Dockerfile/compose/IaC/auth-flow-config change) — this is application route/lib logic only.

## Considerations & constraints

- No schema migration (C1 row-lock, no `version` column; C4 column pre-exists). `npm run db:migrate` N/A.
- C1 deliberately avoids a client-supplied optimistic-version contract change (would break extension/CLI/web). Row-level locking achieves lost-update safety server-side with no client change. Trade-off: a `FOR UPDATE` serializes concurrent PUTs to the SAME entry (correct + rare for a personal vault); cross-entry PUTs are unaffected.
- C3 inlines Set normalization rather than extracting a helper (heterogeneous callers) — recorded DRY exception; reviewers may request a `dedupeTagIds` util.

### Scope contract

- SC1: optimistic concurrency control exposed to clients (sending a base `updatedAt`/ETag and returning 409 on conflict) is OUT of scope — a separate API-contract design PR if ever wanted. C1 solves the data-integrity bug without it.
- SC2: a shared cross-vault (personal+team) tag-ownership helper unifying `prisma.tag`/`prisma.teamTag` paths is OUT of scope (C3 only fixes the dedupe bug in place).

## User operation scenarios

1. Two browser tabs (or web + extension) save edits to the same entry near-simultaneously → both succeed, history shows both the original and the first-saved version, final state is the last save. (Pre-fix: the first save vanishes from history.)
2. An off-network SA token hits `/api/v1/vault/status` under a tenant IP restriction → denied (pre-fix: returned `{ initialized: false }`, acting as a validity oracle).
3. A v1 client sends `tagIds: ["work","work"]` (both owned) → entry saved with the tag (pre-fix: 400 Invalid tagIds).
4. A high-throughput v1 integration polls entries → API-key `lastUsedAt` updates at most every 5 min instead of every request.
