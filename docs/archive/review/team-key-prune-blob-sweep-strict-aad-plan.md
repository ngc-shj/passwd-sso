# Plan: team-key-prune-blob-sweep-strict-aad

Issues: `#1009` (prune unreferenced TeamMemberKey versions), `#1010` (sweep orphaned attachment
objects), `#1012` (one strict helper for team entry crypto). All three are follow-ups to `#988`
(plan `team-key-rotation-rekey-plan.md`, SC2 / SC5 / deviations D80, D83, D84). Finding IDs in
brackets cite `team-key-prune-blob-sweep-strict-aad-review.md`.

Branch: `feat/team-key-prune-blob-sweep-strict-aad`

## Project context

- Type: web app + worker processes (Next.js 16, Prisma 7, PostgreSQL 16), a browser extension
  (`extension/`, own tsconfig and vitest suite) and an iOS app (`ios/`, Swift).
- Test infrastructure: unit + integration (real Postgres, MinIO in CI) + E2E + CI/CD, with static
  gates under `scripts/checks/`.
- Verification environment constraints:
  - VE1 No Azure / GCS account. Their list adapters are unit-tested against narrow SDK shapes
    typed with `satisfies` against the SDK types (`blocked-deferred`: an account costs more than
    the coverage of a three-call adapter, and the shapes are compiler-checked). S3 is exercised
    against MinIO locally and in CI (`ci-integration.yml` starts MinIO) — `verifiable-CI`.
  - VE2 The AWS deployment wires no `BLOB_BACKEND` into the app or worker task, so attachments
    there are DB-stored and the sweep is inert (SC3).
  - VE3 iOS builds on a separate host; the iOS golden-vector mirror for itemKeyVersion ≥ 1 is
    `verifiable-local` there (SC2).

## Objective

1. Delete a team's old `team_member_keys` versions once no row of that team can need them.
2. Delete attachment objects in the external blob store that no `attachments` row references.
3. Make "a team entry field is sealed and opened at the team entry AAD" hold by construction:
   one helper per codebase builds the AAD; legacy no-AAD access goes through separately named
   entry points called only inside the functions that need them.

## Requirements

- R1 (`#1009`) A version is pruned only when no referencing row exists and none can be created.
  Automatic in the retention GC worker once an operator enables it; batch-bounded, idempotent,
  audited per team.
- R2 (`#1010`) An object is deleted only when the bucket carries this deployment's marker, the
  tick saw at least one referenced key and passed the breaker, no row references the object's
  exact key, and the object is older than a grace period.
  Unparseable keys, other prefixes and the DB backend are never touched. Progress covers the
  whole bucket over successive ticks; memory is bounded per tick by `maxObjects` classified keys
  and at most `maxDeletes + 1` held unreferenced keys.
- R3 (`#1012`) Web team entry seal/open goes through `crypto-team.ts`, extension team entry open
  through its twin; the guard is rewritten around the helpers, keeps a known-reader floor, and is
  measured on the migrated tree.
- NFR: least-privilege DB access (no new table grants to the worker), every existing gate green
  with its self-test, no change to stored formats.

## Technical approach

### Worker integration (both sweeps) [F1, F2, S2, T1]

Both sweeps are dispatched by `sweepOnce` after the registry loop. Every tx-taking piece lives
in `sweep.ts` (the bypass-source gate derives its member set from that file and requires
`inSweepTx` / `assertSweepBypass` to stay unexported) [G2]: `sweepTeamMemberKeys(tx, …)` and
`readAttachmentRefs(tx, ids)`, each starting with `assertSweepBypass(tx, true)` and both added to
the gate's `EXPECTED_MEMBERS`. The blob sweep's own module receives `readRefs` as a closure over
`inSweepTx(workerPrisma, BYPASS_GRANT.RETENTION_BLOB_ORPHAN_SWEEP, tx => readAttachmentRefs(tx,
ids))`. Each writes its result into `counts` under a fixed key (`team_member_keys`,
`attachment_objects`, in rows / objects deleted) and the dispatcher's catch writes `-1`, so the
heartbeat's `perTable` shows them.

Configuration and state reach `sweepOnce` through `WorkerConfig` → `SweepOpts` (new fields: the
prune flag, the blob mode and options, and `blobCursor`). `createWorker` owns
`const blobCursor: { value?: string; sawReferenced: boolean } = { sawReferenced: false }` for the process lifetime [G3, R2-3]. New grants in
`tenant-rls-grants.ts`:

- `BYPASS_GRANT.RETENTION_TEAM_KEY_PRUNE` — `team_member_keys`, `teams`, `team_password_entries`,
  `team_password_entry_histories`, `attachments`, `audit_outbox`, `tenants`.
- `BYPASS_GRANT.RETENTION_BLOB_ORPHAN_SWEEP` — `attachments`.

### #1009 — prune through a SECURITY DEFINER function [S6, F3, F5, F15, S7, T13]

