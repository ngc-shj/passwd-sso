# Plan: departed-member-share-links (v5)

Branch: `fix/departed-member-share-links`. Issue `#990` (SC3 of
`team-tenant-departure-plan.md`). Review record: `departed-member-share-links-review.md`.

## Project context

- Type: web app (Next.js 16 + Prisma 7 + PostgreSQL 16, RLS with FORCE).
- Test infrastructure: unit + real-DB integration + E2E + CI/CD.
- Verification environment constraints: dev and CI migrate as a superuser, RDS as a
  NOSUPERUSER NOBYPASSRLS master. Two consequences, both probed on the dev DB (C1):
  a non-superuser cannot create a function whose definition `SET`s a placeholder GUC
  (`app.*`), and FORCE RLS binds anything the master owns. C1 is created and runs
  without either privilege; A10b applies its migration as a non-superuser.

## Objective

A share link for a TEAM entry stops serving once its creator no longer holds the
membership of that entry's team they held when they created it, or the entry is
trashed or gone — by any path (tenant departure, team member removal, SCIM group
removal, team or entry deletion, trashing). Refusal stops further retrieval only; a
recipient who already opened the link holds the data, and the remedy for that is
rotating the credential (manual-test plan says so).

## Design

Decide at serve time with one SQL function; every serve path calls it beside its
revoked check (a refusal answers exactly like a revoked link) and again inside its
conditional view-count UPDATEs (atomic with the serve). Covers every membership-ending
path, present and future, and a share inserted after its creator lost the membership.

Rejected: writing `revoked_at` at each membership-ending site (team/entry deletion
orphan the share first; create-vs-depart race; one hook per ender).

Revival: a link serves again when the creator's SAME membership row is active again —
`returnToTenant`, members POST reactivation, SCIM group re-add, and invitation accept
all reactivate the existing row (keeping `created_at`); restoring the entry from the
trash likewise. A membership deleted and re-created (team member DELETE, SCIM user
DELETE, then a new invitation) does not revive: the row must predate the share. The
same admin intent therefore revives or not depending on whether the removal was soft
(SCIM group removal) or hard (DELETE) — accepted; links expire within 30 days, and
rotation is the remedy either way.

## Contracts

### C1 Admission function

Migration creates `public.share_creator_admitted(p_share_id uuid) RETURNS boolean`:

- `LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = public, pg_temp`. The
  body saves the caller's `app.bypass_rls` / `app.bypass_tables` / `app.bypass_purpose`,
  and inside an inner `BEGIN … EXCEPTION WHEN OTHERS THEN RAISE` block sets them with
  `set_config(…, true)` to `on` / `password_shares,team_password_entries,team_members`
  / `share_admission` and runs the query into a variable; after the block it restores
  each with `set_config(name, COALESCE(saved, ''), true)` and has its single `RETURN`
  — no `RETURN` inside the block, the handler only re-raises. Placement follows
  `tenant_claim_events_purge_for_tenant` (`20260731100000_add_tenant_claim_events`).
  The restore on the normal exit is the control; the subtransaction is defence in
  depth (a caller can only survive an error by rolling back an enclosing
  subtransaction, which undoes the settings anyway — unobservable, not red-proved).
  A never-set setting reads back as `''` afterwards; every reader treats `''` as unset
  (`COALESCE(…,'') = 'on'` policies, `rls_bypass_admits`, `readBypassState` callers).
  C1 never reads or writes `app.tenant_id`. The result is the same under a public
  bypass context, a tenant context or none, whoever owns the function; no caller's
  bypass grant widens; no `rls_bypass_not_granted` report fires; not a SECURITY DEFINER.
- Probes (dev DB, rolled back): (1) a definition carrying `SET app.bypass_rls = 'on'`,
  created by a NOSUPERUSER role, is refused (`permission denied to set parameter
  "app.bypass_rls"`) — hence the body form; (2) the body form, created by a NOSUPERUSER
  NOBYPASSRLS role and called as `passwd_app`, read all 108 rows of the three tables
  (superuser count 108; `passwd_app` direct read 0) with no context and under the
  `password_shares,share_access_logs` bypass, and left the caller's settings as they
  were in both.
- `share_admission` is recorded beside `BYPASS_PURPOSE` in
  `src/lib/tenant-rls-purpose.ts` (a database-side purpose, not a TS grant).
