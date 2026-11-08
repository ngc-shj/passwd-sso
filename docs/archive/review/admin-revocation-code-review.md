# Code Review: admin-revocation
Date: 2026-11-08
Review round: 1

Standalone Phase 3 review (no plan file) of #995 (team admins revoke another
member's share link) and #974 (tenant admins revoke a member's passkey) on
branch `fix/admin-revocation-and-bootstrap-migration`. #955 (bootstrap
migration for directory sync / SCIM) moved to its own PR: it needs a plan.

## Changes from Previous Round
Initial review. An external security review of the same branch (four findings,
E1–E4) arrived during the fixes and is folded in below.

## Functionality Findings
- F1 [Major] Passkeys registered under the member's previous tenant still sign
  them in here, but the admin could neither see nor revoke them.
- F2 [Major] Strict-above meant an OWNER whose only passkey is compromised had
  no recovery path.
- F3 [Minor] Concurrent revoke of one passkey → P2025 → 500; the dialog kept the
  stale row.
- F4 [Minor] Share revoke update lacked `revokedAt: null`: a concurrent double
  revoke overwrote the timestamp and audited twice.
- F5 [Minor] A team admin could revoke but not read another member's link's
  access log (superseded by E4).
- F6 [Minor] SHARE_REVOKE metadata undocumented.
- F7 [Minor] `invalidateUserSessions` called without `reason`.
- F8 [Minor] CLAUDE.md API table missing the two routes.

## Security Findings
- S1 [Minor] Team-admin share revoke skipped the team IP restriction (no `req`).
- S2 [Minor] Role-hierarchy check and delete in separate transactions.
- S3 [Minor] The member was not told; the cache flush was skipped when the
  session revoke threw.
- A1 [Adjacent] = F4.

## External security review (folded in)
- E1 [High] The credential is user-global but sessions/tokens were revoked only
  in the admin's tenant; the credential delete nulls `Session.authCredentialId`,
  so the passkey's own sign-ins elsewhere could not be picked out afterwards.
- E2 [High] The revocation ran after the credential delete committed and a
  failure was swallowed: 200, a "signed out" notification, and no retry (404).
- E3 [Medium] A team link's creator bypassed the team IP restriction.
- E4 [Medium] Extending access logs to team admins exposes viewers' IPs and user
  agents beyond the revoke requirement.

## Testing Findings
- T1 [Major] The DELETE's server step-up was untested (mocked to null).
- T2 [Major] Cache invalidation and the invalidation-failure path untested.
- T3 [Major] Dialog: no step-up denial or load-failure case.
- T4 [Minor] The self-refusal cell could not fail (hierarchy covered it).
- T5 [Minor] Audit `credentialId` unasserted.
- T6 [Minor] GET list tenant scoping untested.
- T7 [Minor] Unit trees lacked the admin path / creator no-metadata cases.
- T8 [Minor] Members card disabled rule for deactivated/peer members unasserted.

## Recurring Issue Check
Functionality: R3/R42 F1 (the passkey member set is user-global), F5; R19/R20 F3,
F4; docs F6, F8. Security: authz model sound (no oracle, RLS scoping, fields
exposed, every token model revoked, proxy CSRF/manifest), S1–S3 / A1.
Testing: RT1 T4; RT2 T1, T2, T6, T7; RT4 T5; RT5/RT8 T1, T3.

## Resolution Status
### F1 / E1 — user-global passkey, all-tenant revocation
- User decision: list and revoke all of the member's passkeys (marked
  `registeredInTenant: false` when registered elsewhere), through two
  bypass grants: `TENANT_MEMBER_PASSKEY_LIST` (tenantMember, webAuthnCredential)
  and `TENANT_MEMBER_PASSKEY_REVOKE` (adds user, auditOutbox and every
  user-bound token model). Each call reads the member active in the admin's
  tenant first.
- Revocation covers the member's sessions and tokens in every tenant
  (`tenantFilter: {}`), since a deleted credential's sign-ins cannot be told
  apart afterwards.

