# Manual Test Plan: Vault Attachment Rotation — Phase B

**R35 tier**: 2 (Critical) — change touches cryptographic material (per-attachment CEK key rotation, envelope-key chain for personal attachments) and the vault key rotation POST contract.

**Boot signal (R32)**: not applicable — no new long-running runtime artifact (the DCR cleanup worker is a separate process, not introduced here).

**Branch**: `feature/vault-attachment-rotation-phase-b`

**Plan reference**: `docs/archive/review/vault-attachment-rotation-phase-b-plan.md`

---

## Pre-conditions (global)

- Local dev stack running:
  ```
  npm run docker:up
  npm run dev
  ```
- Prisma migration applied:
  ```
  npm run db:migrate
  ```
  The new `attachments` table columns must be present: `cek_encrypted`, `cek_iv`, `cek_auth_tag`, `cek_key_version`, `cek_wrap_aad_version`, `encryption_mode`.
- A test account signed in as `<test-user-email>`.
- Vault initialized (master passphrase set).
- At least one password entry in the vault (personal scope, not team).

**Placeholder substitution**: Every `<test-user-email>`, `<reviewer-handle>`, and `<internal-hostname>` MUST be replaced with local values before running. Do NOT commit substituted values — use them locally only.

---

## M1 — Fresh upload + download (mode-2 round-trip)

Verifies: C3 (upload requires mode-2), C4 (download returns CEK fields), C8a (client encrypt/decrypt path).

### Pre-conditions

- Fresh DB or at least one personal entry with no attachments.
- Vault unlocked as `<test-user-email>`.

### Steps

1. Open `http://<internal-hostname>/dashboard/passwords`.
2. Navigate to a personal entry (or create one: title "M1 test").
3. Open the attachment panel for that entry.
4. Upload a small text file `hello.txt` with content exactly `test123` (7 bytes).
5. Wait for the upload to complete (progress spinner disappears, attachment row appears).
6. Close and re-open the browser tab (forces a fresh fetch).
7. Navigate back to the same entry.
8. Click the attachment row and download `hello.txt`.

### Expected result

- Step 5: HTTP 201 from `POST /api/passwords/{entryId}/attachments`. No 400 error.
- Step 8: Downloaded file content equals `test123` byte-for-byte.
- DB row in `attachments` table (verify via `psql`):
  ```sql
  SELECT encryption_mode, cek_encrypted IS NOT NULL AS has_cek,
         cek_iv, cek_auth_tag, cek_key_version, cek_wrap_aad_version
  FROM attachments
  WHERE id = '<attachment-id>';
  ```
  Expected: `encryption_mode = 2`, `has_cek = true`, `cek_iv` is a 24-character hex string, `cek_auth_tag` is a 32-character hex string, `cek_key_version` matches the current vault `key_version` from `users`, `cek_wrap_aad_version = 1`.
- `GET /api/passwords/{entryId}/attachments/{attachmentId}` response JSON includes fields `encryptionMode: 2`, `cekEncrypted` (non-null base64), `cekIv`, `cekAuthTag`, `cekKeyVersion`, `cekWrapAadVersion`.

### Rollback

Delete the attachment via the UI (entry detail → attachment row → delete icon). Or:
```sql
DELETE FROM attachments WHERE id = '<attachment-id>';
```

---

## M2 — Phase A → Phase B upgrade; mode-0 download without rotation

Verifies: NFR-3 (backward compatibility — mode-0 attachments remain readable).

### Pre-conditions

- A mode-0 attachment row must exist in the DB (from before Phase B, or constructed manually).

**`[destructive — operator-only]`** If no real Phase A data is available, insert a test row using the psql REPL. Obtain a valid `entry_id` and `user_id` from the DB first, then run:

```sql
-- substitute real values for <entry-id>, <blob-bytes>, <iv-hex>, <auth-tag-hex>
INSERT INTO attachments (
  id, name, size, mime_type,
  encrypted_data, iv, auth_tag,
  key_version, aad_version,
  encryption_mode,
  password_entry_id,
  created_at, updated_at
) VALUES (
  gen_random_uuid(),
  'm2-legacy.txt',
  7,
  'text/plain',
  '\x<blob-bytes>'::bytea,
  '<iv-hex>',
  '<auth-tag-hex>',
  1, 1, 0,
  '<entry-id>',
  now(), now()
);
```

