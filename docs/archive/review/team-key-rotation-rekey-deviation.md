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
  history wraps still opens that CEK. This release's restore and upload need no change (restore
  mints an id for a NULL-id v1+ row; upload refuses `ITEM_KEY_CHANGED` until the pass ran).
  **Corrected in round 1 (F5):** the previous release's *history restore* is a second writer this
  analysis missed — it writes back the row's wrap and itemKeyVersion but keeps the entry's
  `item_key_id`, marker and high-water (and its overview), so the entry names an ItemKey it no
  longer holds and is not pending; nothing in this release detects or repairs it. deployment.md
  now states the mitigation as a rollout requirement (drain previous-release instances before
  team traffic reaches the migrated database, or no team edits/restores during the rollout; the
  rollout window's `ENTRY_HISTORY_RESTORE` audit rows name the entries to check). Not detectable: the previous release replacing the wrap
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
- D53 (round 1 S1, R42 writer member set) — the team attachment upload refuses 409
  `ENTRY_REKEY_REQUIRED` when the locked entry's normalised team key version differs from the
  team's, after `ITEM_KEY_CHANGED` and `CEK_KEY_VERSION_MISMATCH` (the full-update PUT's order):
  a restored retained row or a carried entry holds an ItemKey wrapped under an older team key,
  and a CEK wrapped under it is readable by a departed holder of that key. `lockTeamAttachmentEntry`
  returns the entry's `team_key_version` (and `created_by_id`, D54); migrate stays exempt (it
  is part of the pass). The upload form maps the code to the save path's message (an owner or
  admin finishes the re-key on the Key Rotation page; `Attachments.uploadRekeyRequired`).
  Integration (AR "upload after a restore"): restore of a row at team key version 1 on a team at
  2 → upload 409, nothing stored; control: a row at version 2 → 201. Unit cells in both upload
  trees (incl. the version-0 normalisation control); red on the scratch copy for each.
- D54 (round 1 S2, user decision 2026-11-04: own entries only) — `canWriteTeamEntry(role,
  createdById, userId)` (team-auth.ts): PASSWORD_UPDATE, and a MEMBER only on an entry they
  created. One rule for the full-update PUT (route pre-check, service under-lock check), history
  restore (pre-check on the outside-tx read; under the lock on `created_by_id` from the locked
  row, after the role re-read) and attachment upload (pre-check where the route reads the entry;
  under the lock from `lockTeamAttachmentEntry`). Pre-check → 403 `ONLY_OWN_ENTRIES` (as the PUT);
  under the lock → 403 `ACTOR_NOT_PERMITTED`. Restore and upload previously let a MEMBER switch
  another member's ItemKey or add a CEK under it. The restore keeps its role re-read before the
  entry lock (D42's order) and adds the creator check after it. The client shows the existing
  `onlyOwnEntries` message through the ApiErrors mapping. Integration (AR "own-entry rule"):
  MEMBER on another's entry → restore and upload 403, entry and attachments unchanged; MEMBER on
  own entry → 201 / 200; ADMIN on another's → 201 / 200. Unit: pre-check and under-lock arms in
  both restore and both upload trees, the helper's table; red per arm.
- D55 (round 1 F1) — the restore body carries `snapshotBlobIv` (hex IV), the `blobIv` of the row
  the client decrypted; under the entry lock, after reading the row, a case-insensitive mismatch
  is 409 `HISTORY_ROW_CHANGED` (new code: API_ERROR, status, i18n key, en/ja ApiErrors, count 201
  → 202), entry unchanged. A re-key committing between the client's row GET and the restore
  POST rewrote the row under a new ItemKey; restoring it beside an overview sealed under the
  old one left the list view unopenable and the entry not pending. entry-history-section
  re-fetches the row and retries once on that code (a second refusal shows the message); it now
  reads the refusal body once instead of through `toastApiError`. The schema requires the field
  (400 without it). The A5 cell (ER) is rebuilt as the client builds it — row GET, overview under
  the row's pre-re-key key, built before the re-key — and asserts 409, the entry equal to the
  post-re-key row, pending 0, then the client's retry → 200 with the overview opening under the
  new ItemKey; control: an unchanged row → 200, overview opens under the row's key. Every
  integration restore helper now sends the row's stored `blob_iv`.
- D56 (round 1 F2, one adjudicator; **reader change superseded by D67**) — the restore builder
  sealed the overview with `teamEntryAadFor(…, OVERVIEW, itemKeyVersion, row.aadVersion)` (the
  restored entry took the row's aadVersion; an aadVersion-0 row's overview was sealed with AAD
  and nothing could open it), and every web and extension reader of a team entry's blob or
  overview went through `teamEntryAadFor` with the entry's aadVersion. Round 2 (security N1,
  R43) found that a fix-induced widening: on main every live-entry reader was strict, and a
  server labelling an entry aadVersion 0 could substitute a no-AAD ciphertext. D67 reverses it —
  the restore now writes aadVersion 1 and every live-entry reader is strict again; the
  extension helper is removed. The rest of this entry (writers, the TP "F2" cell) stands as
  amended by D67.
  Writers (save, import, re-key, rotation) always write aadVersion 1 and keep the builder.
  Integration (TP "F2"): an aadVersion-0 v0 row restored through the client builder → the list
  (list GET → `decryptTeamOverview`) opens it, rotation 200 with no carry, the pass upgrades and
  re-keys it (`expectOnCurrentKey`), the list opens it again, pending 0; aadVersion-1 control.
  Red on the scratch copy separately: the restore builder at AAD 1 (unit + TP aadVersion-0
  cell), the list adapter at AAD 1 (unit + TP aadVersion-0 cell), get-detail (unit).
