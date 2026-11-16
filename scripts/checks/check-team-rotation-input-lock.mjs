#!/usr/bin/env node
/**
 * CI guard over the writes that decide who holds a team key
 * (docs/archive/review/team-tenant-departure-plan.md C8; background in
 * docs/archive/review/team-key-rotation-write-race-code-review.md).
 *
 * Team key rotation wraps the next key to the team's active members, read
 * under its team lock; a tenant departure ends the user's memberships of the
 * tenant's teams. Review found both decided by hand at each writer, so the
 * writer classes are derived here from the code:
 *
 * 1. MEMBER-SET WRITES take a rotation lock first. A Prisma call (any
 *    receiver) of `teamMemberKey.delete/deleteMany`, `teamMember.delete/
 *    deleteMany`, `teamMember.update/updateMany` whose `data` names
 *    `deactivatedAt`, `deactivatedByTenant` or `keyDistributed`, or an
 *    `upsert` whose `update` does, and a raw `DELETE FROM` / `UPDATE` of
 *    `team_members` / `team_member_keys`, must follow a call of LOCK_HELPERS
 *    in its function, or in every same-file caller of that function.
 *
 * 2. TENANT ACTIVE STATE moves only in team-departure.ts. A `tenantMember`
 *    update/updateMany/upsert-update naming `deactivatedAt`, or a raw write of
 *    `tenant_members` naming `deactivated_at`, fails. A create naming it (a row
 *    created deactivated) must follow the creation lock and be followed by
 *    `departCreatedMembership` in the same function. In team-departure.ts
 *    itself such a write is a `departureWriters` site: covered when it clears
 *    the column (raw `SET … deactivated_at = NULL`, Prisma `deactivatedAt:
 *    null`) or a call of `endTeamMemberships` follows it in the same function
 *    (a conditional call counts). In the other IMPLEMENTATIONS files it fails
 *    like anywhere else.
 *
 * 3. ADMISSIONS lock the users' tenant rows first. `teamMember.create/
 *    createMany/upsert`, a nested `members: { create }`, `teamInvitation.
 *    create/createMany`, and a `teamMember.update/updateMany` setting
 *    `deactivatedAt` must follow `lockTenantRows` (or a TENANT_LOCK_WRAPPERS
 *    call) in their function or every same-file caller.
 *
 * 4. LOCK ORDER. In one function, `lockTenantRows` / `lockTenantMemberCreation`
 *    is called at most once, not inside a loop, and not after a LOCK_HELPERS
 *    call; `departFromTenant` / `returnToTenant` called next to it pass
 *    `alreadyLocked: true` (a second tenant-row lock after a team lock closes a
 *    deadlock cycle with an admission holding that row).
 *
 * 5. Nothing calls the adapter's `deleteUser` (its cascade ends memberships
 *    without a team lock or a departure record).
 *
 * 6. `tenant_member_departures` is written only by `deactivateScimUser` and
 *    deleted by nothing (FK cascade aside): no Prisma write of
 *    `tenantMemberDeparture`, no raw write elsewhere, no raw DELETE.
 *
 *    Rules 2, 5 and 6, and the tenant-row delete class below, run for EVERY
 *    scanned file, ahead of the IMPLEMENTATIONS skip: team-departure.ts and the
 *    lock modules are held to them too. The delete class: `tenantMember.delete`
 *    / `deleteMany` and a raw tagged-template `DELETE FROM tenant_members` are
 *    `tenantRowDeletes` sites with no automatic cover (a deleted tenant row
 *    leaves team memberships behind unless the caller ends them); each needs an
 *    EXEMPTION. Pinned at two: the bootstrap migration in src/auth.ts, and
 *    `deactivateScimUser`.
 *
 * 7. SCIM ADMISSION MARKER (docs/archive/review/scim-team-admission-approval-plan.md
 *    C2/C4, Forbidden patterns). In scim-group-service.ts: every `teamMember`
 *    write payload (`data`, an `upsert`'s `create`/`update`, a nested
 *    `members: { create/createMany/connectOrCreate }`) must be readable as an
 *    object literal (a `createMany*` array element, or a `.map` whose arrow
 *    callback returns one in a parenthesised/concise body — a block body is
 *    refused); none may name `deactivatedAt: null`; every creating payload
 *    must name `scimApprovalPending: true` and a non-null `deactivatedAt`; no
 *    raw template in that file writes `team_members`. Repo-wide, OUTSIDE
 *    migrations and BEFORE the IMPLEMENTATIONS skip (so team-departure.ts and
 *    the lock modules are covered too): a `scimApprovalPending` property
 *    (identifier, quoted, or shorthand key) whose value is not the literal
 *    `true` is refused unless the file is the admission module
 *    (src/lib/team/scim-admission.ts); any string or template literal naming
 *    `scim_approval_pending` is refused everywhere (no code needs raw access to
 *    the column). The admission module's boundary (docs/archive/review/
 *    scim-bulk-approve-plan.md C1, V7): only the four admission routes (the
 *    single and the bulk approve / reject) import it — an import declaration,
 *    `export … from` (refused for the module outright), literal `import()` or
 *    literal `require()`, each specifier resolved to a path (`@/` → `src/`, a
 *    relative one against the importing file); those routes do not call
 *    `lockTenantRows`; and the routes and the module import from `@/lib/audit/*`
 *    only `extractRequestMeta` (routes) / `logAuditInTx` (module), both from
 *    `@/lib/audit/audit`.
 *
 *    KNOWN LIMIT (rule 7): a column name assembled from fragments at runtime
 *    is not seen; an `import()` / `require()` with a non-literal specifier is
 *    not followed.
 *
 * 8. RETIRED. The grant-recipient rule (departed-member-leaked-authority-
 *    deviation.md D8) is enforced by the database since migration
 *    20261117000000_departed_member_guard, which judges every spelling of a
 *    grant to a leftover membership (docs/archive/review/
 *    departed-member-db-invariants-plan.md Q6, C8). The number stays: other
 *    documents cite rules 9 and 10.
 *
 * 9. A TENANT-MEMBERSHIP END REVOKES IN ITS FUNCTION
 *    (docs/archive/review/session-revocation-failure-surfaces-plan.md C2/C8).
 *    Runs for every file BEFORE the IMPLEMENTATIONS skip: team-departure.ts
 *    holds two of its sites. A membership end is:
 *    - a `tenantMember.delete/deleteMany` (any receiver);
 *    - a raw template whose target is `tenant_members`, classified from
 *      lib/sql-scan.mjs tokens: a DELETE; an UPDATE, or an upsert's `ON
 *      CONFLICT DO UPDATE`, whose SET list assigns `deactivated_at` anything
 *      but the literal `NULL` or holds an assignment it cannot read (a row
 *      constructor, a `${…}` fragment); an INSERT, plain (read from the
 *      tokens here: sql-scan's WRITE_KIND has no plain INSERT and its other
 *      consumers read that set) or an upsert's insert half, whose column list
 *      names `deactivated_at`, cannot be read, or is absent; a MERGE with a
 *      `THEN DELETE`, a `THEN INSERT` with no column list, or any mention of
 *      `deactivated_at` after its target (its conditions are not told from
 *      its SETs);
 *    - failing closed: a raw write whose target is a `${…}` (any table), and
 *      an UPDATE/DELETE/MERGE word sql-scan cannot place in a template naming
 *      `tenant_members`;
 *    - inside the IMPLEMENTATIONS files only, a Prisma write rule 2's
 *      classifyTenantStateWrite would classify whose payload names
 *      `deactivatedAt` with anything but `null` (a spread or an unreadable
 *      payload counts, as in mayName). Rule 2 runs there too, but in
 *      team-departure.ts its cover is an `endTeamMemberships` call, not a
 *      revocation. Elsewhere rule 2 is the one adjudicator: no update may name
 *      it, and a create must be followed by `departCreatedMembership`, which
 *      revokes.
 *    Each must be followed by a call of `revokeUsersAuthArtifactsInTx` or
 *    `revokeUserAuthArtifactsInTx` in its innermost enclosing function itself
 *    (not a nested callback; for a `$transaction(async (tx) => …)` callback,
 *    inside that callback). The sites are pinned by key in
 *    EXPECTED_MEMBERSHIP_ENDS: a missing one fails as loudly as an unexpected
 *    one. The bootstrap migration in src/auth.ts is exempted (it moves the
 *    sessions rather than revoking them). A `tenantMember.delete/deleteMany`
 *    or raw `DELETE FROM tenant_members` is also a tenant-row delete site: it
 *    needs that class's reviewed exemption (team memberships) AND this rule's
 *    revocation (sessions/tokens); the two classes pin the same two Prisma
 *    deletes under their own key prefixes.
 *
 *    The same function must then call `endCreatorFootholdsInTx` AFTER that
 *    revoker call, in the same block (the credential lock comes before the
 *    foothold rows; a call in another branch from the revoker does not count),
 *    or carry an exemption under its own `foothold-end::` key prefix, so no
 *    other family's exemption satisfies it. Only the bootstrap migration in
 *    src/auth.ts has one: its sole member is that tenant's OWNER, whose moves
 *    are not a member foothold.
 *
 *    KNOWN LIMITS (rule 9): a review tripwire over source order, with the
 *    pinned site set as its backstop, not a proof. "After" is source order:
 *    an early return or a branch between the write and the revocation is not
 *    seen, nor whether the revocation names the departed users. Raw SQL is
 *    seen only as a `$queryRaw` / `$executeRaw` tagged template (not the call
 *    form, a composed `Prisma.sql` fragment, or `*Unsafe`); a membership end
 *    inside a database function or a trigger, and the model reached by
 *    element access or an alias, are not seen.
 *
 * 10. A TENANT-MEMBERSHIP CREATION REVOKES IN ITS FUNCTION
 *    (session-revocation-failure-surfaces deviation D13). A row created for a
 *    user who already existed would revive what they still hold in that
 *    tenant from an earlier membership (a SCIM DELETE whose revocation
 *    failed), so the creating function revokes the user's credentials in
 *    that tenant after the write. A creation is a
 *    `tenantMember.create/createMany/createManyAndReturn/upsert` (any
 *    receiver), or a raw `INSERT INTO tenant_members` / `MERGE INTO
 *    tenant_members` template. Each must be followed by a rule-9 revoker call
 *    in its innermost enclosing function itself, as in rule 9, or carry a
 *    reviewed exemption: a brand-new user (the adapter's createUser) and the
 *    bootstrap migration (no credential can exist under its target).
 *    `departCreatedMembership` (which revokes a row created deactivated)
 *    counts only for a Prisma create/upsert whose `deactivatedAt` is always
 *    non-null (a `new …` expression or a literal): SCIM POST and directory
 *    sync call it on their deactivated arm only, so a conditional
 *    `deactivatedAt` needs the active arm's revoker too. The sites are pinned
 *    by key in EXPECTED_MEMBERSHIP_CREATIONS; two creations sharing a key
 *    carry their payload's text in it. Its known limits are rule 9's: source
 *    order, not control flow (a revoker on one branch covers the other), and
 *    not whether the revocation names the created users or their tenant.
 *
 * Scanned: TARGETS, which include scripts/ (its `.ts` files; `__tests__` and
 * `*.test.*` excluded by the walker). NOT seen by rules 2, 5, 6, 9 or the
 * delete class: aliases of the model, element access, `*Unsafe` raw calls, migrations,
 * and `.sh` / `.sql` files (scripts/manual-tests/run-pr-379-test-plan.sh deletes
 * tenant rows in a manual test; the runbook's operator SQL writes them by hand).
 * The database now enforces I1/I2 where it can judge (migration
 * 20261117000000_departed_member_guard); it does not judge undoing a departure
 * (a return, a tenant-row DELETE), TRUNCATE, re-homing a team, or key rows for
 * an absent membership (plan Q3/Q6). Rules 2, 9 and 10, the departureWriters
 * class and the tenantRowDeletes class remain for those.
 *
 * A `data` / `update` that is not an object literal (an identifier, a spread)
 * cannot be read, so it counts: the gate refuses rather than skips what it
 * cannot see. Reviewed sites are listed in EXEMPTIONS; each key must match
 * exactly one site.
 *
 * KNOWN LIMITS — names and positions, not identities or control flow:
 * "before" is source order; callers are followed one level, in the same file;
 * an alias of the model (`const tm = tx.teamMember`) or a `*Unsafe` raw call
 * is not seen. The real-DB races in team-tenant-departure.integration.test.ts
 * pin that the lock and the write share a transaction. SQL inside a database
 * function is not seen either: team_member_key_prune (the retention GC
 * worker's TeamMemberKey prune, #1009) deletes team_member_keys rows in its
 * migration-defined body, not through a TS call site; it locks each team it
 * prunes FOR NO KEY UPDATE (SKIP LOCKED) before deciding, deletes only
 * versions below the team's current one that nothing references, and its
 * concurrency argument and race cells are in
 * team-member-key-prune.integration.test.ts (its statement order is checked
 * by check-team-key-version-refs.mjs).
 *
 * Exit 0 = clean. Exit 1 = a violation, a stale exemption, or site counts (rule
 * 9: site keys) that differ from the pinned ones (a scan that lost sites, or a
 * site to review).
 */
