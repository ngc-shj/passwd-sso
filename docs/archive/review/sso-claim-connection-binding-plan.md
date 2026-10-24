# Plan: sso-claim-connection-binding

Issue: `#742`. Branch `feat/sso-claim-connection-binding`, base `main` 907f6fdd4. Revision 2.

## Project context

- Type: `web app` (Auth.js sign-in, Prisma schema, CLI). Tests: unit + real-PostgreSQL
  integration + E2E (Playwright) + CI.
- Verification environment constraints:
  - E1 — no browser-driven SAML sign-in exists in the repo. The Jackson behaviour was measured
    against throwaway `boxyhq/jackson:1.52.2` and `:1.42.0` (in-memory DB) with two self-signed
    IdPs, HTTP-level flows, and the token request sent through the repo's own `oauth4webapi`
    3.8.4 with `ClientSecretBasic` (the shape Auth.js v5 sends). A committed probe re-runs this
    in CI (C1). A browser sign-in through Auth.js is in the manual-test file.

## Measured premise

`#742` proposed binding claims to Jackson's `requested.tenant`/`product`. Measured (M1–M11):

- M1: with PKCE, an attacker controlling IdP A appends `idp_hint=<A's clientID>` to the authorize
  URL the app generated for client B. Jackson accepts IdP A's signed response (the ACS filter
  matches `session.requested.idp_hint`) and the token endpoint returns 200 for client B —
  Jackson's PKCE branch does not authenticate the client. userinfo says `requested.tenant=B`,
  `aud=B`. Same on 1.42.0.
- M2/M5/M8: without PKCE, exchanging that code with B's own connection credentials (body or
  `Authorization: Basic`) returns 401 on both versions. Legitimate exchanges return 200. The
  global `dummy` verifier and tenant/product-encoded client ids do not bind (200).
- M9: if the attacker adds a `code_challenge` to that URL and the app sends **no** `code_verifier`,
  401; if the app sends any verifier matching the attacker's challenge, 200 and the client secret
  is never checked. The app must never put a `code_verifier` on the wire for these providers.
- M10: Jackson rejects an authorize request without `state` ("Please specify a state…") on both
  versions — today's legacy provider (default `checks: ["pkce"]`, no state) cannot complete a
  sign-in, so hardening it removes no working configuration.
- M6: no field in id_token or userinfo names the authenticating connection in a way the attacker
  cannot choose. M7: with `FLATTEN_RAW_CLAIMS=true` an IdP can override id_token `requested` and
  `nonce` and userinfo `aud`/`clientID`.

So the attested connection identity is **which Jackson client completed a no-PKCE exchange with
its own credentials** — in Auth.js, the provider id of the callback.

## Objective

A tenant claim resolves only through the SSO provider it is bound to, and no SAML sign-in can be
completed through one Jackson connection's client with another connection's IdP.

## Contracts

### C1 — Jackson providers bound to one connection each
- Providers: the legacy `AUTH_JACKSON_ID`/`AUTH_JACKSON_SECRET` keeps id `saml-jackson` (existing
  `Account` rows and token AAD are untouched); `AUTH_JACKSON_CONNECTIONS` (JSON
  `[{ id, name, clientId, clientSecret }]`) adds `saml-jackson-<id>` per entry. Both may coexist.
- Every Jackson provider: `checks: ["state", "nonce"]`, Auth.js default `client_secret_basic`
  (M8), the connection's own client id. Refused wherever providers are built and in every
  `NODE_ENV`: `dummy`, ids containing `=`/`&` (encoded), the `fed_` federation prefix, duplicate
  `id`, duplicate `clientId` across legacy and entries, an `id` outside `^[a-z0-9-]{1,32}$`.
  Refusal messages never contain a secret or the raw JSON.
- One parser module (`src/lib/auth/jackson-providers.ts`, no prisma import) returns the provider
  list; `auth.config.ts`, `env-schema.ts` (the production "at least one provider" rule), the
  sign-in page (`hasSaml`/`hasSso`, one button per provider) and `isJacksonProviderId(id)`
  (membership in the configured set, not a prefix) read it. Consumers derived from both
  `rtk proxy grep -rn "saml-jackson\|AUTH_JACKSON" src scripts infra docs`: also
  `src/app/api/user/auth-provider/route.ts`, `src/lib/audit/auth-failure-mapping.ts`,
  `scripts/env-descriptions.ts` + `.env.example` (new var, `secret: true`), `infra/terraform/ecs.tf`
  secrets, `docs/setup/*`, README env tables. The `id` is immutable (renaming orphans accounts
  and bindings); each Jackson connection's `redirectUrl` must allow
  `/api/auth/callback/<provider id>`.
