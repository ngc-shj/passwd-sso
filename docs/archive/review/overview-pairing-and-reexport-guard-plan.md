# Plan: overview-pairing-and-reexport-guard

Source: triangulated verification of the comprehensive assessment report (see
`comprehensive-assessment-report-verification.md`) — findings S1, S2, S3.
Branch: `fix/overview-pairing-and-reexport-guard`
Revision: 3 (round 2 reflected: named-chain fixpoint name-registration rule + fixture 8;
C4 blob-only route-unit tests + extension shape pin. Round 1: C1 redesigned to
one-direction refine after Critical finding F1-func — extension passkey counter flow
sends blob-without-overview)

## Project context

- Type: web app (Next.js 16 App Router + Prisma 7 + PostgreSQL)
- Test infrastructure: unit + integration + E2E + CI/CD (vitest incl. `scripts/__tests__/**/*.test.mjs`, real-DB integration via `npm run test:integration`, Playwright, 34-gate scripts/checks suite, pre-pr.sh aggregate)
- Verification environment constraints: `npm run test:integration` requires a running local Postgres (docker compose) — classified `verifiable-local`; all other acceptance paths are plain-local. No `blocked-deferred` paths.

## Objective

1. **S1**: Close the key-version-guard bypass where a PUT carrying `encryptedOverview` without `encryptedBlob` writes overview columns outside the guard, allowing a stale pre-rotation client to persist old-key ciphertext.
2. **S3**: Convert the destructive-wrapper checker's documented re-export-chain residual into a fail-closed mechanical gate.
3. **S2**: Reinforce the checker header comment so the "AST resolution admits non-grep-matchable forms" misreading cannot recur.

## Requirements

- Functional: no first-party client flow changes. Verified consumers of `PUT /api(/v1)?/passwords/[id]`:
  - full edit (web `entry-save-core.ts`): blob+overview pair;
  - metadata-only (web `personal-vault-list-adapter.ts`): neither;
  - **extension passkey signature-counter persist (`extension/src/background/passkey-provider.ts:278-285`): blob WITHOUT overview** — a legitimate, shipped shape ("overview unchanged, omit from PUT", line 270) that the fix MUST keep working.
- Non-functional: schema-enforced invariant at the shared validation boundary; checker keeps the no-Program ts-morph precedent; all new gates RT7 red-proven.

## Technical approach

- S1 is fixed at the shared Zod boundary (`updateE2EPasswordSchema`, `src/lib/validations/entry.ts:57-69`) because both routes parse with it (`src/app/api/passwords/[id]/route.ts:121`, `src/app/api/v1/passwords/[id]/route.ts:144`).
- **One-direction refine**: reject `encryptedOverview` without `encryptedBlob`. The reverse shape (blob-without-overview) is intentionally allowed:
  - It is the extension passkey counter flow (same-keyVersion blob re-encrypt, overview untouched).
  - It is NOT a corruption path: the blob branch runs `assertCurrentKeyVersion` (users FOR SHARE) inside the tx, serializing against rotation (users FOR UPDATE); rotation itself rewrites blob+overview+keyVersion atomically, so a stored overview is always at the entry's current keyVersion, and a blob-only write cannot desynchronize it. (Round-1 plan claimed the mirror direction was corruptive — refuted by this lock/rewrite analysis and withdrawn.)
- Overview-only writes have no legitimate consumer (all clients derive overview from blob content at save time) and are the S1 corruption vector → rejected.
- Precedent: `updateTeamE2EPasswordSchema` refine (`src/lib/validations/team.ts:103-113`). NOTE the deliberate scope difference: team enforces all-or-none over FOUR fields (blob, overview, aadVersion, teamKeyVersion) and both directions; personal C1 enforces one direction over TWO fields because the personal blob-only shape is a shipped flow. The C1 code comment must state this difference explicitly.
- No concurrency-primitive change; no plan-stage real-DB probe needed (no new isolation/lock semantics). Existing real-DB proof of the guard (`src/__tests__/db-integration/key-version-guard.integration.test.ts`) uses blob-only bodies (lines 244-248, 422-426, 494-498) — under the one-direction refine these remain VALID and the suite runs unchanged; the Testing strategy still executes it to prove that.

