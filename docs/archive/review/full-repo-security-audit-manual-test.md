# Manual Test Plan: Full-Repo Security Audit Remediation (S1–S10)

R35 Tier-2 artifact for `fix/security-audit-remediation-v2`. The gate fired
on `src/app/api/mcp/.well-known/oauth-authorization-server/route.ts` (IdP
metadata surface, S9). Adversarial scenarios cover the other auth/crypto
findings changed in the same diff.

Audit report: [full-repo-security-audit-code-review.md](./full-repo-security-audit-code-review.md)

## Pre-conditions

- Dev stack running (`npm run docker:up`), app reachable on the dev origin.
- A tenant with an admin user, vault set up, and at least one MCP client
  registered (one static, one via DCR `POST /api/mcp/register`).
- `APP_URL` (or `AUTH_URL`) set in `.env` for the positive cases; unset for
  the fail-closed case.
- Extension built from this branch and loaded unpacked.

## Steps

### S9 — OAuth discovery metadata fail-closed

1. With `APP_URL` set, request `GET /api/mcp/.well-known/oauth-authorization-server`.
2. Confirm 200 and that every advertised endpoint URL uses the configured
   origin (no request-Host-derived URLs).
3. Stop the app, unset `APP_URL` and `AUTH_URL`, restart.
4. Repeat the request.

**Expected result**: step 2 returns 200 with origin-pinned URLs; step 4
returns 500 (server misconfiguration), NOT metadata built from the
request's Host header.

### S1 — Consent screen redirect_uri + DCR warning

1. Start an OAuth authorize flow for the DCR-registered client.
2. On the consent screen, confirm the exact `redirect_uri` is displayed and
   the amber DCR warning block is shown.
3. Repeat with the static client: `redirect_uri` shown, no DCR warning.

### S7 — Tailscale header trust opt-in

1. With `TRUST_TAILSCALE_SERVE_HEADERS` unset (default false), send a
   request with forged `Tailscale-User-Login` / serve headers from off-tailnet.
2. Confirm the headers are ignored (no serve-ingress normalization applied).
3. Set `TRUST_TAILSCALE_SERVE_HEADERS=true`, restart, and confirm requests
   via tailscale serve are normalized as before.

## Adversarial scenarios (Tier-2)

- **Redirect-URI manipulation (S1)**: register a DCR client whose name
  mimics a trusted client but with an attacker-controlled `redirect_uri`.
  Verify the consent screen surfaces the attacker URI and the DCR warning,
  giving the user the signal to deny.
- **Scope elevation (S2)**: obtain an MCP token WITHOUT `credentials:use`
  (e.g. only `credentials:list`) and call `POST /api/vault/delegation`.
  Expected: 403 — delegation requires `credentials:use` (or legacy
  `credentials:decrypt`).
- **Authorization-code replay after step-up block (S8)**: with tenant
  passkey enforcement on and a non-passkey session, start the OAuth code
  exchange. Expected: the exchange is rejected BEFORE the code is consumed;
  after completing step-up, the SAME code still exchanges successfully
  (blocked attempt did not burn it).
- **Header forgery (S7)**: as above, forged Tailscale-* headers off-tailnet
  must not grant serve-ingress treatment while the opt-in env is false.
- **KDF metadata poisoning (S10a)**: `POST /api/vault/setup` with
  `kdfParams.kdfType=1` (valid Argon2id params). Expected: 400
  VALIDATION_ERROR; user row unchanged (no kdfType=1 persisted while the
  wrapping KDF is PBKDF2).
- **Content-script origin abuse (S4)**: from a page on
  `attacker.example`, have the content script request
  `AUTOFILL_FROM_CONTENT` with a LOGIN entryId bound to another host.
  Expected: `ORIGIN_MISMATCH`; no password message reaches the tab. A
  sender without a tab URL is also rejected (fail closed).

## Rollback

- Code: revert the branch commit(s) before merge; no migrations or schema
  changes are included.
- Config: the only new env key is `TRUST_TAILSCALE_SERVE_HEADERS`
  (default false = prior behavior for non-tailscale deployments; tailscale
  serve deployments must set it to true to retain header-based detection).
  Removing the key restores the fail-closed default.
- No data backfill or key rotation involved; S10b changes the derivation
  call shape only (output bytes pinned identical by golden-vector tests).
