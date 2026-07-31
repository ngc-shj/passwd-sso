#!/usr/bin/env node
/**
 * C5 completeness gate (AST, ts-morph): every writer of `tenant_claims` must
 * append a routing-history event in the same function, and
 * `tenant_claim_events` must have exactly one producer.
 *
 * WHY AST AND NOT GREP. Two of the six writers create their claim row through a
 * NESTED relation write inside `tenant.create({ data: { claims: { create … } } })`
 * — a `tenantClaim.create` grep returns neither, and those two are the sign-in
 * auto-registration path, i.e. the writer an incident responder most needs.
 * A grep also cannot tell a mutation from a read.
 *
 * WHY IT SCANS `scripts/` TOO. Four of the six writers live in
 * `scripts/tenant-domain.ts`. `check-critical-audit-atomic.mjs` — the sibling
 * this gate's shape borrows from — has `SEARCH_DIRS = ["src/app/api", "src/lib"]`
 * and would see none of them. The scan root is parameterised from the start so
 * the self-test never has to migrate it.
 *
 * THREE PREDICATES, because one is not enough:
 *
 *   (1) Per enclosing function, `recordTenantClaimEvent` calls >= EFFECTIVE
 *       writer statements. Two shapes force this and a weaker form fails one:
 *         - `cmdAdd`'s three writers share ONE withBypassRls callback, so a
 *           tree-wide "every operation appears somewhere" existence check is
 *           blind — with its create arm unemitted, `register` still appears via
 *           tenant-management.ts and the gate would green.
 *         - `findOrCreateTenantForClaim` has TWO writer statements (a create and
 *           its catch-clause retry) and the contract mandates ONE event, so a
 *           naive statement count reds on compliant source.
 *       "Effective" is what separates them: a writer whose path to the enclosing
 *       function passes through a `catch` is a mutually exclusive ALTERNATIVE of
 *       the write in the corresponding `try`, not a second logical write. The
 *       contract states the requirement ("alternatives of one logical write must
 *       not be counted twice"); this catch-clause test is the admissible
 *       implementation it names.
 *
 *   (1b) Every operation literal a producer call names must be a member of
 *       TENANT_CLAIM_EVENT_OPERATION, read from the const-object itself. This is
 *       what consumes the operation-set derivation: without it a typo'd literal
 *       is invisible here and surfaces only as a CHECK violation at run time.
 *
 *   (2) Function-scoped presence — writers present, no producer. Subsumed by (1)
 *       arithmetically; kept because it is what produces the useful message.
 *
 *   (3) Single producer — a `tenantClaimEvent` WRITE-verb delegate call outside
 *       the producer module, or a `RETURNING` inside it. Reads are permitted:
 *       `tenant-domain history` reads the table from `scripts/`, and a
 *       verb-blind rule would ban the contract's own required read path and be
 *       repaired by loosening — and the loosening that admits `findMany` is the
 *       one that can readmit a write.
 *
 * FAIL-CLOSED ON AN EMPTY INPUT. `walkSourceFiles` returns [] for a missing
 * directory by design ("Missing directories yield an empty list (never
 * throws)"), and all three predicates above detect VIOLATIONS — zero files means
 * zero violations means exit 0. `check-critical-audit-atomic.mjs` survives that
 * only incidentally, because its predicate requires each action to be SEEN. So
 * this gate asserts a non-zero analysed-file count and a non-zero writer count
 * before it is allowed to print OK.
 *
 * Runs without a Program (in-memory project).
 *
 * Exit: 0 ok · 1 coverage violation · 2 the gate could not run (empty scan,
 * unreadable derived input) — never conflated, because "found nothing wrong" and
 * "looked at nothing" are different answers.
 */
import { SyntaxKind } from "ts-morph";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAstProject, sourceFilesFrom } from "./lib/ast-project.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The repo root is FIXED and is where the derived inputs are read from, even
 * when the scan root is overridden. The sibling gates move their auxiliary
 * files with the override; doing that here would make the self-test exercise
 * fake copies of the schema and the const-object shipped inside the fixture
 * tree, i.e. never the real derivation.
 */
const REPO_ROOT = join(__dirname, "..", "..");
const SCAN_ROOT_OVERRIDE = process.env.TENANT_CLAIM_EVENT_COVERAGE_ROOT;
const SCAN_ROOT = SCAN_ROOT_OVERRIDE || REPO_ROOT;
const SEARCH_DIRS = ["src", "scripts"];

/**
 * sec-F6 env-pollution guard, adopted from `check-gate-selftest-coverage.sh`.
 *
 * The empty-scan and zero-writer floors below do NOT cover this case: an
 * override pointing at any tree containing one compliant writer — which is
 * exactly what this gate's own self-test fixture is — yields a non-zero file
 * count, a non-zero writer count, zero violations and a green OK, while the
 * real source is never read. A stray `export` leaking into a CI run would
 * therefore retire the gate silently and permanently.
 */