- D57 (round 1 T1, RT11) — `parkBehind(lockSql, params, send, whileParked)` in race-helpers.ts:
  the blocker transaction commits only at the end; on any throw it rolls back in `finally`, is
  released (destroyed if the ROLLBACK itself failed), the parked request is awaited to settle,
  and the original error propagates. `waitingQueryOf(pid)` replaces the inline pg_locks query.
  The five hand-rolled blockers (KW ACTOR_NOT_PERMITTED, ER REKEY_SET_MISMATCH and
  ACTOR_NOT_PERMITTED, AR upload/delete ACTOR_NOT_PERMITTED and migrate ACTOR_NOT_PERMITTED)
  use it; `holdRowLock` users (ER A5, AR MinIO) already released in `finally` after commit and
  are unchanged; TP has none. Red on the scratch copy: the KW helper's regex broken for the
  MEMBER demotion only → exactly "PUT: demoted to MEMBER…" fails, the VIEWER, control and
  restore cells after it pass. The same break on HEAD's hand-rolled helper did not reproduce a
  cascade in that run (its restore cells fail on HEAD for the missing `snapshotBlobIv`, so it is
  not a clean comparison); the fix is recorded as failure-safe by construction, not as a
  reproduced cascade.
- D58 (round 1 S3) — team migrate answers `MIGRATE_NOT_LEGACY` (pre-read row already mode 2) and
  `BLOB_REF_INVALID` (the pre-read `getObject` rejects the ref) before `putObject`; both are still
  re-checked under the locks (the under-lock ref check now has its own cell: a locked row whose
  ref changed since the pre-read). Unit: no `putObject`, no lock on either early refusal; the
  legacy-row 200 cells unchanged; red per arm. This moves those two refusals ahead of the
  under-lock `ACTOR_NOT_PERMITTED` / ItemKey checks for a request that is refused anyway.
- D59 (round 1 F3) — the runner resolves the live wrap (`liveCekWrapKey` now returns
  `{ ok: true, cekWrapKey } | { ok: false, block }`) before downloading a legacy attachment;
  `not_held`, `key_invalid` and `undecryptable` go to their report buckets through `recordBlock`
  (previously all three were a skipped "undecryptable", the retry-pass exit) and nothing is
  downloaded or migrated for the entry. Unit: one row per reason (no attachment GET, no migrate
  PUT, no POST for it) with the openable entry beside it still migrated and re-keyed; red with
  the previous order.
- D60 (round 1 F4) — `RekeyRunnerDeps.signal` (AbortSignal): checked before every request and
  after a re-authentication; once aborted the pass stops with `REKEY_STOP_REASON.CANCELLED`
  (a new stop reason; the control discards that result). The finish control aborts its pass in
  the mount effect's cleanup (a remount after a rotation) and settles a pending
  re-authentication waiter with false; it reports `onRunningChange(true/false)` and the
  Key Rotation page disables the rotate button while a pass runs. Unit: runner (abort after the
  first POST → no request for the next entry; abort while parked on re-authentication →
  CANCELLED, nothing after; control: never-aborted signal completes), control (unmount mid-pass
  aborts the signal, settles the waiter, reports false; control: a finished pass is not aborted,
  reports true then false), rotate button (`disabled`); red per mutation.
- D61 (round 1 F6) — attachment GET: a mode-2 row with NULL `cek_item_key_id` (migrated on a
  NULL-id entry during rollout, D41) returns the CEK fields with the entry wrap and every history
  wrap (`itemKeyWraps`, no id filter) for trial, as mode 1 does; none → 409
  `ATTACHMENT_KEY_UNAVAILABLE`. A non-null id keeps the strict match (`itemKeyWrap`).
  `decryptTeamAttachmentDownload` tries each served wrap until one opens the CEK. Unit: the
  route (all wraps, unfiltered; none → 409; strict control) and the client (opens through the
  second wrap; without it unopenable); red for both.
