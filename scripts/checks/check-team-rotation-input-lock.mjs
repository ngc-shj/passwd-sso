#!/usr/bin/env node
/**
 * CI guard: every write that changes an input of team key rotation is
 * serialised with rotation through a team-key-rotation-lock helper.
 *
 * Rotation (src/app/api/teams/[teamId]/rotate-key/route.ts) reads two inputs
 * under `teams ... FOR NO KEY UPDATE` — the team's entries and its key-holding
 * members — and writes the next team key version. A write that changes the
 * member set and commits after rotation read it leaves a departed member a
 * key to the new version. The member-set class grew twice by hand during
 * review (member removal, then tenant-level deactivation; see
 * docs/archive/review/team-key-rotation-write-race-code-review.md), so its
 * completeness is enforced here instead.
 *
 * ─── The class, derived from the write primitive ───
 *
 * A Prisma client call (any receiver) of:
 *   - `teamMemberKey.delete` / `deleteMany`
 *   - `teamMember.delete` / `deleteMany`
 *   - `teamMember.update` / `updateMany` whose `data` sets `deactivatedAt` or
 *     `keyDistributed`
 *   - `tenantMember.delete` / `deleteMany`
 *   - `tenantMember.update` / `updateMany` / `upsert` whose `data` (or
 *     `update`) sets `deactivatedAt`
 * and a `$queryRaw` / `$executeRaw` tagged template that deletes from or
 * updates `team_members`, `team_member_keys` or `tenant_members`.
 *
 * A `data` that is not an object literal (an identifier, a spread) cannot be
 * read, so it counts as setting everything: the gate refuses rather than
 * skips what it cannot see.
 *
 * ─── What satisfies it ───
 *
 * A call to one of LOCK_HELPERS that starts BEFORE the write, in the write's
 * enclosing function, or — one level up — in a function of the same file that
 * calls the enclosing function by name after its own lock call (the SCIM group
 * service locks in `runPatch` / `runReplace` and deactivates in the
 * `applyRemoveOperations` they call). Writes that are not departures are
 * listed in EXEMPTIONS with the reviewed reason; an exemption that no longer
 * matches a site fails, so the list cannot rot into a blanket pass.
 *
 * KNOWN LIMITS: names, not identities — the lock and the write are not proven
 * to share a transaction (that is pinned by the integration races in
 * team-key-version-guard.integration.test.ts), a call through an alias is not
 * seen, and callers more than one level up are not followed. Deleting a user
 * row cascades to their memberships in the database, outside this class; it
 * serialises with rotation through the KEY SHARE rotation's member-key insert
 * takes on `users`.
 *
 * Exit 0 = every site locked or exempt. Exit 1 = a site is not, an exemption
 * is stale, or fewer sites were found than FLOOR (a scan that found nothing
 * must not read as clean).
 */
import { Node, SyntaxKind } from "ts-morph";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAstProject, sourceFilesFrom, unresolvedTargets } from "./lib/ast-project.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.TEAM_ROTATION_INPUT_LOCK_ROOT ?? join(__dirname, "..", "..");
const TARGETS = ["src/app", "src/lib", "src/auth.ts"];
/** The implementation itself: its raw writes ARE the locked revocation. */
const IMPLEMENTATION = "src/lib/team/team-key-rotation-lock.ts";

const LOCK_HELPERS = new Set([
  "lockTeamKeyVersion",
  "lockTeamsAgainstRotation",
  "lockMemberTeamsAgainstRotation",
  "lockTenantMemberTeamsAgainstRotation",
  "endTeamKeyDistribution",
]);

/**
 * Sites that are not departures, keyed `<path>::<enclosing function>::<model>.<method>`.
 * Each reason is the review's conclusion, not a description of the code.
 */
const EXEMPTIONS = new Map([
  [
    "src/app/api/teams/[teamId]/members/route.ts::<anonymous>::teamMemberKey.deleteMany",
    "reactivation of a deactivated member: their stale keys go and they come back with keyDistributed=false, so they are not a key holder rotation includes before or after",
  ],
  [
    "src/app/api/teams/[teamId]/members/route.ts::<anonymous>::teamMember.update",
    "reactivation of a deactivated member (same transaction as above): sets keyDistributed=false",
  ],
]);

/**
 * The real tree has at least this many class sites (member DELETE, confirm-key,
 * SCIM user PUT/PATCH/DELETE, SCIM group deactivation, vault reset, directory
 * sync, tenant move, reactivation). Fewer means the scan or the class
 * derivation broke. Overridable for the self-test's synthetic roots.
 */
const FLOOR = Number(process.env.TEAM_ROTATION_INPUT_LOCK_FLOOR ?? 12);

const RAW_WRITE = /\b(DELETE\s+FROM|UPDATE)\s+"?(team_members|team_member_keys|tenant_members)"?\b/i;

console.log(`check-team-rotation-input-lock: ROOT=${REPO_ROOT}`);