### E2 / S2 / S3 / F3 / F7 — one transaction
- `revokeUserAuthArtifactsInTx` extracted from `invalidateUserSessions`
  (behavior unchanged for its callers; the bearer-passkey gate manifest entry
  re-keyed to it). The DELETE runs in one transaction: re-read of both roles,
  credential `deleteMany` by count (404 on a concurrent revoke), revocation, and
  the audit row via `logAuditInTx`. A failure rolls everything back and errors:
  the passkey stays and the admin can retry; no notification. Cache tombstones
  run after commit; failures are logged and returned (`cacheTombstoneFailures`).
- The member gets an in-app SECURITY_ALERT notification and an email
  (`passkey-revoked-by-admin` template).

### F2 — OWNER on OWNER
- User decision: allowed for passkey revoke only (`canRevokeMemberPasskey`),
  with the notification above. Self stays refused (own settings, last-passkey
  rule). Card uses the same rule.

### F4 / A1 — share revoke CAS
- `updateMany({ ..., revokedAt: null })` and `logAuditInTx` in one tenant-RLS
  transaction; `count === 0` → ALREADY_REVOKED with no audit. The page treats
  ALREADY_REVOKED as revoked.

### S1 / E3 / E4 / F5 — share-link authorization
- `shareLinkManagerOf` (src/lib/share/share-link-manager.ts): creator, or for a
  team link a PASSWORD_DELETE holder via `requireTeamPermission(..., req)`; a
  team link's creator is held to `withTeamIpRestriction` (no membership check,
  so a departed creator can still revoke their own link).
- Access logs: creator only (E4 supersedes F5); `/mine` returns
  `canViewAccessLogs` and the page hides the toggle otherwise.
- `req` now also passed on share creation and `/mine` (same IP-restriction gap).

### F6 / F8 — docs
- SHARE_REVOKE and TENANT_MEMBER_PASSKEY_REVOKE rows in the audit reference;
  CLAUDE.md API table rows (user-approved).

### T1–T8 — tests
- Integration (`tenant-member-passkey-revoke`): step-up refusal keeps the
  passkey and sessions; OWNER→OWNER allowed, ADMIN→ADMIN / ADMIN→OWNER /
  MEMBER / self refused (self now distinguishable); a previous-tenant passkey
  listed and revocable; a foreign-tenant member 404 on list and revoke; audit
  `credentialId` / `registeredInTenant`; all-tenant revocation; notification.
- Unit (`passkeys/[credentialId]/route.test.ts`): order delete → revoke → audit
  in the transaction, cache after commit; a failed revocation rolls back with no
  cache eviction or notification; cache failure reported; step-up first; role
  re-read; concurrent 404.
- `share-link-manager.test.ts`: creator IP check, admin `req`, refusals.
- Share unit trees: CAS, ALREADY_REVOKED with no audit, creator no metadata.
- Integration (`share-departure`): concurrent creator+admin revoke → 200/409 and
  one audit row; access log creator-only.
- Dialog: step-up dialog, load failure, other-tenant marker, reload on refusal.
- Members card: disabled rule for OWNER↔OWNER, ADMIN↔ADMIN, deactivated.

### Gate note
- `check-rls-nesting` read the JSDoc `{@link invalidateUserSessions}` on the
  extracted helper as a call (a false nesting report); the reference is plain
  text instead.

# Round 2

## Changes from Previous Round
Round 1 fixes reviewed (commit 618516ebb added the single-use code tables to the
revocation; ddf166d0b the tests). Two further external reviews (X1–X5) were
folded in; this section records them and their resolution.

## Findings
- R2-1 [Major] `revokeUserAuthArtifactsInTx` did not consume pending
  ExtensionBridgeCode / MobileBridgeCode / McpAuthorizationCode rows: each
  exchanges for a fresh token with no session. Fixed in 618516ebb; the revoked
  model set is now derived from the schema (`user-auth-artifacts.member-set.test.ts`:
  every user-bound model with `revokedAt` / `usedAt` is revoked or exempted with a
  reason).