if (process.env.CI === "true" && SCAN_ROOT_OVERRIDE) {
  if (process.env.TENANT_CLAIM_EVENT_COVERAGE_FIXTURE_MODE !== "1") {
    console.error(
      "ENV_POLLUTION_GUARD: TENANT_CLAIM_EVENT_COVERAGE_ROOT is set under CI=true " +
        "without TENANT_CLAIM_EVENT_COVERAGE_FIXTURE_MODE=1 — refusing to run against " +
        "a possibly-unintended path.",
    );
    process.exit(2);
  }
}

/** The one module allowed to write `tenant_claim_events`. */
const PRODUCER_MODULE = "src/lib/tenant/tenant-claim-event.ts";
const PRODUCER_FN = "recordTenantClaimEvent";

/** Prisma delegate verbs that WRITE. Reads are deliberately absent. */
const WRITE_VERBS = new Set([
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
]);

const fail = (msg) => {
  console.error(`check-tenant-claim-event-coverage: ${msg}`);
  process.exit(2);
};

/**
 * The nested-relation field name, read from the Prisma schema rather than
 * spelled here. Without a Program the AST cannot resolve `claims:` to the
 * Tenant→TenantClaim relation, so the gate is matching an IDENTIFIER — and
 * `claims:` is also the DPoP claim bag, used at 20+ unrelated sites, which is
 * why the match below is additionally scoped to a `tenant.create(...)` argument.
 * A schema rename must retire the match, not the gate.
 */
function deriveRelationField() {
  let schema;
  try {
    schema = readFileSync(join(REPO_ROOT, "prisma", "schema.prisma"), "utf8");
  } catch {
    fail("cannot read prisma/schema.prisma — the nested-relation field name is derived from it");
  }
  const model = /model\s+Tenant\s*\{([\s\S]*?)\n\}/.exec(schema);
  if (!model) fail("no `model Tenant` in prisma/schema.prisma");
  const field = /^\s*(\w+)\s+TenantClaim\[\]/m.exec(model[1]);
  if (!field) fail("no `TenantClaim[]` relation field on model Tenant");
  return field[1];
}

/**
 * The operation values, read from the const-object. `check-critical-audit-atomic`
 * is the right precedent for predicate (1) and the WRONG one for this half: it
 * hardcodes its action set in the gate, and copying that would leave a fifth
 * operation uncovered while every committed fixture stayed green.
 */
function deriveOperations() {
  let src;
  try {
    src = readFileSync(join(REPO_ROOT, PRODUCER_MODULE), "utf8");
  } catch {
    fail(`cannot read ${PRODUCER_MODULE} — the operation set is derived from it`);
  }
  const block = /TENANT_CLAIM_EVENT_OPERATION\s*=\s*\{([\s\S]*?)\}\s*as const/.exec(src);
  if (!block) fail(`no TENANT_CLAIM_EVENT_OPERATION const-object in ${PRODUCER_MODULE}`);
  const ops = new Set([...block[1].matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1]));
  if (ops.size === 0) fail("TENANT_CLAIM_EVENT_OPERATION is empty");
  return ops;
}

const RELATION_FIELD = deriveRelationField();
const OPERATIONS = deriveOperations();

/**
 * C1's forbidden patterns, and this gate is their declared runner. A forbidden
 * pattern with no runner is the shape D-13 recorded one PR ago — a rule that
 * reads as enforced and is not.
 *
 * The migration is located by CONTENT, not by a spelled filename: a timestamped
 * directory name is exactly the kind of literal that goes stale silently, and a
 * gate that stops finding its subject must say so (below) rather than pass.
 */
const MIGRATION_FORBIDDEN = [
  [
    /REFERENCES\s+"?tenant/,
    "a foreign key to tenants/tenant_claims re-arms the ON DELETE CASCADE this table exists to escape",
  ],
  [
    /app\.bypass_rls/,
    "the escape GUC must not be the one every withBypassRls() call already sets",
  ],
  [
    /SECURITY DEFINER/,
    "definer rights make the principal columns a constant (I2 vacuous) and open a grantable deletion capability",
  ],
];

