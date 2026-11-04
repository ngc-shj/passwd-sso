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
- D30 (C3 signatures) — the React-free builders take the context the plan's two-argument form
  leaves implicit: `buildRotationEntryPayload(entry, resolveKey, ctx)` (team id, new team key and
  version, the actor's held versions from `actorKeyVersions`) and
  `buildEntryRekeyPayload(teamId, data, resolveKey)`. The v0→v1 upgrade and legacy-attachment
  migrate payloads live beside the latter (`rekey-payload.ts`); team attachment crypto shared by
  the UI and the pass is `team-attachment-crypto.ts`; key resolution types are the React-free
  `team-key-resolution.ts`, re-exported from `team-vault-core`.
- D31 (C1 reports, open) — the server names other holders only for versions the caller does not
  hold (rekey GET `holders`, `needs_rekeyer_holder`) and never names tenant-deactivated holders.
  The report model takes both as optional data: with other holders of v it names them; with an
  empty list (sole holder) it gives restore / compare-with-admin; when unknown (every live call
  site today) it lists another holder re-keying, restore and compare — never delete. The
  unrecoverable delete shows a "check whether a member who left held this key" caution instead of
  a yes/no deactivated-holder warning.
- D32 (C3 runner) — a rotation in flight and a committed one are handled alike: invalidate the
  team key cache, pause 3 s, re-read, and restart paging from the first page (a rotation re-opens
  every entry). Budgets: 5 key changes, 10 rate-limit waits, 20 steps per entry. A retry-once code
  that recurs after its one retry is skipped and reported with that code. A v1 entry with a
  missing wrap field aborts the rotation (only an AES-GCM `OperationError` is `undecryptable`).
- D33 (C5) — `getItemEncryptionKey` always re-reads the entry (a writer must send the live id)
  and serves both keys from the `(entryId, itemKeyId)` slot; a slot is valid across team key
  versions (rotation re-wraps, never replaces). `listTeamPasswords` now returns `itemKeyId`
  (side-fix) so list decryption hits the cache.
- D34 (writers) — `ENTRY_REKEY_REQUIRED` on save explains that an owner or admin finishes the
  re-key on the Key Rotation page (the submit path has no role to offer the pass inline);
  `ITEM_KEY_CHANGED` asks the user to reopen and retry (the form's edit snapshot is not
  refetched in place). An attachment upload on a v0 entry upgrades it by PUT first (history row,
  editor = uploader); a still-open edit form then holds the pre-upgrade snapshot and its save is
  refused `ITEM_KEY_CHANGED` with the same message.
- D35 (side-fix) — the team login form's password-reuse check decrypted every history row with
  the live entry's key; each row now opens with its own wrap (read from the row endpoint when its
  id differs from the live one), at its own `aadVersion`.
- D36 (C1 reports, closes D31) — `GET /api/teams/[teamId]/rekey` also returns `versionHolders`:
  for every team key version among pending entries, `{ callerHolds, activeHolderCount (caller
  included), holders: [{ id, name, email, canRekey }] (active holders other than the caller,
  re-keyers first, at most REKEY_HOLDERS_LISTED_MAX), deactivatedHolderCount }`. `holders` and
  `stateCounts` keep their meaning. The deactivated count reads `team_member_keys` and
  `team_members.deactivated_at IS NOT NULL` inside the team's RLS context (no bypass); display
  identities are hydrated as for `holders`. The rotation report reads the same list right after
  the rotation (every entry is then pending), so `rotate-key/data` is unchanged. The
  `undecryptable` / `key_invalid` exits name the other holders, the sole active holder gets
  restore / compare-with-admin, and the unrecoverable delete warns only when a version no active
  member holds has a deactivated holder (the hedged caution of D31 is removed; the unnamed exits
  remain only as the fallback when the list cannot be read).