import { Node, SyntaxKind } from "ts-morph";
import { join, dirname, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { createAstProject, sourceFilesFrom, unresolvedTargets } from "./lib/ast-project.mjs";
import { TOKEN, WRITE_KIND, analyzeSql, nameOf, sqlInputFromNode } from "./lib/sql-scan.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.TEAM_ROTATION_INPUT_LOCK_ROOT ?? join(__dirname, "..", "..");
const TARGETS = (process.env.TEAM_ROTATION_INPUT_LOCK_TARGETS ?? "src/app,src/lib,src/workers,src/auth.ts,scripts").split(",");

/** The implementations: their raw SQL IS the lock, the departure and the return. */
const IMPLEMENTATIONS = new Set([
  "src/lib/team/team-key-rotation-lock.ts",
  "src/lib/team/team-departure.ts",
  "src/lib/team/tenant-row-lock.ts",
]);

/** The one file where a tenant active-state write is allowed (a departureWriters site). */
const DEPARTURE_FILE = "src/lib/team/team-departure.ts";
const END_MEMBERSHIPS = new Set(["endTeamMemberships"]);

const LOCK_HELPERS = new Set([
  "lockTeamKeyVersion",
  "lockTeamsAgainstRotation",
  "lockMemberTeamsAgainstRotation",
  // scim-group-service.ts and members/[memberId]/route.ts: lockTenantRows
  // then lockTeamsAgainstRotation.
  "lockGroupWrite",
  "lockActorThenTeam",
]);
const TENANT_LOCKS = new Set(["lockTenantRows", "lockTenantMemberCreation"]);
const TENANT_LOCK_WRAPPERS = new Set(["lockGroupWrite", "lockActorThenTeam"]);
const TRANSITIONS = new Set(["departFromTenant", "returnToTenant"]);

/**
 * Pinned site counts of the real tree, per rule. A change is a site to review.
 * scim-team-admission-approval: member writes +3 (approve CAS, reject delete,
 * SCIM withdraw delete); admissions unchanged (the SCIM reactivation left, the
 * approve CAS joined). scim-team-role-raise-approval: member writes +2 (the
 * SCIM raise-hold CAS of an active row and its key delete for the rows that
 * CAS returned).
 * departed-member-followups: departureWriters 3 (the three tenant_members
 * UPDATEs in departFromTenant, returnToTenant, departCreatedMembership); tenantRowDeletes 2 (both
 * exempted); rules 2/5/6 now run for every file, with no change to the other
 * counts.
 */
const EXPECTED = {
  memberWrites: Number(process.env.TEAM_ROTATION_INPUT_LOCK_WRITES ?? 21),
  tenantStateWrites: Number(process.env.TEAM_ROTATION_INPUT_LOCK_TENANT_WRITES ?? 2),
  admissions: Number(process.env.TEAM_ROTATION_INPUT_LOCK_ADMISSIONS ?? 7),
  departureWriters: Number(process.env.TEAM_ROTATION_INPUT_LOCK_DEPARTURE_WRITERS ?? 3),
  tenantRowDeletes: Number(process.env.TEAM_ROTATION_INPUT_LOCK_TENANT_DELETES ?? 2),
};

/** Sites keyed `<rule>::<path>::<enclosing function>::<site>`, with the review's conclusion. */
const EXEMPTIONS = new Map([
  [
    "member-write::src/app/api/teams/[teamId]/rotate-key/route.ts::<anonymous>::teamMember.updateMany",
    "rotation itself: its transaction holds the team row FOR NO KEY UPDATE (inline), the lock every other writer waits on",
  ],
  [
    "tenant-row-delete::src/auth.ts::<anonymous>::tenantMember.deleteMany",
    "bootstrap migration: removes the user's bootstrap tenant row before the target's row is created (tenant_members_one_active_per_user); their team memberships are kept on purpose and the user reads as a guest of those teams (#1043 SC4)",
  ],
  [
    "tenant-row-delete::src/lib/services/scim-user-service.ts::<anonymous>::tenantMember.delete",
    "deactivateScimUser: deletes the user's team rows (under the teams' rotation locks, assertTeamsLocked) and writes the departure record in the same transaction, so the deleted tenant row leaves no membership active",
  ],
  [
    "membership-create::src/auth.ts::<anonymous>::tenantMember.create",
    "bootstrap → SSO tenant migration: the user's only path into the target is this migration (the target holds no row of theirs, checked above), so no credential of theirs can exist under the target to revive; what they hold is the bootstrap tenant's, whose tokens the migration revokes and whose sessions it moves. A revocation scoped to the target would find nothing before the session move, and would delete the moved sessions after it",
  ],
  [
    "membership-create::src/lib/auth/session/auth-adapter.ts::<anonymous>::tenantMember.create",
    "createUser: the row is for the user the same transaction has just created, who holds no credential anywhere",
  ],
  [
    "foothold-end::src/auth.ts::<anonymous>::tenantMember.deleteMany",
    "bootstrap → SSO tenant migration: the sole member of the bootstrap tenant is its OWNER, and the migration's move is not a member foothold (the tokens and resets they minted there stay theirs; departFromTenant never departs an OWNER either)",
  ],
  [
    "membership-end::src/auth.ts::<anonymous>::tenantMember.deleteMany",
    "bootstrap → SSO tenant migration: revokes the source tenant's tokens inline in the same transaction and MOVES the sessions to the new tenant instead of deleting them, which the revocation primitive would contradict (session-revocation-failure-surfaces-plan.md C2)",
  ],
]);

/**
 * Rule 9's positive control: the membership ends of the real tree, by gate
 * key. A missing one fails as loudly as an unexpected one.
 */
const EXPECTED_MEMBERSHIP_ENDS = [
  "membership-end::src/lib/team/team-departure.ts::departFromTenant::tenant_members.raw",
  "membership-end::src/lib/team/team-departure.ts::departCreatedMembership::tenant_members.raw",
  "membership-end::src/lib/services/scim-user-service.ts::<anonymous>::tenantMember.delete",
  "membership-end::src/auth.ts::<anonymous>::tenantMember.deleteMany",
];

/**
 * Rule 10's positive control: the membership creations of the real tree, by
 * gate key (the revoking ones and the exempted ones alike).
 */
const EXPECTED_MEMBERSHIP_CREATIONS = [
  // The self-test's synthetic sites, as a JSON array of keys (as the counts above take env overrides).
  ...JSON.parse(process.env.TEAM_ROTATION_INPUT_LOCK_EXTRA_CREATIONS ?? "[]"),
  "membership-create::src/app/api/scim/v2/Users/route.ts::<anonymous>::tenantMember.create",
  "membership-create::src/lib/directory-sync/engine.ts::<anonymous>::tenantMember.create",
  "membership-create::src/auth.ts::joinClaimedTenant::tenant_members.raw",
  "membership-create::src/auth.ts::<anonymous>::tenantMember.create",
  "membership-create::src/lib/auth/session/auth-adapter.ts::<anonymous>::tenantMember.create",
];

const RAW_MEMBER_WRITE = /\b(DELETE\s+FROM|UPDATE)\s+(?:"?\w+"?\.)?"?(team_members|team_member_keys)"?\b/i;
const RAW_TENANT_STATE_WRITE = /\b(UPDATE|INSERT\s+INTO)\s+(?:"?\w+"?\.)?"?tenant_members"?\b[\s\S]*\bdeactivated_at\b/i;
const RAW_TENANT_ROW_DELETE = /\bDELETE\s+FROM\s+(?:"?\w+"?\.)?"?tenant_members"?\b/i;
/** A raw tenant-state write that clears the column (a return): the `IS NULL` of a WHERE does not match. */
const RAW_SETS_DEACTIVATED_NULL = /\bSET\b[\s\S]*?\bdeactivated_at\s*=\s*NULL\b/i;
const RAW_DEPARTURE_WRITE = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:"?\w+"?\.)?"?tenant_member_departures"?\b/i;
const LOOPS = new Set([
  SyntaxKind.ForStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.ForInStatement,
  SyntaxKind.WhileStatement,
  SyntaxKind.DoStatement,
]);

