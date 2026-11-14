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
 *    `departCreatedMembership` in the same function.
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
 * 8. GRANT RECIPIENTS (departed-member-leaked-authority-deviation.md D8). A
 *    leftover membership (an active team row whose user's tenant row departed
 *    at or after its admission) receives no grant. This rule is a review
 *    tripwire over the spellings this codebase uses, with the pinned count as
 *    the backstop for a new site — not a proof (KNOWN LIMITS below). A grant
 *    is:
 *    - a `teamMember` update/updateMany/updateManyAndReturn whose `data` (an
 *      `upsert`'s `update`) names `role`, has a computed key, or sets
 *      `keyDistributed` to anything but the literal `false`;
 *    - any `teamMemberKey` create/createMany/createManyAndReturn/upsert/
 *      update/updateMany/updateManyAndReturn;
 *    - an update/updateMany/upsert of a parent naming a relation to those
 *      tables (schema.prisma): `team` `members`/`memberKeys`, `user`
 *      `teamMemberships`/`teamMemberKeys`, `tenant` `teamMembers`/
 *      `teamMemberKeys` (a parent's create is not counted: its nested
 *      creates are new rows — but see KNOWN LIMITS for `connect`);
 *    - a raw `UPDATE team_members` naming `role =` or `key_distributed =
 *      true`, or `INSERT INTO team_member_keys`.
 *    Read from literals, an update is no grant when it reaches no active row
 *    (`where` names `deactivatedAt: { not: null }` or `scimApprovalPending:
 *    true`, or `data` sets `deactivatedAt: new Date(...)`) or only demotes
 *    (`where` and `data` name literal roles, the data's ranked strictly lower;
 *    an equal rank counts as a grant).
 *
 *    Each grant must follow a RECIPIENT CHECK in its function, or in every
 *    same-file caller: a call of `actorDepartedSinceAdmission` that does not
 *    judge the acting member (its row is not keyed `session.user.id`, its
 *    admission is not an `activeTeamAdmission` result), or of a same-file
 *    helper whose EVERY return returns such a call's result (`return
 *    pred(...)`, or a top-level `||` disjunct of the returned value), with at
 *    least one return and a body ending in a `return` or `throw`. The check
 *    must EXIT ON TRUE before the grant: the call (awaited or not) is an if-test or a
 *    top-level `||` disjunct of one, the consequent is or begins with an
 *    unconditional `return` / `throw`, and the if-statement sits in a block
 *    (or the file) that holds the grant, earlier — not in a branch, loop, try
 *    or callback the grant is outside of. A bare call, `!pred`, `x && pred`, a
 *    ternary or a stored result is no check. It JUDGES EVERY RECIPIENT: each value of an
 *    `id` / `userId` key in the grant's where/data/create/update (for a team /
 *    tenant write, inside the nested relation only; a caller's argument for a
 *    parameter), or each interpolation of a raw template, is one recipient, and each needs a check whose arguments, or
 *    the declaration of whose admission argument, read every variable that
 *    value reads; one check covers two recipients only by naming both. A
 *    recipient set the gate cannot list one by one is UNRESOLVED and covered
 *    by no check: a `createMany` over a mapped array or a variable, an
 *    unreadable or spread payload, an unbounded `in`, or a
 *    grant with no recipient key at all. The
 *    tenant-row map's declaration is not followed (one lock call holds the
 *    actor's and the target's rows). A check naming none of a recipient's
 *    variables (the owner route's "is there an active OWNER", over `o`) does
 *    not cover it. Only a
 *    plain value, `equals: x` or a one-element `in: [x]` names a recipient: a
 *    `not` / `notIn` / wider `in` / unreadable operator, or a key under `NOT`
 *    / `OR`, names everyone-but or one-of-several, which no check covers.
 *    Admissions (a re-activation stamps a fresh admitted_at), demotions the
 *    literals cannot show, recipients checked by set, and unreadable payloads
 *    read by hand are EXEMPTIONS.
 *
 *    KNOWN LIMITS (rule 8):
 *    - Names. The tie is by variable name, one declaration deep; two names
 *      for one person are not followed, one name for two is not split. An
 *      `id` under a relation that is not the member's (`team: { id: teamId }`)
 *      is read as a recipient name. Following the admission argument's
 *      declaration ties any mention there, a negated one included (`findFirst
 *      ({ where: { NOT: { id: memberId } } })` ties `memberId`). An operator
 *      object held in a variable (`id: filter`, `filter = { not: x }`) is
 *      read as the name `filter`. (A whole `where` held in a variable names
 *      no recipient: that site is uncovered, not tied.)
 *    - Raw SQL. Seen only as a `$queryRaw` / `$executeRaw` TAGGED template,
 *      and only `UPDATE team_members` naming `role =` or `key_distributed =
 *      true`, and `INSERT INTO team_member_keys`. Not seen: the call form
 *      `$executeRaw(Prisma.sql\`…\`)`, a `Prisma.sql` fragment composed
 *      elsewhere, `*Unsafe`; a non-literal `key_distributed = ${x}`; a role
 *      written by `INSERT … ON CONFLICT DO UPDATE`, `MERGE`, or a
 *      row-constructor `SET (role, …) = (…)`.
 *    - Nested writes. Seen one level deep, through `team` / `user` / `tenant`
 *      update/updateMany/upsert only: a deeper path, another parent model,
 *      and a parent CREATE are not counted — a create's nested `connect`
 *      re-parents an existing member row without being a grant here.
 *    - Model access. Seen only as `x.teamMember.method(...)` (any receiver
 *      `x`): element access (`tx["teamMember"]`), parentheses, a non-null
 *      assertion, destructuring, `.call` / `.apply` and an alias are not.
 *    - Shapes. A role is read by its last name (`X.OWNER` for any `X`). A
 *      write re-pointing a row (`data: { userId }`) is not a grant here.
 *    - Callers. Coverage through callers counts same-file call expressions
 *      only: a function passed by reference, a destructured parameter, and
 *      callers in other files are not followed.
 *
 * A `data` / `update` that is not an object literal (an identifier, a spread)
 * cannot be read, so it counts: the gate refuses rather than skips what it
 * cannot see. Reviewed sites are listed in EXEMPTIONS; each key must match
 * exactly one site. Two grants sharing a key (one method in one anonymous
 * callback) carry their payload's text in it: `…::teamMember.updateMany[{
 * role: result.data.role }]`.
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
 * Exit 0 = clean. Exit 1 = a violation, a stale exemption, or site counts that
 * differ from the pinned ones (a scan that lost sites, or a site to review).
 */
import { Node, SyntaxKind } from "ts-morph";
import { join, dirname, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { createAstProject, sourceFilesFrom, unresolvedTargets } from "./lib/ast-project.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.TEAM_ROTATION_INPUT_LOCK_ROOT ?? join(__dirname, "..", "..");
const TARGETS = (process.env.TEAM_ROTATION_INPUT_LOCK_TARGETS ?? "src/app,src/lib,src/workers,src/auth.ts").split(",");

/** The implementations: their raw SQL IS the lock, the departure and the return. */
const IMPLEMENTATIONS = new Set([
  "src/lib/team/team-key-rotation-lock.ts",
  "src/lib/team/team-departure.ts",
  "src/lib/team/tenant-row-lock.ts",
]);

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
 * departed-member-leaked-authority (rule 8): grants 13 — 4 recipient-checked,
 * 9 exempted (3 of them `user` / `tenant` updates whose data cannot be read,
 * counted since the nested-relation arm covers those models).
 */
const EXPECTED = {
  memberWrites: Number(process.env.TEAM_ROTATION_INPUT_LOCK_WRITES ?? 21),
  tenantStateWrites: Number(process.env.TEAM_ROTATION_INPUT_LOCK_TENANT_WRITES ?? 2),
  admissions: Number(process.env.TEAM_ROTATION_INPUT_LOCK_ADMISSIONS ?? 7),
  grants: Number(process.env.TEAM_ROTATION_INPUT_LOCK_GRANTS ?? 13),
};

/** Sites keyed `<rule>::<path>::<enclosing function>::<site>`, with the review's conclusion. */
const EXEMPTIONS = new Map([
  [
    "member-write::src/app/api/teams/[teamId]/rotate-key/route.ts::<anonymous>::teamMember.updateMany",
    "rotation itself: its transaction holds the team row FOR NO KEY UPDATE (inline), the lock every other writer waits on",
  ],
  [
    "grant::src/app/api/teams/[teamId]/members/route.ts::<anonymous>::teamMember.update",
    "admission: re-activates a deactivated row (an active one throws AlreadyMemberError first, under the target's tenant-row lock and the team lock); the re-activation stamps a fresh admitted_at (trigger), so the row is no leftover",
  ],
  [
    "grant::src/app/api/teams/invitations/accept/route.ts::<anonymous>::teamMember.upsert",
    "admission: creates or re-activates the invitee's row (an active one returns ALREADY_MEMBER first, under the invitee's tenant-row lock and the team lock); the re-activation stamps a fresh admitted_at (trigger)",
  ],
  [
    "grant::src/lib/services/scim-group-service.ts::applyAddOperations::teamMember.updateManyAndReturn",
    "demotion only: toUpdateRoleByPreviousRole holds the rows whose group role ranks strictly below their current one (a raise goes to toHoldByPreviousRole, which deactivates)",
  ],
  [
    "grant::src/app/api/teams/[teamId]/rotate-key/route.ts::<anonymous>::teamMemberKey.createMany",
    "recipients named by the request (memberKeys[].userId), checked by set: every key must name a member of memberUserIds, which excludes the leftoverUserIds its recipient check filters out (rotate-key route.test.ts \"refuses a key supplied for a leftover key-holder\")",
  ],
  [
    "grant::src/app/api/teams/[teamId]/members/[memberId]/route.ts::<anonymous>::teamMember.updateMany[{ role: result.data.role }]",
    "member PUT role change: `if (isRoleAbove(new, old) && await targetIsLeftover(...)) throw` refuses a leftover only for a promotion; a demotion of a leftover is allowed by design (D8: it reduces authority), so the check is a conjunction rule 8 does not count. Pinned by route.test.ts \"a target who left the tenant, judged against their admission to the team\": \"refuses (404 MEMBER_NOT_FOUND) promoting a target whose tenant row departed after their admission\", \"refuses promoting a target whose departure equals their admission\", \"refuses promoting a target whose departure record (row deleted) postdates their admission\", \"allows demoting a leftover target: it reduces authority\"",
  ],
  [
    "grant::src/app/api/teams/[teamId]/route.ts::<anonymous>::team.update",
    "unreadable data, read by hand: updateData carries name and description only (updateTeamSchema), no nested members or memberKeys",
  ],
  [
    "grant::src/app/api/tenant/policy/route.ts::<anonymous>::tenant.update",
    "unreadable data, read by hand: updateData is assigned only named policy columns (updateData.<column> = …), never teamMembers or teamMemberKeys",
  ],
  [
    "grant::src/lib/auth/session/auth-adapter.ts::<anonymous>::user.update",
    "unreadable data, read by hand: updateUser's `rest` is Auth.js's Partial<AdapterUser> (name, email, image, emailVerified), no relation fields",
  ],
  [
    "grant::src/lib/vault/rotate-key-server.ts::applyVaultRotation::user.update",
    "unreadable data (a conditional spread), read by hand: the spread adds passphraseVerifierHmac/passphraseVerifierVersion only; the rest are vault-wrapping columns, no teamMemberships or teamMemberKeys",
  ],
]);

const RAW_MEMBER_WRITE = /\b(DELETE\s+FROM|UPDATE)\s+(?:"?\w+"?\.)?"?(team_members|team_member_keys)"?\b/i;
const RAW_TENANT_STATE_WRITE = /\b(UPDATE|INSERT\s+INTO)\s+(?:"?\w+"?\.)?"?tenant_members"?\b[\s\S]*\bdeactivated_at\b/i;
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

// ── Rule 8: grant recipients (departed-member-leaked-authority-deviation.md D8) ──

const RAW_ROLE_GRANT = /\bUPDATE\s+(?:"?\w+"?\.)?"?team_members"?\b[\s\S]*\b"?role"?\s*=/i;
const RAW_KEY_DISTRIBUTED_GRANT = /\bUPDATE\s+(?:"?\w+"?\.)?"?team_members"?\b[\s\S]*\b"?key_distributed"?\s*=\s*true\b/i;
const RAW_MEMBER_KEY_INSERT = /\bINSERT\s+INTO\s+(?:"?\w+"?\.)?"?team_member_keys"?\b/i;
const RECIPIENT_PREDICATE = "actorDepartedSinceAdmission";
/** The acting member's re-read (team-auth.ts); a check of its result judges the actor, not a recipient. */
const ACTOR_ADMISSION_READ = "activeTeamAdmission";

/**
 * Whether a `data` / `update` literal grants: names `role` (or has a computed
 * key), or sets `keyDistributed` to anything but the literal `false`.
 */
function grants(literal) {
  if (literal === undefined) return false;
  if (mayNameOrCompute(literal, ["role"])) return true;
  const p = findProp(literal, "keyDistributed");
  if (!p) return false;
  return !Node.isPropertyAssignment(p) || p.getInitializer()?.getText() !== "false";
}

/** `mayName`, also counting a computed key (`{ ["role"]: … }`) as one that may name any of `keys`. */
function mayNameOrCompute(literal, keys) {
  if (literal && literal.getProperties().some((p) => Node.isPropertyAssignment(p) && Node.isComputedPropertyName(p.getNameNode()))) return true;
  return mayName(literal, keys);
}

/**
 * Whether an update reaches no active row, read from literals only: its
 * `where` names `deactivatedAt: { not: null }` or `scimApprovalPending: true`
 * (a pending row is deactivated, CHECK in 20261103000000), or its `data` sets
 * `deactivatedAt: new Date(...)` (the row it writes ends inactive).
 */
function reachesNoActiveRow(call) {
  const where = rawProp(call.getArguments()[0], "where");
  if (where && Node.isObjectLiteralExpression(where)) {
    const deactivatedAt = rawProp(where, "deactivatedAt");
    if (deactivatedAt && Node.isObjectLiteralExpression(deactivatedAt) && rawProp(deactivatedAt, "not")?.getText() === "null") return true;
    if (rawProp(where, "scimApprovalPending")?.getText() === "true") return true;
  }
  const deactivatedAt = rawProp(argProp(call, "data"), "deactivatedAt");
  return deactivatedAt !== null && deactivatedAt !== undefined && Node.isNewExpression(deactivatedAt);
}

const ROLE_RANK = { OWNER: 3, ADMIN: 2, MEMBER: 1, VIEWER: 0 };

/** `TEAM_ROLE.X` or `"X"` as a known role, else null. */
function roleLiteral(node) {
  if (!node) return null;
  const name = Node.isStringLiteral(node) ? node.getLiteralText() : Node.isPropertyAccessExpression(node) ? node.getName() : null;
  return name !== null && name in ROLE_RANK ? name : null;
}

/**
 * Whether an update only demotes: its `where` and `data` name literal roles,
 * the data's ranked strictly lower. An equal rank counts as a grant.
 */
function demotesOnly(call) {
  const data = argProp(call, "data");
  if (!data || mayName(data, ["keyDistributed"])) return false;
  const from = roleLiteral(rawProp(rawProp(call.getArguments()[0], "where"), "role"));
  const to = roleLiteral(rawProp(data, "role"));
  return from !== null && to !== null && ROLE_RANK[to] < ROLE_RANK[from];
}

/** The relation fields (schema.prisma) through which a write of the parent writes team_members / team_member_keys. */
const NESTED_GRANT_RELATIONS = {
  team: ["members", "memberKeys"],
  user: ["teamMemberships", "teamMemberKeys"],
  tenant: ["teamMembers", "teamMemberKeys"],
};

function classifyGrant(call, mm) {
  const { model, method } = mm;
  const site = `${model}.${method}`;
  if (model === "teamMemberKey" && ["create", "createMany", "createManyAndReturn", "upsert", "update", "updateMany", "updateManyAndReturn"].includes(method)) return site;
  // A nested write from a parent that exists (a create's nested rows are new ones).
  const relations = NESTED_GRANT_RELATIONS[model];
  if (relations && ["update", "updateMany", "upsert"].includes(method)
    && mayNameOrCompute(argProp(call, method === "upsert" ? "update" : "data"), relations)) return site;
  if (model !== "teamMember") return null;
  if ((method === "update" || method === "updateMany" || method === "updateManyAndReturn")
    && grants(argProp(call, "data")) && !reachesNoActiveRow(call) && !demotesOnly(call)) return site;
  if (method === "upsert" && grants(argProp(call, "update"))) return site;
  return null;
}

/** The declaration of `name` visible from `node`: the innermost enclosing function that declares it. */
function declarationOf(node, name) {
  for (let fn = enclosingFunction(node); fn; fn = enclosingFunction(fn)) {
    const decl = fn.getDescendantsOfKind(SyntaxKind.VariableDeclaration)
      .find((d) => d.getName() === name && enclosingFunction(d) === fn);
    if (decl) return decl;
  }
  return node.getSourceFile().getVariableDeclaration(name) ?? null;
}

function rootIdentifier(expr) {
  let cur = expr;
  while (cur && (Node.isPropertyAccessExpression(cur) || Node.isBinaryExpression(cur) || Node.isParenthesizedExpression(cur))) {
    cur = Node.isBinaryExpression(cur) ? cur.getLeft() : cur.getExpression();
  }
  return cur && Node.isIdentifier(cur) ? cur.getText() : null;
}

/** The variables an expression reads: identifiers that are not a property name or a property key. */
function namesIn(node) {
  if (!node) return [];
  const ids = Node.isIdentifier(node) ? [node] : node.getDescendantsOfKind(SyntaxKind.Identifier);
  return ids.filter((id) => {
    const parent = id.getParent();
    if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === id) return false;
    if (Node.isPropertyAssignment(parent) && parent.getNameNode() === id) return false;
    return true;
  }).map((id) => id.getText());
}

const RECIPIENT_KEYS = new Set(["id", "userId"]);
const NEGATING_FILTERS = new Set(["NOT", "OR"]);
/** A recipient no variable names (everyone but x, one of several): no check ties to it. */
const UNRESOLVED = "\u0000unresolved";

/**
 * The variables one `id` / `userId` value names: a plain value, `equals: x`,
 * or `in: [x]` with one element. Any other operator object (`not`, `notIn`,
 * a wider `in`, a spread, a computed key) is UNRESOLVED.
 */
function recipientValueNames(value) {
  if (!value) return [UNRESOLVED];
  if (!Node.isObjectLiteralExpression(value)) return namesIn(value);
  const props = value.getProperties();
  if (props.length !== 1 || !Node.isPropertyAssignment(props[0]) || Node.isComputedPropertyName(props[0].getNameNode())) return [UNRESOLVED];
  const op = propertyKeyName(props[0]);
  const operand = props[0].getInitializer();
  if (op === "equals") return namesIn(operand);
  if (op === "in" && operand && Node.isArrayLiteralExpression(operand) && operand.getElements().length === 1) {
    const [el] = operand.getElements();
    if (Node.isIdentifier(el) || Node.isPropertyAccessExpression(el)) return namesIn(el);
  }
  return [UNRESOLVED];
}

/** Whether a write payload is unreadable: not an object literal (or an array of them) free of spreads. */
function unreadablePayload(node) {
  if (node === undefined) return false;
  const readable = (n) => n && Node.isObjectLiteralExpression(n) && !n.getProperties().some((p) => Node.isSpreadAssignment(p));
  if (node && Node.isArrayLiteralExpression(node)) return !node.getElements().every(readable);
  return !readable(node);
}

/** The containers whose `id` / `userId` keys name a grant's recipients, and whether one cannot be read. */
function recipientContainers(call) {
  const mm = modelAndMethod(call);
  const arg = call.getArguments()[0];
  const relations = mm && NESTED_GRANT_RELATIONS[mm.model];
  if (relations && mm.model !== "user") {
    // A team / tenant write: its own `where` names the parent, not a member.
    const payload = rawProp(arg, mm.method === "upsert" ? "update" : "data");
    if (!payload || !Node.isObjectLiteralExpression(payload)) return { containers: [], unreadable: true };
    const nested = relations.map((r) => rawProp(payload, r)).filter((n) => n !== undefined);
    return { containers: nested, unreadable: nested.some((n) => n === null || !Node.isObjectLiteralExpression(n)) };
  }
  const keys = ["where", "data", "create", "update"];
  const containers = keys.map((k) => rawProp(arg, k)).filter((n) => n !== undefined);
  const creating = mm && ["create", "createMany", "createManyAndReturn"].includes(mm.method);
  const unreadable = containers.includes(null)
    || unreadablePayload(rawProp(arg, "where"))
    || (creating && unreadablePayload(rawProp(arg, "data")))
    || (mm?.method === "upsert" && unreadablePayload(rawProp(arg, "create")));
  return { containers, unreadable };
}

/**
 * Who a grant reaches, one entry per recipient, each the variables it is named
 * by: the value of every `id` / `userId` key in its `where` / `data` /
 * `create` / `update` (for a team / tenant write, inside the nested relation
 * only), or every interpolation of a raw template. UNRESOLVED stands for a
 * recipient no variable names one by one: a key under `NOT` / `OR`, a value
 * from recipientValueNames' refusals, a literal, an unreadable payload or
 * nested write (a mapped or variable array among them), or no recipient key
 * at all.
 */
function recipients(node) {
  if (Node.isTaggedTemplateExpression(node)) {
    const template = node.getTemplate();
    const spans = Node.isTemplateExpression(template) ? template.getTemplateSpans().map((sp) => namesIn(sp.getExpression())) : [];
    return spans.length === 0 ? [[UNRESOLVED]] : spans.map((n) => (n.length === 0 ? [UNRESOLVED] : n));
  }
  const { containers, unreadable } = recipientContainers(node);
  const found = unreadable ? [[UNRESOLVED]] : [];
  for (const container of containers) {
    if (!container) continue;
    for (const p of [...container.getDescendantsOfKind(SyntaxKind.PropertyAssignment), ...container.getDescendantsOfKind(SyntaxKind.ShorthandPropertyAssignment)]) {
      const key = propertyKeyName(p);
      if ((key === "create" || key === "data") && Node.isPropertyAssignment(p) && unreadablePayload(p.getInitializer())) {
        found.push([UNRESOLVED]);
        continue;
      }
      if (!RECIPIENT_KEYS.has(key)) continue;
      const negated = p.getAncestors().some((a) => container.containsRange(a.getPos(), a.getEnd())
        && Node.isPropertyAssignment(a) && NEGATING_FILTERS.has(propertyKeyName(a)));
      const value = Node.isShorthandPropertyAssignment(p) ? p.getNameNode() : p.getInitializer();
      const names = negated ? [UNRESOLVED] : recipientValueNames(value);
      found.push(names.length === 0 ? [UNRESOLVED] : names);
    }
  }
  return found.length === 0 ? [[UNRESOLVED]] : found;
}

/**
 * A call of the predicate that judges someone other than the acting member:
 * not keyed by `session.user.id`, and not of an `activeTeamAdmission` result.
 */
function isRecipientCheck(call) {
  if (calleeName(call) !== RECIPIENT_PREDICATE) return false;
  const [row, admittedAt] = call.getArguments();
  if (row && Node.isCallExpression(row) && row.getArguments()[0]?.getText() === "session.user.id") return false;
  const root = admittedAt ? rootIdentifier(admittedAt) : null;
  const init = root ? declarationOf(call, root)?.getInitializer() : undefined;
  const read = init && Node.isAwaitExpression(init) ? init.getExpression() : init;
  return !(read && Node.isCallExpression(read) && calleeName(read) === ACTOR_ADMISSION_READ);
}

function unwrap(expr) {
  let cur = expr;
  while (cur && (Node.isParenthesizedExpression(cur) || Node.isAwaitExpression(cur))) cur = cur.getExpression();
  return cur;
}

/** The top-level `||` disjuncts of an expression, unwrapped (`a || (await b) || c` → a, b, c). */
function disjuncts(expr) {
  const e = unwrap(expr);
  if (e && Node.isBinaryExpression(e) && e.getOperatorToken().getKind() === SyntaxKind.BarBarToken) {
    return [...disjuncts(e.getLeft()), ...disjuncts(e.getRight())];
  }
  return [e];
}

/**
 * The if-statement whose TRUE outcome for `call` exits: `call` (awaited or
 * parenthesised) is the test or a top-level `||` disjunct of it, and the
 * consequent is, or begins with, an unconditional `return` / `throw`. A
 * negation, a conjunction, a ternary or a stored result is no such shape.
 */
function exitGuard(call) {
  let cur = call;
  for (let parent = cur.getParent(); parent; cur = parent, parent = parent.getParent()) {
    if (Node.isParenthesizedExpression(parent) || Node.isAwaitExpression(parent)) continue;
    if (Node.isBinaryExpression(parent) && parent.getOperatorToken().getKind() === SyntaxKind.BarBarToken) continue;
    if (!Node.isIfStatement(parent) || parent.getExpression() !== cur) return null;
    const then = parent.getThenStatement();
    const first = Node.isBlock(then) ? then.getStatements()[0] : then;
    return first && (Node.isReturnStatement(first) || Node.isThrowStatement(first)) ? parent : null;
  }
  return null;
}

/**
 * Whether a guard runs before `node` on every path: the guard is a statement
 * of a list (block or file) that also holds `node`, at an earlier position —
 * not in a branch, loop body, try block or callback `node` is outside of.
 */
function dominates(guard, node) {
  const list = guard.getParent();
  return (Node.isBlock(list) || Node.isSourceFile(list))
    && list.containsRange(node.getPos(), node.getEnd()) && guard.getEnd() <= node.getStart();
}

/**
 * Same-file functions whose every exit returns a recipient check's result
 * (`return pred(...)`, or a top-level `||` disjunct of the returned value) or
 * throws, so a TRUE from the predicate is a TRUE from the helper: at least
 * one return, every return such a value, and a block body ending in a
 * `return` or `throw` (no fall-through). A helper with an early `return
 * false`, a bare `return`, or one that drops or inverts the predicate's
 * result is not one.
 */
function recipientCheckHelpers(sourceFile) {
  const names = new Set();
  for (const fn of sourceFile.getDescendants().filter((n) => Node.isFunctionLikeDeclaration(n))) {
    const name = functionName(fn);
    if (name === "<anonymous>" || name === "<module>") continue;
    const body = fn.getBody();
    if (!body) continue;
    const concise = !Node.isBlock(body);
    const returned = concise
      ? [body]
      : fn.getDescendantsOfKind(SyntaxKind.ReturnStatement).filter((r) => enclosingFunction(r) === fn).map((r) => r.getExpression());
    const last = concise ? null : body.getStatements().at(-1);
    const endsInExit = concise || (last !== undefined && (Node.isReturnStatement(last) || Node.isThrowStatement(last)));
    const returnsCheck = (e) => e !== undefined && disjuncts(e).some((d) => d && Node.isCallExpression(d) && isRecipientCheck(d));
    if (returned.length > 0 && returned.every(returnsCheck) && endsInExit) names.add(name);
  }
  return names;
}

/**
 * Who a check judges: the variables its arguments read, and those the
 * declaration of its admission argument's root reads (one level: the member
 * row re-read by `memberId`). The tenant-row map's declaration is not
 * followed: one lock call reads the actor's and the target's rows together.
 */
function checkedNames(call) {
  const names = new Set(call.getArguments().flatMap(namesIn));
  if (isRecipientCheck(call)) {
    const root = rootIdentifier(call.getArguments()[1]);
    for (const m of root ? namesIn(declarationOf(call, root)?.getInitializer()) : []) names.add(m);
  }
  names.delete("tx");
  return names;
}

/**
 * Whether every recipient (a list of the variables it is named by) is judged
 * by a recipient check in `fn` that exits on TRUE before `node` on every path
 * (exitGuard, dominates): each recipient by a check naming every variable it
 * is named by, so one check covers two recipients only by naming both.
 */
function checksRecipientsBefore(fn, helpers, node, recipientList) {
  const checks = fn.getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((c) => isRecipientCheck(c) || helpers.has(calleeName(c)))
    .filter((c) => {
      const guard = exitGuard(c);
      return guard !== null && dominates(guard, node);
    })
    .map(checkedNames);
  return recipientList.every((names) => checks.some((checked) => names.every((n) => checked.has(n))));
}

/**
 * Rule 8's `covered`: a check of each of the grant's recipients precedes it
 * in its function, or in every same-file caller's (a recipient the function
 * names by a parameter is named by that caller's argument).
 */
function recipientChecked(sourceFile, node, helpers) {
  const fn = enclosingFunction(node);
  if (fn === null) return false;
  const recipientList = recipients(node);
  if (recipientList.some((names) => names.includes(UNRESOLVED))) return false;
  if (checksRecipientsBefore(fn, helpers, node, recipientList)) return true;
  const name = functionName(fn);
  if (name === "<anonymous>" || name === "<module>") return false;
  const params = fn.getParameters().map((p) => p.getName());
  const calls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression).filter((c) => calleeName(c) === name);
  return calls.length > 0 && calls.every((c) => {
    const caller = enclosingFunction(c);
    const callerList = recipientList.map((names) => names.flatMap((n) => (params.includes(n) ? namesIn(c.getArguments()[params.indexOf(n)]) : [n])));
    if (callerList.some((names) => names.length === 0)) return false;
    return caller !== null && checksRecipientsBefore(caller, helpers, c, callerList);
  });
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

for (const { rel: path, sf: sourceFile } of sourceFilesFrom(project, TARGETS, REPO_ROOT)) {
  // Rule 7, bullet 2: repo-wide, runs for every file BEFORE the IMPLEMENTATIONS
  // skip below, so team-departure.ts and the lock modules stay covered.
  checkPendingMarkerRepoWide(sourceFile, path, violations);
  checkRawColumnNameRepoWide(sourceFile, path, violations);
  checkAdmissionModuleBoundary(sourceFile, path, violations);

  if (IMPLEMENTATIONS.has(path)) continue;
  const checkHelpers = recipientCheckHelpers(sourceFile);

  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const name = calleeName(call);
    if (name === "deleteUser") {
      violations.push(`delete-user  ${lineOf(path, call)}  calls deleteUser (its cascade skips the team lock and the departure)`);
    }
    const mm = modelAndMethod(call);
    if (!mm) continue;

    if (mm.model === "tenantMemberDeparture" && !/^(find|count|aggregate|groupBy)/.test(mm.method)) {
      violations.push(`departure-record  ${lineOf(path, call)}  tenantMemberDeparture.${mm.method} (only deactivateScimUser writes the record, raw, with the database clock)`);
    }

    const memberWrite = classifyMemberWrite(call, mm);
    if (memberWrite) {
      const key = keyOf("member-write", path, call, memberWrite);
      sites.push({ rule: "memberWrites", key, line: lineOf(path, call), ok: covered(sourceFile, call, LOCK_HELPERS) });
    }

    const tenantWrite = classifyTenantStateWrite(call, mm);
    if (tenantWrite) {
      const key = keyOf("tenant-state", path, call, tenantWrite.site);
      const fn = enclosingFunction(call);
      const ok = tenantWrite.create && fn !== null
        && callsBefore(fn, TENANT_LOCKS, call.getStart())
        && callsAfter(fn, new Set(["departCreatedMembership"]), call.getStart());
      sites.push({ rule: "tenantStateWrites", key, line: lineOf(path, call), ok });
    }

    const admission = classifyAdmission(call, mm);
    if (admission) {
      const key = keyOf("admission", path, call, admission);
      sites.push({ rule: "admissions", key, line: lineOf(path, call), ok: covered(sourceFile, call, TENANT_LOCK_OR_WRAPPER) });
    }

    const grant = classifyGrant(call, mm);
    if (grant) {
      const key = keyOf("grant", path, call, grant);
      const payload = rawProp(call.getArguments()[0], mm.method === "upsert" ? "update" : "data");
      sites.push({ rule: "grants", key, line: lineOf(path, call), ok: recipientChecked(sourceFile, call, checkHelpers), detail: compact(payload) });
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
    const rawGrant = RAW_MEMBER_KEY_INSERT.test(text)
      ? "team_member_keys.raw"
      : RAW_ROLE_GRANT.test(text) || RAW_KEY_DISTRIBUTED_GRANT.test(text) ? "team_members.raw" : null;
    if (rawGrant) {
      const key = keyOf("grant", path, raw, rawGrant);
      sites.push({ rule: "grants", key, line: lineOf(path, raw), ok: recipientChecked(sourceFile, raw, checkHelpers), detail: compact(raw.getTemplate()) });
    }
    if (RAW_TENANT_STATE_WRITE.test(text)) {
      violations.push(`tenant-state  ${lineOf(path, raw)}  raw write of tenant_members.deactivated_at outside team-departure.ts`);
    }
    if (path === SCIM_GROUP_SERVICE_FILE && RAW_TEAM_MEMBERS_WRITE.test(text)) {
      violations.push(`admission-marker  ${lineOf(path, raw)}  raw write of team_members in scim-group-service.ts (the payload marker cannot be verified)`);
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

// Two grants with one key (the same method in one anonymous callback) are told
// apart by their payload: `…::teamMember.updateMany[{ role: result.data.role }]`.
const grantKeyCounts = new Map();
for (const site of sites.filter((s) => s.rule === "grants")) grantKeyCounts.set(site.key, (grantKeyCounts.get(site.key) ?? 0) + 1);
for (const site of sites) {
  if (site.rule === "grants" && grantKeyCounts.get(site.key) > 1) site.key = `${site.key}[${site.detail}]`;
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
const uncovered = sites.filter((s) => !s.ok && !EXEMPTIONS.has(s.key));
if (uncovered.length > 0) {
  problems.push(
    `sites without their lock (a member-set write needs a team lock before it; an admission a tenant-row lock; ` +
      `a tenant active-state write belongs in team-departure.ts; a grant needs a recipient check before it):\n` +
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
console.log(`check-team-rotation-input-lock: OK ${JSON.stringify(counts)}`);
