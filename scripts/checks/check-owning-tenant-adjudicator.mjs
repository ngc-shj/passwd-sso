#!/usr/bin/env node
/**
 * CI guard: a user's tenant identity is read through ONE adjudicator — AST,
 * per-read-site, with a disposition manifest.
 *
 * `User.tenantId` is a denormalized copy of "the user's active TenantMember",
 * and nothing writes the two together. There IS a reachable producer —
 * `auth.ts`'s tenant-claim handler writes the membership without the column on
 * its no-membership branch, so a user released by one tenant and signed in
 * through another's IdP ends divergent (the path is written out in
 * `src/lib/tenant-context.ts`). This gate is not prophylactic; an earlier
 * version of this header said it was, on a premise review falsified.
 * Every reader of the
 * resulting rows scopes by the membership (`withUserTenantRls` ->
 * `resolveUserTenantId`, `requireTenantPermission` -> `getTenantMembership`),
 * so a record filed under the stale copy is invisible under RLS, permanently —
 * and where the value selects a POLICY rather than a row's tenant, the wrong
 * tenant's lockout thresholds, passkey enforcement or session timeouts govern.
 *
 * ─── Why the predicate is "unconstrained", not "reads User.tenantId" ───
 *
 * Most reads of that column are fine. `users_tenant_isolation` is
 * `bypass_rls='on' OR tenant_id = current_setting('app.tenant_id')::uuid`, so a
 * read inside a TENANT-SCOPED context can only return the context's own tenant —
 * RLS enforces the agreement and there is nothing to fix. Only a read that is
 * NOT inside such a context returns the stale copy verbatim. That distinction is
 * the whole class boundary, and a gate keyed on the column name would flag 15
 * safe sites and hide the boundary that matters.
 *
 * ─── Why the opener is RESOLVED, not name-matched ───
 *
 * `src/app/api/vault/status/route.ts` and `.../vault/unlock/data/route.ts` wrap
 * their reads in a local `withVaultTenantRls`, declared in the same file as
 * `tenantId ? withTenantRls(...) : withUserTenantRls(...)`. Both are safe, and a
 * name-matching pass reports them as unconstrained — measured, on the discovery
 * pass that produced this manifest. So each enclosing callee identifier is
 * resolved against the file's own declarations one level deep. Anything that
 * cannot be resolved to a tenant-scoped opener counts as UNCONSTRAINED and needs
 * a manifest entry: "could not decide" must not be spelled like "safe".
 *
 * ─── Dispositions ───
 *
 *   "adjudicator"   - the file resolves a user's tenant through
 *                     `resolveOwningTenantIdFromClient`. Enforced as: this file
 *                     contains NO unconstrained raw read, and DOES call the
 *                     helper. Re-inlining a raw `user.findUnique({ select:
 *                     { tenantId } })` under a bypass here -> FAIL.
 *   "tenant-scoped" - every user-tenant read in the file is inside a
 *                     tenant-scoped opener, so RLS constrains it. Enforced as:
 *                     no unconstrained read. Moving one under `withBypassRls`
 *                     -> FAIL.
 *   "column-intended" - an unconstrained read is deliberate. Requires a reason.
 *                     This is the only disposition that PERMITS the shape, so
 *                     adding an entry is the deliberate act, and the reason is
 *                     what the next reviewer reads.
 *
 * Plus completeness in both directions: a file with a user-tenant read and no
 * MANIFEST entry FAILS, and a MANIFEST entry whose file no longer reads one
 * FAILS. The first is what stops the class growing silently — this class was
 * enumerated by hand and went 1 -> 2 -> 4 -> 16 before it was derived, which is
 * why "all reviewers found nothing" is not what closes it.
 *
 * ─── Why the projection is walked against the SCHEMA ───
 *
 * `User.tenantId` is reachable through a RELATION, not only through
 * `prisma.user`: `tenantMember.findFirst({ select: { user: { select: { tenantId:
 * true } } } })` returns the same stale copy, and an earlier version keyed on the
 * receiver being `.user` could not see it — it was narrower than the class its own
 * header describes, which is the third time a gate in this tree has been. So the
 * projection is walked with the receiver's MODEL in hand, resolving every key
 * against `prisma/schema.prisma`.
 *
 * Resolving by TYPE rather than by field name is what makes that walk sound: 16
 * field names in this schema are declared `User` (42 declarations), and `createdBy` is one of them
 * on some models and a plain `String` on another. A name-keyed pass either misses
 * the relations it does not list or flags the scalar it cannot tell apart.
 *
 * Measured when it landed: the walk reports the SAME 16 files as the receiver-only
 * pass it replaced — it loses nothing — and the tree holds no relation-reached read
 * today. The widening is preventive, and `usersActiveInAnotherTenant` in
 * `tenant-context.ts` is the adjudicator's own read already using the shape.
 *
 * KNOWN LIMITS, both shared with `check-bypass-rls.mjs`:
 *   - the receiver is matched by NAME (`tx.user.findUnique`), so a read through an
 *     aliased model handle is not seen. Resolving that needs a Program, which no
 *     gate in this tree carries.
 *   - a COMPUTED projection key (`select: { [col]: true }`) is skipped rather than
 *     failed closed. `retention-gc-worker/sweep.ts` builds one from a closed union
 *     of Tenant retention columns; failing closed there would buy a manifest entry
 *     whose stated reason would have to be false.
 *
 * Env: OWNING_TENANT_CHECK_ROOT overrides the repo root (used by the self-test).
 */