console.log(`check-team-rotation-input-lock: ROOT=${REPO_ROOT}`);

const unresolved = unresolvedTargets(TARGETS, REPO_ROOT);
if (unresolved.length > 0) {
  console.error(`\nFAIL: scan target not found under ${REPO_ROOT}: ${unresolved.join(", ")}`);
  process.exit(1);
}

/** The property of an object literal keyed `name`, as an identifier or a quoted string (`role` / `"role"`). */
function findProp(obj, name) {
  return obj.getProperties().find((p) => !Node.isSpreadAssignment(p) && propertyKeyName(p) === name);
}

/** The object literal of `prop` in an object, `undefined` when absent, `null` when unreadable. */
function propOf(obj, prop) {
  if (!obj || !Node.isObjectLiteralExpression(obj)) return null;
  if (obj.getProperties().some((p) => Node.isSpreadAssignment(p))) return null;
  const p = findProp(obj, prop);
  if (!p) return undefined;
  if (Node.isShorthandPropertyAssignment(p)) return null;
  if (!Node.isPropertyAssignment(p)) return null;
  const init = p.getInitializer();
  return init && Node.isObjectLiteralExpression(init) ? init : null;
}

function argProp(call, prop) {
  return propOf(call.getArguments()[0], prop);
}

/** Whether an object literal (or an unreadable one) may name any of `keys`. */
function mayName(literal, keys) {
  if (literal === undefined) return false;
  if (literal === null) return true;
  if (literal.getProperties().some((p) => Node.isSpreadAssignment(p))) return true;
  return keys.some((k) => findProp(literal, k) !== undefined);
}

function modelAndMethod(call) {
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return null;
  const object = callee.getExpression();
  if (!Node.isPropertyAccessExpression(object)) return null;
  return { model: object.getName(), method: callee.getName() };
}

function calleeName(call) {
  const callee = call.getExpression();
  if (Node.isIdentifier(callee)) return callee.getText();
  if (Node.isPropertyAccessExpression(callee)) return callee.getName();
  return null;
}

const MEMBER_KEYS = ["deactivatedAt", "deactivatedByTenant", "keyDistributed"];

function classifyMemberWrite(call, mm) {
  const { model, method } = mm;
  const site = `${model}.${method}`;
  if (model === "teamMemberKey" && (method === "delete" || method === "deleteMany")) return site;
  if (model !== "teamMember") return null;
  if (method === "delete" || method === "deleteMany") return site;
  if ((method === "update" || method === "updateMany" || method === "updateManyAndReturn") && mayName(argProp(call, "data"), MEMBER_KEYS)) return site;
  if (method === "upsert" && mayName(argProp(call, "update"), MEMBER_KEYS)) return site;
  return null;
}

/** `{ site, create }` when the call writes `tenant_members.deactivated_at`, else null. */
function classifyTenantStateWrite(call, mm) {
  if (mm.model !== "tenantMember") return null;
  const site = `tenantMember.${mm.method}`;
  if (mm.method === "update" || mm.method === "updateMany" || mm.method === "updateManyAndReturn") {
    return mayName(argProp(call, "data"), ["deactivatedAt"]) ? { site, create: false } : null;
  }
  if (mm.method === "upsert") {
    if (mayName(argProp(call, "update"), ["deactivatedAt"])) return { site, create: false };
    return mayName(argProp(call, "create"), ["deactivatedAt"]) ? { site, create: true } : null;
  }
  if (mm.method === "create" || mm.method === "createMany" || mm.method === "createManyAndReturn") {
    return mayName(argProp(call, "data"), ["deactivatedAt"]) ? { site, create: true } : null;
  }
  return null;
}

/** Whether a tenantMember write's `data` (an upsert's `update`) names `deactivatedAt: null`. */
function namesNullDeactivatedAt(call) {
  const method = modelAndMethod(call)?.method;
  const literal = argProp(call, method === "upsert" ? "update" : "data");
  const p = literal ? findProp(literal, "deactivatedAt") : undefined;
  return p !== undefined && Node.isPropertyAssignment(p) && p.getInitializer()?.getText() === "null";
}

/** Whether a `data` literal clears `deactivatedAt` (a reactivation), or cannot be read. */
function reactivates(call) {
  const data = argProp(call, "data");
  if (data === undefined) return false;
  if (data === null || data.getProperties().some((p) => Node.isSpreadAssignment(p))) return true;
  const p = findProp(data, "deactivatedAt");
  if (!p) return false;
  return !Node.isPropertyAssignment(p) || p.getInitializer()?.getText() === "null";
}

function classifyAdmission(call, mm) {
  const { model, method } = mm;
  if (model === "teamMember" && ["create", "createMany", "createManyAndReturn", "upsert"].includes(method)) return `teamMember.${method}`;
  if (model === "teamMember" && (method === "update" || method === "updateMany" || method === "updateManyAndReturn") && reactivates(call)) {
    return `teamMember.${method}`;
  }
  if (model === "teamInvitation" && (method === "create" || method === "createMany" || method === "createManyAndReturn")) return `teamInvitation.${method}`;
  if (model === "team" && method === "create" && mayName(propOf(argProp(call, "data"), "members"), ["create", "createMany", "createManyAndReturn"])) {
    return "team.create(members)";
  }
  return null;
}

function enclosingFunction(node) {
  return node.getFirstAncestor((n) => Node.isFunctionLikeDeclaration(n)) ?? null;
}

function functionName(fn) {
  if (!fn) return "<module>";
  if (Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn)) return fn.getName() ?? "<anonymous>";
  const parent = fn.getParent();
  if (parent && Node.isVariableDeclaration(parent)) return parent.getName();
  return "<anonymous>";
}

function callsIn(fn) {
  return fn.getDescendantsOfKind(SyntaxKind.CallExpression).filter((c) => enclosingFunction(c) === fn);
}

function callsBefore(fn, names, pos) {
  return fn.getDescendantsOfKind(SyntaxKind.CallExpression).some((c) => names.has(calleeName(c)) && c.getStart() < pos);
}