## Contracts

### C1 — updateE2EPasswordSchema overview-requires-blob refine (S1)

- Signature: append to the object schema in `src/lib/validations/entry.ts:57-69`:
  `.refine((d) => d.encryptedOverview === undefined || d.encryptedBlob !== undefined, { message: "encryptedOverview requires encryptedBlob", path: ["encryptedOverview"] })`
  Inferred type `UpdateE2EPasswordInput` unchanged. Code comment states the deliberate one-direction / two-field scope difference from the team refine (see Technical approach).
- Error surface: refine failure → `parseBody` → 400 `VALIDATION_ERROR` envelope (same as team refine). No new API error code.
- Invariant (schema-enforced at the shared boundary): **an update request that writes overview columns also writes blob columns**, and therefore (composed with the existing blob→keyVersion→guard chain at `route.ts:162-175` / v1 `185-199`) every overview write executes inside `assertCurrentKeyVersion`'s transaction.
- **R42 member-set derivation** (defining primitive: assignment of overview columns into a Prisma write payload; `grep -rn "overviewIv" src --include='*.ts'` filtered to writers):
  | Writer | Path | Status |
  |---|---|---|
  | personal update PUT | `src/app/api/passwords/[id]/route.ts:159` | **GAP → closed by C1** |
  | v1 update PUT | `src/app/api/v1/passwords/[id]/route.ts:182` | **GAP → closed by C1** (same schema) |
  | personal/v1/bulk create | via `createE2EPasswordSchema` | both fields required (entry.ts:42-44) — safe |
  | team create/update | `toOverviewColumns` in `team-password-service.ts:448` | team refine (team.ts:103-113) — safe |
  | personal rotation | `rotate-key-server.ts` | CAS + FOR UPDATE — safe |
  | team rotation | `teams/[teamId]/rotate-key/route.ts:190` | team CAS — safe |
  | history restore | `history/[historyId]/restore/route.ts` | writes blob+overview from history inside guard tx — safe |
