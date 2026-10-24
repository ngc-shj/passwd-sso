# Plan Review: sso-claim-connection-binding
Date: 2026-10-24

## Round 1 (plan revision 1)

User decision after round 1: keep and harden the legacy `saml-jackson` provider (own client id,
no PKCE, state + nonce) rather than leave it unchanged; extra connections are added as
`saml-jackson-<id>`. Measurements M8–M11 requested before revision 2.

### Functionality
- F1 Critical — per-connection provider ids lock out existing SAML users (`OAuthAccountNotLinked`; token AAD bound to provider; bindings; Jackson `redirectUrl` allowlist). → legacy id kept for the existing connection (user decision).
- F2 Major — idempotent `add` branch makes "re-declare with `add --provider`" a no-op → bind/rebind arm with CAS and its own event operation.
- F3 Major — events column needs old/new pair, column INSERT grant, deregister trigger, `history`.
- F4 Major — Auth.js uses `client_secret_basic`; probe measured `client_secret_post` → M8.
- F5 Major — legacy sends no `state`; Jackson 1.52.2 may reject → M10.
- F6 Major — consumers keyed on the Jackson env vars missing (sign-in page `hasSso`, env-schema provider rule, terraform, sidecar, setup docs) → one exported parser.
- F7 Major — new refusal arms: precedence and consumer walk unspecified.
- F8 Major — audit rows cannot name the sign-in vs bound provider.
- F9 Major [Adjacent] — boot rule ignores Google + SAML sharing the claim namespace.
- F10–F13 Minor — CLI `--provider` value semantics/validation/flags; duplicate provider carrier (`sessionMetaStorage`); `FLATTEN_RAW_CLAIMS` nonce override; one provider per claim.

### Security
- F1 Critical (escalated) — legacy `saml-jackson` (PKCE, no client auth) allows cross-connection account takeover via `sub` collision with ≥2 connections. → hardened (user decision).
- F2 Major — no Account-row migration; workarounds (bulk UPDATE, dangerous linking) re-open takeover.
- F3 Major — boot rule omits Google.
- F4 Major (R51) — binding keyed on operator label `id`, not Jackson `clientId`; no clientId uniqueness or id→clientId pinning.
- F5 Major (A04) — re-point keeps old provider; remedy text and auto-registration squatting lead operators to bind to the attacking connection.
- F6 Major — no-PKCE safety depends on Auth.js deleting the decoy `code_verifier`; attacker controls `code_challenge` → M9 + wire-level test.
- F7 Major — adjudication authority measured only on 1.52.2; repo examples pin v1.42.0 → M11.
- F8 Major — provider rebind has no event operation; column grant missing.
- F9–F14 Minor — off-mode warn reach; audit provider ids; boot refusals in every `NODE_ENV`; public list of customer names; attestation preconditions (shared entityId/cert, OIDC-backed connections); nonce as the code-injection control.

### Testing
- T1 Critical — C1 tested only as a config literal; probe did not use Auth.js's token request.
- T3 Critical — integration entry points unspecified; must drive `ensureTenantMembershipForSignIn` and `createUser` under the ALS store on the app role.
- T2 Major — probe not committed/reproducible/CI-run.
- T4–T14 Major — denial side-effect and attribution assertions; C4 fail-closed arm; parallel mock trees; hand-listed arm tables and wrong bucket; events column grant; CLI writer arms need real-DB tests; provider-id format in four spellings and CLI→sign-in round trip; consumer-level tests; env/boot allow-deny matrix and parser twins; off-mode warn controls; concurrent cross-provider registration.
- T15–T19 Minor — enumerated red proofs; binding-mode read site; legacy-bound rows after migration; manual-test file; CHECK tests.

## Recurring Issue Check
Kept in each expert's output (R1–R57, RS1–RS6, RT1–RT11); fired rules are cited per finding above.

### Measurements M8–M11 (before revision 2)
- M8: oauth4webapi `ClientSecretBasic`, no PKCE — legit 200, cross-connection 401, `client_id` rewrite 401 (1.52.2 and 1.42.0).
- M9: attacker-added `code_challenge`; app sends no verifier → 401; app sends a matching verifier → 200 with no client check.
- M10: authorize without `state` rejected on both versions — the legacy provider's default checks cannot complete a sign-in today.
- M11: 1.42.0 behaves the same for every binding-relevant case (the M1 hole exists there too); tag is `1.42.0`, the repo's `v1.42.0` is an ECR re-tag.

Revision 2 addresses every round-1 finding; dispositions map: legacy hardened and kept (F1 func, F1 sec, F5 func), migration avoided by keeping the legacy id (F1 func, F2 sec), `bind` arm (F2 func, F5 sec), events old/new + grants + trigger (F3 func, F8 sec, T8), wire test + committed CI probe (F4 func, F6 sec, T1, T2), one parser (F6 func, F11 sec, T12), consumer table (F7 func), audit ids (F8 func, F10 sec), Google in the count with derived strict (F9 func, F3 sec), clientId uniqueness + immutable id (F4 sec — fingerprint pinning not adopted: unique clientId across entries plus immutable id documented; a re-pointed id is an operator config change, recorded as residual), entry points and assertions (T3–T14), scope-outs SC1–SC6 (F12, F13 sec, F13 func, SC3 squatting opt-out).

## Round 2 (plan revision 2)

### Security
R2-1 Major (members evidence only on `bind`; bucket text points to the squatter), R2-2 Minor (id re-point transfer understated), R2-3 Minor (`signInProvider` names one customer to another in a tenant-readable row), R2-4 Minor [Adjacent] (derived strict locks out Google + Jackson on upgrade), R2-5 Minor (Google predicate), R2-6 Minor (tested versions undocumented).

### Functionality
N1 Major (M10 conclusion ignores `AUTH_REDIRECT_PROXY_URL`), N2 Major (derived strict lockout, no runbook — converges with R2-4, T-N13), N3 Major (`add`/`add --from` create NULL rows strict refuses), N4 Major (`bucketOf`, `printGroup`, audit-id carriage missing from C4), N5–N8 Minor (CAS on provider; C5 disagreement policy; `off` with ≥2 silently ignored; CLI without app env).

### Testing
N1 Major (path filter), N2 Major (one digest, two deployed versions), N3 Major (probe environment/deps), N4 Major (status-only negative asserts), N5 Major (wire test must use production providers + leftover PKCE cookie), N6 Major (mode computed once vs grid), N7 Major (env matrix gaps), N8 Major (`bind` cells), N9 Major (parity must be behavioural over three live CHECKs), N10 Major (CLI with/without app env), N11–N12 Minor, N13 Major [Adjacent] (upgrade lockout), T18 Minor (manual-test file — created in Phase 2).

### Revision 3
Upgrade lockout (R2-4, N2, T-N13, N7): boot refused with ≥2 claim providers unless `AUTH_CLAIM_BINDING=strict` is set explicitly; `off` with ≥2 refused; `bind --from-members` and an upgrade runbook. Squat remediation (R2-1): evidence check on every provider-setting writer, created-by-sign-in shown, zero-member "no evidence", bucket text names re-point. N3: `--provider` required in strict, `--unbound` explicit otherwise. N4: consumer additions. R2-3: `signInProviderRef` hash in the tenant-readable row. R2-2, R2-5, R2-6, N1, N5, N6, N8: stated in C1/C2/C3/C5/C6. Testing N1–N10, N11, N12: one line each in the strategy; cell-level detail left to Phase 2 (plan granularity is not where these converge).