function callsAfter(fn, names, pos) {
  return fn.getDescendantsOfKind(SyntaxKind.CallExpression).some((c) => names.has(calleeName(c)) && c.getStart() > pos);
}

/** One level up: every same-file call of `name` follows a `names` call in its own function. */
function coveredByCallers(sourceFile, name, names) {
  if (name === "<anonymous>" || name === "<module>") return false;
  const calls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression).filter((c) => calleeName(c) === name);
  return calls.length > 0 && calls.every((c) => {
    const caller = enclosingFunction(c);
    return caller !== null && callsBefore(caller, names, c.getStart());
  });
}

function covered(sourceFile, node, names) {
  const fn = enclosingFunction(node);
  return fn !== null && (callsBefore(fn, names, node.getStart()) || coveredByCallers(sourceFile, functionName(fn), names));
}

function rawWrites(sourceFile) {
  return sourceFile.getDescendantsOfKind(SyntaxKind.TaggedTemplateExpression)
    .filter((t) => /\$(queryRaw|executeRaw)$/.test(t.getTag().getText()));
}

/**
 * Whether an options argument is an object literal with `alreadyLocked: true`,
 * or an identifier declared in `fn` with such an initializer.
 */
function passesAlreadyLocked(fn, options) {
  let literal = options;
  if (options && Node.isIdentifier(options)) {
    const decl = fn.getDescendantsOfKind(SyntaxKind.VariableDeclaration).find((d) => d.getName() === options.getText());
    literal = decl?.getInitializer();
  }
  if (!literal || !Node.isObjectLiteralExpression(literal)) return false;
  const p = findProp(literal, "alreadyLocked");
  return p !== undefined && Node.isPropertyAssignment(p) && p.getInitializer()?.getText() === "true";
}

// ── Rule 7: SCIM admission marker (scim-team-admission-approval-plan.md, Forbidden patterns) ──

const SCIM_GROUP_SERVICE_FILE = "src/lib/services/scim-group-service.ts";
const SCIM_ADMISSION_MODULE = "src/lib/team/scim-admission";
const SCIM_ADMISSION_MODULE_FILE = `${SCIM_ADMISSION_MODULE}.ts`;
const MEMBERS_ROUTE_DIR = "src/app/api/teams/[teamId]/members";
const SCIM_ADMISSION_ROUTE_FILES = new Set([
  `${MEMBERS_ROUTE_DIR}/[memberId]/approve/route.ts`,
  `${MEMBERS_ROUTE_DIR}/[memberId]/reject/route.ts`,
  `${MEMBERS_ROUTE_DIR}/bulk-approve/route.ts`,
  `${MEMBERS_ROUTE_DIR}/bulk-reject/route.ts`,
]);
const AUDIT_LIB_DIR = "src/lib/audit";
const AUDIT_EMITTER_MODULE = "src/lib/audit/audit";
/** What each file in the admission boundary may import from `@/lib/audit/*`. */
const AUDIT_IMPORT_ALLOWLIST = new Map([
  ...[...SCIM_ADMISSION_ROUTE_FILES].map((file) => [file, new Set(["extractRequestMeta"])]),
  [SCIM_ADMISSION_MODULE_FILE, new Set(["logAuditInTx"])],
]);
const NON_CREATING_TEAM_MEMBER_METHODS = new Set(["update", "updateMany", "updateManyAndReturn"]);
const RAW_TEAM_MEMBERS_WRITE = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:"?\w+"?\.)?"?team_members"?\b/i;

/** An object literal readable as a write payload (no spread), else `null`; `undefined` passes through. */
function asObject(node) {
  if (node === undefined) return undefined;
  if (node === null) return null;
  return Node.isObjectLiteralExpression(node) && !node.getProperties().some((p) => Node.isSpreadAssignment(p))
    ? node
    : null;
}

/** The raw initializer of `prop` on object literal `obj`: `undefined` absent, `null` unreadable. */
function rawProp(obj, prop) {
  if (!obj || !Node.isObjectLiteralExpression(obj)) return null;
  if (obj.getProperties().some((p) => Node.isSpreadAssignment(p))) return null;
  const p = findProp(obj, prop);
  if (!p) return undefined;
  if (Node.isShorthandPropertyAssignment(p)) return null;
  if (!Node.isPropertyAssignment(p)) return null;
  return p.getInitializer() ?? null;
}

/**
 * A `createMany*` `data` node as a list of element object literals, `null`
 * standing in for an unreadable element (a non-literal array entry, or a
 * `.map` whose callback is anything but a concise arrow returning an object
 * literal — a block body is refused, not inspected for its `return`).
 */
function createElements(node) {
  if (node === null || node === undefined) return [null];
  if (Node.isArrayLiteralExpression(node)) {
    return node.getElements().map((el) => asObject(el) ?? null);
  }
  if (Node.isCallExpression(node) && calleeName(node) === "map") {
    const cb = node.getArguments()[node.getArguments().length - 1];
    if (!cb || !Node.isArrowFunction(cb)) return [null];
    const body = cb.getBody();
    const expr = Node.isParenthesizedExpression(body) ? body.getExpression() : body;
    return [Node.isObjectLiteralExpression(expr) ? asObject(expr) : null];
  }
  return [null];
}

/** `{ literal, creating }` payloads a `teamMember` write call carries, for rule 7. */
function teamMemberWritePayloads(call, mm) {
  if (mm.model !== "teamMember") return [];
  const obj = call.getArguments()[0];
  if (mm.method === "create") {
    return [{ literal: asObject(rawProp(obj, "data")) ?? null, creating: true }];
  }
  if (mm.method === "createMany" || mm.method === "createManyAndReturn") {
    const data = rawProp(obj, "data");
    return createElements(data).map((literal) => ({ literal, creating: true }));
  }
  if (mm.method === "upsert") {
    const out = [];
    const createLit = rawProp(obj, "create");
    if (createLit !== undefined) out.push({ literal: asObject(createLit) ?? null, creating: true });
    const updateLit = rawProp(obj, "update");
    if (updateLit !== undefined) out.push({ literal: asObject(updateLit) ?? null, creating: false });
    return out;
  }
  if (NON_CREATING_TEAM_MEMBER_METHODS.has(mm.method)) {
    const data = rawProp(obj, "data");
    if (data === undefined) return [];
    return [{ literal: asObject(data) ?? null, creating: false }];
  }
  return [];
}

/**
 * A `members: { create / createMany / connectOrCreate }` relation payload
 * nested in a `team` write call's `data` (or an `upsert`'s `create`/`update`
 * arm) — mirrors classifyAdmission's own `team.create(members)` scope, so a
 * `members` property elsewhere (e.g. a SCIM Group resource's response list)
 * is never mistaken for a Prisma relation write.
 */
function nestedMemberPayloads(call, mm) {
  if (mm.model !== "team") return [];
  const out = [];
  const scan = (container) => {
    const literal = asObject(container);
    if (!literal) return;
    const membersProp = findProp(literal, "members");
    if (!membersProp || !Node.isPropertyAssignment(membersProp)) return;
    const init = membersProp.getInitializer();
    if (!init || !Node.isObjectLiteralExpression(init)) {
      out.push({ literal: null, creating: true, node: membersProp });
      return;
    }
    const createProp = findProp(init, "create");
    if (createProp && Node.isPropertyAssignment(createProp)) {
      out.push({ literal: asObject(createProp.getInitializer()) ?? null, creating: true, node: createProp });
    }
    const createManyProp = findProp(init, "createMany");
    if (createManyProp && Node.isPropertyAssignment(createManyProp)) {
      const data = rawProp(createManyProp.getInitializer(), "data");
      for (const literal of createElements(data)) out.push({ literal, creating: true, node: createManyProp });
    }
    const connectOrCreateProp = findProp(init, "connectOrCreate");
    if (connectOrCreateProp && Node.isPropertyAssignment(connectOrCreateProp)) {
      const coc = connectOrCreateProp.getInitializer();
      const items = coc && Node.isArrayLiteralExpression(coc) ? coc.getElements() : [coc];
      for (const item of items) {
        const createLit = item ? rawProp(item, "create") : null;
        out.push({ literal: asObject(createLit) ?? null, creating: true, node: connectOrCreateProp });
      }
    }
  };
  const obj = call.getArguments()[0];
  if (mm.method === "upsert") {
    scan(rawProp(obj, "create"));
    scan(rawProp(obj, "update"));
  } else if (["create", "update", "updateMany", "createMany"].includes(mm.method)) {
    scan(rawProp(obj, "data"));
  }
  return out;
}

/** Rule 7, bullet 1: one payload's readability / no-null-deactivatedAt / creating-marker checks. */
function checkAdmissionPayload(path, node, { literal, creating }, violations) {
  if (literal === null) {
    violations.push(`admission-marker  ${lineOf(path, node)}  unreadable team_members write payload (cannot verify the pending marker)`);
    return;
  }
  const deactivatedAt = findProp(literal, "deactivatedAt");
  const namesNull = deactivatedAt !== undefined
    && Node.isPropertyAssignment(deactivatedAt)
    && deactivatedAt.getInitializer()?.getText() === "null";
  if (namesNull) {
    violations.push(`admission-marker  ${lineOf(path, node)}  team_members payload names deactivatedAt: null`);
  }
  if (creating) {
    const marker = findProp(literal, "scimApprovalPending");
    const markerTrue = marker !== undefined && Node.isPropertyAssignment(marker) && marker.getInitializer()?.getText() === "true";
    const hasDeactivatedAt = deactivatedAt !== undefined && !namesNull;
    if (!markerTrue || !hasDeactivatedAt) {
      violations.push(`admission-marker  ${lineOf(path, node)}  creating team_members payload missing scimApprovalPending: true and a non-null deactivatedAt`);
    }
  }
}

