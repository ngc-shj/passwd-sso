#!/usr/bin/env node
/**
 * CI guard (AST, ts-morph): a read or write against an RLS-protected table from
 * a worker or one-shot script must run inside a transaction that established an
 * RLS context — `$transaction` + `setBypassRlsGucs`, `withBypassRls`, or
 * `withTenantRls`. A statement issued on the top-level client instead is
 * evaluated with `app.tenant_id` unset (or reverted to '' after an earlier
 * transaction on that pooled connection), and the tenant_isolation policy then
 * either returns ZERO ROWS WITH NO ERROR or raises 22P02.
 *
 * Why this gate exists, and why it is not check-bypass-rls.mjs: that gate is an
 * ALLOWLIST over `withBypassRls` usage — it answers "who may bypass", and it
 * only parses files that mention one of its four helper NAMES. It is therefore
 * structurally unable to report a MISSING context, which is the defect class
 * that actually shipped three times:
 *   - audit-outbox-worker checkDepthAlert       (22P02 every 30s in production)
 *   - audit-outbox-worker processDeliveryBatch  (same, latent)
 *   - audit-chain-verify-worker                 (0 rows, silent, control inert)
 * Two of those live in a file the name-prefilter skipped, and the third is in
 * `scripts/`, which that gate does not scan at all. Matching spellings could not
 * close this; the mechanism had to change.
 *
 * CONTROL CLASS (R49): fail-closed verification gate over a BOUNDED scan root.
 * It is not an enforceable boundary — it is bypassable by editing the gate, by
 * aliasing a client through a shape it cannot resolve (`const p = prisma`), or
 * by adding code outside SEARCH_DIRS. What it guarantees is that within those
 * directories every recognised statement is decided, and that an unresolvable
 * subject FAILS rather than passing quietly. `src/app` and `src/lib` are out of
 * scope on purpose: request-path code runs inside withTenantRls established by
 * the proxy/route layer, which this gate does not model.
 *
 * Table set is DERIVED, never re-typed: manifest ∩ schema @@map.
 *
 * Runs without a Program (in-memory project).
 */
import { SyntaxKind } from "ts-morph";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAstProject, sourceFilesFrom } from "./lib/ast-project.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.RLS_READ_CONTEXT_ROOT
  ? process.env.RLS_READ_CONTEXT_ROOT
  : join(__dirname, "..", "..");

const SEARCH_DIRS = (
  process.env.RLS_READ_CONTEXT_DIRS ?? "src/workers,scripts"
)
  .split(",")
  .map((d) => d.trim())
  .filter(Boolean);

console.log(`check-rls-read-context: SEARCH_DIRS=${SEARCH_DIRS.join(", ")}`);

// Calls that establish an RLS context for their callback parameter.
const CONTEXT_ESTABLISHING = new Set([
  "$transaction",
  "withBypassRls",
  "withTenantRls",
  "withUserTenantRls",
  "withTeamTenantRls",
]);

const MODEL_METHODS = new Set([
  "findMany", "findFirst", "findFirstOrThrow", "findUnique",
  "findUniqueOrThrow", "count", "aggregate", "groupBy",
  "update", "updateMany", "updateManyAndReturn", "delete", "deleteMany",
  "create", "createMany", "createManyAndReturn", "upsert",
]);

const RAW_METHODS = new Set([
  "$queryRaw", "$queryRawUnsafe", "$executeRaw", "$executeRawUnsafe",
]);

function fail(msg) {
  console.error(`check-rls-read-context: ${msg}`);
  process.exit(1);
}

/** Manifest tables — the authoritative RLS table set. */
function loadRlsTables() {
  const p = join(REPO_ROOT, "scripts/rls-cross-tenant-tables.manifest");
  let raw;
  try {
    raw = readFileSync(p, "utf8");
  } catch (err) {
    // Fail loudly: an unreadable manifest must not be spelled like an empty one.
    fail(`cannot read ${p}: ${err.message}`);
  }
  const tables = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  if (tables.length === 0) fail(`manifest ${p} yielded 0 tables`);
  return new Set(tables);
}

/** table -> prisma client accessor, from schema @@map. */
function loadModelAccessors(rlsTables) {
  const p = join(REPO_ROOT, "prisma/schema.prisma");
  let schema;
  try {
    schema = readFileSync(p, "utf8");
  } catch (err) {
    fail(`cannot read ${p}: ${err.message}`);
  }
  const accessors = new Map();
  const modelRe = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
  let m;
  while ((m = modelRe.exec(schema)) !== null) {
    const [, modelName, body] = m;
    const mapped = body.match(/@@map\("([^"]+)"\)/);
    const table = mapped ? mapped[1] : modelName;
    if (!rlsTables.has(table)) continue;
    accessors.set(modelName[0].toLowerCase() + modelName.slice(1), table);
  }
  if (accessors.size === 0) {
    fail("derived 0 RLS model accessors from prisma/schema.prisma — the manifest/schema join broke");
  }
  return accessors;
}