- **Consumer-flow walkthrough**:
  - Consumer 1 (web full edit: `src/lib/vault/entry-save-core.ts:36-45` via `personal-entry-save.ts`) sends `{encryptedBlob, encryptedOverview, keyVersion, aadVersion, tagIds, ...}` → passes.
  - Consumer 2 (web metadata mutations: `personal-vault-list-adapter.ts:188-204`) sends `{isFavorite}` / `{isArchived}` — neither field → passes.
  - Consumer 3 (extension passkey counter: `extension/src/background/passkey-provider.ts:278-285`) sends `{encryptedBlob, keyVersion, aadVersion}` — blob-only → passes under one-direction refine (would have broken under round-1's two-direction design; this consumer is why the direction is scoped).
  - Consumer 4 (v1 REST external callers): overview-only PUT now 400. Pre-1.0 tightening; converts a corruption-capable request into an explicit rejection.
  - Consumer 5 (route handlers post-parseBody): no code change; the overview branch (`route.ts:157-161` / v1 `179-183`) becomes reachable only alongside the blob branch.
- Acceptance criteria:
  - PUT `{encryptedOverview}` only → 400 VALIDATION_ERROR, no DB write (both routes).
  - PUT `{encryptedBlob, keyVersion, aadVersion}` (passkey counter shape) → unchanged behavior (guard runs in tx; 200 on current keyVersion, 409 on stale).
  - PUT with both + keyVersion → unchanged. PUT metadata-only → unchanged.
  - `key-version-guard.integration.test.ts` passes unchanged (its blob-only bodies remain valid).

### C2 — checker re-export detection (S3)

- Location: `scripts/checks/check-destructive-wrapper-derivation.mjs`.
- New failure code: `REEXPORTED_DESTRUCTIVE_WRAPPER: <file> re-exports <name> from <specifier>`.
- Detection cases (ExportDeclaration with `moduleSpecifier`):
  - (a) named re-export `export { x } from` / `export { x as y } from` — flag when the *source-side* name is in the destructive set (name match; catches any chain depth for named chains without resolution).
  - (b) `export * from "<relative specifier>"` — flag when the one-hop-resolved target file is a destructive-exporting module.
  - (c) `export * as ns from "<relative specifier>"` — same lookup as (b) (namespace re-export binds the whole module).
  - Non-relative specifiers (package imports) out of scope — destructive wrappers are all in-repo.
- **Implementation ordering & transitivity (from review F2-func / F1-sec)**:
  - The re-export scan runs as a **separate pass after** the main derivation loop fully populates `destructiveExportsByModule` (mirrors the route-pass sequencing at `:682+`); it must NOT be interleaved into the per-file derivation loop (a barrel sorting before its target would otherwise false-negative).
  - The destructive-module lookup must be **transitively closed**: when a file is flagged for re-exporting a destructive symbol (any case a/b/c), register that file into the same lookup, and iterate the scan to a fixpoint (bounded by file count) so an A→B→C `export *` chain of any depth flags every hop. Without this, depth ≥3 chains evade (round-1 design under-delivered its own claim).
  - **Name registration rule for named chains (round-2 sec finding)**: for case (a), the fixpoint step registers the re-exporting file's **own locally-visible export name (post-alias)** — e.g. for `B: export { executeVaultReset as x } from "./C"`, register `B → x`, NOT `B → executeVaultReset`. A further hop `A: export { x as y } from "./B"` matches by looking up `x` against B's registered exports. Registering the original destructive-set name would silently break named chains after hop 1.
- **Scan scope extension**: the re-export pass scans production `src/**/*.ts` INCLUDING `route.ts` files (a re-export inside route.ts is invisible to the import/call-walking route pass — review F3-sec); route.ts stays excluded from the primitive-call derivation scan as before.
- Header update: RESIDUAL LIMITATION paragraph narrows to "only an INDIRECT binding evades" (local-variable assignment / higher-order pass-through — SC1).
- Invariant (app-enforced, CI gate): no production module (route.ts included) re-exports a destructive wrapper; barrel-free convention machine-checked.
- Acceptance criteria — red fixtures, each isolated to exactly the new failure code (assert exit 1 + stderr contains `REEXPORTED_DESTRUCTIVE_WRAPPER` and does NOT contain `ROUTE_DESTRUCTIVE_NO_STEPUP` / `UNDECLARED_DESTRUCTIVE_WRAPPER`; `seedWrapperStubs()` isolation pattern per `scripts/__tests__/check-destructive-wrapper-derivation.test.mjs:74-83`):
  1. named re-export; 2. aliased named re-export; 3. `export * from` (2-hop);
  4. `export * from` 3-hop chain A→B→C (proves transitive closure);
  5. ordering-adversarial: barrel file sorts before its target in scan order;
  6. `export * as ns from`; 7. re-export hosted inside a route.ts file;
  8. 2-hop NAMED chain with a distinct alias at each hop (`A: export {x as y} from "./B"`; `B: export {executeVaultReset as x} from "./C"`) — proves the post-alias name-registration rule.
  Green: current repo tree passes unchanged (grep-verified zero re-exports today); existing failure codes and exit semantics unchanged.

### C3 — checker header comment reinforcement (S2)

- Location: header wrapper-forms paragraph (lines 37-48) of the checker.
- Add one explicit sentence: the ROUTE PASS (AST) compensates only for alias/namespace *imports of grep-matchable forms*; it never admits a non-grep-matchable form — the only escapes are refactor to a grep-matchable form or an explicit `destructive-wrapper-exempt.txt` entry.
- Acceptance: comment-only; checker behavior for C3 byte-identical (self-test suite green without C3-attributable fixture changes).

### C4 — tests

- Schema unit tests (sibling test of `entry.ts`): overview-only rejected; blob-only accepted (passkey counter shape); both accepted; neither accepted. One behavioral assertion each.
- Route tests (existing `route.test.ts` harnesses for both routes; RT8 pattern at `route.test.ts:807-810`, `934-936`): overview-only PUT → assert 400 AND Prisma update mock **not** called. **Blob-only PUT unit test added per route** (assert success + guard/tx path executes) — round-2 correction: no existing route-unit test sends blob-only (every blob-carrying body pairs both fields); the only blob-only coverage today is the real-DB integration suite, so the passkey-counter shape gets an explicit route-mock pin. No existing test sends overview-only (verified).
- Extension shape pin (round-2 testing finding): add one assertion to the existing counter-persist PUT test(s) in `extension/src/__tests__/background-passkey-provider.test.ts` (~396-448) asserting the sent body does NOT contain `encryptedOverview` (e.g. `expect(putBody).not.toHaveProperty("encryptedOverview")`) — pins the client shape that motivated the one-direction refine against future two-direction regressions.
- Checker self-test (`scripts/__tests__/check-destructive-wrapper-derivation.test.mjs`, vitest harness): the 8 red fixtures + green regression above (RT7 — every new detection path proven able to fail for the claimed reason).
- Integration (real DB): `key-version-guard.integration.test.ts` must pass unchanged — executed in Testing strategy step 3.

## Forbidden patterns

- pattern: `OVERVIEW_WITHOUT_BLOB` — reason: no new API error code; the fix is the shared-schema refine.
- pattern: `eslint-disable` (new occurrences in the diff) — reason: R36.
- pattern: `\.skip\(` (in touched test files) — reason: no disabled tests to force green.
- pattern: `keyVersion === undefined` (new occurrences in the two update routes beyond existing lines 173/218 and v1 197/239) — reason: C1 must not be reimplemented as duplicated route-level conditionals.

## Testing strategy

1. Targeted: `npx vitest run src/lib/validations src/app/api/passwords src/app/api/v1/passwords scripts/__tests__/check-destructive-wrapper-derivation.test.mjs` (single vitest invocation — the checker self-test is vitest-based per `vitest.config.ts:8-13`; `node --test` does not work).
2. Full: `npx vitest run`, then `npx next build` (mandatory per CLAUDE.md).
3. Real-DB: `npm run test:integration -- key-version-guard` (running Postgres required) — proves the blob-only integration bodies still pass through the refine.
4. Extension: run the touched extension test file (`cd extension && npx vitest run src/__tests__/background-passkey-provider.test.ts`) — extension CI is a separate job pre-pr.sh does not cover.
5. `scripts/pre-pr.sh` before push.

## Considerations & constraints

- Pre-1.0: the v1 REST tightening (overview-only PUT → 400) needs no deprecation shim.
- Scope contract:
  - SC1 — INDIRECT-binding evasion of the route pass (local-variable assignment / higher-order pass-through) stays a documented residual; closing it needs whole-program resolution the repo's AST guards deliberately avoid. Owner: future ts-morph AST-guard upgrade.
  - SC2 — Team update path: already enforced by team refine; no changes.
  - SC3 — Overview-only update capability: not added (no client derives overview independently of blob).
  - SC4 — External-report text corrections: recorded in the verification artifact; not a repo change.

## User operation scenarios

1. Web full edit → blob+overview+keyVersion → unchanged.
2. Favorite/archive toggle → metadata-only PUT → unchanged.
3. Extension passkey sign-in → blob-only counter persist PUT → unchanged (409 if a rotation raced it — extension soft-fail path already handles).
4. Stale tab / third-party v1 script PUTs overview without blob → 400 with Zod message naming `encryptedOverview`.
5. Developer adds `export { executeVaultReset } from "./vault-reset"` (any depth of barrel, incl. inside route.ts) → CI fails `REEXPORTED_DESTRUCTIVE_WRAPPER`.

## Go/No-Go Gate

| ID  | Subject                                                          | Status |
|-----|------------------------------------------------------------------|--------|
| C1  | updateE2EPasswordSchema overview-requires-blob refine (one-way)  | locked |
| C2  | checker re-export detection (transitive, ordered, route.ts incl.)| locked |
| C3  | checker header comment reinforcement                             | locked |
| C4  | schema/route/checker/extension/integration tests (RT7/RT8)       | locked |

Locked at review round 3 (2026-07-17): rounds 1-2 findings all resolved; round 3
returned one Minor documentation-count drift (fixed inline: C4 "7"→"8 fixtures")
and No findings from all three perspectives otherwise.