/** Rule 7, bullet 2 (repo-wide, run for EVERY file before the IMPLEMENTATIONS skip). */
function propertyKeyName(prop) {
  const nameNode = prop.getNameNode();
  if (Node.isIdentifier(nameNode)) return nameNode.getText();
  if (Node.isStringLiteral(nameNode)) return nameNode.getLiteralText();
  return null;
}

function isInsideWhereFilter(node) {
  for (let cur = node.getParent(); cur; cur = cur.getParent()) {
    if (Node.isPropertyAssignment(cur) && propertyKeyName(cur) === "where") return true;
  }
  return false;
}

function checkPendingMarkerRepoWide(sourceFile, path, violations) {
  const props = [
    ...sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAssignment),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.ShorthandPropertyAssignment),
  ];
  for (const prop of props) {
    if (propertyKeyName(prop) !== "scimApprovalPending") continue;
    if (path === SCIM_ADMISSION_MODULE_FILE) continue;
    // A query filter writes nothing; anything not under a `where` — a write
    // payload, or an object a payload may be built from — is checked.
    if (isInsideWhereFilter(prop)) continue;
    const isTrueLiteral = Node.isPropertyAssignment(prop) && prop.getInitializer()?.getText() === "true";
    if (isTrueLiteral) continue;
    violations.push(`admission-marker  ${lineOf(path, prop)}  scimApprovalPending set to something other than the literal true outside the admission module`);
  }
}

function checkRawColumnNameRepoWide(sourceFile, path, violations) {
  const literalNodes = [
    ...sourceFile.getDescendantsOfKind(SyntaxKind.StringLiteral),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.TemplateHead),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.TemplateMiddle),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.TemplateTail),
  ];
  for (const lit of literalNodes) {
    const text = Node.isStringLiteral(lit) || Node.isNoSubstitutionTemplateLiteral(lit) ? lit.getLiteralText() : lit.getText();
    if (text.includes("scim_approval_pending")) {
      violations.push(`admission-marker  ${lineOf(path, lit)}  raw access to scim_approval_pending by column name (no code needs it)`);
    }
  }
}

/** A module specifier as a repo-relative extension-less path (`@/` → `src/`, relative against the importer); null for a package. */
function resolveSpecifier(importer, specifier) {
  let resolved;
  if (specifier.startsWith("@/")) resolved = `src/${specifier.slice(2)}`;
  else if (specifier.startsWith(".")) resolved = posix.join(posix.dirname(importer), specifier);
  else return null;
  // Normalised for both forms: `@/lib/team/../team/x` and `@/lib//team/x` name the same file.
  return posix.normalize(resolved).replace(/\.(?:[cm]?[jt]sx?)$/, "");
}

/**
 * Every module reference of a file whose specifier is a literal: import
 * declarations, `export … from`, `import()`, `require()` and `import x =
 * require()`. `names` lists what an import declaration binds (`*` for a
 * default or namespace binding, none for a side-effect import).
 */
function moduleReferences(sourceFile) {
  const refs = [];
  for (const decl of sourceFile.getImportDeclarations()) {
    const names = decl.getNamedImports().map((n) => n.getName());
    if (decl.getDefaultImport() || decl.getNamespaceImport()) names.push("*");
    refs.push({ node: decl, specifier: decl.getModuleSpecifierValue(), kind: "import", names });
  }
  for (const decl of sourceFile.getExportDeclarations()) {
    const specifier = decl.getModuleSpecifierValue();
    if (specifier !== undefined) refs.push({ node: decl, specifier, kind: "export", names: [] });
  }
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    const isImport = callee.getKind() === SyntaxKind.ImportKeyword;
    if (!isImport && !(Node.isIdentifier(callee) && callee.getText() === "require")) continue;
    const arg = call.getArguments()[0];
    if (arg && (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg))) {
      refs.push({ node: call, specifier: arg.getLiteralText(), kind: isImport ? "dynamic import" : "require", names: [] });
    }
  }
  for (const ref of sourceFile.getDescendantsOfKind(SyntaxKind.ExternalModuleReference)) {
    const expr = ref.getExpression();
    if (expr && Node.isStringLiteral(expr)) refs.push({ node: ref, specifier: expr.getLiteralText(), kind: "require", names: [] });
  }
  return refs;
}

/** Rule 7, admission module boundary (plan C1 V7 b-d), repo-wide and before the IMPLEMENTATIONS skip. */
function checkAdmissionModuleBoundary(sourceFile, path, violations) {
  const isRoute = SCIM_ADMISSION_ROUTE_FILES.has(path);
  const auditAllowed = AUDIT_IMPORT_ALLOWLIST.get(path);
  for (const ref of moduleReferences(sourceFile)) {
    const resolved = resolveSpecifier(path, ref.specifier);
    if (resolved === null) continue;
    const where = lineOf(path, ref.node);
    if (resolved === SCIM_ADMISSION_MODULE && path !== SCIM_ADMISSION_MODULE_FILE) {
      if (ref.kind === "export") {
        violations.push(`admission-module  ${where}  re-exports the SCIM admission module (export … from)`);
      } else if (!isRoute) {
        violations.push(`admission-module  ${where}  ${ref.kind} of the SCIM admission module outside the four admission routes`);
      }
    }
    if (auditAllowed && (resolved === AUDIT_LIB_DIR || resolved.startsWith(`${AUDIT_LIB_DIR}/`))) {
      const bad = ref.kind !== "import" || resolved !== AUDIT_EMITTER_MODULE
        ? [`${ref.kind} of ${ref.specifier}`]
        : ref.names.filter((n) => !auditAllowed.has(n)).map((n) => `import of ${n} from ${ref.specifier}`);
      for (const what of bad) {
        violations.push(`admission-audit  ${where}  ${what} (only ${[...auditAllowed].join(", ")} from @/lib/audit/audit is allowed here)`);
      }
    }
  }
  if (isRoute) {
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      if (calleeName(call) === "lockTenantRows") {
        violations.push(`admission-module  ${lineOf(path, call)}  admission route calls lockTenantRows (the admission module takes the locks)`);
      }
    }
  }
}

// ── Rule 9: a tenant-membership end revokes in its function (session-revocation-failure-surfaces-plan.md C8) ──

const REVOKERS = new Set(["revokeUsersAuthArtifactsInTx", "revokeUserAuthArtifactsInTx"]);
const FOOTHOLD_ENDERS = new Set(["endCreatorFootholdsInTx"]);
const MEMBERSHIP_TABLE = "tenant_members";
const END_COLUMN = "deactivated_at";
const SET_LIST_ENDS = new Set(["FROM", "WHERE", "RETURNING"]);

const isKeyword = (t, upper) => t !== undefined && t.type === TOKEN.WORD && t.upper === upper;
const isSqlName = (t) => t !== undefined && (t.type === TOKEN.WORD || t.type === TOKEN.QIDENT || t.type === TOKEN.OPAQUE);
const namesColumn = (t, name) => t !== undefined && (t.type === TOKEN.WORD || t.type === TOKEN.QIDENT) && nameOf(t) === name;

/**
 * Whether a Prisma payload names `deactivatedAt` with anything but the
 * literal `null`, judged as mayName judges (a spread or an unreadable payload
 * may name it, so it counts).
 */
function endsByPayload(literal) {
  if (!mayName(literal, ["deactivatedAt"])) return false;
  if (literal === null || literal.getProperties().some((p) => Node.isSpreadAssignment(p))) return true;
  const p = findProp(literal, "deactivatedAt");
  return !Node.isPropertyAssignment(p) || p.getInitializer()?.getText() !== "null";
}

/**
 * The site of a Prisma membership end: a `tenantMember` delete/deleteMany,
 * and — inside the IMPLEMENTATIONS files only, where rule 2 does not run — a
 * write rule 2 would classify whose payload names a non-null `deactivatedAt`.
 * Elsewhere rule 2 adjudicates those writes.
 */
function prismaMembershipEnd(path, call, mm) {
  const site = `tenantMember.${mm.method}`;
  if (mm.model === "tenantMember" && (mm.method === "delete" || mm.method === "deleteMany")) return site;
  if (!IMPLEMENTATIONS.has(path) || !classifyTenantStateWrite(call, mm)) return null;
  const arms = mm.method === "upsert" ? ["update", "create"] : ["data"];
  return arms.some((arm) => endsByPayload(argProp(call, arm))) ? site : null;
}

/** First token after the statement holding token `i` at depth `depth`. */
function sqlStatementEnd(tokens, i, depth) {
  for (let j = i; j < tokens.length; j++) {
    const t = tokens[j];
    if ((t.type === TOKEN.SEMI && t.depth <= depth) || (t.type === TOKEN.RPAREN && t.depth < depth)) return j;
  }
  return tokens.length;
}

