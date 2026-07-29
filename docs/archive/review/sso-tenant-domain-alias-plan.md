# Plan: SSO tenant domain registry + env-var documentation gate

Date: 2026-07-29
Branch: `fix/sso-tenant-domain-alias`
Revision: 4 (after round-3 review — see `sso-tenant-domain-alias-review.md`)

> **Documentation policy for this plan and every artifact it produces:** no real
> customer/company domain names, no real email addresses. Use `primary.example`
> (the domain the tenant was originally provisioned under) and `alias.example`
> (the new `hd` value the IdP started sending) as placeholders throughout.

---

## What changed in revision 5

Round 4 returned **zero** Criticals against the design — security's second consecutive
clean round, with the round-3 remedy (`SAVEPOINT` recovery) empirically validated against
the dev database. All six Criticals were against *this document's* mechanism
specifications: `ALTER TABLE … DROP CONSTRAINT` naming an object created as
`CREATE UNIQUE INDEX`, an `@import` directive Prisma does not have, a `SAVEPOINT` placed
after the statement that aborts the session, a mock surface missing `$executeRaw`, a
`P2002` acceptance criterion the contract body had already deleted.

Those are what `npx next build`, `npx vitest run` and `npm run db:migrate` surface in
minutes. Revision 5 therefore does two things:

1. **Settles the three items only plan review can settle** — D1 (deploy window), D2
   (revoked-claim semantics), D3 (normalisation equivalence). Each is a decision, not a
   detail: getting them wrong produces the same lockout this PR exists to fix, and no
   compiler or test suite would have asked the question.
2. **De-specifies the implementation detail.** Exact SQL text, exact Prisma call shapes,
   exact test line numbers and exact mock surfaces are removed from the contracts and
   replaced with the *obligation* and its *acceptance criterion*. At 1650 lines the plan
   had become the defect surface; specifying `deleteMany({where:{domain}})` in prose buys
   nothing that `tsc` does not buy in one second, and costs a review round when it is
   wrong. Phase 3 re-reviews the resulting code with the same three experts, so the
   verification is deferred, not dropped.

What remains specified is what the toolchain cannot check: which invariant is
schema-enforced versus app-enforced, which adjudicator decides each predicate, which
member sets must be re-derived from code, which paths must assert a mutation rather than
a verdict, and which behaviours are deliberate narrowings with a stated cost.

### D1 — Deploy window: expand-and-contract

`scripts/deploy.sh` is migration-first, so the migration runs while the **old** code is
still serving. Old `findOrCreateSsoTenant` writes `tenants.external_id` and no claim row,
and the backfill has already run — that row is never filled. A claim first presented
during the roll therefore produces a tenant the new resolver cannot see, and the affected
users are denied `tenant_claim_unmapped` permanently. Dropping the unique index in the
same release compounds it: with the index gone and old code live, two concurrent first
sign-ins create two tenants with the same `external_id` — the round-2 **S1** shadow-tenant
class, inside its own rollout window.

**This PR is release 1 of two.**

