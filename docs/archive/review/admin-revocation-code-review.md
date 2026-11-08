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

# Round 3

## Changes from Previous Round
Incremental review of 2b065ae45 (serialization, revoke-all, rule 4). Local LLM
seeds were unavailable (pre-screen timed out); all three experts did full
reviews of the commit.

## Functionality Findings
- R3-F1 [Major] check-count-then-create-lock knew only `advisoryXactLock(` /
  `pg_advisory_xact_lock`; three cap sites now lock through
  `lockUserAuthArtifacts`, so the static CI gate went red.
- R3-F2 [Major] The credential lock shared its key (the bare user id) with the
  vault-data lock key rotation holds for up to its 2-minute transaction; a
  revocation queued behind it would hit the 5 s transaction timeout, and SCIM
  deactivation / team removal carry on when revocation fails.
- R3-F3 [Minor] An iOS refresh overlapping the rotation it retries now got
  FAMILY_EXPIRED instead of the cached rotation.
- R3-F4 [Minor] An MCP refresh revoked while waiting was answered and audited as
  a concurrent rotation (family revoked, CONCURRENT_ROTATION reason).
- R3-F5 [Adjacent, Minor] Adapter sign-in does not re-check active membership
  under the lock.
- R3-F6 [Adjacent, Minor] Shared lifecycle bypass grants widened with `session`.

## Security Findings
- R3-S1 [Minor] The bootstrap→SSO tenant migration (src/auth.ts) revokes the
  user's tokens without the credential lock.
- R3-S2 [Minor] Unbounded `credentialIds` in the revoke-all audit row: past
  METADATA_MAX_BYTES the whole metadata is replaced, losing every count.
- R3-S3 [Minor] Rule 4: cookie-only helpers counted as readers; a client
  navigation renders a page without its layout; per-file granularity.
- R3-S4 [Adjacent, Minor] Revoke-all leaves non-token footholds (linked IdP
  accounts, admin-created SCIM / service-account tokens, grants).
- R3-S5 [Adjacent, Minor] Revoke-all reaches other tenants' passkeys with no
  audit row there.
- X2 independently confirmed: no path where a cached proxy decision alone
  grants anything.

## Testing Findings
- R3-T1 [Critical] iOS / AutoFill / iOS refresh rechecks had no deny cell.
- R3-T2 [Major] The lock on MCP code exchange, MCP refresh and extension refresh
  was unpinned.
- R3-T3 [Major] Passkey verify's UserAuthRevokedError mapping untested.
- R3-T4 [Major] No real-DB allow/deny pair for route-level session mints.
- R3-T5..T10 [Minor] integration holder cleanup; deny cells not asserting the
  advisory-lock wait; revoke-all route gaps; rule 4 member sets hand-kept;
  dialog revoke-all failure / step-up; integration CAS twin.

## Resolution Status
### R3-F1 — gate recognizes the credential lock
- `lockUserAuthArtifacts(` counts as a lock only with its import from
  `user-auth-serialization` (a same-named local function does not). Self-test:
  wrapper passes, wrapper removed fails, imposter fails.

### R3-F2 — namespaced credential lock key
- `userAuthLockKey(userId)` = `user-auth:<userId>`; every credential cap and
  mint and the revocation use it, so mint-vs-mint and mint-vs-revocation
  serialization are unchanged, while the vault-data lock (rotate-key,
  attachments, file sends, PRF) stays on the bare id. Integration cell: a
  revocation completes while the bare-id lock is held.

### R3-F3 / R3-F4
- iOS refresh: on UserAuthRevokedError the step-1 retry cache is consulted
  (same body, within the grace) before FAMILY_EXPIRED; cells for both.
- MCP refresh: a lost claim re-reads the row; revoked-not-rotated answers
  `revoked` with no family revocation; rotated stays `race_lost`.

### R3-F5 — Accepted
- **Anti-Deferral check**: acceptable risk.
- **Justification**: a session created for a member with no active membership
  is refused by the proxy (`auth-gate.ts` returns invalid when the tenant does
  not resolve) and every handler's tenant resolution fails. Requiring the
  membership in session creation would also refuse the documented
  `User.tenantId` fallback the adjudicator uses. Worst case: an unusable session
  row until expiry. Likelihood: low. Cost-to-fix: changing the sign-in
  adjudicator's contract, out of this PR's scope.

### R3-F6
- Narrow `EXTENSION_BRIDGE_CODE_ISSUE`, `MOBILE_BRIDGE_CODE_ISSUE`,
  `MCP_AUTH_CODE_ISSUE` grants for the issuing transactions; the lifecycle
  grants are back to their previous model lists.

### R3-S1
- The migration transaction takes the credential lock first; the lock module's
  header names it among the revokers.

