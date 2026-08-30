#!/usr/bin/env node
/**
 * CI guard (AST, ts-morph): a caught value must not be handed to a structured
 * logger. Reduce it with `errorLogFields` first.
 *
 * pino's default `err` serializer emits `message` AND `stack`, and
 * src/lib/logger.ts redacts by top-level KEY NAME, which never reaches message
 * text. A pg pool error's message reads `password authentication failed for
 * user "passwd_outbox_worker"`; a Prisma error's carries the failing query and
 * its bound parameters; an undici failure carries the target host. Those go to
 * stdout, get shipped, indexed, and read by people never meant to see them.
 *
 * WHY THIS GATE EXISTS RATHER THAN A SWEEP. The sweep came first and got the
 * class wrong three times over, while its own count reproduced exactly:
 *   - drawn at error/fatal, but `LOG_LEVEL` defaults to `info` and pino's
 *     warn(40) >= info(30), so warn reaches the same sink — 18 sites missed;
 *   - drawn at `src/workers` + one `src/lib` file, while the app-side twin of
 *     the very pool handler the first fix repaired sat untouched in
 *     src/lib/prisma.ts — 23 more;
 *   - and sites deriving `code` by hand kept the top-level read that the
 *     helper's own docblock declares wrong for Prisma errors.
 * An honest count of the wrong class is the failure mode this closes. The class
 * is derived here from its defining primitive — a binding introduced by a
 * `catch` clause, reaching a logger call's field object — not from a list.
 *
 * CONTROL CLASS (R49): fail-closed verification gate over a BOUNDED scan root.
 * NOT an enforceable boundary — bypassable by editing the gate, by logging
 * through a receiver it does not model, or by adding code outside SEARCH_DIRS.
 *
 * Measured against a synthetic tree, not assumed:
 *   CAUGHT   `log.error({ err }, …)` and every other level; a renamed binding
 *            (`catch (e)`); a nested property (`{ ctx: { err } }`); a template
 *            or concatenation embedding the binding (`` `${e.message}` ``); a
 *            member read (`err.message`, `err.stack`); `String(err)`;
 *            a binding logged from a nested function inside the catch block
 *   PASSES   `errorLogFields(err)` in any position; a catch binding used OUTSIDE
 *            a logger call (`throw err`, `recordError(prisma, row, err)`,
 *            `onError(id, err)`, `if (isLockTimeout(err))`); a logger call whose
 *            fields hold no catch binding; a shadowing binding of the same name
 *            declared inside the catch block
 *   MISSED   a logger reached through a parameter or a data structure; a caught
 *            value stored to an outer variable and logged after the block
 *            closes (the anchor-publisher's `uploadFailedReason` shape — caught
 *            by review, not by this gate, and named here so the next reader
 *            knows the boundary)
 *
 * Runs without a Program (in-memory project).
 */
import { SyntaxKind } from "ts-morph";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAstProject,
  sourceFilesFrom,
  unresolvedTargets,
} from "./lib/ast-project.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.CAUGHT_ERROR_LOG_ROOT
  ? process.env.CAUGHT_ERROR_LOG_ROOT
  : join(__dirname, "..", "..");

// Env pollution guard: the overrides exist for the self-test, and left ungated
// they are a way to silently NARROW what CI examines. `scanned === 0` fails
// loudly, but a wrong-but-non-empty scope prints OK.
const HAS_OVERRIDE =
  Boolean(process.env.CAUGHT_ERROR_LOG_ROOT) ||
  Boolean(process.env.CAUGHT_ERROR_LOG_DIRS);
if (
  process.env.CI === "true" &&
  HAS_OVERRIDE &&
  process.env.CAUGHT_ERROR_LOG_FIXTURE_MODE !== "1"
) {
  console.error(
    "check-caught-error-logging: CAUGHT_ERROR_LOG_ROOT/DIRS must not be set in " +
      "CI (they would narrow the scan). Set CAUGHT_ERROR_LOG_FIXTURE_MODE=1 " +
      "only from the self-test.",
  );
  process.exit(1);
}

// The whole application and its entrypoint scripts — NOT `src/workers` alone.
// Narrowing this is what let the app-side pool handler sit un-fixed beside the
// worker-side one that had already been repaired.
const SEARCH_DIRS = (
  process.env.CAUGHT_ERROR_LOG_DIRS ?? "src,scripts"
)
  .split(",")
  .map((d) => d.trim())
  .filter(Boolean);

// Every level, not the alerting subset. `LOG_LEVEL` defaults to `info`, so warn
// and info are written and shipped exactly like error — severity decides which
// alert rule matches, never whether the bytes leave the host.
const LOG_METHODS = new Set([
  "error", "fatal", "warn", "info", "debug", "trace",
]);

const REDUCER = "errorLogFields";

function fail(msg) {
  console.error(`check-caught-error-logging: ${msg}`);
  process.exit(1);
}

/**
 * The innermost `catch` clause enclosing `node`, or null.
 *
 * Returns the CLAUSE, not its name. Comparing names instead reports a nested
 * `catch (err)` inside an outer `catch (err)` twice — once from each clause's
 * own walk — because the two bindings are distinct while their names are equal.
 * Measured: two offending lines produced three findings.
 */
