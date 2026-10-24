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

### D5: B3 choices
- "The app env is present" means at least one claim provider is configured in the env the CLI loaded (`listClaimProviderIds(process.env)`). If the provider configuration is invalid, the binding commands refuse with the `ProviderConfigError` text. `unmapped` warns in that case and maps no refs.
- `add` needs `--provider` or `--unbound` on every arm that writes: create, unrevoke and the `--from` re-point. Outside strict, giving neither is refused. It does not fall back to the row's current provider. In strict, `--unbound` is refused too. If the row is already active on this tenant and the stated binding differs from its own, `add` refuses and points to `bind`, because silently ignoring the flag is not allowed.
- Evidence counts accounts at the configured claim providers. Without the app env it counts every Google- or Jackson-shaped provider the members use, plus the provider being bound. Majority means strictly more than half of the active members. `add`/`bind` check the majority before the confirmation prompt. `--unbound` still prints the evidence but skips the majority check.
- The plan named three reserved labels, and `backfill` had no constant. `tenant-claim-event.ts` gains `BACKFILL_CREATED_BY_LABEL` and `ENGINE_WRITTEN_LABELS`, and `--by` is checked against that list.
- `adjudicateClaimBinding`, `ClaimRow` and `ClaimBindingVerdict` move to the prisma-free `src/lib/tenant/claim-binding.ts`, which the CLI can import (see the import-graph test). `tenant-management.ts` re-exports them. The same module adds `isUnusableUnderStrict`, the predicate `list --unbound` uses. It treats a row as unusable when it is active and strict refuses it for every configured provider, so revoked rows are not listed.
- `--apply` is a boolean for `backfill-owning-column`, so `parseFlags`/`findValuelessFlag`/`valuelessError` take the subcommand. `SUBCOMMAND_VALUE_FLAG_HINTS` makes `--apply` a value flag under `bind` only. `bind` has three forms: exactly one of `--claim`, `--from-members` and `--apply` must be given. Any flag the chosen form does not read is refused.
- Bind file: the header line is `passwd-sso-claim-bind<TAB>v1`. The claim column is written as stored, because the CHECK holds it to printable ASCII and escaping `<` would produce a different claim. A claim that fails `storableClaimSchema` makes the writer throw. The claim is escaped on the comment line. Every row gets a flag line: `created_by`, `uuid_claim`, `operator_events`, `register_provider`. `--out` lists active rows whose provider is NULL, matching the row state `--apply`'s CAS requires.
- `--out` worktree check: the target's parent is compared by realpath against `git rev-parse --show-toplevel`, run both from the CLI's own directory and from the cwd. A directory outside any worktree, or a host without git, adds no restriction. A parent directory that does not exist is refused. The file is opened `wx` with mode 0600, then `fchmod 0600`. It is unlinked if the read fails.
- `--apply`: a line counts as operator-chosen when `suggestedProvider(parseEvidence(line.evidence))` differs from the line's provider. "already bound" is checked before evidence, so a rerun reports it. "CAS lost" covers a row that is absent, moved, revoked or bound elsewhere. There is one confirmation before the per-line transactions.
- `unmapped` prints `boundProvider` and the mapped `signInProvider` on provider-binding rows. It adds two labels: "unmappable (no provider configuration)" when the CLI has no app env, and "no ref stored" when the app stored no ref.
- New bypass grants: `TENANT_CLAIM_BINDING_READ` (`list --unbound`, `--out`) and `TENANT_CLAIM_BINDING_WRITE` (`add`, `bind`, `--apply`). `add` now reads accounts and events, so it moves to the WRITE grant. `TENANT_CLAIM_REGISTER` stays with `remove`.
- The coverage gate now resolves `TENANT_CLAIM_EVENT_OPERATION.<KEY>` to its value. Before this, an arm naming the constant and another naming the literal counted as two operations, and an unknown key went unchecked. The self-test has fixtures for both cases.
- Existing CLI tests: the 46 `cmdAdd` calls in `tenant-claim-cli.integration.test.ts` pass `unbound: true`. The dev `.env` configures no claim provider, so those calls run in off mode.
- Red proofs ran on a copy (`src`, `scripts`, `prisma`, `messages`, configs, `.env`) under the session scratchpad, with `node_modules` symlinked. The copy has a minimal `.git` (HEAD/objects/refs written as files, no git command) so `rev-parse` resolves inside it. Each mutated file was restored from the real tree after its run.

