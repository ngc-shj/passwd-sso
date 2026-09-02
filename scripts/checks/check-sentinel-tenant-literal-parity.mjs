#!/usr/bin/env node
/**
 * The sentinel tenant's UUID is written down in five places that must agree, and
 * four of them cannot dereference the fifth.
 *
 *   src/lib/constants/app.ts          SYSTEM_TENANT_ID  (the definition)
 *   prisma/migrations/…_add_dcr_cleanup_worker_role_and_system_tenant
 *                                     the `tenants` row itself
 *   prisma/migrations/…_forbid_system_tenant_membership
 *                                     the CHECK that keeps it memberless
 *   docs/operations/alerts.md         the unattributable-event query
 *   docs/operations/sentinel-tenant-membership.md
 *                                     the membership incident runbook
 *
 * Why the `tenants` row is in scope and not just the CHECK: that row is the FK
 * target of audit_logs.tenant_id and audit_outbox.tenant_id. A gate watching
 * only the CHECK goes green on a change that leaves no `tenants` row for the new
 * UUID — at which point every unattributable audit emit FK-fails into
 * logAuditAsync's log-only catch arm, and the gap #806 closed is open again with
 * this gate reporting OK.
 *
 * ─── Why an expected-site MANIFEST rather than a value search ──────────────
 *
 * The obvious implementation — read the constant, grep prisma/ for it, compare —
 * is fail-open in exactly the direction this gate exists to catch. Change a
 * literal and it stops matching, so it DROPS OUT of the match set: the gate sees
 * fewer occurrences, finds no mismatch, and exits 0. The drift it was built for
 * is the one it cannot see.
 *
 * Anchoring on shape instead (every UUID literal under prisma/) fails the other
 * way: SYSTEM_ACTOR_ID is also there, twice, and would mismatch on an unmodified
 * tree.
 *
 * So the sites are NAMED, and the gate asserts three things about each: the file
 * exists, it carries the constant's value, and it carries it exactly as many
 * times as the manifest says. A site that has moved or been renamed is a
 * refusal, not a silent pass — "examined nothing" must not be spelled the same
 * as "found nothing".
 *
 * The COUNT is what makes a multi-occurrence site checkable. Presence alone is
 * enough for a file that spells the UUID once, and silently wrong for one that
 * spells it more: docs/operations/sentinel-tenant-membership.md carries it four
 * times — once in prose and three times in queries an operator pastes — and a
 * gate asking only "does this file contain the value" stays green while three of
 * the four drift. Adding a legitimate fifth occurrence reds the gate too; the
 * fix is to update the number here, which is the point of a named manifest.
 *
 * ─── Direction of repair ───────────────────────────────────────────────────
 *
 * Applied migrations are checksummed; editing one makes `prisma migrate` report
 * a modified-after-applied migration on every deployed database. The SQL sites
 * are immutable. If this gate reds, the CONSTANT is what moves.
 *
 * The constant is read by AST rather than by regex: its initializer is an
 * `as const` assertion, and a regex that happens to work today is one
 * reformatting away from matching the wrong thing or nothing at all.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Project, ts } from "ts-morph";

const { SyntaxKind } = ts;
const REPO_ROOT = process.env.SENTINEL_PARITY_ROOT
  ? resolve(process.env.SENTINEL_PARITY_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Env pollution guard, mirroring the sibling gate: the override exists for the
// self-test, and left ungated it is a way to point CI's parity check at a
// fixture tree that trivially agrees with itself. The refusals below fail
// loudly on a missing site, but a wrong-but-complete root prints OK.
if (
  process.env.CI === "true" &&
  process.env.SENTINEL_PARITY_ROOT &&
  process.env.SENTINEL_PARITY_FIXTURE_MODE !== "1"
) {
  console.error(
    "check-sentinel-tenant-literal-parity: SENTINEL_PARITY_ROOT must not be set " +
      "in CI (it would point the check at a tree that is not the one shipping). " +
      "Set SENTINEL_PARITY_FIXTURE_MODE=1 only from the self-test.",
  );
  process.exit(1);
}

const CONSTANT_FILE = "src/lib/constants/app.ts";
const CONSTANT_NAME = "SYSTEM_TENANT_ID";

/**
 * Named sites, each with how many times it must spell the literal. The
 * migration directories are matched by suffix because their timestamps are not
 * ours to predict; the suffix is the part a human chose and will not drift.
 */