- X1 [High] A mint racing a revocation survives it: a code consumed, then the
  revocation commits, then the token is issued (or a session-authenticated mint
  whose session was deleted meanwhile).
- X2 [Medium] A session revoked while its cache tombstone failed stays valid at
  the proxy for up to the cache TTL.
- X3 [Medium] A compromised session can register a second passkey before the
  admin revokes the first; revoking one leaves the other to sign back in with.
- X4 [Blocker] Unit tests failing in the mid-change tree (missing `$executeRaw`
  mocks); no real-DB race test.
- X5 [Minor] Two unused imports.

## Resolution Status
### X1 — serialize revocation against every mint
- User decision: fix in this PR. `user-auth-serialization.ts`: the revocation
  and every mint of a user credential take one transaction-scoped advisory lock
  keyed by the user id (the key the per-user caps already used, so it is one
  lock and cannot deadlock against them), and the mint re-checks its proof in
  the locked transaction: the session row (`isSessionRowLive`), the token row
  (`isTokenRowLive` / the refresh CAS with `revokedAt: null`), the code CAS, or
  the passkey row for a passkey sign-in. A lost proof throws
  `UserAuthRevokedError`, mapped to 401 (or the flow's own refusal).
- Mints covered: every sign-in (session cap), extension bridge code / exchange /
  refresh, mobile authorize / token / refresh / autofill, API key, operator token
  (user lock before the per-tenant cap lock), vault delegation (also re-reads the
  MCP token), MCP consent code / exchange / refresh, passkey registration.
- Grants widened where the recheck reads a new model (`session` on the bridge
  code, mobile bridge code and MCP code grants; `webAuthnCredential` on session
  capping); delegation got its own `DELEGATION_SESSION_CREATE` grant rather than
  widening the shared lookup grant.

### X2 — the cache is not an authenticator
- Measured, not assumed: the Redis cache is read only by the proxy's
  `getSessionInfo`; `auth()` (database strategy) reads the session row on every
  call; every `api-session-required` route reads the session itself except three
  bearer-only routes; the /dashboard and /admin layouts call `auth()`. A stale
  entry therefore passes the proxy and is refused by the handler.
- User decision: pin that invariant instead of adding an auth generation.
  `check-session-passkey-readers.mjs` rule 4 fails an `api-session-required`
  route that reads no session (unless named in `BEARER_ONLY_ROUTES` with the
  token it authenticates) and a gated layout that reads none; self-test cells for
  each refusal. The admin dialog's "sign-ins may stay valid" warning was wrong
  and is removed (the response still reports `cacheTombstoneFailures`; Sentry
  still fires).

### X3 — revoke all passkeys
- User decision: add `DELETE /api/tenant/members/[userId]/passkeys`: every
  passkey of the member (any tenant), their sessions and tokens everywhere, one
  `TENANT_MEMBER_PASSKEY_REVOKE_ALL` audit row, in one transaction under the
  member's lock — so no passkey can be registered meanwhile, and no session that
  could register one survives. Shared with the single revoke in
  `src/lib/tenant/member-passkey-revoke.ts`. Dialog "Revoke all" button; ja/en
  notification and email wording per extent.

### X4 / X5 — tests
- Mocks updated; each changed mint has a "proof revoked while waiting → 401,
  nothing created" unit cell, with lock-before-recheck ordering asserted.
- `user-auth-serialization.integration.test.ts` (real DB): a revocation held
  open, a mint parked on it (observed via `pg_blocking_pids`), then commit —
  passkey sign-in, bridge-code exchange and MCP consent each issue nothing; each
  has a control (lock only, no revocation) that does issue. A source-mutation
  red proof of these cells was not run (the scratch-copy run was not permitted);
  the controls show the refusal is the revocation's, and the unit cells cover the
  recheck branches.
- `tenant-member-passkey-revoke.integration.test.ts`: revoke-all cell.
