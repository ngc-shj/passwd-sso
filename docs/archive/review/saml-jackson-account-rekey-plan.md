# Plan: saml-jackson-account-rekey (#954)

## Project context

- Type: `mixed` (web app + offline operator CLI `scripts/tenant-domain.ts`)
- Test infrastructure: `unit + integration` (+E2E, +CI/CD). Real-DB integration tests run against this worktree's own database `passwd_sso_wt_954`; no dev worker races it. CI's integration job runs no worker either.
- Verification environment constraints:
  - VE1: no real Jackson / IdP in the worktree, so a real sign-in through `saml-jackson-<id>` after the move cannot be driven. — `blocked-deferred`. What the move must guarantee is row-level: the row is keyed `(to, providerAccountId)` (what `getUserByAccount`, `src/lib/auth/session/auth-adapter.ts`, looks up), its tokens decrypt under `{userId, provider: to, providerAccountId}`, and the tenant's claims are bound so that `claimedTenantMembership` (`src/auth.ts`) admits a claim-presenting sign-in through `to` (C2). All three are asserted against the real DB through production code. A SAML IdP fixture costs far more than these row-level properties need.
  - VE2: no cloud KMS locally. — `verifiable-local`: unit test drives the production key-provider module with `KEY_PROVIDER=aws-sm` and a stateful fake at the cloud-provider constructor (C6).

## Objective

Give the operator a recorded, reviewed way to move a tenant's pre-upgrade `saml-jackson` accounts onto the per-connection provider `saml-jackson-<id>` that tenant's IdP sits behind, so those users stop being refused with `account_not_linked` after the SSO claim binding upgrade (README "SSO tenant claim binding upgrade" → "Known lockout").

## Requirements

Functional:
- F1 `tenant-domain rekey-accounts --tenant <ref> --to saml-jackson-<id> --by <label> [--apply] [--yes]`.
- F2 Without `--apply`: print the tenant's claims with their binding evidence, the accounts that would move, and every refusal reason; write nothing. Exit status is the one `--apply` would have before confirmation.
- F3 With `--apply`: in ONE transaction, re-encrypt every token of every listed account from the old AAD to the new AAD, set `provider`, and record the move in the tenant's audit log; the operator confirms after seeing the listing (or `--yes`).
- F4 Refuse the whole run (no write) on: target not a configured connection provider in this process's env; any token that does not decrypt; an existing row at `(to, providerAccountId)`; a candidate's user already holding an account at `to`; a C2 condition; a change, during the confirmation, to anything the listing showed.
- F5 Member set: accounts at `saml-jackson` whose user holds an ACTIVE membership in the tenant. A user holds at most one active membership (`tenant_members_one_active_per_user`, `prisma/migrations/20260909120000_one_active_membership_per_user/migration.sql`), so a candidate belongs to exactly one tenant's set. The account rows do not record which connection a user came through; the move trusts `to`'s IdP with every listed member's identity (residual, documented — S14).
- F6 No automatic choice of connection: `--to` is always operator-supplied.
- F7 `bind --claim <c> --provider <p>` on a claim already bound to `p` whose binding was not written by an operator records an operator attestation (C7), so R-c is satisfiable.