The worker role gets no table grant. A migration creates
`public.team_member_key_prune(p_batch integer) RETURNS TABLE(pruned_tenant_id uuid,
pruned_team_id uuid, pruned_key_version integer, pruned_user_ids uuid[])` (OUT names prefixed so
no PL/pgSQL variable shadows a column; every column reference table-qualified) [G6],
`LANGUAGE plpgsql`, `SECURITY DEFINER`, `SET search_path = public, pg_temp`,
owned by the migration role, EXECUTE revoked from PUBLIC and granted to
`passwd_retention_gc_worker` — the `audit_log_purge` precedent
(`20261021000000_definer_audit_functions_check_grant`), including its first statement:
`IF NOT rls_bypass_admits('team_member_keys') THEN RAISE … USING ERRCODE='42501'`. The body
enforces "never the current version" and "one statement". The bypass check refuses when the
bypass is off; when the bypass is on but the grant does not name the table it only reports
(`rls_bypass_not_granted` WARNING) until `#921` flips enforcement — the same report-mode arm the
audit definers have, stated in the docs [R2-4].

Body: `RETURN QUERY WITH picked AS MATERIALIZED (SELECT DISTINCT tmk.team_id, tmk.key_version …
LIMIT p_batch), del AS (DELETE FROM team_member_keys tmk USING picked … RETURNING tmk.tenant_id,
tmk.team_id, tmk.key_version, tmk.user_id) SELECT … array_agg(user_id) FROM del GROUP BY …` —
one statement. `p_batch` bounds `(team_id, key_version)` pairs; the TS sweep returns deleted rows
(sum of `array_length(pruned_user_ids)`) [G7, R2-8]. Reference predicates use the reader's normalisation (`normalizeTeamKeyVersion`:
any value `< 1` counts as 1), spelled index-friendly as `v = k OR (k = 1 AND COALESCE(v, 0) < 1)`:

- `team_password_entries.team_key_version` of team T;
- `team_password_entry_histories.team_key_version` of an entry of T;
- `attachments.key_version` of an attachment of an entry of T with `encryption_mode = 0`.

`item_key_team_key_version` (the re-key marker) is never part of the decision (policy §1).
`EXPLAIN ANALYZE` on the dev DB is recorded in Phase 2 against `WORKER_POOL_STATEMENT_TIMEOUT_MS`.

Because the DELETE is in SQL inside a migration, `check-team-rotation-input-lock.mjs` (which
scans TS `$queryRaw`/`$executeRaw` sites) does not see it; no exemption, no count bump. The
lock gate's known-limits note gains a line naming the function.

Concurrency argument [S7]. Two parts, both required:

1. No non-current reference is created from nothing: every creating writer asserts the current
   version under `teams … FOR SHARE` (`team-key-rotation-lock.ts`), and every writer of a
   non-current version copies an existing reference inside one transaction (restore copies the
   history row's; the history snapshot copies the entry's; rotation carry and re-key retention
   leave rows in place). C2 guards the column set this argument ranges over.
2. The prune is one statement, so it reads one snapshot: a reference moved between tables by a
   committed transaction is visible on one side. EvalPlanQual re-checks only locked target rows
   (`team_member_keys`). Their concurrent writers, derived by `rg -n
   'teamMemberKey\.(update|updateMany|upsert|delete|deleteMany|create|createMany)' src` (the
   rotation-input-lock gate's `memberWrites` set) [N7, G9]: deleters (`vault-reset.ts`,
   `scim-user-service.ts`, `scim-group-service.ts`, `invitations/accept`, `members` POST and
   `members/[memberId]` DELETE) only remove rows; rotation `createMany` and confirm-key `upsert`
   write the current version, which the prune never selects; team create writes version 1 of a
   new team. None can make a selected row's reference decision wrong.

Plan-stage probe (2026-11-08, dev Postgres 16 via `psql`, scratch database `probe_1009` created
and dropped; tables `teams`, `keys`, `entries`, `histories`; team at version 3, keys v1–v3, entry
at v3, history at v1). Session A: `BEGIN; UPDATE entries SET team_key_version=1; DELETE FROM
histories …; pg_sleep(3); COMMIT`. Session B, 1 s into A: the single-statement prune. Observed: B
returned `2` only; after A committed keys were `1, 3`; isolation `read committed`; B re-run
returned nothing, keys `1, 3`. This covers the restore shape at the SQL level only; the
production-path race cells (C1) are the evidence, including the negative control the probe lacks.

Kill switch [S4]: `RETENTION_GC_TEAM_KEY_PRUNE_ENABLED` (default false). The sweep does not run
until an operator enables irreversible key deletion; docs say to enable after reviewing C2's
classification.

Audit [F12, S9]: one `TEAM_MEMBER_KEY_PRUNED` row per (tenant, team) per tick, scope TEAM,
`teamId` set, SYSTEM actor, metadata `{ keyVersions: number[], rows: number, holderUserIds:
string[] }` (opaque ids, bounded to 100 with an omitted count — the evidence that replaces the
deleted rows for dispute resolution, policy §3). Grouped with `TEAM_KEY_ROTATION` in the same
tenant and team groups; webhook treatment identical to `TEAM_KEY_ROTATION`.

### #1010 — orphan-object sweep [S1, F6, F7, F8, S11, S12, T5]

`AttachmentBlobStore` gains `listObjects(prefix: string, opts: { cursor?: string; pageSize:
number }): Promise<{ objects: { key: string; lastModified: Date }[]; cursor?: string }>` (S3
`ListObjectsV2`, Azure `listBlobsFlat({prefix}).byPage({continuationToken, maxPageSize})`, GCS
`getFiles({prefix, autoPaginate:false, maxResults, pageToken})` with `metadata.updated` parsed
to `Date`). The DB backend returns `{ objects: [] }`. An empty final token (`""`) is "done".

