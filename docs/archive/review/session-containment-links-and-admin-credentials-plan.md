# Plan: session-containment-links-and-admin-credentials (#1016)

## Project context

- Type: web app (Next.js App Router + Prisma 7 + PostgreSQL 16 with RLS, Auth.js v5 database sessions).
- Test infrastructure: unit + real-DB integration + E2E + CI/CD.
- Verification environment constraints: none specific (local Postgres, compose workers stopped for
  integration; CI the same).

## Objective

`DELETE /api/tenant/members/[userId]/passkeys` ("revoke all passkeys") deletes a member's passkeys
and ends every session and user-bound token in one transaction under the member's credential lock
(`revokeMemberPasskeys`, `src/lib/tenant/member-passkey-revoke.ts`). #1016 asks what else a
compromised session can leave behind. User decision (2026-11-10): full containment.

1. **Session-time account links are already refused** (#967 strips session cookies from Auth.js
   callback requests; `withoutSessionCookieOnCallback`, pinned by `route.auth-core.test.ts`; the only
   `linkAccount` caller is Auth.js `handleLoginOrRegister`). The `src/auth.ts` "Not modelled"
   comment predates #967; corrected.
2. **Revoke-all works for a member with no passkeys** (today 404 — an SSO-only member cannot be
   contained). It stays limited to ACTIVE members: a deactivated row is not authority over a user who
   may now be owned by another tenant (`usersOwnedByAnotherTenant`), and the flow reaches user-global
   state (plan review round 2, S1, Critical). Deactivation happens only at the IdP (SCIM / directory
   sync); the dialog and docs say to contain first.
3. **Linked IdP accounts** are listed and the admin can unlink chosen ones (links made before #967).
4. **Footholds the member created** are listed and the admin can revoke chosen ones in the same
   transaction: SCIM tokens, service accounts (with their tokens), service-account tokens the member
   minted on any service account, MCP clients (with their tokens), break-glass grants, and the
   member's own emergency-access grants (the owner's routine vault unlock escrows the vault key to an
   accepted grant without a prompt — security review S2).

## Requirements

- R1: `src/auth.ts` comment states the #967 behaviour.
- R2: revoke-all (`scope: {all: true}`) succeeds for zero passkeys of an ACTIVE member; both
  `NOT_FOUND` exits in `revokeMemberPasskeys` stay only for the single-credential scope; the target
  stays active-only everywhere (GET member read, `refuseMemberPasskeyTarget`, the in-transaction
  re-read, the members card).
- R3: GET additionally returns `linkedAccounts: [{ id, provider, linkedInTenant }]` (never
  `providerAccountId` or any token) and `createdFootholds` per kind: live rows only.
- R4: DELETE accepts an optional strict body `{ unlinkAccountIds?, revoke?: { scimTokenIds?,
  serviceAccountIds?, serviceAccountTokenIds?, mcpClientIds?, breakglassGrantIds?,
  emergencyAccessGrantIds? } }` (uuid, ≤ 100 per array, unknown keys refused). Absent or empty body
  = no containment (today's behaviour). The body is validated before step-up.
- R5: in the SAME transaction as the passkey/session revocation, after it, each chosen row is
  written only when it matches the id, the target as creator/owner, the tenant (tenant-owned kinds),
  and liveness; non-matching ids are skipped and counted. Audit in the transaction (`logAuditInTx` /
  `logAuditBulkInTx`).
- R6: gates: `MEMBER_MANAGE`, `refuseMemberPasskeyTarget` (not self; active member;
  `canRevokeMemberPasskey`), step-up. Per-kind permission (`SCIM_MANAGE`,
  `SERVICE_ACCOUNT_MANAGE` for service accounts, their tokens and MCP clients, `BREAKGLASS_REQUEST`)
  is defence in depth — OWNER and ADMIN hold all of them today — omitted from GET / 403 in DELETE
  when absent; tested by a mocked permission lookup with paired allow cells.
  The break-glass kind additionally requires an OWNER actor (the single route's "requester or
  OWNER" rule; an ADMIN actor containing a MEMBER who still holds a grant from before a demotion is
  refused 403 for that kind).
- R7: the dialog lists linked accounts and footholds with unchecked checkboxes, states that unlinking
  may stop an SSO member's sign-in and does not stop an email-linking provider (Google with allowed
  domains) from re-linking an account that asserts the member's email, and states the scope (en/ja).