- D62 (round 1 F7 / T3 / T5 / F8, docs) — checklist items with no diff, and why:
  - v0-only raw-SQL seeders unchanged (`share-departure`, `bulk-import-entry-isolation`,
    `passwords-history-lost-update`, `tenant-swap.adversarial`, `scripts/rls-cross-tenant-seed.sql`):
    they insert only `item_key_version = 0` rows (or none), which carry no `item_key_id`, and no
    cell of theirs reads the re-key marker, the high-water or the pending list, so the column
    defaults (NULL, 0, 0) are the correct state for them.
  - `src/lib/blob-store/db-blob-store.ts` unchanged: the DB backend stores the body in the column
    and has no object key, so generation-based addressing does not apply; only its test's context
    gained the now-required `generation` field.
  - CLAUDE.md Teams API table: rows for `GET /api/teams/[teamId]/rekey`, `GET, POST
    /api/teams/[teamId]/passwords/[id]/rekey` and `PUT …/attachments/[attachmentId]/migrate`
    added in round 1 (user-approved).
  - `schema.prisma` `item_key_id` comment reworded to the rollout state (no CHECK this release,
    D41).
  - Existing cells whose meaning changed in this branch: rotation payload snapshots — the rotate
    route test, `rotation-payload.test.ts` and `team-rotate-key.integration.test.ts` now send
    `snapshotIv` per entry and, for v0 entries, `snapshotOverviewIv` (both ciphertexts are
    replaced); raw-SQL seeders in `team-rotate-key`, `team-key-version-guard` and
    `vault-rotate-key-attachments` gained the marker (`item_key_team_key_version`), the
    high-water and, for v1+ rows, `item_key_id`; both attachment test trees
    (`src/__tests__/api/teams/team-attachments.test.ts` / `team-attachment-download.test.ts` and
    the `route.test.ts` files beside the routes) moved to mode-2-only uploads, the locked
    identity, and the D20 wrap selection; restore tests in both trees (`team-history-restore.test.ts`,
    `restore/route.test.ts`) gained the overview body (D1), the in-lock holder rule, the
    marker/id rule and, in round 1, `snapshotBlobIv` and the creator rule; PUT tests in both trees
    (`…/passwords/[id]/route.test.ts`, `team-password-service.test.ts`) gained the ItemKey
    identity rules and the under-lock role/creator re-read; the A10 CHECK cells (four 23514
    SAVEPOINT inserts and "re-adds the CHECK") were removed per D41 and the A10 cell asserts the
    absence of the constraint instead; the A5 cell was rebuilt (D55).
  - Acceptance map: A10 row names D41 and what the cell asserts; the inventory gains the re-key
    POST `ENTRY_UPGRADE_REQUIRED` (D23) and the round-1 codes (D53–D55).
- D63 (round 1 T4) — the personal-migrate MinIO red proof, re-run and recorded: on the scratch
  copy, `applyAttachmentMigration` (rotate-key-server.ts) hashing the column as `main` did
  (`createHash("sha256").update(row.encryptedData as Buffer)`) instead of the body read through
  the blob store; AR MinIO "personal migrate: hashes the stored body read through the blob store…"
  with `ANCHOR_TEST_S3_ENDPOINT=http://127.0.0.1:9000` failed with
  `expected { status: 409, … } to deeply equal { status: 200, error: undefined }` (the route's
  `LEGACY_INTEGRITY_MISMATCH` refusal: on S3 the column holds the ref, so the client's hash of
  the body never matches); unmutated → passes.
- D64 (round 1 T2 / T6 / T7 / T8, tests and CI) — `ENTRY_REKEY_REQUIRED` PUT cells (service and
  route) gain the minus-step 200 control in the same cell (red: a comparison refusing every
  reuse); the A10 backfill cell seeds a version-0 team (marker 1; red with the predicate
  `= 1`); TP "T7" runs restore(v0 at version 1) → upgrade PUT → `runRekeyPass` → pending 0,
  `rowsOffCurrentVersion` empty, `expectOnCurrentKey` (red: a restore keeping the marker for a
  v0 row leaves the upgraded entry not pending); `ci-integration.yml` path filter adds
  `src/lib/validations/**`, `src/lib/http/**`, `src/lib/security/**`.
- D65 (round 1 A1, not changed) — `s3-blob-store.ts` sets no `forcePathStyle`; the MinIO cells
  pass only with an IP-literal endpoint. Out of this branch's goal; the user files a follow-up.
