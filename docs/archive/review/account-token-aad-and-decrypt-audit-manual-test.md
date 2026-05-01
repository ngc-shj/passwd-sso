# Manual Test Plan: account-token-aad-and-decrypt-audit

R35 Tier-2 artifact for the `feat/account-token-aad-and-decrypt-audit` branch.

Triggered by: OAuth callback flow (Auth.js linkAccount/getAccount) + cryptographic-material change (AAD shape).

## Pre-conditions

- Local dev stack running:
  ```bash
  npm run docker:up
  npm run db:migrate     # latest migration (incl. OAUTH_ACCOUNT_TOKEN_DECRYPT_FAILURE enum)
  npm run dev            # Next.js
  ```
- Postgres reachable at the URL in `.env`.
- Audit outbox worker running in a separate shell:
  ```bash
  npm run worker:audit-outbox
  ```
- A Google OAuth application configured (Client ID/Secret in `.env`).
- A second test user account at the OAuth provider (for cross-user pivot test).
- `psql` CLI available.

Helpful aliases for the steps below:
```bash
alias pp='psql "$DATABASE_URL"'
ACC_PROV=google         # provider you sign in as
```

---

## Step 1 — Fresh OAuth link writes ciphertext under new AAD (positive path)

**Steps:**
1. Open `http://localhost:3000/ja/auth/signin`, click Google, complete OAuth.
2. After landing on the dashboard, query the row:
   ```sql
   SELECT id, user_id, tenant_id, provider, provider_account_id,
          substring(refresh_token, 1, 20) AS rt_prefix,
          substring(access_token, 1, 20) AS at_prefix,
          substring(id_token, 1, 20) AS idt_prefix
   FROM accounts
   WHERE provider = 'google'
   ORDER BY id DESC LIMIT 1;
   ```

**Expected:**
- `rt_prefix`, `at_prefix`, `idt_prefix` all start with `psoenc1:0:` (or current keyVersion).
- No `OAUTH_ACCOUNT_TOKEN_DECRYPT_FAILURE` event in `audit_logs` or `audit_outbox`.

**Rollback:** none — this is read-only verification.

---

## Step 2 — Round trip (sign-out → sign-in continues to work)

**Steps:**
1. Sign out from the dashboard.
2. Sign in again with the same Google account.
3. Inspect the audit log UI at `/ja/dashboard/audit-logs`.

**Expected:**
- Sign-in succeeds without re-authorization prompt at Google (refresh-token-based session).
- No `OAUTH_ACCOUNT_TOKEN_DECRYPT_FAILURE` events.
- Standard `AUTH_LOGIN` event present.

---

## Step 3 — TAMPERED audit fires on userId pivot (Vector A — adversarial)

**Pre-condition:** at least two users in `users` table (e.g., one Google sign-in + one magic-link).

**Steps:**
1. Identify the victim's google account row and an attacker user:
   ```sql
   SELECT id, user_id, provider, provider_account_id FROM accounts WHERE provider='google';
   SELECT id FROM users LIMIT 5;
   ```
2. Pivot the row to point to a different user (replace UUIDs):
   ```sql
   UPDATE accounts SET user_id = '<other-user-uuid>' WHERE id = '<victim-account-uuid>';
   ```
3. Sign in as that other user (or trigger any path that invokes Auth.js `getAccount`):
   - Easiest: Sign out current session, then sign in as the pivoted user. If that user uses magic-link, `getAccount` is still invoked during session validation depending on Auth.js callbacks.
4. Wait ~5 seconds for outbox worker to drain.
5. Check audit:
   ```sql
   SELECT action, scope, user_id, target_id, metadata
   FROM audit_logs
   WHERE action = 'OAUTH_ACCOUNT_TOKEN_DECRYPT_FAILURE'
   ORDER BY created_at DESC LIMIT 5;
   ```

