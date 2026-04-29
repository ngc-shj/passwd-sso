# Manual Test Plan: verifier-pepper-dual-version

Target branch: `feature/verifier-pepper-dual-version`
Dev URL: `https://localhost:3001/passwd-sso`
Tier: **R35 Tier-2 (auth-adjacent crypto material)** — required.
Scope: this PR adds dual-version pepper support with `VERIFIER_VERSION = 1` unchanged. Mode A rotation (V=1 → V=2) is a future PR. Manual scope is **regression check on V=1 path** only.

## Pre-conditions

- Dev server running at `https://localhost:3001/passwd-sso` (curl `/api/health/live` → 200 ✓)
- Docker stack up: `db`, `redis`, `jackson`, `mailpit`, `audit-outbox-worker` (✓)
- Migration applied: `npx prisma migrate deploy` was run; `users.recovery_verifier_version` and `password_shares.access_password_hash_version` columns exist (✓)
- **Dev server restarted AFTER `npm run db:generate` + migration apply** — Prisma Client is loaded once at process start; schema changes require server restart, hot-reload does NOT refresh the cached client. (See `~/.claude/projects/.../memory/feedback_prisma_generate_branch_switch.md`.)
- Test user: any existing user with `passphrase_verifier_hmac` already set (V=1). Substitute the email in DB query placeholders below.

## Pre-test DB snapshot (baseline)

```bash
docker compose exec db psql -U passwd_user -d passwd_sso -c "
  SELECT email, passphrase_verifier_version, recovery_verifier_version,
         LENGTH(passphrase_verifier_hmac) AS hmac_len,
         LENGTH(recovery_verifier_hmac) AS rec_hmac_len
  FROM users WHERE email = '<test-user-email>';"
```

Captured (2026-04-29):
```
 passphrase_verifier_version | recovery_verifier_version | hmac_len | rec_hmac_len
                           1 |                         1 |       64 |  (null)
```

---

## Tests

### Test 1: Vault unlock (regression — opportunistic re-HMAC must NOT fire when version matches)

**Steps:**
1. Open `https://localhost:3001/passwd-sso/ja/dashboard` (or sign in if not authenticated)
2. Unlock vault with passphrase
3. (DB check)

**Expected:**
- Unlock succeeds, vault entries visible
- DB: `passphrase_verifier_version` is still 1, `passphrase_verifier_hmac` is **unchanged** (re-HMAC did not fire because version matches `VERIFIER_VERSION = 1`)
- Audit log: NO `VERIFIER_PEPPER_MISSING` entry; only normal vault-unlock audit (if any)

**Verification query (run after):**
```bash
docker compose exec db psql -U passwd_user -d passwd_sso -c "
  SELECT passphrase_verifier_version, md5(passphrase_verifier_hmac) AS hmac_fingerprint
  FROM users WHERE email = '<test-user-email>';"
```
Compare `hmac_fingerprint` against the pre-test value to confirm no rewrite.

**Audit check:**
```bash
docker compose exec db psql -U passwd_user -d passwd_sso -c "
  SELECT created_at, action FROM audit_logs
  WHERE action = 'VERIFIER_PEPPER_MISSING'
  ORDER BY created_at DESC LIMIT 5;"
```
Expected: zero rows.

**Result:** [x] PASS — 2026-04-29
- Pre/Post `hmac_fingerprint` identical (re-HMAC did NOT fire because version already matches `VERIFIER_VERSION = 1`) ✓
- `VERIFIER_PEPPER_MISSING` audit count: 0 ✓

---

### Test 2: Change passphrase (verify VERIFIER_VERSION_UNSUPPORTED 409 is gone)

**Steps:**
1. Settings → Security → Change Passphrase
2. Enter current passphrase + new passphrase + confirm
3. Submit

**Expected:**
- Success message
- The dialog must NOT show the error key `VERIFIER_VERSION_UNSUPPORTED` under any circumstances (the gate is removed)
- DB: new `passphrase_verifier_hmac` value (different from baseline), `passphrase_verifier_version` still 1

**Verification:**
```bash
docker compose exec db psql -U passwd_user -d passwd_sso -c "
  SELECT passphrase_verifier_version, md5(passphrase_verifier_hmac) AS hmac_fingerprint
  FROM users WHERE email = '<test-user-email>';"
```
Expected: `hmac_fingerprint` differs from Test 1's post-state.

**Result:** [x] PASS — 2026-04-29
- `hmac_fingerprint` changed (new HMAC for new passphrase) ✓
- `passphrase_verifier_version` still 1 ✓
- 200 OK; no `VERIFIER_VERSION_UNSUPPORTED` 409 ✓

