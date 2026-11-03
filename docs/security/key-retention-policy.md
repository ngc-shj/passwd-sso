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
- No automated pruning exists yet (follow-up); old keys are retained
  indefinitely. The re-key pass (whitepaper §6.2) is what lets version N reach
  zero references.

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

1. `TeamMemberKey` for the revoked user: **mark as deactivated, do not delete**.
   - Audit trail: the key record proves the user had access during a period.
   - Dispute resolution: may be needed to verify what data was accessible.
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
mind. A sweep of unreferenced attachment objects is a follow-up.

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
| TeamMemberKey (current) | Retain while member is active | Member permanently removed + no history references |
| TeamMemberKey (old version) | Retain while any entry, history row or mode-0 attachment references the version | No row of the team references it (not keyed on the re-key marker) |
| TeamMemberKey (revoked member) | Mark deactivated, do not delete | Manual cleanup after audit period (org policy) |
| VaultKey (personal) | Retain while history references exist | All referencing history entries deleted |
| User.encryptedSecretKey | Single active copy, overwritten on change | N/A (always current) |
| Recovery key material | Retain until regenerated or vault reset | Overwritten on regeneration |
| KDF params | Single active set per user | Overwritten on migration |
