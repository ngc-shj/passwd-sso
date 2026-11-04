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