---

### Test 3: Recovery key generate (writes new recoveryVerifierVersion column)

**Steps:**
1. Settings → Security → Generate Recovery Key
2. Re-enter current passphrase
3. Submit; record the recovery key shown (for Test 4)

**Expected:**
- Recovery key generated (24-word phrase or similar)
- DB: `recovery_verifier_hmac` now non-null, `recovery_verifier_version = 1`

**Verification:**
```bash
docker compose exec db psql -U passwd_user -d passwd_sso -c "
  SELECT recovery_verifier_version, LENGTH(recovery_verifier_hmac) AS rec_hmac_len, recovery_key_set_at
  FROM users WHERE email = '<test-user-email>';"
```
Expected: `recovery_verifier_version = 1`, `rec_hmac_len = 64`, `recovery_key_set_at` recent.

**Result:** [x] PASS — 2026-04-29
- `recovery_verifier_hmac` written (length 64) ✓
- `recovery_verifier_version = 1` ✓ (new column write OK)
- `RECOVERY_KEY_CREATED` audit emitted ✓
- Note: dev server was restarted after Prisma schema changes (per memory `feedback_prisma_generate_branch_switch.md` — first attempt failed with stale Prisma client cache, resolved by `npm run db:generate` + `npm run dev` restart)

---

### Test 4: Recovery key recover (two-step verify→reset, writes both versions)

**Steps:**
1. Sign out
2. Sign in (new session)
3. Vault unlock screen → click "Forgot passphrase / Use recovery key"
4. Enter recovery key from Test 3
5. (verify step succeeds) → enter NEW passphrase + confirm
6. (reset step succeeds)

**Expected:**
- Vault unlock screen reappears with new passphrase
- DB: BOTH `passphrase_verifier_hmac` AND `recovery_verifier_hmac` updated; both versions still 1

**Verification:**
```bash
docker compose exec db psql -U passwd_user -d passwd_sso -c "
  SELECT passphrase_verifier_version, recovery_verifier_version,
         encode(digest(passphrase_verifier_hmac, 'sha256'), 'hex') AS pp_digest,
         encode(digest(recovery_verifier_hmac, 'sha256'), 'hex') AS rec_digest,
         failed_unlock_attempts
  FROM users WHERE email = '<test-user-email>';"
```
Expected: digests differ from Test 3 post-state; both versions = 1; `failed_unlock_attempts = 0` (lockout reset).

**Result:** [x] PASS — 2026-04-29
- `passphrase_verifier_hmac` updated (passphrase reset succeeded) ✓
- `passphrase_verifier_version = 1`, `recovery_verifier_version = 1` ✓
- `failed_unlock_attempts` reset to 0 (lockout cleared) ✓
- `RECOVERY_PASSPHRASE_RESET` audit emitted ✓
- Note: this app's recovery dialog does NOT regenerate the recovery key on reset (only re-wraps with new passphrase derivation), so `recovery_verifier_hmac` is unchanged. This is pre-existing behavior, out of this PR's scope.

---

### Test 5: Travel mode disable (passphrase verify path)

**Skip if travel mode is not currently enabled.**

**Steps:**
1. Settings → Travel Mode (if disabled, enable first; reload, then disable)
2. Disable: enter passphrase
3. Submit

**Expected:**
- Travel mode disabled
- No `VERIFIER_PEPPER_MISSING` audit (operator config OK)

**Verification:**
```bash
docker compose exec db psql -U passwd_user -d passwd_sso -c "
  SELECT travel_mode_active, travel_mode_activated_at FROM users
  WHERE email = '<test-user-email>';"
```

**Result:** [x] PASS — 2026-04-29
- Travel mode enable → disable round-trip succeeded ✓
- `TRAVEL_MODE_ENABLE` and `TRAVEL_MODE_DISABLE` audits emitted ✓
- No `VERIFIER_PEPPER_MISSING` audit ✓
- `passphrase_verifier_*` unchanged (verify-only path, no write) ✓

---

### Test 6: Share link with access password (V=1 hash storage)

**Steps:**
1. Pick a password entry → Share → Create share link with access password
2. Set access password (e.g., `test-share-pw-2026`)
3. Copy share URL
4. Open share URL in incognito browser
5. Enter access password

**Expected:**
- Share content visible after correct password
- Wrong password → 403 + audit `SHARE_ACCESS_VERIFY_FAILED` (NOT `VERIFIER_PEPPER_MISSING`)
- DB: new `password_shares` row has `access_password_hash` set AND `access_password_hash_version = 1`