- D66 (D56 follow-up, iOS; **reverted by D67** — the helper and its callers are gone, iOS
  readers are strict again; the cells below became refusal cells) — `teamEntryAadFor(teamId:entryId:vaultType:itemKeyVersion:aadVersion:)`
  in `ios/Shared/Crypto/AAD.swift`: aadVersion ≥ 1 → `buildTeamEntryAAD` at the entry's ItemKey
  version, else `nil`, which `decryptAESGCM` opens with no AAD (the web helper's `undefined`).
  Every iOS team blob/overview reader goes through it with `CacheEntry.aadVersion`:
  `TeamEntryDecryptor.decryptTeamSummary` / `decryptTeamDetail` (in-app list and detail,
  QuickType registration) and `CredentialResolver.buildEntryAAD` (AutoFill); the team branch of
  `VaultViewModel.buildEntryAAD` too (only personal entries reach it today). `aadVersion` was
  already decoded from the team list response (`TeamEncryptedEntry`, a required field the server
  always sends) and carried into the cache; no default is added. Tests: TeamKeyCryptoTests
  re-seals the fixture's ItemKey-v1 overview and a blob with no AAD (fixture unchanged) →
  aadVersion 0 opens both, the same ciphertext labelled aadVersion 1 is refused, the helper's
  aadVersion-1 bytes equal the fixture's OV AADs (v0 and v2); CredentialResolverTests the same
  pair through `resolveCandidates`. Full `PasswdSSOTests` on z1mn-island: 889 tests, 0 failures.
  Red on the remote scratch copy (HEAD's `TeamEntryDecryptor.swift` and
  `CredentialResolver.swift`): exactly the two aadVersion-0 cells fail, the refusals and fixture
  cells pass.
- D67 (round 2 security N1 + testing T10, R43; supersedes D56's reader change and D66; **the
  restore decrypt at the row's AAD is superseded by D72** — restore now refuses aadVersion < 1
  and opens the row strictly) — a live
  team entry is read strictly at AAD 1 again, everywhere: `buildTeamEntryAAD` at the entry's
  ItemKey version in the list adapter, `build-team-get-detail`, watchtower, team export, the
  edit-dialog loader, the team audit-log page (now strict; on main it was the one
  aadVersion-conditional live reader) and `use-team-login-form-state`'s history passwords
  (strict, as on main: they feed a policy decision, not a display); the extension's three
  sites; iOS `TeamEntryDecryptor` ×2, `CredentialResolver.buildEntryAAD`,
  `VaultViewModel.buildEntryAAD` (iOS sources back to their pre-D66 text).
  **Restore** (as of D72: an aadVersion-0 row is refused, client and server, and the row is
  opened at strict AAD; the rest of this paragraph stands): the client decrypts the row at the
  row's AAD (`teamEntryAadFor`, the only aadVersion-aware step), rebuilds the overview and re-seals BOTH blob and overview under the
  row's key (team key at the row's version for v0, the row's ItemKey for v1+) at AAD 1 and the
  row's `itemKeyVersion`. The body always carries `encryptedBlob` (decision: every restore, one
  code path — the server never copies a row's blob or aadVersion into a live entry; the cost is
  a re-encryption of an aadVersion-1 row the server could have copied). The route writes the
  client blob + overview with `aadVersion = AAD_VERSION`; the history row is unchanged;
  `snapshotBlobIv` CAS (D55) and the key metadata from the row are unchanged. Validation:
  `encryptedFieldSchema` (`CIPHERTEXT_MAX`) under `parseBody`'s default 1 MB cap, as the PUT.
  **Kept aadVersion-aware** (allow-list): rotation v0 reseal, the v0→v1 upgrade payload, the
  re-key payload (live-entry decrypt side and history rows), the restore builder's row decrypt
  (**removed by D72**), and the history VIEW (`entry-history-section` `handleView`): a history row is server-held
  legacy data that is only displayed, never treated as the live entry, and legitimately
  aadVersion 0 for pre-AAD rows — refusing it there would hide old versions without protecting
  any live read. A pre-existing live aadVersion-0 entry is fixed by rotation / the pass as
  before this branch (and unreadable to the strict readers until then, as on main).
  Tests: refusal + aadVersion-1 control per reader, with a `decryptData` stand-in modelling
  the AAD check (`src/__tests__/helpers/aad-model-decrypt.ts`): list adapter, get-detail,
  watchtower, export, edit loader, login-form state; extension `team-entries.test.ts`
  "strict team entry AAD" (list; by id blob+overview; overview only; control asserts the real
  AAD bytes) with the fixed-value `buildTeamEntryAAD` / `teamEntryAadFor` mocks removed from it
  and `http-auth-wiring.test.ts` (the real builder); iOS `TeamKeyCryptoTests` (no-AAD at
  aadVersion 0 for v1 and v0, at aadVersion 1; AAD-sealed opens under both labels) and
  `CredentialResolverTests` (v1 and v0 refused at aadVersion 0; AAD-sealed label-0 control).
  The audit-log page has no unit harness (a Next page cannot export its helper); it is covered
  by the D68 guard only (D73 since). Integration (TP "F2" replaced by D72's refusal cell and
  control): TP "F2" now asserts the restored entry at `aad_version 1`
  (both labels), the strict list opens it, rotation 200 no carry, the pass re-keys it; new TP
  "D67: a pre-existing live aadVersion-0 v0 entry…" (strict list refuses it → rotation re-seals
  at AAD 1, no carry → list opens it → pass re-keys). Restore helpers in ER/AR/KW send the row's
  stored blob as `encryptedBlob` (the same AAD for the aadVersion-1 rows they restore); TP's
  placeholder body gains one. Red on the scratch copy: each web reader honouring aadVersion 0 →
  its refusal cell red (control green) and the guard red; each extension site → its cell red
  (the overview-only mutation → exactly the overview-only cell); the builder sealing the
  overview by `row.aadVersion` → its unit cell and the guard red; a restore route copying the
  row's aadVersion → TP "F2" aadVersion-0 cell red, its aadVersion-1 control green. iOS: HEAD's
  (D66) `TeamEntryDecryptor` / `CredentialResolver` / `AAD.swift` / `VaultViewModel` on a remote
  scratch copy → the six label-0 cells fail (four refusals, two AAD-sealed controls), the
  label-1 refusals pass; full `PasswdSSOTests` with the fix: 892 tests, 0 failures.