- `allowDangerousEmailAccountLinking` is never set on a Jackson provider.
- Control class: enforceable boundary, conditional on: no `code_verifier` on the wire (M9 —
  pinned by a wire-level test), each connection's own credentials, a Jackson version the probe
  passes, SAML connections whose IdPs have distinct entityIds and signing keys (Jackson selects
  candidates by Issuer; stated in docs, SC5). Adjudication authority: Jackson's token endpoint.

### C2 — binding mode
- Claim-presenting providers: `google` when configured, every Jackson provider. When there are
  two or more, binding is strict regardless of configuration; `AUTH_CLAIM_BINDING=strict` forces
  it with one. No configuration selects off with two or more.
- Control class: fail-closed gate; computed once from the C1 parser and the Google env.

### C3 — claim provenance recorded
- `tenant_claims.provider VARCHAR(64) NULL`, CHECK on the shared provider-id pattern (one TS
  constant, parity-tested against the CHECK). NULL = provenance unknown.
- `tenant_claim_events.old_provider`, `.new_provider` (nullable, same CHECK); column INSERT grants
  for `passwd_app` in a migration, `scripts/checks/app-role-denied-privileges.json` columnGrants,
  `bootstrap-rds-roles.mjs`, `db-grants-manifest.json`; the BEFORE DELETE deregister trigger
  copies `OLD.provider`; `tenant-domain history` prints them.
- Writers: sign-in registration (both `tenant.create` arms) records the presenting provider;
  `tenant-domain add --provider <full provider id>` records it (create and unrevoke arms);
  `add --from` re-point sets it from `--provider` or resets it to NULL, shown in the preview;
  new `tenant-domain bind --claim <c> --provider <id> --by <label>` changes the binding of an
  existing active row — CAS on `(tenant_id, provider, revoked_at)`, event operation `rebind`
  (CHECK widened, `check-tenant-claim-event-coverage.mjs` updated), prints the account providers
  of the tenant's active members and refuses when none use `<id>` unless `--accept-unused-provider`.
  `--provider` is validated against the configured provider set when the app env is present,
  otherwise against the pattern with a warning. Flags registered in `tenant-domain-flags.ts`.
- `tenant-domain list` shows the provider; `list --unbound` lists rows strict mode refuses
  (NULL, or a provider no longer configured), using the adjudicator's predicate.

### C4 — binding adjudicator
- One function in `tenant-management.ts` decides after `findClaimRow` (which now selects
  `provider`); `resolveTenantByClaim` and `findOrCreateTenantForClaim` take the sign-in provider
  (required) and call it. Arm order: revoked (existing `claim_taken`) → in strict, NULL provider
  → `claim_unbound`, provider ≠ sign-in → `claim_provider_mismatch`. Both arms carry the owning
  tenant and exist in `ClaimLookup` and `ClaimTenantResolution`.
- Reasons `tenant_claim_unbound`, `tenant_claim_provider_mismatch`; audit metadata adds
  `signInProvider` and `boundProvider` (deployment-defined ids). Consumers to change:
  `refusalFromLookup`, `claimRefusalOf`, `lookupRefusalReason`, `SignInTenantResult.reason`,
  `TenantClaimUnusableError` kinds, `ClaimRefusalKind`, `CLAIM_REFUSAL_REASON`,
  `UNMAPPED_SELECTED_REASONS`, a new `UNMAPPED_BUCKET` (heading: investigate first — a mismatch
  is the attack's signature; bind only to the provider the tenant's members use, `tenant-domain
  bind`), README cause table (en/ja), `docs/security/audit-log-schema.md` (also add the missing
  `tenant_claim_system_tenant`), `check-audit-metadata-narrative.mjs` allowlist.
- Off mode (single claim provider, not forced): resolution unchanged; a mismatch on a bound row
  logs `auth.tenant_claim.provider_mismatch` (provider ids, tenant id). With one claim provider
  this fires only for rows bound to a provider no longer configured — stated.
- Auto-registration under strict records the presenting provider, so a claim squatted through
  one connection is unusable by another until an operator binds it; the bucket text says so.

