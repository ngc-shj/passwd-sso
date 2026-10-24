# Manual Test Plan: sso-claim-connection-binding

Target branch: `feat/sso-claim-connection-binding` (issue `#742`)
Dev URL: `https://localhost:3001/passwd-sso`
Tier: **R35 Tier-2 (authentication / tenant routing)** — required. No browser-driven SAML sign-in exists in the automated suites (plan E1). The C1 probe covers Jackson's token endpoint over HTTP. This file covers the browser sign-in through Auth.js.

## Pre-conditions

- Docker stack up: `db`, `redis`, `jackson` (`boxyhq/jackson:1.52.2`), `mailpit`. **Stop `audit-outbox-worker` and `retention-gc-worker` only if you run integration tests in between** (CLAUDE.md); this plan does not need them stopped.
- Migration `20261025000000_tenant_claim_provider` applied, `npm run db:generate` run, dev server restarted afterwards.
- Two SAML IdPs whose **entityIds and signing keys differ**, for example two test tenants of one IdP product, or two mock IdPs configured with different entity IDs. Call them IdP A and IdP B. Both assert `email` and an `organization` attribute.
- In the Jackson admin portal (`http://localhost:5225`), create two SSO connections, A → IdP A and B → IdP B. Note each connection's own `clientID` / `clientSecret`. Each connection's redirect URL allows `https://localhost:3001/passwd-sso/api/auth/callback/saml-jackson` (A) and `.../callback/saml-jackson-b` (B).
- Jackson's `FLATTEN_RAW_CLAIMS` is unset (the compose file does not set it).
- `.env` (or `.env.local`) for the app:

  ```bash
  JACKSON_URL=http://localhost:5225
  AUTH_JACKSON_ID=<connection A clientID>
  AUTH_JACKSON_SECRET=<connection A clientSecret>
  AUTH_JACKSON_CONNECTIONS='[{"id":"b","name":"IdP B","clientId":"<connection B clientID>","clientSecret":"<connection B clientSecret>"}]'
  AUTH_CLAIM_BINDING=strict
  AUTH_TENANT_CLAIM_KEYS=organization
  ```

- Every bind file this plan writes goes under a scratch directory **outside the repository**, for example `$TMPDIR`.

Reusable queries (read-only):

```bash
docker compose exec -T db psql -U passwd_user -d passwd_sso -c "SELECT claim, tenant_id, provider, created_by, revoked_at FROM tenant_claims ORDER BY created_at DESC LIMIT 5;"
docker compose exec -T db psql -U passwd_user -d passwd_sso -c "SELECT created_at, metadata->>'reason' AS reason, metadata->>'claim' AS claim, metadata->>'boundProvider' AS bound_provider, metadata->>'signInProviderRef' AS sign_in_ref, tenant_id FROM audit_logs WHERE action = 'AUTH_LOGIN_FAILURE' ORDER BY created_at DESC LIMIT 5;"
docker compose exec -T db psql -U passwd_user -d passwd_sso -c "SELECT seq, operation, claim, old_provider, new_provider, actor_label FROM tenant_claim_events ORDER BY seq DESC LIMIT 3;"
```

---

## Tests

### Test 1: boot refusals

**Steps:** start the dev server once with each change below, and restore `.env` afterwards.

| Change to `.env` | Expected |
|---|---|
| remove `AUTH_CLAIM_BINDING` | startup fails: `AUTH_CLAIM_BINDING: must be set to "strict" when 2 SSO providers can present a tenant claim; bind the existing tenant claims to their providers first (README: SSO tenant claim binding upgrade)` |
| `AUTH_CLAIM_BINDING=off` | the same refusal |
| `AUTH_CLAIM_BINDING=Strict` | refused: must be one of off, strict (lowercase) |
| `AUTH_JACKSON_ID=dummy` | refused: `AUTH_JACKSON_ID: client id is Jackson's global placeholder client, …` |
| B's entry with A's `clientId` | refused: same client id as `AUTH_JACKSON_ID` |
| as listed in Pre-conditions | starts |

Check that no refusal message contains a client secret or the raw JSON.

### Test 2: sign-in through each connection

**Steps:**
1. Open the sign-in page. Two SSO buttons are shown: `SSO` (or `SAML_PROVIDER_NAME`) and `IdP B`.
2. Sign in through A as a new user whose IdP A asserts `organization=acme-a`.
3. Sign out. Sign in through B as a new user whose IdP B asserts `organization=acme-b`.

**Expected:**
- Both sign-ins succeed.
- `tenant_claims` shows `acme-a` with `provider=saml-jackson`, created by `signin`, and `acme-b` with `provider=saml-jackson-b`.
- `tenant_claim_events`: one `register` row per claim, with `new_provider` set.
- In browser DevTools → Network: the authorize redirect to Jackson carries `state` and `nonce` and **no** `code_challenge`.

### Test 3: cross-connection claim refused under strict

**Steps:** sign in through **B** as a new user whose IdP B asserts `organization=acme-a`, which is A's claim.

