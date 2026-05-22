# Manual test plan: A02-8 — WebAuthn PRF per-credential salt

Replaces the missing passkey/PRF Playwright E2E gate (consistent with C21 review).
Operator MUST execute and check off all steps before commit.

## Pre-conditions

- `npm run docker:up && npm run dev` running locally.
- Dev DB has at least one pre-existing PRF-enabled credential
  (`prf_supported = TRUE`, `prf_salt IS NULL`). If absent, register one
  BEFORE applying the A02-8 code changes.
- Snapshot pre-state:
  ```bash
  docker compose exec db psql -U passwd_user -d passwd_sso -c \
    "SELECT \"credentialId\", prf_supported, prf_salt IS NULL AS is_v1, counter \
     FROM webauthn_credentials ORDER BY \"createdAt\" DESC LIMIT 10;"
  ```
- Substitute `<test-user-email>` with your test account email throughout.

## Steps

| # | Step | Expected | Status |
|---|------|----------|--------|
| 1 | `npm run dev` boots clean | No `derivePrfSaltV2` or `buildPrfExtensions` import errors in console | ☐ |
| 2 | Sign in by email with the existing v1 passkey | Vault auto-unlocks via PRF (v1 RP-global salt). Network tab on `/api/auth/passkey/options/email`: `response.options.extensions.prf.eval.first` present; `evalByCredential` absent | ☐ |
| 3 | Lock the vault; click "Unlock with passkey" (post-login PRF flow) | Vault unlocks. Network tab on `/api/webauthn/authenticate/options`: same v1 shape as step 2 | ☐ |
| 4 | Register a NEW passkey from `/settings/security` | DB row inserted with `prf_salt IS NOT NULL`. Verify via psql: `SELECT prf_salt FROM webauthn_credentials WHERE created_at > NOW() - INTERVAL '1 minute';` returns a 64-hex string | ☐ |
| 5 | Sign out, sign in by email with the NEW passkey | Vault auto-unlocks. Network tab on `/api/auth/passkey/options/email`: `response.options.extensions.prf.evalByCredential[<new credId base64url>]` present; the new cred id is keyed in evalByCredential. Mixed mode: `response.options.extensions.prf.eval.first` also present (v1 fallback for the existing legacy passkey) | ☐ |
| 6 | Lock vault, post-login re-unlock via the NEW passkey | Vault unlocks. Network tab on `/api/webauthn/authenticate/options`: same evalByCredential pattern | ☐ |
| 7 | Discoverable sign-in (`/auth/signin` → "Use a passkey" without entering email) using the v1 passkey | Vault auto-unlocks (legacy path; v1 RP-global salt still works) | ☐ |
| 8 | Discoverable sign-in using the NEW v2 passkey | Sign-in succeeds; **PRF auto-unlock FAILS**, user is prompted for passphrase. Documented behavior change. | ☐ |
| 9 | PRF rebootstrap (`/settings/security` → "Test" or "Re-bind PRF") on the v2 credential | Test ceremony succeeds. Network tab: `response.options.extensions.prf.evalByCredential[<credId>].first` is sent | ☐ |
| 10 | Reauth (vault sensitive op, e.g., reveal a password) with a v2 credential | Reauth modal succeeds. Counter advanced in DB | ☐ |
| 11 | Concurrent register-options race: open two tabs, click "Add passkey" in tab A, then again in tab B BEFORE completing tab A. Complete tab A's ceremony. | Tab A's `register/verify` returns 400 INVALID_CHALLENGE (tab B's salt overwrote tab A's; tab A's challenge no longer in Redis). User retries; no credential row created with mismatched salt+wrap | ☐ |
| 12 | Run the migration diagnostic | `MIGRATION_DATABASE_URL=<url> bash scripts/migrate-prf-per-credential-salt.sh` prints three lines: `v1_count|N`, `v2_count|M`, `prf_enabled_total|N+M`. Re-run produces identical output; DB row count unchanged | ☐ |

## Verification commands

After step 5, verify the persisted shape did not regress any pre-existing column:

```bash
docker compose exec db psql -U passwd_user -d passwd_sso -c \
  "SELECT \"credentialId\", length(\"credentialId\") AS cid_len, length(\"publicKey\") AS pk_len, \
          counter, prf_supported, prf_salt IS NOT NULL AS is_v2 \
   FROM webauthn_credentials ORDER BY \"createdAt\" DESC LIMIT 5;"
```

- `cid_len` / `pk_len` should match between pre-A02-8 and post-A02-8 rows (no encoding change).
- `is_v2 = TRUE` for the newly registered passkey; `is_v2 = FALSE` for the pre-existing one.

## Expected result

All 12 checkboxes ticked. DB schema migration applied cleanly. PRF auto-unlock works for v1 creds in all flows; works for v2 creds in all flows EXCEPT discoverable signin (documented).

## Rollback

If any step fails:
1. `git revert <A02-8 commit-sha>` BEFORE deploying to staging/production.
2. The migration column `prf_salt` is nullable, so reverting the code alone leaves a column that's safe to keep (no orphan data). Drop the column manually if desired:
   `ALTER TABLE webauthn_credentials DROP COLUMN prf_salt;`
3. Re-run the manual test plan on `main` to confirm baseline.

## Adversarial scenarios (R35 Tier-1)

- **Step 11**: Redis race condition. Plan v2 §C4 design (challenge+salt JSON envelope) makes this fail-safe (cred row never created with mismatched binding). Verify the resulting credential row count is unchanged after the race.
- **Cross-user salt leak**: register a passkey as user A; as user B, try to access user A's `prfSalt` via the credentials list API (`/api/webauthn/credentials`). Should 403 / not include the field unless owned. Spot-check.
- **Tampered Redis value**: if an operator manually `redis-cli SET webauthn:challenge:register:<userId> '{"challenge":"...","prfSalt":"nothex"}'`, the verify route should reject with VALIDATION_ERROR (defense-in-depth against tampered Redis values per plan v2 §C5).
- **Discoverable signin fallback UX**: confirm user-facing copy makes clear that v2 credentials require email signin for PRF auto-unlock. Step 8 must produce a useful passphrase prompt, not a confusing error.
