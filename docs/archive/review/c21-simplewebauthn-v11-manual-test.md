# Manual test plan: C21 — @simplewebauthn v9 → v11 migration

Replaces the fictional `npx playwright test passkey` gate (T1) and the unactionable round-trip-test claim (T2). Operator MUST execute all steps and check off the result list before commit.

## Pre-conditions

- Local dev environment: `npm run docker:up`, `npm run dev`
- Dev DB contains at least one pre-existing v9-format `webauthn_credentials` row. If absent, register one BEFORE applying the v11 code changes (re-checkout main, register a passkey, then checkout this branch).
- Ideally, the pre-existing credential is PRF-enabled so the auto-unlock path is exercised.
- Snapshot the DB row shape before the test:
  ```bash
  docker compose exec db psql -U passwd_user -d passwd_sso -c \
    "SELECT id, \"credentialId\", left(\"publicKey\", 20) AS pk_prefix, counter, \"prfSupported\" FROM webauthn_credentials LIMIT 5;"
  ```

## Steps

| # | Step | Expected | Status |
|---|------|----------|--------|
| 1 | `npm run dev` — confirm server boots clean (no v11 type errors at startup) | Next.js dev banner; no `@simplewebauthn` import errors in console | ☐ |
| 2 | Sign in as `<test-user-email>` using the existing passkey | Session cookie issued; redirected to dashboard | ☐ |
| 3 | Confirm vault auto-unlocks via PRF (only if the credential is PRF-enabled) | Vault is unlocked without manual passphrase prompt; password list is decrypted | ☐ |
| 4 | Register a NEW passkey from `/settings/security` → "Add passkey" | New row inserted in `webauthn_credentials`; `credentialId` shape (base64url string length) matches the pre-existing row | ☐ |
| 5 | Sign out, sign in with the NEW passkey | Session cookie issued; session metadata shows correct device | ☐ |
| 6 | Trigger reauth (vault sensitive op — e.g., reveal a password, change passphrase) | Reauth modal appears; passkey reauth succeeds; counter advanced in DB | ☐ |
| 7 | Simulate non-existent credential (timing-equalization branch). In DevTools, intercept the `/api/auth/passkey/verify` request and tamper the assertion `id` field to an unregistered base64url string. Submit. | Response is a generic auth failure (HTTP 401 / `null` from authorize). No 500. No "credential not found" leak that distinguishes from "verification failed". | ☐ |
| 8 | Verify the counter advanced in DB after step 5 + step 6 | `SELECT counter FROM webauthn_credentials WHERE id = ...` shows higher value than the pre-test snapshot | ☐ |

## Verification commands

After step 7, check the timing-equalization branch ran the full path (not a short-circuit):

```bash
# Tail dev server logs during step 7. The verifyAuthentication call should run
# even though the credential doesn't exist (dummy WebAuthnCredential is built).
# If the response time is &lt;< the real-credential time, the dummy branch may be
# short-circuiting — verify by adding console.time around the verifyAuthentication
# call temporarily.
```

After step 8, verify the DB row shape is unchanged from pre-v11:

```bash
docker compose exec db psql -U passwd_user -d passwd_sso -c \
  "SELECT id, \"credentialId\", length(\"credentialId\") AS cred_id_len, left(\"publicKey\", 20) AS pk_prefix, length(\"publicKey\") AS pk_len, counter FROM webauthn_credentials ORDER BY \"createdAt\" DESC LIMIT 5;"
```

- `cred_id_len` should be identical for both pre-v11 and post-v11 rows (base64url length depends on raw byte length; same authenticators produce same lengths).
- `pk_len` should be identical (COSE-encoded EC2/P-256 keys are 77 bytes → 103-char base64url).
- `pk_prefix` should start with the same hex pattern (typically `pQECAyYg...` for COSE P-256) on both pre/post rows.

## Expected result

All 8 checkboxes ticked; DB schema and row shapes byte-identical before/after; PRF auto-unlock still functions for the pre-existing credential; no console errors.

## Rollback

If any step fails:
1. `git revert <c21-commit-sha>` BEFORE deploying to staging/production.
2. `npm install` to restore v9.
3. Re-run the manual test plan on main to confirm baseline.
4. File a bug with the failing step number and capture network traces.

## Adversarial scenarios (R35 Tier-1 — verify before claiming complete)

- **Step 7** above is the timing-equalization adversarial check. The dummy
  credential must execute the full verifyAuthenticationResponse path under
  v11, otherwise credential enumeration becomes possible via response timing.
- **Cross-tenant**: the v11 migration does NOT change `withBypassRls` /
  `withUserTenantRls` boundaries. Spot-check: as user A, register a passkey;
  as user B in a DIFFERENT tenant, attempt to sign in with user A's credential
  ID (manually constructed) — must fail with the same generic auth-failure
  response as step 7.
- **Replay**: capture a valid passkey assertion from step 5; replay it
  immediately (within Redis TTL). Second attempt must fail (`getdel` is
  one-shot; counter CAS would also reject on counter mismatch).
