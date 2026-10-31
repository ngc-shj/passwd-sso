#!/usr/bin/env node
/**
 * CI guard over who holds a team key, from two sides.
 *
 * Team key rotation (src/app/api/teams/[teamId]/rotate-key/route.ts) wraps
 * the next team key to the team's key holders, read under its team lock.
 * Review of #979 found the class of code deciding "who holds the key" twice
 * by hand (member removal, then tenant departure; see
 * docs/archive/review/team-key-rotation-write-race-code-review.md), so both
 * halves are derived here:
 *
 * ─── WRITES that change the member set take a rotation lock first ───
 *
 * A Prisma client call (any receiver) of
 *   - `teamMemberKey.delete` / `deleteMany`
 *   - `teamMember.delete` / `deleteMany`
 *   - `teamMember.update` / `updateMany` whose `data` sets `deactivatedAt` or
 *     `keyDistributed`, and `teamMember.upsert` whose `update` does
 * and a `$queryRaw` / `$executeRaw` tagged template that deletes from or
 * updates `team_members` / `team_member_keys` (schema-qualified or not), must
 * follow a call to one of LOCK_HELPERS — earlier in its enclosing function,
 * or earlier in EVERY same-file caller of that function by name.
 *
 * ─── READS that select key holders apply the departure predicate ───
 *
 * A `teamMember.findMany` / `findFirst` / `findUnique` / `count` whose
 * `where` filters on `keyDistributed`, or a `teamMember` read whose `select`
 * returns it, decides who holds (or needs) a key. A member who departed the
 * team's tenant must not count (src/lib/team/team-departure.ts), so the
 * read's outermost enclosing function (the route handler or service
 * function — the predicate filters the result, often in a sibling callback)
 * must call one of DEPARTURE_HELPERS. Read sites are keyed by that function.
 *
 * A `data` / `where` / `select` that is not an object literal (an
 * identifier, a spread) cannot be read, so it counts: the gate refuses
 * rather than skips what it cannot see. Sites that are neither are listed in
 * EXEMPTIONS with the reviewed reason; each key must match exactly one site.
 *
 * KNOWN LIMITS — the gate reads names and positions, not identities or
 * control flow:
 *   - "earlier" is source order: a lock in an untaken branch, or in an
 *     earlier separate transaction, satisfies it; that the lock and the write
 *     share a transaction is pinned by team-key-version-guard.integration.test.ts;
 *   - callers are followed one level, within the same file — an exported
 *     writer called from another file is judged by its same-file callers only;
 *   - a call reached through an alias (`const tm = tx.teamMember`), a
 *     `$executeRaw(Prisma.sql…)` call form or a `*Unsafe` raw call is not seen;
 *   - deleting a user row cascades to their memberships in the database; that
 *     serialises with rotation through the KEY SHARE its member-key insert
 *     takes on `users`.
 *
 * Exit 0 = every site covered or exempt. Exit 1 = a site is not, an
 * exemption matches no site or several, or the site counts differ from the
 * pinned ones (a scan that lost sites, or a new site that needs review).
 */
import { Node, SyntaxKind } from "ts-morph";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAstProject, sourceFilesFrom, unresolvedTargets } from "./lib/ast-project.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.TEAM_ROTATION_INPUT_LOCK_ROOT ?? join(__dirname, "..", "..");
const TARGETS = (process.env.TEAM_ROTATION_INPUT_LOCK_TARGETS ?? "src/app,src/lib,src/workers,src/auth.ts").split(",");
/** The implementations: their raw SQL IS the lock and the predicate. */
const IMPLEMENTATIONS = new Set(["src/lib/team/team-key-rotation-lock.ts", "src/lib/team/team-departure.ts"]);

const LOCK_HELPERS = new Set([
  "lockTeamForRotation",
  "lockTeamKeyVersion",
  "lockTeamsAgainstRotation",
  "lockMemberTeamsAgainstRotation",
]);
const DEPARTURE_HELPERS = new Set(["departedFromTenant", "departedPairs", "lockDepartureState"]);

/**
 * Pinned site counts of the real tree. A change means a member-set write or a
 * key-holder read appeared or disappeared: review it, then update the pin.
 */
const EXPECTED_WRITES = Number(process.env.TEAM_ROTATION_INPUT_LOCK_WRITES ?? 12);
const EXPECTED_READS = Number(process.env.TEAM_ROTATION_INPUT_LOCK_READS ?? 6);

/**
 * Sites that need neither, keyed `<path>::<enclosing function>::<model>.<method>`.
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
  [
    "src/app/api/teams/invitations/accept/route.ts::<anonymous>::teamMember.upsert",
    "joining or rejoining through an invitation: the membership is created or reset with keyDistributed=false, never a key holder",
  ],
  [
    "src/app/api/teams/[teamId]/member-key/route.ts::handleGET::teamMember.read",
    "the caller's own membership, read after requireTeamMember, which already refuses a member who departed the team's tenant",
  ],
]);

const RAW_WRITE = /\b(DELETE\s+FROM|UPDATE)\s+(?:"?\w+"?\.)?"?(team_members|team_member_keys)"?\b/i;
const READ_METHODS = new Set(["findMany", "findFirst", "findUnique", "count"]);

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

/** `<model>.<method>` when the call is a member-set write, else null. */
function classifyWrite(call) {
  const mm = modelAndMethod(call);
  if (!mm) return null;
  const { model, method } = mm;
  const site = `${model}.${method}`;
  if (model === "teamMemberKey" && (method === "delete" || method === "deleteMany")) return site;
  if (model !== "teamMember") return null;
  if (method === "delete" || method === "deleteMany") return site;
  const keys = ["deactivatedAt", "keyDistributed"];
  if ((method === "update" || method === "updateMany") && mayName(objectProp(call, "data"), keys)) return site;
  if (method === "upsert" && mayName(objectProp(call, "update"), keys)) return site;
  return null;
}