- D68 (round 2 security N1 (e), R42 member set; **superseded by D73** — the rules below matched
  spellings without a Program and were rewritten to resolve bindings) — guard `src/__tests__/team-entry-aad-strictness.test.ts`
  (vitest + ts-morph AST, chosen over a scripts/checks gate: no CI/pre-pr registration needed,
  runs in the unit suite). Member set derived: every non-test .ts/.tsx module under `src/` and
  `extension/src/`. Fails if `teamEntryAadFor` is declared outside team-key-resolution.ts,
  referenced outside the allow-list (D67), called in the history view outside `handleView`, or
  used as the AAD of an `encryptData` call; or if, outside the allow-list, a
  `buildTeamEntryAAD(...)` call is a branch of a ternary / logical / if on `aadVersion`, or of a
  ternary whose other branch is undefined/null (an inline re-implementation under another
  spelling); and asserts each known reader still calls `buildTeamEntryAAD`. iOS (Swift) is
  outside it; its refusal cells pin the rule. Red on the scratch copy: `teamEntryAadFor`
  reintroduced in `build-team-get-detail` → the reference and reader cells red; each reader's
  inline aadVersion ternary (incl. the audit-log page) → the conditional cell red.
- D69 (round 2 testing T9, RT11) — AR "A3: of two concurrent migrates…" and ER "A5: a restore
  built before a re-key…": the `finally` awaits `Promise.allSettled` over the started requests
  after releasing the blocker (AR collects them before the park waits; ER the re-key and, once
  sent, the restore), so a failed park wait no longer leaves a request writing after the cell.
  Parking assertions unchanged. Red on the scratch copy (the second park wait made to throw,
  timestamps logged when each request settles and when the `finally` ends): with the fix both
  cells fail with "park wait broke" and every request settles before the cell ends; HEAD's cells
  under the same break end first and their requests settle after (AR ~20 ms, ER ~30–90 ms).
- D70 (round 2 functionality N1) — `team-rekey-finish-control.tsx`: the effect cleanup, after
  `abort()`, clears `abortRef`, sets `running` false and resets progress; the aborted pass's
  `finally` still skips `setResult` / `fetchStatus`. Unit: re-render with another `teamId`
  mid-pass (no unmount) → signal aborted, `onRunningChange(false)`, button enabled, no running
  status, no result; the un-aborted control now also asserts the post-pass status refresh.
  Red: HEAD's control → the re-render cell fails.
- D71 (round 2 functionality N2, accepted, no code change) — restore and upload controls stay
  visible to a MEMBER on another member's entry; the server refuses with ONLY_OWN_ENTRIES (D54)
  and the client shows that message. This matches the existing edit button, which is shown and
  refused the same way; gating all three controls client-side is a UI change outside this PR.
- D72 (round 3 security S-R3-2, R43 widening vs main; supersedes D67's restore decrypt) — a
  history restore refuses a row below `aadVersion` 1 instead of opening it without AAD and
  re-sealing it at AAD 1: nothing binds such a row to the entry, so re-sealing it laundered a
  server-substituted legacy ciphertext into an AAD-bound live entry. On main such a restore
  wrote an entry whose detail did not decrypt, so refusing loses no working behaviour; the
  exit is restoring a more recent version. Client (the control under a malicious server):
  `isRestorableHistoryRow` (`typeof aadVersion === "number" && aadVersion >= 1`, so a
  malformed label is refused too); `entry-history-section` `teamRestoreInit` refuses before
  `buildTeamHistoryRestoreBody` and toasts `ApiErrors.historyRowLegacy` ("This version is too
  old to restore. Restore a more recent version instead." / ja 「このバージョンは古すぎるため
  復元できません。より新しいバージョンを復元してください。」); the builder throws
  `HistoryRowLegacyError` before obtaining a key, and opens the row with `buildTeamEntryAAD`
  only — `teamEntryAadFor` is removed from it (allow-list: rotation-payload, rekey-payload,
  `handleView`). Server (defense in depth for an honest server): the restore route returns 409
  `HISTORY_ROW_LEGACY` for `row.aadVersion < 1`, read under the entry lock after the existing
  checks (CAS, key holder); nothing is written. `HISTORY_ROW_LEGACY` registered in API_ERROR,
  API_ERROR_STATUS (409), the i18n map and messages en/ja; the count test is 203. Tests: unit
  builder (aadVersion-0 → `HistoryRowLegacyError`, no key lookup; a no-AAD ciphertext labelled
  1 → rejects; control: AAD-1 v0 row restores), section (aadVersion-0 row → no POST, no
  decrypt, `historyRowLegacy` shown; control aadVersion 1 → POST), both route test files
  (refusal under the lock, nothing written; control → 200; their default row is now
  aadVersion 1). Integration TP "F2 (S-R3-2)": an aadVersion-0 row → the client builder throws,
  a body re-sealed at AAD 1 anyway → 409 `HISTORY_ROW_LEGACY`, entry and history rows equal
  before/after; "F2 control": the aadVersion-1 v0 row restores and the old chain (strict list,
  rotation no carry, pass re-keys) holds. Docs: threat-model T2 and whitepaper §6.2 (restore no
  longer an upgrade path; legacy acceptance left: rotation, upgrade, re-key and the history
  view — narrowed by D76: the re-key pass no longer re-seals a legacy history row, so the
  refusal here is binding; legacy acceptance is the rotation's v0 re-seal, the re-key of the
  LIVE entry, the v0→v1 upgrade and the history view). Red on the scratch copy: builder refusal removed → its unit cell; section refusal
  removed → its cell; route refusal removed → both route cells and the TP "F2 (S-R3-2)" cell
  (200 instead of 409; control green); builder refusal removed → the TP cell fails with the
  strict decrypt's `OperationError` instead of `HistoryRowLegacyError` (the strict AAD alone
  already refuses the legacy row);
  the builder's AAD made `aadVersion`-conditional → the D73 guard (the strict-AAD unit cell
  stays green under that mutation because the refusal precedes it: the guard is what pins it).
  iOS: no change (its readers are strict and identical to main; iOS has no history restore
  builder).
