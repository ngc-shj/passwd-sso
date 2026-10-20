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
 *   - "dynamic-where": the `where` is assembled at run time and this gate cannot
 *     read it (`<unreadable-where>`). The reason must name every key the assembly
 *     can set — or the type that bounds them — so a reviewer can see none is a
 *     required User relation. Weaker than the others: a later edit to the builder
 *     does not change the count. Prefer a literal the gate can read.
 * A disposition is a claim about one kind of hit, so it excuses only that kind:
 * "dynamic-where" only a path through `<unreadable-where>`, and no other
 * disposition such a path. Matching the count alone let a "dynamic-where" entry
 * excuse a projection that returns the relation, which its reason says nothing
 * about (round 6).
 *
 * Where it looks. A call's `select`/`include`, followed through nested relations;
 * its `where`, through `AND`/`OR`/`NOT` and `is`/`isNot`/`some`/`every`/`none`; the
 * `where` of a nested relation inside a projection, and inside `_count.select`. A
 * `where` given as a name or a shorthand (`{ where }`) is followed to the `const`
 * object literal the name is bound to where it is written — a name inside a
 * followed literal at its own position, not the call's — provided nothing in the
 * file assigns into, deletes from, or `Object.assign`s onto it; otherwise it is reported as `<unreadable-where>` when the model — or,
 * for a nested filter, the related model — declares a required User relation.
 * (Round 5, T3: `tenantMember.count({ where: prismaWhere })` was an S2 member this
 * gate did not report.)
 *
 * Context comes from `lib/rls-context.mjs`: the nearest enclosing call that opens
 * one around the argument the call is in, with names resolved by scope and imports
 * by their original name. A parameter or a wrapper that also runs the callback
 * outside its opener is UNKNOWN, which is not a bypass (round 5, S3/T2).
 *
 * Known not to be covered, stated so the next editor does not assume otherwise:
 *   - A `where` spread (`...ACTIVE_ENTRY_WHERE`) is not followed: the constant
 *     usually lives in another file. A projection spread fails closed instead.
 *   - An unreadable `where` on a model with NO required User relation of its own
 *     is not reported, even if a relation filter inside it could reach one.
 *   - A computed projection key is skipped.
 *   - Raw SQL, and a client obtained from a call (`const db = wrap(tx)`) whose
 *     handle the tree cannot resolve to a model.
 *   - The receiver is matched by NAME (`tx.tenantMember.findMany`), so a read
 *     through an aliased model handle (`const m = prisma.tenantMember;
 *     m.findFirst(…)`) is not seen, inside an opener or outside one. The same limit
 *     as `check-owning-tenant-adjudicator.mjs` and `check-bypass-rls.mjs`:
 *     resolving it needs a Program, which no gate in this tree carries (declared in
 *     audit-tenant-adjudicator round 11, S-R11-3).
 *   - Context is decided per file. A read in a helper the caller wraps in a bypass
 *     from another file is reported, and belongs in the manifest as
 *     "caller-bypass".
 */
import { SyntaxKind } from "ts-morph";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createAstProject, sourceFilesFrom } from "./lib/ast-project.mjs";
import { bindingIndex } from "./lib/scope-bindings.mjs";
import { RLS_CONTEXT, rlsContextOf } from "./lib/rls-context.mjs";
import { FILTERING, SchemaReadError, loadPrismaSchema, walkCallArgs } from "./lib/prisma-relation-reach.mjs";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const ROOT = process.env.REQUIRED_USER_RELATION_CHECK_ROOT ?? REPO_ROOT;
const SCAN_ROOT = "src";
const SCHEMA_PATH = "prisma/schema.prisma";
const MANIFEST_PATH = "scripts/checks/required-user-relation-manifest.json";

const DISPOSITIONS = new Set(["active-membership", "actor", "caller-bypass", "dynamic-where"]);

/** Marks a path through a filter this gate could not read; the manifest check keys on it. */
const UNREADABLE_WHERE = "<unreadable-where>";

/**
 * `model -> (field -> { type, list, optional })` from the schema itself, plus the
 * client handle each model answers to (lib/prisma-relation-reach.mjs). Fail-loud
 * on a schema it cannot read: a walk that resolved every field to "not a
 * relation" would pass every call.
 */
function loadSchema() {
  let schema;
  try {
    schema = loadPrismaSchema(join(ROOT, SCHEMA_PATH));
  } catch (e) {
    if (e instanceof SchemaReadError) fail(e.message);
    throw e;
  }
  if (!schema.models.has("User")) fail(`${join(ROOT, SCHEMA_PATH)} declares no User model, so no call can be classified.`);
  return schema;
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
const hasRequiredUser = (model) => [...(MODELS.get(model)?.values() ?? [])].some(isRequiredUser);
const asObject = (node) => (node && node.getKind() === SyntaxKind.ObjectLiteralExpression ? node : null);

/**
 * The paths through one call's argument that reach a required User relation,
 * read by the shared relation walk: a projection or filter that names the
 * relation (it is not descended), and — when the model the unreadable part is
 * about declares one — a filter this gate cannot read.
 */
function requiredUserHits(args, model, method, ctx) {
  const hits = [];
  const visitor = {
    relation({ trail, field, position }) {
      if (position === "count" || !isRequiredUser(field)) return true;
      hits.push(position === "where" ? `${trail.join(".")}<filter>` : trail.join("."));
      return false;
    },
    unreadable({ trail, model: at, kind, key, field, root }) {
      switch (kind) {
        case "projection":
          hits.push([...trail, `${root}:<unreadable>`].join("."));
          break;
        case "spread":
          hits.push([...trail, "<spread>"].join("."));
          break;
        case "unresolved-field":
          hits.push([...trail, "<unresolved-field>"].join("."));
          break;
        case "shorthand-filter":
          if (isRequiredUser(field)) hits.push(`${trail.join(".")}<filter>`);
          break;
        case "where":
          if (hasRequiredUser(at)) hits.push([...trail, `where${UNREADABLE_WHERE}`].join("."));
          break;
        case "logical":
          if (hasRequiredUser(at)) hits.push([...trail, `${key}${UNREADABLE_WHERE}`].join("."));
          break;
        case "filter":
        case "relation-op":
          if (hasRequiredUser(field.type)) hits.push(`${trail.join(".")}${UNREADABLE_WHERE}`);
          break;
        default:
          break;
      }
    },
  };
  walkCallArgs(args, model, method, { models: MODELS, visitor, ctx });
  return hits;
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
  let bindings;
  const bindingsFor = () => (bindings ??= bindingIndex(sf));
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

    const hits = requiredUserHits(args, model, method, { bindingsFor });
    if (hits.length === 0 || rlsContextOf(call, sf, bindingsFor) === RLS_CONTEXT.BYPASS) continue;

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
  if (DISPOSITIONS.has(entry.disposition)) {
    // See the header: an entry excuses only the kind of hit its disposition describes.
    const excusesUnreadable = entry.disposition === "dynamic-where";
    for (const c of calls) {
      for (const path of c.paths) {
        if (path.includes(UNREADABLE_WHERE) === excusesUnreadable) continue;
        failures.push(
          `${rel}:${c.line}: disposition "${entry.disposition}" cannot excuse ${path}. ` +
            (excusesUnreadable
              ? `"dynamic-where" covers only a where this gate cannot read; this path was read, and reaches the relation.`
              : `Only "dynamic-where" covers a where this gate cannot read, with a reason naming every key it can hold.`),
        );
      }
    }
  }
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
