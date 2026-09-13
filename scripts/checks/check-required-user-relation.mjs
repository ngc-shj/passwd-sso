#!/usr/bin/env node
/**
 * CI guard: a Prisma call that may run in a tenant context must not reach a
 * REQUIRED to-one `User` relation — through what it returns, or through its
 * `where`.
 *
 * Why. `users_tenant_isolation` shows a users row only to the tenant its owning
 * column names, so a tenant or team context cannot see a user filed under another
 * tenant: a departed member the realignment moved, a team guest from another
 * primary tenant, a creator or initiator who has since left. Measured against the
 * real database (audit-tenant-adjudicator round 4, S2), a REQUIRED relation to such
 * a row does not throw. It comes back `null` under a type that says it cannot be,
 * and a relation filter through it silently drops the row. Eighteen reads failed
 * that way: a response taken down by the dereference, a null handed to a client, a
 * member missing from a list and from its count.
 *
 * What passes without a manifest entry: a call whose enclosing call, in this file,
 * resolves to `withBypassRls` — there every users row is visible. Everything else
 * is treated as possibly tenant-scoped, fail-closed, because a service function
 * carries no opener of its own and runs inside whatever context its caller opened.
 * The fix is to keep the foreign key and hydrate identity after the context
 * closes (`fetchUserDisplayMap` / `displayIdentityOf`), or to read under a bypass
 * that pins the tenant in every condition.
 *
 * Exceptions are per file, in the manifest, WITH the number of calls they cover:
 * a call added to a listed file changes the count and fails here, instead of being
 * excused by an entry that was written for a different call. Every entry needs a
 * reason. Dispositions:
 *   - "active-membership": the call is restricted to users with an ACTIVE
 *     membership in the tenant it runs in, whose owning column the realignment
 *     keeps on that tenant (src/lib/tenant/tenant-realignment.ts).
 *   - "actor": the relation is the requesting user's own row.
 *   - "caller-bypass": every caller runs the call inside a bypass it opened.
 *
 * Known not to be covered, stated so the next editor does not assume otherwise:
 *   - A `where` spread (`...ACTIVE_ENTRY_WHERE`) is not followed: the constant
 *     usually lives in another file. A projection spread fails closed instead.
 *   - A computed projection key is skipped.
 *   - Raw SQL, and a client obtained from a call (`const db = wrap(tx)`) whose
 *     handle the tree cannot resolve to a model.
 *   - Context is decided per file. A read in a helper the caller wraps in a bypass
 *     from another file is reported, and belongs in the manifest as
 *     "caller-bypass".
 */
import { SyntaxKind } from "ts-morph";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createAstProject, sourceFilesFrom } from "./lib/ast-project.mjs";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const ROOT = process.env.REQUIRED_USER_RELATION_CHECK_ROOT ?? REPO_ROOT;
const SCAN_ROOT = "src";
const SCHEMA_PATH = "prisma/schema.prisma";
const MANIFEST_PATH = "scripts/checks/required-user-relation-manifest.json";

/** Calls that return rows, and so carry `select` / `include`. */
const RETURNING = new Set([
  "findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "findMany",
  "create", "update", "upsert", "delete", "createManyAndReturn", "updateManyAndReturn",
]);
/** Calls whose `where` decides which rows are touched or counted. */
const FILTERING = new Set([...RETURNING, "count", "aggregate", "groupBy", "updateMany", "deleteMany"]);

const DISPOSITIONS = new Set(["active-membership", "actor", "caller-bypass"]);

const BYPASS = "withBypassRls";
const TENANT_SCOPED = new Set(["withTenantRls", "withUserTenantRls", "withTeamTenantRls"]);
const LOGICAL = new Set(["AND", "OR", "NOT"]);
const RELATION_FILTERS = new Set(["is", "isNot", "some", "every", "none"]);

/**
 * `model -> (field -> { type, list, optional })` from the schema itself, plus the
 * client handle each model answers to. Fail-loud on a schema it cannot read: a
 * walk that resolved every field to "not a relation" would pass every call.
 */
function loadSchema() {
  const abs = join(ROOT, SCHEMA_PATH);
  if (!existsSync(abs)) fail(`prisma schema not found at ${abs}.`);
  const models = new Map();
  let current = null;
  for (const line of readFileSync(abs, "utf8").split("\n")) {
    const open = /^model\s+(\w+)\s*\{/.exec(line);
    if (open) {
      current = new Map();
      models.set(open[1], current);
      continue;
    }
    if (/^\}/.test(line)) {
      current = null;
      continue;
    }
    if (!current) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith("@@") || trimmed.startsWith("//")) continue;
    const field = /^[ \t]+(\w+)[ \t]+([A-Za-z_]\w*)(\[\])?(\?)?/.exec(line);
    if (field) current.set(field[1], { type: field[2], list: !!field[3], optional: !!field[4] });
  }
  if (models.size === 0) fail(`parsed zero models from ${abs}.`);
  if (!models.has("User")) fail(`${abs} declares no User model, so no call can be classified.`);
  const handles = new Map([...models.keys()].map((m) => [m[0].toLowerCase() + m.slice(1), m]));
  return { models, handles };
}