// A parameter carrying one of these in its type annotation IS a transaction
// client: the caller opened the transaction and threaded it in. Matched on the
// annotation text, so it needs no Program.
const TX_TYPE_RE = /\b(TransactionClient|TxClient|RawExecutor)\b/;

/**
 * True when `recvText` names a binding that is already transaction-scoped:
 * either the parameter of a callback passed to a context-establishing call, or
 * a parameter annotated as a transaction client and threaded in by its caller.
 */
function hasRlsContext(node, recvText) {
  let cur = node.getParent();
  while (cur) {
    if (
      cur.getKind() === SyntaxKind.ArrowFunction ||
      cur.getKind() === SyntaxKind.FunctionExpression ||
      cur.getKind() === SyntaxKind.FunctionDeclaration ||
      cur.getKind() === SyntaxKind.MethodDeclaration
    ) {
      for (const param of cur.getParameters()) {
        if (param.getName() !== recvText) continue;
        const typeText = param.getTypeNode()?.getText() ?? "";
        if (TX_TYPE_RE.test(typeText)) return true;
      }
      const params = cur.getParameters().map((p) => p.getName());
      if (params.includes(recvText)) {
        const call = cur.getParent();
        if (call && call.getKind() === SyntaxKind.CallExpression) {
          const expr = call.getExpression();
          const name =
            expr.getKind() === SyntaxKind.PropertyAccessExpression
              ? expr.getName()
              : expr.getText();
          if (CONTEXT_ESTABLISHING.has(name)) return true;
        }
      }
    }
    cur = cur.getParent();
  }
  return false;
}

/** RLS tables named by a raw-SQL literal. */
function tablesInSql(text, rlsTables) {
  const hits = new Set();
  for (const t of rlsTables) {
    // Word-boundary match so `audit_logs` does not match `audit_logs_archive`.
    if (new RegExp(`\\b${t}\\b`).test(text)) hits.add(t);
  }
  return hits;
}

const rlsTables = loadRlsTables();
const modelAccessors = loadModelAccessors(rlsTables);
console.log(
  `check-rls-read-context: ${rlsTables.size} RLS tables, ${modelAccessors.size} model accessors`,
);

const project = createAstProject();
const violations = [];
let scanned = 0;

for (const { rel: path, sf } of sourceFilesFrom(project, SEARCH_DIRS, REPO_ROOT)) {
  if (
    /\.(test|spec)\.[cm]?tsx?$/.test(path) ||
    path.includes("__tests__") ||
    // Gate fixtures are deliberately-malformed inputs for OTHER gates.
    path.includes("__fixtures__") ||
    // Developer scratch tools, run by hand against a superuser URL. Not
    // shipped, not scheduled, and not part of any deployment path.
    path.includes("scripts/manual-tests/")
  ) {
    continue;
  }
  scanned++;

  // A script that refuses to run without RLS visibility has EARNED the bare
  // client: assertRlsVisibility fails closed on a NOSUPERUSER/NOBYPASSRLS role,
  // so its statements cannot be silently emptied. This is an exemption a file
  // has to implement, not one it gets by being named in a list here.
  if (sf.getFullText().includes("assertRlsVisibility(")) continue;

  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) continue;
    const method = expr.getName();
    const recv = expr.getExpression();

    let subject = null;
    let recvText = null;

    if (RAW_METHODS.has(method)) {
      const argText = call.getArguments()[0]?.getText() ?? "";
      const hits = tablesInSql(argText, rlsTables);
      if (hits.size === 0) continue;
      subject = [...hits].join(",");
      recvText = recv.getText();
    } else if (MODEL_METHODS.has(method)) {
      if (recv.getKind() !== SyntaxKind.PropertyAccessExpression) continue;
      const accessor = recv.getName();
      if (!modelAccessors.has(accessor)) continue;
      subject = modelAccessors.get(accessor);
      recvText = recv.getExpression().getText();
    } else {
      continue;
    }

    if (hasRlsContext(call, recvText)) continue;

    violations.push({
      path,
      line: call.getStartLineNumber(),
      recvText,
      method,
      subject,
    });
  }
}

if (scanned === 0) {
  // "Examined nothing" must not be spelled like "found nothing wrong".
  fail(
    `scanned 0 source files under ${SEARCH_DIRS.join(", ")} — scan root is wrong or the tree moved`,
  );
}

console.log(`check-rls-read-context: scanned ${scanned} files`);

if (violations.length > 0) {
  console.error(
    `\ncheck-rls-read-context: ${violations.length} RLS-table statement(s) with no RLS context:\n`,
  );
  for (const v of violations) {
    console.error(
      `  ${v.path}:${v.line}  ${v.recvText}.${v.method}  ->  ${v.subject}`,
    );
  }
  console.error(
    `\nWith no RLS context these run with app.tenant_id unset or '' — the policy
returns zero rows with no error, or raises 22P02. Wrap the statement in
$transaction + setBypassRlsGucs (workers), or withTenantRls/withBypassRls.\n`,
  );
  process.exit(1);
}

console.log("check-rls-read-context: OK");