Mode `RETENTION_GC_BLOB_SWEEP_MODE = off | report | delete` (default `off`). `report` does
everything except delete and logs the counts it would have deleted; operators run it before
`delete`. Neither mode writes anything to the bucket.

Each tick has two phases [N2, G5]. Classify, while `listed < maxObjects`:

1. List one page (`pageSize` = constant 1000, the S3 maximum; overridable in tests through opts)
   under the current prefix, no transaction open. Cursor in `blobCursor` across ticks; reset when
   a listing completes, on a list error, and on process start (stated in docs). A bucket larger
   than `maxObjects` is covered over successive ticks.
2. `parseObjectKey(key)` (inverse of `buildObjectKey`, current prefix only, generation and legacy
   forms): every id segment must be UUID syntax; the attachment id is returned lowercased.
   Anything else → `unparseable`, never deleted. `.passwd-sso-deployment` is not an object key.
3. Keep keys with `lastModified <= now - graceMs` (`now` injected).
4. `readRefs(lowercased ids)` → `readAttachmentRefs` under the asserted bypass: `SELECT id,
   encrypted_data FROM attachments WHERE id = ANY($1::uuid[])`. A key is referenced iff a row
   with that id exists and `decodeObjectRef(row.encrypted_data)?.key === key` exactly.

Decide, on the tick's cumulative counts, only when the tick has unreferenced old keys to
delete (an empty bucket or a young/unparseable-only tick completes with 0, never `-1`) [R4-1]: if
no referenced key has been seen in this tick or
earlier in the current cursor pass (`blobCursor.sawReferenced`, reset when a pass completes or
the cursor resets) — positive evidence that the database is this bucket's; an empty or foreign
database never deletes, and an all-orphan tail tick of a pass that did see references is swept
[N8, J1] — or unreferenced old keys > 20 AND >
`maxDeleteRatio` × parseable old keys, or > `RETENTION_GC_BLOB_SWEEP_MAX_DELETES` (absolute
per-tick cap), the tick deletes nothing and reports `refused: "breaker"` with counts. The cursor still advances, so an
orphan-dense stretch never wedges the sweep; it trips again on the next pass and the operator
path is documented: run `report`, inspect, raise the ratio or cap for one pass, lower it again.
A contiguous orphan block inside a mostly-referenced tick is deleted; a wrong database spread
over many small pages trips on the cumulative ratio.

Delete (mode `delete`, not refused): outside any transaction, for each unreferenced key,
`deleteObject(encodeObjectRef({ key }), contextFromParsed)` (so `validateObjectRefKey` still
holds), counting failures; never throw.

Safety rails [S1, N1, G4]:

- Ownership marker, operator-created: the store gains `readMarker(): Promise<string | null>` and
  `createMarker(body: string): Promise<"created" | "exists">` (conditional create — S3
  `IfNoneMatch: "*"`, Azure `conditions: { ifNoneMatch: "*" }`, GCS `preconditionOpts:
  { ifGenerationMatch: 0 }`; never overwrites). Marker key `${prefix}.passwd-sso-deployment` with
  `buildObjectKey`'s prefix normalisation (no leading `/` when the prefix is empty). The worker
  only reads: absent or ≠ `DEPLOYMENT_ID` → the sweep refuses (logged, `-1`), nothing deleted or
  written. The operator creates it with `node dist/retention-gc-worker.js --init-blob-marker`
  (the worker bundle, beside `--validate-env-only`; reuses the worker's env pick list and bundled
  blob store, so it runs from the deployed image) [H1]; it prints `created` or `exists` and exits. Docs: `DEPLOYMENT_ID` must be unique per deployment and changed
  when an environment is cloned; create the marker only from the deployment that owns the
  bucket. `DEPLOYMENT_ID` (already in the env schema) becomes required when the mode is not `off`.
- RLS: the read runs under `assertSweepBypass`; a missing bypass throws instead of returning no
  rows.

Monotonicity: the four writers of `attachments.encrypted_data` each put a fresh
`newBlobGeneration()` (C3 member-set), so an unreferenced key older than the grace period is
never referenced again. Database restore is the exception: restoring the DB to a point older
than the grace period resurrects rows whose objects may be gone. Docs require one of: `graceMs >=`
the backup retention window (max raised to 35 days to cover RDS), or bucket versioning with
noncurrent-version retention ≥ the backup window so a deleted generation can be recovered. As a
separate post-restore step, set the mode to `off` until the restored rows are reconciled [S10, N3].

Logging [S11]: counts only; errors logged as `{ name, httpStatusCode }`, never `message` (S3
error messages embed the key).

### #1012 — strict helpers [F9, F10, F11, S3, S8, T7]

Web, `src/lib/crypto/crypto-team.ts`:

```ts
export interface TeamEntryAadContext { teamId: string; entryId: string; vaultType: VaultType; itemKeyVersion: number }
export function sealTeamEntryField(plaintext: string, key: CryptoKey, ctx: TeamEntryAadContext): Promise<EncryptedData>
export function openTeamEntryField(enc: EncryptedData, key: CryptoKey, ctx: TeamEntryAadContext): Promise<string>
// legacy, confined (C6)
export function openTeamEntryFieldAt(enc: EncryptedData, key: CryptoKey, ctx: TeamEntryAadContext, aadVersion: unknown): Promise<string>
export function openLegacyTeamEntryField(enc: EncryptedData, key: CryptoKey): Promise<string>
export function sealLegacyTeamEntryField(plaintext: string, key: CryptoKey): Promise<EncryptedData>
```

