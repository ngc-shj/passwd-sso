# Plan: sso-claim-connection-binding

Issue: `#742`. Branch `feat/sso-claim-connection-binding`, base `main` 907f6fdd4.

## Project context

- Type: `web app` (Auth.js sign-in, Prisma schema, CLI). Tests: unit + real-PostgreSQL
  integration + E2E (Playwright) + CI.
- Verification environment constraints:
  - E1 — no browser-driven SAML sign-in exists in the repo. The Jackson behaviour this plan
    rests on was measured against a throwaway `boxyhq/jackson:1.52.2` (in-memory DB) with two
    self-signed IdPs and HTTP-level flows (M1–M7 below). The Auth.js side (that Auth.js with
    `checks: ["state","nonce"]` sends no `code_challenge` and authenticates with the client's
    own secret) is verified by a unit test over the provider config plus the same probe run
    against the app's token request shape; an end-to-end browser sign-in is listed in the
    manual-test file.

## Measured premise (replaces `#742`'s "Step 1 RESULT")

`#742` proposed binding claims to Jackson's `requested.tenant` / `requested.product`. Measured,
that value is not attested:

- M1: with PKCE, an attacker controlling IdP A appends `idp_hint=<A's connection clientID>` to
  the authorize URL the app generated for client B. Jackson accepts IdP A's signed response
  (`oauth.ts` ACS filter matches `session.requested.idp_hint`), issues a code, and the token
  endpoint returns 200 for client B — PKCE path checks no client credentials. userinfo then
  says `requested.tenant = tenantB`, `aud = B`. No `tenant`/`product` tampering needed.
- M2/M5: without PKCE, exchanging that code with B's own connection `clientID`/`clientSecret`
  returns 401 `Invalid client_id or client_secret` (Jackson compares against the authenticating
  connection's credentials). The global `dummy` verifier and tenant/product-encoded client ids
  do NOT block it (200).
- M3/M4: legitimate sign-ins through A and through B, no PKCE, own credentials: 200.
- M6: neither id_token nor userinfo carries any field naming the authenticating connection that
  the attacker cannot choose (`providerName`, `requested.*`, `aud` are authorize-time values).
- M7: with `FLATTEN_RAW_CLAIMS=true` an IdP can override the id_token's `requested` key (as a
  string); userinfo's `requested` object is not overridable.

So the only attested connection identity is **which Jackson client completed the token
exchange**, and only when that client is a connection's own `clientID`/`clientSecret` and the
exchange carries no PKCE. In Auth.js that is the provider id the sign-in arrived through.

## Objective

Make a tenant claim resolve only through the SSO connection it was registered for, so one
customer's IdP cannot place users into another customer's tenant on a deployment with several
SAML connections.

## Contracts

### C1 — one Auth.js provider per Jackson connection
- New env `AUTH_JACKSON_CONNECTIONS`: a JSON array of `{ id, name, clientId, clientSecret }`.
  `id` matches `^[a-z0-9-]{1,32}$` and is unique; `clientId` is a connection's own Jackson
  client id — refused at boot when it is `dummy`, or contains `=` or `&` (tenant/product
  encoding), since M2 shows those do not bind; `clientSecret` non-empty. Requires `JACKSON_URL`.
  Mutually exclusive with the legacy `AUTH_JACKSON_ID`/`AUTH_JACKSON_SECRET` (boot refuses both).
- Each entry becomes an OIDC provider with id `saml-jackson-<id>`, `checks: ["state", "nonce"]`
  (no PKCE — M1), the connection's client credentials, the existing `profile()` mapping.
