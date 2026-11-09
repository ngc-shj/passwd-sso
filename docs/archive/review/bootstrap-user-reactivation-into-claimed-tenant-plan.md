# Plan: bootstrap-user-reactivation-into-claimed-tenant (#955, re-scoped)

## Project context

- Type: web app (Next.js + Prisma + PostgreSQL) with an offline operator CLI (`scripts/tenant-domain.ts`).
- Test infrastructure: unit + real-DB integration + E2E + CI/CD.
- Verification environment constraints: none specific. Integration cells run on the local
  Postgres after stopping the compose workers (CLAUDE.md); CI runs the same job.

## Objective

#955 reports a user stuck in their bootstrap tenant: they hold a **deactivated** membership row in
the tenant their SSO claim resolves to, every SSO sign-in is refused with `tenant_mismatch`, and
the issue says no producer can move them, because directory sync recreates the row deactivated
after the documented remedy (SCIM `DELETE`) removes it.

The issue proposes that directory sync and SCIM reactivation migrate a bootstrap user into the
claiming tenant. That proposal is **not adopted** (user decision, 2026-11-09):

- `#830` (merged 2026-09-15, before the issue was filed on 2026-10-25) made the producers that do
  not authenticate the user — SCIM POST/PUT/PATCH and both directory-sync arms — act only on users
  the tenant **owns** (`resolveExistingUsersForTenant`, `usersOwnedByAnotherTenant`,
  `owningTenantOf`, `src/lib/tenant-context.ts`). Joining a tenant is the user's own act, through
  that tenant's IdP (round-5 S1, round-6 R6-S2 of the audit-tenant-adjudicator review).
- Directory sync and SCIM run on data the claiming tenant controls and authenticate nobody.
  Letting them migrate a bootstrap user would let a tenant list any email and absorb that user's
  bootstrap estate (vault data, sessions, credentials, personal audit history, then readable by
  its admins) and strip them of their own tenant's OWNER role.
- Reactivating the row at sign-in is not safe either: a row the tenant deactivated on purpose
  (IdP `active: false`, a later suspension) is indistinguishable from one created deactivated by
  the old `ACTIVE_IN_ANOTHER_TENANT` guard — no provenance is stored.