- `resolveTenantByClaim` falls back to `Tenant.externalId` (exact match on the raw claim,
  today's semantics) when no `tenant_claims` row matches.
- `findOrCreateTenantForClaim` writes **both** the claim row and `externalId`.
- `Tenant.externalId` keeps its unique index.
- **SC10** owns release 2: remove the fallback, the `externalId` write, and the index,
  once no live code reads or writes the column.

The cost is one release in which two keys exist. It is bounded, because the fallback makes
them agree by *reading* rather than by convention — the state round 3 objected to was two
keys with no reconciliation, not two keys.

### D2 — Revoked-claim semantics

`revokedAt` keeps a claim's lifetime available to the incident response that discovers it,
but the row keeps its slot in `UNIQUE(claim)` while the resolver filters `revokedAt: null`.
Round 4 found both halves of the resulting hole: a first-ever sign-in presenting a revoked
claim proceeds to create and collides, aborting the auth transaction; and `add` after
`remove` reports success without clearing `revokedAt`, so **the recovery tool says it
recovered while the tenant stays locked out**.

- `findOrCreateTenantForClaim` looks for a row **including revoked ones** under the
  advisory lock. A revoked row means the claim is taken and needs an operator decision:
  return `null`, which the dispatch maps to a deny with `tenant_claim_unmapped` — the
  reason that makes `unmapped` show it.
- `add` clears `revokedAt` when the named tenant already owns the row, and refuses with an
  explicit *revoked, owned by tenant X* message otherwise.

A partial unique index (`UNIQUE (claim) WHERE revoked_at IS NULL`) is rejected: it would
permit two revoked rows per claim and weaken I1 from a total to a conditional constraint.

C3's revision-4 justification for filtering in application code — *"so a revoked row still
occupies its claim in the unique index"* — is withdrawn. Index occupancy is a property of
the table, not of the query. The real reason is that `findUnique`'s shape is simpler, and
the fail-open risk that creates is closed by the C4 obligation above plus a forbidden
pattern against bare `tenantClaim.findUnique` outside the resolver.

### D3 — Normalisation equivalence

SC9's claim that an ASCII restriction makes the Postgres and JS folds agree is **false**,
demonstrated empirically in both directions:

```
pg:  lower('İ')                    = 'i'          (1 char, pure ASCII)
js:  'İ'.toLowerCase()             = 'i' + U+0307 (2 chars, non-ASCII)
pg:  lower('I' COLLATE "tr-x-icu") = 'ı'          (non-ASCII from ASCII input)
```

The filter was applied to the **output** of `lower(btrim(...))`, so a value whose Postgres
fold is ASCII but whose JS fold is not passes and is stored — and then never matches at
sign-in. Worse, a *different* organisation asserting the plain ASCII spelling resolves
into that tenant.

- Fold with `lower(x COLLATE "C")` — locale-independent — in both the CHECK and the
  backfill.
- Apply the ASCII filter to the **raw** `external_id`, so everything non-ASCII lands
  uniformly in SC9's excluded set.
- C12's pre-flight query tests the raw column, and gains a third query listing rows where
  the two folds differ.
- `storableClaimSchema` carries the printable-ASCII predicate explicitly — revision 4
  asserted C2 enforced it while C2's definition and criteria never mentioned it.

## What changed in revision 4

Round 3 endorsed the unification — security reported **no Criticals** and confirmed
again that no cross-tenant exploit exists that does not begin with database-level
access — and returned three Criticals against the mechanism, one of them a
three-round recurrence.

| Finding | Revision 4 |
|---|---|
| **CR9** — `P2002` aborts the enclosing Prisma interactive transaction, so C4's recovery arm cannot run. Raised as round-2 **S13**, dismissed by revision 3, then reached independently by two round-3 reviewers | C4 gains `advisoryXactLock` before the resolve→create sequence — the repo's own primitive for this shape, used at five sites and enforced by `check-count-then-create-lock.mjs`. It **removes** the claim-key race rather than recovering from it. The residual slug collision runs in a `SAVEPOINT`. The proof moves to real Postgres via `raceTwoClients` |
| **CR10** — row 9 removed the bootstrap→SSO migration path | Row 9 splits into **9a** (bootstrap → create + migrate → allow) and **9b** (non-bootstrap → deny). Creating on an *allow* path does not conflict with D2 |
| **CR11** — the backfill criterion could not fail | The backfill statement is extracted to `scripts/lib/tenant-claim-backfill.sql`, `@import`ed by the migration and **executed** by the test against seeded rows |
| **M22** — `Tenant.externalId` kept an unreconciled `@unique` | The unique is dropped and the column is no longer written. Two globally-unique keys over one concept, populated by different rules, is the shape the unification exists to remove |
| **M23** — `lower(btrim())` ≠ `normalizeTenantClaim`; collation-dependent | The CHECK restricts the stored form to printable ASCII, making the two engines agree by construction. The narrowing is real and is recorded as **SC9** with its cost |
| **S3-3** — the CLI had no RLS context | Every command opens a transaction and sets `app.bypass_rls`/`app.tenant_id`. On RDS the master user is not `BYPASSRLS`, so without this the CLI returns *silent wrong answers* at incident time |
| **S3-4** — SC8's premise was false and `remove` destroyed its own evidence | `revokedAt` (soft delete) + `createdBy` (self-asserted) on the row; SC8's justification corrected rather than restated |
| **M24, M26, M27, M28, M29, M30, M31, F8, S3-5, S3-7, S3-13, T22, T25** | Folded in — the nested create input type named; the CLI given exported commands, a main guard and return codes; test member sets re-derived from the right primitive; the dispatch table grown to twelve rows; I7's grep extended to throws; the rename finished; the control flow stated explicitly; SC7's threat premise corrected; the row-6 absorption direction documented and surfaced in the CLI prompt |

Two simplifications from revision 3 survived round 3 intact and are not revisited: the
dropped `TenantDomainSource` discriminator (SC7) and the dropped audit actions (SC8,
now on a corrected justification).

## What changed in revision 3

Round 2 returned three Criticals and twenty Majors. One finding (Security S1) was not
a defect in the write-up but in the design: making `createUser` alias-blind — the
revision-2 fix for round-1's Critical — meant that the **next first-ever sign-in
after a successful recovery creates a tenant that shadows the alias**, re-locking the
whole tenant and silencing the plan's own diagnostic.

That, plus round 2's finding that requirement F4 was contradicted by the plan's own
dispatch rows 4 and 6, pointed at a cause upstream of both: **the tenant's identity
claim is stored in two places with different rules.** `tenants.external_id` is
created implicitly by whoever signs in first and is never curated;
`tenant_claims.claim` is registered explicitly by an operator. Nothing constrains
one against the other. Every symptom follows:

| Symptom | Because |
|---|---|
| D2 — a denied sign-in writes a `tenants` row | an authentication *attempt* mints an identity key |
| S1 — shadow tenant re-locks the tenant | two tables hold the same kind of key with no cross-constraint, and one is auto-populated |
| F4 self-contradiction | "alias" and "externalId" have no semantic difference, so a rule forbidding one of them cannot be coherent |
| I6 enforced by an unrun grep | the invariant only existed to keep the two kinds apart |

**Revision 3 unifies them.** `tenant_claims` becomes the single claim→tenant
resolution table; `Tenant.externalId` is retained for provenance but no resolver
reads it. There is one resolver, one namespace, and one unique index adjudicating
collisions.

Verified before committing to this: `Tenant.externalId` is read or written in
exactly **one** file — `src/lib/tenant/tenant-management.ts`, four sites (the
`directory-sync/engine.ts` hits are `ScimExternalMapping.externalId`, a different
model). In the dev database, 2 of 264 tenants have a non-null `external_id`, so the
backfill is small everywhere.

### Simplifications this revision also makes

Round 2's findings priced two pieces of machinery that revision 2 had bundled in.
Both are dropped, and both drops remove whole finding clusters:

- **The `TenantDomainSource` discriminator is gone.** Under unification, backfilled
  rows would have to mean "matches any source", which reintroduces a nullable-means-
  wildcard rule on top of an enum. Dropping it also drops the `extractTenantClaimValue`
  shape change — and with it round-2 **CR6** entirely (four unlisted consumers, a
  compile error at `src/auth.ts:351`, nine assertions in
  `src/lib/tenant/tenant-claim.test.ts`, and a factory-mock form that returns a
  *truthy* stale string no type-checker can catch). Matching the claim string
  verbatim is exactly today's behaviour, so NF2 holds by construction. The
  attestation concern is real but is a **different** hardening from the lockout fix —
  recorded as **SC7** with its threat statement.
- **The `TENANT_DOMAIN_ADD` / `TENANT_DOMAIN_REMOVE` audit actions are gone.** The
  CLI runs on `MIGRATION_DATABASE_URL`, where no application user identity exists, so
  the row would record `SYSTEM` — attribution that looks present and is not, which is
  worse than its absence. The repo's other database-level operator scripts
  (`bootstrap-rds-roles.mjs`, `set-outbox-worker-password.sh`) write no audit rows
  either. This drops the Prisma enum, the `ALTER TYPE` migration, `AUDIT_ACTION_VALUES`,
  both group arrays, both i18n files, the webhook-subscription decision (R11), round
  2's three-mutation proof problem (**T9**), and the `check-critical-audit-atomic.mjs`
  mis-citation (**M13**). Recorded as **SC8**.

- **"Domain" is renamed to "claim", and the hostname grammar moved off the storage
  layer.** Drafting revision 3 surfaced a regression the plan would otherwise have
  carried into review: `parseTenantClaimKeys()` defaults to `tenant_id`, `tenantId`,
  `organization`, `org`, `company`, `company_id` before the Google `hd` fallback, so a
  deployment configured that way legitimately has `Tenant.externalId = "acmecorp"`.
  Validating the resolution key as a hostname — which revision 3's first draft did, via
  `new URL()` and a mandatory dot — would have locked those deployments out, an NF2
  violation of the same shape as the bug being fixed. The registry stores **claim
  strings**; normalisation is trim + lowercase; the hostname check lives only at the
  operator CLI, where the values genuinely are domains. This also removes the
  `node:punycode`/`new URL()` question (round-2 **N15**) from this PR — see SC7.

### Round-2 corrections folded in

`.mjs` → `.ts` under tsx (**CR5**); the `:451-459` mapping corrected (**M14** — round
2 was right and revision 2 asserted the opposite without re-tracing); C3's tests moved
to a new file (**M16**); `scanAppEnvReaders` extended to `.tsx` (**M17**); the pepper
memo given a reset seam (**M18**); the dispatch table given its missing throw row
(**N5**); every forbidden pattern made executable or demoted to an acceptance criterion
(**N6**); `remove` given `--tenant` scoping and a dry-run (**S4**); the
`GOOGLE_WORKSPACE_DOMAINS` runbook given a removal condition and the correct symptom
(**S8**); `node:punycode` → `new URL()` (**N15**); Prisma methods and input types named
(**N11**); the `METADATA_BLOCKLIST` criterion restated (**N13/S11**).

---

## Project context

- **Type**: web app (Next.js 16 App Router) + service workers + CLI + browser extension
- **Test infrastructure**: unit (vitest) + real-DB integration (`npm run test:integration`) + E2E (Playwright) + CI/CD + ~60 repo gates under `scripts/checks/`
- **Verification environment constraints**:
  - **VE1 — IdP `hd` claim mutation is not reproducible locally.** Reproducing it needs
    a paid Workspace subscription plus a primary-domain rename against an owned domain.
    **Anti-Deferral cost-justification**: that buys verification of one link — "an IdP
    can emit a different claim for an unchanged email" — which is already **empirically
    confirmed by production data** (see Root cause). Everything downstream of
    `extractTenantClaimValue` is a plain string and is `verifiable-CI` at that seam.
  - **VE2 — the dev database is shared between working copies.** The CLI (C7) and the
    remediation (C13) must be idempotent and must not assume a single consumer.
  - **VE3 — the `check-env-docs` self-test runs against a fixture root** via `--root`,
    so C11's failure proof is `verifiable-CI` and mutates no real source.

---

## Root cause (established from production data)

| Time (UTC) | Observation |
|---|---|
| `07:25:42.705` | Row inserted into `tenants`: `external_id = <alias.example>`, `is_bootstrap = false` |
| `07:25:42.724` | `audit_logs`: `AUTH_LOGIN_FAILURE`, `{reason: "tenant_mismatch", provider: "google"}` |
| `07:28:39.418` | Same failure repeated; no second tenant row |

The user's `User.tenantId` points at the tenant whose `external_id` is
`<primary.example>`, `is_bootstrap = false`. Their email is unchanged; the Google `hd`
claim now reads `<alias.example>`.

1. `src/auth.ts:329-339` — `signIn` resolves `userId` by email; found.
2. `src/auth.ts:357` — calls `ensureTenantMembershipForSignIn`.
3. `src/auth.ts:52` → `src/lib/tenant/tenant-claim.ts:69-72` — `extractTenantClaimValue`
   returns `<alias.example>` via the Google `hd` fallback.
4. `src/auth.ts:71` — `findOrCreateSsoTenant` finds nothing and **creates a tenant**
   (`src/lib/tenant/tenant-management.ts:26-35`).
5. `src/auth.ts:78` — the new tenant id ≠ the user's existing tenant id.
6. `src/auth.ts:83`/`:211` — the existing tenant is not a bootstrap tenant → `null`.
7. `src/auth.ts:233` — `return !!tenant` → `false`.
8. `src/auth.ts:362-370` — emits `AUTH_LOGIN_FAILURE{reason:"tenant_mismatch"}`;
   `@auth/core`'s `handleAuthorized` turns a falsy `signIn` into
   `throw new AccessDenied("AccessDenied")`.

**D1 (lockout)** — tenant identity is keyed on a mutable IdP claim with no supported
way to say "`alias.example` is the same organisation as `primary.example`".
**D2 (write on a denied authentication)** — step 4 commits a row before step 6 rejects.

The `AUDIT_IDENTIFIER_PEPPER not configured` warning in the same window is **not** part
of the sign-in failure — it is emitted by `hashIdentifier`
(`src/lib/audit/auth-failure.ts:41`) while *recording* the failure. Separate defect (C8).

---

## Objective

1. Give a tenant more than one claim string, registered by a **deployment operator**,
   so an IdP domain change is survivable.
2. Stop a denied sign-in from creating a tenant row.
3. Provide a recovery path that works when **every** member is locked out — which rules
   out anything needing a session or a tenant-scoped token.
4. Make the claim→tenant mapping a single namespace, so a later tenant creation cannot
   shadow a registered claim.
5. Replace the zero-value empty-key HMAC fallback for audit identifier hashing.
6. Close the env-var documentation gap for the nine app-runtime variables read by
   `src/**` but declared nowhere, and add the missing gate direction.

---

## Requirements

### Functional

- **F1** A claim string maps to at most one tenant, enforced by the storage engine.
- **F2** A tenant may have one or more claim strings. Sign-in resolves through them.
- **F3** A sign-in that will be denied must not create, update, or delete any row other
  than the audit record of the denial.
- **F4** Creating a tenant for a previously unseen claim registers that claim in the
  same transaction, so no later creation can shadow an existing registration.
- **F5** A deployment operator with database access can add or remove a claim string
  with no session and no application token.
- **F6** A denial caused by an unregistered claim is distinguishable in the audit trail
  from other tenant mismatches, **and the audit record names the claim**, so the
  operator knows what to register.
- **F7** Audit identifier hashing either uses a real key or reports that it has none.
- **F8** All nine undeclared app-runtime env vars are declared, described, emitted into
  `.env.example`, and documented in both READMEs.

### Non-functional

- **NF1** Registering a claim string is a privilege-escalation primitive: whoever
  controls one controls which IdP claims land in that tenant. It is therefore restricted
  to actors who already hold database-level access — a strictly smaller set than tenant
  admins, and one that already has strictly greater power.
- **NF2** No behaviour change for deployments that never register a second claim string,
  and no new startup requirement.
- **NF3** Every new guard must be provably able to fail, demonstrated by a test or
  self-test, not asserted.

---

## Technical approach

### One namespace

`tenant_claims` holds every claim string that resolves to a tenant, including the one
each tenant already has in `tenants.external_id` (backfilled by C1's migration).
`Tenant.externalId` is kept as provenance and keeps its unique index as a second guard,
but **no resolver reads it**.

Consequences, all of them simplifications:

- One resolver. No two legs, no precedence rule, no `via` discriminator.
- Tenant creation inserts the tenant and its claim row in one transaction, so
  `UNIQUE(tenant_claims.claim)` adjudicates the race that revision 2 would have needed an
  application-side pre-check for. Round-2 **S1** disappears at the schema level.
- `createUser` and sign-in call the same function. There is no "alias vs externalId"
  distinction, so requirement F4 of revision 2 — and the unrun forbidden pattern that
  was supposed to enforce it (round-2 **CR7**) — are both unnecessary.

**Is the round-1 Critical still closed?** Yes. Round 1's exploit was that a *tenant
admin* could register a claim for an organisation they did not control, capturing that
organisation's first user. Under revision 3 a resolution row can be written only by
(a) the operator CLI, which requires database credentials, or (b) tenant creation
triggered by actually presenting that claim from an IdP — the same bar as today, and
strictly narrower than today because (a) did not previously exist as a curated path.
Nothing a tenant admin can do writes a row.

### Storage

A dedicated table rather than an array column on `tenants`: a `UNIQUE` constraint on
`domain` makes F1 enforceable by Postgres against any writer — a future migration, an
ad-hoc query, a not-yet-written code path.

`tenant_claims` carries a `tenant_id`, so the maintenance contract at the head of
`scripts/rls-cross-tenant-tables.manifest` applies: migration (column +
`ENABLE`/`FORCE ROW LEVEL SECURITY` + a `tenant_claims_tenant_isolation` policy),
seed rows in `scripts/rls-cross-tenant-seed.sql`, and an alphabetical manifest line.
Both files also carry a hand-written total ("Total: 55 tenant-scoped tables") that no
gate updates — those counts are part of the delta. The
`enforce_tenant_id_from_context` BEFORE INSERT trigger is **not** universal (28 of 55)
and this table does not take it.

### Why the recovery path is a CLI

D1's blast radius is the whole tenant, so any recovery needing a session or a
tenant-scoped token is unusable exactly when it is needed. An offline script run with
`MIGRATION_DATABASE_URL` needs neither, adds no HTTP attack surface, and requires no
change to the operator-token model. It names honestly what an HTTP variant silently
required: database access the operator already has.

### Concurrency

No new concurrency-control primitive. Creation relies on `UNIQUE(tenant_claims.claim)` and
`UNIQUE(slug)`; there is no read-then-write window whose correctness depends on an
isolation level, so the plan-stage real-DB isolation probe does not apply.

---

## Contracts

### C1 — `TenantClaim` model, migration, backfill, RLS, seed, manifest, grants

**Naming.** The table holds *claim strings that resolve to a tenant*, which are not
necessarily domains: `parseTenantClaimKeys()` defaults to `tenant_id`, `tenantId`,
`organization`, `org`, `company`, `company_id` before the Google `hd` fallback, and
`AUTH_TENANT_CLAIM_KEYS` can name others. A deployment configured that way stores
values like `acmecorp` in `Tenant.externalId` today. Calling the column `domain` — and,
worse, validating it as a hostname — would break those deployments, an NF2 violation
this plan caught in itself before review. The branch name and this file's name predate
the rename.

```prisma
model TenantClaim {
  id        String    @id @default(uuid(4)) @db.Uuid
  tenantId  String    @map("tenant_id") @db.Uuid
  claim     String    @unique @db.VarChar(255)
  createdBy String?   @map("created_by") @db.VarChar(255)
  createdAt DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)
  revokedAt DateTime? @map("revoked_at") @db.Timestamptz(3)

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@index([tenantId])
  @@map("tenant_claims")
}
```

`Tenant` gains `claims TenantClaim[]`, and **`Tenant.externalId` loses its `@unique`**
and is no longer written by any code path (round-3 **M22**, converged Major). Keeping a
second globally-unique key over the same concept, populated by a different rule (raw
claim vs normalised claim), is the exact shape the unification exists to remove: after
a `remove` or a rolled-back deploy the two desynchronise, and the next first-ever
sign-in presenting that claim hits `P2002` on `tenants_external_id_key`, which no branch
handles — a permanent, undiagnosable lockout. The column stays as historical provenance
for existing rows; nothing reads it (verified: one non-test file, four sites, no seeder,
no E2E fixture).

`revokedAt` and `createdBy` exist because of round-3 **S3-4**. `remove` **soft-deletes**
(sets `revokedAt`); `resolveTenantByClaim` filters `revokedAt: null`. Without it, the
responder's first action on discovering a wrongly-registered claim destroys
`tenant_claims.createdAt` — one of the two timestamps C12's own incident runbook needs,
making the runbook unexecutable in the order it will actually be followed. `createdBy`
is an operator-supplied, **self-asserted** label (`--by`), stated as self-asserted so it
is not mistaken for authenticated attribution.

Still no `source` and no `kind` (SC7).

**SC8's justification is corrected here, not restated.** Revision 3 deferred an
application-level audit row on the grounds that a `SYSTEM`-attributed row is
"attribution that looks present and is not". Round-3 **S3-4** showed that is false:
`emitAuthLoginFailure` writes `userId: SYSTEM_ACTOR_ID, actorType: ACTOR_TYPE.SYSTEM`
for every failed sign-in, as do the outbox, retention-GC and anchor-publisher workers.
`ACTOR_TYPE.SYSTEM` is a truthful statement about a non-human actor. The real reason to
defer is narrower and is now stated in SC8: the timeline the runbook needs lives on the
row itself (`createdAt`/`revokedAt`/`createdBy`), so the audit row would add only a
duplicate timestamp — and adding two `AUDIT_ACTION` values costs a Prisma enum, an
`ALTER TYPE` migration, `AUDIT_ACTION_VALUES`, two group arrays, two i18n files and a
webhook-subscription decision for that duplicate.

**Migration**, one file, inside the repo's standard `BEGIN; … COMMIT;` wrapper
(`check-migration-transaction.mjs` requires it once `ddlCount > 1`):

1. `CREATE TABLE tenant_claims …`
2. `ALTER TABLE tenant_claims ADD CONSTRAINT tenant_claims_claim_normalized CHECK (claim = lower(claim) AND claim = btrim(claim) AND claim <> '' AND claim !~ '[^\x20-\x7E]')`
   — Prisma's schema language cannot express this. Without the case fold, the `UNIQUE`
   index is case-sensitive and `Alias.Example` / `alias.example` are two rows resolving
   to two tenants.
   **The ASCII restriction is deliberate and is round-3 M23's remedy.** Revision 3
   claimed the CHECK was "exactly `normalizeTenantClaim`'s postcondition". It is not:
   `btrim(x)` strips ASCII space only while JS `.trim()` strips all Unicode whitespace,
   and `lower()` is LC_CTYPE-dependent while `toLowerCase()` is fixed full-Unicode — so
   under a `C`-ctype database the CHECK would **accept** `Àbc` alongside `àbc` (two rows,
   one claim, I1 false), and a legitimate non-ASCII claim could round-trip differently
   between the two engines. Restricting the *stored* form to printable ASCII makes the
   two agree by construction, at the cost that a non-ASCII claim cannot be registered.
   `storableClaimSchema` (C2) enforces the same restriction at the application boundary
   and rejects earlier with a better message; a non-ASCII claim therefore denies at
   sign-in rather than being stored unresolvably. **This is a real narrowing** and is
   recorded as **SC9** — `slugifyTenant` carries an explicit "Fallback for
   non-ASCII-only inputs (e.g. Japanese org names)" branch, so a deployment using a
   non-ASCII `organization` claim exists in the design space, though not in this one
   (verified: 2 of 264 tenants have an `external_id`, both ASCII).
3. **Backfill**, extracted so it is executable outside the migration —
   `scripts/lib/tenant-claim-backfill.sql`, `@import`ed by the migration and read by the
   test (round-3 **CR11**):
   ```sql
   INSERT INTO tenant_claims (id, tenant_id, claim, created_by)
   SELECT gen_random_uuid(), id, lower(btrim(external_id)), 'backfill'
   FROM tenants
   WHERE external_id IS NOT NULL
     AND btrim(external_id) <> ''
     AND lower(btrim(external_id)) !~ '[^\x20-\x7E]'
   ON CONFLICT (claim) DO NOTHING;
   ```
   `ON CONFLICT DO NOTHING` replaces revision 3's "the UNIQUE index aborts the
   migration": aborting mid-`prisma migrate deploy` on a foreign deployment with no
   remediation guidance is worse than skipping a duplicate, and the pre-flight query in
   C12 surfaces both skipped classes (non-ASCII, and normalisation collisions) for
   operator review **before** the upgrade.
4. `ALTER TABLE tenants DROP CONSTRAINT tenants_external_id_key` (see the schema note).
5. `ENABLE`/`FORCE ROW LEVEL SECURITY` + `CREATE POLICY tenant_claims_tenant_isolation`,
   matching the predicate shape of the existing `tenant_members_tenant_isolation`.
   **No `DROP POLICY IF EXISTS` prefix** — round-3 **F11** found that the
   `operator_tokens` template opens with one, and `check-destructive-migration.mjs`'s
   `DROP` matcher fires on anything outside `{DEFAULT, NOT, IDENTITY, EXPRESSION}` with
   every baseline entry annotated "predates the rule", so a new migration cannot be
   baselined. The table is new in this migration, so the guard is pointless anyway.
5. The guarded `passwd_app` GRANT block used by five existing table migrations
   (`DO $$ BEGIN IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'passwd_app') THEN GRANT … END IF; END $$;`).
   Redundant given the default ACL, and included anyway because it is the convention —
   stated so a reviewer comparing against the `operator_tokens` template does not read
   its absence as an oversight (round-2 **N16**).

`npx prisma generate` is part of this contract: `TxOrPrisma` gains the `tenantClaim`
delegate only after it.

**Control class**: `enforceable boundary` for uniqueness **and for the normalised
form** — the unique index and the CHECK together mean no writer, application or
otherwise, can store a second spelling of the same claim. The *hostname* shape that
operators are expected to register is **not** engine-adjudicated and must not be: it is
an operator-input guard in C7 only (`fail-closed verification gate`, authority
`operatorDomainSchema`), because the storage layer must keep accepting the non-domain
claims existing deployments already use. Round 1 flagged revision 1's control class as
overclaiming; this is the honest split.

**Invariants**:
- **I1 (schema-enforced)** — a claim string resolves to at most one tenant. Authority:
  `UNIQUE(tenant_claims.claim)` + the normalisation CHECK.
- **I2 (schema-enforced)** — a claim row cannot outlive its tenant. Authority: FK
  `ON DELETE CASCADE`.
- **I3 (schema-enforced)** — cross-tenant reads are impossible outside a bypass
  context. Authority: `FORCE ROW LEVEL SECURITY` + the isolation policy.
- **I4 (app-enforced, universally quantified — R42)** — every tenant-scoped table
  appears in all three maintenance-contract locations plus both prose counts.
  ```bash
  grep -cE '@map\("tenant_id"\)' prisma/schema.prisma                 # 55 → 56
  grep -cvE '^\s*(#|$)' scripts/rls-cross-tenant-tables.manifest      # 55 → 56
  grep -n 'Total: 55' scripts/rls-cross-tenant-tables.manifest        # → 56
  grep -n '55 tenant-scoped tables' scripts/rls-cross-tenant-seed.sql # → 56
  ```
  Recomputed independently in rounds 1 and 2: A = 55, B = 55, A\B empty today.

**Forbidden patterns** (each executable as written, per NF3 — round-2 **N6**):
- `pattern: externalIds\s+String\[\]` in `prisma/schema.prisma` — reason: array storage
  cannot express I1 as a schema constraint.
- `pattern: enforce_tenant_id_from_context` in the new migration file — reason: the
  trigger is not universal (28 of 55) and this table does not take it.

**Acceptance criteria** — `src/__tests__/db-integration/tenant-claim.integration.test.ts`,
following `src/__tests__/db-integration/helpers.ts`:
- Second insert of an existing `claim` → Prisma `P2002` through the model API.
- Insert of `Alias.Example` → the CHECK fires. Since a CHECK violation maps to **no**
  Prisma error code, this is asserted via `$executeRawUnsafe` and `P2010` with
  `meta.code === "23514"`, the shape
  `src/__tests__/db-integration/audit-outbox-concurrent-delivery.integration.test.ts:36-49`
  already uses (round-2 **T13**).
- A non-domain claim (`acmecorp`) inserts successfully — the storage layer must keep
  accepting what existing deployments already use (NF2).
- `DELETE FROM tenants WHERE id = …` → dependent `tenant_claims` rows gone (I2).
- As `passwd_app` with `app.tenant_id` set to tenant A, tenant B's rows are invisible
  (I3 — additionally covered in CI by the existing `rls-smoke` job once the manifest
  line and seed rows land).
- **Backfill** — asserted by **executing** `scripts/lib/tenant-claim-backfill.sql`, not
  by observing history. Round-3 **CR11** showed the revision-3 form could not fail: CI
  creates a fresh `postgres:16` service DB and runs `prisma migrate deploy` before any
  test, so `tenants` is empty when the migration's copy runs, and
  `src/__tests__/db-integration/helpers.ts:113-127` `createTenant()` never writes
  `external_id` — deleting the statement from the migration left the assertion green.
  The test therefore seeds four tenants via `ctx.su` with `external_id` values covering
  `Alias.Example`, `" alias.example "`, `acmecorp`, and `NULL`, deletes any claim rows,
  runs the extracted statement, and asserts the resulting set. Two further cases: two
  tenants whose values normalise identically → exactly one row, no error
  (`ON CONFLICT DO NOTHING`); a non-ASCII `external_id` → **no** row, which is the
  SC9 narrowing made visible. A cheap drift assertion confirms the migration file
  `@import`s that same statement, so the two cannot diverge.
- **Normalisation equivalence** (round-3 **M23**): C2's adversarial input table is fed
  through the real `normalizeTenantClaim` in JS and then `INSERT`ed; every value either
  passes the CHECK and round-trips byte-identically, or is rejected by
  `storableClaimSchema` before the insert is attempted. This is the assertion that pins
  the two engines against each other; C2's unit test asserts only the JS side and cannot.
- `npx prisma generate` then `npx next build` succeeds.
- `check-migration-drift.mjs`, `check-destructive-migration.mjs`,
  `check-migration-transaction.mjs` pass; `node scripts/audit-db-grants.mjs` reports no
  drift after the manifest is regenerated.

Round 1 verified the grant delta: `DEFAULTACL:passwd_user public r
passwd_app=arwd/passwd_user` (`db-grants-manifest.json:26`) auto-grants
SELECT/INSERT/UPDATE/DELETE, so the manifest delta is exactly four
`TABLE:passwd_app public.tenant_claims` lines — no sequence (uuid PK), no worker
grants, and the `tenants` FK needs only SELECT, which `passwd_app` already holds.

---

### C2 — `normalizeTenantClaim` and the two schemas

**New module** `src/lib/tenant/tenant-claim-registry.ts` — deliberately **not**
`tenant-claim.ts`, which is factory-mocked in two suites
(`src/lib/tenant/tenant-management.test.ts:20-22`, `src/auth.test.ts:147-151`); a new
export there is a silent-undefined trap (round-1 Testing F3).

```ts
export function normalizeTenantClaim(input: string): string   // trim → toLowerCase
export const storableClaimSchema: z.ZodString    // storage floor  — any claim shape
export const operatorDomainSchema: z.ZodString   // operator input — hostname shape
```

Two schemas, because the two boundaries genuinely differ:

- **`storableClaimSchema`** is what C3 and C4 use. It accepts any value that survives
  `sanitizeTenantClaimValue`, is non-empty after normalisation, and is ≤
  `MAX_TENANT_CLAIM_LENGTH`. It deliberately does **not** require a hostname shape —
  `parseTenantClaimKeys()` defaults include `organization` and `company`, so a
  deployment configured that way legitimately produces `acmecorp`, and rejecting it
  would be an NF2 regression.
- **`operatorDomainSchema`** is what C7 uses on `--domain`. Operators register domains,
  and a typo caught at the CLI is cheaper than a row that resolves nothing. LDH labels,
  at least one dot, no scheme, no path, no leading or trailing dot. It is an input
  guard, not a storage invariant — stated so nobody later "tightens" the storage layer
  to match it.

`normalizeTenantClaim` is trim + lowercase, nothing more. It is the sole producer of
the stored form, and the C1 CHECK constraint is exactly its postcondition, so the
storage engine rejects anything that did not go through it (or through an equivalent).

Punycode/IDN canonicalisation is deliberately **not** here. A U-label and its A-label
would be two rows, which is a real if minor hazard (round-1 Security F14, Minor) — but
canonicalising requires deciding whether a value is a hostname at all, which is the
same conflation this contract exists to avoid. Folded into **SC7**.

**Control class**: `detection or audit only` — both schemas and the normaliser are pure
functions. The enforcement that matters is C1's CHECK constraint, which is engine-level.

**Forbidden patterns**:
- `pattern: \.toLowerCase\(\)` **in `src/lib/tenant/tenant-management.ts` only** —
  reason: normalisation has a single producer; a second spelling in the resolver is how
  the stored form and the looked-up form drift apart. Round 2 (**N6**) showed the
  revision-2 form named an unbounded file set and fired on legitimate code elsewhere.

**Acceptance criteria** — `src/lib/tenant/tenant-claim-registry.test.ts`, no module
mocking, exercising the **real** functions (RT5):
- Leading/trailing whitespace stripped; mixed case folded; already-normalised input
  unchanged; at least one input is changed, so the test fails if the function becomes
  identity.
- `normalizeTenantClaim` output always satisfies the C1 CHECK predicate
  (`v === v.toLowerCase().trim()`), asserted over a table of adversarial inputs
  including full-width and non-ASCII characters.
- `storableClaimSchema` accepts `acmecorp`, `alias.example` and a 255-character value;
  rejects `""`, whitespace-only, and 256 characters.
- `operatorDomainSchema` accepts `alias.example`; rejects `acmecorp` (no dot),
  `" alias.example"`, `alias.example/path`, `https://alias.example`, `alias..example`,
  `alias.example.`.

---

### C3 — `resolveTenantByClaim`

```ts
// src/lib/tenant/tenant-management.ts
export async function resolveTenantByClaim(
  tenantClaim: string,
  db: TxOrPrisma = prisma,
): Promise<{ id: string } | null>
```

Normalises the claim with `normalizeTenantClaim`, then
`db.tenantClaim.findUnique({ where: { claim }, select: { tenantId: true, revokedAt: true } })`
— `Prisma.TenantClaimWhereUniqueInput`, `claim` being `@unique` (round-2 **N11**).
Returns `{ id: row.tenantId }` when the row exists **and `revokedAt` is null**, else
`null`. Never writes. Returns `null` rather than throwing when the claim fails
`storableClaimSchema`, since an IdP may send anything.

The `revokedAt` filter is in the resolver, not the `where`, so a revoked row still
occupies its `claim` in the unique index — re-registering a revoked claim for a
*different* tenant is a deliberate operator act (`add` reports the conflict and the
prior owner), not a silent race.

Caller must already be inside a `withBypassRls` context, same contract as the function
it replaces.

**Control class**: `enforceable boundary`. Round 1 correctly rejected revision 1's
`detection or audit only`: this function's result is the sole input to the allow/deny
dispatch, and on the `createUser` path (via C4) it decides which tenant a new user and
their vault are created in. Adjudication authority is the `tenant_claims.claim` unique
index.

**Invariants**:
- **I5 (app-enforced)** — `resolveTenantByClaim` performs no writes. No viable
  schema-enforced equivalent short of a read-only role and a second pool; pinned by an
  acceptance criterion asserting no write mock was called.

**Acceptance criteria** — a **new file** `src/lib/tenant/resolve-tenant-by-claim.test.ts`
(not `tenant-management.test.ts`, whose factory mock of `@/lib/tenant/tenant-claim`
would shadow the real normaliser this suite needs — RT5):
- A registered claim → its tenant.
- An unknown claim → `null`, with zero writes asserted.
- `Alias.Example` resolves the row stored as `alias.example` — exercising the real
  normaliser, not a stub.
- A non-domain claim (`acmecorp`) that is registered → resolves. This is the NF2 case:
  deployments using `organization`/`company` claim keys must keep working.
- A claim that fails `storableClaimSchema` (empty, whitespace-only, over-length) →
  `null`, no throw.

---

### C4 — `findOrCreateTenantForClaim`

Replaces `findOrCreateSsoTenant`. Same call sites
(`src/auth.ts` row 8, `src/lib/auth/session/auth-adapter.ts:174`), same
`{ id } | null` return, new body:

```ts
export async function findOrCreateTenantForClaim(
  tenantClaim: string,
  db: TxOrPrisma = prisma,
): Promise<{ id: string } | null>
```

1. **`await advisoryXactLock(db, \`tenant-claim:${normalizeTenantClaim(tenantClaim)}\`)`.**
2. `resolveTenantByClaim(tenantClaim, db)` → return it if found.
3. Validate with `storableClaimSchema`; return `null` if it fails (replacing the old
   empty-slug guard, and covering the same denial outcome).
4. Create the tenant **and** its `tenant_claims` row in one statement:
   ```ts
   db.tenant.create({
     data: { name, slug, claims: { create: { claim } } },   // Prisma.TenantCreateInput
     select: { id: true },                                   // + TenantClaimCreateNestedManyWithoutTenantInput
   })
   ```
   The nested form is the only one that is atomic on **any** `TxOrPrisma`: a `tx` has no
   `$transaction` method, so C4 cannot open one, and two separate `create` calls on a
   bare `prisma` would leave the shadow state this contract exists to prevent
   (round-3 **M24**). A failure of the nested insert must **not** be caught locally.
5. Slug collision (`P2002` on `tenants_slug_key`) retries once with a random suffix,
   as today. That retry runs **after** a failed statement, so it is subject to step 1's
   serialisation caveat below.

**Why step 1 exists, and why the previous revision's `P2002` recovery does not.**
Round 3 (Functionality **CR8**, Security **S3-2**, converged Critical) established what
round 2 first raised as **S13** and revision 3 wrongly dismissed: `withBypassRls` is
`prisma.$transaction(async (tx) => …)` (`src/lib/tenant-rls.ts:64-71`), and Prisma
interactive transactions issue one `BEGIN` on one connection with **no per-statement
savepoints**. A constraint violation therefore leaves the session in `ERROR` and every
follow-up statement returns `25P02`. The repo says so in its own code —
`src/__tests__/db-integration/audit-anchor-epoch-migration.integration.test.ts:215`:
*"We run this in a SAVEPOINT so we can recover without aborting the outer tx."* All
twelve other `P2002` catches in `src/` sit outside a transaction and return 409 without
re-querying; `src/lib/tenant/tenant-management.ts:36-61` is the sole exception, and it
is the code revisions 1–3 carried forward and then promoted to *adjudication authority*.

`advisoryXactLock` (`src/lib/tenant-rls.ts:88-93`) is the repo's own answer to this
read→check→write shape, already used at `src/app/api/vault/rotate-key/route.ts:187`,
`src/app/api/api-keys/route.ts:117`, `src/app/api/extension/bridge-code/route.ts:279`
and two other sites, and enforced for count-then-create by
`scripts/checks/check-count-then-create-lock.mjs` (`LOCK_RE` matches
`advisoryXactLock\s*\(`). It **removes** the concurrent-creation race rather than
recovering from it: two sign-ins presenting the same claim serialise, the second sees
the first's committed row at step 2, and no `P2002` on `tenant_claims_claim_key` is
reachable at all.

The residual `P2002` on `tenants_slug_key` (step 5) is a genuinely different claim
colliding after slugification — `slugifyTenant` collapses `[^a-z0-9]+`, so
`alias.example` and `alias-example` both give `alias-example`. The advisory lock is
keyed on the claim, so it does not serialise those. **The suffix retry must therefore
run in a `SAVEPOINT`**, following the epoch-migration test's shape, or the whole create
must move outside the caller's transaction. C4 specifies the `SAVEPOINT`: it is local,
it matches an existing in-repo precedent, and it keeps the atomicity of step 4.

`Tenant.externalId` is **no longer written**. See C1's schema change and round-3
**M22**: keeping a second globally-unique key over the same concept, populated by a
different rule (raw vs normalised), is the exact shape the unification exists to remove,
and `remove` or a rolled-back deploy desynchronises the two into a permanent lockout.

Step 4's atomicity is why round-2 **S1** cannot happen: there is no state in which a
tenant exists for a claim the registry does not know about.

**Control class**: `enforceable boundary`. Two authorities, named separately because
they are different: `pg_advisory_xact_lock` serialises concurrent creation for the same
claim, and `UNIQUE(tenant_claims.claim)` is the backstop that holds even if a future
caller forgets the lock. Revision 3 claimed the index alone adjudicated a *recovery* it
could not perform; this states only what each mechanism delivers.

**Invariants**:
- **I6 (schema-enforced)** — a tenant cannot be created for a claim that already
  resolves to a different tenant. Authority: `UNIQUE(tenant_claims.claim)`. The advisory
  lock makes the violation unreachable in the concurrent case; the index makes it
  impossible in every case.

**Acceptance criteria.** Split by adjudicator, because round 3 (**T24**) showed the
atomicity proof was sitting on a passthrough `$transaction` mock that models no
rollback.

*Real Postgres* — `src/__tests__/db-integration/tenant-claim.integration.test.ts`:
- Two concurrent `findOrCreateTenantForClaim` calls for the same claim on distinct
  clients via `raceTwoClients` (`src/__tests__/db-integration/helpers.ts:364`, which
  exists for exactly this): **exactly one** tenant and one claim row, and both callers
  receive the same id. This is the advisory lock's proof.
- A forced failure between the tenant insert and the claim insert leaves **neither** row
  — the nested-write atomicity.
- A slug collision between two different claims produces two tenants with distinct
  slugs and no error, exercising the `SAVEPOINT` retry.

*Mocked* — `src/lib/tenant/tenant-management.test.ts`, whose `findOrCreateSsoTenant`
describe block is **renamed and updated**. The mock surface gains a `tenantClaim`
delegate. Round-3 **M27** found the revision-3 list incomplete; all seven cases,
enumerated from the file:

| Line | Case | Fate |
|---|---|---|
| `:32` | returns existing tenant by externalId | renamed; asserts `tenantClaim.findUnique` |
| `:45` | creates **new** tenant when not found | the exact `toHaveBeenCalledWith` at `:52-59` is **restated** against the nested `claims: { create: { claim } }` shape and the removal of `externalId` |
| `:62` | retries findUnique after P2002 on externalId | retargeted to `tenantClaim.findUnique`; **expected count restated as 1** — the advisory lock removes the re-resolve, so the P2002-retry assertion is deleted, not adjusted |
| `:80` | retries with fallback slug on slug collision | kept; `secondCreate.data.externalId` assertion **removed** with the column |
| `:101` | returns null when slugifyTenant returns "" | becomes the `storableClaimSchema` reject, **keeping its two existing no-write assertions** (`findUnique` and `create` not called) — round-3 **T25** noted revision 3 dropped them |
| `:111` | returns null on double P2002 | **deleted** — the path is unreachable once the lock removes the claim-key race and the slug retry runs in a `SAVEPOINT`. Deleting a test because its path is gone is stated here so it is not read as coverage loss |
| `:128` | throws non-P2002 errors | kept; delegate stub only |

- New: a non-domain claim (`acmecorp`) creates a tenant successfully (NF2).
- New: `advisoryXactLock` is called before the resolve, with the **normalised** claim in
  the key — otherwise two spellings of one claim take different locks.
- New: creating a tenant for a claim already registered to another tenant → `P2002` →
  re-resolves to that other tenant, and **no** second tenant row is created.

`src/lib/auth/session/auth-adapter.test.ts` needs its mock renamed
(`findOrCreateSsoTenant` → `findOrCreateTenantForClaim`) and nothing else — round 1
verified it mocks the module with only that one symbol, which is all the adapter calls.

---

### C5 — `ensureTenantMembershipForSignIn`: discriminated result + dispatch

```ts
export type SignInTenantResult =
  | { ok: true }
  | { ok: false;
      reason: Extract<AuthLoginFailureReason,
        "tenant_mismatch" | "tenant_claim_unmapped">;
      tenantId: string | null;
      claim: string | null };
```

Round 1 (converged Critical) showed `Promise<boolean>` could not carry which reason to
emit, and that emitting inside the function would run `logAuditAsync` →
`resolveTenantId` → `withBypassRls` **nested inside** the open `prisma.$transaction`,
an R9 pool-exhaustion shape. The result is returned **out of** the `withBypassRls`
block — `withBypassRls<T>` is generic over the callback's return
(`src/lib/tenant-rls.ts:54`), verified feasible in round 2 — and `emitAuthLoginFailure`
stays at `src/auth.ts:362-369`, post-transaction.

**Control flow, stated explicitly** (round-3 **F8**). Both lookups run **inside the
single `withBypassRls` callback**, in this order:

```ts
return withBypassRls(prisma, async (tx) => {
  const claimTenant = tenantClaim ? await resolveTenantByClaim(tenantClaim, tx) : null;
  const existingTenantId = await resolveUserTenantIdFromClient(prisma, userId);
  …dispatch…
}, BYPASS_PURPOSE.AUTH_FLOW);
```

`resolveUserTenantIdFromClient` is called with the **global proxy**, not `tx`
(`src/auth.ts:75`), and works only because `src/lib/prisma.ts:151-180` consults
`getTenantRlsContext()` and returns the delegate bound to the active transaction. An
implementer who reads "resolve the existing tenant first" as *hoist it above
`withBypassRls`* would run it as `passwd_app` under `FORCE ROW LEVEL SECURITY` with no
`app.tenant_id` set: `tenantMember.findMany` returns zero rows and **every deny row
silently becomes an allow row** — a cross-tenant fail-open that I7's walk-back cannot
catch, because the walk-back tests for the absence of `findOrCreateTenantForClaim`,
which still holds. Stating the ordering is the whole guard.

**Dispatch** (twelve rows):

| # | claim | `resolveTenantByClaim` | user's existing tenant | Outcome |
|---|---|---|---|---|
| 1 | absent | — | none | allow (unchanged) |
| 2 | absent | — | resolves | allow (unchanged) |
| 3 | absent | — | `MULTI_TENANT…` throws | deny, `tenant_mismatch`, **no write** (unchanged) |
| 4 | present | resolved | none | upsert membership → allow |
| 5 | present | resolved | equal | upsert membership → allow |
| 6 | present | resolved | different, existing **is** bootstrap | bootstrap migration → allow |
| 6b | present | resolved | different, bootstrap, **>1 active member** | `assertBootstrapSingleMember` throws → `provider_error`, **no write** (unchanged) |
| 7 | present | resolved | different, existing **not** bootstrap | deny, `tenant_mismatch`, **no write** |
| 8 | present | `null` | none | `findOrCreateTenantForClaim` → upsert membership → allow |
| 8b | present | `null` | none, and create returns `null` | deny, `tenant_mismatch`, **no write** |
| 9a | present | `null` | different, existing **is** bootstrap | `findOrCreateTenantForClaim` → bootstrap migration → **allow** |
| 9b | present | `null` | different, existing **not** bootstrap | deny, `tenant_claim_unmapped`, **no write** |
| 10 | present | either | `MULTI_TENANT…` throws | propagates to the catch at `src/auth.ts:371-386` → `provider_error`, **no write** |

Row 9b is the reported failure. It is a distinct reason because the operator action
differs: `tenant_mismatch` means "this user belongs somewhere else";
`tenant_claim_unmapped` means "your IdP started sending a claim this deployment has not
registered".

**Row 9a is round-3 CR10's remedy and is load-bearing.** Revision 3 had a single row 9
that denied before reaching the bootstrap check. Today `findOrCreateSsoTenant`
*creates*, so `found` is always non-null and a magic-link user's first Google sign-in
migrates (`src/auth.ts:78-213`). Under a single row 9 that user would be denied
`tenant_claim_unmapped` — the primary bootstrap→SSO onboarding path regressing to a hard
denial, an NF2 violation of the same shape as the bug being fixed. Row 9a restores it:
creating a tenant on an **allow** path does not conflict with D2, which is about writes
on *denied* paths. `src/auth.test.ts:271-336` does **not** already cover this — its
`beforeEach` makes the claim resolve, so it models row 6; the create-then-migrate
combination is untested today and gets its own case.

Row 10 proves D2 is closed: today the throw happens *after* `findOrCreateSsoTenant`
created a tenant at `src/auth.ts:71`, so its test is the regression pin for the reorder.

Row 8b exists because `findOrCreateTenantForClaim` returns `{ id } | null` and round 2
(**T12**) and round 3 (**M28**) both found the null outcome uncelled. Note that its
trigger — C4 step 3's `storableClaimSchema` reject — is **unreachable from sign-in**:
`sanitizeTenantClaimValue` already trims, rejects empty, and bounds at
`MAX_TENANT_CLAIM_LENGTH`, the same bound the schema applies. It is reachable only via
the ASCII restriction (SC9) and defensively. Stated so the test is written as a
defensive-path test rather than as a claimed user scenario.

Row 6b is `assertBootstrapSingleMember`'s throw (`src/auth.ts:36-44`) — a real, denial
producing exit today, enumerated so I7 can cover it.

**Control class**: `fail-closed verification gate`. Every row decides; there is no
fall-through. An unresolved claim, an errored lookup, and an absent tenant all deny.

**Invariants**:
- **I7 (app-enforced, universally quantified — R42)** — no code path reachable from a
  denied sign-in performs a write other than the audit record.
  **Defining primitive**: every falsy or deny-producing **exit** of `signIn` *and of
  every function it awaits* — returns **and throws**. Rounds 2 (**S9**) and 3 (**M29**)
  each found a member the plan could name but its own command could not produce; the
  alternation now covers throws:
  ```bash
  grep -nE 'return false|return null|return found|return !!tenant|return ok|throw new Error' \
    src/auth.ts src/auth.config.ts \
    src/lib/tenant/tenant-management.ts src/lib/tenant-context.ts
  ```
  **Enumerated members**: `src/auth.ts:41` (`assertBootstrapSingleMember` throw — row
  6b), `:61`, `:73`, `:211`, `:233`, `:277`, `:302`, `:323`, `:370`, `:385`;
  `src/auth.config.ts:211`; `src/lib/tenant/tenant-management.ts` (the
  `storableClaimSchema` reject in C4, and `return found` at the tail);
  `src/lib/tenant-context.ts:15` (`return null`) and `:17` (throw — the sole cause of
  rows 3 and 10). Rounds 1–3 each recomputed the return-set and confirmed it exact; the
  throws are what the earlier alternations could not see.
  **A grep is the floor, not the ceiling.** Per the repo's AST-first rule for
  classification, if the enumeration drifts again the guard becomes a ts-morph pass over
  every `return` whose static type admits `null | false` plus every `throw`
  (`scripts/checks/lib/ast-project.mjs` runs without a Program). Recorded so the third
  recurrence is the trigger, not a fourth finding.
  **Negative result recorded deliberately**:
  `src/app/api/auth/passkey/verify/route.ts:93-106` has its own bootstrap-only guard and
  never calls the tenant resolver — it is in the class and clean.
  **Post-fix expectation per member**: `src/auth.ts:211`'s walk-back must contain
  `resolveTenantByClaim` and **no** `findOrCreateTenantForClaim`.

**Forbidden patterns** — revision 2 had two here that were scope predicates rather than
regexes (round-2 **N6**). Both are demoted to acceptance criteria below, which is what
they always were.

**Acceptance criteria**:
- All ten rows have a test.
- Rows 7, 9 and 10 each assert **both** `tenant.create`/`tenantClaim.create` **and**
  `tenantMember.upsert` were not called. I7's scope is "no write other than the audit
  record", and `src/auth.ts:215` is the other reachable write (round-1 **F10**).
- Row 10 additionally asserts the reorder: `findOrCreateTenantForClaim` was not called.
- **The emit is asserted at the `signIn` callback level, not at the dispatch level**
  (round-2 **T11**). Rows 1–10 test `ensureTenantMembershipForSignIn`, which only
  *returns* the reason; a forgotten hard-coded `reason: "tenant_mismatch"` at
  `src/auth.ts:366` would leave every row test green and the audit trail wrong. So:
  drive the `signIn` callback into row 9 and assert the emitted payload equals
  `{ email, provider, reason: "tenant_claim_unmapped", tenantId: <existing>, userId, claim }`;
  drive it into row 7 and assert `reason: "tenant_mismatch"`. This needs a
  `vi.mock("@/lib/audit/auth-failure")` that `src/auth.test.ts` does not have today —
  listed in the mock delta below.
- Regression: with a second claim registered, row 5 reached through it allows sign-in.

**`src/auth.test.ts` delta (R42 — member set re-derived against revision 3's change,
not inherited).** The breaking cause is the return type, so the primitive is *every
call site that reads the return value*:
- `expect(ok).toBe(...)` → `expect(result.ok).toBe(...)` at `:231, 258, 267, 276, 343,
  386, 408, 422, 443, 456` — **ten** sites. Revision 2 listed five, inherited from
  round 1 where the cause was different.
- `mockPrisma` (`:14-92`) gains a `tenantClaim` delegate.
- `vi.mock("@/lib/audit/auth-failure")` added for the emit assertions.
- **`:451-459` — corrected.** Revision 2 claimed its verdict "must stay `false`". Round 2
  showed, and I re-traced against the file, that it does not: the test sets only
  `mockSlugifyTenant.mockReturnValue("")`, while the `beforeEach` at `:194-198` leaves
  `tenant.findUnique({where:{externalId:"tenant-acme"}})` returning a row. Under
  revision 3 the resolver reads `tenantClaim`, so the test must be **rewritten**: stub
  `tenantClaim.findUnique` → `null` and make the claim fail `storableClaimSchema`, which
  reaches row 8's reject path. Add a separate row-4 test for the behaviour the old
  assertions would otherwise silently become.
- **`:372-396` — vacuity risk.** It asserts `findUnique` `toHaveBeenCalledTimes(2)` with
  `mockResolvedValueOnce(null).mockResolvedValueOnce({id})`. Under revision 3 the
  resolver reads a different delegate, so the queued values no longer line up; the case
  must be retargeted to `tenantClaim.findUnique` with the P2002 retry still exercised,
  and the expected count restated. Round 2 showed that left alone it goes green while
  testing nothing.

---

### C6 — Audit payload: record the claim, make the hash binding self-describing

```ts
export type AuthLoginFailureReason =
  | "unknown_email" | "tenant_mismatch" | "provider_error"
  | "magic_link_expired" | "credential_mismatch"
  | "tenant_claim_unmapped";                        // new

export async function emitAuthLoginFailure(args: {
  email: string | null;
  tenantId?: string | null;
  provider: AuthProvider;
  reason: AuthLoginFailureReason;
  userId?: string | null;
  claim?: string | null;                            // new
}): Promise<void>
// metadata: { provider, reason, identifierHash, identifierHashScope, claim? }
```

**Recording the claim.** Revision 1 refused to; round 1 showed that makes requirement F6
unachievable, because the operator learns *that* a tenant had unmapped-claim denials but
never *which* claim to register. The rationale also misapplied the logging rule, which
targets secrets, credentials, session identifiers and personal data. A hosted-domain
claim is organisational metadata, already length-capped at `MAX_TENANT_CLAIM_LENGTH` and
control-character stripped. Stored truncated to that cap.

**Sanitizer rider (RS6).** `sanitizeTenantClaimValue`
(`src/lib/tenant/tenant-claim.ts:46-54`) strips C0/C1/DEL but passes Unicode bidi and
zero-width characters (U+200B, U+202E). Since this value is now rendered to an operator,
the strip set is extended **there** — the shared ingest boundary, upstream of the audit
metadata, of `Tenant.name`, and of the CLI's terminal output. Round 2 confirmed this is
the right placement and that a second strip set inside `auth-failure.ts` would be RT9
twin drift.

Round 3 (**M23**) found that in revision 3 this rider *also* changed the resolution key
for stored claims — a claim containing U+200B resolved before the PR and not after,
a self-inflicted lockout produced by a change described as display hardening. C1's ASCII
CHECK (SC9) removes that coupling: a stored claim cannot contain a bidi or zero-width
character at all, so the strip set now governs only what is **rendered**, never what is
**matched**. The two concerns are independent, which is why the rider can ship here.

**`identifierHashScope`.** Round 1 established that revision 1's forensic analysis was
factually wrong: there are already **two** `tenant_mismatch` call sites that disagree —
`src/auth.ts:316-322` passes `tenantId`, `:363-368` does not — so one email hitting both
already yields two unlinkable hashes under one reason. The binding therefore becomes a
property of the record: `identifierHashScope: "tenant" | "global" | "unkeyed"`, and the
two existing sites are normalised to one rule (bind whenever the tenant is known). The
`"unkeyed"` member is what C8 emits when no key material exists.

**Control class**: `detection or audit only`.

**Acceptance criteria** — `src/lib/audit/auth-failure.test.ts`, a **new file**
(`hashIdentifier` and `emitAuthLoginFailure` have no test today; round-2 **N13**):
- A denial with a known tenant emits `identifierHashScope: "tenant"`; one without emits
  `"global"`.
- The claim appears in metadata, truncated at the cap, with bidi/zero-width characters
  stripped — asserted with a fixture containing U+202E, in
  `src/lib/tenant/tenant-claim.test.ts` where `sanitizeTenantClaimValue` is actually
  reachable (it is not exported; `extractTenantClaimValue` is its only adjudicator).
- Neither new metadata key collides with a name in `METADATA_BLOCKLIST`, and a fixture
  containing a blocklisted key is still redacted — asserted in
  `src/__tests__/audit-logger.test.ts`, the constant's real test home. Round 2 (**S11**,
  **N13**) showed revision 2's "`METADATA_BLOCKLIST` accepts the new fields" describes a
  redaction denylist as an accept list, so it could only be satisfied by a no-op.
- **`claim` is added to `EXTERNAL_DELIVERY_METADATA_BLOCKLIST`**
  (`src/lib/http/external-http.ts:324-336`), asserted in
  `src/lib/webhook-dispatcher.test.ts` alongside the existing blocklist test. Round 3
  (**S3-9**) found that the *egress* boundary is a different constant from the internal
  one, that `AuditDeliveryTarget` has **no action filter** so every `AUTH_LOGIN_FAILURE`
  is forwarded, and that the list already strips the sibling `reason` field. Shipping
  the organisation's IdP claim to a tenant-configured HTTP endpoint while withholding
  the far less sensitive denial reason would be an asymmetry decided by omission.
  `identifierHashScope` is **not** added — it carries no organisational data and its
  absence would make forwarded hashes uninterpretable.
- **Two test files must be converted to `vi.stubEnv` in the same delta** (round-3
  **T22**). `check-test-hygiene.sh` gate (c) forbids `^\s*process\.env\.[A-Z_]+ *=` in
  any `.test.ts` changed vs main, allowlisting only `src/__tests__/setup.ts` and
  `src/__tests__/env.test.ts`. `src/lib/tenant/tenant-claim.test.ts` has **nine** such
  lines (`:15, 25, 30, 56, 66, 75, 88, 96, 105`) and `src/__tests__/audit-logger.test.ts`
  one (`:29`); both are invisible today only because neither file has changed. C6
  modifies both, so `pre-pr.sh:289` reds on ten pre-existing violations at push time.
  The conversion is safe for `tenant-claim.test.ts` because it reads env at call time
  (`parseTenantClaimKeys`), not at module load, and `setup.ts:20-25` already wires
  `vi.unstubAllEnvs()` in `afterEach`, so the save/restore block at `:5-18` collapses.
- The hash-population change is recorded in `docs/security/audit-log-schema.md` — a
  **new** file. Revision 3 justified naming it with "`check-doc-paths.mjs` fails an
  invented path"; round 3 (**M31**) showed that gate validates only `src/…` and
  `scripts/…` references *inside* docs and **skips `docs/security/**` entirely**. The
  real reason is round-2 **N13**: revision 2 referred to "the audit-schema note" without
  naming a file. The genuine obligation is the other direction — C12's runbooks will
  have their `scripts/tenant-domain.ts` references validated by that gate's Pass B, so
  the script must exist at exactly that path.

---

### C7 — Offline operator CLI

`scripts/tenant-domain.ts`, `#!/usr/bin/env tsx`, with an npm script
`"tenant-domain": "tsx scripts/tenant-domain.ts"`.

Round 2 (**CR5**, three-way convergence) established that a `.mjs` file cannot do this:
`scripts/checks/check-mjs-imports.mjs:124` states the rule in code — `EXTENSIONS = ["",
".mjs", ".js", ".json"]` with the comment *".ts/.tsx are intentionally excluded"* —
plain `node` resolves neither the `@/` alias nor `.ts`, and **zero** `scripts/*.mjs`
files import from `src/`. The cited precedents (`bootstrap-rds-roles.mjs`,
`audit-db-grants.mjs`) are `.mjs` precisely because they import only `pg`. `scripts/migrate-account-tokens-to-encrypted.ts` is the analogue for **client
construction only** — `#!/usr/bin/env tsx`, `loadEnv()`, `MIGRATION_DATABASE_URL`, and
its own `new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })` because
the `src/lib/prisma.ts` singleton reads `DATABASE_URL`.

**Module shape** follows `scripts/bootstrap-rds-roles.mjs` instead, which is the
importable one (round-3 **M26**): that file ends with
`if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()`,
while `migrate-account-tokens-to-encrypted.ts` ends with a bare
`main().catch(… process.exit(1))` — **importing it runs the CLI**. Concretely:
- Named exports `cmdList`, `cmdUnmapped`, `cmdAdd`, `cmdRemove`, each **returning** a
  `{ ok: boolean; code: number; … }` result. Every acceptance criterion below is phrased
  as an exit code; an imported function cannot express that without killing the vitest
  worker, so the thin CLI wrapper is what translates the result to `process.exitCode`.
- A `main` guard as above; no module-scope client construction and no module-scope
  `loadEnv()` side effect beyond the env read.
- `MIGRATION_DATABASE_URL` is read **per call**, not memoised — otherwise the
  "missing env var" case is order-dependent against the twelve cases that need it set.
- Confirmation is an injectable seam (a `confirm` callback defaulting to the TTY prompt)
  so tests neither hang on stdin nor have to pass `--yes` everywhere.

**RLS context is mandatory** (round-3 **S3-3**). C1 puts `FORCE ROW LEVEL SECURITY` on
`tenant_claims`; `audit_logs` and `audit_outbox` already carry it
(`prisma/migrations/20260228020000_force_rls_and_scim_trigger_phase9/migration.sql:50`).
`FORCE` binds the table **owner** too — only `SUPERUSER` or `BYPASSRLS` escapes. Docker
dev hides this because `passwd_user` is a real `SUPERUSER`; on RDS the master user holds
`rds_superuser` but neither `rolsuper` nor `rolbypassrls`. Without the GUCs, at incident
time, `list`/`unmapped` print nothing and `deleteMany` returns `count: 0` which maps to
"unknown domain" — **silent wrong answers, not errors.** Every command therefore opens a
transaction and sets `app.bypass_rls = 'on'` and `app.tenant_id = NIL_UUID` first,
mirroring `src/lib/tenant-rls.ts:65-68` and the workers' `setBypassRlsGucs`.

Round 2 surfaced this requirement through `enqueueAuditInTx`'s GUC hard-fail; SC8
dropped the audit row and the requirement went with it. The requirement was never about
the audit row — it is about the table.

```bash
MIGRATION_DATABASE_URL=<url> npm run tenant-domain -- list [--tenant <uuid|domain>]
MIGRATION_DATABASE_URL=<url> npm run tenant-domain -- unmapped
MIGRATION_DATABASE_URL=<url> npm run tenant-domain -- add    --tenant <uuid|domain> --domain <domain> [--yes]
MIGRATION_DATABASE_URL=<url> npm run tenant-domain -- remove --tenant <uuid|domain> --domain <domain> [--yes]
```

`unmapped` is C5's Consumer 3: it reports recent `tenant_claim_unmapped` denials as
`(tenant, claim, count, lastSeen)` so the operator learns exactly what to register. It
reads `audit_logs` **union** pending `audit_outbox` payloads — round-2 **N14** noted
that `audit_logs` is written only by the outbox worker, and a stopped worker is a
supported state, so querying only `audit_logs` returns a false-empty at incident time.
It also prints the retention window and says "no rows in the retained window" rather
than an empty list (**S12**).

`add` and `remove` **both require `--tenant`**, and refuse when the named tenant does
not own the named domain. Round 2 (**S4**) showed revision 2's "`domain` is unique so
there is no parent-scoping hazard" inverts the risk: uniqueness removes the correctness
hazard and leaves the authorization hazard, so `remove --domain <typo>` would reach into
any tenant and deny every one of its members at their next sign-in.

`add` also requires `--by <label>`, stored in `TenantClaim.createdBy` as a
**self-asserted** operator label, and `remove` **soft-deletes** (`revokedAt = now()`)
rather than `DELETE`ing, so a claim's lifetime survives the incident response that
discovers it (round-3 **S3-4**).

`remove` normalises with `normalizeTenantClaim` and validates with
**`storableClaimSchema`**, not `operatorDomainSchema` (round-3 **S3-13**). The asymmetry
is deliberate: the operator-input guard belongs on the write that creates a row;
applying it to `remove` would make a legitimately stored non-domain claim — `acmecorp`,
or a backfilled value — unremovable.

Before mutating, both print the resolved tenant (id, name, slug, active member count)
and the exact row, then require confirmation — `--yes` for non-interactive runs.
**The prompt names the row-6/9a consequence** (round-3 **S3-7**): registering a claim
does not only decide which *new* users land in the tenant — it also makes an existing
bootstrap user's first sign-in with that claim reassign their **entire personal
estate** (`passwordEntry`, `vaultKey`, `attachment`, `emergencyAccessGrant`,
`passwordShare`, `apiKey`, `webAuthnCredential`, `session`, and `audit_logs` via
`CALL audit_log_tenant_migrate`) into it. A tenant name and a member count do not convey
that, so the prompt says it in words.

`add` normalises with `normalizeTenantClaim` and validates with **`operatorDomainSchema`**
— the stricter of C2's two schemas. Operators register domains, so a typo is worth
catching here even though the storage layer accepts non-domain claims; the asymmetry is
deliberate and is stated in C2 so nobody later "tightens" the storage floor to match.
`add` is idempotent: re-adding a claim already owned by the named tenant reports success
and leaves exactly one row (VE2, since C13 runs against a shared dev database). A claim
owned by a different tenant is refused with a non-zero exit and the row untouched.

`list` prints the stored claim verbatim. Round-1 Security F14 asked for A-label/U-label
rendering; without punycode canonicalisation (see C2 and SC7) there is nothing to
render, and printing a value verbatim after the C6 sanitizer strip is the honest
behaviour.

**No audit row.** See **SC8** — at `MIGRATION_DATABASE_URL` there is no application user
identity, so the row would record `SYSTEM`: attribution that looks present and is not.

**Control class**: `enforceable boundary`. The actor must already hold
`MIGRATION_DATABASE_URL`, i.e. database-level access — a strictly smaller set than
tenant admins and one that already has strictly greater power. Adjudication authority is
Postgres role authentication, not an application check. That is the whole reason the
HTTP variant was removed in revision 2: an application-layer check would have been a
`fail-closed verification gate` guarding a capability its holders could already exercise
directly.

**Invariants**:
- **I8 (schema-enforced)** — the CLI cannot attach a domain owned by another tenant.
  Authority: `UNIQUE(claim)`; the CLI translates the constraint violation into a
  refusal rather than deciding the question itself.
- **I9 (app-enforced)** — every mutation names both the domain **and** its owning
  tenant, and a mismatch is a refusal. Revision 2's I9 named the wrong artifact and the
  wrong hazard; this is the real invariant.

**Gate delta** (round-3 **M25**). `scripts/checks/check-raw-sql-usage.mjs:63` sets
`SCAN_ROOTS = ["src", "scripts"]` and walks `.ts`/`.tsx`, so `scripts/tenant-domain.ts`
needs a `scripts/checks/raw-sql-usage.txt` entry with a ≥10-character purpose, plus an
`ident-markers=N` suffix and `// raw-sql-ident:` markers if any `$…Unsafe` span
interpolates an identifier. Both existing `scripts/*.ts` operator tools are already
listed (`raw-sql-usage.txt:63-64`), one with `ident-markers=2`. `unmapped` is the raw-SQL
site: it unions `audit_logs.metadata->>'claim'` with
`audit_outbox.payload->'metadata'->>'claim'` — **two different JSON paths**, which the
plan must state rather than call "a union" as if they were one — grouped as
`(tenant, claim, count, lastSeen)`. No identifier is interpolated, so `ident-markers=0`.
Recorded negative: the gate's `EXCLUDE_RE` covers `__tests__`, so the C1 and C7
integration tests' `$executeRawUnsafe` calls need **no** entry.

**Forbidden patterns**:
- `pattern: process\.env\.DATABASE_URL\b` in `scripts/tenant-domain.ts` — reason:
  `passwd_app` is NOSUPERUSER and RLS-bound; this is an operator tool. Revision 2's bare
  `DATABASE_URL` was a substring of `MIGRATION_DATABASE_URL`, the one variable the script
  must read, so it forbade the compliant implementation (**N6**).
- `pattern: ADMIN_API_TOKEN|\bop_` in that file — reason: the operator-token model is
  deliberately not involved (round-1 Critical).

**Acceptance criteria** — `src/__tests__/db-integration/tenant-claim-cli.integration.test.ts`,
importing the script's exported command functions and using `createTestContext()` from
`src/__tests__/db-integration/helpers.ts`. Round 2 (**T6**) showed a
`scripts/__tests__/*.test.mjs` placement lands in the **unit** suite
(`vitest.config.ts` includes it; `vitest.integration.config.ts` includes only
`src/**/*.integration.test.ts`) and would run in `app-ci`, which has a redis service and
a dummy `DATABASE_URL` — reddening the job or self-skipping. The repo's convention is the
opposite placement: `src/__tests__/db-integration/bootstrap-rds-roles.integration.test.ts`
imports `../../../scripts/bootstrap-rds-roles.mjs`. `scripts/tenant-domain.ts` is added
to `.github/workflows/ci-integration.yml`'s paths filter, which has no `scripts/**` today.

- `add` for a new domain → row created.
- `add` repeated for the same tenant+domain → success, exactly one row (idempotency, VE2).
- `add` for a domain owned by another tenant → non-zero exit, and the row's `tenantId`
  is **unchanged** (asserts the mutation, not only the exit code — RT8).
- `add` with `Alias.Example` → stored as `alias.example`; with `"https://alias.example"`
  → rejected by `operatorDomainSchema` before any query.
- `add`/`remove` with an unresolvable `--tenant` → non-zero exit, no row changed.
- `remove` with a `--tenant` that does not own the domain → non-zero exit, row intact.
- `remove` → row gone; `remove` of an unknown domain → non-zero exit. Implemented as
  `updateMany({ where: { claim, tenantId, revokedAt: null }, data: { revokedAt: new Date() } })`
  — `Prisma.TenantClaimWhereInput` — with an explicit `count === 0` → non-zero exit,
  rather than `update`, whose miss throws `P2025` (**N11**). Soft delete, so the row's
  lifetime survives (**S3-4**); the total row count is asserted unchanged.
- `remove` does **not** delete or invalidate any `sessions` row — the assertion for
  scenario 3, which revision 2 stated in prose with nothing testing it.
- `unmapped` returns the claim and tenant for a seeded denial present only in
  `audit_outbox` (worker stopped), and an empty result with the retention message when
  there are none (RT10 — both sides).
- Missing `MIGRATION_DATABASE_URL` → non-zero exit with an actionable message, no
  connection attempted.

---

### C8 — Audit identifier pepper

```ts
// src/lib/audit/auth-failure.ts
function getIdentifierPepper(): Buffer | null   // memoised, with a test reset seam
// 1. AUDIT_IDENTIFIER_PEPPER            → explicit override
// 2. AUTH_SECRET (length-checked ≥ 32)  → hkdfSync("sha256", secret, "",
//                                          "audit-identifier-pepper-v1", 32)
// 3. neither                            → null
```

When it returns `null`, `emitAuthLoginFailure` emits `identifierHash: null` and
`identifierHashScope: "unkeyed"`, and warns once.

Round 1 established that the current empty-key fallback is a control that degrades to
zero: an unkeyed hash over an email-address input space is a lookup, not a protection,
so the module's "Raw email is never persisted" comment is true in form and false in
effect. It also established that revision 1's SC3 deferral rested on a false premise —
`AUTH_SECRET` is **already production-required**
(`src/lib/env-schema.ts:452-457`, min 32 chars, enforced by `superRefine`, verified
directly).

Round 2 (**S6**) then rejected revision 2's dev fallback — a *committed public constant*
is the same defect in a narrower band, and `NODE_ENV` distinguishes build mode, not data
sensitivity. Emitting `null` is the honest answer: it costs one nullable read, it never
claims a protection it does not have, and it needs no throw. In production the branch is
unreachable because `envSchema` fails boot without `AUTH_SECRET`.

Note the deliberate divergence from `src/lib/auth/session/session-cache.ts:84-117`, which
falls back to another real secret in dev: that fallback exists to preserve *digest
compatibility* with pre-existing rows. There is no such compatibility requirement here,
so the simpler honest branch wins.

`AUTH_SECRET` is length-checked at the derivation site because the ≥32 floor is enforced
only under `isProd` in `superRefine`. The info string carries `-v1`, matching
`session-token-hmac-v1` and `session-cache-hmac-v1`, so a later rotation is expressible.

**Control class**: `enforceable boundary` **in production** — key material is guaranteed
by `envSchema`'s production requirement, which fails boot rather than degrading. Outside
production the class is `detection or audit only`, and the record says so via
`identifierHashScope: "unkeyed"` rather than looking keyed.

**Invariants**:
- **I10 (app-enforced)** — `hashIdentifier` never runs with an empty or fabricated key.

**Forbidden patterns**:
- `pattern: AUDIT_IDENTIFIER_PEPPER\s*\?\?\s*""` in `src/lib/audit/auth-failure.ts` —
  reason: this is the exact shape of the defect (`:36`). Revision 2's pattern targeted
  `createHmac("sha256", "")`, which never appears, so it could not be shown able to fail
  (**N10**).

**Acceptance criteria** — in `src/lib/audit/auth-failure.test.ts`, with
`vi.resetModules()` plus a per-case `await import("@/lib/audit/auth-failure")`, the
pattern `src/__tests__/audit-logger.test.ts:151` already uses. Round 2 (**M18**) showed a
module-scope memo is otherwise incompatible with these cases: `vitest.config.ts` sets
`isolate: true` per **file**, and `src/__tests__/setup.ts:20-25` mandates `vi.stubEnv` /
`vi.unstubAllEnvs()`, neither of which reaches a value frozen at first call.
- Explicit pepper set → the hash matches the explicit-key HMAC.
- Unset + `AUTH_SECRET` set → stable across calls, differs from the empty-key HMAC of the
  same input, and differs when `AUTH_SECRET` differs.
- Unset + `AUTH_SECRET` shorter than 32 → treated as absent.
- Both unset → `identifierHash: null`, `identifierHashScope: "unkeyed"`, warn emitted
  once across repeated calls.
- The warning fires on first derivation, not at module load — the branch is only known
  when the pepper is first needed (**N10**).

Existing hashes change. Since `AUTH_LOGIN_FAILURE` hashes are forensic correlators and
not lookup keys, no migration is needed; the change is recorded in
`docs/security/audit-log-schema.md` so a reader correlating across the upgrade knows why
the population splits. NF2 covers startup and feature behaviour, not the stability of a
hash that was previously providing no protection.

---

### C9 — Nine undeclared app-runtime env vars

**Member-set (R42), derived from code** — the reported symptom named exactly one
variable. Derivation reuses the gate's own scanner so the gate and the member set cannot
drift apart:

```
set A = scanAppEnvReaders(repoRoot)   # scripts/check-env-docs.ts:193
set B = Object.keys(getSchemaShape()) ∪ allowlist literals ∪ allowlist regexes
finding set = A \ B
```

Recomputed independently by three reviewers across two rounds (94 readers, 117 Zod keys,
11 literals + 2 regexes → ten members):

| Var | Read at |
|---|---|
| `AUDIT_IDENTIFIER_PEPPER` | `src/lib/audit/auth-failure.ts:36` — secret; now an override over C8's derived key |
| `COOKIE_PARTITIONED` | `src/auth.config.ts:172` |
| `BREAKGLASS_COOLING_OFF_SECONDS` | `src/app/api/tenant/breakglass/route.ts:134` |
| `IOS_APP_TEAM_ID` | `src/app/api/mobile/.well-known/apple-app-site-association/route.ts:32` |
| `IOS_APP_BUNDLE_ID` | same file:39 |
| `QUOTA_MAX_PASSWORDS_PER_USER` | `src/lib/quota/resource-quotas.ts:49` |
| `QUOTA_MAX_ATTACHMENT_BYTES_PER_USER` | same file:51 |
| `QUOTA_MAX_SHARE_LINKS_PER_USER` | same file:53 |
| `QUOTA_MAX_WEBHOOKS_PER_TENANT` | same file:55 |

The tenth, `INTERNAL_TEST_VERIFIER_VERSION`, is C10.

The four `QUOTA_MAX_*` are exactly what a `process.env.` grep misses — they are read
through a locally-defined `envInt(name, default)` at `src/lib/quota/resource-quotas.ts:39`
that shadows the exported helper in `src/lib/prisma.ts`. Deriving from the defining
primitive rather than a hand-written grep is what surfaced them.

**Deltas**: `src/lib/env-schema.ts` (`envObject`, all `.optional()` — each has a working
default or a documented degraded mode, so none becomes a new startup requirement, NF2);
`scripts/env-descriptions.ts` (sidecar entry with `group`); regenerate `.env.example` via
`npm run generate:env-example`; `scripts/init-env.ts` prompts for
`AUDIT_IDENTIFIER_PEPPER` only (the sole secret).

**Control class**: `detection or audit only`. Enforcement is C11.

**Forbidden patterns**:
- `pattern: AUDIT_IDENTIFIER_PEPPER:\s*hex64(?!\.optional)` in `src/lib/env-schema.ts` —
  reason: C8 makes it an override; requiring it would break NF2 for no gain.
- `pattern: [0-9a-f]{64}` in `.env.example` / `scripts/env-descriptions.ts` — reason: the
  secret-pattern guard fails the build, and a committed example key is a committed
  credential.

**Acceptance criteria**:
- `npm run generate:env-example` produces a diff of exactly nine new keys.
- `npm run check:env-docs` exits 0.
- `src/lib/env-schema.test.ts` asserts the schema parses with each var absent **and**
  that each parsed value equals the documented default. ("Behaves identically to `main`"
  has no mechanical form; this is the assertable subset.)

---

### C10 — `INTERNAL_TEST_VERIFIER_VERSION` allowlist entry

`src/lib/crypto/verifier-version.ts:12` reads it from non-test code, gated on
`NODE_ENV === "test"`. It is a test seam, not operator configuration, so it belongs in
`scripts/env-allowlist.ts` with `readByApp: true`, plus `consumers[]` (≥1 path) and
`reviewedAt`, which checks 5 and 10 require.

**Control class**: `detection or audit only`.

**Acceptance criteria**: after C11 lands, `check:env-docs` exits 0 with the entry and
non-zero without it — the entry's necessity is proven, not asserted.

---

### C11 — `check-env-docs` check 12, its CI trigger, and its self-test

**The missing gate direction.** All eleven existing checks run
Zod/allowlist/compose/`.env.example` against each other. Check 9 asks "is an allowlisted
key read by `src/**`?" — the reverse. Nothing asks "is a key read by `src/**` declared
anywhere?", which is how nine variables accumulated.

```
check 12 [src-read-undeclared]: "<KEY>" is read by src/** but is in neither the Zod
schema nor scripts/env-allowlist.ts — add it to envObject (operator-configurable) or to
the allowlist with readByApp: true (framework/test-only)
```

Reuses `scanAppEnvReaders(root)` (`:193`), the loaded Zod shape, and the allowlist. No
new scanner.

**Scanner extension to `.tsx`** (round-2 **M17**). `scanAppEnvReaders` walks `.ts` only
(`:206-212`). Eleven variables are read from `.tsx` today — all currently declared, so
the gate would be green by luck, not by construction. A gate that declares itself
fail-closed and enumerates its non-members must either close this or enumerate it; it is
one line in the extension filter, so it is closed. `.test.tsx` is already excluded.

**CI trigger** (round-2 **T5/F5**). `env-drift-check` (`.github/workflows/ci.yml:78-91`)
is guarded by `if: needs.changes.outputs.env == 'true'`, and the `env` paths filter
(`:64-74`) lists only env/compose/script files — **not** `src/**`. Check 12's trigger is
a new env read anywhere under `src/**`; all nine C9 variables live outside the filter, so
a PR adding an undeclared read without touching a listed path would not run the job.
`'src/**'` is added to the `env` filter. Round 2 verified this disturbs nothing:
`dorny/paths-filter` evaluates filters independently, `needs.changes.outputs.env` is
consumed by exactly one job, and `check:env-docs` runs in exactly one CI place.

**Control class**: `fail-closed verification gate` **for statically-spelled reads**.
Adjudication authority is `scanAppEnvReaders`'s regex over source text — a *lexical*
authority, not the TypeScript resolver. **Enumerated non-members**: dynamic key
construction (`process.env[name]`). Enumerated input axes: `process.env.X` and
`env{Int,Bool,Str}("X", …)`, over `.ts` and `.tsx`.

**Invariants**:
- **I11 (app-enforced)** — the gate fails when any statically-spelled `src/**` env read
  is undeclared. Proven by the fixtures below, not by the gate being green.

**Acceptance criteria**:
- Fixtures at `scripts/__tests__/fixtures/env-drift/<case>/`, driven by the existing
  harness (`scripts/__tests__/check-env-docs.test.mjs:15`, `runChecker(dir)` → `--root`).
  Revision 1's invented `scripts/__fixtures__/` path holds unrelated files.
- Five **committed** cases mirroring the `positive/` fixture's layout:
  `src-read-in-zod` (exit 0), `src-read-in-allowlist` (exit 0), `src-read-undeclared`
  (exit 1, stderr matches `/src-read-undeclared/`), `src-read-tsx-undeclared` (exit 1),
  `src-read-dynamic-key` (exit 0).
- **Vacuity guards (RT4).** `scanAppEnvReaders` silently returns an empty set when
  `<root>/src` is absent (`:228-230`), so every fixture contains a real read under
  `<fixture>/src/**`. `src-read-dynamic-key` contains **both** a `process.env[name]` read
  (expected invisible) **and** a statically-spelled *declared* read, so the case cannot
  pass by the scanner being dead. Its liveness is pinned by the separate
  `src-read-tsx-undeclared` fixture rather than by mutating a committed one at runtime —
  round-2 **T14** noted that a runtime write leaves the tree dirty on a crashed run and
  flips that case's own expected exit code next time.
- One-off RT7 proof: with C9's declarations reverted on a **scratch copy** and `--root`
  pointed at it, the gate reports exactly the nine keys and exits 1. The exact-nine form
  stays a one-off; the committed fixtures assert on the failure token, not the count, so
  they do not rot when a tenth variable is legitimately added.
- A PR touching only `src/**` triggers `env-drift-check`.

Round 1 established that `scripts/checks/check-gate-selftest-coverage.sh` imposes **no**
contract here — its member sets are `scripts/checks/*.{sh,mjs}` and inline
`run_step "Static: …" bash -c` gates, and `scripts/check-env-docs.ts` matches neither.
Revision 1's claim that it "must accept the new self-test" is removed rather than relied
on.

---

### C12 — Operator documentation

- `README.md` / `README.ja.md`: rows for the nine C9 variables, and a recovery
  subsection "IdP domain changed / tenant locked out" pointing at C7.
- **The `GOOGLE_WORKSPACE_DOMAINS` interaction** (round-1 and round-2 converged Major,
  R48). `src/auth.config.ts:207-215` denies any Google sign-in whose `hd` is not in
  `parseAllowedGoogleDomains()`, running as `baseSignIn` at `src/auth.ts:268-279` —
  **before** tenant resolution, producing `reason: "provider_error"`. For deployments
  that set it (which `SECURITY.md:85` recommends), registering a claim alone changes
  nothing, and `tenant-domain unmapped` shows nothing because the denial never reaches
  row 9. The runbook therefore instructs: register the claim **and** add the domain to
  `GOOGLE_WORKSPACE_DOMAINS`. Two things revision 2 left unsaid, both from round-2
  **S8**:
  - The variable is **deployment-global** while the registry is tenant-scoped. The
    runbook says to record which tenant it was added for and gives a removal condition,
    so it does not silently accumulate every domain any tenant ever renamed to.
  - The warning against *unsetting* it must name the observable symptom.
    `allowDangerousEmailAccountLinking` is `allowedGoogleDomains.length > 0`
    (`src/auth.config.ts:43`), so adding a domain does not change the flag and unsetting
    flips it to `false` — **stricter**, producing a second, different failure
    (`OAuthAccountNotLinked`) on top of the tenant denial. "Changes account-linking
    behaviour" is not a symptom anyone recognises at 3am.
  `tenant-domain add` prints the same reminder on success.
- **Incident runbook: "a claim was registered that should not have been"** (round-1
  Security F12). Removing the row does **not** undo what it granted: `User.tenantId` and
  `TenantMember` rows created while it existed persist, and the bootstrap-migration
  branch reassigns rows wholesale. The runbook gives the query to enumerate members whose
  tenant was assigned during the row's lifetime (both `createdAt` values are available)
  and states plainly that the bootstrap-migration case may be irreversible.
- **Pre-flight query, run before `prisma migrate deploy`** (round-3 **F10**/**S3-8**,
  and SC9). C1's backfill silently skips two classes; the operator must see them first:
  ```sql
  -- normalisation collisions: two tenants that would compete for one claim
  SELECT lower(btrim(external_id)) AS claim, count(*), array_agg(id)
  FROM tenants WHERE external_id IS NOT NULL AND btrim(external_id) <> ''
  GROUP BY 1 HAVING count(*) > 1;
  -- non-ASCII values that SC9 excludes from the registry
  SELECT id, external_id FROM tenants
  WHERE external_id IS NOT NULL AND lower(btrim(external_id)) ~ '[^\x20-\x7E]';
  ```
  Both are also surfaced by `npm run tenant-domain -- preflight`. Each row returned needs
  an operator decision (which tenant keeps the claim; whether the non-ASCII tenant needs
  an ASCII claim registered) **before** the upgrade, not after a lockout.
- **What the backfill actually contains.** `prisma/migrations/20260228010000_tenant_external_id_and_bootstrap/migration.sql:15-17`
  backfilled `external_id = id` for every non-bootstrap, non-orphan tenant, so in
  deployments upgraded through it the registry inherits **tenant UUIDs** as live claim
  strings — and `tenant_id` is the first entry in `DEFAULT_TENANT_CLAIM_KEYS`. This is
  pre-existing behaviour carried forward faithfully, but it becomes visible here and so
  is documented here (round-3 **S3-12**), with the query to review the backfilled set
  and a note that `tenant_id`/`tenantId` in the default claim-key list deserves its own
  look now that the namespace is explicit.
- **`AUTH_TENANT_CLAIM_KEYS` guidance** (round-3 **S3-5**): setting it to a SAML-asserted
  attribute lets any provisioned IdP select any tenant, because `saml-jackson` is one
  deployment-wide client and nothing binds a claim namespace to the connection that
  asserted it. `hd`, or per-connection tenant binding, is the safe configuration.
- **Incident runbook covers both directions** (round-3 **S3-7**). Revision 3's runbook
  covered "members created inside the wrong tenant". Rows 6 and 9a produce the other
  direction: a bootstrap user's personal vault **absorbed** into the tenant, with
  `passwordEntry`, `vaultKey`, `attachment`, `emergencyAccessGrant`, `passwordShare`,
  `apiKey`, `webAuthnCredential`, `session` and `audit_logs` reassigned. The runbook
  gives the query for both and repeats "may be irreversible" for the absorption case.
- `docs/security/audit-log-schema.md` (new): the `identifierHashScope` semantics, the
  `claim` field's IdP-controlled provenance and inert-text rendering requirement, the
  `EXTERNAL_DELIVERY_METADATA_BLOCKLIST` decision, and the C8 hash-population change.
- `CLAUDE.md`: `npm run tenant-domain` in the admin-scripts block. No endpoint table rows
  — there are no new endpoints.

**Control class**: `detection or audit only`.

**Acceptance criteria**: `check:env-docs` and `scripts/checks/check-doc-paths.mjs` pass;
no real domain or email appears in any changed file.

---

### C13 — Dev-database remediation

1. Delete the stray tenant created by the denied sign-in
   (`external_id = <alias.example>`, zero members) — **after** proving it owns nothing.
   Its backfilled `tenant_claims` row goes with it via `ON DELETE CASCADE`.
2. Register `<alias.example>` for the user's existing tenant using
   `npm run tenant-domain -- add`, so the remediation exercises the path it documents.

Order matters and is now enforced rather than trusted: step 2 would fail with a
uniqueness refusal while the stray tenant's backfilled row still holds the domain.

**Control class**: `enforceable boundary` for step 1 — the deletion is gated on FK
reference counts read from `information_schema`, not on inspection.

**Acceptance criteria**:
- A pre-delete query proves the stray tenant has no referencing rows in **any** table
  with a `tenant_id` FK. If any exist, stop and report.
- After remediation, Google sign-in for the affected user succeeds and `audit_logs` shows
  `AUTH_LOGIN`, not `AUTH_LOGIN_FAILURE`.
- Executed only with explicit user confirmation at the time of execution. This plan
  authorises writing the runbook, not running it.

---

## Verification map

| Path | Class | Discharged by |
|---|---|---|
| C1 uniqueness / CHECK / cascade / RLS / backfill | verifiable-CI | `tenant-claim.integration.test.ts` + the existing `rls-smoke` job |
| C2 normalisation + schema | verifiable-CI | `tenant-claim-registry.test.ts` (real functions) |
| C3 resolution | verifiable-CI | `resolve-tenant-by-claim.test.ts` (new file) |
| C4 find-or-create + atomic registration | verifiable-CI | `tenant-management.test.ts` (updated) + the shadow-claim case |
| C5 rows 1–10 + emit-level reason | verifiable-CI | `src/auth.test.ts` |
| C6 metadata + sanitizer | verifiable-CI | `auth-failure.test.ts` (new) + `tenant-claim.test.ts` + `audit-logger.test.ts` |
| C7 CLI | verifiable-CI | `tenant-claim-cli.integration.test.ts` + the `ci-integration.yml` paths delta |
| C8 pepper | verifiable-CI | `auth-failure.test.ts` with `vi.resetModules()` |
| C11 gate | verifiable-CI (VE3) | five committed fixtures + the one-off scratch-copy proof |
| C13 remediation | verifiable-local | manual, user-confirmed |
| An IdP actually emitting a changed claim | **blocked-deferred (VE1)** | cost-justified above; the seam below it is covered |

| Scenario | Discharged by |
|---|---|
| 1. Reported failure: unregistered claim, existing member | C5 row 9 + the emit-level assertion |
| 2. Locked-out tenant recovered by the CLI | C7 `add` + C5 row 5 regression |
| 3. **New hire signs in after recovery** | C4's atomic registration: the claim already resolves, so no tenant is created and the user joins the right tenant. This is round-2 **S1**, pinned as a test. |
| 4. Claim removed while users authenticate under it | C7 `remove` + C5 row 9 + the "no `sessions` row touched" assertion |
| 5. Domain already owned by another tenant | C7 `add` refusal, `tenantId` unchanged |
| 6. Genuinely different organisation | C5 row 7 (`tenant_mismatch` preserved — the NF2 regression case) |
| 7. First-ever sign-in, unknown claim, no membership | C5 row 8 + C4 |
| 8. User with two active memberships and a claim present | C5 row 10 (`provider_error`, no write — the D2 regression pin) |
| 9. Fresh clone, nothing configured | C9 acceptance (schema parses with all nine absent) |

---

## Testing strategy

| Contract | Level | What proves it can fail |
|---|---|---|
| C1 | integration (real Postgres) | duplicate → `P2002`; `Alias.Example` → `P2010`/`23514`; tenant delete → rows gone; cross-tenant select → 0 rows; backfill set comparison |
| C2 | unit, unmocked | a non-identity normalisation case; seven rejection cases |
| C3 | unit, new file | zero-write assertion; invalid-domain claim → `null` |
| C4 | unit | shadow-claim case: creating for an already-registered claim re-resolves and creates no second tenant |
| C5 | unit | ten rows; three deny rows assert `tenant.create`, `tenantClaim.create` and `tenantMember.upsert` not called; emit-level reason asserted at the `signIn` callback |
| C6 | unit | U+202E fixture in the file where the sanitizer is reachable; scope field both ways |
| C7 | integration (real DB) | refusals assert the row's `tenantId` is unchanged, not only the exit code; `unmapped` covered with the worker stopped |
| C8 | unit with `vi.resetModules()` | derived hash ≠ empty-key hash; both-unset → `null` + `"unkeyed"` |
| C9 | unit | each var absent → parses; each default asserted |
| C11 | gate self-test | five fixtures incl. a `.tsx` case + the one-off scratch-copy revert |

**Mocking stance.** Round-1 Testing F8 caught revision 1 placing its *proof* of the
unique index and the CHECK constraint on the mocked side, where both assertions would
have been self-fulfilling. Every assertion whose adjudication authority is Postgres —
unique index, CHECK, FK cascade, RLS, the backfill — runs against the real database.
Mocks are used only where the assertion is about application-layer mapping.

**Shared fixtures (RT3).** `primary.example` / `alias.example` are exported once from
`src/__tests__/helpers/tenant-claim-fixtures.ts` and consumed by the unit and
integration tests. The SQL seed and the gate fixtures necessarily duplicate the literals;
that is the deliberate exception.

Every new guard gets a paired allow case, not only a deny case.

---

## Considerations & constraints

### Scope contract

- **SC1 — Dashboard UI for claim management.** Deferred, and contingent: it cannot be
  built as tenant-admin self-service without SC5's DNS verification. **Anti-Deferral**:
  the CLI fully restores a locked-out tenant, so deferral costs convenience, not
  recoverability.
- **SC2 — Automatic registration inferred from an inbound claim.** Rejected, not
  deferred. Any heuristic attaching an unrecognised claim to an existing tenant becomes
  the authorisation boundary.
- **SC3 — Retired.** Superseded by C8.
- **SC4 — Retired.** Revision 1 deferred backfilling `TenantClaim` from
  `Tenant.externalId`; revision 3's unification makes that backfill mandatory (C1).
- **SC5 — Tenant-admin self-service claim registration.** Rejected in this PR, owner: a
  follow-up gated on DNS verification. **Anti-Deferral cost-justification**: round-1
  review demonstrated that admin-of-some-tenant is not evidence of control over a domain,
  and that the resulting exploit reaches `createUser` without passing any denial gate.
  Shipping it with a note in a follow-up list would ship the vulnerability. The correct
  control — a `PENDING`/`VERIFIED` state machine with a `_passwd-sso-verify.<domain>` TXT
  lookup plus re-verification — is a feature in its own right, and DNS resolution at a
  request boundary brings its own timeout, caching and SSRF-adjacent considerations.
- **SC6 — Surfacing the failure reason in the dashboard audit viewer.** Deferred. Round 1
  established the viewer renders no failure reason for any existing
  `AuthLoginFailureReason` (`tenant-audit-log-card.tsx:188` passes metadata only to
  `AuditDelegationDetail`, which reads `reason` for delegation actions), so this is a
  pre-existing gap this PR does not widen. **Anti-Deferral**: F6's actionability is
  discharged through `tenant-domain unmapped` and the CSV export; adding a reason-render
  path means new i18n keys for all six reasons plus a coverage test, and a lowercase key
  in `AuditLog.json` would sit outside the orphan-label guard's `^[A-Z][A-Z0-9_]+$`
  pattern — a permanently dead key.
- **SC7 — Claim-source attestation.** Deferred, with the threat stated because it is
  real. `extractTenantClaimValue` tries `tenant_id`, `tenantId`, `organization`, `org`,
  `company`, `company_id` (or `AUTH_TENANT_CLAIM_KEYS`) before falling back to `hd` for
  Google. Google's `hd` is attested by Google; a SAML `organization` attribute is attested
  by nothing, so an IdP that can set that attribute can match any registered claim string.
  **Anti-Deferral cost-justification** — corrected after round-3 **S3-5**, which showed
  revision 3 named the wrong barrier. The operator controls *whether a connection
  exists*; the **customer** controls *what their IdP asserts through it*, and the
  exploit needs only the second. `saml-jackson` is a single deployment-wide OIDC client
  (`src/auth.config.ts:60-91`) and nothing binds a claim namespace to the connection
  that asserted it, so in a deployment where `AUTH_TENANT_CLAIM_KEYS` names an
  assertion-sourced attribute and more than one SSO connection exists, customer A's IdP
  admin can assert customer B's claim string. The real preconditions are therefore: a
  deliberate `AUTH_TENANT_CLAIM_KEYS` configuration naming an IdP-asserted attribute,
  **and** ≥2 provisioned connections. The primitive is pre-existing — identical today
  through `findUnique({externalId})` — and does not fire on `hd`-only deployments, which
  is the reported incident. It becomes a tenant-admin escalation the moment self-service
  SSO connection management is added, which is the same gate SC5 sits behind.
  **This PR carries the documentation half**: C12 states that setting
  `AUTH_TENANT_CLAIM_KEYS` to a SAML-asserted attribute lets any provisioned IdP select
  any tenant, and that `hd` or per-connection tenant binding is the safe configuration. Building it here costs a
  discriminator column, a nullable-means-wildcard rule for backfilled rows, a shape change
  to `extractTenantClaimValue` that round 2 showed breaks four consumers and two test
  suites in a way no type-checker catches, and a widening of `TenantClaimStore`. It is a
  separate hardening from the lockout fix and belongs with SC5.
  **IDN canonicalisation folds in here.** Round-1 Security F14 (Minor) noted a U-label
  and its A-label spelling would be two rows resolving to two tenants. Canonicalising
  requires first deciding whether a claim *is* a hostname — the same conflation C2 exists
  to avoid, since `organization`-style claims are not. The two hardenings share that
  prerequisite, so they share a follow-up. Until then `operatorDomainSchema` keeps
  operator-registered rows in one spelling; only an IdP-created row could arrive as a
  U-label.
- **SC8 — Application-level audit for claim registration.** Deferred, on a **corrected**
  justification. Revision 3 argued a `SYSTEM`-attributed row would be "attribution that
  looks present and is not"; round-3 **S3-4** showed that is false —
  `emitAuthLoginFailure` writes `userId: SYSTEM_ACTOR_ID, actorType: ACTOR_TYPE.SYSTEM`
  for every failed sign-in, as do the outbox, retention-GC and anchor-publisher workers.
  `ACTOR_TYPE.SYSTEM` is a truthful statement about a non-human actor, and per the
  no-false-technical-justification rule the stated cost was not a real constraint.
  The narrower true reason: with C1's `createdAt`, `revokedAt` and `createdBy`, the row
  itself carries the timeline and the self-asserted actor that an incident needs, so an
  audit row would add a duplicate timestamp — and two new `AUDIT_ACTION` values cost a
  Prisma enum, an `ALTER TYPE` migration, `AUDIT_ACTION_VALUES`, two group arrays, two
  i18n files, a webhook-subscription decision, and three distinct mutation proofs for
  that duplicate. **Anti-Deferral**: real (non-self-asserted) attribution needs an
  operator identity model for database-level tooling, a cross-cutting change well beyond
  this PR. Until then, C12's runbook directs incident responders to Postgres logs and to
  `tenant_claims.createdAt`, and the CLI prints exactly what it changed.

- **SC9 — Non-ASCII claim strings.** Narrowed in this PR, deliberately. C1's CHECK
  restricts a *stored* claim to printable ASCII, and `storableClaimSchema` rejects the
  rest at the application boundary. This is round-3 **M23**'s remedy: `btrim()` strips
  ASCII space only while JS `.trim()` strips all Unicode whitespace, and `lower()` is
  LC_CTYPE-dependent while `toLowerCase()` is fixed full-Unicode, so outside ASCII the
  two engines do not agree — a backfilled row could be stored un-trimmed and be
  unreachable at read time, and under a `C`-ctype database the CHECK would accept two
  spellings of one claim, making I1 false. Restricting the stored form makes the engines
  agree by construction. **Anti-Deferral cost-justification**: the alternative is a
  collation-pinned deployment precondition plus a Unicode-aware CHECK, which is real
  work and belongs with SC7's claim-source model (IDN canonicalisation has the same
  prerequisite). The narrowing is genuine — `slugifyTenant` carries an explicit
  "Fallback for non-ASCII-only inputs (e.g. Japanese org names)" branch, so a deployment
  using a non-ASCII `organization` claim exists in the design space, and for it this PR
  turns a working sign-in into a `tenant_mismatch` denial. It does not exist in this
  deployment (2 of 264 tenants have an `external_id`, both ASCII), and C12's pre-flight
  query surfaces the affected rows **before** the upgrade rather than after.

### Risks

- **R-a** — `tenant_claims` joins the RLS manifest; a missed delta breaks the
  cross-tenant CI verify. Mitigated by I4's four-way count check.
- **R-b** — C8 changes every future `identifierHash`. Deliberate; recorded in
  `docs/security/audit-log-schema.md`.
- **R-c** — `scanAppEnvReaders` is lexical; `process.env[dynamicKey]` is invisible to
  check 12. Enumerated in C11, not discovered later.
- **R-d** — the shared dev database (VE2) means C13 affects other working copies.
  Idempotent by construction; confirmed with the user before running.
- **R-e** — the backfill makes `tenant_claims` authoritative for tenants that previously
  resolved through `Tenant.externalId`. A row deleted by mistake is a tenant-wide lockout,
  which is why C7 requires `--tenant` on `remove` and prints the affected member count
  before mutating.

---

## Go/No-Go Gate

| ID  | Subject                                                          | Status  |
|-----|------------------------------------------------------------------|---------|
| C1  | `TenantClaim` model, migration, backfill, ASCII CHECK, RLS, grants | pending |
| C2  | `normalizeTenantClaim` + storable/operator schemas             | pending |
| C3  | `resolveTenantByClaim`                                           | pending |
| C4  | `findOrCreateTenantForClaim` (advisory lock + atomic registration) | pending |
| C5  | `ensureTenantMembershipForSignIn` discriminated result + dispatch | pending |
| C6  | Audit payload: claim + `identifierHashScope` + sanitizer rider   | pending |
| C7  | Offline operator CLI                                             | pending |
| C8  | Audit identifier pepper                                          | pending |
| C9  | Nine undeclared app-runtime env vars                             | pending |
| C10 | `INTERNAL_TEST_VERIFIER_VERSION` allowlist entry                 | pending |
| C11 | `check-env-docs` check 12 + `.tsx` + CI trigger + fixtures       | pending |
| C12 | Operator documentation + recovery and incident runbooks          | pending |
| C13 | Dev-database remediation runbook                                 | pending |

All contracts are `pending` until round-3 review closes.
