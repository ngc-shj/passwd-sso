# Key Retention and Deletion Policy

This document defines when cryptographic key material can be retained or safely
deleted. It applies to both automated systems and manual maintenance operations.

---

## 1. TeamMemberKey Retention

### Active member keys

- **Current version**: Always retained while member is active.
- **Old versions**: Retained while any row of the team references that
  version: a `TeamPasswordEntry` or `TeamPasswordEntryHistory` with
  `teamKeyVersion = N`, or a legacy (`encryptionMode = 0`) attachment with
  `keyVersion = N`.

### Cleanup rules

- Safe to delete a `TeamMemberKey` at version N when:
  - No row of the team references version N (the three references above;
    a NULL or 0 version counts as 1)
  - The team's current `teamKeyVersion > N`
- The condition is keyed on references, **not** on the re-key marker
  (`item_key_team_key_version`). A re-keyed entry can still hold history rows
  retained under version N (rows the re-keyer could not open), and a carried
  entry stays at N; deleting N on the strength of "no entry is pending" would
  make those rows unreadable to everyone.
- The re-key pass (whitepaper §6.2) is what lets version N reach zero
  references.

### Automatic prune (`#1009`)

- The retention GC worker deletes these versions — every member's row at
  (team, N) — once `RETENTION_GC_TEAM_KEY_PRUNE_ENABLED=true`. The switch is
  **off by default**: deletion is irreversible, so enable it only after
  reviewing the reference classification (`scripts/checks/check-team-key-version-refs.mjs`).
  While it is off, old versions are retained indefinitely.
- The prune is the SECURITY DEFINER function `team_member_key_prune(p_batch)`
  (migrations `20261108120100_team_member_key_prune`, redefined by
  `20261109100000_team_member_key_prune_team_lock`). It first locks up to
  `p_batch` teams that have an old version no row references, `teams ... FOR
  NO KEY UPDATE SKIP LOCKED`, then decides and deletes in a later statement,
  for the locked teams only. The references are exactly the three above,
  normalised as the reader does (a stored version below 1 counts as 1); the
  current version is never selected. Each tick deletes at most
  `RETENTION_GC_BATCH_SIZE` (team, version) pairs.
- Concurrency. No non-current reference is created from nothing: every writer
  that creates a reference asserts the current version under the team row
  lock. Every transaction that copies a non-current version into a row —
  history restore, the full-update history snapshot, the per-entry re-key —
  holds `teams ... FOR SHARE` from before it reads the copy source until it
  commits, and rotation holds `teams ... FOR NO KEY UPDATE`
  (`src/lib/team/team-key-rotation-lock.ts`). The prune's lock conflicts with
  both and skips, never waits: a team any such writer holds is not pruned in
  that tick, and a writer that starts later waits until the prune's
  transaction ends. The deciding statement runs after the locks are held, so
  under READ COMMITTED (the function refuses any other isolation level) it
  sees every copier of a locked team as committed. A third party deleting a
  copier's source in the meantime (the history age sweep, the history trim)
  is covered because the copier still holds its team lock.
  A single statement alone is not enough: a restore that read history row h,
  whose h the history sweep then deleted, would be invisible to a snapshot
  that sees neither h nor the restored entry.
- A new column that can hold a team key version must be added to the
  function and to the gate's classification; the gate fails until it is. The
  gate also checks the function's statement order (bypass check, isolation
  guard, one team-lock statement, one deciding statement restricted to the
  locked teams).
- The worker role holds EXECUTE on the function and no table grant. The
  function refuses unless the caller's RLS bypass is on; a bypass whose grant
  does not name `team_member_keys` is reported (`rls_bypass_not_granted`) and
  becomes a refusal once enforcement is switched on (`#921`).
- Each tick writes one `TEAM_MEMBER_KEY_PRUNED` audit row per team (team
  scope, SYSTEM actor) carrying the versions, the row count and the holders'
  user ids (section 3).

---

## 2. History Decryption Key Lifetime

### Minimum retention

A `TeamMemberKey` version must be retained as long as any
`TeamPasswordEntryHistory` record references that `teamKeyVersion`.

### History trim limits

- Maximum 20 history entries per `TeamPasswordEntry` (enforced in code).
- Oldest entries are deleted first when the limit is exceeded.
- Deletion of history entries may allow cleanup of old key versions.

### Under the re-key pass

- The pass re-encrypts every history row it can open under the entry's new
  ItemKey and current team key version, so those rows stop referencing the
  old version.
- Rows it cannot open are **retained** under their old wrap and old
  `teamKeyVersion` and keep that version alive. They stay readable to holders
  of that version, including departed members who kept the key. They are
  revisited only when the entry is pending again after the next rotation and a
  holder of their version re-keys it first.