- D37 (A8) — the E2E spec drives the two requests through a browserless Playwright request
  context (session cookie and Origin as headers): it needs no page, and a browser download is
  not a precondition of the limit. Red, run once on a production build of a scratch copy with
  `experimental.proxyClientMaxBodySize` removed from `next.config.ts`: Next logged "Request
  body exceeded 10MB … Only the first 10MB will be available" for both paths, and both answered
  **400 `INVALID_JSON`** (the re-key POST instead of 409 `REKEY_SNAPSHOT_MISMATCH`, the personal
  migrate instead of 404). With the setting: 409 and 404. Locally the spec ran on :3100 through
  a scratch Playwright config (the developer's servers held :3000 and :3001; the repo config's
  `reuseExistingServer: !CI` would otherwise have reused the :3000 one) with the CI e2e job's
  dummy production env (`SESSION_TOKEN_HMAC_KEY`, `AUDIT_ANCHOR_*`), `NEXT_PUBLIC_BASE_PATH=""`,
  an http `AUTH_URL`, and the throwaway `passwd_sso_e2e` database migrated to this branch.
- D38 (side-fix, C4 migrate) — `BASE64_RE` repeats a group per 4 characters and V8 throws
  `RangeError: Maximum call stack size exceeded` from about 6M characters, so a migrate of an
  attachment above roughly 4.5 MB answered 500 (team migrate via the schema's `.regex`,
  personal migrate via `.test`; the personal route had it on main). Found by the A8 spec.
  `isBase64()` in `validations/common.ts` checks the same grammar linearly; both migrate
  routes use it for `encryptedData`. `BASE64_RE` stays for the CEK-wrap fields (capped at
  `CEK_WRAP_BASE64_MAX`), the only other users. Red → green: a body at
  `ATTACHMENT_BODY_BASE64_MAX` in each migrate route's unit test (RangeError under the old
  check), and the `isBase64` table in `common.test.ts`.
- D39 (Step 2-5 hooks) — `check-race-vacuous-guard` flagged three zero-pending assertions in
  `team-rekey-pass.integration.test.ts` (A9, scenario 3). Not race blocks (no concurrent calls);
  each follows an exact positive assertion on a non-empty `rekeyed` list, which fails if nothing
  ran. Dismissed. Orphaned-check, hardcoded-reuse and propagation hits are vitest-run test files
  and incidental numeric literals.
- D40 (Phase 2 self-check, R39) — `TeamVaultProvider` stays mounted across vault lock and
  `clearAll()` had no production caller, so unwrapped team keys and ItemKey-derived keys outlived
  the lock. An effect now clears both caches whenever `vaultUnlocked` is false (the true→false
  edge in practice), and a generation counter — bumped by `clearAll` and `invalidateTeamKey` — is
  captured before each populate site's first await (`getTeamEncryptionKey`, the versioned team
  key resolve, `getEntryItemKeys`, which `getItemEncryptionKey` goes through); a site whose
  generation moved returns its key to the in-flight caller but does not write the cache. Red on a
  scratch copy: without the effect, the lock and both in-flight cells fail; with the effect but
  no generation check, the two in-flight cells fail. Control: a re-render that stays unlocked
  keeps both caches.
