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
 */
const EXPECTED = {
  memberWrites: Number(process.env.TEAM_ROTATION_INPUT_LOCK_WRITES ?? 21),
  tenantStateWrites: Number(process.env.TEAM_ROTATION_INPUT_LOCK_TENANT_WRITES ?? 2),
  admissions: Number(process.env.TEAM_ROTATION_INPUT_LOCK_ADMISSIONS ?? 7),
};

/** Sites keyed `<rule>::<path>::<enclosing function>::<site>`, with the review's conclusion. */
const EXEMPTIONS = new Map([
  [
    "member-write::src/app/api/teams/[teamId]/rotate-key/route.ts::<anonymous>::teamMember.updateMany",
    "rotation itself: its transaction holds the team row FOR NO KEY UPDATE (inline), the lock every other writer waits on",
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

/** The object literal of `prop` in an object, `undefined` when absent, `null` when unreadable. */
function propOf(obj, prop) {
  if (!obj || !Node.isObjectLiteralExpression(obj)) return null;
  if (obj.getProperties().some((p) => Node.isSpreadAssignment(p))) return null;
  const p = obj.getProperty(prop);
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
  return keys.some((k) => literal.getProperty(k) !== undefined);
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
  const p = data.getProperty("deactivatedAt");
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
  const p = literal.getProperty("alreadyLocked");
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
  const p = obj.getProperty(prop);
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
    const membersProp = literal.getProperty("members");
    if (!membersProp || !Node.isPropertyAssignment(membersProp)) return;
    const init = membersProp.getInitializer();
    if (!init || !Node.isObjectLiteralExpression(init)) {
      out.push({ literal: null, creating: true, node: membersProp });
      return;
    }
    const createProp = init.getProperty("create");
    if (createProp && Node.isPropertyAssignment(createProp)) {
      out.push({ literal: asObject(createProp.getInitializer()) ?? null, creating: true, node: createProp });
    }
    const createManyProp = init.getProperty("createMany");
    if (createManyProp && Node.isPropertyAssignment(createManyProp)) {
      const data = rawProp(createManyProp.getInitializer(), "data");
      for (const literal of createElements(data)) out.push({ literal, creating: true, node: createManyProp });
    }
    const connectOrCreateProp = init.getProperty("connectOrCreate");
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
  const deactivatedAt = literal.getProperty("deactivatedAt");
  const namesNull = deactivatedAt !== undefined
    && Node.isPropertyAssignment(deactivatedAt)
    && deactivatedAt.getInitializer()?.getText() === "null";
  if (namesNull) {
    violations.push(`admission-marker  ${lineOf(path, node)}  team_members payload names deactivatedAt: null`);
  }
  if (creating) {
    const marker = literal.getProperty("scimApprovalPending");
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
      `a tenant active-state write belongs in team-departure.ts):\n` +
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