To produce the blob bytes: use a Node.js snippet with the same crypto path as production mode-0:
```js
// run with: node -e "..."
const { webcrypto } = require('node:crypto');
// ... derive encryptionKey from secretKey via HKDF("passwd-sso-enc-v1")
// ... encrypt Buffer.from("test123") with encryptionKey + buildAttachmentAAD(entryId, attachmentId)
// print hex of encryptedData, iv, authTag
```
This step requires knowing the user's `secretKey` derivation — use a test passphrase in a clean dev environment only.

### Steps

1. Start the Phase B app (`npm run dev`) against the DB that has the mode-0 row.
2. Navigate to the entry that owns the mode-0 attachment.
3. Open the attachment panel.
4. Observe the attachment row for the legacy hint text.
5. Click the attachment row and download it.

### Expected result

- Step 4: The attachment row shows a hint — "Legacy attachment — will upgrade on next vault rotation" (or equivalent i18n string `legacyAttachmentHint` from `Vault.json`).
- Step 5: Download succeeds. Downloaded content matches the original plaintext.
- No HTTP error (not 500, not 404). The legacy mode-0 decrypt path is used transparently.
- DB row `encryption_mode` remains `0` — no auto-migration occurs on download in Phase B (migration is deferred to rotation time per C8).

### Rollback

```sql
DELETE FROM attachments WHERE name = 'm2-legacy.txt' AND encryption_mode = 0;
```

---

## M3 — Phase A → Phase B + rotate; both mode-0 and mode-2 attachments survive

Verifies: FR-2 (CEK re-wrap), FR-3 (mode-0 auto-migration), C6 (data fetch shape), C7 (rotation POST), C8 (client rotation flow), C11 (whitepaper — rotation freshness).

### Pre-conditions

- State from M2: at least 1 mode-0 attachment in the vault.
- Additionally, 1 mode-2 attachment exists (uploaded via M1 or fresh upload).
- Vault unlocked.

### Steps

1. Note the attachment IDs and their current `encryption_mode` via `psql`:
   ```sql
   SELECT id, name, encryption_mode, cek_key_version FROM attachments
   WHERE password_entry_id IN (
     SELECT id FROM password_entries WHERE user_id = '<user-id>'
   );
   ```
2. Navigate to Settings → Security → Vault Key Rotation.
3. Enter the vault passphrase and confirm rotation.
4. Observe the rotation dialog — it should display a "Upgrading N attachments to new format…" progress indicator for the mode-0 attachment.
5. Wait for rotation to complete.
6. Navigate to each entry and download both the originally-mode-0 and originally-mode-2 attachments.

### Expected result

- Step 4: Progress indicator shows migration count (C8 I8.3).
- Step 5: Rotation completes without error. No 409 errors.
- Step 6: Both downloads return original plaintext bytes.
- Post-rotation DB state:
  ```sql
  SELECT id, name, encryption_mode, cek_key_version
  FROM attachments
  WHERE password_entry_id IN (
    SELECT id FROM password_entries WHERE user_id = '<user-id>'
  );
  ```
  Expected: ALL rows have `encryption_mode = 2`, and `cek_key_version` matches the new vault `key_version` from `users`.
- `audit_logs` has a `VAULT_KEY_ROTATION` entry with metadata including `cekRewrapsAttempted`, `cekRewrapsSucceeded`, `legacyAttachmentsMigrated`.

### Rollback

Restore from a pre-rotation DB backup. There is no in-app undo for key rotation. This is expected and documented in the rotation dialog.

---

## M4 — Mid-rotation abort; resume on next session

Verifies: C5 (per-attachment commit atomicity), C8 I8.4 (halt before rotation POST on migration failure), snapshot-window risk documented in §6.1.d of the whitepaper.

### Pre-conditions

- Vault with exactly 12 mode-0 attachments (inserted via `[destructive — operator-only]` SQL as described in M2 pre-conditions, repeated for 12 attachments across one or more entries).
- Vault unlocked.