import { SyntaxKind } from "ts-morph";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createAstProject, sourceFilesFrom } from "./lib/ast-project.mjs";
import { bindingIndex } from "./lib/scope-bindings.mjs";
import { RLS_CONTEXT, rlsContextOf } from "./lib/rls-context.mjs";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const ROOT = process.env.OWNING_TENANT_CHECK_ROOT ?? REPO_ROOT;
const SCAN_ROOT = "src";

const HELPER = "resolveOwningTenantIdFromClient";

/** Every read shape that can return a row's scalars. */
const READ_METHODS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
]);


const MANIFEST_PATH = "scripts/checks/owning-tenant-adjudicator-manifest.json";
const SCHEMA_PATH = "prisma/schema.prisma";

/** `User`'s own fields that name the tenant the row is filed under. */
const USER_TENANT_FIELDS = new Set(["tenantId", "tenant"]);

/**
 * `model -> (field -> declared type)`, plus the Prisma client handle each model
 * answers to (`TenantMember` -> `tenantMember`), from the schema itself.
 *
 * Derived rather than listed because the projection walk needs the owning model
 * to classify a key at all — see the header. Fail-loud on a schema it cannot
 * read: a gate that silently resolves every field to "unknown" would flag the
 * whole tree, and one that resolved them to "not a relation" would flag none.
 */
function loadSchema() {
  const abs = join(ROOT, SCHEMA_PATH);
  if (!existsSync(abs)) {
    console.error(`\nFAIL: prisma schema not found at ${abs}. The projection walk resolves every projection key against it.`);
    process.exit(1);
  }
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
    const field = /^[ \t]+(\w+)[ \t]+([A-Za-z_]\w*)/.exec(line);
    if (field) current.set(field[1], field[2]);
  }

  if (models.size === 0) {
    console.error(`\nFAIL: parsed zero models from ${abs}.`);
    process.exit(1);
  }
  if (!models.has("User")) {
    console.error(`\nFAIL: ${abs} declares no User model, so no read can be classified.`);
    process.exit(1);
  }

  const handles = new Map([...models.keys()].map((m) => [m[0].toLowerCase() + m.slice(1), m]));
  return { models, handles };
}

const { models: MODELS, handles: HANDLES } = loadSchema();

/**
 * Dispositions live in a JSON sidecar, not inline, so the self-test can supply
 * its own against a synthetic tree. An inline map would make the completeness
 * checks below meaningless under any root but this repo's — and those checks are
 * the half that stops the class growing silently.
 */
function loadManifest() {
  const abs = join(ROOT, MANIFEST_PATH);
  if (!existsSync(abs)) {
    console.error(`\nFAIL: manifest not found at ${abs}.`);
    process.exit(1);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf8"));
  } catch (e) {
    console.error(`\nFAIL: manifest at ${abs} is not valid JSON: ${e.message}`);
    process.exit(1);
  }
  const map = new Map();
  for (const [rel, value] of Object.entries(parsed)) {
    map.set(rel, [value.disposition, value.reason ?? ""]);
  }
  if (map.size === 0) {
    console.error(`\nFAIL: manifest at ${abs} is empty.`);
    process.exit(1);
  }
  return map;
}

const MANIFEST = loadManifest();

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === "__tests__") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(relative(ROOT, p));
  }
  return out;
}

/**
 * The read is constrained when the nearest enclosing call that opens an RLS
 * context around it opens a TENANT one. Resolved by scope, with imports read by
 * their original name, through `lib/rls-context.mjs` — the file-wide name lookup
 * this replaced trusted a sibling function's wrapper, a shadowing parameter, and a
 * wrapper that ran the callback outside its opener (round 5, S3/T2).
 */