function loadManifest() {
  const abs = join(ROOT, MANIFEST_PATH);
  if (!existsSync(abs)) fail(`manifest not found at ${abs}.`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf8"));
  } catch (e) {
    fail(`manifest at ${abs} is not valid JSON: ${e.message}`);
  }
  return new Map(Object.entries(parsed));
}

function fail(message) {
  console.error(`\nFAIL: ${message}`);
  process.exit(1);
}

const { models: MODELS, handles: HANDLES } = loadSchema();
const MANIFEST = loadManifest();

const isRequiredUser = (field) => field.type === "User" && !field.list && !field.optional;
const asObject = (node) => (node && node.getKind() === SyntaxKind.ObjectLiteralExpression ? node : null);
const initializerOf = (prop) => prop?.getInitializer?.() ?? null;

/** Every path through a projection of `model` that reaches a required User relation. */
function scanProjection(projection, model, trail, hits) {
  for (const prop of projection.getProperties()) {
    if (prop.getKind() !== SyntaxKind.PropertyAssignment) {
      hits.push([...trail, "<spread>"].join("."));
      continue;
    }
    if (prop.getNameNode().getKind() === SyntaxKind.ComputedPropertyName) continue;
    const key = prop.getName();
    if (key === "_count") continue;
    const field = MODELS.get(model)?.get(key);
    const here = [...trail, key];
    if (!field) {
      hits.push([...here, "<unresolved-field>"].join("."));
      continue;
    }
    if (!MODELS.has(field.type)) continue;
    if (isRequiredUser(field)) {
      hits.push(here.join("."));
      continue;
    }
    const nested = asObject(initializerOf(prop));
    if (!nested) continue;
    for (const root of ["select", "include"]) {
      const sub = initializerOf(nested.getProperty(root));
      if (!sub) continue;
      if (!asObject(sub)) {
        hits.push([...here, `${root}:<unreadable>`].join("."));
        continue;
      }
      scanProjection(asObject(sub), field.type, here, hits);
    }
  }
}

/** Every path through a `where` of `model` that filters through a required User relation. */
function scanWhere(where, model, trail, hits) {
  for (const prop of where.getProperties()) {
    if (prop.getKind() !== SyntaxKind.PropertyAssignment) continue;
    if (prop.getNameNode().getKind() === SyntaxKind.ComputedPropertyName) continue;
    const key = prop.getName();
    const value = initializerOf(prop);
    if (LOGICAL.has(key)) {
      const branches = value?.getKind() === SyntaxKind.ArrayLiteralExpression ? value.getElements() : [value];
      for (const branch of branches) {
        const obj = asObject(branch);
        if (obj) scanWhere(obj, model, [...trail, key], hits);
      }
      continue;
    }
    const field = MODELS.get(model)?.get(key);
    if (!field || !MODELS.has(field.type)) continue;
    const here = [...trail, key];
    if (isRequiredUser(field)) {
      hits.push(`${here.join(".")}<filter>`);
      continue;
    }
    const nested = asObject(value);
    if (!nested) continue;
    const wrapped = nested.getProperties().some(
      (p) => p.getKind() === SyntaxKind.PropertyAssignment && RELATION_FILTERS.has(p.getName()),
    );
    if (!wrapped) {
      scanWhere(nested, field.type, here, hits);
      continue;
    }
    for (const op of RELATION_FILTERS) {
      const sub = asObject(initializerOf(nested.getProperty(op)));
      if (sub) scanWhere(sub, field.type, [...here, op], hits);
    }
  }
}

/**
 * Every opener name reachable from `name`'s declaration in this file, following
 * local identifier callees transitively. An unresolvable name contributes nothing.
 */
function openersReachableFrom(name, sf, seen) {
  if (seen.has(name)) return new Set();
  seen.add(name);
  if (name === BYPASS || TENANT_SCOPED.has(name)) return new Set([name]);
  const decl =
    sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration).find((d) => d.getName() === name) ??
    sf.getFunction(name);
  if (!decl) return new Set();
  const out = new Set();
  for (const call of decl.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (callee.getKind() !== SyntaxKind.Identifier) continue;
    for (const o of openersReachableFrom(callee.getText(), sf, seen)) out.add(o);
  }
  return out;
}