What `#830` changed and the issue and code comments did not catch up with: directory sync no
longer creates a row for a user another tenant owns, and SCIM POST answers 409 for them. So once
the claimed tenant deletes the row with SCIM `DELETE /Users/<id>` (`deactivateScimUser` removes the
row **and** the user's external mapping), the next directory sync puts the user in `toCreate`,
resolves them `foreign` with no row, and refuses with nothing written; the user's next SSO sign-in
finds no row and migrates (row 6). The remedy is deterministic.

Producers of a `tenant_members` row (`rg -n 'tenantMember\.(create|upsert|createMany)' src scripts`
plus raw `INSERT INTO tenant_members`), checked against a bootstrap-owned user in another tenant:

| Producer | Verdict |
|---|---|
| SCIM POST (`api/scim/v2/Users`) | 409 unless `owned` |
| Directory sync create (`directory-sync/engine.ts`) | `foreign` with no row → refused, re-checked in-context |
| Directory sync / SCIM PUT, PATCH reactivation | update only; gated by `usersOwnedByAnotherTenant` / `usersActiveInAnotherTenant` |
| Sign-in row 4 / row 5 (`src/auth.ts`) | user active nowhere / already active in the claimed tenant; user authenticated |
| Sign-in row 6 / 9a migration | the user's own authenticated act, all guards |
| `createUser` (`auth-adapter.ts`) | new user, new tenant |
| Raw SQL inserts | test seeds only (`scripts/rls-cross-tenant-seed.sql`, manual-test scripts) |

So the stuck state arises only from rows written before `#830` (or by operator database writes).
Any new producer must call the same ownership gates. The `tenant-domain unmapped` report already
lists these refusals under their own heading.

## Requirements

- R1: every live description of the deactivated-row refusal states the current behaviour and its
  terms: deleting the row is the tenant agreeing to admit the user; their next SSO sign-in then
  moves them in with their bootstrap data and personal audit history; a row the tenant deactivated
  on purpose should stay; directory sync does not recreate a deleted row. No live text says a sync
  recreates the row, or that SCIM, directory sync or the tenant's admins can reactivate it.
- R2: the `src/auth.ts` comment names that remedy, why SCIM and directory sync do not reactivate or
  migrate the user themselves (`#830` ownership), and the two cases where the remedy still does not
  move the user: a second active member in the bootstrap tenant (row 6b) and an OWNER-role row
  (`deactivateScimUser` refuses, `SCIM_OWNER_PROTECTED`).
- R3: a real-DB cell proves the remedy end to end through the SCIM route, red-proved per step.
- R4: no behaviour change in sign-in, directory sync, SCIM or the ownership helpers. Superseded in code review (S2, deviation D3): the bootstrap migration now moves history, key pairs and share access logs only through the migrating user's parents.

## Technical approach

Documentation and comment corrections plus one integration cell. No production logic changes.

## Contracts

### C1 — Stale remedy and rationale text corrected

Member set, derived by
`rg -n -i 'recreat|re-creat|no producer can|tenant.s decision|SCIM, directory sync, its admins' src scripts README.md README.ja.md docs -g '!docs/archive/**'`
plus `rg -n '作り直|テナントが決める' README.ja.md` (re-run in Phase 2; any new hit joins the set):

| Site | Change |
|------|--------|
| `src/auth.ts`, both comment paragraphs above the `priorMembership` refusal | R2 wording; the "target tenant's decision — SCIM, directory sync, its admins" rationale and "No producer can …" text replaced |
| `scripts/tenant-domain.ts`, the `unmapped` deactivated-row heading | R1 remedy, incl. "if the tenant means to admit the user"; keeps the three substrings `DEACTIVATED membership row`, ``SCIM `DELETE /Users/<userId>` `` and ``not `add --from` `` that `tenant-claim-cli.integration.test.ts` pins; same `printGroup` count |
| `README.md` cause table, deactivated-row `tenant_mismatch` row (cause and remedy cells) | R1; remedy notes a directory-sync-only tenant mints a SCIM token first (shortest expiry, revoked afterwards: it is a tenant-wide provisioning credential), and the id may be the userId or the IdP's externalId (`resolveUserId` accepts both) |
| `README.ja.md` same row | Same, with the same code spans in the same order (parity test keys on code spans) |
| `src/lib/tenant-context.ts`, `usersOwnedByAnotherTenant` doc ("the way back is … signing in") | one clause: a bootstrap user with a deactivated row here needs the row deleted first (see `src/auth.ts`) |
| `src/__tests__/db-integration/tenant-claim-binding.integration.test.ts`, the deactivated-row cell's docstring | same rationale correction |

- Control class: none (documentation), plus one pinned assertion (below).
- Forbidden patterns, scoped to the six member-set files above (the member-set grep's other hits —
  `isShareCreatorAdmitted`, "pre-create", `scim-user-service.ts`'s "membership is re-created (SCIM
  POST, SSO sign-in)", the realign warning — are unrelated correct text and out of scope):
  - pattern: `sync recreates|recreates it` — reason: the stale race.
  - pattern: `No producer can reactivate` — reason: stale claim.
  - pattern: `SCIM, directory sync, its admins` — reason: stale rationale.
  - pattern: `作り直` in README.ja.md — reason: the stale race, ja.
- Acceptance: the patterns return no match in those files; the README parity test passes; the CLI
  heading cell gains `expect(heading).not.toMatch(/recreat/i)` and
  `expect(heading).toContain("next SSO sign-in moves them in")` — the heading carries that exact
  phrase — so a wording regression goes red in CI.

### C2 — The remedy, proved on a real database

One cell in `src/__tests__/db-integration/tenant-claim-binding.integration.test.ts` (the only file
with the sign-in harness: `capturedSignIn`, `seedBootstrapMember`, `claimedTenant`, `placement`).
Directory sync's provider fetch and credential decryption are mocked at module scope (system
boundary), as `directory-sync-cross-tenant-users.integration.test.ts` does; the config row is
inserted raw the same way.

1. Seed: bootstrap member (OWNER, active) with a bootstrap-tenant session (and an API key or
   extension token); in the claimed tenant T a deactivated SCIM-managed MEMBER row and a `User`
   external mapping with the provider's externalId — the pre-`#830` shape.
2. Positive control: the sign-in through T's claim is refused, `tenant_mismatch` filed under T.
3. `DELETE /api/scim/v2/Users/<userId>` through the route's exported handler → 204. As in
   `scim-cross-tenant-users.integration.test.ts`, `@/lib/scim/with-scim-auth` is mocked at module
   scope (hoisted tenant id set to T): token validation, access restriction and the Redis rate
   limit are not the subject; the route body, `resolveUserId`, `deactivateScimUser` and the
   session invalidation run for real.