### Steps

1. Before starting rotation, open a `psql` session in another terminal window with a periodic count query:
   ```sql
   -- Run repeatedly (e.g., every 2 seconds):
   SELECT count(*), encryption_mode FROM attachments
   WHERE password_entry_id IN (
     SELECT id FROM password_entries WHERE user_id = '<user-id>'
   )
   GROUP BY encryption_mode;
   ```
2. Initiate rotation from Settings → Security → Vault Key Rotation.
3. Monitor the DB query. When the count shows 8 rows with `encryption_mode = 2` and 4 rows with `encryption_mode = 0`, force-close the browser tab (Ctrl+W or kill the tab process).
4. Verify the intermediate state in `psql`:
   - 8 rows with `encryption_mode = 2`, `cek_key_version = <old-vault-key-version>` (under OLD `secretKey`).
   - 4 rows with `encryption_mode = 0`.
   - No `VAULT_KEY_ROTATION` audit row (rotation POST was never sent).
5. Sign back in as `<test-user-email>`, unlock the vault with the same passphrase.
6. Navigate to Settings → Vault Key Rotation and run rotation again.
7. Monitor until completion.

### Expected result

- Step 4: Confirms abort before rotation POST leaves no half-applied state. Each attachment is either fully mode-0 (untouched) or fully mode-2 (committed under old key). No row is in an inconsistent state.
- Step 7: Second rotation migrates the remaining 4 mode-0 rows, then re-wraps all 12 mode-2 CEKs under the NEW `secretKey`. Rotation completes.
- Post-step-7 DB: all 12 rows are `encryption_mode = 2` with `cek_key_version = <new-vault-key-version>`.
- All 12 attachments remain downloadable with correct plaintext.

### Rollback

**`[destructive — operator-only]`** Restore from a pre-test DB backup:
```bash
# e.g., pg_restore from a pg_dump taken before M4
```
Or delete the 12 test attachments:
```sql
DELETE FROM attachments WHERE name LIKE 'm4-legacy-%';
```

---

## M5 — Adversarial: DB write access flips cek_encrypted back to pre-rotation blob

**Adversarial classification**: Active server-side storage tampering.

Verifies: C2 (wrap AAD includes `cekKeyVersion`), C8a I8a.3 (AAD-version floor + AES-GCM verification rejection), whitepaper §6.1.d (cekKeyVersion in wrap AAD prevents stale wrap replay).

### Pre-conditions

- M3 state: a mode-2 attachment with `cek_key_version = N+1` (post-rotation).
- The pre-rotation `cek_encrypted` blob value was recorded in a DB backup or noted from a `psql` query before rotation.

### Steps

1. Obtain the pre-rotation `cek_encrypted` bytes and the attachment `id`:
   ```sql
   -- (from backup or pre-rotation snapshot)
   SELECT encode(cek_encrypted, 'hex') FROM attachments WHERE id = '<attachment-id>';
   ```
2. **`[destructive — operator-only]`** Flip the row's `cek_encrypted` back to the pre-rotation value while leaving `cek_key_version` at the post-rotation value:
   ```sql
   UPDATE attachments
   SET cek_encrypted = '\x<pre-rotation-blob>'::bytea
   WHERE id = '<attachment-id>';
   ```
3. Navigate to the entry and click the attachment row to download.

### Expected result

- Download fails with a client-side error. The error message corresponds to the "outdated AAD format" code from C8a I8a.3, OR an AES-GCM authentication failure.
- No plaintext is returned.
- The mismatch is detectable because the wrap AAD includes `cekKeyVersion = N+1` (current), but the blob was wrapped under AAD with `cekKeyVersion = N` (old) — the AAD bytes differ, so AES-GCM authentication rejects.
- The `cek_encrypted` row is unchanged after the failed download (the client never writes on download failure).

### Rollback

**`[destructive — operator-only]`** Restore the correct `cek_encrypted` from the post-rotation backup:
```sql
UPDATE attachments
SET cek_encrypted = '\x<post-rotation-blob>'::bytea
WHERE id = '<attachment-id>';
```

---

## M6 — Adversarial: Concurrent migrate + rotate (two tabs)