## Technical approach

- New sibling module `src/lib/tenant/member-containment.ts` (listing + writes), called from
  `revokeMemberPasskeys` inside its transaction and from the GET route. NOT in
  `revokeUserAuthArtifactsInTx` (its member set, pinned by
  `user-auth-artifacts.member-set.test.ts`, excludes these by design).
- Reads/writes under the bypass: GET's `TENANT_MEMBER_PASSKEY_LIST` grant gains the models it reads
  (`account`, `scimToken`, `serviceAccount`, `serviceAccountToken`, `mcpClient`,
  `personalLogAccessGrant`, `emergencyAccessGrant`); DELETE's `TENANT_MEMBER_PASSKEY_REVOKE` gains the
  models it writes (same list plus `mcpAccessToken`/`mcpRefreshToken`, already present). Every query
  on a tenant-owned kind carries `tenantId = actor tenant` explicitly; `account` and
  `emergencyAccessGrant` match on the user (they carry a `tenantId` that is the tenant at creation,
  moved only by the bootstrap migration) and get a SYSTEM-actor audit row in each other tenant they
  were filed under. The module receives `tx` and makes no `withBypassRls` call, so it is NOT added to
  the `check-bypass-rls.mjs` allowlist (a stale entry fails the gate).
- Schema: `ServiceAccountToken.createdById String? @db.Uuid` (FK users, `ON DELETE SET NULL`), set by
  both mint paths (`POST .../service-accounts/[id]/tokens` → the session user; JIT approval → the
  approver). Migration is additive and backfills JIT tokens from
  `access_requests.approved_by_id` / `granted_token_id`; other existing rows stay NULL. Both tables
  are under FORCE RLS and the RDS migrate role is NOBYPASSRLS, so the backfill runs in a `DO` block
  that sets the bypass GUCs transaction-locally (`app.bypass_rls`, `app.bypass_tables =
  'service_account_tokens,access_requests'`, purpose) and restores them, as
  `20261102000000_share_creator_admitted` does; an integration cell runs that block as a NOBYPASSRLS
  role and asserts rows updated (red without the GUCs). The FK makes
  the model user-bound for the schema-derived gates: `user-auth-artifacts.member-set.test.ts`
  (`NOT_AUTH_ARTIFACTS`: a tenant credential, revoked by containment, not by session invalidation),
  `tenant-context.stranded-models.test.ts` (`NOT_STRANDED`), `bootstrap-migration-set.ts`
  (`TENANT_OWNED_LEFT`: the composite FK pins it to its service account's tenant).

## Contracts

### C1 — Stale comment (R1)
Rewrite the "Not modelled" paragraph above `resolveOAuthSignInSubject`.

### C2 — Revoke-all for zero passkeys (R2)
Zero passkeys no longer 404 for `scope: {all:true}`. Post-commit email and notification: a variant
for zero passkeys that says only what happened ("A tenant administrator ended all your sessions"),
and the existing passkey wording when count > 0; the "register a new passkey" line is kept only
when passkeys were removed. The notification needs a new message key (the existing body is static).
en/ja, pinned by `passkey-revoked-by-admin.test.ts` and the notification tests.

### C3 — Listing (R3)
Live = not revoked/inactive, not expired (`expiresAt` null or > now where the column exists).
Per kind: SCIM tokens `createdById = target`; service accounts `createdById = target`; service-
account tokens `createdById = target` (any service account of the tenant); MCP clients
`createdById = target`; break-glass grants `requesterId = target`, not revoked, `expiresAt > now`
(future `effectiveAt` included); emergency-access grants `ownerId = target`, status not
`REVOKED`/`REJECTED` (shows `hasEscrow` = `encryptedSecretKey` present and grantee email).
Accounts: `userId = target`, `linkedInTenant = (tenantId = actor tenant)`.

### C4 — Containment writes (R4, R5)
After the passkey/session revocation in the same transaction, CAS writes per kind (match predicate
of C3 plus "still live"):
- accounts: `deleteMany`; SYSTEM-actor audit row in each other tenant whose `tenantId` an unlinked
  account carried (mirrors the passkey `otherTenants` loop).
- SCIM tokens: `revokedAt` → `SCIM_TOKEN_REVOKE` per token.
- service accounts: `isActive = false` AND revoke their live tokens (`revokedAt`) — deliberately
  stronger than PUT `isActive:false`, so a later reactivation does not revive tokens →
  `SERVICE_ACCOUNT_UPDATE {isActive:false, tokensRevoked}`.
- service-account tokens: `revokedAt` → `SERVICE_ACCOUNT_TOKEN_REVOKE` per token.
- MCP clients: `isActive = false` and revoke their access/refresh tokens →
  `MCP_CLIENT_UPDATE {isActive:false, tokensRevoked}`.
- break-glass grants: `revokedAt` → `PERSONAL_LOG_ACCESS_REVOKE` per grant. Reachability: only ADMIN/
  OWNER requesters hold them and `canRevokeMemberPasskey` lets only an OWNER contain an ADMIN/OWNER,
  and the kind requires an OWNER actor (R6) — the single route's "requester or OWNER" rule.
- emergency-access grants: through `transition()` (`src/lib/emergency-access/emergency-access-state.ts`,
  the single writer the state-mutation gate allows) with `where: {id, ownerId: target}`,
  `to: REVOKED`, `actor: OWNER`, clearing what the owner route's permanent revoke clears
  (`encryptedSecretKey`, `secretKeyIv`, `secretKeyAuthTag`, `ownerEphemeralPublicKey`, `hkdfSalt`)
  and setting `revokedAt` → `EMERGENCY_ACCESS_REVOKE` registered in a TENANT action group (ADMIN) so
  the tenant log can filter it → `EMERGENCY_ACCESS_REVOKE` per grant, TENANT scope with the admin
  as actor in the actor's tenant, SYSTEM-actor row in another tenant the grant was filed under. The
  grantee is NOT emailed (the grantee may be the attacker). Revoking an ACTIVATED grant stops further
  vault reads but cannot undo a key already unwrapped; the dialog says so.
- Write order (pinned): accounts, SCIM tokens, service accounts, service-account tokens, MCP clients,
  break-glass grants, emergency-access grants last.
- Other tenants: the existing passkey `otherTenants` loop writes one SYSTEM-actor
  `TENANT_MEMBER_PASSKEY_REVOKE_ALL` row per other tenant; unlinked accounts and revoked
  emergency-access grants filed under such a tenant are counted into that same row's metadata (a
  tenant reached only through them gets one row too) — never two rows per tenant.