- D41 (Phase 2 self-check, R24; supersedes the CHECK in plan A10) — deploy migrates before the
  services roll, so an instance of the previous release creating or upgrading a v1 entry without
  an id hit the CHECK `team_password_entries_item_key_id_iff_item_key` (23514 → 500). The CHECK is
  removed from `20261104000000_team_key_rotation_rekey` (unreleased, so the file was edited
  rather than adding a drop migration); the backfill block says the CHECK ships in the next
  release after a backfill of such rows (follow-up). Dev DB: `ALTER TABLE team_password_entries
  DROP CONSTRAINT IF EXISTS team_password_entries_item_key_id_iff_item_key` and the recorded
  checksum re-synced (`9d22c9b4…` → `a40df35a…`, scoped by name and old checksum, precedent
  bind-stepup-to-session-credential D12); `prisma migrate status` is clean. **Any other database
  that applied the previous file needs the same two statements** (the throwaway `passwd_sso_e2e`
  of D37 was not touched):

  ```sql
  ALTER TABLE team_password_entries DROP CONSTRAINT IF EXISTS team_password_entries_item_key_id_iff_item_key;
  UPDATE _prisma_migrations SET checksum = 'a40df35a85cf67ad6cf64bac56f1d04ee6369cbbb4186ee69a27c300ff1f994f'
   WHERE migration_name = '20261104000000_team_key_rotation_rekey';
  ```

  Mixed window. What the previous release writes (read from `main`'s service): create leaves
  `item_key_id` NULL, marker 0, high-water 0; a full-update PUT carrying `encryptedItemKey` (the
  v0→v1 upgrade of its web client, or any API caller) replaces the wrap and keeps id, marker and
  high-water, writing a history row without an id. Two server rules make that tolerable:
  `isRekeyPending` (team-key-resolution.ts; Prisma form `rekeyPendingWhere`) counts a v1+ entry
  with a NULL id as pending whatever its marker — used by the list, the re-key GET/POST and the
  runner — so an upgraded entry marked current is re-keyed instead of refusing every PUT
  (`ITEM_KEY_CHANGED`, NULL never matches) until the next rotation; and `nextItemKeyVersion` =
  max(high-water, item_key_version) + 1 (entry GET, re-key GET/POST, upgrade PUT) so a created
  entry at version 1 with high-water 0 is not re-keyed into version 1 again. The pass migrates
  legacy attachments before it re-keys, and the migrate PUT compared ids with NULL never
  matching, so a NULL-id entry holding a legacy attachment could never finish: the migrate body's
  `itemKeyId` is now nullable, and a NULL locked id accepts exactly a NULL body id (any other
  pairing is `ITEM_KEY_CHANGED`), binding the CEK to no id; the re-key opens it by trial. Every
  writer of this release mints an id, so this only lets through an ItemKey change an older
  instance made between the client's read and the migrate — and the re-key's trial over the
  history wraps still opens that CEK. Restore and upload need no change (restore mints an id for
  a NULL-id v1+ row; upload refuses `ITEM_KEY_CHANGED` until the pass ran). Not detectable: the previous release replacing the wrap
  of an entry marked current while keeping its id (no web-client path does this; an API caller
  could) — the entry is not pending and its id names the new ItemKey; mode-2 CEKs still open by
  trial in the next pass. Integration (team-rekey-pass, "rollout"): a raw create (re-keyed to
  version 2, id minted), an upgrade of an entry marked current (PUT refused, pending, re-keyed,
  PUT accepted after), the same upgrade over a mode-0 attachment (migrated with NULL ids, then
  re-keyed; the attachment decrypts under the new ItemKey), and a wrap replacement on a pending
  entry with a mode-2 attachment bound to the old ItemKey (CEK opened by trial, history by its
  own wrap). Red on the scratch copy: with the previous route/runner code the create and upgrade
  cells fail (version 1 kept; pending 0); with the previous migrate route the mode-0 cell fails
  (the pass does not complete). The wrap-replacement cell passes either way (confirmation). The A10 CHECK
  cells (four 23514 SAVEPOINT inserts and the "re-adds the CHECK" assertion) cannot pass without
  the constraint and are deleted — moved to the follow-up that adds the CHECK; the A10 cell now
  asserts the block adds no CHECK and accepts a NULL-id v1 row. deployment.md describes the
  rollout state; the plan's A10 text is left as written.
- D42 (Phase 2 self-check, R3) — the entry full-update PUT (PASSWORD_UPDATE, and MEMBER only on
  an entry they created — read from the locked row's `created_by_id`), history restore
  (PASSWORD_UPDATE), attachment upload (PASSWORD_UPDATE) and attachment delete (PASSWORD_DELETE)
  re-read the actor's role with `activeTeamRole` under the team lock and answer 403
  `ACTOR_NOT_PERMITTED`, as the re-key POST does. A metadata-only PUT takes no team lock and is
  unchanged. Integration: a blocker holds the team row FOR NO KEY UPDATE, the request parks on
  its FOR SHARE (asserted in pg_locks), the blocker demotes the actor and commits → 403 for PUT
  (to MEMBER on another's entry, and to VIEWER), restore (VIEWER), upload (VIEWER), delete
  (MEMBER); each control (commit without a change) → 200/201. Unit cells in both test trees;
  red on the scratch copy for every new cell.
- D43 (Phase 2 self-check, R3/audit) — the rotation summary `TEAM_KEY_ROTATION` is written with
  `logAuditInTx` in the rotation transaction after the carry rows (it was `logAuditAsync` after
  commit), and is in `CRITICAL_ACTIONS` (gate count 19 → 20). Integration: the summary row's
  `xmin` equals the teams row's after the rotation (red with the previous route: a different
  transaction); a rotation rolled back by `ENTRY_COUNT_MISMATCH` leaves no summary row (this cell
  also holds for the previous post-commit write; the rollback after the enqueue has no fault
  point to inject without schema changes).
- D44 (Phase 2 self-check, R29) — audit-log-reference.md: `TEAM_ENTRY_REKEY` metadata key is
  `retained` (with its element shape), `TEAM_ATTACHMENT_MIGRATE` includes `toItemKeyVersion`, the
  summary row is in-tx. The four rows (TEAM_KEY_ROTATION, TEAM_KEY_ROTATION_CARRY,
  TEAM_ENTRY_REKEY, TEAM_ATTACHMENT_MIGRATE) are now held to the code: each route test compares
  its audit call's metadata keys with the doc row (`documentedMetadataKeys`); red against the
  previous doc for the re-key and migrate rows.
- D45 (Phase 2 self-check, R1) — `itemKeyIdsMatch` and `normalizeTeamKeyVersion` are defined
  only in team-key-resolution.ts (client-safe) and re-exported from team-item-key.ts; their
  tests moved to team-key-resolution.test.ts, and team-item-key.test.ts pins the re-export
  identity (red with two definitions).
- D46 (Phase 2 self-check, R2) — `ATTACHMENT_ENCRYPTION_MODE = { VAULT_KEY: 0, ITEM_KEY: 1,
  CEK_WRAPPED: 2 }` (constants/vault/attachment-encryption-mode.ts): 0 is the body under the
  owner's key (personal vault key or team key) at keyVersion, 1 the team-only legacy body under
  the ItemKey, 2 the CEK wrapped by the vault key or the ItemKey's CEK-wrap key. Used at every
  production comparison, Prisma filter/value and form field in the team and personal attachment
  routes, rotate-key-server.ts, rotate-key/data, vault-context, the attachment section and the
  team re-key modules. A behaviour-preserving rename: the only red-provable cell is the
  wire-value pin of the constant itself.
- D47 (Phase 2 self-check, R2) — the team re-key limiters have their own budgets derived from
  team quantities (TEAM_ROTATE_ENTRIES_MAX entries × MAX_ATTACHMENTS_PER_ENTRY, one retry per
  entry): migrate 21 000, re-key POST 2 000, reads 24 000 per 15 minutes. The previous shared
  6 000 / 12 000 could not cover a full team's legacy attachments. Unit: each limiter allows its
  budget and refuses budget + 1 (red against the previous values).
- D48 (Phase 2 self-check, R43) — `teamRotateKeyFailureLimiter` (rate-limiters.ts): every
  rotation attempt takes a slot per (team, user), a committed rotation clears it, 10 per 15
  minutes; refused with 429 before the rotation transaction, releasing the success-limiter slot.
  Unit (the real in-memory limiter): the 11th consecutive refused rotation → 429 without opening
  the transaction (red without the limiter); control: 9 refusals, a commit, then 10 more refusals
  all reach the route.
- D49 (Phase 2 self-check, R39) — `buildEntryRekeyPayload` registers every unwrapped raw ItemKey
  (live and history) before deriving from it, and zero-fills that list in `finally`; a derive
  that threw used to leave the raw buffer unregistered. Unit: a derive failing on the live and on
  a history ItemKey leaves every raw buffer zeroed (red before).
- D50 (Phase 2 self-check, R37) — Teams copy: "item key" / アイテムキー replaced by "encryption
  key" / 暗号化キー; the undecryptable and key-invalid issues and the holder lists say "an older
  team key" / 古いチームキー without the number (holders per version are listed without it;
  the issue already names who to ask). The version stays only in `rekeyKeySuspicion`: comparing a
  distributed copy with another holder is done for one specific version, which the member must
  name. `rekeyHoldersVersion` is renamed `rekeyOlderKeyHolders`. A copy test pins both rules
  (red before). ApiErrors `itemKeyRequired` ("ItemKey") predates the branch and is unchanged.
- D51 (Phase 2 self-check, R1) — `sha256Hex` uses `hexEncode` from crypto-utils. Behaviour
  preserved; a known-answer cell (SHA-256 of "abc") guards it — not red-provable as a refactor.
- D52 (Phase 2 self-check, R29) — the team-key-rotation-lock.ts writer list names the re-key
  POST and the attachment upload, migrate and delete (`lockTeamAttachmentEntry`). Comment only.