- D73 (round 3 testing T11 Major + security S-R3-1; supersedes D68; its team-decrypt
  classification (b) is superseded by D77, which fails closed where (b) failed open) — the
  strictness guard resolves bindings, not spellings. Each tree is loaded into a ts-morph Project built from its
  tsconfig (`tsconfig.json` over `src/`, `extension/tsconfig.json` over `extension/src/`,
  non-test files; `skipAddingFilesFromTsConfig`, the type checker resolves `@/` and relative
  imports); ~10 s in the unit suite. (a) outside rotation-payload, rekey-payload,
  team-key-resolution and the history view: any import/export specifier whose imported name is
  `teamEntryAadFor`, any reference `findReferences` resolves to its declaration (renamed
  re-exports, `export *` namespace access), any `["teamEntryAadFor"]` element access, and any
  second declaration of it; an import of it that resolves to nothing fails loudly; the history
  view's call sites must be `handleView` only; it never supplies an `encryptData` AAD.
  (b) a team decrypt is a `decryptData` call (callee resolved through aliases and const
  bindings to a decryptData declaration) whose key argument flows from a team key getter call —
  through const/let initializers, assignments to the same symbol, destructuring, and the
  callers of a local function's parameter, following only key-material values (CryptoKey-
  carrying, `Uint8Array`, `ArrayBuffer`) so a key looked up by a team-derived user id is not
  "team". The getter set is derived: `TeamVaultContextValue` members whose awaited return
  carries a CryptoKey within two property levels (getTeamEncryptionKey, getTeamKeyInfo,
  getTeamEncryptionKeyForVersion, resolveTeamKey, getItemEncryptionKey, getEntryDecryptionKey,
  getEntryItemKeys), plus `extension/src` function declarations with a `teamId` parameter
  returning one (the background `getTeamEncryptionKey`); a getter call matches by resolved
  declaration name or by its spelled name (the spelling only widens the team set, fail-closed).
  Every team decrypt outside the allow-list must have an AAD argument that is a direct
  `buildTeamEntryAAD(...)` call (resolved through aliases) or an identifier with one `const`
  declaration bound to one, whose arguments never read `aadVersion`. (c) the strict-reader set
  is derived from (b) and must contain the nine known readers (the seven web readers, the
  restore builder, the extension background); personal decrypts in watchtower, the history
  view, the extension background, login-save and passkey-provider are asserted examined and
  classified non-team. (d) fixtures through the same `analyze()`: aliased import, barrel rename,
  `export *` namespace, unresolved import, redeclaration, aliased builder in a ternary,
  early-return wrapper, element-access conditional, builder argument from element access,
  hoisted conditional at the decrypt site, `let` binding, missing AAD through an aliased decrypt
  and a destructuring-renamed getter, a team key through a local helper's parameter, a getter
  that stops resolving (drops out of the derived set); controls: a strict reader, a personal
  decrypt with a conditional personal AAD in a team-reading module. Red on the scratch copy:
  each rule's line removed or neutralised → exactly its fixture cells red (alias following
  removed → 14 cells, incl. the tree cells; one getter dropped from the derivation → 10 cells,
  incl. the getter and reader-set cells); tree mutations: login-form AAD made
  `aadVersion`-conditional → (b) red; team-export importing `teamEntryAadFor as strictAad` → (a)
  and (b) red. iOS (Swift) stays outside it.