const SQL_SITES = [
  {
    dirSuffix: "_add_dcr_cleanup_worker_role_and_system_tenant",
    occurrences: 1,
    what: "the sentinel `tenants` row (FK target of audit_logs / audit_outbox)",
  },
  {
    dirSuffix: "_forbid_system_tenant_membership",
    occurrences: 1,
    what: "the CHECK that keeps the sentinel memberless",
  },
  {
    dirSuffix: "_set_system_tenant_audit_retention",
    // Two: the guard reads audit_chain_enabled for this tenant, then the UPDATE
    // targets it. Both must move together if the constant ever does.
    occurrences: 2,
    what: "the retention that bounds the sentinel's audit growth, and its chain-off guard",
  },
];

/**
 * Operator-facing copies. These are not SQL the engine runs — they are queries a
 * human pastes during an incident, which is what makes their drift dangerous in
 * a quieter way: a stale UUID here counts rows for a tenant nothing writes to
 * and returns a reassuring zero, at the one moment somebody is asking whether
 * unattributable events are piling up.
 *
 * docs/archive/review/** is deliberately OUT of scope: those are historical
 * records of what was true when written, annotated rather than rewritten.
 */
const DOC_SITES = [
  {
    path: "docs/operations/alerts.md",
    // Two: the unattributable-event diagnostic query, and the capture query an
    // operator runs before the first retention sweep drops rows older than the
    // window. Both are pasted mid-incident, which is what puts them in scope.
    occurrences: 2,
    what: "the unattributable-event diagnostic and pre-sweep capture queries",
  },
  {
    path: "docs/operations/sentinel-tenant-membership.md",
    occurrences: 4,
    what: "the membership incident runbook (prose + three operator queries)",
  },
];

function fail(msg) {
  console.error(`check-sentinel-tenant-literal-parity: ${msg}`);
  process.exit(1);
}

/** How many times `text` spells `value`. Plain substring count — the value is a UUID. */
function countOccurrences(text, value) {
  return text.split(value).length - 1;
}

const UUID_LITERAL_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * The UUID-shaped literals a site spells that are NOT the expected value.
 *
 * Reported alongside the count because "the constant is what moves" is useless
 * advice without saying what to move it TO: the SQL half is checksummed, so a
 * reader who has to open an applied migration to find the other value is being
 * sent to the one file they must not edit. Deduplicated and sorted so a site
 * carrying two different wrong values lists both rather than the first.
 */
function foreignUuids(text, expected) {
  const found = new Set();
  for (const m of text.match(UUID_LITERAL_RE) ?? []) {
    if (m.toLowerCase() !== expected.toLowerCase()) found.add(m.toLowerCase());
  }
  return [...found].sort();
}

function mismatchLine(label, found, site, text) {
  const foreign = foreignUuids(text, sentinelValue);
  return (
    `MISMATCH  ${label} spells ${sentinelValue} ${found} time(s), expected ${site.occurrences}\n` +
    `           (${site.what})\n` +
    `           ${CONSTANT_NAME} in ${CONSTANT_FILE} is ${sentinelValue}\n` +
    `           this site also spells: ${foreign.length > 0 ? foreign.join(", ") : "no other UUID literal"}`
  );
}

// ─── Read the constant by AST ──────────────────────────────────────────────

const constantPath = join(REPO_ROOT, CONSTANT_FILE);
if (!existsSync(constantPath)) {
  fail(`${CONSTANT_FILE} does not exist — the constant's home moved, and this gate cannot tell parity from absence`);
}

