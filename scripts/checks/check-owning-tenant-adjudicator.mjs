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
 * KNOWN LIMIT — the callee is matched by NAME (`user.findUnique`), so a read
 * reached through an aliased model handle is not seen. Resolving that needs a
 * Program, which no gate in this tree carries; `check-bypass-rls.mjs` documents
 * the same boundary.
 *
 * Env: OWNING_TENANT_CHECK_ROOT overrides the repo root (used by the self-test).
 */
import { SyntaxKind } from "ts-morph";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createAstProject, sourceFilesFrom } from "./lib/ast-project.mjs";

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

/** Openers that establish `app.tenant_id`, so RLS constrains the row. */
const TENANT_SCOPED = new Set(["withTenantRls", "withUserTenantRls", "withTeamTenantRls"]);

const MANIFEST_PATH = "scripts/checks/owning-tenant-adjudicator-manifest.json";

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
 * Does `name` resolve, in this file, to something that opens a tenant-scoped
 * context? One level deep, and fail-closed: an unresolvable name is not safe.
 */
function resolvesToTenantScoped(name, sf) {
  if (TENANT_SCOPED.has(name)) return true;
  const reached = openersReachableFrom(name, sf, new Set());
  // Order matters: a wrapper whose own text names a tenant opener may still
  // delegate to another wrapper that opens a bypass. Checking "names a tenant
  // opener" first returns SAFE for exactly that shape — measured, on the
  // one-level version this replaced.
  if (reached.has("withBypassRls")) return false;
  return [...TENANT_SCOPED].some((o) => reached.has(o));
}

/**
 * Every opener name reachable from `name`'s declaration in this file, following
 * local identifier callees transitively. `seen` is the cycle guard.
 *
 * Fail-closed: a name that resolves to no local declaration contributes nothing,
 * so a read wrapped only in unresolvable calls stays UNCONSTRAINED.
 */
function openersReachableFrom(name, sf, seen) {
  if (seen.has(name)) return new Set();
  seen.add(name);
  if (TENANT_SCOPED.has(name) || name === "withBypassRls") return new Set([name]);

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

/** The read is constrained when any enclosing call resolves to a tenant opener. */
function isConstrained(call, sf) {
  for (let n = call.getParent(); n; n = n.getParent()) {
    if (n.getKind() !== SyntaxKind.CallExpression) continue;
    const callee = n.getExpression();
    if (callee.getKind() !== SyntaxKind.Identifier) continue;
    if (resolvesToTenantScoped(callee.getText(), sf)) return true;
  }
  return false;
}

/**
 * Does this read return a tenant identity?
 *
 * FAIL-CLOSED on an absent or unreadable projection. A Prisma read with no
 * `select` returns every scalar, `tenantId` included — so "no select" is the
 * BROADEST shape, not an exempt one, and the first version of this function
 * answered `false` for it. That version was red-proved blind to a bare
 * `findUnique`, an `include:` and a `findMany`, which is the completeness half
 * of this gate — the half the header credits with stopping the class growing
 * silently — never firing.
 */
function selectsTenantIdentity(call) {
  const arg = call.getArguments()[0];
  // No argument object at all, or one this gate cannot read: assume the broad
  // shape rather than the narrow one.
  if (!arg || arg.getKind() !== SyntaxKind.ObjectLiteralExpression) return true;

  // `select` ONLY. `include` does not restrict scalars — it returns every scalar
  // PLUS a relation — so reading it here made an `include`-only read look
  // NARROWER than an unprojected one and exempted it. Red-proved: a
  // `findUnique({ include: { accounts: true } })` under a bypass passed the gate
  // whose docstring names `include` as a shape it fails closed on.
  const projection = arg.getProperty?.("select");
  if (!projection) return true; // no select (with or without include) -> all scalars

  const text = projection.getText();
  // A projection that is not an inline literal (`select: SEL`, a spread) is
  // undecidable here, so it counts.
  const init = projection.getInitializer?.();
  if (!init || init.getKind() !== SyntaxKind.ObjectLiteralExpression) return true;

  return /\btenantId\s*:/.test(text) || /\btenant\s*:/.test(text);
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

  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) continue;
    const method = callee.getName();

    if (method === HELPER || callee.getText().endsWith(`.${HELPER}`)) continue;
    if (!READ_METHODS.has(method)) continue;

    const recv = callee.getExpression();
    if (recv.getKind() !== SyntaxKind.PropertyAccessExpression) continue;
    if (recv.getName() !== "user") continue;
    if (!selectsTenantIdentity(call)) continue;

    record ??= { unconstrained: [], usesHelper: false, anyRead: false };
    record.anyRead = true;
    if (!isConstrained(call, sf)) record.unconstrained.push(call.getStartLineNumber());
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
    for (const line of record.unconstrained) {
      failures.push(
        `${rel}:${line}: reads a user's tenant identity OUTSIDE any tenant-scoped ` +
          `context, but the MANIFEST says "${disposition}". Under a bypass this ` +
          `returns \`User.tenantId\` — a denormalized copy with no invalidation — ` +
          `so the value decides a tenant no reader opens. Resolve it with ` +
          `${HELPER}, or move the read inside a tenant-scoped opener.`,
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