- D74 (round 3 testing T12 Minor) — team-export.test.tsx asserts `buildTeamEntryAAD` called once
  with `("team-1", "e1", "blob", 0)`; use-team-login-form-state.test.ts asserts the AAD equals
  the real `buildTeamEntryAAD("team-1", "entry-1", "blob", 1)` bytes. Label-0 refusal assertions
  kept. Red on the scratch copy: export at ItemKey version 1, login-form at the overview scope →
  both cells of each file red.
- D75 (round 3 functionality F-R3-1 Minor) — `team-rekey-finish-control.tsx`: on a `teamId`
  change (render-time previous-prop check, the pattern `entry-history-section` uses) `result`
  is cleared and `status` set to loading; a `useLayoutEffect` bumps a team generation ref at
  commit, and the post-pass `fetchStatus` in the `finally` applies its result only if the
  generation is unchanged. Unit: completed team-1 pass then re-render for team-2 → no
  completed/stopped panel, team-2's count shown; team-1's delayed post-pass fetch resolving
  after team-2's → team-2's count stays; control: a pass for the current team shows the
  post-pass status. Red on the scratch copy: reset removed → the first cell; generation check
  removed → the second.
- D76 (round 4 functionality N-R4-1 Major + security S-R4-2; completes D72) — the re-key pass
  no longer re-seals a history row below `aadVersion` 1: it re-sealed such a row at AAD 1, after
  which the D72 restore refusal accepted it (two-step laundering of a substituted no-AAD
  ciphertext). Client (`rekey-payload` `buildEntryRekeyPayload`): a history row failing
  `isRestorableHistoryRow` (the restore's own predicate, so the pass retains exactly the rows
  the restore refuses: aadVersion < 1 or non-numeric) goes to `retainHistoryIds` without being
  decrypted; every other history row is opened with strict `buildTeamEntryAAD` at its ItemKey
  version (`teamEntryAadFor` removed from the history-row path; it stays for the live entry,
  the v0→v1 upgrade and rotation, the accepted T2 risk). Server (rekey POST, defense in depth):
  the locked history read now selects `aad_version`; a `history[]` item naming a locked row
  below 1 → 409 `REKEY_HISTORY_LEGACY` after the set check, before any write. New code
  registered in API_ERROR, API_ERROR_STATUS (409), the i18n map and ApiErrors en/ja ("A history
  version of this entry is too old to re-encrypt. Reload the page and try again." /
  「このエントリの履歴バージョンが古すぎるため再暗号化できません。ページを再読み込みしてから再度お試しください。」);
  unmapped in the runner, so the pass stops and reports (a non-conforming or stale client);
  count test 204. Tests: unit `rekey-payload` (rows labelled 0 / undefined / null / "1", each a
  no-AAD ciphertext under the live ItemKey → retained, `history` empty, two decrypts only (the
  live blob and overview); control: the same row at aadVersion 1 sealed at AAD → re-keyed,
  three decrypts; a no-AAD ciphertext labelled 1 → retained); route unit (locked row at
  aad_version 0 named in `history` → 409, no history/attachment/entry write, no audit; control:
  the row in `retainHistoryIds` → 200, only H1 written). Integration: TP "A1 / scenario 1" —
  the aadVersion-0 row is retained by the real pass (`retained` names it, byte-identical,
  `rowsOffCurrentVersion` = it, `retainedHistoryCount` 1), and after the pass the client
  restore builder throws `HistoryRowLegacyError` and a body re-sealed at AAD 1 anyway → 409
  `HISTORY_ROW_LEGACY`, entry unchanged; team-entry-rekey: the aadVersion-0 row is opt-in in
  `seedEntry({ legacy })` and the local builder mirrors the client (retain below 1, strict
  AAD); new cells "N-R4-1" (retained byte-identical, counted, restore after the pass → 409
  `HISTORY_ROW_LEGACY`) and "REKEY_HISTORY_LEGACY" (a laundering body → 409, rows unchanged;
  control → 200); A1/A10 no longer seed the legacy row, A7 restores the re-keyed sameKey row
  (it restored the aadVersion-0 row after a re-key and expected 200 — the laundering this
  closes). Docs: whitepaper §6.2 and threat-model T2 (the refusal is binding because the pass
  retains such rows unopened and the server refuses re-sealing one; legacy acceptance only on
  the rotation v0 re-seal, the live-entry re-key, the v0→v1 upgrade and the history view). Red
  on the scratch copy: client retention removed → the four unit cells (3 decrypts, not 2); the
  HEAD client (retention removed, `teamEntryAadFor` restored) → the same four; route refusal
  removed → its unit cell; HEAD client + HEAD route → TP A1 and the REKEY_HISTORY_LEGACY cell;
  HEAD client with the new route → TP A1 (the pass stops on 409). The strict-AAD swap alone is
  not observable once the retention gate runs first (`teamEntryAadFor` equals the strict
  builder for a numeric aadVersion ≥ 1); the mislabelled-row unit cell pins the behaviour.