### C5 — provider through the sign-in hand-off
- `ensureTenantMembershipForSignIn(userId, account, profile)` reads the provider from `account`
  (required); `tenantClaimStorage` becomes `{ tenantClaim, provider }` set together, read by
  `createUser`. A claim present with no provider is refused (`provider_error`, logged) — no NULL
  fallback. `route.ts`'s initial store gains `provider: null`.

### C6 — docs
README (en/ja) SAML section rewritten (per-connection config, why PKCE is off — M1/M9, nonce as
the code-injection control, `FLATTEN_RAW_CLAIMS=false` required, distinct IdP entityIds, strict
rules, migration: `list --unbound` → `bind`), `docs/setup/*`, `docs/operations/alerts.md`, the
cookie comment in `auth.config.ts` (login CSRF rests on state, not PKCE, for Jackson), `#742`
updated with M1–M11.

## Testing strategy

- C1 wire test (unit, `@auth/core`'s real sign-in and callback, `fetch` mocked at the network
  boundary): authorize URL carries `state` and `nonce`, no `code_challenge`; token request has
  `Authorization: Basic` with that provider's credentials and no `code_verifier`; each provider
  uses its own entry. Red: `pkce` added; two entries' secrets swapped.
- C1 probe (`scripts/probes/jackson-connection-binding.mjs`, committed, keys generated at run
  time, asserts and exits non-zero): M8a/M8c 200, M8b 401, M9 without verifier 401, positive
  control M1 (PKCE) 200. Runs in `ci-integration.yml` via `docker run` of Jackson pinned by digest
  (image parameterised), teardown registered first.
- C1/C2 env: one parser; allow/deny matrix (1 Jackson + off; 2 → strict; Google + 1 → strict;
  legacy + entries; each refusal paired with an adjacent allow); no secret in any message;
  consumer tests (`toAuditProvider`, auth-provider route, sign-in page parity with registered
  ids, env-schema production rule with only the new var); `isJacksonProviderId` adjacency.
- C3/C4/C5 real-DB integration on the app role, through the production entry points
  (`ensureTenantMembershipForSignIn` for existing users via resolve and via create;
  `createUser` under `tenantClaimStorage.run`): grid of row state (bound-same, bound-other,
  NULL) × mode × path, including a Google strict allow cell. Each refusal asserts no
  `users`/`tenants`/`tenant_members`/`tenant_claims`/`tenant_claim_events` delta and an audit row
  with the reason, `signInProvider`, `boundProvider` and the owning tenant. Off-mode warn: payload
  key set pinned, negative controls (bound-same, NULL). C5 missing-provider refusal. Concurrent
  first registration through two providers (`raceTwoClients`, 50×): one tenant, one binding, the
  loser `claim_provider_mismatch`. CLI: every writer arm with and without `--provider` (claim row
  and event row), `bind` CAS and refusal, `list --unbound` with a bound negative control,
  `add --provider X` → strict sign-in through X resolves. Column grant asserted with
  `has_column_privilege`. CHECK accept/deny on both columns.
- Typed fixtures for claim rows (explicit `provider`), arm tables as `Record<kind, …> satisfies`,
  `importOriginal` spreads, and the store type's `provider` required so every literal site fails
  to compile until updated.
- Red proofs named per mutation in Phase 2 (mismatch allowed, NULL matched, provider dropped in
  createUser, provider constant, `pkce` in checks, prefix predicate), allow arms included.

## Considerations & constraints

- SC1 — strict as the single-provider default (a major release).
- SC2 — Jackson upstream: PKCE path skips client authentication; 401 bodies are not JSON;
  timing-unsafe secret compare. Reported upstream.
- SC3 — an opt-out for sign-in auto-registration (closes squatting; `#742`'s note applies).
- SC4 — more than one provider per claim (one customer, two IdPs; Google and SAML on one domain).
- SC5 — Jackson admin-API checks at boot for shared IdP entityIds/certs and OIDC-backed
  connections; documented as preconditions here.
- SC6 — generic labels or home-realm discovery instead of one named button per connection.
- Binding to the claim key is not added: the IdP controls every attribute.
- `sessionMetaStorage.provider` already exists for audit; C5 keeps the tenant-claim store as the
  single carrier for the binding decision and asserts the two agree in `createUser`.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | Jackson providers bound to one connection each | pending |
| C2 | binding mode derived from claim-presenting providers | pending |
| C3 | provenance columns, grants, writers, CLI | pending |
| C4 | binding adjudicator, reasons, buckets | pending |
| C5 | provider through the sign-in hand-off | pending |
| C6 | docs and issue update | pending |