### D6: B5 choices
- The runbook is the README section `SSO tenant claim binding upgrade`, so the boot error's reference resolves by text. The heading is kept verbatim in `README.md`. `README.ja.md` gives it a Japanese suffix and an explicit `<a id="sso-tenant-claim-binding-upgrade">`, so both READMEs share the anchor that `docs/setup/*` links to. The SAML paragraph gets the same treatment: `<a id="saml-sign-in--bind-the-tenant-to-the-connection">` in both.
- Terraform: `AUTH_JACKSON_CONNECTIONS` is a secret behind a new `enable_jackson_connections` toggle (default `false`), because ECS refuses a task whose secret lacks a key it reads. `AUTH_CLAIM_BINDING` is plain environment from `auth_claim_binding` (`""`, `off` or `strict`; empty leaves it unset). The default stays unset so that an upgrade binds claims before strict is turned on.
- Terraform also sets `JACKSON_URL=https://<jackson_domain>` on the app task. No task passed it, so `AUTH_JACKSON_ID`/`SECRET` registered nothing on AWS before B1. Since D3 they refuse to boot without it. With empty Jackson credentials the variable is unused.
- Terraform sets `FLATTEN_RAW_CLAIMS=false` on the Jackson task. This pins Jackson's default, which the binding depends on (M7). `docker-compose.yml` was left unchanged: it does not set the variable, so Jackson's default applies, and the setup docs state the requirement.
- `src/__tests__/infra/ecs-secrets.test.ts` turns `enable_jackson_connections` on in its all-toggles-on evaluation, so the new key is held to the `infra/terraform` README secret tables. Both tables gained the row.
- Exposure review (runbook step 3) uses `list`, `list --unbound` (its `members=` column is the members' account providers) and `history`, not raw SQL. Those are the commands the CLI already offers for it.
- The probe is documented by pointing at the `jackson-probe` CI job and its matrix, not as a docker command line, because this batch may not start containers to verify one.

### D7 — Red proofs
Each mutation ran on a scratch copy (D5's layout), never on the real tree, and the mutated file was restored after its run. A mutation counts only when the listed tests passed unmutated in the same copy first. B2 and B3 are copied from their batch reports. B1, B4 and the Phase 2 R-check fixes were run for this record.

**B2** (the B2 report does not name the unmutated run per mutation, so none is recorded here)

| Mutation | Tests that went red |
|----------|---------------------|
| M1 mismatch allowed | unit 3 (adjudicator arm, resolver, creator); integration 4 (strict bound-other ×2 paths, no-pepper cell, race) |
| M2 NULL matched in strict | unit 3; integration 3 (strict unbound ×2 paths, forced-strict fresh-module cell) |
| M3 provider dropped in `createUser` | integration missing-provider cell. Unit initially survived through a leftover session-meta mock; both C5 unit tests were tightened to pin the refusing arm, and unit fails too after that |
| M3b producer drops `store.provider` | unit "stores tenant claim…" |
| M4 provider replaced by a constant | unit 3; integration 7 (strict bound-same, both registration cells, warn cells, C5 allows) |
| M5 ref replaced by raw id | unit 4; integration 5 |
| M6 prefix compare instead of distinctness | unit shared-prefix allow test |
| M7 HKDF info changed | golden vectors 4 |
| M7b floor changed | golden vectors 4 |

**B3** (unmutated: `scripts/__tests__/tenant-domain-binding.test.ts` and `tenant-claim-cli-binding.integration.test.ts`, the two files its mutation script ran)

| Mutation | Tests that went red |
|----------|---------------------|
| M1 escape removed from TSV writer | unit 3 (newline/tab/bidi `created_by`); integration 3, the same `--out` cells |
| M2 majority `>=` half | unit `isMajority` 1/2 and 2/4; integration "exactly half is refused; half plus one is allowed" |
| M3a rebind CAS without provider | integration "a concurrent rebind while the operator reads is a CAS refusal" |
| M3b re-point CAS without provider | integration "re-point: a concurrent change of the provider alone is a refusal" |
| M3c unrevoke CAS without provider | integration "unrevoke: a concurrent change of the provider alone is a refusal" |
| M4 worktree check by string prefix | unit symlinked-parent and missing-parent cells; integration "refuses a symlinked parent, creating nothing" |
| M5 `--apply` skips evidence comparison | integration partial-failure cell |
| M6 ref mapping keyed by raw id | unit "maps the ref the app stores back…"; integration unmapped "…app and CLI refs agree" |
| post-B5: implicit-reassign hint without the binding flag (on the B3 copy) | integration "refuses a domain already owned by a different tenant…" |

**B1** (unmutated: `src/auth.config.jackson-wire.test.ts` 11/11, `src/lib/auth/jackson-providers.test.ts` 136/136)

| Mutation | Tests that went red |
|----------|---------------------|
| `pkce` added to the Jackson providers' `checks` | wire 9/11: all three cells (no `code_challenge`; own Basic credentials and no `code_verifier`; no `code_verifier` with a Google PKCE cookie) × `saml-jackson`, `saml-jackson-a`, `saml-jackson-b` |
| the two `AUTH_JACKSON_CONNECTIONS` entries' client secrets swapped in the provider build | wire 4/11: own-credentials and Google-cookie cells for `saml-jackson-a` and `saml-jackson-b` (the legacy provider keeps its own secret, so its cells stay green) |
| provider puts a `code_verifier` on the token request (a `customFetch` that sets one) | wire 6/11: own-credentials and Google-cookie cells × all three providers |
| `isJacksonProviderId` as a prefix predicate | jackson-providers 5: rejects `"saml-jackson-"`, `"saml-jackson-a "`, `"saml-jackson-b"`, `"saml-jacksonx"`, and the legacy id when only entries are configured |
| `deriveClaimBindingMode` returns `configured ?? OFF` without the ≥2 → strict arm | jackson-providers 3: "derives strict" for Google + Jackson off, Google + Jackson unset, two Jackson entries unset |
| boot check accepts `off` with ≥2 providers | jackson-providers 1: Google + Jackson, off — "refuses to boot on AUTH_CLAIM_BINDING" |

**B4** (unmutated: `scripts/__tests__/jackson-probe-images.test.mjs` 6/6)

| Mutation | Tests that went red |
|----------|---------------------|
| matrix entry bumped to `1.52.3` (version and image tag), so it no longer matches the compose tag | "matrix versions equal the versions the compose file and tfvars examples reference"; "the probe driver image is the matrix entry for the docker-compose.yml version" |
| matrix image tag `1.42.0` on the `1.52.2` entry | "each matrix image is boxyhq/jackson:<its version>@sha256:<digest>, digests distinct"; the probe driver image cell |
| the `1.52.2` entry carries the `1.42.0` digest | the image/digest-distinct cell; the probe driver image cell |

**Phase 2 R-check fixes** (unmutated: the race cell of `tenant-claim-binding.integration.test.ts`, 1 passed; `src/lib/audit/identifier-pepper.test.ts` 15/15)

| Mutation | Tests that went red |
|----------|---------------------|
| `advisoryXactLock` removed from `findOrCreateTenantForClaim` | integration "one tenant, one binding; the loser gets claim_provider_mismatch" (the losing side hit `tenant_claims_claim_key`; no `bind-race-*` tenant or claim row was left in the dev DB) |
| collision throw removed from `assertDistinctProviderRefs` | unit "refuses at boot when a pepper is configured, naming both providers" |
| `pepper === null` early return removed | unit "is not checked without a pepper, because no ref is stored then"; unit "the boot assertion passes for real refs of distinct ids, and is skipped without a pepper" |

Unmutated, the race cell won 37/13, 31/19, 24/26, 14/36 and 24/26 (`saml-jackson-alpha`/`saml-jackson-bravo`) over five runs, so its at-least-one-win-each assertion is not flaky.