- D77 (round 4 testing T13 Major + security S-R4-1, third escape of the guard; supersedes D73's
  (b)) — the strictness guard's mechanism changed to fail closed. (b) declaration-side
  enumeration: the decrypt set is derived — both `decryptData` declarations plus every named
  function forwarding its own key and AAD parameters to a member (fixed point;
  `decryptTeamEntry`, rekey-payload's `tryDecrypt`, fixture `openWith`); every
  `findReferences` hit of a member must be an import/export specifier, a `typeof`, or the
  direct callee of a call with no spread argument; a string element access naming a member is
  reported by spelling. (c) classification of every non-forwarding decrypt call: TEAM when its
  AAD names `buildTeamEntryAAD` (aliases, const/let bindings, ternary/logical branches, a local
  helper's body, a parameter's arguments) whatever the key, or when its key traces to a getter
  call; UNCLASSIFIABLE when the key trace reaches a parameter with no enumerable call sites
  (callbacks, object/class methods, property-assigned arrows), a container written through a
  property or a mutating method call, a key-returning call through a parameter, a library call
  yielding a key from no key material (WebCrypto excepted), `this`, or an unmodelled
  declaration; such a site fails unless in `NON_TEAM_DECRYPT_SITES`, which must equal the
  derived set (both directions; empty today — every decrypt key in `src/` and
  `extension/src/` traces to its sources). The key trace follows key-material values only
  (CryptoKey-carrying, byte buffers incl. `ArrayBufferView`, containers of them), a
  destructured parameter by its property, `for...of`, a scanned callee's return expressions and
  an interface member's object-literal implementations, byte-buffer writes, and React stores
  (`useState` setter arguments, `useRef` `.current` writes, `createContext` default plus
  `<Ctx.Provider value>`); a byte transformation's body is not entered (its arguments are
  traced), which keeps `toArrayBuffer`'s parameter from joining every caller in the tree.
  Runtime ~15 s for the file (was ~10 s). Fixtures: reference violations (dynamic-import
  destructure, namespace destructure, `.call`, `.apply`, element access, `.bind` as a value,
  const alias, spread, a wrapper as a value); key-independent clause (ternary, const over an
  aliased builder in `&&`, team/personal builders in two branches, a local helper choosing the
  builder — each with a personal key); unclassifiable (then/map callbacks, object method,
  object arrow, class method, property-held key, callback-param key, array holder filled by
  push, Map cache, class field via `this`, a library store); React state setter → team;
  controls: strict reader, personal-AAD reader, T15 alias following (import-renamed + const
  alias builder passes), the `decryptTeamEntry` wrapper at strict AAD, the reviewed-list drift
  in both directions. T15: the ternary cell renamed for what it tests ("a ternary at the
  decrypt site over an aliased builder"), the missing-AAD cell for its spellings
  ("import-renamed decrypt and a destructuring-renamed getter"), plus the alias-following
  control. All 18 reviewer harness cases and the 4 probe2 cases caught (scratch run). Red on
  the scratch copy, one rule at a time (cells red): value-reference rule → the 7 value cells;
  spread → spread; element access → element access; key-independent clause → its 4 cells;
  unclassified reporting off → the 10 unclassifiable cells + drift control; callback params
  traced as no-arg → the 5 callback/method cells + drift control; property write → property-held;
  mutating method → array holder; callback-call → callback-param; `this` → class field;
  library-call → library store; React setter → React state; const-alias following → T15
  control; stale / unreviewed drift → drift control; wrapper derivation and alias resolution
  are foundational (17 / 35 cells incl. the tree cells). Tree mutations: a team reader's decrypt
  moved into a `.then` callback → the traced-or-reviewed cell and the reader-set cell; a
  personal reader given a team-builder ternary AAD → the strict-shape cell.
- D78 (round 4 testing T14 Minor) — `team-history-restore.test.ts`: aadVersion undefined / null /
  "1" on a row sealed at entry AAD → `HistoryRowLegacyError`, no key lookup; control: numeric 1
  on the same row restores (one key lookup). Red on the scratch copy: the typeof check dropped →
  the "1" cell (undefined and null are refused by `>= 1` alone); the predicate as
  `aadVersion !== 0` → all three.
- D79 (round 4 functionality N-R4-2 Minor) — `entry-history-section`: a team history row failing
  `isRestorableHistoryRow` (from the list response's `aadVersion`) shows a disabled Restore
  button described (`aria-describedby`) by a visible muted label `restoreVersionTooOld` ("Too
  old to restore." / 「古すぎるため復元できません。」); the disabled style is the Button
  base class (`disabled:opacity-50 disabled:pointer-events-none`). Personal rows are unchanged
  (their restore does not refuse legacy rows). The `teamRestoreInit` refusal stays for a row GET
  that disagrees with the list. Tests (role/label queries): team rows at aadVersion 0 and
  undefined → disabled, accessible description, label visible, click → no reprompt, no
  dialog; control aadVersion 1 → enabled, no description, dialog opens; control: a personal row
  at 0 stays enabled. Red on the scratch copy: gate removed → the two disabled cells; gate not
  scoped to teams → the personal control.