**Expected:**
- One row in `audit_logs` with `action = 'OAUTH_ACCOUNT_TOKEN_DECRYPT_FAILURE'`, `metadata.kind = 'TAMPERED'`, `metadata.field = 'refresh_token'` (and/or other fields if multiple decrypted on this call).
- `audit_outbox` row was processed (status `SENT`).
- The pivoted user cannot use the redirected `refresh_token` (it's returned as `undefined` by getAccount).

**Rollback:**
```sql
UPDATE accounts SET user_id = '<original-victim-uuid>' WHERE id = '<victim-account-uuid>';
```

---

## Step 4 — Plaintext-write attack does NOT emit audit (S2 design trade-off)

**Steps:**
1. Replace the encrypted refresh_token with a plaintext value:
   ```sql
   UPDATE accounts SET refresh_token = 'attacker-injected-plaintext'
     WHERE id = '<account-uuid>';
   ```
2. Trigger getAccount (sign out and sign in as that user).
3. Check audit:
   ```sql
   SELECT count(*) FROM audit_logs
     WHERE action = 'OAUTH_ACCOUNT_TOKEN_DECRYPT_FAILURE'
     AND created_at > NOW() - interval '1 minute';
   ```

**Expected:**
- `getAccount` returns `refresh_token: undefined` (the plaintext is not returned verbatim).
- `audit_logs` contains **0 new** rows for this action (CORRUPT classification — operationally benign by design).
- Application log (pino) contains a `kind: "CORRUPT"` warn entry.
- User is forced to re-OAuth.

**Rationale (do not flag this as a bug):** the plaintext-write attack gains the attacker nothing — the value is rejected. Auditing every CORRUPT event would create alert fatigue from genuine storage corruption. The operational signal (forced re-OAuth) is the out-of-band detection.

**Rollback:** force re-OAuth (the row is now broken anyway).

---

## Step 5 — Existing dev row encrypted under prior AAD shape (migration verification)

**Pre-condition:** dev DB has at least one `accounts` row encrypted before this branch (i.e., AAD = `provider:providerAccountId`, no `userId`).

If the dev DB is fresh (no such rows): skip this step.

**Steps:**
1. Identify a candidate row (will have `psoenc1:` prefix but predates the branch):
   ```sql
   SELECT id, created_at FROM accounts ORDER BY created_at LIMIT 5;
   ```
2. Sign in as that user.
3. Wait ~5 seconds for outbox.
4. Check audit:
   ```sql
   SELECT action, metadata FROM audit_logs
     WHERE action = 'OAUTH_ACCOUNT_TOKEN_DECRYPT_FAILURE'
     ORDER BY created_at DESC LIMIT 1;
   ```

**Expected:**
- `kind = 'TAMPERED'` (old AAD does not match the new `userId:provider:providerAccountId` shape).
- `refresh_token` returned as undefined → user prompted to re-OAuth → after re-OAuth, the row is rewritten under new AAD.

**This confirms the dev-phase migration story articulated in the plan.**

---

## Step 6 — i18n labels render in both locales

**Pre-condition:** at least one `OAUTH_ACCOUNT_TOKEN_DECRYPT_FAILURE` event exists (from any prior step).

**Steps:**
1. Open `http://localhost:3000/ja/dashboard/audit-logs` — find the event.
2. Open `http://localhost:3000/en/dashboard/audit-logs` — find the same event.

**Expected:**
- ja: `OAuthアカウントトークンの改ざんを検出`
- en: `OAuth account token tampering detected`

---

## Step 7 — `:` in provider/providerAccountId rejected at linkAccount

**Pre-condition:** ability to drive the OAuth callback with controlled values.

Easiest path: write a temporary script invoking the adapter directly.

**Steps:**
```bash
cat > /tmp/test-colon.ts <<'EOF'
import { createCustomAdapter } from "@/lib/auth/session/auth-adapter";
const adapter = createCustomAdapter();
adapter.linkAccount({
  userId: "<existing-user-uuid>",
  type: "oidc",
  provider: "saml:malicious",
  providerAccountId: "g-1",
  refresh_token: "rt",
}).then(
  () => console.log("BUG: should have thrown"),
  (e) => console.log("OK:", e.message),
);
EOF
npx tsx /tmp/test-colon.ts
```

**Expected:** prints `OK: AccountTokenAad field contains reserved delimiter ':'`. No row inserted into `accounts`.

**Cleanup:** `rm /tmp/test-colon.ts`.

---

## Adversarial scenarios (Tier-2)

Already covered above:

- **Cross-tenant ciphertext substitution** — Step 3 (uses cross-user pivot, which is the in-scope subset; cross-tenant is structurally impossible due to `@@unique([provider, providerAccountId])`).
- **Token-replay via DB write** — Step 4 (plaintext injection rejected).
- **Old-AAD ciphertext replay** — Step 5 (TAMPERED, forced re-OAuth).
- **Delimiter-collision aliasing** — Step 7 (rejected at write time).

Additional adversarial considerations (do not require steps but are worth mentioning to the on-call SIEM consumer):
- An attacker who cannot read the `psoenc1:` ciphertext but can rewrite the value still cannot recover plaintext. Their best outcome is forcing the user to re-OAuth (availability nuisance, not confidentiality).
- TAMPERED audit emission rate is bounded by Auth.js OAuth callback rate.

---

## Rollback (whole-branch revert)

If a regression surfaces and the branch is reverted:

1. `git revert 31a8791d 71733509 1cc740f0 4bc86dbf` (in reverse order on a separate branch).
2. The Prisma `AuditAction` enum value `OAUTH_ACCOUNT_TOKEN_DECRYPT_FAILURE` cannot be removed via Prisma migration without a custom raw SQL `ALTER TYPE ... DROP VALUE` step — leave the enum value in place; it becomes unused.
3. After revert, existing rows encrypted under the new AAD (`userId:provider:...`) will fail decryption under the reverted code (which uses old AAD `provider:providerAccountId`). All affected users will be forced to re-OAuth — recoverable, but expect a sign-in spike.
4. Plaintext fallback re-instated by the revert means any rows where decrypt fails will silently return whatever bytes are stored — verify no plaintext was injected during the brief window the new code was deployed.