const project = new Project({ useInMemoryFileSystem: false, skipAddingFilesFromTsConfig: true });
const sf = project.addSourceFileAtPath(constantPath);

let sentinelValue = null;
for (const decl of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
  if (decl.getName() !== CONSTANT_NAME) continue;
  let init = decl.getInitializer();
  // `"…" as const` — unwrap the assertion to reach the literal.
  if (init && init.getKind() === SyntaxKind.AsExpression) init = init.getExpression();
  if (init && init.getKind() === SyntaxKind.StringLiteral) sentinelValue = init.getLiteralValue();
  break;
}

if (sentinelValue === null) {
  fail(
    `no string-literal declaration of ${CONSTANT_NAME} found in ${CONSTANT_FILE} — ` +
      `it was renamed, computed, or moved. Refusing rather than reporting parity ` +
      `against a value this gate never read`,
  );
}

// ─── Check each named SQL site ─────────────────────────────────────────────

const migrationsDir = join(REPO_ROOT, "prisma/migrations");
if (!existsSync(migrationsDir)) fail("prisma/migrations does not exist");
const migrationDirs = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

const problems = [];
let checked = 0;

for (const site of SQL_SITES) {
  const matches = migrationDirs.filter((d) => d.endsWith(site.dirSuffix));
  if (matches.length === 0) {
    problems.push(`MISSING  ${site.dirSuffix} — no migration directory with that suffix (${site.what})`);
    continue;
  }
  if (matches.length > 1) {
    problems.push(`AMBIGUOUS  ${site.dirSuffix} — ${matches.length} directories match; the gate cannot pick one`);
    continue;
  }
  const file = join(migrationsDir, matches[0], "migration.sql");
  if (!existsSync(file)) {
    problems.push(`MISSING  ${matches[0]}/migration.sql (${site.what})`);
    continue;
  }
  checked++;
  // Comments in these files legitimately mention the constant's NAME; what must
  // match is the value, so look for the literal itself.
  const sql = readFileSync(file, "utf8");
  const found = countOccurrences(sql, sentinelValue);
  if (found !== site.occurrences) {
    problems.push(mismatchLine(`${matches[0]}/migration.sql`, found, site, sql));
  }
}

for (const site of DOC_SITES) {
  const file = join(REPO_ROOT, site.path);
  if (!existsSync(file)) {
    problems.push(`MISSING  ${site.path} (${site.what})`);
    continue;
  }
  checked++;
  const text = readFileSync(file, "utf8");
  const found = countOccurrences(text, sentinelValue);
  if (found !== site.occurrences) {
    problems.push(mismatchLine(site.path, found, site, text));
  }
}

if (checked === 0) {
  fail(
    `examined 0 named sites — every one is missing, so this run proves ` +
      `nothing about parity`,
  );
}

if (problems.length > 0) {
  console.error(
    `check-sentinel-tenant-literal-parity: ${problems.length} site(s) out of parity ` +
      `with ${CONSTANT_NAME}:\n`,
  );
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    `\nApplied migrations are checksummed — editing one makes prisma migrate report
a modified-after-applied migration on every deployed database. The SQL sites are
the immutable half of this pair: if they disagree with the constant, the CONSTANT
is what moves.

Changing the sentinel is not a rename. The tenants row is the FK target of
audit_logs.tenant_id and audit_outbox.tenant_id, so a new value with no row
behind it makes every unattributable audit emit FK-fail into logAuditAsync's
log-only catch arm — silently, and with this gate green if it only watched the
CHECK.\n`,
  );
  process.exit(1);
}

console.log(
  `check-sentinel-tenant-literal-parity: ${CONSTANT_NAME} = ${sentinelValue}, ` +
    `${checked} site(s) in parity`,
);
console.log("check-sentinel-tenant-literal-parity: OK");