function isConstrained(call, sf, bindingsFor) {
  return rlsContextOf(call, sf, bindingsFor) === RLS_CONTEXT.TENANT;
}

const asObject = (node) =>
  node && node.getKind() === SyntaxKind.ObjectLiteralExpression ? node : null;
const initializerOf = (prop) => prop?.getInitializer?.() ?? null;

/**
 * Walk one projection object, whose keys are fields of `model`. Returns the path
 * taken to a user's tenant identity, or null.
 *
 * FAIL-CLOSED throughout: a key this cannot resolve, or a value it cannot read,
 * counts as reaching one. "Could not decide" must not be spelled like "safe" —
 * and a Prisma read with no `select` returns every scalar, `tenantId` included,
 * so the UNPROJECTED shape is the broadest, not an exempt one. An earlier version
 * answered "no" for it and was red-proved blind to a bare `findUnique`, an
 * `include:` and a `findMany` — the completeness half of this gate never firing.
 */
function scanProjection(projection, model, trail) {
  for (const prop of projection.getProperties()) {
    if (prop.getKind() !== SyntaxKind.PropertyAssignment) return [...trail, "<spread>"];
    // See the header: a computed key is skipped, not failed closed.
    if (prop.getNameNode().getKind() === SyntaxKind.ComputedPropertyName) continue;

    const key = prop.getName();
    if (key === "_count") continue;
    const type = MODELS.get(model)?.get(key);
    const value = initializerOf(prop);
    const here = [...trail, key];
    if (!type) return [...here, "<unresolved-field>"];

    if (type === "User") {
      const nested = asObject(value);
      if (!nested) return [...here, value?.getText() === "true" ? "<all-scalars>" : "<unreadable>"];
      const select = initializerOf(nested.getProperty("select"));
      // No `select` on the relation (an `include:`, a bare `where:`) returns
      // every User scalar.
      if (!select) return [...here, "<all-scalars>"];
      if (!asObject(select)) return [...here, "select:<unreadable>"];
      const reached = scanProjection(asObject(select), "User", here);
      if (reached) return reached;
      continue;
    }

    if (model === "User" && USER_TENANT_FIELDS.has(key)) return here;

    // A relation to some other model: only its own scalars come back unless the
    // read descends further, so follow the descent and nothing else.
    if (MODELS.has(type)) {
      const nested = asObject(value);
      if (!nested) {
        if (value?.getText() === "true") continue;
        return [...here, "<unreadable>"];
      }
      for (const root of ["select", "include"]) {
        const sub = initializerOf(nested.getProperty(root));
        if (!sub) continue;
        if (!asObject(sub)) return [...here, `${root}:<unreadable>`];
        const reached = scanProjection(asObject(sub), type, here);
        if (reached) return reached;
      }
    }
  }
  return null;
}

/** Does this read return a user's tenant identity, directly or through a relation? */
function readsUserTenantIdentity(call, model) {
  const args = asObject(call.getArguments()[0]);
  if (!args) return model === "User" ? [`${model}`, "<all-scalars>"] : null;

  const select = initializerOf(args.getProperty("select"));
  // `include` does not restrict scalars — it returns every scalar PLUS a
  // relation — so an `include`-only read of `user` is the broad shape. Reading it
  // as a projection made it look NARROWER than an unprojected one and exempted
  // it; red-proved on `findUnique({ include: { accounts: true } })`.
  if (!select && model === "User") return [`${model}`, "<all-scalars>"];

  for (const root of ["select", "include"]) {
    const node = initializerOf(args.getProperty(root));
    if (!node) continue;
    if (!asObject(node)) return [`${model}`, `${root}:<unreadable>`];
    const reached = scanProjection(asObject(node), model, [model]);
    if (reached) return reached;
  }
  return null;
}

if (!existsSync(join(ROOT, SCAN_ROOT))) {
  console.error(`\nFAIL: scan root ${join(ROOT, SCAN_ROOT)} does not exist.`);
  process.exit(1);
}

const files = walk(join(ROOT, SCAN_ROOT));
console.log(
  `check-owning-tenant-adjudicator: ROOT=${ROOT} FILES=${files.length} MANIFEST=${MANIFEST.size}`,
);

// "Examined nothing" must not be spelled like "found nothing".
if (files.length === 0) {
  console.error(`\nFAIL: scanned zero source files under ${SCAN_ROOT}.`);
  process.exit(1);
}