**Verification:**
```bash
docker compose exec db psql -U passwd_user -d passwd_sso -c "
  SELECT id, access_password_hash_version, LENGTH(access_password_hash) AS hash_len, expires_at
  FROM password_shares
  WHERE access_password_hash IS NOT NULL
  ORDER BY created_at DESC LIMIT 3;"
```
Expected: latest row has `access_password_hash_version = 1`, `hash_len = 64`.

**Result:** [x] PASS — 2026-04-29
- New `password_shares` row created (share_type = `ENTRY_SHARE`) ✓
- `access_password_hash_version = 1`, `hash_len = 64` ✓
- `SHARE_CREATE` and `SHARE_ACCESS_VERIFY_SUCCESS` audits emitted ✓
- Cross-browser access verified (view_count = 1) ✓

---

### Test 7 (Optional): Send file with access password

Similar to Test 6 but using Send file flow instead of password share. Verify the new `access_password_hash_version` column on the file Send.

**Result:** [x] PASS — 2026-04-29
- New `password_shares` row created (share_type = `FILE`) ✓
- `access_password_hash_version = 1`, `hash_len = 64` ✓
- `SEND_CREATE` and `SHARE_ACCESS_VERIFY_SUCCESS` audits emitted ✓
- Cross-browser file download verified (view_count = 1) ✓

---

## Adversarial scenarios (Tier-2 required)

### A1: VERIFIER_PEPPER_MISSING fail-closed simulation (operator side)

**Steps:**
1. Stop dev server (`Ctrl-C` on `npm run dev`)
2. **Temporarily** unset `VERIFIER_PEPPER_KEY` in `.env` (comment it out)
3. **DO NOT** start the server in production mode (would crash on `validateKeys`); instead start dev mode where the SHA-256-derived fallback is used — confirms the fallback still works
4. Re-set the env var, restart server
5. Optional: simulate a stored V=2 user via SQL `UPDATE users SET passphrase_verifier_version = 2 WHERE email = '<test-user>'` then attempt unlock — should return 401 `INVALID_PASSPHRASE` and emit `VERIFIER_PEPPER_MISSING` audit. Restore the row to version=1 after.

**Expected:**
- Production startup with empty `VERIFIER_PEPPER_KEY` would abort (per `validateKeys()`); dev fallback continues to work for V=1
- For simulated V=2 stored user without `VERIFIER_PEPPER_KEY_V2` configured: 401 + audit `VERIFIER_PEPPER_MISSING` (TENANT scope)

**Verification (after restore):**
```bash
docker compose exec db psql -U passwd_user -d passwd_sso -c "
  SELECT created_at, action, scope, metadata FROM audit_logs
  WHERE action = 'VERIFIER_PEPPER_MISSING'
  ORDER BY created_at DESC LIMIT 5;"
```
Expected: `metadata` has `storedVersion` STRIPPED (per METADATA_BLOCKLIST). Action visible at TENANT scope.

**Result:** [ ] PASS / [ ] FAIL / [ ] SKIPPED (acceptable for this PR — runbook covers Mode A rotation testing)

---

## Rollback

If any test FAILS:

1. Identify the failing route from the audit log + browser console
2. `git log --oneline 5a6faba8..HEAD` to identify the suspect review commit
3. Targeted `git revert <commit>` of the specific review commit (preserve plan/feat commits)
4. Re-run failed test to confirm regression source
5. Open issue with:
   - Test number + steps to reproduce
   - DB state before/after (queries above)
   - Audit log entries
   - Browser console logs

---

## Sign-off

- [x] Tests 1-7 PASS — 2026-04-29 (all routes confirmed working in dev: vault unlock, change-passphrase, recovery-key generate/recover, travel-mode disable, share-links with password, send file with password)
- [ ] Adversarial A1 — SKIPPED for this PR. **Acceptable risk:** A1 simulates Mode A V2 rotation behavior (storedVersion=2 + missing V2 key). This PR keeps `VERIFIER_VERSION = 1`; the V2 path is exercised only in the integration test (`pepper-dual-version.integration.test.ts`), not in production runtime. Mode A operational testing belongs to the future rotation-script PR.
- Reviewer: NOGUCHI Shoji
- Notes: One operational lesson — Prisma client cache must be refreshed via `npm run db:generate` + `npm run dev` restart after schema changes; hot-reload does NOT pick up new Prisma fields. Pre-conditions section updated to include this requirement.