**Adversarial classification**: Race condition / advisory lock serialization.

Verifies: C5 I5.1 (advisory lock on migrate), C7 I7.1 (advisory lock on rotate), no half-applied state under concurrent access.

### Pre-conditions

- Vault with at least 1 mode-0 attachment and 1 mode-2 attachment.
- Two browser tabs open, both authenticated as `<test-user-email>`, vault unlocked in each.

### Steps

1. Tab A: begin vault key rotation (Settings → Vault Key Rotation → enter passphrase → submit). Do NOT wait for it to finish.
2. Immediately in Tab B: navigate to a personal entry, upload a new attachment (mode-2) while Tab A's rotation is in progress.
3. Wait for Tab A's rotation to complete.
4. In Tab B: download the newly uploaded attachment.

### Expected result

- The advisory lock (`pg_advisory_xact_lock(hashtext(userId::text))`) serializes the concurrent operations — no interleaved half-applied state occurs.
- Tab A's rotation completes successfully.
- Tab B's upload succeeds (201).
- Tab B's newly-uploaded mode-2 attachment has `cek_key_version = <old-key-version>` immediately after upload (the upload happened before rotation committed). On the NEXT rotation cycle, this row will be re-wrapped under the new key. This is the expected behavior per C7 guard B (loosened strict-equality).
- Tab B's download returns the correct plaintext.
- No 500 errors on either side.

**Note**: if on-demand migration is not implemented in this Phase B (deferred to Phase B+ per C13 plan note), Tab B exercises the same lock surface via the concurrent upload path. The upload limiter and rotation POST use the same per-user advisory lock namespace.

### Rollback

Delete the Tab B attachment via the UI or `psql`.

---

## M7 — Server reject of mode-0 upload after Phase B lands

Verifies: C3 I3.1 (server rejects uploads missing CEK fields).

### Pre-conditions

- Phase B server deployed (`npm run dev` with Phase B code).
- An entry `<entry-id>` exists in the vault.
- Auth cookie obtained (sign in via browser, copy the `authjs.session-token` cookie value).

### Steps

1. Submit a POST to the attachment upload endpoint without CEK fields:
   ```bash
   curl -s -X POST \
     http://<internal-hostname>/api/passwords/<entry-id>/attachments \
     -H "Cookie: authjs.session-token=<session-token>" \
     -F "name=legacy-upload.txt" \
     -F "size=7" \
     -F "mimeType=text/plain" \
     -F "encryptedData=dGVzdDEyMw==" \
     -F "iv=aabbccdd00112233aabbccdd" \
     -F "authTag=aabbccdd00112233aabbccdd00112233" \
     -F "keyVersion=1" \
     -F "aadVersion=1"
   ```
   (No `cekEncrypted`, `cekIv`, `cekAuthTag`, `cekKeyVersion`, `cekWrapAadVersion` fields are included.)

### Expected result

- HTTP 400 response with error code `INVALID_REQUEST`.
- No row is created in the `attachments` table.

### Rollback

N/A — no DB write occurred.

---

## M8 — Adversarial: Forged attachmentId in /migrate request

**Adversarial classification**: Cross-scope ID enumeration / authorization bypass.

Verifies: C5 I5.2 (scope predicate rejects wrong user/tenant/team-scope), T12.5, T12.5b.

### Pre-conditions

- User A (`<test-user-email>`) has at least 1 mode-0 personal attachment with ID `<user-a-att-id>`.
- User B (`<other-user-email>`) has at least 1 mode-0 personal attachment with ID `<user-b-att-id>`.
- A second test tenant with user C (`<other-tenant-email>`) has a mode-0 attachment with ID `<other-tenant-att-id>`.
- A team that `<test-user-email>` belongs to has a mode-2 (team) attachment with ID `<team-att-id>`.
- Auth cookie for `<test-user-email>` obtained.

### Steps