- The v0→v1 upgrade the pass performs adds a history row and trims history to
  20, which may itself drop old-version rows.

### Personal vault history

- `PasswordEntryHistory` uses `keyVersion` from the User model.
- Old `VaultKey` versions must be retained as long as any history entry
  references that version.

---

## 3. Revoked Member Key Handling

### On member removal

1. `TeamMemberKey` rows of the removed user are **deleted** with the
   membership, in the removal's transaction (member removal, SCIM
   deprovisioning, invitation re-accept, vault reset). They are not kept as
   evidence. What records who held which version instead:
   - `TEAM_MEMBER_KEY_DISTRIBUTE` (confirm-key) and `TEAM_KEY_ROTATION`
     audit rows, written when a version was given to a member;
   - `TEAM_MEMBER_KEY_PRUNED.holderUserIds` (up to 100 ids, the rest counted
     in `holderUserIdsOmitted`), written when the worker deletes an old
     version, naming every member who still held it.
2. Team key rotation followed by the re-key pass is **mandatory** after member
   removal.
   - Rotation re-wraps each entry's `ItemKey` under the new `TeamKey`; the
     re-key pass then replaces each `ItemKey` and re-encrypts the entry's
     blob, overview and history and re-wraps its attachment CEKs.
   - New `TeamMemberKey` envelopes issued only for remaining active members.
3. Revoked user **cannot obtain** new `TeamMemberKeyEnvelope`.

### Forward secrecy guarantee

- Once an entry is re-keyed, content written to it afterwards is unreadable
  with the old team key or the old `ItemKey`.
- Rotation alone does not provide this: until an entry is re-keyed, edits to
  it still use the old `ItemKey`. The pending count shows how many remain.
- Stated limits (each leaves material readable to a departed member who kept
  the old keys):
  - history rows the re-keyer could not open (retained, above);
  - entries carried as unrecoverable (no active holder) or on a holder's
    `undecryptable` / `key_invalid` claim, until another holder re-keys them;
  - attachment CEKs, which are re-wrapped, not replaced, and any CEK or
    plaintext the member already downloaded;
  - backups, WAL and versioned buckets (section 4).
- **Backward secrecy is NOT guaranteed** (E2E limitation): if the member
  cached the old team key locally, they could still decrypt historical data
  encrypted with that key version.

### Recommended companion actions

- Kill all sessions for the revoked user (database session deletion).
- Invalidate extension tokens.
- Revoke API keys scoped to the team.

---

## 4. Backup Key Metadata

### What backups contain

- Encrypted vault data (personal entries, team entries).
- Entry-level `keyVersion` / `teamKeyVersion` metadata.
- User-level `accountSalt`, `encryptedSecretKey`, `keyVersion`.

### What backups do NOT contain

- `TeamMemberKey` records (server-side key distribution only).
- Plaintext keys of any kind.
- Server-side `masterPasswordServerHash` / `masterPasswordServerSalt`.

### Restore handling

- On restore, the system reads KDF params and key versions from the database
  (populated by migration defaults or existing data).
- If a backup references a `keyVersion` that no longer exists in `VaultKey`,
  the entry cannot be decrypted. This is an expected limitation — users should
  maintain current vault access before restoring old backups.

### Old ciphertext outside the live rows

Rotation and the re-key pass rewrite live rows only. Database backups, WAL
archives, versioned object-storage buckets, and attachment objects orphaned by a
crash between a rewrite's commit and its post-commit delete keep the
pre-rotation wraps and ciphertext. Anyone holding the old keys and such a copy
reads the content as it was then. Their retention is bounded only by the
operator's backup, WAL and bucket-versioning retention; set those with that in
mind.

### Orphaned attachment objects (`#1010`)

With an external `BLOB_BACKEND` (S3, Azure, GCS), the retention GC worker can
delete attachment objects that no `attachments` row references
(`RETENTION_GC_BLOB_SWEEP_MODE`, default `off`). An object is deleted only when:

- the bucket holds this deployment's marker — `<BLOB_OBJECT_PREFIX>/.passwd-sso-deployment`
  (no leading `/` when the prefix is empty) whose body equals `DEPLOYMENT_ID`.
  The worker only reads it; the operator creates it once with
  `node dist/retention-gc-worker.js --init-blob-marker`, which creates it only
  if absent and prints `created` or `exists`. `DEPLOYMENT_ID` must be unique per
  deployment and changed when an environment is cloned; create the marker only
  from the deployment that owns the bucket (with operator credentials when the
  worker's identity has no write access);
- its key parses as an attachment key under the **current** prefix. Objects
  under a previous `BLOB_OBJECT_PREFIX`, other prefixes and unparseable keys are
  never listed or never deleted;
- it is older than `RETENTION_GC_BLOB_ORPHAN_GRACE_MS`;
- no row with its attachment id names its exact key;
- the tick passed the breaker: at least one referenced object was seen in the
  current listing pass, and the unreferenced old objects are at most 20 or at
  most `RETENTION_GC_BLOB_SWEEP_MAX_DELETE_RATIO` of the tick's attachment
  objects, and at most `RETENTION_GC_BLOB_SWEEP_MAX_DELETES`.

A refused tick deletes nothing, records `-1` for `attachment_objects` and still
advances the listing, which resets when a pass completes, on a listing error
and on worker restart. Run `report` mode first and inspect its counts; when a
legitimate orphan backlog trips the breaker, raise the ratio or cap for one
pass and lower it again (operator steps per refusal cause:
`docs/architecture/retention-gc-worker.md`, "Breaker refusals").

**Database restore.** Every writer of an attachment ref writes a fresh object
key, so an object unreferenced past the grace period is never referenced
again — except after a database restore, which brings back rows whose objects
the sweep may already have deleted. In `delete` mode the grace period has no
default and must be set explicitly to at least the database backup / PITR
retention window (the maximum, 35 days, covers RDS); alternatively keep
noncurrent object versions in the bucket for at least that window so a deleted
object can be recovered. After a restore, set the mode to `off` until the
restored rows have been reconciled with the bucket.

---

## 5. Personal Vault Key Retention

### Master key versioning

- `User.keyVersion` tracks the current vault key version.
- `VaultKey` stores verification artifacts per version.
- `MASTER_KEY_VERSION` in environment tracks the server-side master key.

### Old wrapped secret keys

- When a user changes their passphrase, the old `encryptedSecretKey` is
  overwritten with the new wrapping.
- The underlying `secretKey` remains the same — only the wrapping changes.
- No old wrapped copies are retained (single active wrapping per user).

### Recovery key

- Independent lifecycle from the main passphrase.
- `recoveryEncryptedSecretKey` stored on the User model.
- Recovery key setup/regeneration does not affect the main key chain.
- Recovery key can be regenerated without changing the vault passphrase.

---

## 6. KDF Parameter Retention

### Current params

- `User.kdfType` and `User.kdfIterations` store the active KDF configuration.
- These are overwritten on passphrase change or KDF migration (future P2).

### Migration handling

- When migrating from PBKDF2 to Argon2id (future), the old params are
  overwritten — no history of previous KDF params is maintained.
- This is acceptable because KDF params are not needed for decryption of
  existing data (the derived key, not the params, protects the data).

---

## 7. Admin Script Authentication

Admin and maintenance scripts (`scripts/purge-history.sh`, `scripts/purge-audit-logs.sh`, `scripts/rotate-master-key.sh`) require an operator (`op_*`) token, not the shared `ADMIN_API_TOKEN` environment variable. Operator tokens are minted per-operator at `/admin/tenant/operator-tokens` (requires tenant OWNER role). Pass the token as:

```bash
ADMIN_API_TOKEN=op_<token> scripts/purge-history.sh
```

The `ADMIN_API_TOKEN` env var name is reused by the scripts as the transport variable for the `op_*` token value; no shared static token exists in the application.

---

## Summary Table

| Key Material | Retention Policy | Deletion Condition |
|---|---|---|
| TeamMemberKey (current) | Retain while member is active | Member removed (rows deleted with the membership) |
| TeamMemberKey (old version) | Retain while any entry, history row or mode-0 attachment references the version | No row of the team references it (not keyed on the re-key marker); deleted by the retention GC worker when `RETENTION_GC_TEAM_KEY_PRUNE_ENABLED=true`, audited as `TEAM_MEMBER_KEY_PRUNED` |
| TeamMemberKey (removed member) | Deleted with the membership | Evidence kept in audit: `TEAM_MEMBER_KEY_DISTRIBUTE`, `TEAM_KEY_ROTATION`, `TEAM_MEMBER_KEY_PRUNED.holderUserIds` |
| Attachment object (external store) | Retain while a row names its key, and for the grace period | Unreferenced past `RETENTION_GC_BLOB_ORPHAN_GRACE_MS`, in a bucket marked with this `DEPLOYMENT_ID`, when `RETENTION_GC_BLOB_SWEEP_MODE=delete` |
| VaultKey (personal) | Retain while history references exist | All referencing history entries deleted |
| User.encryptedSecretKey | Single active copy, overwritten on change | N/A (always current) |
| Recovery key material | Retain until regenerated or vault reset | Overwritten on regeneration |
| KDF params | Single active set per user | Overwritten on migration |
