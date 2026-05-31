# Manual Test Plan: personal-history-aad-mismatch (Part A + B)

R35 Tier-2 (cryptographic-material change: AAD format unification + key-rotation
path + emergency-access / webhook / OAuth-token re-encryption). Automated tests
(app vitest, extension, iOS XCTest, DB-integration round-trips) cover the byte
contracts; the steps below cover what tests cannot — real browser E2E decrypt,
key rotation in the running app, and the breaking-change recovery flows.

## Pre-conditions
- Dev stack up: `docker compose up -d db`, `npm run dev`.
- A logged-in user with an **unlocked** vault (browser). The dev vault was
  reset earlier, so it is fresh at keyVersion 1 — re-import or create entries first.
- For the breaking-change flows, a second user / a configured webhook / a linked
  OAuth account as noted per step. Substitute `<test-user-email>` locally; do
  not commit real addresses.

## Steps / Expected

### A1 — Headline fix: personal entry change-history decrypts (was the bug)
1. Create a personal **login** entry, save.
2. Edit it (change the password) and save → this snapshots the prior blob to history.
3. Open the entry → expand **変更履歴 / Change history** → click **View** on the older version.
- **Expected:** the old version decrypts and renders (sensitive fields masked).
  Before this change it failed with "Failed to decrypt history version".

### A2 — History decrypt for non-login types
1. Repeat A1 with a **credit-card** and an **identity** entry (edit once each).
- **Expected:** history View decrypts for every entry type (aadVersion ≥ 1).

### A3 — Key rotation with history present (Part A C2)
1. With at least one entry that has history (from A1), rotate the vault key
   (change master passphrase / rotate-key in settings).
- **Expected:** rotation **completes** (previously it aborted whenever history
  existed). Re-open the entry → View history → still decrypts under the new key.

### A4 — keyVersion stamping after rotation (Part A keyVersion fix)
1. After A3 (vault now at keyVersion 2), create a new entry and import a few via CSV.
2. Inspect the new rows' `key_version` (DB) — `SELECT key_version FROM password_entries WHERE user_id=<id> ORDER BY created_at DESC LIMIT 5;`
- **Expected:** new/imported entries are stamped with the **current** key version
  (2), not hardcoded 1.

### B1 — Account OAuth token (AC reformat, breaking, self-healing)
1. With a linked OAuth (Google) account whose token predates this change, trigger
   a flow that reads the stored token (or just sign in again).
- **Expected:** the old (colon-AAD) token fails to decrypt and the user is
  transparently asked to re-authorize; after re-auth the row is rewritten and
  works. No hard error surfaced to the user. *(operator-only; needs a real IdP.)*

### B2 — Webhook secret (WH reformat, breaking)
1. With a pre-existing tenant/team webhook, observe a delivery (signature uses the
   secret) → it will fail to verify against the old (pipe-AAD) secret.
2. Regenerate the webhook secret in settings.
- **Expected:** after regeneration, deliveries sign/verify correctly. *(operator-only.)*

### B3 — Emergency access escrow (EM reformat, breaking)
1. With a pre-existing confirmed emergency-access grant, the grantee attempts to
   access the grantor's vault.
- **Expected:** the old (pipe-AAD) escrow fails to unwrap; the grantor must
  re-establish the grant; a freshly re-established grant works end to end.
  *(operator-only; needs grantor + grantee.)*

## Adversarial scenarios (Tier-2)
- **Cross-entry / cross-user transplant:** moving one entry's `encrypted_blob`
  into another row (different entryId/userId) must fail to decrypt (AAD binds
  userId+entryId). Covered by `aad-parity.test.ts` anti-vacuous + the integration
  round-trip's wrong-AAD rejection; spot-confirm in DB if desired.
- **Scope confusion:** a blob sealed under one scope must not decrypt under
  another (PV vs OV, blob vs overview). Covered by the parity/round-trip suites.

## Rollback
- Code: revert the branch (no schema migration in Part B; Part A's `AuditAction`
  enum-recreate migration `20260531030918_remove_entry_history_reencrypt_audit_action`
  would need a forward migration re-adding the value if rolled back — pre-1.0,
  no rows used it).
- Data: full pre-work dev backup at `~/passwd-sso-backups/passwd_sso-20260531-103630.sql.gz`.

## Results (2026-05-31, dev — operator: account owner)
- **A1: PASS** — history View decrypts in the browser; DB shows history records present at key_version 2.
- **A2: PASS** — credit-card / identity history View decrypts (UI); a CREDIT_CARD entry persists at key_version 2.
- **A3: PASS** — key rotation completed with history present (users.key_version 1→2); all entries (409) and history rows (1972) re-encrypted to key_version 2.
- **A4: PASS** — vault rotated to v2 at 05:52:33; a LOGIN entry created at 05:55:33 (post-rotation) is stamped key_version **2** (current), not the old hardcoded 1. Zero key_version-1 entries remain. keyVersion fix confirmed in the running app.
- B1 / B2 / B3: **N/A** — operator-only breaking-change recovery flows (multi-user / real IdP / webhook delivery); not exercised in this dev pass.