/** `[ONLY] [schema.]name` at `i`: `{ name, end }` (`name` null for a `${…}` table), or null. */
function readTable(tokens, i) {
  let j = isKeyword(tokens[i], "ONLY") ? i + 1 : i;
  if (!isSqlName(tokens[j])) return null;
  let last = tokens[j];
  j++;
  while (tokens[j]?.type === TOKEN.DOT && isSqlName(tokens[j + 1])) {
    last = tokens[j + 1];
    j += 2;
  }
  return { name: last.type === TOKEN.OPAQUE ? null : nameOf(last), end: j };
}

/**
 * Whether a SET list ends a membership. Each assignment from `from` up to the
 * list's end (FROM / WHERE / RETURNING / the statement end, at `depth`) must
 * read `column = value`; one that does not (a row constructor, a `${…}`
 * fragment, a subscript) counts, and so does `deactivated_at = <anything but
 * NULL>`.
 */
function setListEnds(tokens, from, depth) {
  const assignmentEnds = (s, e) => {
    const [column, eq] = [tokens[s], tokens[s + 1]];
    if (e - s < 3 || !(column.type === TOKEN.WORD || column.type === TOKEN.QIDENT) || eq.type !== TOKEN.OP || eq.text !== "=") return true;
    return nameOf(column) === END_COLUMN && !(e - s === 3 && isKeyword(tokens[s + 2], "NULL"));
  };
  let start = from;
  for (let j = from; ; j++) {
    const t = tokens[j];
    const atEnd = t === undefined || t.depth < depth
      || (t.depth === depth && (t.type === TOKEN.SEMI || (t.type === TOKEN.WORD && SET_LIST_ENDS.has(t.upper))));
    if (atEnd || (t.type === TOKEN.COMMA && t.depth === depth)) {
      if (assignmentEnds(start, j)) return true;
      if (atEnd) return false;
      start = j + 1;
    }
  }
}

/**
 * An `INSERT INTO tenant_members` head at `i` (plain, or an upsert's insert
 * half), read from tokens — analyzeSql has no plain-INSERT kind. It ends a
 * membership when its column list names deactivated_at or cannot be read, or
 * it has none; an `ON CONFLICT … DO UPDATE SET` ends one as an UPDATE's SET
 * list does.
 */
function insertEnds(tokens, i, table, reasons) {
  const depth = tokens[i].depth;
  const end = sqlStatementEnd(tokens, i + 1, depth);
  let j = table.end;
  if (isKeyword(tokens[j], "AS") && isSqlName(tokens[j + 1])) j += 2;
  const open = tokens[j];
  if (open?.type !== TOKEN.LPAREN || open.match === undefined) {
    reasons.push("INSERT with no column list");
  } else {
    const columns = tokens.slice(j + 1, open.match);
    const readable = columns.length % 2 === 1
      && columns.every((t, k) => (k % 2 === 0 ? t.type === TOKEN.WORD || t.type === TOKEN.QIDENT : t.type === TOKEN.COMMA));
    if (!readable) reasons.push("INSERT whose column list cannot be read");
    else if (columns.some((t) => namesColumn(t, END_COLUMN))) reasons.push(`INSERT naming ${END_COLUMN}`);
  }
  for (let k = j; k < end; k++) {
    if (tokens[k].depth !== depth || !isKeyword(tokens[k], "ON") || !isKeyword(tokens[k + 1], "CONFLICT")) continue;
    for (let d = k + 2; d < end; d++) {
      if (tokens[d].depth === depth && isKeyword(tokens[d], "DO") && isKeyword(tokens[d + 1], "UPDATE") && isKeyword(tokens[d + 2], "SET")) {
        if (setListEnds(tokens, d + 3, depth)) reasons.push(`ON CONFLICT DO UPDATE SET assigning ${END_COLUMN}`);
        break;
      }
    }
    break;
  }
}

/**
 * A `MERGE INTO tenant_members` at `i` ends a membership when it has a `THEN
 * DELETE`, a `THEN INSERT` with no column list, or names deactivated_at
 * anywhere after its target — its conditions are not told from its SETs and
 * INSERT arms, so a mention anywhere counts.
 */
function mergeEnds(tokens, i, table, reasons) {
  const depth = tokens[i].depth;
  const end = sqlStatementEnd(tokens, i + 1, depth);
  for (let k = table.end; k < end; k++) {
    const t = tokens[k];
    if (namesColumn(t, END_COLUMN)) reasons.push(`MERGE naming ${END_COLUMN}`);
    if (t.depth !== depth || !isKeyword(t, "THEN")) continue;
    if (isKeyword(tokens[k + 1], "DELETE")) reasons.push("MERGE … THEN DELETE");
    if (isKeyword(tokens[k + 1], "INSERT") && tokens[k + 2]?.type !== TOKEN.LPAREN) reasons.push("MERGE … THEN INSERT with no column list");
  }
}

/**
 * Why a raw template ends a membership (empty when it does not), from
 * sql-scan tokens: a DELETE of tenant_members; an UPDATE whose SET list ends
 * one (setListEnds); an INSERT or MERGE read by insertEnds / mergeEnds; and,
 * failing closed, a write whose target is a `${…}` (any table), or an
 * UPDATE/DELETE/MERGE word sql-scan cannot place in a template that names
 * tenant_members.
 */
function rawMembershipEndReasons(raw) {
  const input = sqlInputFromNode(raw.getTemplate());
  if (input === null) return [];
  const { tokens, writes, unrecognisedWrites } = analyzeSql(input);
  const reasons = [];
  for (const w of writes) {
    if (w.target.name === null) {
      reasons.push(`${w.kind} of a \${…} target`);
      continue;
    }
    if (w.target.name !== MEMBERSHIP_TABLE) continue;
    if (w.kind === WRITE_KIND.DELETE) reasons.push("DELETE");
    if (w.kind === WRITE_KIND.UPDATE) {
      const set = tokens.findIndex((t, k) => k > w.token && k < w.end && t.depth === w.depth && isKeyword(t, "SET"));
      if (set === -1 || setListEnds(tokens, set + 1, w.depth)) reasons.push(`UPDATE assigning ${END_COLUMN}`);
    }
    // An UPSERT's halves and a MERGE are read from their heads below (a
    // MERGE whose actions are only INSERT is no analyzeSql write).
  }
  for (let i = 0; i < tokens.length; i++) {
    const head = isKeyword(tokens[i], "INSERT") ? insertEnds : isKeyword(tokens[i], "MERGE") ? mergeEnds : null;
    if (head === null || !isKeyword(tokens[i + 1], "INTO")) continue;
    const table = readTable(tokens, i + 2);
    if (table === null) continue;
    if (table.name === null) reasons.push(`${tokens[i].upper} into a \${…} target`);
    else if (table.name === MEMBERSHIP_TABLE) head(tokens, i, table, reasons);
  }
  if (unrecognisedWrites.length > 0 && tokens.some((t) => namesColumn(t, MEMBERSHIP_TABLE))) {
    reasons.push(`${unrecognisedWrites.map((u) => u.word).join("/")} the scanner cannot place, beside ${MEMBERSHIP_TABLE}`);
  }
  return [...new Set(reasons)];
}

/** Rule 9's sites in one file: `{ node, site, detail }`. */
function membershipEnds(sourceFile, path) {
  const out = [];
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const mm = modelAndMethod(call);
    const site = mm && prismaMembershipEnd(path, call, mm);
    if (site) out.push({ node: call, site, detail: site });
  }
  for (const raw of rawWrites(sourceFile)) {
    const reasons = rawMembershipEndReasons(raw);
    if (reasons.length === 0) continue;
    const namesTable = /\btenant_members\b/.test(raw.getTemplate().getText());
    out.push({ node: raw, site: namesTable ? `${MEMBERSHIP_TABLE}.raw` : "opaque.raw", detail: reasons.join("; ") });
  }
  return out;
}

// ── Rule 10: a tenant-membership creation revokes in its function (deviation D13) ──

const CREATE_METHODS = new Set(["create", "createMany", "createManyAndReturn", "upsert"]);
/**
 * departCreatedMembership revokes the users whose rows were created
 * deactivated, so it covers only a creation whose row is ALWAYS created
 * deactivated: in SCIM POST and directory sync it runs on the deactivated arm
 * only, and the active arm's revocation is a rule-9 revoker's.
 */
const CREATION_REVOKERS = new Set([...REVOKERS, "departCreatedMembership"]);

/**
 * Whether a Prisma creation always creates its row deactivated: its payload
 * (`data`, an upsert's `create`) is an object literal whose `deactivatedAt` is
 * a `new …` expression or a string or numeric literal. A conditional, an
 * identifier, a call, `null`, an absent key, a spread, a `createMany*` and an
 * unreadable payload are not (a row it creates may be active).
 */