4. Assert: no `tenant_members` row and no `User` mapping for the user in T (counted over T); the
   bootstrap session and token survive (revocation stayed in T).
5. Run directory sync for T outside any tenant context, provider returning the user active with
   the same externalId. Assert `{ success: true, usersCreated: 0, usersRefused: 1 }`, exactly one
   `DIRECTORY_SYNC_ACTIVATION_REFUSED` outbox row with `metadata.reason = "owned_by_another_tenant"`,
   `targetType = DIRECTORY_SYNC_CONFIG` and `metadata.userId = null`, and still no row or mapping.
6. Sign in through T's claim again → allowed; `placement` shows the column and the active
   membership on T and no bootstrap membership.

- Control class: n/a (test).
- Red-proof (RT7), each on a scratch copy; the first failing assertion is recorded in the deviation log:
  - M1 `src/lib/directory-sync/engine.ts`: reduce `!user || (resolution?.kind === "foreign" && !existing)`
    to `!user` → first red at step 5 (a deactivated row is created; `usersCreated: 1`).
  - M2 `src/lib/services/scim-user-service.ts`: drop the mapping `deleteMany` → first red at step 4
    (mapping count). Had the cell continued, step 5 would see `usersRefused: 0` and no outbox row:
    with the mapping kept and the row gone the user enters neither `toCreate` nor `toUpdate`.
  - M3 the SCIM DELETE route: `invalidateUserSessions(userId, { tenantId })` widened to
    `{ allTenants: true }` → first red at step 4 (bootstrap session or token revoked).
- Acceptance: passes on the unmodified tree, red under each mutant at the named step.

### C3 — Issue record

The PR body says the issue's producer-side proposal was not adopted and why, and closes `#955`; a
comment on `#955` carries the same explanation before merge.

## Testing strategy

- C2 cell, red-proved by M1–M3; C1's pinned heading assertion.
- Existing suites touching the changed text: README parity test, `tenant-claim-cli` heading cell,
  `tenant-claim-binding` deactivated-row cell (behaviour unchanged).
- Mandatory: `npx vitest run`, `npx next build`, `npm run test:integration` (workers stopped),
  `scripts/pre-pr.sh`.

## Considerations & constraints

### Scope contract

- SC1: producer-side migration of bootstrap users by directory sync / SCIM (the issue's proposal),
  and reactivation at sign-in — rejected (Objective). Owner: none; recorded here and on the issue.
- SC2: a directory-sync or tenant-admin path that deletes the tenant's own deactivated row for a
  user another tenant owns (the safe variant the security review named) — not added; SCIM `DELETE`
  already does it. Owner: a future issue if operators ask for it.
- SC3: CLAUDE.md lists `DELETE /api/tenant/members/[userId]`, which the route does not export.
  CLAUDE.md edits need explicit user approval; reported, not changed here.
- SC4: archived review docs keep their historical wording.
- SC5: SCIM POST's 409 and directory sync's `owned_by_another_tenant` refusal tell a tenant that an
  email it lists has an account here — inherent in `#830`'s rule, unchanged.

## User operation scenarios

1. Legacy state: a magic-link user whose claimed tenant ran directory sync before `#830` holds a
   deactivated row there; their SSO sign-in is refused and the operator sees them under the
   `unmapped` deactivated-row heading. If the tenant means to admit them, it deletes the row with
   SCIM `DELETE` (minting a short-lived SCIM token first if it only uses directory sync, and
   revoking it afterwards); the next sync logs
   the user refused (`owned_by_another_tenant`) and writes nothing; the user signs in through SSO
   and lands in the tenant with their bootstrap data. If the bootstrap tenant has a second active
   member, or the row is OWNER, the move is still refused.
2. After `#830`: a tenant enabling directory sync today declines the bootstrap user (no row), so
   their first SSO sign-in migrates them directly (row 6).
3. A tenant that deactivated the user on purpose leaves the row; the refusal stands.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | Stale remedy and rationale text corrected; heading wording pinned | locked |
| C2 | Remedy proved end to end through the SCIM route, red-proved by M1–M3 | locked |
| C3 | PR body + issue comment record the re-scope | locked |