function checkMigrationForbiddenPatterns() {
  // SUBJECT, not derived identifier — so it follows the scan root. The two
  // derived identifiers (the relation field, the operation set) stay pinned to
  // the repo root so the self-test exercises the real derivation; the things
  // being CHECKED are what the override is for, and a runner the self-test
  // cannot red is the shape RT7 exists to catch.
  const dir = join(SCAN_ROOT, "prisma", "migrations");
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    fail("cannot read prisma/migrations — C1's forbidden patterns have no subject");
  }
  const found = [];
  for (const name of entries) {
    let sql;
    try {
      sql = readFileSync(join(dir, name, "migration.sql"), "utf8");
    } catch {
      continue;
    }
    if (!/CREATE TABLE\s+"?tenant_claim_events"?/.test(sql)) continue;
    found.push(name);
    for (const [re, reason] of MIGRATION_FORBIDDEN) {
      if (re.test(sql)) {
        violations.push(
          `prisma/migrations/${name}/migration.sql: forbidden pattern ${re} — ${reason}.`,
        );
      }
    }
  }
  if (found.length === 0) {
    fail(
      "no migration creates tenant_claim_events — C1's forbidden patterns were checked " +
        "against nothing. Finding no subject is not the same answer as finding no violation.",
    );
  }
}

/** `<expr>.<obj>.<verb>` → { obj, verb }, or null. */
function delegateCall(call) {
  const callee = call.getExpression();
  if (!callee.isKind(SyntaxKind.PropertyAccessExpression)) return null;
  const verb = callee.getName();
  const inner = callee.getExpression();
  if (!inner.isKind(SyntaxKind.PropertyAccessExpression)) return null;
  return { obj: inner.getName(), verb };
}

/**
 * Prisma properties that can carry a nested relation write. `create` takes
 * `data:`; `upsert` splits the same payload across `create:` and `update:`, so
 * a gate that looked only under `data` would register no writer for
 * `tenant.upsert({ where, create: { …, claims: { create … } }, update })` and
 * silently stop requiring an event there — a blind spot in a control declared
 * fail-closed.
 */
const NESTED_WRITE_CARRIERS = ["data", "create", "update"];

/** Does this `tenant.<write>(...)` argument nest a claim-row write? */
function nestsClaimWrite(call) {
  const arg = call.getArguments()[0];
  if (!arg || !arg.isKind(SyntaxKind.ObjectLiteralExpression)) return false;
  for (const carrier of NESTED_WRITE_CARRIERS) {
    const payload = arg.getProperty(carrier);
    if (!payload) continue;
    const rel = payload
      .getDescendantsOfKind(SyntaxKind.PropertyAssignment)
      .find((p) => p.getName() === RELATION_FIELD);
    if (!rel) continue;
    if (/\b(create|createMany|connectOrCreate)\b/.test(rel.getText())) return true;
  }
  return false;
}

/** The innermost function-like ancestor, or null at module scope. */
function enclosingFunction(node) {
  return (
    node.getFirstAncestor(
      (a) =>
        a.isKind(SyntaxKind.FunctionDeclaration) ||
        a.isKind(SyntaxKind.FunctionExpression) ||
        a.isKind(SyntaxKind.ArrowFunction) ||
        a.isKind(SyntaxKind.MethodDeclaration),
    ) ?? null
  );
}

/** Is `node` inside a catch clause that is itself inside `fn`? */
function insideCatchWithin(node, fn) {
  const cc = node.getFirstAncestorByKind(SyntaxKind.CatchClause);
  return cc !== undefined && (fn === null || cc.getStart() >= fn.getStart());
}

const violations = [];
checkMigrationForbiddenPatterns();

const project = createAstProject();
let analysedFiles = 0;
let writerCount = 0;