/**
 * Inside a bypass: the nearest enclosing call that resolves to an opener at all
 * resolves to the bypass and to no tenant opener. A wrapper reaching both is not
 * trusted — which one it opens around this call is not decidable here.
 */
function isInsideBypass(call, sf) {
  for (let n = call.getParent(); n; n = n.getParent()) {
    if (n.getKind() !== SyntaxKind.CallExpression) continue;
    const callee = n.getExpression();
    if (callee.getKind() !== SyntaxKind.Identifier) continue;
    const reached = openersReachableFrom(callee.getText(), sf, new Set());
    if (reached.size === 0) continue;
    return reached.has(BYPASS) && ![...TENANT_SCOPED].some((o) => reached.has(o));
  }
  return false;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === "__tests__") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(relative(ROOT, p));
  }
  return out;
}

if (!existsSync(join(ROOT, SCAN_ROOT))) fail(`scan root ${join(ROOT, SCAN_ROOT)} does not exist.`);
const files = walk(join(ROOT, SCAN_ROOT));
console.log(`check-required-user-relation: ROOT=${ROOT} FILES=${files.length} MANIFEST=${MANIFEST.size}`);
// "Examined nothing" must not be spelled like "found nothing".
if (files.length === 0) fail(`scanned zero source files under ${SCAN_ROOT}.`);

/** rel -> [{ line, method, paths }] for calls outside a bypass. */
const found = new Map();
let scanned = 0;

for (const { rel, sf } of sourceFilesFrom(createAstProject(), files, ROOT)) {
  scanned += 1;
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) continue;
    const method = callee.getName();
    if (!FILTERING.has(method)) continue;
    const recv = callee.getExpression();
    if (recv.getKind() !== SyntaxKind.PropertyAccessExpression) continue;
    const model = HANDLES.get(recv.getName());
    if (!model || model === "User") continue;
    const args = asObject(call.getArguments()[0]);
    if (!args) continue;

    const hits = [];
    if (RETURNING.has(method)) {
      for (const root of ["select", "include"]) {
        const node = initializerOf(args.getProperty(root));
        if (!node) continue;
        if (!asObject(node)) hits.push(`${model}.${root}:<unreadable>`);
        else scanProjection(asObject(node), model, [model], hits);
      }
    }
    const where = asObject(initializerOf(args.getProperty("where")));
    if (where) scanWhere(where, model, [model], hits);
    if (hits.length === 0 || isInsideBypass(call, sf)) continue;

    if (!found.has(rel)) found.set(rel, []);
    found.get(rel).push({ line: call.getStartLineNumber(), method, paths: hits });
  }
}

if (scanned === 0) fail(`resolved zero scannable source files from ${files.length} paths.`);

const failures = [];
const describe = (rel, calls) =>
  calls.map((c) => `    ${rel}:${c.line} ${c.method} -> ${c.paths.join(" | ")}`).join("\n");

for (const [rel, calls] of found) {
  const entry = MANIFEST.get(rel);
  if (!entry) {
    failures.push(
      `${rel}: ${calls.length} call(s) reach a REQUIRED User relation outside a bypass. ` +
        `In a tenant context that relation is null for a user filed under another tenant, ` +
        `and a filter through it drops the row. Keep the foreign key and hydrate after the ` +
        `context closes, or add a manifest entry with a reason.\n${describe(rel, calls)}`,
    );
    continue;
  }
  if (!DISPOSITIONS.has(entry.disposition)) {
    failures.push(`${rel}: unknown disposition "${entry.disposition}" (expected one of ${[...DISPOSITIONS].join(", ")}).`);
  }
  if (!entry.reason) failures.push(`${rel}: manifest entry has no reason.`);
  if (entry.calls !== calls.length) {
    failures.push(
      `${rel}: manifest covers ${entry.calls} call(s) but the file has ${calls.length}. ` +
        `A call was added or removed — re-derive the entry rather than bumping the number.\n${describe(rel, calls)}`,
    );
  }
}

// The reverse direction: an entry that outlives its subject reads as coverage.
for (const rel of MANIFEST.keys()) {
  if (!found.has(rel)) {
    failures.push(`${rel}: manifest entry with no matching call left in the file. Remove it.`);
  }
}

if (failures.length > 0) {
  console.error(`\nFAIL: ${failures.length} problem(s):\n`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}

console.log(
  `check-required-user-relation: OK (${found.size} file(s) reach a required User relation ` +
    `outside a bypass, each under a declared exception)`,
);