**Sub-variant (a) — cross-user:**
```bash
curl -s -X PUT \
  http://<internal-hostname>/api/passwords/<wrong-entry-id>/attachments/<user-b-att-id>/migrate \
  -H "Cookie: authjs.session-token=<session-token-for-user-a>" \
  -H "Content-Type: application/json" \
  -d '{"oldEncryptedDataHash":"aabbccdd","encryptedData":"dGVzdA==","iv":"aabbccdd00112233aabbccdd","authTag":"aabbccdd00112233aabbccdd00112233","cekEncrypted":"dGVzdA==","cekIv":"aabbccdd00112233aabbccdd","cekAuthTag":"aabbccdd00112233aabbccdd00112233","cekKeyVersion":1,"cekWrapAadVersion":1}'
```

**Sub-variant (b) — cross-tenant:**
```bash
# Use the same curl pattern, substituting <other-tenant-att-id> for the attachment ID
```

**Sub-variant (c) — team-scoped attachment (strongest test):**
```bash
# Use the same curl pattern, substituting <team-att-id> for the attachment ID,
# while the session belongs to a member of that team with attachment access.
# The personal migrate route must return 404 regardless of team membership.
```

### Expected result

All three sub-variants:
- HTTP 404 response. No enumeration leak (response body does not reveal whether the attachment exists, belongs to another user, or is team-scoped).
- DB rows are unchanged for all three target attachments.

### Rollback

N/A — no DB write occurred.

---

## M9 — Adversarial: Malformed CEK fields in /migrate

**Adversarial classification**: Input validation enforcement.

Verifies: C5 request schema validation (Zod); per I5.3, row remains mode-0 on rejection.

### Pre-conditions

- A mode-0 personal attachment `<att-id>` belonging to `<test-user-email>` in entry `<entry-id>`.
- Valid auth cookie for `<test-user-email>`.

### Steps

Run each sub-variant independently. After each sub-variant, confirm the row is unchanged in `psql`.

**Sub-variant (a) — truncated cekEncrypted (too short to be a valid AES-256-GCM CEK wrap):**
```bash
curl -s -X PUT \
  http://<internal-hostname>/api/passwords/<entry-id>/attachments/<att-id>/migrate \
  -H "Cookie: authjs.session-token=<session-token>" \
  -H "Content-Type: application/json" \
  -d '{"oldEncryptedDataHash":"<valid-hash>","encryptedData":"<valid-b64>","iv":"<valid-24-hex>","authTag":"<valid-32-hex>","cekEncrypted":"dA==","cekIv":"aabbccdd00112233aabbccdd","cekAuthTag":"aabbccdd00112233aabbccdd00112233","cekKeyVersion":1,"cekWrapAadVersion":1}'
```

**Sub-variant (b) — wrong-length cekIv (not 24 hex chars):**
```bash
# Same as (a) but with cekIv set to "aabbccdd" (too short)
```

**Sub-variant (c) — non-hex cekAuthTag:**
```bash
# Same as (a) but with cekAuthTag set to "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ"
```

### Expected result

All three sub-variants:
- HTTP 400 `INVALID_REQUEST`.
- DB row for `<att-id>` remains `encryption_mode = 0` with all CEK columns NULL.

### Rollback

N/A — no DB write occurred.

---

## M10 — Adversarial: Stolen session — body-replacement attempt via mismatched oldEncryptedDataHash

**Adversarial classification**: Chosen-ciphertext body replacement by a session attacker (S1 defense).

Verifies: C5 I5.4 (hash check rejects mismatched body), `LEGACY_BODY_HASH_MISMATCH` error code (no information disclosure per I5.3 / S11).

### Pre-conditions

- A mode-0 personal attachment `<att-id>` belonging to `<test-user-email>` in entry `<entry-id>`.
- The attacker has a valid session cookie for `<test-user-email>` but has NOT downloaded the actual attachment body.
- Valid auth cookie.

### Steps

1. Submit a `/migrate` request with valid-looking but incorrect `oldEncryptedDataHash` (e.g., all zeros):
   ```bash
   curl -s -X PUT \
     http://<internal-hostname>/api/passwords/<entry-id>/attachments/<att-id>/migrate \
     -H "Cookie: authjs.session-token=<session-token>" \
     -H "Content-Type: application/json" \
     -d '{"oldEncryptedDataHash":"0000000000000000000000000000000000000000000000000000000000000000","encryptedData":"<attacker-chosen-b64>","iv":"aabbccdd00112233aabbccdd","authTag":"aabbccdd00112233aabbccdd00112233","cekEncrypted":"<attacker-cek>","cekIv":"aabbccdd00112233aabbccdd","cekAuthTag":"aabbccdd00112233aabbccdd00112233","cekKeyVersion":1,"cekWrapAadVersion":1}'
   ```