const project = createAstProject();
const failures = [];
/** rel -> { unconstrained: number[], usesHelper: boolean, anyRead: boolean } */
const seen = new Map();
let scanned = 0;

for (const { rel, sf } of sourceFilesFrom(project, files, ROOT)) {
  scanned += 1;
  let record = null;
  let bindings;
  const bindingsFor = () => (bindings ??= bindingIndex(sf));

  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) continue;
    const method = callee.getName();

    if (method === HELPER || callee.getText().endsWith(`.${HELPER}`)) continue;
    if (!READ_METHODS.has(method)) continue;

    const recv = callee.getExpression();
    if (recv.getKind() !== SyntaxKind.PropertyAccessExpression) continue;
    const handle = recv.getName();
    // An unresolvable handle is not a read this gate can clear. Every read in the
    // tree resolved when the walk landed, so this arm costs nothing today and
    // refuses to guess if that stops being true.
    const model = HANDLES.get(handle);
    const path = model ? readsUserTenantIdentity(call, model) : [`${handle}`, "<unresolved-model>"];
    if (!path) continue;

    record ??= { unconstrained: [], usesHelper: false, anyRead: false };
    record.anyRead = true;
    if (!isConstrained(call, sf, bindingsFor)) {
      record.unconstrained.push({ line: call.getStartLineNumber(), path: path.join(".") });
    }
  }

  // A CALL, not any identifier: an unused `import { resolveOwningTenantIdFromClient }`
  // satisfied the "adjudicator" disposition on its own.
  const callsHelper = sf
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .some((c) => {
      const e = c.getExpression();
      return e.getText() === HELPER || e.getText().endsWith(`.${HELPER}`);
    });
  if (callsHelper) {
    record ??= { unconstrained: [], usesHelper: false, anyRead: false };
    record.usesHelper = true;
  }

  if (record) seen.set(rel, record);
}

if (scanned === 0) {
  console.error(`\nFAIL: resolved zero scannable source files from ${files.length} paths.`);
  process.exit(1);
}

for (const [rel, record] of seen) {
  const entry = MANIFEST.get(rel);

  if (!entry) {
    failures.push(
      `${rel}: reads a user's tenant identity (or calls ${HELPER}) with no MANIFEST ` +
        `entry. Add one: "adjudicator" if it resolves through ${HELPER}, ` +
        `"tenant-scoped" if every read sits inside withTenantRls / withUserTenantRls / ` +
        `withTeamTenantRls, or "column-intended" WITH A REASON if the unconstrained ` +
        `read is deliberate.`,
    );
    continue;
  }

  const [disposition, reason] = entry;

  if (disposition === "column-intended") {
    if (!reason) {
      failures.push(`${rel}: "column-intended" without a reason. State why the stale copy is correct here.`);
    }
    continue;
  }

  if (disposition === "adjudicator" || disposition === "tenant-scoped") {
    for (const { line, path } of record.unconstrained) {
      failures.push(
        `${rel}:${line}: reads a user's tenant identity (${path}) OUTSIDE any ` +
          `tenant-scoped context, but the MANIFEST says "${disposition}". Under a ` +
          `bypass this returns \`User.tenantId\` — a denormalized copy with no ` +
          `invalidation — so the value decides a tenant no reader opens. Resolve it ` +
          `with ${HELPER}, or move the read inside a tenant-scoped opener.`,
      );
    }
  }

  if (disposition === "adjudicator" && !record.usesHelper) {
    failures.push(
      `${rel}: MANIFEST says "adjudicator" but the file never references ${HELPER}. ` +
        `Either it stopped resolving a user's tenant (drop the entry) or the ` +
        `resolution was replaced by something else.`,
    );
  }
}

// The reverse direction: a stale entry must not sit here reading as coverage.
for (const rel of MANIFEST.keys()) {
  if (!seen.has(rel)) {
    failures.push(
      `${rel}: MANIFEST entry with no user-tenant read and no ${HELPER} reference ` +
        `left in the file. Remove the entry — a manifest that outlives its subject ` +
        `reports a class member that is no longer there.`,
    );
  }
}

if (failures.length > 0) {
  console.error(`\nFAIL: ${failures.length} problem(s):\n`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}

const adjudicator = [...MANIFEST.values()].filter(([d]) => d === "adjudicator").length;
console.log(
  `check-owning-tenant-adjudicator: OK (${seen.size} files carry a user-tenant ` +
    `resolution; ${adjudicator} route it through ${HELPER}, no unconstrained read ` +
    `outside a declared exception)`,
);