Non-functional:
- NF1 Runs on `MIGRATION_DATABASE_URL`; never imports `src/lib/prisma.ts` (`tenant-domain-import-graph.test.ts`). `rekey-accounts` also needs the `share-master` key (env, or the cloud key provider's credentials); the file header and README say so.
- NF2 Every operator-text echo goes through `escapeUnsafeDisplayChars`.
- NF3 No token plaintext, no ciphertext, no decrypt/driver error text, and no `providerAccountId` reaches stdout, stderr or the audit row, on any path including unexpected errors (C1 step 11).

## Technical approach

A new exported command `cmdRekeyAccounts` in `scripts/tenant-domain.ts`, shaped like `realign` (single bypass transaction, confirmation inside it, `confirmationTransaction.options()` budget) and `backfill-owning-column` (list by default, `--apply` to write). Re-encryption reuses `decryptAccountTokenTriple` / `encryptAccountTokenTriple` (`src/lib/crypto/account-token-crypto.ts`). A verify pass before confirmation decrypts the snapshot and discards the plaintext; after confirmation the command re-reads and compares everything it showed, re-warms keys, and re-encrypts from the same snapshot row by row. The write is a compare-and-swap `updateMany` whose expected values are the snapshot. Audit rows are written with `enqueueAuditInTx` in the same transaction. Errors raised in the transaction propagate out of `withBypassRls` (a 23505 aborts the transaction) and are mapped to fixed messages outside it.

Concurrency: no isolation-level dependency and no row locks taken by the reads (a second-connection write during the prompt must not block). The design relies on (a) the unique index `accounts_provider_provider_account_id_key`, which aborts the transaction on a racing insert at the target key, (b) the CAS affected-row count, and (c) the post-confirmation re-read comparison. None depends on the isolation level a pooler grants; all three races are driven in the integration test.

## Contracts

### C1 — `cmdRekeyAccounts`

```ts
export async function cmdRekeyAccounts(args: {
  tenant: string; to: string; by: string;
  apply?: boolean; yes?: boolean; confirm?: ConfirmFn;
}): Promise<CmdResult>
```
`CmdResult.rows`: one element per candidate `{ accountId, userId, memberId, tokens: ("refresh_token"|"access_token"|"id_token")[] }` (no `providerAccountId`).

Order (each refusal returns `{ ok:false, code:1 }` with nothing written):
1. `MIGRATION_DATABASE_URL` missing → `missingUrlResult()`, no client built.
2. `validateActorLabel(by)`.
3. `readAppEnv("rekey-accounts")`; refused config or not present → refuse.
4. `to` must start with `JACKSON_CONNECTION_PROVIDER_ID_PREFIX` and be in `claimProviders`. Print the caveat that "configured" is this process's env and the app's runtime env must list `to` too; when `saml-jackson` is configured in this env, print that the unmoved accounts at it remain governed by `legacy-accounts`.
5. `await getKeyProvider()` (C6).
6. One `withBypassRls` transaction. Read the snapshot `S`:
   a. tenant (`resolveTenantRef`); refuse unknown and `SYSTEM_TENANT_ID`;
   b. the tenant's claims and, per claim, the deciding binding event (C2);
   c. candidates (F5) ordered by `accounts.id` ascending, with every column the CAS and AAD use;
   d. conflicts (F4).
   Then C2 over `S`; warm keys for the versions in `S` (C6, per version, failures attributed to their accounts as `KEY_UNAVAILABLE`); decrypt every candidate's triple under `{userId, provider: "saml-jackson", providerAccountId}` with `onFieldError` collecting `(accountId, field, kind)`; plaintext discarded. Print the tenant summary, each live claim with provider, `createdBy` and deciding event label/time, the candidates, and every refusal (decrypt failures by `kind`, `TAMPERED` distinct from `CORRUPT` / `KEY_UNAVAILABLE`; "a refusal writes no audit row").
7. Any refusal → code 1 (C2 is evaluated before the zero-candidate check). No `--apply` → code 0, "dry run". Zero candidates → code 0, nothing to do.
8. Confirm (`yes` or `confirm`), else "Aborted: not confirmed." (code 1, nothing written).
9. Re-read `S'` (steps 6a–6d) and compare with `S`: tenant id; the SET of non-revoked claim ids, and per claim its provider, `revokedAt` and deciding event `seq`; the SET of candidate account ids; the conflict set. `S'` equal to `S` carries C2's result over (a claim added during the prompt makes the sets differ). Any difference → throw the fixed "changed during confirmation" error (rolls back). Per-row columns of a candidate that stays a candidate are the CAS's job (step 10), not the re-read's — the two are disjoint so each race reaches exactly one of them.
10. Re-warm keys (C6). For each candidate of `S` in order: decrypt the snapshot ciphertexts under the old AAD, `encryptAccountTokenTriple` under the new AAD, then `tx.account.updateMany` with `where: Prisma.AccountWhereInput = { id, userId, tenantId, providerAccountId, provider: "saml-jackson", refresh_token, access_token, id_token }` (snapshot values; null compiles to `IS NULL`) and `data: Prisma.AccountUpdateManyMutationInput = { provider: to, refresh_token, access_token, id_token }`. `count !== 1` → throw the fixed CAS error naming the account id. Then `enqueueAuditInTx` (C3). Each row's plaintext is dropped after its write.
11. Outside `withBypassRls` (outer `catch`): `confirmationTimeoutResult`; the CAS and "changed" errors → their fixed messages; `isUniqueViolationOn(e, "accounts_provider_provider_account_id_key")` → "another account at <to> appeared during the run; nothing was moved"; any other error → "rekey-accounts failed; nothing was moved (<error class>[, SQLSTATE <pgErrorCode>])" — never the message or cause.

Invariants:
- I1 (app-enforced) No write unless every candidate decrypted, C2 passed, no conflict exists, and the post-confirmation re-read equals what was shown.
- I2 (schema-enforced) `(provider, providerAccountId)` unique — a racing insert at the target key aborts the transaction.
- I3 (app-enforced, CAS) A row whose `userId`, `tenantId`, `providerAccountId`, `provider` or any ciphertext differs from the snapshot is not overwritten; the run rolls back. Schema cannot express "re-encryption saw the current AAD and ciphertext".
- I4 After the move, the row's tokens decrypt under `{userId, provider: to, providerAccountId}` and not under the old AAD; all other columns are unchanged.

Control class: `fail-closed verification gate`. Adjudication authority: AES-GCM tag verification (`decryptWithKey` via `decryptAccountTokenTriple`) for "decrypts"; the unique index for conflicts; `listClaimProviderIds(process.env)` for "configured"; C2's authority below.

Forbidden patterns (Phase 2/3 conformance grep over the diff):
- pattern: `UPDATE accounts SET provider` — reason: the raw UPDATE the issue says fails.
- pattern: `tx.account.update(` — reason: non-CAS write loses I3.
- pattern: `onFieldError: () => {}` — reason: a swallowed decrypt failure moves a row with a null token.
- pattern: `logAuditAsync` in `scripts/tenant-domain.ts` — reason: audit must be in the moving transaction.

Acceptance:
- Preview lists the candidates and exits 0; account rows and the tenant's outbox rows are unchanged.
- Apply moves exactly the active members' `saml-jackson` accounts; inactive members' accounts, other tenants' accounts, and the members' accounts at other providers are byte-identical before and after (seeded, with a non-empty moved set).
- After apply, in one test: `decryptAccountTokenTriple(row, newAad)` returns the original plaintexts and `decryptAccountTokenTriple(row, oldAad)` throws; null fields stay null; `expires_at`, `scope`, `token_type`, `session_state`, `type`, `tenantId` unchanged.
- Re-running apply after success → zero candidates, exit 0.
- Each refusal leaves accounts and the tenant's outbox unchanged and exits 1, preview and apply alike.
- Races (Testing strategy) roll back every row and write no audit row.

Consumer-flow walkthrough (persisted-state shape: the moved `accounts` row):
- `getUserByAccount` (`src/lib/auth/session/auth-adapter.ts`) reads `{provider, providerAccountId}` → user. Satisfied: provider is `to`.
- The adapter's account token reader decrypts with `{userId, provider, providerAccountId}` from the same row. Satisfied by I4.
- `ensureTenantMembershipForSignIn` → `claimedTenantMembership` (`src/auth.ts`) compares the asserted claim's `tenant_claims.provider` with the sign-in provider (`tenant_claim_provider_mismatch`); strict mode refuses an unbound claim. Satisfied by C2 R-b. A sign-in that presents no claim takes the existing-user path, which no claim check covers — the residual stated in C2.
- `tenant-domain legacy-accounts` reads `provider = 'saml-jackson'`; moved rows drop out. `bind --from-members` / `list --unbound` evidence reads `account.provider`; moved users count at `to`.
- `Session.provider` is not touched: its only reader (`src/lib/auth/session/recent-current-auth-method.ts`) compares it with `"webauthn"`.

### C2 — claim-binding consistency check (not a trust root)

What C2 is: a check that the move agrees with bindings an OPERATOR recorded, and that the moved users can sign in afterwards with any claim of the tenant. What it is not: proof that the tenant's IdP sits behind `to`. That remains the operator's attestation (`--by`, recorded); a sign-in that presents no claim reaches a moved account through the existing-user path whatever C2 says.

Over the tenant's non-revoked `tenant_claims` rows (revoked rows are ignored):
- R-a at least one is bound to `to`;
- R-b every one is bound to `to` or to `google` — an unbound claim, or one bound to any other provider (`saml-jackson`, another `saml-jackson-*`, anything else), refuses. The refusal names each offending claim and its provider and says what resolves it: bind a Google-domain claim to `google`, bind the tenant's SAML claim to `to`, or revoke a claim that belongs to another connection. No override flag.
- R-c for each claim bound to `to`, `bindingAttestation(events)` (C7) must be non-null with `provider === to` and `operator === true`.

The preview marks a claim whose deciding event is a same-provider `rebind` preceded by an engine-labelled binding as "attested after sign-in registration".

Control class: `fail-closed verification gate` over the recorded bindings; the residual (claimless sign-in, operator mis-attestation, a member who came through another connection — F5) is declared. R-c's "operator" is decided by `actor_label` alone, which a direct writer with INSERT on `tenant_claim_events` (including `passwd_app`) can set — tripwire grade against a compromised writer, the same class `validateActorLabel` declares; `db_user` is the unforgeable attribution and is printed for the operator, not adjudicated. Adjudication authority: `tenant_claims` (`provider`, `revokedAt`, `tenantId`) and `tenant_claim_events` via C7.

Acceptance: refuse (nothing written) for — no claim; only an unbound live claim; an unbound Google-domain claim beside a `to` claim; a live claim bound to `saml-jackson-other` or to `saml-jackson` beside one bound to `to`; a claim bound to `to` whose deciding event's label is `signin`, `backfill` or `db-delete`; an operator binding followed by a later `signin` event carrying `new_provider = to`; a claim bound to `to` with no events; a revoked claim bound to `to` as the only one. Proceed for — all live claims bound to `to` by operator events (including `bind … --accept-unused-provider`); a `signin` binding followed by the C7 attestation; a `google`-bound claim beside them; a revoked claim bound elsewhere beside a live operator binding to `to`; an operator binding followed by an operator `revoke`-then-`add --provider to`.

### C3 — audit action `ACCOUNT_PROVIDER_REKEYED`

One row per moved account, enqueued in the moving transaction:
`{ scope: TENANT, action: ACCOUNT_PROVIDER_REKEYED, userId: SYSTEM_ACTOR_ID, actorType: SYSTEM, tenantId, targetType: TENANT_MEMBER, targetId: memberId, metadata: { movedUserId, previousProvider: "saml-jackson", provider: to, claims, claimsOmitted, runId, by } }`.
`claims` is the first `REKEY_AUDIT_MAX_CLAIMS` (10) claims bound to `to`, `claimsOmitted` how many more — the `unlinkedAccountIds`/`unlinkedAccountIdsOmitted` shape (`src/lib/tenant/member-passkey-revoke.ts`), which keeps the metadata well under `METADATA_MAX_BYTES` (10 × 255-char claims ≈ 2.6 KB of 10 KB). `runId` is one `randomUUID()` per apply. No `providerAccountId`, token material, key material or error text.

Registration member set (R12), derived from `grep -rn USER_TENANT_REALIGNED src messages prisma docs/operations`:
- `src/lib/constants/audit/audit.ts`: `AUDIT_ACTION`, `AUDIT_ACTION_VALUES`, `AUDIT_ACTION_GROUPS_TENANT[ADMIN]`
- `prisma/schema.prisma` enum `AuditAction` + migration `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ACCOUNT_PROVIDER_REKEYED'`
- `messages/{en,ja}/AuditLog.json`
- `docs/operations/audit-log-reference.md` (group table + metadata description)
Enumerating tests expected to move with it (run red→green first): `src/__tests__/audit-action-group-coverage.test.ts`, `src/__tests__/audit-i18n-coverage.test.ts`, `src/__tests__/audit-bypass-coverage.test.ts`, plus any further failure the full suite reports.

Consumer walkthrough: the tenant audit-log view/download reads `{action, targetType, targetId, metadata}` and renders the i18n label for `action`; webhooks subscribed to `group:admin` receive the row. Satisfied by the registration.

### C4 — bypass grants

`BYPASS_GRANT.TENANT_ACCOUNT_REKEY_READ` (preview) and `TENANT_ACCOUNT_REKEY_APPLY` (apply; adds what `enqueueAuditInTx` reaches). The model sets are what `scripts/checks/check-bypass-rls.mjs` derives as reached. The `bind` change (C7) reads `tenantClaimEvent`, already in `TENANT_CLAIM_BINDING_WRITE`. `operator-scripts-rds-shaped.integration.test.ts` gains a preview cell and an apply cell; both seed an account with real encrypted tokens and an operator-bound claim, so the decrypt, claim-event and conflict reads and `enqueueAuditInTx` run under the probe role.

### C5 — CLI surface and docs

- `scripts/lib/tenant-domain-flags.ts`: `VALUE_FLAG_HINTS.to`; `SUBCOMMAND_FLAGS["rekey-accounts"] = ["tenant","to","by","apply","yes"]`.
- `main()` dispatch arm; `printUsage` (rekey-accounts, and `bind`'s attestation behaviour); file header usage line and NF1 paragraph.
- README "SSO tenant claim binding upgrade": replace "This release cannot move their accounts … Until a re-key command ships …" with the procedure — bind every live claim of the tenant (its SAML claim to its connection, a Google-domain claim to `google`; `bind` again on a claim sign-in already bound, to attest it) → `rekey-accounts` preview → `--apply` → `legacy-accounts`; state the residuals (claimless sign-in; the move trusts `to`'s IdP with every listed member); state that users active in no tenant are moved only after `realign` (SC1); add the commands to the code block.
- CLAUDE.md admin-scripts `tenant-domain` line gains `rekey-accounts` and the `bind` attestation.

### C6 — key provider initialised and warmed

`account-token-crypto` reads keys through `getKeyProviderSync()`, which throws for a cloud `KEY_PROVIDER` unless initialised and serves only versions it fetched: `getKey` refetches an entry older than `ttlMs` and otherwise returns the cache; `getKeySync` throws past `maxStaleTtlMs` (`src/lib/key-provider/base-cloud-provider.ts`).

- `warmShareMasterKeys(versions: Iterable<number>): Promise<Map<number, "ok" | "unavailable">>` in a prisma-free module `scripts/lib/share-master-keys.ts`: awaits `getKeyProvider()`, then `getKey("share-master", v)` for each given version and the current one, each in its own try, reporting per version. `collectEnvelopeVersions(values)` there too: `parseEnvelope` in a try per value; a value that does not parse contributes no version (the decrypt pass reports it as `CORRUPT`).
- `cmdRekeyAccounts` reaches it through an exported seam object `shareMasterKeyWarmer = { warm: warmShareMasterKeys }` (like `migrationClientFactory`), calls it before the verify pass and again after confirmation. A version reported unavailable in the verify pass marks every account carrying it `KEY_UNAVAILABLE` (refusal); in the apply pass it aborts with nothing written. Re-warming after confirmation refetches entries older than `ttlMs`; the rest stay valid under `maxStaleTtlMs`, and a decrypt that still finds a key missing throws and rolls back.
- `scripts/migrate-account-tokens-to-encrypted.ts` encrypts through `getKeyProviderSync()` with no initialisation and so throws under a cloud provider (R34): an exported `prepareMigration()` warms the current version and refuses if it is unavailable, and `main()` calls it before the first batch.

### C7 — operator binding attestation (shared by C2 R-c and `bind`)

- Pure `bindingAttestation(events: { seq: bigint; newProvider: string | null; actorLabel: string }[]): { provider: string; operator: boolean; seq: bigint; actorLabel: string } | null` in `scripts/lib/tenant-domain-binding.ts`: the latest event by `seq` with a non-null `newProvider` decides; `operator` is `actorLabel.trim().toLowerCase()` not in `ENGINE_WRITTEN_LABELS` (the normalisation `validateActorLabel` applies). Null when no event carries a provider. One adjudicator for "an operator bound this claim to X", used by both callers (R48).
- `cmdBind --claim <c> --provider <p>` where the claim is already bound to `p`: if `bindingAttestation` reports `operator: true` for `p`, unchanged ("already bound … No change made"). Otherwise (the deciding event is engine-written, or there is none), it runs the same evidence check and confirmation as a real rebind and records a `rebind` event with `oldProvider = newProvider = p` and the operator's `--by`, through `rebindInTx` (its CAS holds with the provider unchanged). The prompt prints the deciding event being attested (label, `seq`, time, `db_user`) and the claim's `createdBy`, every DB-sourced field through `escapeUnsafeDisplayChars`, and a sentence derived from that event — "this binding was written by `<label>` (engine), not by an operator", or "no recorded event binds this claim" when `bindingAttestation` is null — followed by: attesting it lets `rekey-accounts` move this tenant's members onto `p`. On this path the evidence block adds one line: zero holders of `p` is expected before the move, with the count of members holding `saml-jackson`; `majorityRefusal`'s text is unchanged on every other path. The result says an attestation was recorded. Before a rekey, the tenant's members still hold `saml-jackson` accounts, so the majority check refuses unless `--accept-unused-provider` is given — expected here, as in scenario 1, and the README says so. `bind --apply` is unaffected (it binds unbound claims only). Other readers of `rebind` events: `history` prints old/new provider verbatim (old = new reads as an attestation); `readProvenance` reads register/reassign/unrevoke only — neither treats it as a provider change.

Acceptance: `bind` on a `signin`-bound claim records exactly one `rebind` event (old = new = `p`, label = `--by`) and leaves `tenant_claims.provider` unchanged; a second `bind` reports already bound and writes nothing; `bind` on an operator-bound claim writes nothing; the attestation path still refuses on the majority check without `--accept-unused-provider`. `bindingAttestation` unit cells: latest-by-seq wins in both orders; null-`newProvider` events (deregister) are skipped; label normalisation (`" SignIn "` is engine); empty list → null.

## Testing strategy

Integration — `src/__tests__/db-integration/tenant-account-rekey.integration.test.ts`, production `cmdRekeyAccounts`, production crypto:
- Fixtures: `createTestContext`; tenant/claim/user/member rows per test with `runToken()`-derived claims and `providerAccountId`s; Jackson providers from `stubClaimProviderEnv` with test-scoped ids; tokens seeded through `encryptAccountTokenTriple` (works under the local and CI `SHARE_MASTER_KEY`); operator bindings via `cmdAdd`/`cmdBind`; engine bindings by creating the claim row and calling `recordTenantClaimEvent` with `signin`/`backfill`/`db-delete` inside a `ctx.su` transaction. Cleanup in `finally`: `tenant_claim_events` rows for the test's claims deleted explicitly by claim (they are not tenant-cascaded), then the tenant data. `vi.unstubAllEnvs()` after each test. Outbox assertions filter by `tenant_id` and action.
- Cells (each deny asserts account rows and the tenant's outbox unchanged — RT8 — with a paired allow — RT10):
  - C1 steps 1–4: missing URL (spy: no client built), bad `--by`, no app env, `to` = `saml-jackson` / `google` / unconfigured `saml-jackson-x`; stdout carries the step-4 caveat, and the legacy reminder when `saml-jackson` is configured.
  - Every C2 acceptance line; preview stdout shows each live claim's provider and deciding label.
  - Decrypt: bad tag (`TAMPERED`), unknown key version (`KEY_UNAVAILABLE`), non-envelope (`CORRUPT`) — each kind's text asserted in stdout; a triple mixing a `CORRUPT` field with valid ones refuses as `CORRUPT`; a triple with a null `access_token` beside non-null fields moves and keeps the null.
  - Conflicts: existing `(to, pid)` row; candidate user already holding another `to` row.
  - Preview and apply exit codes agree on a refusal; C2 refusal with zero candidates exits 1; decline at confirm writes nothing; zero-candidate apply exits 0; re-run after success exits 0 with nothing moved.
  - Moved-set boundaries per C1 acceptance; post-move decrypt pair in one test.
  - Audit: one outbox row per moved account with the C3 shape; metadata keys exactly `{movedUserId, previousProvider, provider, claims, claimsOmitted, runId, by}`; one `runId` across the run; a tenant with 12 max-length claims bound to `to` keeps `movedUserId`/`runId` and `claimsOmitted = 2`; no row after preview, refusal, decline or rollback.
  - Key warming: `shareMasterKeyWarmer.warm` spied — called before the verify pass with the snapshot's versions, and again after the `confirm` seam returns; a spy returning `unavailable` for a version in the verify pass refuses as `KEY_UNAVAILABLE`, and only in the second call aborts the apply with nothing written.
  - NF3: seeded plaintext markers, ciphertexts and the `providerAccountId` never appear in captured stdout/stderr or in the outbox payload, across allow, TAMPERED, race and unexpected-error paths. Unexpected error: the warmer seam throws an error whose message embeds the pid marker → generic fixed message, marker absent.
  - Race fixtures: at least two candidates, plus an active member of the tenant with no `saml-jackson` account (race b). The implementation calls the seams through their objects (`shareMasterKeyWarmer.warm(...)`), never destructured, so a spy intercepts them; allow-path spies call through.
  - Races via the `confirm` seam on `ctx.su` (except (c)), each with a `raced` flag asserted `true`, the second-connection write's row count asserted 1, and the specific fixed message asserted (RT4). Candidates are ordered by `id` in the database; the victim is the last `accountId` of the preview's `CmdResult.rows` (not a test-side sort — ids mix CUID and UUID), so the CAS error naming it proves the loop wrote the earlier rows before rolling back: (a) CAS — rewrite the victim's `access_token` with another valid ciphertext → all rows at `saml-jackson` with original bytes, zero audit rows; (b) CAS on `user_id` — re-point the victim to another ACTIVE member of the tenant who holds no `saml-jackson` account, so the candidate account-id set is unchanged and the step-9 re-read passes → CAS message, same rollback assertions; (c) insert — injected through the SECOND `shareMasterKeyWarmer.warm` call (after the step-9 re-read, before the first write; through `confirm` the re-read would catch it as a conflict-set change): a new user (with `tenantId`) with an account at `(to, pid-of-the-last-candidate)` → unique-violation message, no pid in output, earlier rows rolled back, nothing moved; (d) re-read — one cell per compared term: rebind a claim (provider), revoke a claim (`revokedAt`), add an unbound claim (claim-id set), un-revoke a revoked claim bound elsewhere (claim-id set grows), append an operator attestation to a `to` claim (deciding `seq` only), record a `signin` event with `new_provider = to` on an operator-bound claim (deciding `seq` only), deactivate a candidate's membership (candidate set), insert a row at `(to, pid-of-a-candidate)` (conflict set): each → "changed during confirmation"; (e) control — a write to a non-candidate account during confirm does not abort the run.
- `operator-scripts-rds-shaped.integration.test.ts`: preview and apply cells (C4); header table updated. Bind attestation cell under the probe role.
- `tenant-claim-cli-binding.integration.test.ts`: C7 `bind` acceptance cells, parameterised over a deciding event labelled `signin`, `backfill`, `db-delete`, and no event — each attested, then a `rekey-accounts` preview passes R-c. Captured stdout asserts the attestation prompt (deciding label, seq, `createdBy`, the event-derived sentence per variant including "no recorded event", consequence sentence; a control character seeded into `actor_label` and `created_by` prints escaped) and the "attestation recorded" result; the rekey preview shows the "attested after sign-in registration" marker, absent for a claim an operator bound directly.

Unit:
- `scripts/__tests__/tenant-domain-binding.test.ts`: `bindingAttestation` cells (C7).
- `scripts/__tests__/tenant-domain-flags.test.ts`: `rekey-accounts` flags, `--to` hint, stray-flag refusal.
- `scripts/__tests__/tenant-domain-cli-dispatch.test.ts`: dispatch arm and usage on missing flags.
- `scripts/__tests__/share-master-keys.test.ts` (C6): `_resetKeyProvider()`, `KEY_PROVIDER=aws-sm`, `AWS_REGION`, `SHARE_MASTER_KEY_CURRENT_VERSION` stubbed; `vi.mock("@/lib/key-provider/aws-sm-provider")` (the module `getKeyProvider` dynamically imports) with a stateful fake whose `getKey` fills a cache and whose `getKeySync` throws on a miss. Negative control: before warming, production `getMasterKeyByVersion(v)` throws; after warming, it succeeds for each given version and the current one. A rejecting version is reported `unavailable` while the others are `ok`. `collectEnvelopeVersions` skips non-envelopes. `prepareMigration()`: warms before returning; refuses when the current version is unavailable. `afterEach` resets the singleton and env.
- `scripts/__tests__/tenant-domain-import-graph.test.ts` passes unchanged.

RT7 red-proofs, one mutation per clause, on scratch copies only: drop each CAS predicate group (ciphertexts; `userId`/`providerAccountId`/`tenantId`); move `enqueueAuditInTx` after the transaction; skip R-a; skip R-b; skip R-c; make `bindingAttestation` pick the earliest event; drop its label normalisation; stop it skipping null-`newProvider` events; ignore `operator` in R-c; ignore `provider === to` in R-c; skip the evidence check on `bind`'s attestation path; drop each step-9 term separately (claim-id set, per-claim provider, `revokedAt`, deciding `seq`, candidate set, conflict set); skip the conflict reads; drop the post-confirm warm call; drop `onFieldError` collection; drop the unique-violation mapping; let the generic error path print the message; make `bind` keep its old same-provider no-op; drop a model from each new grant.

Mandatory before completion: `npx vitest run`, `npx next build`, `npm run test:integration`, `node scripts/checks/check-bypass-rls.mjs` and the other `scripts/pre-pr.sh` gates.

## Considerations & constraints

Scope contract:
- SC1 Users with a `saml-jackson` account and no active membership (`legacy-accounts`' "(no active tenant)" group) are not moved: there is no member evidence for them. The README tells the operator to `realign` them onto a tenant first.
- SC2 Automatic selection of the connection per tenant: deliberately absent (issue #954).
- SC3 Claimless tenants, and tenants whose live claims span providers other than `to` and `google`: refused by C2; the operator registers/rebinds/revokes first. No override flag.
- SC4 Batching for very large tenants: one transaction per tenant under the 10-minute confirmation budget. A tenant too large for it is not addressed.
- SC5 Plaintext zeroisation: JavaScript strings cannot be zeroed; the design holds no plaintext across the prompt and drops each row's plaintext after its write.

Risks:
- Operator names the wrong connection: C2 requires agreement with operator-recorded bindings of every live claim; the audit row records `--by`, the claims and the run id; `db_user` on claim events is the real attribution.
- The legacy `saml-jackson` provider still configured: moved rows no longer match it; the command prints the `legacy-accounts` reminder for the rest.
- `bind`'s new attestation path changes a former no-op into a recorded event: it writes only an event (provider unchanged), behind the same evidence check and confirmation.

## User operation scenarios

1. Connections A and B were behind `saml-jackson`; `AUTH_JACKSON_CONNECTIONS` now lists both. T1's claim `t1.example` was bound to `saml-jackson-a` with `bind --claim … --accept-unused-provider`. `rekey-accounts --tenant t1.example --to saml-jackson-a --by ops` lists T1's users, exit 0; `--apply` confirms and moves them; T1's users sign in through A.
2. Operator types `--to saml-jackson-b` for T1 → refused by R-a/R-b (T1's claim is bound to A).
3. T1 also has `t1-legacy.example`, unbound → refused by R-b, naming the claim; the operator binds or revokes it.
4. A claim auto-registered by a sign-in through A → refused by R-c; the operator reviews the printed origin and runs `bind --claim <c> --provider saml-jackson-a --accept-unused-provider --by ops`, which records the attestation (C7); the rekey then proceeds.
5. One token was written under a master key version not loaded → `KEY_UNAVAILABLE`, refused; operator loads the version and re-runs.
6. A T1 user already signed in through A as a new user (row at `(saml-jackson-a, pid)`) → conflict refusal; operator resolves the duplicate user by hand.
7. Re-run after success → zero candidates, exit 0.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | cmdRekeyAccounts: order, snapshot/re-read, CAS write, error mapping | locked |
| C2 | claim-binding consistency check (R-a/R-b/R-c) | locked |
| C3 | ACCOUNT_PROVIDER_REKEYED audit action + registration | locked |
| C4 | bypass grants | locked |
| C5 | CLI surface + docs | locked |
| C6 | key warming helper + seam (+ migrate-account-tokens fix) | locked |
| C7 | bindingAttestation + bind attestation path | locked |