function createsDeactivated(call, mm) {
  if (mm.method !== "create" && mm.method !== "upsert") return false;
  const value = rawProp(argProp(call, mm.method === "upsert" ? "create" : "data"), "deactivatedAt");
  if (!value) return false;
  return Node.isNewExpression(value) || Node.isStringLiteral(value)
    || Node.isNoSubstitutionTemplateLiteral(value) || Node.isNumericLiteral(value);
}

/** Whether a raw template inserts into tenant_members: an INSERT head, or a MERGE with an INSERT action. */
function rawCreatesMembership(raw) {
  const input = sqlInputFromNode(raw.getTemplate());
  if (input === null) return false;
  const { tokens } = analyzeSql(input);
  for (let i = 0; i < tokens.length; i++) {
    const head = isKeyword(tokens[i], "INSERT") ? "INSERT" : isKeyword(tokens[i], "MERGE") ? "MERGE" : null;
    if (head === null || !isKeyword(tokens[i + 1], "INTO")) continue;
    const table = readTable(tokens, i + 2);
    if (table?.name !== MEMBERSHIP_TABLE) continue;
    if (head === "INSERT") return true;
    const end = sqlStatementEnd(tokens, i + 1, tokens[i].depth);
    if (tokens.slice(table.end, end).some((t, k, rest) => isKeyword(t, "THEN") && isKeyword(rest[k + 1], "INSERT"))) return true;
  }
  return false;
}

/**
 * Rule 10's sites in one file: `{ node, site, detail, revokers }`, `detail`
 * the created row's payload text, `revokers` the calls that cover it (a raw
 * creation's row is never read as always deactivated).
 */
function membershipCreations(sourceFile) {
  const out = [];
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const mm = modelAndMethod(call);
    if (!mm || mm.model !== "tenantMember" || !CREATE_METHODS.has(mm.method)) continue;
    const payload = argProp(call, mm.method === "upsert" ? "create" : "data");
    const revokers = createsDeactivated(call, mm) ? CREATION_REVOKERS : REVOKERS;
    out.push({ node: call, site: `tenantMember.${mm.method}`, detail: payload ? compact(payload) : "<unreadable>", revokers });
  }
  for (const raw of rawWrites(sourceFile)) {
    if (rawCreatesMembership(raw)) {
      out.push({ node: raw, site: `${MEMBERSHIP_TABLE}.raw`, detail: compact(raw.getTemplate()), revokers: REVOKERS });
    }
  }
  return out;
}

/** Whether a revoker is called after `node`, in `node`'s innermost enclosing function itself (not a nested callback). */
function revokesAfter(node, revokers = REVOKERS) {
  const fn = enclosingFunction(node);
  return fn !== null && callsIn(fn).some((c) => revokers.has(calleeName(c)) && c.getStart() >= node.getEnd());
}

/** The statement list holding `node`: the closest block, case clause or file. */
function enclosingBlock(node) {
  return node.getFirstAncestor((a) => Node.isBlock(a) || Node.isCaseClause(a) || Node.isDefaultClause(a) || Node.isSourceFile(a)) ?? null;
}

/**
 * Whether a foothold ender is called after a revoker that itself follows
 * `node`, in `node`'s innermost enclosing function, with both in one block (a
 * revoker in one branch and the ender in another is not the lock order).
 */
function footholdsEndAfter(node) {
  const fn = enclosingFunction(node);
  if (fn === null) return false;
  const calls = callsIn(fn);
  const revokes = calls.filter((c) => REVOKERS.has(calleeName(c)) && c.getStart() >= node.getEnd());
  return calls.some((f) => FOOTHOLD_ENDERS.has(calleeName(f))
    && revokes.some((r) => f.getStart() >= r.getEnd() && enclosingBlock(f) === enclosingBlock(r)));
}

/** A node's text on one line, for a site key. */
function compact(node) {
  return node ? node.getText().replace(/\s+/g, " ") : "";
}

const project = createAstProject();
const sites = [];
const violations = [];
const keyOf = (rule, path, node, site) => `${rule}::${path}::${functionName(enclosingFunction(node))}::${site}`;
const lineOf = (path, node) => `${path}:${node.getStartLineNumber()}`;
const TENANT_LOCK_OR_WRAPPER = new Set([...TENANT_LOCKS, ...TENANT_LOCK_WRAPPERS]);

/**
 * Rules 2, 5, 6 and the tenant-row delete class, for EVERY file before the
 * IMPLEMENTATIONS skip: their claim is "only X writes Y", which the lock
 * modules and team-departure.ts must keep too. In team-departure.ts a tenant
 * active-state write is a departureWriters site, not a violation.
 */
function checkDepartureClasses(sourceFile, path) {
  const inDeparture = path === DEPARTURE_FILE;
  const tenantStateSite = (node, site, create, nulls) => {
    const fn = enclosingFunction(node);
    if (inDeparture) {
      // A call in the function's own body: one nested in a callback it may never run does not count.
      const ok = nulls || (fn !== null && callsIn(fn).some((c) => END_MEMBERSHIPS.has(calleeName(c)) && c.getStart() > node.getStart()));
      sites.push({ rule: "departureWriters", key: keyOf("departure-writer", path, node, site), line: lineOf(path, node), ok });
      return;
    }
    if (create === null) {
      violations.push(`tenant-state  ${lineOf(path, node)}  raw write of tenant_members.deactivated_at outside team-departure.ts`);
      return;
    }
    const ok = create && fn !== null
      && callsBefore(fn, TENANT_LOCKS, node.getStart())
      && callsAfter(fn, new Set(["departCreatedMembership"]), node.getStart());
    sites.push({ rule: "tenantStateWrites", key: keyOf("tenant-state", path, node, site), line: lineOf(path, node), ok });
  };

  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (calleeName(call) === "deleteUser") {
      violations.push(`delete-user  ${lineOf(path, call)}  calls deleteUser (its cascade skips the team lock and the departure)`);
    }
    const mm = modelAndMethod(call);
    if (!mm) continue;

    if (mm.model === "tenantMemberDeparture" && !/^(find|count|aggregate|groupBy)/.test(mm.method)) {
      violations.push(`departure-record  ${lineOf(path, call)}  tenantMemberDeparture.${mm.method} (only deactivateScimUser writes the record, raw, with the database clock)`);
    }

    const tenantWrite = classifyTenantStateWrite(call, mm);
    if (tenantWrite) tenantStateSite(call, tenantWrite.site, tenantWrite.create, namesNullDeactivatedAt(call));

    if (mm.model === "tenantMember" && (mm.method === "delete" || mm.method === "deleteMany")) {
      sites.push({ rule: "tenantRowDeletes", key: keyOf("tenant-row-delete", path, call, `tenantMember.${mm.method}`), line: lineOf(path, call), ok: false });
    }
  }

  for (const raw of rawWrites(sourceFile)) {
    const text = raw.getTemplate().getText();
    if (RAW_TENANT_STATE_WRITE.test(text)) tenantStateSite(raw, "tenant_members.raw", null, RAW_SETS_DEACTIVATED_NULL.test(text));
    if (RAW_TENANT_ROW_DELETE.test(text)) {
      sites.push({ rule: "tenantRowDeletes", key: keyOf("tenant-row-delete", path, raw, "tenant_members.raw"), line: lineOf(path, raw), ok: false });
    }
    const departureRaw = RAW_DEPARTURE_WRITE.exec(text);
    if (departureRaw) {
      const fn = functionName(enclosingFunction(raw));
      const inDeactivate = raw.getAncestors()
        .some((a) => Node.isFunctionLikeDeclaration(a) && functionName(a) === "deactivateScimUser");
      const isDelete = /^DELETE/i.test(departureRaw[1]);
      if (isDelete || path !== "src/lib/services/scim-user-service.ts" || !inDeactivate) {
        violations.push(`departure-record  ${lineOf(path, raw)}  ${departureRaw[1].toUpperCase()} tenant_member_departures in ${fn} (only deactivateScimUser writes it; nothing deletes it)`);
      }
    }
  }
}