### R3-S2
- At most 10 public ids, each cut to AUDIT_CREDENTIAL_ID_MAX_LENGTH, plus
  `credentialIdsOmitted`; a cell with 11 × 1023-byte ids keeps every count and
  stays under METADATA_MAX_BYTES.

### R3-S3 / R3-T8 — rule 4 tightened
- Rule 4 counts only DB readers (`auth`, `checkAuth`, `authOrToken`, the step-up
  readers). The gated page prefixes are read from the `if` guarding
  getSessionInfo in page-route.ts (fails closed when unreadable); each needs a
  reading layout, and every server-component segment file under them reads the
  session or imports only next / next-intl / @/i18n / @/components / react /
  lucide-react. Red cells: cookie-only route, layout reading none, missing
  layout, a new prefix without a layout, an unreadable guard, a data page; allow
  cells: the same page as a client component or reading the session.
- Accepted floors: per-file (not per-method) reading, imported components not
  followed, and the BEARER_ONLY reason-length branch (a constant map with no
  fixture hook) — each documented in the gate.

### R3-S4 — user decision: state the scope, track the rest
- The revoke-all confirmation states what it does not cover; issue `#1016`
  tracks account links and admin-created credentials.

### R3-S5 — user decision: audit in each affected tenant
- A revoked passkey registered under another tenant writes the same audit row
  there, with `revokedFromTenantId` (single and all). Unit and integration cells.

### R3-T1..T10
- T1: deny cells for issueIosToken (proof gone, lock first), issueAutofillToken
  (host token revoked), refreshIosToken (row revoked → FAMILY_EXPIRED; overlap →
  cached rotation; different body → FAMILY_EXPIRED); autofill route 401. The
  mobile token route's mock runs the route's real CAS; issueIosToken's own
  refusal is pinned against the real function.
- T2: lock key and lock-before-claim cells for MCP code exchange, MCP refresh and
  extension refresh.
- T3: passkey verify → 401 AUTHENTICATION_FAILED, no cookie, no AUTH_LOGIN.
- T4: integration pairs for `POST /api/api-keys` and
  `POST /api/tenant/operator-tokens` through the real handlers (held revocation
  → 401 and nothing created; lock-only control → created).
- T5/T6: the holder commits in `finally`; every parked mint is asserted to wait
  on `pg_advisory_xact_lock`. T7: revoke-all read order, 401 / permission
  cells, no-delete assertion. T9: dialog failure and step-up cells. T10: the
  integration CAS copy is labelled as a twin.
- Mutation red proof (scratch copy, unit level): removing each of the 11
  guarded clauses (iOS proof check, autofill recheck, MCP refresh lock, revoked
  vs rotated, overlap retry, passkey verify mapping, other-tenant audit, id
  bound, lock key namespace, extension refresh lock, MCP code lock) turns its
  test red. The integration cells were not mutation-run (that needs the
  database env in the copy).

# Round 4

## Changes from Previous Round
Incremental review of 3c93024ef. Functionality: all Round-3 fixes verified
(lock-key sweep: no inversion; grants narrowed back), five Minors. Security:
one Major on the new cross-tenant audit row. Testing: two Majors, six Minors.

## Findings
- R4-S1 [Major] (with R4-F1 [Minor]) The row written into another tenant
  spread the revoking request's base: tenant A's admin id (hydrated to name,
  email, avatar by the audit-log view), IP and user agent, the session/token
  counts across every tenant, and every revoked credential id — into a log
  tenant B's admins read and export; `registeredInTenant: false` was wrong there.
- R4-S2 [Minor] Rule 4: `@/components` imports not followed; segment set and
  guard extraction incomplete. R4-F3 [Minor]: re-exports / dynamic imports not
  checked; a non-literal guard operand silently dropped.
- R4-F2 [Minor] audit-log reference not updated. R4-F4 [Minor] stale lock
  comments. R4-F5 [Minor] iOS overlap fallback is best-effort, undocumented.
- R4-T1 [Major] The revoked-vs-rotated boundary was unpinned (the race-lost
  fixture re-read an unrotated row). R4-T2 [Major] The vault-lock cell would
  hang to the test timeout, leaking the holder. R4-T3..T8 [Minor] cookie-only
  layout cell; "no family revocation" unasserted; extension refresh lock key
  pinned by prefix only; other-tenant de-duplication unpinned; single-statement
  lock unpinned; imposter cell asserted exit code only.

## Resolution Status
### R4-S1 / R4-F1
- The other-tenant row is built on its own: actor SYSTEM (`SYSTEM_ACTOR_ID`,
  `actorType: SYSTEM`), no IP or user agent, metadata naming only that tenant's
  passkeys (`credentialId` + `registeredInTenant: true`, or the bounded
  `passkeys` / `credentialIds` / `credentialIdsOmitted`), `targetUserId` and
  `revokedFromTenantId` (the user decision of Round 3) — no counts. Unit cells
  pin the whole row; integration cell checks the drained payload.

