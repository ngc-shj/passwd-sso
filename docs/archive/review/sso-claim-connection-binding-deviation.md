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