- Legacy `AUTH_JACKSON_ID` keeps provider id `saml-jackson` and today's behaviour; it is a
  single-connection configuration (README's existing constraint).
- Control class: enforceable boundary. Adjudication authority: Jackson's token endpoint
  (credential comparison against the authenticating connection, measured M2/M5); the app's
  part is only to send no PKCE and the connection's own credentials, pinned by test.
- Member set of provider-id consumers (`rtk proxy grep -rn "saml-jackson" src scripts e2e`):
  `src/auth.config.ts`, `src/app/api/user/auth-provider/route.ts` (`OIDC_SAML_PROVIDERS`),
  `src/app/[locale]/auth/signin/page.tsx` (button), `src/lib/audit/auth-failure-mapping.ts`
  (provider → audit name), `scripts/env-descriptions.ts`. Each accepts `saml-jackson-<id>`
  through one exported predicate `isSamlJacksonProvider(id)`; the sign-in page renders one
  button per configured connection with its `name`.

### C2 — claim provenance recorded
- `tenant_claims.provider VARCHAR(64) NULL`, with a CHECK on `^[a-z0-9-]+$`. NULL means
  "provenance unknown" (every pre-existing row).
- Writers (member set from `check-tenant-claim-event-coverage.mjs`'s writer enumeration, re-run
  in Phase 2): sign-in auto-registration in `findOrCreateTenantForClaim` writes the sign-in's
  `account.provider`; `tenant-domain add` takes `--provider <id>` (validated against the same
  pattern; omitted → NULL); the CLI's re-point (`add --from`) and unrevoke paths set it from
  `--provider` when given and otherwise leave it. `tenant_claim_events` gains the same nullable
  column so routing history records which provider a registration was bound to.
- `tenant-domain list` shows the provider; a new `tenant-domain list --unbound` lists rows with
  NULL provider (the registrations strict mode will refuse).
- Control class: detection only (recording).

### C3 — binding adjudicator
- New env `AUTH_CLAIM_BINDING`: `off` (default) | `strict`.
- One function in `tenant-management.ts` decides, after `findClaimRow`, whether a row may be used
  by a sign-in arriving through provider P. Both readers (`resolveTenantByClaim`,
  `findOrCreateTenantForClaim`) call it; their signatures gain the sign-in provider.
- `strict`: a row whose `provider` is NULL → refusal arm `claim_unbound`; a row whose provider ≠
  P → refusal arm `claim_provider_mismatch`. Both carry the owning tenant (audit attribution as
  `claim_taken` does). New audit reasons `tenant_claim_unbound`,
  `tenant_claim_provider_mismatch` — in `CLAIM_REFUSAL_REASON`, `AuthLoginFailureReason`, the
  `tenant-domain unmapped` buckets (remedy text: re-declare with `add --provider`), and every
  test that enumerates them. A sign-in that creates a claim records P (C2), so it is bound.
- `off`: resolution unchanged; a provider mismatch on a bound row emits a structured warn
  `auth.tenant_claim.provider_mismatch` (provider ids and tenant id only) — detection for
  deployments not yet strict.
- Boot: `AUTH_JACKSON_CONNECTIONS` with more than one entry requires `AUTH_CLAIM_BINDING=strict`
  (refuse to start otherwise). This is new configuration, so no existing deployment changes
  behaviour; the single-connection legacy path is unaffected.
- Control class: fail-closed verification gate (strict). Adjudication authority: the provider id
  Auth.js reports for the callback (C1's boundary makes it attested).

### C4 — plumbing
- The signIn → createUser hand-off (`tenantClaimStorage`) carries `{ tenantClaim, provider }`;
  both sign-in paths pass `account.provider`. A missing provider with a present claim is a
  refusal (fail closed), not a fallback to NULL.

### C5 — docs
README (en/ja) SAML section: per-connection configuration, why PKCE is off for these providers
(M1), strict mode and migration (`list --unbound`, re-declare with `--provider`, enable strict);
`.env.example` via the generator; `docs/operations/alerts.md` for the new warn and reasons;
`#742` updated with the measured premise.

## Testing strategy

- C1: unit over the generated provider list — ids, `checks` exactly `["state","nonce"]`, client
  credentials per entry; env refusals (dummy, encoded id, duplicate id, both legacy and new set,
  missing `JACKSON_URL`); `isSamlJacksonProvider` allow/deny; sign-in page renders one button per
  connection. A probe script (`scripts/probes/jackson-connection-binding.mjs`, run in the manual
  test, not CI) reproduces M1/M2 against a throwaway Jackson.
- C2/C3: real-DB integration — strict: bound row + same provider → tenant; other provider →
  `claim_provider_mismatch`, no membership, no tenant created; NULL provider →
  `claim_unbound`; auto-registration records the provider; first-ever sign-in (createUser path)
  enforces the same; off: mismatch → resolves as today and warns. Unit: CLI `--provider`
  validation, `list --unbound`, bucket mapping of the new reasons; boot refusal for >1 connection
  without strict.
- Red proofs for each refusal arm (mutate on a scratch copy).

## Considerations & constraints

- SC1 — strict by default (a major release), with migration tooling beyond `list --unbound`.
- SC2 — Jackson upstream: PKCE path skips client authentication; expose the authenticating
  connection in userinfo. Reported upstream, not fixed here.
- SC3 — Google: `hd` is attested by Google; recorded and bound like any provider, nothing more.
- Binding to the claim key is not added: the IdP controls every attribute, so the key adds no
  attestation.
- Dropping PKCE on these providers: they are confidential clients (secret on the back channel,
  `state` + `nonce` checked); PKCE would disable Jackson's only client check (M1).

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | per-connection providers, no PKCE, attested provider id | pending |
| C2 | claim provenance column, writers, CLI | pending |
| C3 | binding adjudicator, strict mode, reasons, boot rule | pending |
| C4 | provider through the sign-in hand-off | pending |
| C5 | docs and issue update | pending |