### R4-S2 / R4-F3
- The guard must be exactly one getSessionInfo call under an `if` whose `||`
  operands are all literal `startsWith` calls, or the gate refuses to run.
  Segment files include `route` and `.js`/`.jsx`; re-exports and literal
  import()/require count as loads, an unreadable one fails. Cells for each.
- Accepted floor: `@/components` imports are not followed (verified: the only
  two server components there are data-free), documented in the gate header.

### R4-F2 / R4-F4 / R4-F5
- audit-log reference documents the id bound, `credentialIdsOmitted` and the
  per-tenant SYSTEM row; lock comments point at the credential lock and its
  separation from the vault-data lock; the iOS fallback is commented as
  best-effort (fails closed).

### R4-T1..T8
- Race-lost re-reads a rotated row; new cell: rotated and revoked → race_lost
  with family revocation. Vault-lock cell is bounded (BLOCK_WAIT_MS), fails with
  a named message if the revocation waits on the bare-id lock, and releases the
  holder in `finally`. Cookie-only layout cell; `mockRevokeFamily` asserted;
  lock key pinned to the user; three-tenant de-duplication cell (row count
  pinned); `$executeRaw` called once; imposter cell names the file.
- Mutation red proof (scratch copy): the rotated boundary, the SYSTEM actor,
  the per-tenant passkey filter and the per-tenant de-duplication each turn
  their cell red (the de-duplication cell first survived — keyed by tenant it
  collapsed duplicates — and now also pins the row count).

# Round 5

## Changes from Previous Round
Incremental review of ad3388a30. Security: R4-S1 closed (row, webhooks/SIEM
fan-out, audit-log view hydration, notification and email checked). No
production-code findings; gate and test findings only.

## Findings
- R5-F1 [Minor] Rule 4 did not require the getSessionInfo call to be in its
  `if`'s then-branch (an else-branch call would gate the complement).
- R5-S1 [Minor] Rule 4's segment set omitted the metadata routes and boundaries
  that render outside the layout (opengraph/twitter image, icon, apple-icon,
  sitemap, forbidden, unauthorized).
- R5-T1 [Major] The other-tenant row's "no IP / user agent" was asserted where
  the request carried none (unit base mock, header-less integration request).
- R5-T2 [Major] The new route / .js / .jsx segment coverage had no cell.
- R5-T3..T6 [Minor] literal import()/require branch unpinned; the "not inside
  an if" fatal lost its cell; the vault-lock cell did not await the released
  revocation; a variant built without `swap`.

## Resolution Status
- R5-F1: the call must be inside the guard's then-branch, or the gate refuses
  to run; else-branch and no-if cells.
- R5-S1: those file names are segment files; a metadata image route cell.
- R5-T1: the unit base mocks carry an IP and user agent and the originating row
  is asserted to keep them while the other-tenant row is null; the integration
  request sends a user agent, kept on the originating row, null on the other.
- R5-T2: route, .jsx and metadata-route FAIL cells with route / client allow
  sides. R5-T3: literal import() and require FAIL cells, an allowed import()
  and a type-only re-export PASS cell. R5-T4: no-if cell. R5-T5: the pending
  revocation is awaited in `finally`. R5-T6: `swap`.
- Mutation red proof (scratch copy): copying the request base into the
  other-tenant row, reverting the segment set, dropping the literal-import
  branch and dropping the then-branch check each turn their cells red.

# Round 6

Incremental review of 2c8405112 (gate and tests only). Functionality: no
findings (the then-branch check and widened segment set match no current file
wrongly; the prefixes still read /dashboard and /admin). Security: no findings;
no production code changed and no earlier refusal weakened (R43). Testing and
security converged on one Minor.

## Tightening-only skip — Round 6
Findings applied directly (no Round 7 review):
- R6-T1 [Minor] Only `opengraph-image` of the seven segment names added in
  Round 5, and no `.js` file, had a FAIL cell — scripts/__tests__/
  check-session-passkey-readers.test.mjs — the FAIL `it.each` now runs every
  segment name, each extension at least once, plus a `.js` client allow cell.
  Dropping `sitemap` from the gate's name set, or `.js` from its extensions,
  turns the suite red (scratch-copy mutation).
Justification: the finding is inside Round 5's fix range, test-only (an inline
addition of cells), and touches no security boundary in production code.

## Termination
All three experts returned no further findings beyond R6-T1, applied above.
Accepted floors and decisions recorded in earlier rounds stand: R3-F5
(membership re-check at sign-in), the rule-4 floors (`@/components` not
followed, per-file reading), and `#1016` (non-token footholds after revoke-all).