const unresolved = unresolvedTargets(TARGETS, REPO_ROOT);
if (unresolved.length > 0) {
  console.error(`\nFAIL: scan target not found under ${REPO_ROOT}: ${unresolved.join(", ")}`);
  process.exit(1);
}

/** The object literal of `prop` in a call's first argument, `undefined` when absent, `null` when unreadable. */
function objectProp(call, prop) {
  const [arg] = call.getArguments();
  if (!arg || !Node.isObjectLiteralExpression(arg)) return null;
  if (arg.getProperties().some((p) => Node.isSpreadAssignment(p))) return null;
  const p = arg.getProperty(prop);
  if (!p) return undefined;
  if (!Node.isPropertyAssignment(p)) return null;
  const init = p.getInitializer();
  return init && Node.isObjectLiteralExpression(init) ? init : null;
}

/** Whether an object literal (or an unreadable one) may set any of `keys`. */
function maySet(literal, keys) {
  if (literal === undefined) return false;
  if (literal === null) return true;
  if (literal.getProperties().some((p) => Node.isSpreadAssignment(p))) return true;
  return keys.some((k) => literal.getProperty(k) !== undefined);
}

/** `<model>.<method>` when the call is a member-set write, else null. */
function classifyClientCall(call) {
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return null;
  const method = callee.getName();
  const object = callee.getExpression();
  if (!Node.isPropertyAccessExpression(object)) return null;
  const model = object.getName();
  const site = `${model}.${method}`;
  if (model === "teamMemberKey" && (method === "delete" || method === "deleteMany")) return site;
  if (model === "teamMember") {
    if (method === "delete" || method === "deleteMany") return site;
    if ((method === "update" || method === "updateMany") && maySet(objectProp(call, "data"), ["deactivatedAt", "keyDistributed"])) return site;
  }
  if (model === "tenantMember") {
    if (method === "delete" || method === "deleteMany") return site;
    if ((method === "update" || method === "updateMany") && maySet(objectProp(call, "data"), ["deactivatedAt"])) return site;
    if (method === "upsert" && maySet(objectProp(call, "update"), ["deactivatedAt"])) return site;
  }
  return null;
}

function classifyRawWrite(tagged) {
  const tag = tagged.getTag().getText();
  if (!/\$(queryRaw|executeRaw)$/.test(tag)) return null;
  const m = RAW_WRITE.exec(tagged.getTemplate().getText());
  return m ? `${m[2]}.raw` : null;
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

function lockCallsIn(fn) {
  return fn
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((c) => LOCK_HELPERS.has(c.getExpression().getText()));
}

function lockedBefore(fn, pos) {
  return lockCallsIn(fn).some((c) => c.getStart() < pos);
}

/** One level up: a function of the file that locks before calling `name`. */
function lockedByCaller(sourceFile, name) {
  if (name === "<anonymous>" || name === "<module>") return false;
  const calls = sourceFile
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((c) => c.getExpression().getText() === name);
  return calls.length > 0 && calls.every((c) => {
    const caller = enclosingFunction(c);
    return caller !== null && lockedBefore(caller, c.getStart());
  });
}

const project = createAstProject();
const sites = [];
for (const { rel: path, sf: sourceFile } of sourceFilesFrom(project, TARGETS, REPO_ROOT)) {
  if (path === IMPLEMENTATION) continue;
  const found = [
    ...sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression).map((n) => [n, classifyClientCall(n)]),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.TaggedTemplateExpression).map((n) => [n, classifyRawWrite(n)]),
  ].filter(([, site]) => site !== null);
  for (const [node, site] of found) {
    const fn = enclosingFunction(node);
    const name = functionName(fn);
    const key = `${path}::${name}::${site}`;
    const locked = fn !== null && (lockedBefore(fn, node.getStart()) || lockedByCaller(sourceFile, name));
    sites.push({ key, line: node.getStartLineNumber(), locked });
  }
}

const unlocked = sites.filter((s) => !s.locked && !EXEMPTIONS.has(s.key));
const stale = [...EXEMPTIONS.keys()].filter((k) => !sites.some((s) => s.key === k));
let failed = false;

if (sites.length < FLOOR) {
  console.error(`\nFAIL: found ${sites.length} member-set write site(s), fewer than the floor of ${FLOOR} — the scan or the class derivation broke.`);
  failed = true;
}
if (unlocked.length > 0) {
  console.error(
    `\nFAIL: member-set writes not serialised with team key rotation (call a team-key-rotation-lock helper before the write, ` +
      `or exempt the site with a reviewed reason):\n` +
      unlocked.map((s) => `  ${s.key.split("::")[0]}:${s.line}  ${s.key}`).join("\n"),
  );
  failed = true;
}
if (stale.length > 0) {
  console.error(`\nFAIL: exemption(s) matching no site — remove them:\n${stale.map((k) => `  ${k}`).join("\n")}`);
  failed = true;
}
if (failed) process.exit(1);
console.log(
  `check-team-rotation-input-lock: OK (${sites.length} member-set write site(s): ` +
    `${sites.filter((s) => s.locked).length} locked, ${sites.filter((s) => !s.locked).length} exempt)`,
);