- `ctx` is required on every strict entry point; no parameter in a team module is typed
  `TeamEntryAadContext | undefined | null`.
- `openTeamEntryFieldAt` replaces `teamEntryAadFor` (removed from `team-key-resolution.ts`):
  `aadVersion === 0` → legacy; `>= 1` integer → strict; anything else throws.
- `buildTeamEntryAAD` loses its parameter defaults (web and extension).
- `encryptTeamEntry` / `decryptTeamEntry` (optional-AAD pass-throughs) are removed.
- `buildEncryptedEntryBody` takes `seal: (plaintext: string, vaultType: VaultType) =>
  Promise<EncryptedData>`; team save passes a closure over `sealTeamEntryField`, personal save
  over its personal sealer. Its AAD parameters are removed [F11].
- `rekey-payload.ts`'s `tryDecrypt(enc, key, aad)` becomes `tryOpen(open: () => Promise<string>)`,
  catching only AES-GCM authentication failures; each legacy call is lexically inside an allowed
  function [F10, S8].

Extension, `extension/src/lib/crypto-team.ts`: `openTeamEntryField` twin (the extension never
seals team entries), mirror comments both ways.

## Contracts

### C1 — team key prune

- SQL: `team_member_key_prune(p_batch integer)` as above (migration; owner, search_path, EXECUTE
  grant, bypass check, PUBLIC revoke). TS: `sweepTeamMemberKeys(tx: Prisma.TransactionClient,
  batchSize: number, emit: EmitFn): Promise<number>` calling it via `$queryRaw` and emitting one
  audit row per returned team in the same transaction.
- Invariants: I1.1 (schema-enforced by the function body) a referenced version and the current
  version are never deleted. I1.2 (app-enforced, C2) no non-current reference is created from
  nothing.
- Member-set (R42): columns naming a team key version — derivation `rg -n -i 'version' 
  prisma/schema.prisma` classified by C2; current classification: references
  `TeamPasswordEntry.teamKeyVersion`, `TeamPasswordEntryHistory.teamKeyVersion`,
  `Attachment.keyVersion` (mode 0); current `Team.teamKeyVersion`; self
  `TeamMemberKey.keyVersion`; excluded `TeamPasswordEntry.itemKeyTeamKeyVersion` (marker) and
  every ItemKey / personal / master-key / wrap / aad version.
- Control class: enforceable boundary (adjudication: PostgreSQL, one statement, one snapshot,
  definer body). Kill switch default off.
- Grants: EXECUTE on the function only; no table grant. Manifest (`db-grants-manifest.json`),
  `bootstrap-rds-roles.mjs` and `audit-db-grants.mjs` regenerated.
- Forbidden patterns:
  - `pattern: item_key_team_key_version` in the function body — reason: keyed on the marker.
  - `pattern: teamMemberKey\.(delete|deleteMany)` in `src/workers/` — reason: the prune is the
    definer function.