**Expected:**
- The sign-in is denied, and no user, tenant or membership is created.
- `audit_logs`: an `AUTH_LOGIN_FAILURE` row with `reason=tenant_claim_provider_mismatch`, `claim=acme-a`, `boundProvider=saml-jackson`, a 16-hex `signInProviderRef`, and `tenant_id` = A's tenant. The row contains no `saml-jackson-b` string anywhere.
- The server log has `auth.tenant_claim.binding_refused` with `boundProvider: "saml-jackson"`, `signInProvider: "saml-jackson-b"`, `verdict: "provider_mismatch"`.
- `npm run tenant-domain -- unmapped` lists the denial under the provider-binding heading ("investigate first …"), with `boundProvider="saml-jackson"` and `signInProvider="saml-jackson-b"`.

### Test 3b: squatted claim, re-pointed

**Steps:**
1. Pick a claim value `acme-x` that is not registered. Sign in through **B** as a new user whose IdP B asserts `organization=acme-x`. This creates a new tenant, with `acme-x` bound to `saml-jackson-b`.
2. Sign in through **A** as the Test 2 user, with IdP A now asserting `organization=acme-x`.
3. Run `npm run tenant-domain -- add --tenant <A's tenant uuid> --domain acme-x --from <tenant created in step 1> --provider saml-jackson --by manual-test`.
4. Repeat the sign-ins from steps 1 and 2.

**Expected:**
- Step 2 is denied with `tenant_claim_provider_mismatch`, `boundProvider=saml-jackson-b`.
- Step 3 prints both tenants and the evidence (A's tenant: `saml-jackson` majority), then asks for confirmation. `history --domain acme-x` shows a `reassign` row with `oldProvider=saml-jackson-b` and `newProvider=saml-jackson`.
- After step 3, the A sign-in resolves to A's tenant, and the B sign-in is denied with `tenant_claim_provider_mismatch`.

### Test 4: `idp_hint` cross-connection attack (M1) fails

**Steps:**
1. Click the `IdP B` button. Copy the redirect URL to Jackson's `/api/oauth/authorize` before following it (DevTools → Network, "Preserve log").
2. Append `&idp_hint=<connection A clientID>`, open it, and authenticate at **IdP A**.

**Expected:** Jackson redirects to `/api/auth/callback/saml-jackson-b` with a code, and the token exchange fails: Jackson answers 401, and the app shows the Auth.js error page. No session is created. Repeat with `&code_challenge=<any>&code_challenge_method=S256` appended as well: still refused, because the app sends no `code_verifier`.

### Test 5: off mode, single provider

**Steps:** after Tests 2–3, remove `AUTH_JACKSON_ID` / `AUTH_JACKSON_SECRET` (connection A) and `AUTH_CLAIM_BINDING`, keeping only connection B, and restart. Sign in through B as a new user whose IdP B asserts `organization=acme-a`.

**Expected:** the app boots in off mode. The sign-in **resolves** to A's tenant, because off mode does not enforce the binding. The server log has `auth.tenant_claim.provider_mismatch` with `boundProvider: "saml-jackson"` (no longer configured) and `signInProvider: "saml-jackson-b"`. A sign-in presenting `acme-b` logs nothing. Restore `.env` afterwards.

### Test 6: upgrade runbook end to end

**Setup:** on `main`, configure Google + connection A. Create two tenants by sign-in, one through Google and one through A, and note their claims. On `main`, the legacy Jackson provider completes a sign-in only with `AUTH_REDIRECT_PROXY_URL` set (M10). If that is impractical, create both tenants through Google. Stop the app. Check out this branch, apply the migration and restart **without** `AUTH_CLAIM_BINDING`.

**Steps and expected:**
1. Startup is refused with the message from Test 1, which names the README section. Find `SSO tenant claim binding upgrade` in both `README.md` and `README.ja.md`.
2. `npm run tenant-domain -- list --unbound`: both claims are listed with `provider=-`, and each `members=` column names the provider its members use, with a `suggest=` value.
3. `npm run tenant-domain -- bind --from-members --out "$TMPDIR/claim-bind.tsv"`: the file is written with mode 0600, its header is `passwd-sso-claim-bind<TAB>v1`, and each claim line has a `#` flag line above it. Rerun the command: it refuses, because the file exists. Run it with `--out ./claim-bind.tsv`: it refuses, because the path is inside the git worktree.
4. Edit the file: keep one suggestion, and empty the other line's `provider`.
5. `npm run tenant-domain -- bind --apply "$TMPDIR/claim-bind.tsv" --by manual-test`: the summary lists the line to apply, and the prompt appears once. After confirmation the per-line table shows `bound`, and the emptied line is not applied. Rerun: `already bound`.
6. Bind the other claim interactively: `npm run tenant-domain -- bind --claim <claim> --provider google --by manual-test`. The evidence is printed before the prompt. `tenant-domain history --domain <claim>` shows a `rebind` row with `oldProvider=-` and `newProvider=google`.
7. Delete the file. `npm run tenant-domain -- list --unbound` lists nothing.
8. Set `AUTH_CLAIM_BINDING=strict` and restart: the app boots. Sign in through Google and through A, and both resolve to their tenants.

### Test 7: hardened legacy provider, stale secret

**Steps:** set `AUTH_JACKSON_SECRET` to a wrong value and restart. The app boots. Sign in through A.

**Expected:** the callback fails. The server log shows an `OperationProcessingError` from the token exchange (Jackson's non-JSON 401), and no session is created. Restore the secret afterwards.

---

## Results

| Test | Result | Notes |
|---|---|---|
| 1 | | |
| 2 | | |
| 3 | | |
| 4 | | |
| 5 | | |
| 6 | | |
| 7 | | |
