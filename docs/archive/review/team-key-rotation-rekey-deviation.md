# Coding Deviation Log: team-key-rotation-rekey

- D1 (C1, C6 restore) — history rows hold no overview, so a restore that switches the live
  ItemKey leaves the live overview sealed under the previous ItemKey (list view breaks; the pass
  could not open it). The restore POST now carries `encryptedOverview` re-encrypted by the client
  under the restored row's key at its AAD. Found in Step 2-1 impact analysis.
- D2 (C2 audit) — `TEAM_ENTRY_REKEY` is written with `logAuditInTx` (wraps `enqueueAuditInTx`),
  the form `check-critical-audit-atomic.mjs` recognises.
- D3 (C3 rotation audit) — audit metadata is truncated above 10 KB and a carry list can hold 1000
  entries, so each carried entry gets its own in-tx row (`logAuditBulkInTx`, target the entry,
  reason + actor) beside the summary `TEAM_KEY_ROTATION` row.
- D4 (C4 cleanup) — with fail-closed ref decoding, cleanup paths skip and log an undecodable ref
  instead of deleting a guessed key.
- D5 (scope) — the team audit-log page and watchtower unwrap with the latest team key only;
  carried entries stay at an old version, so both resolve the entry's own version (same reader
  class as C3).
- D6 (C7) — body caps live in the dependency-free `src/lib/validations/body-limits.ts`
  (re-exported from `common.ts`): Next's config transpiler does not resolve `@/` inside modules
  `next.config.ts` imports. The personal vault rotate cap (`VAULT_ROTATE_BODY_MAX`, previously an
  inline 16 MiB) moved there and is pinned by the config test too; it was already truncated by the
  10 MiB default before this change.
- D7 (C7 docs) — the ingress table in `docs/operations/deployment.md` also lists
  `/api/vault/rotate-key` and `/api/sends/file`: a low ingress default would otherwise break
  personal rotation and large Send uploads. The Send multipart envelope is pinned by the test.
- D8 (C1 PUT codes) — the plan names no code for a stale upgrade view; these return 409
  `ITEM_KEY_CHANGED`: `snapshotBlobIv` ≠ locked `blob_iv`, a new wrap for an entry already holding
  an ItemKey, and a v1 reuse PUT on an entry a restore turned back to v0 (was 400
  `ITEM_KEY_REQUIRED`). A new wrap without `snapshotBlobIv` is a 400 validation error. The old
  re-wrap-through-PUT on a team key version change is removed (C6: a wrap only for the upgrade).
- D9 (C1 PUT) — a reuse PUT whose `itemKeyVersion` differs from the locked row while the id
  matches → 409 `ITEM_KEY_VERSION_INVALID`.
- D10 (C3) — a carry's optional `teamKeyVersion`, when sent, must equal the entry's normalised
  version, else 409 `TEAM_ROTATE_CARRY_INVALID`.
- D11 (C3 limiter) — `createRateLimiter` has only `check`/`clear`; the route checks up front and
  clears its own slot (max 1) on any non-200 outcome, throws included.
- D12 (C1 restore) — the holder rule also covers v0 rows (by the row's `teamKeyVersion`); a
  team-lock timeout maps to 409 `TEAM_KEY_VERSION_MISMATCH` as in the entry service.
- D13 (A7) — the "re-key, then restore a re-keyed row" cell lands with Batch 3 (needs the re-key
  route); Batch 1 covers restoring a history row holding the live id.
- D14 (C6 member set) — re-derived by grep in Step 2-1: create, PUT/upgrade, restore, rotation,
  re-key, upload/migrate/delete; metadata writers (trash/archive/restore, bulk ops, folder delete),
  deletes (permanent, purge, empty-trash, team delete, retention GC), vault reset's
  creator-scoped attachment delete and the sign-in tenant move of attachments — the latter groups
  are covered by the re-key exact sets / CAS (count ≠ 1 → 409).