- `TENANT_MEMBER_PASSKEY_REVOKE_ALL` metadata gains per-kind counts and unlinked-account ids bounded
  like credential ids (first N, then an omitted count) so it stays under `METADATA_MAX_BYTES`.
- Response: today's `{ ok, sessionsRevoked, cacheTombstoneFailures }` unchanged; plus
  `contained: { … counts }` only when a body asked for containment.
- Control class: enforceable boundary (client ids are only a selection; the server re-derives
  ownership). Adjudication: the `where` predicates.

### C5 — UI (R7)
`src/components/settings/security/tenant-member-passkeys-dialog.tsx` (mounted from
`src/components/settings/account/tenant-members-card.tsx`): sections with checkboxes, revoke-all
enabled with zero passkeys, a note to contain before deactivating at the IdP, confirm text listing
the chosen items,
warnings; nothing ticked posts no body. `revokeAllPasskeysDescription` en/ja rewritten.

### C6 — Docs
`docs/operations/audit-log-reference.md` (REVOKE_ALL metadata; SA/MCP update metadata),
the email/notification copy, the scope contract below in the admin docs if one documents revoke-all.

## Forbidden patterns
- pattern: `scimToken|personalLogAccessGrant|serviceAccount|mcpClient|emergencyAccessGrant` inside
  `revokeUserAuthArtifactsInTx` — reason: keeps the user-bound member set (gate:
  `user-auth-artifacts.member-set.test.ts`).
- pattern: `providerAccountId` or `access_token`/`refresh_token` in the GET response — reason: not
  needed to choose an unlink; identifying / secret.

## Acceptance criteria (integration, real DB, `tenant-member-passkey-revoke.integration.test.ts`)
1. SSO-only member (oidc session, extension token, no passkeys): revoke-all → 200, session deleted,
   token revoked, audit `passkeys: 0`. A deactivated member (deactivated here, active and owned in
   another tenant): GET and DELETE refused 404, their passkeys/accounts/grants unchanged.