- Acceptance (integration, driving `sweepOnce` with the flag on, on the worker role connection
  — `inSweepTx` is module-private, so no test twin of it [R2-6] — asserted by row id never by
  count [T1, T3]): kept when referenced only
  by (a) an entry, (b) an entry at version 0 for k = 1, (c) a history row, (d) a mode-0
  attachment at k, (e) a mode-0 attachment with NULL and (e') with 0 for k = 1; (f) a mode-1/2
  attachment's `key_version` does NOT keep k; (g) the current version kept with no references;
  (h) the marker alone does not keep k; (i) bound: own team, one member, seeded with N > batch
  eligible pairs, the function returns exactly `batch` pairs and ≥ N − batch remain; (j) audit
  row per team with `keyVersions` and `holderUserIds`, filtered by teamId. Each cell has a
  positive control: an unreferenced old version of the same team that IS pruned, the sweep
  looped until it returns 0, asserting `counts.team_member_keys !== -1` each iteration and
  failing after a fixed iteration cap [R3-3].
- Definer cells (mirroring `definer-audit-functions-grant.integration.test.ts`, calling the
  function directly as the worker role) [R2-4, G1]: bypass off → 42501; grant naming
  `team_member_keys` → runs, no notice; grant naming another table → runs and reports
  (`expectBypassNotices`) — the report-mode arm; `passwd_app` and PUBLIC → EXECUTE denied
  (and an `app-role-denied-privileges.json` entry if that policy covers functions). RDS shape
  [N4]: one cell with the function owned by a NOSUPERUSER NOBYPASSRLS stand-in role under FORCE
  RLS, enforce mode on, proving the body sees rows through the caller's bypass and that the
  grant's table list covers every table the body reads. The whole cell runs in one superuser
  `pg` transaction that always ends in `ROLLBACK` (owner change, FORCE RLS, the
  `rls_bypass_enforced()` redefinition, then `SET LOCAL ROLE` to call), after the
  `retire-dcr-cleanup-worker.integration.test.ts` precedent; a final fresh-connection assertion
  checks `rls_bypass_enforced()` is false and the owner unchanged [R3-1].
- Flag cell (l): unit — flag off, the fake tx never sees `team_member_key_prune`; flag on, it
  does (positive control).
- Race cells [T2, S7, R2-1]: production `sweepOnce` (flag on) on connection B, writer on
  connection A — a Prisma interactive transaction with an explicit `timeout` well above the
  cell's hold, which records its `pg_backend_pid()`; ordered by deferred promises. Before
  releasing A, a third connection asserts that pid is `idle in transaction`; B's result includes
  the positive control and k survives. Release A, await A's promise and assert it resolved, then
  assert the post-commit state by id (restore: entry at k, history row gone; snapshot: entry at
  current, history at k; rotation: team bumped, new version rows), re-run B, k still survives.
  Shapes: restore (entry ← k, history row deleted); snapshot (entry → current, history inserted
  at k); rotation committing between.
- Harness: A, B and the observer use `src/__tests__/db-integration/race-helpers.ts` (held
  transaction with pid, rollback on failure), extended with a held-writer helper rather than a
  parallel harness [R3-4].
- Negative control [R2-2]: run as the superuser connection (the worker role has no table
  grants), a test-local two-statement check-then-delete whose statements
  straddle A's commit — restore shape: statement 1 checks entries while A is open, release and
  await A, statement 2 checks histories and deletes → k deleted; snapshot shape: histories first,
  entries after the commit → k deleted. Proves the harness observes a loss.
- Red-proofs: removing the history predicate fails the restore cell; removing the entry predicate
  fails the snapshot cell; the rotation cell fails when the `key_version < team_key_version`
  clause is removed.
- Note (RT11): local runs prune unreferenced keys in the developer's dev DB when the flag is on
  for the test; cells set it explicitly and only call through the test's own data where they
  assert.

### C2 — key-version column classification gate

- `scripts/checks/check-team-key-version-refs.mjs`: parses `prisma/schema.prisma` with the same
  parser the existing schema gates use (decided in Phase 2 by reading them; must expose `@map`),
  lists every `Int`/`Int?` field on EVERY model whose field name or `@map` column matches
  `/version/i`, and requires each `(model, field)` pair to be classified in the gate's table as
  `reference`, `current`, `self`, or `excluded` with a reason. Unclassified → fail [S4, T11, F16].
  A `reference` pair must appear as `<alias>.<column>` with the alias bound to that pair's table
  in the LATEST migration that `CREATE [OR REPLACE] FUNCTION … team_member_key_prune` [N5, R2-9,
  G9]; an integration cell additionally asserts `pg_get_functiondef('team_member_key_prune'::regproc)`
  names each reference column on the live DB.
- Control class: fail-closed verification gate over the schema.
- Acceptance: self-tests — new model with `teamKeyVersion` fails; new field on a known model
  (`TeamPasswordEntry.previousTeamKeyVersion`) fails; a differently named field with
  `@map("team_key_version")` fails; a `reference` pair the function SQL does not name fails; a
  later migration redefining the function without one reference predicate fails; real schema
  green; each with its conformant control.

### C3 — `listObjects` and `parseObjectKey`

- Signatures as in the approach. Each backend extends its narrow SDK shape with `satisfies`
  against the SDK type [T6] and `check-bypass-rls`'s EXTERNAL_SHAPE_ALLOWLIST where it keys on
  shape names.
- `parseObjectKey(key: string): { scope: "team" | "personal"; teamId?: string; entryId: string;
  attachmentId: string; generation?: string } | null` — current prefix only; UUID-syntax ids;
  attachment id lowercased [F6].
- Member-set (R42) of writers of `attachments.encrypted_data`: `rg -n 'encryptedData' src
  scripts cli --glob '!**/*.test.ts'` filtered to attachment create/update → personal upload,
  team upload, team migrate, personal migrate (`rotate-key-server.ts`); each puts
  `newBlobGeneration()`. No path assigns an existing ref.
- Acceptance: `parseObjectKey ∘ buildObjectKey` round-trip (both scopes, generation and legacy),
  and agreement with `validateObjectRefKey`; uppercase attachment id → lowercased; non-UUID
  segment → null; other prefix → null; marker key → null. Per backend: empty page, multi-page,
  final token `""` vs undefined, GCS string → Date. DB backend → `{ objects: [] }`. Marker per
  backend: absent → null; present → body; `createMarker` on existing → `"exists"` without
  overwrite; empty prefix → key without leading `/`.

### C4 — `sweepOrphanBlobs`

- `sweepOrphanBlobs(deps: { readRefs: (ids: string[]) => Promise<{ id: string; encryptedData:
  Uint8Array }[]>; store: AttachmentBlobStore; now: () => Date; log: Logger }, opts: { mode:
  "report" | "delete"; graceMs: number; maxObjects: number; maxDeletes: number; pageSize: number;
  maxDeleteRatio: number; deploymentId: string }, cursor: { value?: string; sawReferenced: boolean }): Promise<{ listed;
  unparseable; young; referenced; deleted; wouldDelete; deleteFailed; refused?: "marker_missing"
  | "marker_mismatch" | "breaker" }>`; `sweepOnce` calls it when mode ≠ off and the backend is
  external, passing `opts.blobCursor` from `createWorker`. `counts.attachment_objects` records
  `deleted` on a completed tick (0 in report mode), and `-1` on any refusal (marker missing or
  mismatched, breaker) and on error, so the existing entry-failed monitoring sees refusals [H2].
- Invariants: I4.1 an object whose exact key a row's ref names is never deleted; I4.2 younger
  than grace → never deleted; I4.3 unparseable, other prefix, DB backend, marker missing or
  mismatched, breaker tripped → nothing deleted; I4.4 no key, ref or error message reaches a log
  or audit row.
- Control class: enforceable boundary within the worker for I4.1–I4.3 (adjudication: the row read
  under asserted bypass, the store's `lastModified`, `parseObjectKey`, the marker object). The
  monotonicity it relies on is C3's member-set (review gate).
- Env (`env-schema.ts`, worker pick list, `.env.example`, sidecar descriptions, allowlist,
  `check-env-docs`, docker-compose, worker docs): `RETENTION_GC_BLOB_SWEEP_MODE` (enum, default
  `off`), `RETENTION_GC_BLOB_ORPHAN_GRACE_MS` (int, default 86 400 000, min 3 600 000, max
  3 024 000 000), `RETENTION_GC_BLOB_SWEEP_MAX_OBJECTS` (int, default 10 000, min 100, max
  1 000 000), `RETENTION_GC_BLOB_SWEEP_MAX_DELETES` (int, default 1 000, min 1, max 100 000),
  `RETENTION_GC_BLOB_SWEEP_MAX_DELETE_RATIO` (number, default 0.5, (0, 1]),
  `RETENTION_GC_TEAM_KEY_PRUNE_ENABLED` (bool, default false), and to the pick list
  `DEPLOYMENT_ID`, `BLOB_BACKEND`, `BLOB_OBJECT_PREFIX`, `AWS_REGION`, `S3_ATTACHMENTS_BUCKET`,
  `S3_FORCE_PATH_STYLE`, `AZURE_STORAGE_ACCOUNT`, `AZURE_BLOB_CONTAINER`,
  `AZURE_STORAGE_CONNECTION_STRING`, `AZURE_STORAGE_SAS_TOKEN`, `GCS_ATTACHMENTS_BUCKET` where
  they are in the schema (the pick list validates; blob-store code reads `process.env` directly,
  which is why the trash purge works under compose today) [F14]. A refine: mode ≠ off requires
  `DEPLOYMENT_ID`.
- Forbidden patterns:
  - `pattern: \.startsWith\(` applied to a decoded ref in the sweep — reason: exact equality.
  - `pattern: err(or)?\.message` in `sweep-blob-orphans.ts` — reason: I4.4.
- Acceptance, unit (fake store + real decision code): referenced kept; young kept at
  `now = put + grace − 1 ms`, deleted at `+ 1 ms` [T5]; unparseable kept and counted; old
  generation of a live attachment deleted, new kept; row gone → deleted; report mode deletes
  nothing, writes nothing, counts `wouldDelete`; marker absent → refused, nothing written or
  deleted; marker mismatch → refused; marker matching → deletes (allow side); breaker [R2-7]:
  20 unreferenced at ratio 1.0 with one referenced → not tripped, an empty database with ≤ 20
  old keys (no referenced key) → tripped, an all-orphan tail tick after a tick that saw a
  reference in the same pass → deleted, the same tail at the start of a new pass → tripped,
  an empty bucket and a young/unparseable-only tick → not refused, 0, 21 above the ratio → tripped, 21 at exactly the
  ratio → not tripped, over `maxDeletes` → tripped, a wrong database spread over many small
  pages → tripped on cumulative counts, a contiguous orphan block in a mostly-referenced tick →
  deleted, a tripped tick still advances the cursor and the next tick processes later keys;
  bypass off → throws; delete failure counted, not thrown; no logger argument contains any
  listed key string. Through `sweepOnce` [R2-3]: two or more consecutive calls with the same
  opts object cover a bucket of 3 × maxObjects; an exported `buildSweepOpts(workerEnv)` in
  `scripts/retention-gc-worker.ts`'s import graph (called by the entrypoint to fill
  `WorkerConfig`) maps each env value into opts (cell per variable). Integration (MinIO,
  mandatory, `ENDPOINT_ENV` pattern, dedicated bucket asserted ≠ `S3_ATTACHMENTS_BUCKET`, cleaned
  in `afterAll`) [T4]: real pagination with small `pageSize`, objects across pages, `maxObjects`
  cut mid-page, `now` derived from each object's listed `LastModified` ± 1 ms (1 s server
  granularity and container clock) [R2-5], real attachment rows under the worker role, real
  conditional `createMarker`: create, then create again with a different body → `"exists"` and
  the original body still stored [R3-5].
