# Coding Deviation Log: team-key-prune-blob-sweep-strict-aad

## Phase 2

- D1 (orchestrator decision, external review item 3) — `RETENTION_GC_BLOB_ORPHAN_GRACE_MS` has
  no schema default. A worker-schema refine requires it when `RETENTION_GC_BLOB_SWEEP_MODE=delete`;
  `report` mode falls back to `BLOB_ORPHAN_GRACE_REPORT_DEFAULT_MS` (one day) in
  `buildSweepOpts`. Reason: a default of one day in delete mode would delete objects that a DB
  restore to an older point needs. Cells: delete without grace fails, delete with grace passes,
  report without grace passes.
- D2 (C1 RDS-shape cell) — the cell observes the bypass report instead of flipping
  `rls_bypass_enforced()`: `check-bypass-rls` forbids creating routines outside migrations, so
  the test cannot redefine it. It still runs in one rolled-back superuser transaction with a
  NOSUPERUSER NOBYPASSRLS stand-in owner and FORCE RLS on the five tables, asserting no
  `rls_bypass_not_granted` under the production grant (and the referenced v2 kept) and the
  history table reported when the grant omits it (negative control); a fresh connection confirms
  report mode, the owner and the absence of the probe role.
- D3 (C1 rotation race cell) — after the rotation commits, the re-run prunes v3 (now
  non-current and unreferenced); the cell asserts v2 (referenced) and v4 (current) survive.
- D4 (C9 `--init-blob-marker` smoke) — no `worker-bundle-smoke.json` entry: that map is one entry
  per ECS task pinned to `ecs.tf` and its harness runs only `--validate-env-only`. The smoke
  check builds the real bundle with the new code (proves no top-level await in the CJS bundle),
  the MinIO integration cells spawn the entrypoint (`created`, `exists`), and store-less spawn
  cells cover the exit-1 refusals.
- D5 (C3 VE1) — Azure/GCS list fixtures are typed against the stores' narrow shapes, not
  `satisfies` against SDK types: neither SDK is installed in this repo. S3 fixtures are typed
  against `ListObjectsV2CommandOutput`.
- D6 — `BLOB_SWEEP_MODE` lives in `src/lib/blob-store/constants.ts`: the worker sweep-bounds
  scanner reads a `"delete"` literal inside a worker module as SQL; `env-schema.ts` keeps its
  own literal enum because `check-public-contract` pins its import closure. Empty optional blob
  variables are treated as unset by the worker schema (the dev `.env` has `BLOB_BACKEND=`).
  Audit metadata adds `holderUserIdsOmitted`; the function rejects `p_batch < 1` (22023).
  `app-role-denied-privileges.json` covers tables and sequences only, so no function entry.
- D7 (C5) — `openTeamEntryFieldAt` treats exactly 1 as strict, 0 as legacy, anything else
  throws (the C5 acceptance cell's "2 throws" over the approach text's "integer ≥ 1"; no AAD
  version 2 exists). `tryOpen` does not catch it, so a malformed label stops the re-key pass;
  the history view shows its decrypt-failed toast.
- D8 (C7 scope) — (c') scope root: function declaration, method, or outermost arrow/function
  expression; nested arrows (incl. variable-bound React handlers) belong to the root; nested
  function declarations are their own scope. (b') uses the nearest declared function or
  variable-bound arrow; unbound closures (the `tryOpen` callback) are skipped. Key sources
  re-derived: the plan's five plus `getEntryItemKeys`, `getTeamEncryptionKeyForVersion`,
  `resolveTeamKey`, `requireTeamKey`, `deriveTeamEncryptionKey`. The measured hit on the
  migrated tree (`entry-history-section.tsx` component scope) was fixed by moving the personal
  decrypt into `openPersonalHistoryBlob`; `TRIPWIRE_EXEMPT` is empty.
- D9 (CI parity, Step 2-1 item 7) — deferred parity gaps, pre-existing: `check-npm-audit.mjs`
  needs registry network access; `check-terraform-test-count.mjs` covers the terraform tree,
  which this change does not touch.

## Verification evidence (Phase 2)

- `npx vitest run` exit 0 (1154 files, 21581 tests); extension `npx vitest run` exit 0 (91 files,
  2761 tests); `npm run typecheck` 0; `npm run lint` 0; `npx next build` 0.
- `npm run test:integration` (dev DB + MinIO) exit 0 (147 files, 1439 tests), run by the batch W
  implementer; `audit-db-grants.mjs` on the migrated dev DB 0.
- MinIO honoured `If-None-Match: *` (second `createMarker` → `exists`, body unchanged).
- EXPLAIN ANALYZE of the prune on the dev DB: 0.514 ms execution (dev data is small; production
  scale not measured).
- Red-proofs on scratch copies / an isolated database (`tmk_redproof`, created and dropped): C1
  predicates, blob grace / marker / breaker arms / exact equality, C7 rules (each fails exactly
  its own cells), 34 T8 per-site mutants all caught.