2. GET (one request): `linkedAccounts` deep-equals the target's accounts incl. one under another
   tenant (`linkedInTenant: false`); raw JSON contains neither the seeded `provider_account_id` nor
   token values; per kind the listed ids equal exactly the target's live rows — a bystander's
   same-tenant row, the target's row in another tenant (tenant-owned kinds), revoked/inactive/expired
   rows are absent; a future-effective break-glass grant is present.
3. DELETE with a body, per kind (`it.each`), one request naming: a target-owned live id (revoked —
   positive control), a bystander's same-tenant id (row byte-unchanged), the target's row in another
   tenant (unchanged), an already-revoked id (`revoked_at` value unchanged), for SCIM a token with
   `created_by_id` NULL (unchanged); exact counts; one audit row per revoked id, none for skipped.
   Effects through production validators: service-account token refused after its service account
   is contained; MCP access token `invalid_token`.
4. Atomicity: via `ctx.su`, `ALTER TABLE emergency_access_grants ADD CONSTRAINT … CHECK
   (id <> '<seeded row id>') NOT VALID` (no function, so the `check-bypass-rls` function rule is not
   touched; NOT VALID skips existing rows; the UPDATE of that row fails); response 5xx; passkey,
   session, tokens, credentials, accounts unchanged; no audit outbox rows for any of them; no
   notification/email; constraint dropped in `finally`.
5. Break-glass: an ADMIN actor's request for that kind is refused 403, the grant unchanged; an
   OWNER actor revokes it. Emergency access: a not-escrowed and an ACTIVATED grant revoked; the
   grantee's request and vault read are refused; a grant filed under another tenant gets the SYSTEM
   audit row there; no grantee email. JIT approval mint sets `created_by_id` to the approver.
6. Existing revoke-all cells unchanged with no body; the per-credential route's response unchanged.
Unit/route: body schema (absent/empty/`{}` → no containment; 101 ids, non-uuid, unknown key → 400);
per-kind 403 with paired allow (mocked lookup); validation before step-up; the inverted 404 cell;
mint paths set `createdById`. Dialog: zero-passkey button; deactivated member shows no revoke-all; checkboxes unchecked by
default; nothing ticked posts no body; ticking posts exactly the chosen ids; warnings. Test helpers:
`deleteTestData` deletes `scim_tokens`, `personal_log_access_grants` (RESTRICT FKs) before users.
Red-proofs: per kind drop the creator predicate → only that kind's cell 3 row red; drop `tenantId` →
the other-tenant row red; move the writes after commit → cell 4 red.

## Considerations & constraints
- Unlinking does not stop an email-linking provider (Google with allowed domains) from re-linking an
  IdP account that asserts the member's email; that is contained at the IdP. Jackson providers never
  link by email, so their unlink holds.
- Unlinking an SSO member's only account can stop their sign-in; opt-in and warned.
- Deactivating a service account or MCP client stops integrations; opt-in.
- `Account` has no link time; the list cannot say which links are recent.
- Service-account tokens minted directly before this change have no creator (NULL) and are not
  listed; their `SERVICE_ACCOUNT_TOKEN_CREATE` audit rows identify them (JIT tokens are backfilled).
- The GET lists emergency-access grantee emails to tenant admins with `MEMBER_MANAGE`: third-party
  personal data, shown so the admin can judge an unknown contact.
- Containment applies to active members only; deactivate at the IdP after containing.

### Scope contract
- SC1: personal share links and sends the member created (`PasswordShare.createdById`), team
  invitations they issued, admin vault resets they initiated/approved, role or policy changes,
  webhooks, directory-sync configs, audit delivery targets — not contained here; follow-up issue
  filed with the audit filters that find each.
- SC2: changes a session makes to rows other admins created (e.g. an MCP client's redirect URIs) —
  not attributable to the member; follow-up issue.

## User operation scenarios
1. An admin's session is stolen; the OWNER opens the passkey dialog before the IdP deactivates the
   admin, sees a
   linked Google account, a SCIM token and a service-account token the member minted yesterday on
   the production service account, and an emergency-access grant to an unknown address; ticks all,
   revokes.
2. An SSO-only member's session is stolen: no passkeys; the OWNER still revokes all.

## Go/No-Go Gate
| ID | Subject | Status |
|----|---------|--------|
| C1 | Stale link comment | locked |
| C2 | Revoke-all for zero passkeys (active members only); copy | locked |
| C3 | Listing accounts and footholds | locked |
| C4 | Containment writes in the revoke transaction; SA token creator column | locked |
| C5 | Dialog | locked |
| C6 | Docs | locked |
