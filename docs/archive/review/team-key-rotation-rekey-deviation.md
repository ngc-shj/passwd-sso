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
- D15 (C4 cleanup, D4 follow-on) — `collectAttachmentRefsByCreator` records the team id of team
  attachments so their refs validate; this reads `teamPasswordEntry.teamId` inside vault reset's
  existing bypass transaction, so `VAULT_RESET_EXECUTE` gains `teamPasswordEntry` (read of the
  target's own attachments' entries only). Without it every team attachment object would be
  skipped and orphaned on external backends.
- D16 (C4 upload) — refusal order: `ENTRY_UPGRADE_REQUIRED` → `ITEM_KEY_CHANGED` →
  `CEK_KEY_VERSION_MISMATCH` → attachment cap (advisory lock still before the count). The team
  upload requires the client attachment id (bound into both AADs); missing → 400.
- D17 (C4) — a rotation lock-wait timeout in upload, migrate and delete maps to 409
  `TEAM_KEY_VERSION_MISMATCH` (as D12).
- D18 (C4 migrate) — the stored body is read and hashed before the transaction (no storage I/O
  in transactions in this codebase); under the locks the route re-checks that the row still holds
  the same ref, iv and authTag (else `MIGRATE_CAS_FAILED`). The role re-check runs after all three
  locks. The migrated row's `keyVersion` = locked team key version.
- D19 (C4 personal migrate) — CAS failure → 409 `MIGRATE_CAS_FAILED`; `applyAttachmentMigration`
  now scopes by the route's entry id (it ignored it before — side-fix); personal DELETE takes the
  per-user advisory lock upload and migrate take.
- D20 (C4 GET) — mode 2 with several history rows holding the ItemKey returns the one at the
  highest team key version, then the latest; mode 1 returns the entry wrap first, then every v1+
  history wrap. `ITEM_KEY_REQUIRED` is no longer emitted (code kept registered).
- D21 (C4 crypto) — `TW` manifest/golden vector set to the post-PR truth (`crossCodebase`, iOS);
  the iOS builder and parity test were added in this batch, verified on the macOS host in Batch 5.
- D22 (C8 fixture) — the committed fixture JSON is extended, not regenerated: the generator now
  loads the committed base and appends deterministic v2 / `TW` vectors (seeded from labelled
  SHA-256), so existing vectors stay byte-identical; `--fresh` regenerates everything. The
  extension's `unwrapTeamAttachmentCek` takes hex `EncryptedData` like its other unwraps.
- D23 (C2 POST) — `REKEY_NOT_PENDING`, `ENTRY_UPGRADE_REQUIRED` and `REKEY_ATTACHMENTS_UNMIGRATED`
  are refused before the body is read and re-checked under the locks. A v0 entry gets 409
  `ENTRY_UPGRADE_REQUIRED` (not in C2's list) instead of falling into `REKEY_SNAPSHOT_MISMATCH`,
  which the runner would retry; the runner table already maps it to "upgrade, retry".
- D24 (C2 order) — inside the transaction: history exact set → `REKEY_ATTACHMENTS_UNMIGRATED` →
  attachment exact set; a legacy attachment has no CEK to re-wrap, so checking the set first would
  turn every unmigrated case into a set mismatch.
- D25 (C2 list) — `retainedHistoryCount` = the team's history rows whose `item_key_id IS DISTINCT
  FROM` their entry's (no team-key-version clause; one would count every re-keyed row after the
  next rotation). The list also returns `holders` (≤ 10 per version) for "needs re-keyer holder";
  state names `ready` / `needs_rekeyer_holder` / `holder_cannot_rekey` / `unrecoverable`.
- D26 (C2 body/response) — one top-level `aadVersion` (= current) for the entry and every
  re-keyed history row; attachment rewraps set `cekWrapAadVersion` to current. Response
  `{ success, itemKeyVersion }`; the client re-GETs.
- D27 (C2 post-check) — `assertEntryRekeyConsistent` additionally requires marker = team key
  version, high-water = item key version and every retained id to exist; its error carries a token
  code (no free text, per `check-caught-error-logging`). The 500 mapping is unit-tested only.
- D28 (C2 tx) — 15 s transaction timeout; only the team lock uses the bounded wait. The entry
  write bumps `updatedAt` (as rotation does), `updatedById` unchanged. High-water read from the
  locked column, as in the PUT.
- D29 (test hygiene) — `object-ref.test.ts` assigned `process.env` directly (pre-existing on
  main; the file changed in this branch, so the gate scans it) — moved to `vi.stubEnv`; the MinIO
  block of `team-attachment-rekey.integration.test.ts` stubs per test and passes explicit S3
  credentials to its own client.
