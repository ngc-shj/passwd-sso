# Plan: sso-claim-connection-binding

Issue: `#742`. Branch `feat/sso-claim-connection-binding`, base `main` 907f6fdd4. Revision 3.

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
  versions. Today's legacy provider sends no state — unless `AUTH_REDIRECT_PROXY_URL` is set, which
  makes Auth.js add one; such a deployment signs in today over PKCE, where Jackson never checked
  `AUTH_JACKSON_SECRET`. Hardening can therefore break a deployment whose secret is stale or whose
  client id is `dummy`/encoded; the boot refusal makes that loud, and the upgrade notes say so.
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
  pinned by a wire-level test), each connection's own credentials, a stable id → connection
  mapping (re-pointing an id to another connection gives that connection's IdP sign-in as every
  account and binding under it; a replaced connection gets a new id), a Jackson version the probe
  passes (measured: 1.42.0, 1.52.2), SAML connections whose IdPs have distinct entityIds and signing
  keys (Jackson selects candidates by Issuer; SC5). Adjudication authority: Jackson's token
  endpoint.

### C2 — binding mode
- Claim-presenting providers: `google` when registered (the same exported predicate
  `auth.config.ts` and `env-schema.ts` use), every Jackson provider. `AUTH_CLAIM_BINDING` is
  `off` | `strict`; any other value is refused. With two or more claim providers the app refuses to
  boot unless it is `strict` — explicitly set, so an upgrade of a Google + Jackson deployment stops
  at deploy time with a message naming the runbook (C6) instead of silently refusing every
  claim-routed sign-in on NULL rows. With one, `strict` is opt-in.
- Control class: fail-closed gate. The mode is computed by one exported function from the env
  (no module-level cache); the adjudicator takes it as an argument, so tests select it explicitly
  and one integration cell per mode runs the production derivation.

### C3 — claim provenance recorded
- `tenant_claims.provider VARCHAR(64) NULL`, CHECK on the shared provider-id pattern (one TS
  constant, parity-tested against the CHECK). NULL = provenance unknown.
- `tenant_claim_events.old_provider`, `.new_provider` (nullable, same CHECK); column INSERT grants
  for `passwd_app` in a migration, `scripts/checks/app-role-denied-privileges.json` columnGrants,
  `bootstrap-rds-roles.mjs`, `db-grants-manifest.json`; the BEFORE DELETE deregister trigger
  copies `OLD.provider`; `tenant-domain history` prints them.
- Writers: sign-in registration (both `tenant.create` arms) records the presenting provider.
  CLI writers that set a provider — `add` create and unrevoke, `add --from` re-point, and the new
  `bind` — take `--provider <full provider id>`; in strict mode `add`/`add --from` refuse without
  it (no NULL row in strict), and outside strict a NULL row needs an explicit `--unbound`. Every
  such writer runs one evidence check on the target tenant: the account providers of its active
  members, whether the tenant was created by sign-in and through which provider; it refuses when
  no member uses `<id>` unless `--accept-unused-provider`, and reports a zero-member tenant as
  "no evidence" rather than as an unused provider. Existing CAS clauses (re-point, unrevoke) gain
  `provider`.
- `tenant-domain bind --claim <c> --provider <id> --by <label>` changes an active row's binding —
  CAS on `(tenant_id, provider, revoked_at)`, event `rebind` (operation CHECK widened; the gate's
  self-test and the operation-check test follow). `bind --from-members --by <label>` binds every
  NULL row whose tenant's active members use exactly one claim provider, without the override, and
  lists the rest — the upgrade path.
- `--provider` is validated against the configured provider set when the app env is present;
  without it, against the pattern, with a warning. `list --unbound` without the app env lists NULL
  rows only and says that rows bound to unconfigured providers were not evaluated. Flags in
  `tenant-domain-flags.ts`.
- `tenant-domain list` shows the provider; `list --unbound` lists rows strict mode refuses (NULL,
  or a provider no longer configured), using the adjudicator's predicate, with a suggested provider
  when the members use exactly one.

### C4 — binding adjudicator
- One function in `tenant-management.ts` decides after `findClaimRow` (which now selects
  `provider`); `resolveTenantByClaim` and `findOrCreateTenantForClaim` take the sign-in provider
  (required) and call it. Arm order: revoked (existing `claim_taken`) → in strict, NULL provider
  → `claim_unbound`, provider ≠ sign-in → `claim_provider_mismatch`. Both arms carry the owning
  tenant and exist in `ClaimLookup` and `ClaimTenantResolution`.
