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
- Existing CLI tests: the 46 `cmdAdd` calls in `tenant-claim-cli.integration.test.ts` pass `unbound: true`. Its `beforeEach` stubs the provider env to none (`stubClaimProviderEnv({})`, Phase 3 round 1), so those calls run in off mode whatever the developer's `.env` configures.
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
Each mutation ran on a scratch copy (D5's layout), never on the real tree, and the mutated file was restored after its run. A mutation counts only when the listed tests passed unmutated in the same copy first. B3 is copied from its batch report. B1, B4 and the Phase 2 R-check fixes were run for this record, and B2 and the Phase 3 round 1 fixes were run in round 1.

**B2**, re-run in Phase 3 round 1 on its own copy (`b742-r1`, D5's layout), each mutation precisely as defined in the first column. Unmutated first: unit `tenant-management`, `resolve-tenant-by-claim`, `auth-adapter`, `auth`, `identifier-pepper`, `auth-failure`, `auth-failure-mapping`, `tenant-domain-binding` 289/289; integration `tenant-claim-binding` + `tenant-claim-cli-binding` 119/119.

| Mutation | Tests that went red |
|----------|---------------------|
| M1 `adjudicateClaimBinding`'s strict `row.provider !== signInProvider` arm disabled (mismatch allowed) | unit: `strict: returns claim_provider_mismatch for a row bound elsewhere, with no create`; `strict: a row bound to another provider is a mismatch carrying the owner`; `provider_mismatch`. integration: `strict mode, bound-other row, existing-user` / `first-sign-in`; `without a pepper the refusal row stores no ref, and still names the binding`; `one tenant, one binding; the loser gets claim_provider_mismatch`; `list --unbound with the app env: NULL and unconfigured rows, never a bound one, with a suggestion`; `add --provider X: a strict sign-in through X resolves, through another provider is refused`; the four `unmapped` cells (binding heading with the provider mapped back; removed provider unknown; unmappable without a pepper; unmappable without the app env) |
| M2 the strict NULL arm returns a tenant instead of `unbound` (NULL matched) | unit: `strict: returns claim_unbound for a NULL row, with no create`; `strict: a NULL row is unbound carrying the owner`; `unbound`. integration: `strict mode, unbound row, existing-user` / `first-sign-in`; `strict: a NULL row through createUser is allowed=false`; `list --unbound with the app env…`; `upgrade: NULL rows under Google + Jackson refuse boot; after --out/--apply and strict, sign-ins resolve` |
| M3 `createUser`'s `pendingProvider === null` refusal disabled (the claim resolves with no provider) | unit: `createUser > refuses a pending claim that carries no provider, without resolving it`. integration: `refuses a claim with no provider with provider_error and writes nothing` |
| M3b the signIn callback stops setting `store.provider` | unit: `stores tenant claim in tenantClaimStorage for new user`; `takes the first-sign-in path for an unlinked account whose email names no user`. integration: every first-sign-in grid cell (off and strict × three row states); both `first registration binds the claim to the presenting provider` cells; the three `off-mode mismatch warning` cells; `strict, Google: a row bound to google resolves a google sign-in`; `without a pepper…`; `add --provider X…`; `upgrade…`; the four `unmapped` cells |
| M4a `lookupFromRow` passes the constant `"google"` to the adjudicator | unit: `off: no mismatch warning for a row bound to the same provider`. integration: `strict mode, bound-same row, existing-user` / `first-sign-in`; `a bound-same row: warned=false`; both C5 `allows when the session meta …` cells; the strict S1 linked-account and own-account cells (3); `add --provider X…`; `upgrade…` |
| M4b `findOrCreateTenantForClaim` registers the claim with provider `"google"` (first create) | unit: `creates a new tenant with its claim row in one nested create when not found`; `creates a tenant for a non-domain claim like acmecorp (NF2)`. integration: both `first registration binds…` cells; both `existing user with no active membership, unregistered claim` cells; `one tenant, one binding…` |
| M5 `providerRefOf` returns the raw provider id | unit: `providerRefOf stores no ref without a pepper, and the keyed ref with one`; `maps the ref the app stores back to its provider id, under one env`. integration: `strict mode, bound-other row` and `strict mode, unbound row` × both paths; `unmapped > prints the denial under the binding heading…; app and CLI refs agree` |
| M6 `findProviderRefCollision` compares the first 8 hex characters | unit: `allows refs that share a long prefix (distinctness, not a prefix test)` |
| M7 `PROVIDER_REF_INFO` changed to `-v2` | **survived** (app and CLI recompute through the same function). Round 1 adds `providerRef > is the recorded vector`; with it, the same mutation reds that cell (unmutated 16/16) |
| M7c `IDENTIFIER_PEPPER_INFO` changed to `-v2` (the B2 report's "HKDF info" mutation, by its "golden vectors" result) | unit: `AUTH_SECRET fallback is the recorded HKDF output`; `a below-floor pepper falls through to a usable AUTH_SECRET`; `memoises the first derivation until reset`; `AUTH_SECRET fallback: the derived pepper and the hash are the recorded vectors` |
| M7b `MIN_KEY_MATERIAL_LENGTH` 32 → 16 | unit: `a below-floor pepper falls through to a usable AUTH_SECRET`; `below-floor pepper and secret: no key material`; `AUTH_SECRET shorter than 32 chars is treated as absent`; `below-floor pepper and secret: no hash, unkeyed` |

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

**Phase 3 round 1** (copy `b742-r1`. Unmutated first: `src/auth.test.ts` + `src/auth.config.test.ts` 124/124 and the S1 block of `tenant-claim-binding.integration.test.ts` 11/11; `tenant-domain-binding` + `tenant-domain-flags` + `tenant-domain-cli-dispatch` 130/130 and `tenant-claim-cli-binding.integration.test.ts` 72/72)

| Mutation | Tests that went red |
|----------|---------------------|
| S1a the OAuth/OIDC subject resolution skipped (`if (account && false)`): the email lookup again for every type | integration: all eight S1 deny cells (`{off, strict} × {departed, bootstrap} member`: `an unlinked account asserting the victim's email is refused before any write`, `a linked account asserting the victim's email signs in its own user and writes nothing for the victim`). unit: all four `OAuth/OIDC sign-in subject` cells that resolve through the adapter |
| S1b the `getUserByAccount` step removed (email first) | integration: the four linked-account deny cells; both `the victim's own linked account resolves them as before (row 4 join)`. unit: `writes for the linked account's user, whatever email is asserted` |
| S1c the `allowsDangerousEmailAccountLinking` exception removed (always `not_linked`) | integration: `Google with email linking on: an unlinked account whose email names a user proceeds with that user`. unit: `proceeds with the email's user where the provider links by email`; `refuses an unlinked account whose email names a user, before any write` (it asserts the predicate was consulted) |
| S1d the Google provider's flag hard-coded `true` instead of the predicate | unit: `the linking predicate agrees with every constructed provider without GOOGLE_WORKSPACE_DOMAINS` |
| F1 `cmdRemove`'s CAS without `provider` | integration: `remove: a concurrent rebind of an unbound row …` and `… of a bound row is a refusal and records no event` |
| S2 the `isBindFileWritable` skip removed (a `#` claim written as a line) | unit: `lists a claim starting with # in a not-written note instead of as a data line`. integration: `names a stored claim starting with # as not written, and writes the others as lines` |
| F3a the CRLF refusal removed | unit: `refuses the whole file on CRLF line endings` |
| F3b the BOM refusal removed | unit: `refuses the whole file on a leading byte-order mark` |
| F4a the stray-flag refusal in `main()` disabled | dispatch: `refuses a flag the subcommand does not read, before reaching a handler` |
| F4b `provider` dropped from `SUBCOMMAND_FLAGS.add` | unit: `add accepts the documented form […--provider…]`; `each subcommand accepts exactly the flags its dispatch reads` |
| F4c `provider` added to `SUBCOMMAND_FLAGS.remove` | unit: `remove refuses […--provider google]`; `each subcommand accepts exactly the flags its dispatch reads`. dispatch: `refuses a flag the subcommand does not read…` |
| F4d `add`'s `--unbound` + `--accept-unused-provider` refusal disabled | integration: `refuses --accept-unused-provider together with --unbound` |
| T2 the pre-fix `tenant-claim-cli.integration.test.ts` (from HEAD) with `AUTH_GOOGLE_ID/SECRET`, `JACKSON_URL`, a one-entry `AUTH_JACKSON_CONNECTIONS` and `AUTH_CLAIM_BINDING=strict` exported in the shell | 30 of 102 red (the `add --unbound` cells refused under the derived strict mode). The post-fix file under the same shell env: 102/102 |

Not red-proved: T3 and T7 change fixtures and assertions, and the B2 rows above exercise them (M4a reds the strict two-connection cells, M4b the new existing-user registration cells). T6's narrowing has no source mutation that reaches it without also changing `refMappingFor`'s other callers. T1/T5 are workflow edits with no test reading them.

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

### D8: Phase 3 round 1 choices
- **Security (S1):** for an OAuth/OIDC sign-in, the signIn callback now resolves the subject the way Auth.js will, through the adapter's own `getUserByAccount` / `getUserByEmail`, before any membership write. A linked account resolves to its user. An unlinked account whose email names a user proceeds only where `allowsDangerousEmailAccountLinking` (exported from `auth.config.ts` and used by the Google provider's construction) allows it. Otherwise the callback refuses with the new reason `account_not_linked`, filed under that user. Magic link and other account types keep the email lookup. A sign-in made while another session is active is resolved as if there were no session; the app has no account-linking flow. The adapter instance is hoisted so NextAuth and the callback share it.
- Found while writing the S1 allow cells, not fixed (out of this round's scope): the bootstrap migration (rows 6 / 9a) upserts the new membership before deleting the bootstrap one, and `tenant_members_one_active_per_user` refuses that. On a real database every bootstrap-member sign-in into a claimed tenant ends in `provider_error`. The unit suite mocks Prisma and no integration cell drove the arm. The S1 cells use a departed member for the write that commits, and the bootstrap victim's cells pin "refused, nothing written".
- F3: a bind file with a BOM or CRLF endings is refused up front with "save it with LF line endings, no BOM". It is not normalised, so the file `--apply` reads is the file the operator reviewed byte for byte. A lone `\r` inside a cell is still the cell check's refusal.
- S2: a claim starting with `#` is not written as a line. `formatBindFile` lists it in a "Not written" header note, and `bind --from-members` names it in its output, with `bind --claim` as the path for it.
- F4: `SUBCOMMAND_FLAGS` lists the flags each subcommand reads, and `main()` refuses any other before dispatch. A unit test derives each set from the CLI's own flag reads per `case`.
- T4: re-running B2 found that a change to `PROVIDER_REF_INFO` reds nothing, because every ref cell recomputes through `providerRef`. Stored refs are mapped back by recomputation, so such a change orphans every ref already written. `identifier-pepper.test.ts` gains a recorded vector for `providerRef`.
- T2: the provider env key list is `Record<ProviderEnvKey, true>` in the shared fixture module, so a variable added to `jackson-providers.ts` must be listed there to compile. `stubClaimProviderEnv` asserts the derived mode against the documented rule.