for (const { rel: path, sf: sourceFile } of sourceFilesFrom(project, TARGETS, REPO_ROOT)) {
  // Rule 7, bullet 2: repo-wide, runs for every file BEFORE the IMPLEMENTATIONS
  // skip below, so team-departure.ts and the lock modules stay covered.
  checkPendingMarkerRepoWide(sourceFile, path, violations);
  checkRawColumnNameRepoWide(sourceFile, path, violations);
  checkAdmissionModuleBoundary(sourceFile, path, violations);

  checkDepartureClasses(sourceFile, path);
  // Rule 9, also before the skip: team-departure.ts holds two of its sites.
  for (const { node, site, detail } of membershipEnds(sourceFile, path)) {
    const key = keyOf("membership-end", path, node, site);
    sites.push({ rule: "membershipEnds", key, line: lineOf(path, node), ok: revokesAfter(node), detail });
    sites.push({ rule: "footholdEnds", key: keyOf("foothold-end", path, node, site), line: lineOf(path, node), ok: footholdsEndAfter(node), detail });
  }

  for (const { node, site, detail, revokers } of membershipCreations(sourceFile)) {
    const key = keyOf("membership-create", path, node, site);
    sites.push({ rule: "membershipCreations", key, line: lineOf(path, node), ok: revokesAfter(node, revokers), detail });
  }

  if (IMPLEMENTATIONS.has(path)) continue;

  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const mm = modelAndMethod(call);
    if (!mm) continue;

    const memberWrite = classifyMemberWrite(call, mm);
    if (memberWrite) {
      const key = keyOf("member-write", path, call, memberWrite);
      sites.push({ rule: "memberWrites", key, line: lineOf(path, call), ok: covered(sourceFile, call, LOCK_HELPERS) });
    }

    const admission = classifyAdmission(call, mm);
    if (admission) {
      const key = keyOf("admission", path, call, admission);
      sites.push({ rule: "admissions", key, line: lineOf(path, call), ok: covered(sourceFile, call, TENANT_LOCK_OR_WRAPPER) });
    }

    if (path === SCIM_GROUP_SERVICE_FILE) {
      for (const payload of teamMemberWritePayloads(call, mm)) {
        checkAdmissionPayload(path, call, payload, violations);
      }
      for (const { literal, creating, node } of nestedMemberPayloads(call, mm)) {
        checkAdmissionPayload(path, node, { literal, creating }, violations);
      }
    }
  }

  for (const raw of rawWrites(sourceFile)) {
    const text = raw.getTemplate().getText();
    const memberRaw = RAW_MEMBER_WRITE.exec(text);
    if (memberRaw) {
      const key = keyOf("member-write", path, raw, `${memberRaw[2]}.raw`);
      sites.push({ rule: "memberWrites", key, line: lineOf(path, raw), ok: covered(sourceFile, raw, LOCK_HELPERS) });
    }
    if (path === SCIM_GROUP_SERVICE_FILE && RAW_TEAM_MEMBERS_WRITE.test(text)) {
      violations.push(`admission-marker  ${lineOf(path, raw)}  raw write of team_members in scim-group-service.ts (the payload marker cannot be verified)`);
    }
  }

  // Rule 4: per function, the tenant-row lock is one call, outside loops,
  // before any team lock; the transitions next to it are told it is held.
  const fns = sourceFile.getDescendants().filter((n) => Node.isFunctionLikeDeclaration(n));
  for (const fn of fns) {
    const calls = callsIn(fn);
    const tenantLocks = calls.filter((c) => TENANT_LOCKS.has(calleeName(c)));
    if (tenantLocks.length === 0) continue;
    const where = `${path}::${functionName(fn)}`;
    if (tenantLocks.length > 1) {
      violations.push(`lock-order  ${where}  ${tenantLocks.length} tenant-row lock calls in one function (lock every user in one call)`);
    }
    for (const lock of tenantLocks) {
      const loop = lock.getAncestors().find((a) => LOOPS.has(a.getKind()) && fn.containsRange(a.getPos(), a.getEnd()));
      if (loop) violations.push(`lock-order  ${lineOf(path, lock)}  tenant-row lock inside a loop`);
      const teamFirst = calls.find((c) => LOCK_HELPERS.has(calleeName(c)) && !TENANT_LOCK_WRAPPERS.has(calleeName(c)) && c.getStart() < lock.getStart());
      if (teamFirst) violations.push(`lock-order  ${lineOf(path, lock)}  tenant-row lock after a team lock (${lineOf(path, teamFirst)})`);
    }
    for (const transition of calls.filter((c) => TRANSITIONS.has(calleeName(c)))) {
      if (!passesAlreadyLocked(fn, transition.getArguments()[3])) {
        violations.push(`lock-order  ${lineOf(path, transition)}  ${calleeName(transition)} next to a tenant-row lock without alreadyLocked: true`);
      }
    }
  }
}

// Two membership creations with one key (one method in one anonymous callback) are told apart by their payload.
const creationKeyCounts = new Map();
for (const site of sites.filter((s) => s.rule === "membershipCreations")) creationKeyCounts.set(site.key, (creationKeyCounts.get(site.key) ?? 0) + 1);
for (const site of sites) {
  if (site.rule === "membershipCreations" && creationKeyCounts.get(site.key) > 1) site.key = `${site.key}[${site.detail}]`;
}

const problems = [];
const counts = Object.fromEntries(Object.keys(EXPECTED).map((rule) => [rule, sites.filter((s) => s.rule === rule).length]));
if (Object.keys(EXPECTED).some((rule) => counts[rule] !== EXPECTED[rule])) {
  problems.push(
    `site counts ${JSON.stringify(counts)} differ from the pinned ${JSON.stringify(EXPECTED)}. ` +
      `Review the sites that appeared or disappeared, then update EXPECTED:\n` +
      sites.map((s) => `  ${s.line}  ${s.key}`).join("\n"),
  );
}
const membershipEndSites = sites.filter((s) => s.rule === "membershipEnds");
for (const s of membershipEndSites.filter((m) => !m.ok && !EXEMPTIONS.has(m.key))) {
  violations.push(`membership-end  ${s.line}  ${s.key}  ends a tenant membership (${s.detail}) with no revokeUsersAuthArtifactsInTx / revokeUserAuthArtifactsInTx call after it in its function`);
}
const foundEnds = membershipEndSites.map((s) => s.key);
const unexpectedEnds = foundEnds.filter((k) => !EXPECTED_MEMBERSHIP_ENDS.includes(k));
const missingEnds = EXPECTED_MEMBERSHIP_ENDS.filter((k) => !foundEnds.includes(k));
const repeatedEnds = [...new Set(foundEnds.filter((k, i) => foundEnds.indexOf(k) !== i))];
if (unexpectedEnds.length + missingEnds.length + repeatedEnds.length > 0) {
  problems.push(
    `membership-end sites differ from the pinned set (EXPECTED_MEMBERSHIP_ENDS). Review each, then update it:\n` +
      [
        ...unexpectedEnds.map((k) => `  unexpected: ${k}`),
        ...missingEnds.map((k) => `  missing: ${k}`),
        ...repeatedEnds.map((k) => `  repeated: ${k}`),
      ].join("\n"),
  );
}
for (const s of sites.filter((m) => m.rule === "footholdEnds" && !m.ok && !EXEMPTIONS.has(m.key))) {
  violations.push(`foothold-end  ${s.line}  ${s.key}  ends a tenant membership (${s.detail}) with no endCreatorFootholdsInTx call after its revoker call in the same block of its function (the service-account tokens and unapproved vault resets the member minted would stay live)`);
}
const membershipCreationSites = sites.filter((s) => s.rule === "membershipCreations");
for (const s of membershipCreationSites.filter((m) => !m.ok && !EXEMPTIONS.has(m.key))) {
  violations.push(`membership-create  ${s.line}  ${s.key}  creates a tenant membership with no revokeUsersAuthArtifactsInTx / revokeUserAuthArtifactsInTx call after it in its function (an existing user's residue in the tenant would come back with the row; departCreatedMembership covers only a row always created deactivated)`);
}
const foundCreations = membershipCreationSites.map((s) => s.key);
const unexpectedCreations = foundCreations.filter((k) => !EXPECTED_MEMBERSHIP_CREATIONS.includes(k));
const missingCreations = EXPECTED_MEMBERSHIP_CREATIONS.filter((k) => !foundCreations.includes(k));
const repeatedCreations = [...new Set(foundCreations.filter((k, i) => foundCreations.indexOf(k) !== i))];
if (unexpectedCreations.length + missingCreations.length + repeatedCreations.length > 0) {
  problems.push(
    `membership-create sites differ from the pinned set (EXPECTED_MEMBERSHIP_CREATIONS). Review each, then update it:\n` +
      [
        ...unexpectedCreations.map((k) => `  unexpected: ${k}`),
        ...missingCreations.map((k) => `  missing: ${k}`),
        ...repeatedCreations.map((k) => `  repeated: ${k}`),
      ].join("\n"),
  );
}
const uncovered = sites.filter((s) => !s.ok && !EXEMPTIONS.has(s.key) && s.rule !== "membershipEnds" && s.rule !== "membershipCreations" && s.rule !== "footholdEnds");
if (uncovered.length > 0) {
  problems.push(
    `sites without their lock (a member-set write needs a team lock before it; an admission a tenant-row lock; ` +
      `a tenant active-state write belongs in team-departure.ts and there needs its clearing or an endTeamMemberships call after it; ` +
    `a tenant-row delete needs a reviewed exemption):\n` +
      uncovered.map((s) => `  ${s.line}  ${s.key}`).join("\n"),
  );
}
if (violations.length > 0) problems.push(`violations:\n${violations.map((v) => `  ${v}`).join("\n")}`);
const badExemptions = [...EXEMPTIONS.keys()].filter((k) => sites.filter((s) => s.key === k).length !== 1);
if (badExemptions.length > 0) {
  problems.push(`exemption(s) matching no site, or several — make each match exactly one:\n${badExemptions.map((k) => `  ${k}`).join("\n")}`);
}
if (problems.length > 0) {
  for (const p of problems) console.error(`\nFAIL: ${p}`);
  process.exit(1);
}
console.log(`check-team-rotation-input-lock: OK ${JSON.stringify({ ...counts, membershipEnds: foundEnds.length, footholdEnds: sites.filter((s) => s.rule === "footholdEnds").length, membershipCreations: foundCreations.length })}`);