- `sweepOnce` outcome cells [R4-2]: `marker_missing`, `marker_mismatch`, `breaker` → each
  `counts.attachment_objects === -1`; report mode → 0; a completed delete tick → the deleted count.
- `createWorker` cell [R3-2]: `sweepOnce` mocked, two or more loop iterations under a short
  interval and an abort signal; every call receives the identical `blobCursor` reference
  (`toBe`), and a value set in tick 1 is seen in tick 2.

### C5 — strict team entry helpers

- Signatures and API changes as in the approach.
- Member-set (R42) of seal/open sites: `rg -ln 'buildTeamEntryAAD|teamEntryAadFor|encryptTeamEntry|decryptTeamEntry' src extension/src --glob '!**/*.test.*' --glob '!**/__tests__/**'`
  at HEAD 91f29cd8c → `src/app/[locale]/admin/teams/[teamId]/audit-logs/page.tsx`,
  `src/components/passwords/entry/entry-history-section.tsx`,
  `src/components/passwords/import/password-import-importer.ts`,
  `src/components/team/management/team-edit-dialog-loader.tsx`,
  `src/components/team/management/team-export.tsx`, `src/hooks/team/use-team-login-form-state.ts`,
  `src/hooks/use-watchtower.ts`, `src/lib/team/rekey-payload.ts`, `src/lib/team/rotation-payload.ts`,
  `src/lib/team/team-entry-save.ts`, `src/lib/team/team-history-restore.ts`,
  `src/lib/team/team-key-resolution.ts`, `src/lib/vault/build-team-get-detail.ts`,
  `src/lib/vault/team-vault-list-adapter.ts`, plus `crypto-aad.ts`, `crypto-team.ts`, and
  `extension/src/background/index.ts`, `extension/src/lib/crypto-team.ts`. After migration the
  same command returns only the two helper modules and `crypto-aad.ts` (plus the extension's
  builder module). Test helpers (`src/__tests__/helpers/team-key-fixtures.ts`) may call the
  builder; the guard's `isTestPath` exempts tests and test helpers.