### Expected result

- HTTP 409 with error code `LEGACY_BODY_HASH_MISMATCH`.
- Response body does NOT reveal the expected hash or stored body bytes (S11 — no information disclosure).
- DB row for `<att-id>` is unchanged: `encryption_mode = 0`, `encrypted_data` is the original ciphertext.

### Rollback

N/A — no DB write occurred.

---

## M11 — Post-rotation forensic audit

Verifies: C7 I7.5 (`cekRewrappedAttachmentIds` in audit metadata), C10 (audit action fields), I11.3 (whitepaper forensic continuity).

### Pre-conditions

- M3 state (rotation completed with at least 2 attachments: one originally-mode-0 and one originally-mode-2).

### Steps

1. After M3 rotation completes, query the `audit_logs` table:
   ```sql
   SELECT id, action, metadata, created_at
   FROM audit_logs
   WHERE action = 'VAULT_KEY_ROTATION'
     AND actor_id = '<user-id>'
   ORDER BY created_at DESC
   LIMIT 1;
   ```
2. Inspect the `metadata` JSON field.

### Expected result

The `metadata` JSON object contains:
- `cekRewrapsAttempted`: integer ≥ 1.
- `cekRewrapsSucceeded`: equals `cekRewrapsAttempted` (all succeeded).
- `cekRewrapsFailed`: 0.
- `legacyAttachmentsMigrated` (or `legacyAttachmentsMigratedClientReported`): equals the count of mode-0 attachments that were migrated in this cycle (≥ 1 from M3).
- `mode0Residual`: 0 (guard A enforces this).
- `cekRewrappedAttachmentIds`: an array of attachment ID strings. Both attachments from M3 (the originally-mode-0 attachment ID and the originally-mode-2 attachment ID) appear in this list.
- `cekRewrappedAttachmentIdsOverflow`: `false` (the count is well under the 1000-entry cap).

**Overflow sub-variant** (optional, requires ≥ 1001 mode-2 attachments post-migration):
- `cekRewrappedAttachmentIds.length === 1000`.
- `cekRewrappedAttachmentIdsOverflow === true`.

### Rollback

N/A — read-only query.

---

## Adversarial scenarios summary

| ID | Attack surface | Mitigating contract | Section |
|----|---------------|---------------------|---------|
| M5 | DB write flips `cek_encrypted` to stale pre-rotation blob | C2 (`cekKeyVersion` in wrap AAD), C8a I8a.3 (AES-GCM auth failure) | Above |
| M6 | Concurrent migrate + rotate; advisory lock serialization | C5 I5.1, C7 I7.1 | Above |
| M8 | Forged `attachmentId` — cross-user, cross-tenant, team-scope | C5 I5.2, T12.5, T12.5b | Above |
| M9 | Malformed CEK fields — schema validation bypass | C3 / C5 Zod schema | Above |
| M10 | Stolen session; body replacement via `/migrate` | C5 I5.4 (`oldEncryptedDataHash`), S1 defense | Above |

---

## Rollback (global)

- The Prisma migration for Phase B is purely additive (5 new nullable columns on `attachments`, new `ATTACHMENT_LEGACY_MIGRATION` enum value). To roll back the code while keeping the DB schema, redeploy the Phase A binary; the new columns are ignored and new attachments continue to upload — but the upload route will 400 (Phase A does not supply CEK fields). Restore from a backup first if mode-2 attachments must remain accessible via Phase A code.
- To revert the schema: write a follow-up migration that drops the 5 new columns. Note that existing mode-2 rows become unreadable without the CEK columns; restore from backup before applying the revert migration.
- The `ATTACHMENT_LEGACY_MIGRATION` audit action enum value cannot be removed from a deployed Postgres enum without recreating the type — leave it (harmless if unused after rollback).