function innermostCatchClause(node) {
  for (let cur = node.getParent(); cur; cur = cur.getParent()) {
    if (cur.getKind() === SyntaxKind.CatchClause) return cur;
  }
  return null;
}

/** True when `expr` shadows `name` with its own declaration before use. */
function isShadowed(node, name) {
  for (let cur = node.getParent(); cur; cur = cur.getParent()) {
    if (typeof cur.getStatements !== "function") continue;
    for (const stmt of cur.getStatements()) {
      if (stmt.getKind() !== SyntaxKind.VariableStatement) continue;
      for (const decl of stmt.getDeclarations()) {
        const n = decl.getNameNode();
        if (n.getKind() === SyntaxKind.Identifier && n.getText() === name) {
          return true;
        }
      }
    }
    if (cur.getKind() === SyntaxKind.CatchClause) return false;
  }
  return false;
}

/**
 * The property of `objectLiteral` that carries `name`, or null.
 *
 * Any REFERENCE counts — the identifier alone, a member read (`err.message`),
 * a template (`` `${e}` ``), a call (`String(err)`), or a nested object. The
 * defect is the value reaching the serializer, and every one of those spellings
 * delivers it. `errorLogFields(x)` is the one form that does not, because it
 * returns a fresh bounded object.
 */
function offendingProperty(objectLiteral, name) {
  const ref = new RegExp(`(^|[^\\w$])${name}([^\\w$]|$)`);
  for (const prop of objectLiteral.getProperties()) {
    const kind = prop.getKind();
    if (
      kind !== SyntaxKind.PropertyAssignment &&
      kind !== SyntaxKind.ShorthandPropertyAssignment &&
      kind !== SyntaxKind.SpreadAssignment
    ) {
      continue;
    }
    const text = prop.getText();
    if (!ref.test(text)) continue;
    // Reduced already. Checked on the property, not the whole call, so a call
    // that reduces one field and leaks another is still reported.
    if (new RegExp(`${REDUCER}\\s*\\(`).test(text)) continue;
    return prop;
  }
  return null;
}

{
  const missing = unresolvedTargets(SEARCH_DIRS, REPO_ROOT);
  if (missing.length > 0) {
    fail(
      `scan target(s) resolved to no source file: ${missing.join(", ")} — ` +
        `moved, renamed, or misspelled. A target the gate cannot find is not a ` +
        `target it may skip.`,
    );
  }
}

const project = createAstProject();
const violations = [];
let scanned = 0;
let catchBlocks = 0;

for (const { rel: path, sf } of sourceFilesFrom(project, SEARCH_DIRS, REPO_ROOT)) {
  if (
    path.includes("__tests__") ||
    path.includes("__fixtures__") ||
    /\.test\.tsx?$/.test(path)
  ) {
    continue;
  }
  scanned++;

  for (const clause of sf.getDescendantsOfKind(SyntaxKind.CatchClause)) {
    const decl = clause.getVariableDeclaration();
    if (!decl) continue;
    const nameNode = decl.getNameNode();
    if (nameNode.getKind() !== SyntaxKind.Identifier) continue;
    catchBlocks++;
    const bound = nameNode.getText();

    for (const call of clause.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expr = call.getExpression();
      if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) continue;
      if (!LOG_METHODS.has(expr.getName())) continue;

      const arg = call.getArguments()[0];
      if (!arg || arg.getKind() !== SyntaxKind.ObjectLiteralExpression) continue;

      // Innermost catch OWNS the call. A nested try/catch rebinding the same
      // name means the identifier no longer refers to the outer value, and
      // attributing the line to both clauses reports one defect twice.
      if (innermostCatchClause(call) !== clause) continue;
      if (isShadowed(call, bound)) continue;

      const prop = offendingProperty(arg, bound);
      if (!prop) continue;
      violations.push({
        path,
        line: call.getStartLineNumber(),
        level: expr.getName(),
        key: prop.getKind() === SyntaxKind.SpreadAssignment ? "…spread" : prop.getName(),
      });
    }
  }
}

if (scanned === 0) {
  fail(
    `scanned 0 source files under ${SEARCH_DIRS.join(", ")} — scan root is ` +
      `wrong or the tree moved`,
  );
}
if (catchBlocks === 0) {
  // "Recognised no subject" must not be spelled like "found nothing wrong":
  // a changed catch shape, a moved tree, or a broken parse all land here.
  fail(
    `recognised 0 catch clauses under ${SEARCH_DIRS.join(", ")} — the gate is ` +
      `not seeing its subject`,
  );
}

console.log(
  `check-caught-error-logging: scanned ${scanned} files, ${catchBlocks} catch clauses`,
);

if (violations.length > 0) {
  console.error(
    `\ncheck-caught-error-logging: ${violations.length} caught value(s) handed ` +
      `to a logger:\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.path}:${v.line}  .${v.level}()  ->  field "${v.key}"`);
  }
  console.error(
    `\npino's default serializer emits the message AND the stack, and
src/lib/logger.ts redacts by key name — which never reaches message text. A pg
error's message carries the DB role and host; a Prisma error's carries the query
and its parameters. Wrap it:  ${REDUCER}(err)  from @/lib/logger/error-fields.\n`,
  );
  process.exit(1);
}

console.log("check-caught-error-logging: OK");