- Reasons `tenant_claim_unbound`, `tenant_claim_provider_mismatch`. The audit row (readable by
  the owning tenant's admins) carries `boundProvider` and `signInProviderRef` — a short hash of the
  presenting provider id, so one customer's connection name is not shown to another; the
  structured log line and `tenant-domain unmapped` (which maps refs against the configured set)
  show both ids. Carried through `SignInTenantResult`, `TenantClaimUnusableError`,
  `emitAuthLoginFailure`'s parameters, and the `unmapped` query (selected, grouped and printed).
  Consumers to change: `bucketOf` (becomes a full reason → bucket table), the new heading's
  `printGroup` call in `cmdUnmapped`,
  `refusalFromLookup`, `claimRefusalOf`, `lookupRefusalReason`, `SignInTenantResult.reason`,
  `TenantClaimUnusableError` kinds, `ClaimRefusalKind`, `CLAIM_REFUSAL_REASON`,
  `UNMAPPED_SELECTED_REASONS`, a new `UNMAPPED_BUCKET` (heading: investigate first — a mismatch
  is the attack's signature; if the bound tenant was created by sign-in through another customer's
  provider, re-point the claim to the rightful tenant with `add --from … --provider <theirs>`;
  never `bind` the rightful provider into it), README cause table (en/ja), `docs/security/audit-log-schema.md` (also add the missing
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
  fallback. In `createUser`, when `sessionMetaStorage` carries a provider that differs from the
  claim store's, the sign-in is refused (`provider_error`) inside the transaction; an absent
  session meta is not a refusal. `route.ts`'s initial store gains `provider: null`.

### C6 — docs
Upgrade notes (breaking): hardened legacy Jackson (real connection credentials required); Google +
Jackson deployments must run `migrate`, `tenant-domain bind --from-members`, resolve the listed
rest, then set `AUTH_CLAIM_BINDING=strict` before starting the app. README (en/ja) SAML section rewritten (per-connection config, why PKCE is off — M1/M9, nonce as
the code-injection control, `FLATTEN_RAW_CLAIMS=false` required, distinct IdP entityIds, strict
rules, measured Jackson versions and that a Jackson bump requires a probe run, the id-immutability
consequence, migration: `list --unbound` → `bind`), `docs/setup/*`, `docs/operations/alerts.md`, the
cookie comment in `auth.config.ts` (login CSRF rests on state, not PKCE, for Jackson), `#742`
updated with M1–M11.

## Testing strategy

- C1 wire test (unit, `@auth/core`'s real sign-in and callback over the production provider
  objects from `jackson-providers.ts` — legacy and two entries — `fetch` mocked at the network
  boundary): authorize URL carries `state` and `nonce`, no `code_challenge`; token request has
  `Authorization: Basic` with that provider's credentials and no `code_verifier`, also when a
  valid PKCE cookie left by a Google sign-in is present. Red: `pkce` added; two entries' secrets
  swapped; the provider reading the cookie.
- C1 probe (`scripts/probes/jackson-connection-binding.mjs`, committed, keys generated at run
  time, asserts and exits non-zero): every attack case first asserts that IdP A's signed response
  produced a code, then the 401 and its credential-check body (M8b, M5a, M9 without verifier);
  M8a/M8c 200; positive controls M1 (PKCE) 200 and M9 with the attacker's verifier 200. It runs in
  a node container on the probe network, exchanges tokens through the oauth4webapi copy
  `@auth/core` resolves (version asserted), and signs SAML with the pinned Jackson image's
  `@boxyhq/saml20` (stated). `ci-integration.yml` runs it as a matrix over every Jackson image the
  repo references (a drift test pins the list to `docker-compose.yml` and the Terraform image),
  with teardown registered first; its path filter gains the compose file, `infra/terraform/**`,
  `src/auth.ts`, `src/auth.config.ts` and the sign-in page.
- C1/C2 env: one parser; allow/deny matrix — Google alone off; 1 Jackson off; forced strict with
  one; two or more with `strict` boots, with `off`/unset refused; invalid or miscased mode refused;
  Google ID without secret not counted; no claim providers; refusals under production, development
  and test — each refusal paired with an adjacent allow; no secret in any message;
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
  `add --provider X` → strict sign-in through X resolves; `bind` cells (CAS lost, revoked, absent,
  unconfigured provider, override allow pair, evidence listing scoped to this tenant's active
  members, rebind event values, same-provider no-op, `--from-members` ambiguous rows left);
  each CLI command with and without the app env; a real strict denial selected by `unmapped` and
  printed under the new heading; an upgrade scenario (NULL rows, Google + Jackson env → boot
  refused; after `bind --from-members` and strict → sign-ins resolve). Column grants asserted with
  `has_column_privilege`. Provider-id parity: one corpus (empty, 64/65 chars, uppercase, `_`,
  trailing newline, non-ASCII, the longest generable id) through the TS predicate and each of the
  three live CHECKs read from `pg_constraint`, identical verdicts. C5 agreement cells.
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