for (const { rel, sf } of sourceFilesFrom(project, SEARCH_DIRS, SCAN_ROOT)) {
  analysedFiles += 1;
  const isProducerModule = rel === PRODUCER_MODULE;

  // SQL text only, never the whole file: the module's own comment explains WHY
  // there is no RETURNING, and a full-text match would fire on that explanation
  // — a forbidden pattern that reds on its own rationale gets deleted, not
  // obeyed.
  if (isProducerModule) {
    const sql = [
      ...sf.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral),
      ...sf.getDescendantsOfKind(SyntaxKind.TemplateExpression),
      ...sf.getDescendantsOfKind(SyntaxKind.StringLiteral),
    ];
    for (const node of sql) {
      if (!/\bRETURNING\b/i.test(node.getText())) continue;
      violations.push(
        `${rel}:${node.getStartLineNumber()}: RETURNING in the producer module's SQL — ` +
          `passwd_app holds INSERT but not SELECT, so a returning INSERT fails at run time ` +
          `on the sign-in path and passes every mocked test.`,
      );
    }
  }

  // per-function tallies, keyed by the enclosing function node
  const perFn = new Map();
  const bump = (fn, key) => {
    const k = fn ?? sf;
    if (!perFn.has(k)) perFn.set(k, { writers: 0, producers: 0, line: 0 });
    const e = perFn.get(k);
    e[key] += 1;
    return e;
  };

  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const d = delegateCall(call);

    // predicate (3): second producer
    if (d && d.obj === "tenantClaimEvent" && WRITE_VERBS.has(d.verb) && !isProducerModule) {
      violations.push(
        `${rel}:${call.getStartLineNumber()}: tenantClaimEvent.${d.verb}() outside ${PRODUCER_MODULE}. ` +
          `There is exactly one producer; reads are permitted, writes are not.`,
      );
    }

    // predicate (1b): the operation literal must be a known member
    const callee = call.getExpression();
    if (callee.getText().endsWith(PRODUCER_FN)) {
      const fn = enclosingFunction(call);
      const e = bump(fn, "producers");
      e.line ||= call.getStartLineNumber();
      // The event must be written on the caller's TRANSACTION client. The type
      // cannot say so — `Prisma.TransactionClient` is `Omit<PrismaClient, …>`,
      // which a `PrismaClient` satisfies structurally — so the obvious
      // regression is passing the global proxy, which commits independently of
      // the mutation and loses exactly the atomicity this table exists for.
      //
      // A SPELLING check, and its limit is enumerated rather than discovered:
      // without a Program this matches the identifier `prisma`, so it catches
      // the direct spelling and not an aliased binding. It is a tripwire on top
      // of the callers, not a proof of in-transaction execution — the gate
      // proves an event is emitted in the same function, which is necessary and
      // not sufficient.
      const dbArg = call.getArguments()[0];
      if (dbArg?.isKind(SyntaxKind.Identifier) && dbArg.getText() === "prisma" && !isProducerModule) {
        violations.push(
          `${rel}:${call.getStartLineNumber()}: ${PRODUCER_FN}() called with the global \`prisma\` client. ` +
            `The event must commit with its mutation; pass the enclosing transaction client.`,
        );
      }

      const arg = call.getArguments()[1];
      const named = arg?.getDescendantsOfKind(SyntaxKind.PropertyAssignment)
        .find((p) => p.getName() === "operation");
      const lit = named?.getInitializer();
      if (lit?.isKind(SyntaxKind.StringLiteral) && !OPERATIONS.has(lit.getLiteralValue())) {
        violations.push(
          `${rel}:${call.getStartLineNumber()}: operation "${lit.getLiteralValue()}" is not a member of ` +
            `TENANT_CLAIM_EVENT_OPERATION — the database CHECK will reject it at run time.`,
        );
      }
    }

    // member-set writers: spelling 1 (delegate) and spelling 2 (nested relation)
    const isSpelling1 = d && d.obj === "tenantClaim" && WRITE_VERBS.has(d.verb);
    const isSpelling2 =
      d && d.obj === "tenant" && WRITE_VERBS.has(d.verb) && nestsClaimWrite(call);
    if (!isSpelling1 && !isSpelling2) continue;

    writerCount += 1;
    const fn = enclosingFunction(call);
    // A writer inside a `catch` is the alternative arm of the write in the
    // corresponding `try` — one logical registration, retried — so it must not
    // be counted a second time.
    if (insideCatchWithin(call, fn)) continue;
    const e = bump(fn, "writers");
    e.line ||= call.getStartLineNumber();
  }

  for (const [, e] of perFn) {
    if (e.writers === 0) continue;
    if (e.producers === 0) {
      violations.push(
        `${rel}:${e.line}: writes tenant_claims but calls no ${PRODUCER_FN}() — ` +
          `every routing change must append its history row in the same transaction.`,
      );
    } else if (e.producers < e.writers) {
      violations.push(
        `${rel}:${e.line}: ${e.writers} tenant_claims writer(s) but only ${e.producers} ` +
          `${PRODUCER_FN}() call(s) in the same function — one of the arms emits no event.`,
      );
    }
  }
}

if (analysedFiles === 0) {
  fail(
    `analysed 0 files under ${SCAN_ROOT} (${SEARCH_DIRS.join(", ")}). ` +
      `A missing directory yields an empty walk, and every predicate here detects a ` +
      `VIOLATION — so an empty scan would print OK while looking at nothing.`,
  );
}
if (writerCount === 0) {
  fail(
    `analysed ${analysedFiles} file(s) but found no tenant_claims writer at all. ` +
      `The member set is non-empty by construction; finding none means the writer ` +
      `patterns no longer match the source, not that the source is clean.`,
  );
}

if (violations.length > 0) {
  console.error("check-tenant-claim-event-coverage: FAIL");
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}

console.log(
  `check-tenant-claim-event-coverage: OK (${writerCount} tenant_claims writer(s) across ` +
    `${analysedFiles} file(s); relation field "${RELATION_FIELD}", ${OPERATIONS.size} operations)`,
);