/** `teamMember.read` when the call reads key holders, else null. */
function classifyRead(call) {
  const mm = modelAndMethod(call);
  if (!mm || mm.model !== "teamMember" || !READ_METHODS.has(mm.method)) return null;
  const filters = mayName(objectProp(call, "where"), ["keyDistributed"]);
  const returns = mm.method !== "count" && objectProp(call, "select") !== undefined
    && mayName(objectProp(call, "select"), ["keyDistributed"]);
  return filters || returns ? "teamMember.read" : null;
}

function classifyRawWrite(tagged) {
  if (!/\$(queryRaw|executeRaw)$/.test(tagged.getTag().getText())) return null;
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

function outermostFunction(node) {
  const all = node.getAncestors().filter((n) => Node.isFunctionLikeDeclaration(n));
  return all.length > 0 ? all[all.length - 1] : null;
}

function callsBefore(fn, helpers, pos) {
  return fn
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .some((c) => helpers.has(c.getExpression().getText()) && c.getStart() < pos);
}

/** One level up: every same-file call of `name` follows a helper call in its own function. */
function coveredByCallers(sourceFile, name, helpers) {
  if (name === "<anonymous>" || name === "<module>") return false;
  const calls = sourceFile
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((c) => c.getExpression().getText() === name);
  return calls.length > 0 && calls.every((c) => {
    const caller = enclosingFunction(c);
    return caller !== null && callsBefore(caller, helpers, c.getStart());
  });
}

const project = createAstProject();
const sites = [];
for (const { rel: path, sf: sourceFile } of sourceFilesFrom(project, TARGETS, REPO_ROOT)) {
  if (IMPLEMENTATIONS.has(path)) continue;
  const calls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
  const found = [
    ...calls.map((n) => [n, classifyWrite(n), "write"]),
    ...calls.map((n) => [n, classifyRead(n), "read"]),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.TaggedTemplateExpression).map((n) => [n, classifyRawWrite(n), "write"]),
  ].filter(([, site]) => site !== null);
  for (const [node, site, kind] of found) {
    if (kind === "read") {
      const fn = outermostFunction(node);
      const covered = fn !== null && callsBefore(fn, DEPARTURE_HELPERS, Infinity);
      sites.push({ key: `${path}::${functionName(fn)}::${site}`, kind, line: node.getStartLineNumber(), covered });
      continue;
    }
    const fn = enclosingFunction(node);
    const name = functionName(fn);
    const covered = fn !== null && (callsBefore(fn, LOCK_HELPERS, node.getStart()) || coveredByCallers(sourceFile, name, LOCK_HELPERS));
    sites.push({ key: `${path}::${name}::${site}`, kind, line: node.getStartLineNumber(), covered });
  }
}

const problems = [];
const writes = sites.filter((s) => s.kind === "write").length;
const reads = sites.filter((s) => s.kind === "read").length;
if (writes !== EXPECTED_WRITES || reads !== EXPECTED_READS) {
  problems.push(
    `found ${writes} member-set write(s) and ${reads} key-holder read(s); pinned ${EXPECTED_WRITES} and ${EXPECTED_READS}. ` +
      `Review the sites that appeared or disappeared, then update EXPECTED_WRITES / EXPECTED_READS:\n` +
      sites.map((s) => `  ${s.kind}  ${s.key.split("::")[0]}:${s.line}  ${s.key}`).join("\n"),
  );
}
const uncovered = sites.filter((s) => !s.covered && !EXEMPTIONS.has(s.key));
if (uncovered.length > 0) {
  problems.push(
    `sites without their helper (a write needs a rotation lock before it, a key-holder read the departure ` +
      `predicate; or exempt the site with a reviewed reason):\n` +
      uncovered.map((s) => `  ${s.kind}  ${s.key.split("::")[0]}:${s.line}  ${s.key}`).join("\n"),
  );
}
const badExemptions = [...EXEMPTIONS.keys()].filter((k) => sites.filter((s) => s.key === k).length !== 1);
if (badExemptions.length > 0) {
  problems.push(`exemption(s) matching no site, or several — make each match exactly one:\n${badExemptions.map((k) => `  ${k}`).join("\n")}`);
}
if (problems.length > 0) {
  for (const p of problems) console.error(`\nFAIL: ${p}`);
  process.exit(1);
}
console.log(
  `check-team-rotation-input-lock: OK (${writes} member-set write(s), ${reads} key-holder read(s); ` +
    `${sites.filter((s) => s.covered).length} covered, ${sites.filter((s) => !s.covered).length} exempt)`,
);
