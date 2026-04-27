# Key Retention and Deletion Policy

This document defines when cryptographic key material can be retained or safely
deleted. It applies to both automated systems and manual maintenance operations.

---

## 1. TeamMemberKey Retention

### Active member keys

- **Current version**: Always retained while member is active.
- **Old versions**: Retained while any `TeamPasswordEntryHistory` or
  `TeamPasswordEntry` references that `teamKeyVersion`.

### Cleanup rules

- Safe to delete a `TeamMemberKey` at version N when:
  - No `TeamPasswordEntry.teamKeyVersion = N` exists for that team
  - No `TeamPasswordEntryHistory.teamKeyVersion = N` exists for that team
  - The team's current `teamKeyVersion > N`
- Until lazy re-encryption (P3 roadmap) is implemented, old keys must be
  retained indefinitely.

---

## 2. History Decryption Key Lifetime

### Minimum retention

A `TeamMemberKey` version must be retained as long as any
`TeamPasswordEntryHistory` record references that `teamKeyVersion`.

### History trim limits

- Maximum 20 history entries per `TeamPasswordEntry` (enforced in code).
- Oldest entries are deleted first when the limit is exceeded.
- Deletion of history entries may allow cleanup of old key versions.

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
2. Team key rotation is **mandatory** after member removal.
   - All active `ItemKey` (future) or entry data must be re-encrypted with
     the new `TeamKey` version.
   - New `TeamMemberKey` envelopes issued only for remaining active members.
3. Revoked user **cannot obtain** new `TeamMemberKeyEnvelope`.

### Forward secrecy guarantee

- After rotation, the revoked member cannot decrypt new data (no new key).
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

Admin and maintenance scripts (`scripts/purge-history.sh`, `scripts/purge-audit-logs.sh`, `scripts/rotate-master-key.sh`) require an operator (`op_*`) token, not the shared `ADMIN_API_TOKEN` environment variable. Operator tokens are minted per-operator at `/dashboard/tenant/operator-tokens` (requires tenant OWNER role). Pass the token as:

```bash
ADMIN_API_TOKEN=op_<token> scripts/purge-history.sh
```

The `ADMIN_API_TOKEN` env var name is reused by the scripts as the transport variable for the `op_*` token value; no shared static token exists in the application.

---

## Summary Table

| Key Material | Retention Policy | Deletion Condition |
|---|---|---|
| TeamMemberKey (current) | Retain while member is active | Member permanently removed + no history references |
| TeamMemberKey (old version) | Retain while history references exist | All referencing history entries deleted or re-encrypted |
| TeamMemberKey (revoked member) | Mark deactivated, do not delete | Manual cleanup after audit period (org policy) |
| VaultKey (personal) | Retain while history references exist | All referencing history entries deleted |
| User.encryptedSecretKey | Single active copy, overwritten on change | N/A (always current) |
| Recovery key material | Retain until regenerated or vault reset | Overwritten on regeneration |
| KDF params | Single active set per user | Overwritten on migration |