- `scripts/rls-cross-tenant-verify.sql` gains `[E-RLS-BYPASS-ROUTINE]` beside
  `[E-RLS-SECDEF]`, over every routine (functions and procedures) outside
  `pg_catalog` / `information_schema`: one whose `prosrc` matches
  `set_config\s*\(\s*'app\.bypass_` or `\mSET\s+((LOCAL|SESSION)\s+)?app\.bypass_`
  (case-insensitive), or whose `proconfig` has an `app.bypass_%` element, must be on
  an allowlist compared as `oid <> 'public.share_creator_admitted(uuid)'::regprocedure`
  (a cast that errors if the function is missing — never `to_regprocedure` in a
  `NOT IN`, which turns a typo into a silent pass), whose body must also contain its exact
  table list. Reading the settings (`rls_bypass_admits`) does not match; the
  claim-event purge sets `app.allow_claim_event_purge` and does not match. A review
  tripwire for accidents, not a boundary; known bypasses: dynamic names (`EXECUTE`,
  variables), a double-quoted setting name, `E''` / dollar-quoted literals, and
  string concatenation.
- Result (`COALESCE(…, false)`; false for an unknown id): a share is a team share when
  `team_password_entry_id IS NOT NULL OR master_key_version = 0`; anything else is
  admitted. A team share is admitted iff its entry exists and is not trashed
  (`deleted_at IS NULL`) and the creator has an active membership of the entry's team
  (`deactivated_at IS NULL`) whose `created_at <= share.created_at`.
- `REVOKE ALL … FROM PUBLIC`; `GRANT EXECUTE` to `passwd_app` in the migration,
  `scripts/bootstrap-rds-roles.mjs` (`ROUTINE_EXECUTE`), the CI role bootstrap
  (`.github/workflows/ci-integration.yml`), and `scripts/checks/db-grants-manifest.json`.
- Single spelling of the rule. TypeScript calls it through
  `src/lib/share/share-admission.ts`: `isShareCreatorAdmitted(tx, shareId): Promise<boolean>`
  (`=== true` on the row, so a missing or NULL result refuses) and
  `creatorAdmittedByShareId(tx, ids): Promise<Map<string, boolean>>` for lists.
- Role equivalence: creation needs `PASSWORD_READ`, held by every team role; a future
  role without it must update this function.
- Control class: enforceable boundary for further retrieval; adjudication authority:
  PostgreSQL evaluating the function in the serving transaction. Fail-closed: a missing
  function (42883) is a 500, not an admission.

### C2 Team share is schema-defined

