# Coding Deviation Log: sso-claim-connection-binding

### D1: the probe's driver runs on a fixed Jackson image, not on each matrix image
- **Plan**: the probe runs on the pinned Jackson image so `@boxyhq/saml20` resolves in its own tree.
- **Actual**: `boxyhq/jackson:1.42.0` bundles saml20/xml-crypto into Next.js chunks; only 1.52.2 ships them under `/app/node_modules`. A fixed `PROBE_DRIVER_IMAGE` (the compose 1.52.2 digest) plays IdP and app; each matrix image is only the server under test. The probe asserts `/api/health` reports the expected version, tying digest to version.

### D2: `scripts/probes/` declared non-production for the bypass gates
- `check-bypass-rls`'s Program walk treated the probe as production code it could not read; it runs no application code, so `scripts/checks/lib/function-resolver.mjs` lists the prefix in `NON_PRODUCTION`.

### D3: B1 choices
- `init-env` honours a new sidecar flag `generate: false` (set on `AUTH_JACKSON_CONNECTIONS`): without it the generator wrote random hex into a JSON variable and the dev profile failed.
- The auth-provider route counts an account at an unconfigured Jackson provider as non-SSO (`canPasskeySignIn` true) — pinned by test.
- Legacy Jackson credentials without `JACKSON_URL` are refused (previously registered nothing silently).
- The cookie comment now states Google relies on PKCE and Jackson on `state` (Auth.js's Google provider uses `checks: ["pkce"]` only).

### D4: B2 choices
- C5's two refusals are their own `ClaimRefusalKind`s, `provider_unavailable` and `provider_disagreement`, both mapped to `provider_error` and declared unreported in `REFUSAL_BUCKET`, so the thrown arm says which carrier failed.
- `ensureTenantMembershipForSignIn(userId, account: Account | null, profile)`: every parameter is positional and required, but `account` stays nullable because Auth.js types the callback's account that way. A claim that arrives with no account is refused with `provider_error`, never resolved as unbound.
- The structured log line with both raw ids is `auth.tenant_claim.binding_refused`. It is emitted by the adjudication wrapper in `tenant-management.ts`, next to the off-mode `auth.tenant_claim.provider_mismatch`. The audit row carries `providerBinding` (`boundProvider`, `signInProviderRef`), built by `providerBindingOf`.
- `check-audit-metadata-narrative.mjs` has no metadata-key allowlist, so it was left unchanged; the gate passes with the new keys.
- `bucketOf` now reads a `REASON_BUCKET` table that covers every selected reason, and it throws on any reason that is not selected. `assertReasonTableAgrees` holds `REFUSAL_BUCKET` to that table when the module loads.
- The distinct-ref boot check runs in `auth.config.ts`, over `listClaimProviderIds()` and the derived pepper. It is skipped when no pepper is configured, because then no ref is stored.
- CLI compile fixes only: the revoke/unrevoke/reassign events record the row's own `provider` as both old and new, and the `add` create arm records null. B3 adds the provider to the CAS and the writers. The `unmapped` report gains the provider-binding heading and count now, because it only reads the new reasons.