- Invariants: I5.1 (gate C7) the builder is referenced only by the helper modules; I5.2 every web
  team seal binds the AAD (no `encryptData` call with a team key outside `crypto-team.ts`).
- Control class: I5.1 fail-closed gate (Program reference resolution). "Every team seal/open
  uses the helper" is a best-effort tripwire (C7 (c')), key provenance being undecidable (D80);
  known bypass: a function that receives a team key as a plain parameter and calls a raw
  primitive; recovery: the floor (C7 (d')), the per-reader tests (T8 cells) and review.
- Forbidden patterns (non-test paths):
  - `pattern: buildTeamEntryAAD\(` outside the builder and helper modules — reason: I5.1.
  - `pattern: export (async )?function (encryptTeamEntry|decryptTeamEntry|teamEntryAadFor)\b` — reason: removed.
  - `pattern: TeamEntryAadContext \| (undefined|null)` — reason: no optional ctx.
- Acceptance: helper unit tests (round-trip; each ctx field changed alone fails to open; legacy
  opener opens no-AAD and fails on AAD ciphertext; `openTeamEntryFieldAt` 0 → legacy, 1 →
  strict, 2 / undefined / NaN / "1" → throws; `sealLegacyTeamEntryField` output opens only
  without AAD) [T10]. Per migrated site, a cell that fails on (a) blob/overview swapped and (b)
  a wrong itemKeyVersion, red-proved on a scratch copy; mocks of `@/lib/crypto/crypto-team`
  switch to the `importOriginal` spread so real helpers run [T8]. Golden vectors: a fixed
  key/IV ciphertext at itemKeyVersion ≥ 1 for blob and overview, opened by the web helper and
  the extension twin, failing on any single ctx change; web seal → extension open round-trip;
  iOS mirror in `ios/PasswdSSOTests/AADParityTests.swift` [T9].

### C6 — legacy confinement

- `openTeamEntryFieldAt`, `openLegacyTeamEntryField` may be CALLED (not referenced as values)
  only directly inside: `reencryptV0` (rotation-payload), `buildEntryRekeyPayload`,
  `buildEntryUpgradePayload`, `resealLegacyHistoryRow` (rekey-payload), `handleView`
  (entry-history-section; an arrow `const` — identified by its variable declaration).
  `sealLegacyTeamEntryField` only inside `resealLegacyHistoryRow`. Inside `tryOpen(() => …)`
  closures the enclosing declared function is the one that counts.
- Control class: fail-closed gate (Program resolution of the callee symbol and of the enclosing
  declaration, not name spelling).

### C7 — rewritten strictness guard

- (a') builder confinement (I5.1) over non-test paths, by symbol: alias import, renamed
  re-export, `export *` namespace access, element access.
- (b') C6.
- (c') function-scoped tripwire [N6, G8]: the scope is a declared function (or a variable-bound
  arrow) including the arrow and function expressions nested in it; nested function
  declarations are their own scope. `password-import-importer.ts`'s chunk loop is split into a
  team branch function and a personal branch function. A scope that calls a team key source
  (`getEntryDecryptionKey`, `getItemEncryptionKey`, `getTeamEncryptionKey` (web and the
  extension's local function), `unwrapItemKey`, `deriveItemEncryptionKey` — exact list
  re-derived in Phase 2 by `rg` over the key-resolution modules and recorded) and a raw
  primitive (`encryptData`, `decryptData`, web and extension) fails, outside `crypto-team.ts`.
  Applies to `extension/src`. Measured on the migrated tree before locking; any exemption is
  listed with the reason and the header says (c') is blind there [T7, F9, S3].
- (d') floor: every module in `KNOWN_TEAM_READERS` (today's ten, the extension background
  included, plus `team-entry-save.ts` and `password-import-importer.ts` as writers) calls
  `openTeamEntryField` / `sealTeamEntryField` (or the legacy entry points where C6 allows),
  resolved through the Program.
- Unresolved import fails loudly. Header states what each rule proves. Fixture: key source in
  the outer function, `decryptData` in a `.map` callback → fails.
- Acceptance: per rule a violating and a conformant fixture, exact `toEqual` over outcomes;
  mutation red-proof on a scratch copy — removing each rule fails exactly its own cells.

### C8 — docs and generated artifacts

- `docs/security/key-retention-policy.md` §1 (automatic prune, kill switch, single statement,
  references), §3 corrected to the code (removal deletes the member's TeamMemberKey rows) with
  the replacement evidence (`TEAM_MEMBER_KEY_PRUNED.holderUserIds`, confirm-key and rotation
  events), summary table, §4 (the sweep, grace ≥ backup retention, versioned buckets, prefixes).
- `docs/architecture/retention-gc-worker.md`; `docs/security/deletion-retention-matrix.md` via
  `scripts/generate-security-matrices.ts` (team_member_keys → worker-pruned).
- `docs/operations/audit-log-reference.md`; env docs.

### C9 — worker manifests, gates, and enumerations [F4, F12, T12]

- `worker-policy-manifest.json` (`retentionPolicyTouched` + `team_member_keys`,
  `attachments` objects note; `modules` + new files).
- Raw-SQL allowlist / `raw-sql-usage.txt` for new `$queryRaw` sites.
- `sweep-bypass-source.test.ts`, `sweep-bypass-assert.test.ts`, `sweep-dispatch-bypass.test.ts`
  (fake tx answers the new calls; `BLOB_BACKEND` stubbed), `index.test.ts`,
  `retention-gc-worker-env.test.mjs` (pick list and bounds).
- Audit: `AuditAction` enum migration, `AUDIT_ACTION`, `AUDIT_ACTION_VALUES`, groups,
  `messages/{en,ja}/AuditLog.json`, coverage tests, webhook groups/suppress as for
  `TEAM_KEY_ROTATION`.
- `check-bypass-rls.mjs` allowed usage for the two grants.
- SECURITY DEFINER inventory [G1]: `scripts/rls-cross-tenant-verify.sql` `[E-RLS-SECDEF]`
  allowlist gains `team_member_key_prune` with its safety argument (EXECUTE only to the worker
  role, bypass check first, fixed SQL); `src/__tests__/workers/worker-policy-manifest.test.ts`
  `SECURITY_DEFINER_FUNCTION_NAMES` and its source-migration note.
- `sweep-bypass-source.test.ts` `EXPECTED_MEMBERS` gains `sweepTeamMemberKeys` and
  `readAttachmentRefs`.
- `--init-blob-marker` flag in `scripts/retention-gc-worker.ts`; `scripts/checks/worker-bundle-smoke.json`
  entry; ops doc for it. Cells [R4-3]: in the mandatory MinIO block, spawning the entrypoint
  with `ENDPOINT_ENV` — absent → `created`; present → `exists`, body unchanged. Store-less spawn
  cells — mode `off`, `DEPLOYMENT_ID` missing, `BLOB_BACKEND` db or unset → exit 1 without
  writing.

## Testing strategy

- Unit: helpers, guard fixtures, parse/list, sweep decision, env bounds, C2 self-tests, dispatch.
- Integration (real Postgres + MinIO; stop compose workers first): C1 cells and race cells, C4
  MinIO cells, `audit-db-grants.mjs` on the migrated dev DB.
- Mutation red-proofs on a scratch copy (no `.env`): each C1 predicate; grace check; exact
  equality → prefix; marker check; breaker; each C7 rule; each T8 per-site cell.
- `npx vitest run`, `cd extension && npx vitest run`, `npx next build`, `scripts/pre-pr.sh`.

## Considerations & constraints

### Scope contract

- SC1 `#1011` (item_key_id CHECK) — needs a release after `#988` ships; own PR.
- SC2 iOS: no code change (already strict); golden-vector mirror run on the iOS host.
- SC3 Terraform: wiring `BLOB_*` into the app and worker tasks and `s3:ListBucket` for the worker
  is a deployment backend switch on DB-stored data; filed as a follow-up issue. The follow-up also
  scopes the worker's PutObject to `${prefix}.passwd-sso-deployment` only (the worker otherwise
  needs read, list and delete); the ops doc says to run `--init-blob-marker` with operator
  credentials where the worker identity has no write [N9]. Ops docs state
  that the worker must receive the same `BLOB_*` values as the app (the trash purge already
  depends on it).
- SC4 Departed-member key rows beyond the version rule — removal already deletes them.
- SC5 Objects under a previous `BLOB_OBJECT_PREFIX` — never listed, never swept; documented.

### Risks

- Irreversible deletion (C1, C4): definer function, kill switch / report mode, C2, marker,
  breaker, race cells with a negative control.
- Guard rewrite dropping coverage (C7): floor kept, (c') measured, mutation table.

## User operation scenarios

1. A team rotates twice; after the re-key pass and history trim, v1 has no references; with the
   flag on, the next tick deletes every member's v1 row and writes one team-scope audit row.
2. A restore runs while the worker prunes: the version survives (race cell).
3. An attachment migrate crashes after commit; in `delete` mode, once the grace period passes,
   the sweep reaches the old generation (possibly over several ticks) and deletes it.
4. An upload in flight: its object is young and has no row; kept.
5. A staging deployment is pointed at the production bucket: the production operator created
   the marker, so staging's differs; or no marker exists: staging refuses either way. Nothing is
   deleted.
6. The worker's DB URL names an empty database: the breaker trips; nothing is deleted.
7. A developer adds a team reader calling `decryptData` with `getEntryDecryptionKey` in one
   function: (c') fails; if they call the builder: (a') fails.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | team key prune (definer function, sweep, audit, race cells) | locked |
| C2 | key-version column classification gate | locked |
| C3 | listObjects + parseObjectKey | locked |
| C4 | sweepOrphanBlobs with marker, breaker, report mode, cursor | locked |
| C5 | strict team entry helpers (web + extension) | locked |
| C6 | legacy entry-point confinement | locked |
| C7 | rewritten strictness guard | locked |
| C8 | docs and generated artifacts | locked |
| C9 | worker manifests, gates, enumerations | locked |