A separate migration (so C1's applies as a whole in A10b): `CHECK (team_password_entry_id IS NULL OR master_key_version = 0)
NOT VALID` — new team-entry shares cannot be stored under the server key. C1's team
test does not rely on it (it also treats any row with a team entry as a team share).

### C3 Every serve decision applies C1

Member set: functions reading `passwordShare` under the `SHARE_LINK_PUBLIC_ACCESS` /
`SHARE_LINK_VERIFY_ACCESS` grants (`grep -rln "SHARE_LINK_PUBLIC_ACCESS\|SHARE_LINK_VERIFY_ACCESS" src`
minus the definition). No extension, iOS, CLI or Send-viewer endpoint serves shares.

| Site | Pre-check (answers as revoked) | UPDATEs calling C1 |
|---|---|---|
| `src/app/s/[token]/page.tsx` | `ShareError reason="revoked"`, before the password-protected branch | 2 |
| `src/app/api/share-links/verify-access/route.ts` | `notFound()`, in its own bypass transaction after the revoked check and before password verification; no audit row | 0 (content re-checks) |
| `src/app/api/share-links/[id]/content/route.ts` | `notFound()` | 2 |
| `src/app/s/[token]/download/route.ts` | the revoked answer (410) | 2 |

An UPDATE that then matches no row keeps its existing answer (state changed between
the two statements). Download and the FILE arms serve personal Sends only; they apply
C1 anyway so the member set has no exceptions (their refusal arms are gate-pinned, not
data-reachable). Timing: a refused link costs one more query than a revoked one —
accepted (it reveals at most that the link was not revoked by its creator).
`share-admission.ts` is registered in `scripts/checks/raw-sql-usage.txt`; the existing
entries' purposes mention the admission call.

### C4 Team-context lists show the state

`GET /api/share-links` and `GET /api/share-links/mine` add `creatorAdmitted` per item
(via `creatorAdmittedByShareId`; no query for an empty page). `isActive` keeps its
meaning (time / revocation / views); the `status=active` filter still includes a dead
link (documented). Audiences: `/mine?team=` shows other members' links to roles above
VIEWER; `GET /api/share-links` lists the caller's own links, where a creator sees a
dead link after re-admission on a new membership row (A4). A pure, dependency-free
`shareLinkStatus({ isActive, revokedAt, expiresAt, maxViews, viewCount, creatorAdmitted })`
in `src/lib/share/share-link-status.ts`, used by
`src/app/[locale]/dashboard/share-links/page.tsx` (badge and icon) and
`src/components/share/share-dialog.tsx`, returns `creatorNotInTeam` first when
`creatorAdmitted === false`, then the existing active / revoked / maxViewsReached /
expired. Revoke stays available on `isActive` (revoking a dead link is harmless). String in
`messages/{en,ja}/Share.json`: "Unavailable: creator is no longer in the team" /
"利用不可：作成者がチームに所属していません".

### C5 CI gate

`scripts/checks/check-share-serve-admission.mjs` (ts-morph, scan root parameterised,
binding-aware):
- every tagged `$executeRaw` / `$queryRaw` whose literal text names `password_shares`
  and `view_count` contains `share_creator_admitted(`;
- every reference to `SHARE_LINK_PUBLIC_ACCESS` / `SHARE_LINK_VERIFY_ACCESS` (resolved
  through imports and aliases) is the grant argument of a `withBypassRls` call, and the
  top-level function enclosing that call contains (at any depth, including nested
  callbacks and a second bypass transaction) a call of the resolved
  `isShareCreatorAdmitted`; any other reference fails, as does the call sitting only in
  an unrelated sibling function;
- pinned per-file counts; a missing target fails; exit status is the verdict.
Self-test with fixtures for each rule (including a passing fixture, an aliased grant,
a grant in a variable, a second UPDATE without the call, an import-only file).
`Static:` step in `scripts/pre-pr.sh`. Ordering (pre-check before the protected branch
and the password check) is pinned by integration cells, not the gate.

## Forbidden patterns

- pattern: `deactivated_at IS NULL` in `src/app/s` or `src/app/api/share-links` —
  reason: the rule lives in C1.
- pattern: `revokedAt: new Date()` in `team-departure.ts`, `scim-*-service.ts`,
  `members/[memberId]/route.ts` — reason: one mechanism.

## Acceptance criteria

Team-share cells run for an unprotected and a protected share, start from a positive
control with the expected effect per site (page unprotected: renders, `view_count` +1;
page protected: gate renders; verify-access: token issued; content: data, +1), and
assert a refusal as the revoked answer, effects absent (`view_count`, access log,
token, audit), `revoked_at` still NULL.

- A1 Tenant departure (SCIM `active=false`) → refused at page, verify-access, content.
- A2 Refused after SCIM DELETE, team member DELETE, SCIM group removal, team deletion,
  entry trashed, entry hard-deleted. verify-access with a wrong password on a dead
  link → 404, no `SHARE_ACCESS_VERIFY_FAILED`.
- A3 Serves again after tenant return, SCIM group removal → invitation accept, and
  restore from trash.
- A4 Team member DELETE then re-invite → refused (share `created_at` backdated so the
  boundary is not the clock).
- A5 Removed from team X, active in Y → X refused, Y serves; another member active,
  creator not → refused.
- A6 Personal entry shares and Sends (TEXT page, FILE download) serve regardless.
- A7 Share inserted after its creator lost the team membership (team member DELETE,
  `POST /api/share-links` with a stale permission check) → refused; positive twin
  serves. Tenant-departure variant: share row seeded after the departure.
- A8 `/mine?team=` as an ADMIN/MEMBER reports `creatorAdmitted:false` for another
  member's dead link (a VIEWER does not list it); `GET /api/share-links` as the creator
  after A4 reports it false; `shareLinkStatus` unit cells cover every arm and the
  precedence; the dialog renders the string. The dashboard page's wiring is covered by
  `shareLinkStatus` only (no page test exists).
- A9 C2: inserting a team-entry share with version 1 through the su pg client fails
  with SQLSTATE 23514 and `err.constraint` naming the constraint; a version-0 team
  share and a version-1 personal share insert.
- A10 C1 matrix, one `ctx.su.prisma.$transaction` per calling context (a `createPool`
  connection, so the setup's notice sink sees every `rls_bypass_not_granted` report),
  each always rolled back by throwing a sentinel out of the callback; seeding and the
  C2 drop happen as su before the role switch, switched to
  `passwd_app` with `SET LOCAL ROLE` (asserting `current_user` first), in three calling
  contexts established with the production helpers — none; `setTenantGucs`;
  `setBypassGucs(SHARE_LINK_PUBLIC_ACCESS)`: membership `created_at` at share −1s /
  equal / +1s (admit, admit, refuse); `deleted_at`; `deactivated_at`; other user; other
  team; entry NULL with version 0; legacy row (team entry, version 1, inserted after
  dropping C2 in the same transaction) refused when the creator left; unknown id →
  false. After each call, in every result arm, `COALESCE(current_setting('app.bypass_*',
  true), '')` and `app.tenant_id` equal their values before it. No report reaches the
  sink unclaimed; a positive control on the same connection, as `passwd_app` under
  `setBypassGucs` with a grant excluding the table it reads, makes one deliberate
  out-of-grant read under `expectBypassNotices`.
- A10b In a rolled-back su transaction: drop the existing function, create a
  NOSUPERUSER NOBYPASSRLS role with CREATE on `public`, `SET LOCAL ROLE` to it, apply
  C1's migration file read at run time with its `BEGIN;`/`COMMIT;` sliced off after the
  migration-transaction gate's `analyze()` asserts the wrapper (as `migrationBody()`
  in `retire-dcr-cleanup-worker.integration.test.ts` does), then assert the function's owner is that role, `RESET ROLE`, and call it once as
  `passwd_app`. C1's migration file starts with `BEGIN;` (no leading comment) so the
  slice applies.
- A12 With `isShareCreatorAdmitted` forced true (hoisted toggle; the mock spreads the
  real module), a dead team link is still not served by the page (unprotected) and
  content, for an ENTRY_SHARE and for a team-entry share seeded with
  `share_type = FILE`, `master_key_version = 0` through the su client (the arms split
  on `shareType`, so this reaches both UPDATEs per site): page →
  `ShareError reason="maxViews"`, content → `SHARE_GONE`; `view_count` unchanged, no
  access log, no data. A live twin under the same toggle serves.
- A11 Gate self-test fixtures each fail; the passing fixture passes.

## Testing strategy

- Real-DB integration `src/__tests__/db-integration/share-departure.integration.test.ts`
  for A1-A12 through the real handlers and `await SharePage({ params })` (`next/headers`
  and rate limiters mocked; the `.ts` test asserts on the returned element —
  `el.type === ShareError && el.props.reason === "revoked"` — after a smoke import of
  the page under the node integration config); A7's stale permission and A12's forced
  pre-check are per-cell hoisted toggles passing through to the real modules by
  default; SCIM routes need `vi.stubEnv("AUTH_URL", …)`; all created
  tenants cleaned up; workers stopped first.
- Unit: routes mock `@/lib/share/share-admission` at the module boundary (the
  `fn(prisma)` mocks have no `$queryRaw`); refused cells assert `$executeRaw` not called,
  no token, no access log; list routes skip the query on an empty page. Files: both
  trees of the content, mine and GET tests, `verify-access/route.test.ts`,
  `src/__tests__/api/s/download.test.ts`, `share-dialog.test.tsx`, plus new
  `share-admission` and `shareLinkStatus` tests. `page.tsx` is integration-covered.
- Red-proofs on a scratch worktree: each pre-check removed or moved after the
  protected branch / password check; each reachable UPDATE call removed (A12); each
  C1 term removed (`deleted_at`, `deactivated_at`, `user_id` match, team join,
  `<=` → `<`, team-share test); C2 removed; helper NULL → true;
  `creatorAdmitted` wiring and status precedence (dialog + `shareLinkStatus`). The
  `set_config` calls are removed one at a time and observed in A10's base cells (the
  purpose setting is not observable — said so); the UPDATE calls are observed in A12.
- Manual test plan `departed-member-share-links-manual-test.md`.

## Considerations & constraints

- SC1 Personal-entry shares whose entry was deleted keep serving (not membership).
- SC2 Team admins cannot revoke another member's link — follow-up issue.
- SC3 Turning a team's sharing policy off later leaves links serving — follow-up issue.
- SC4 Master-key rotation with `revokeShares` also revokes version-0 team shares
  (fails closed) — follow-up note.
- The bootstrap-tenant migration (`src/auth.ts`) deletes a bootstrap `tenantMember`
  row without touching `team_members`; C1 has no tenant-row term on purpose.

## User operation scenarios

- Member shares a team password with a contractor, then the IdP deprovisions them →
  the link says it is no longer available; the admin rotates the password.
- Member removed from one team only → links for that team stop, others keep working.
- IdP deactivates and reactivates a member the same day → their links resume.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | Admission function (invoker, function-scoped bypass) | locked |
| C2 | Team-share CHECK | locked |
| C3 | Every serve decision applies C1 | locked |
| C4 | Team-context lists show the state | locked |
| C5 | CI gate | locked |
