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
