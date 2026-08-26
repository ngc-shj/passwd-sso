#!/usr/bin/env node
/**
 * CI guard (AST, ts-morph): an error- or fatal-level pino log emitted by a
 * worker must carry a `_logType` string literal.
 *
 * docs/operations/alerts.md tells the operator to match on `_logType`. A worker
 * error log without one is therefore not merely undocumented — it is invisible
 * to every rule that document describes, and its absence from the SIEM reads
 * exactly like a healthy pipeline. That is the same manufactured-assurance
 * shape as an RLS-less read returning zero rows: the signal cannot arrive, and
 * nothing distinguishes "cannot arrive" from "nothing to report".
 *
 * Measured before this gate existed: 22 error-level pino calls across
 * src/workers, three of which carried `_logType`. The three were the ones
 * somebody had written an alert rule for; the rule was true of those and of
 * nothing else, which is why a declaration in prose could not hold.
 *
 * CONTROL CLASS (R49): fail-closed verification gate over a BOUNDED scan root.
 * NOT an enforceable boundary — bypassable by editing the gate or by adding
 * code outside SEARCH_DIRS.
 *
 * Measured against a synthetic tree, not assumed:
 *   CAUGHT   `getLogger().error({...}, "x")` with no `_logType`; the same via a
 *            local binding (`const log = getLogger()`); a `_logType` that is not
 *            a string literal (a variable, a template with substitutions — none
 *            of which a SIEM rule can be written against); a non-object first
 *            argument (`log.error("x")`), which has nowhere to carry one
 *   PASSES   `_logType: "x"` as a string literal, inline or expanded; warn/info/
 *            debug levels; `console.error`, and any receiver not resolvable to
 *            `getLogger()`
 *   MISSED   a logger reached through a parameter, a field, or a data structure
 *            — the receiver has to be `getLogger()` or a same-file binding of it
 *
 * DELIBERATELY out of scope, not an oversight:
 *   - warn/info levels. The boundary is severity, and it is the one alerts.md
 *     documents. The dead-letter warns are named in alerts.md by hand instead.
 *   - `scripts/audit-chain-verify-worker.ts`, whose `logger` is `console` and
 *     whose lines are printf, not structured records. alerts.md already says
 *     CHAIN_VERIFY_FAILED carries no `_logType` and must be matched as raw
 *     stderr text. This gate reaches that file and does not flag it, because
 *     the receiver does not resolve to `getLogger()` — the exclusion is a
 *     property of the code, not a path on a list that can silently rot.
 *
 * Runs without a Program (in-memory project).
 */
import { SyntaxKind } from "ts-morph";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAstProject, sourceFilesFrom } from "./lib/ast-project.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.WORKER_LOGTYPE_ROOT
  ? process.env.WORKER_LOGTYPE_ROOT
  : join(__dirname, "..", "..");

// Env pollution guard, same reasoning as check-rls-read-context: the overrides
// exist for the self-test, and left ungated they are a way to silently NARROW
// what CI examines — `scanned === 0` fails loudly, but a wrong-but-non-empty
// scope prints OK.
const HAS_OVERRIDE =
  Boolean(process.env.WORKER_LOGTYPE_ROOT) ||
  Boolean(process.env.WORKER_LOGTYPE_DIRS);
if (
  process.env.CI === "true" &&
  HAS_OVERRIDE &&
  process.env.WORKER_LOGTYPE_FIXTURE_MODE !== "1"
) {
  console.error(
    "check-worker-logtype: WORKER_LOGTYPE_ROOT/DIRS must not be set in CI " +
      "(they would narrow the scan). Set WORKER_LOGTYPE_FIXTURE_MODE=1 only " +
      "from the self-test.",
  );
  process.exit(1);
}

const SEARCH_DIRS = (
  process.env.WORKER_LOGTYPE_DIRS ?? "src/workers,scripts"
)
  .split(",")
  .map((d) => d.trim())
  .filter(Boolean);

// Severity is the boundary. An error-level line is by definition something an
// operator is meant to see, so it is exactly the set alerts.md's rules cover.
const ALERT_LEVELS = new Set(["error", "fatal"]);

const LOGGER_FACTORY = "getLogger";
const LOGTYPE_PROP = "_logType";

function fail(msg) {
  console.error(`check-worker-logtype: ${msg}`);
  process.exit(1);
}

/** Names bound to `getLogger()` in this file (`const log = getLogger()`). */
function loggerBindings(sf) {
  const names = new Set();
  for (const decl of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const init = decl.getInitializer();
    if (!init || init.getKind() !== SyntaxKind.CallExpression) continue;
    if (init.getExpression().getText() !== LOGGER_FACTORY) continue;
    if (decl.getNameNode().getKind() !== SyntaxKind.Identifier) continue;
    names.add(decl.getName());
  }
  return names;
}

/** True when `recv` is `getLogger()` or a same-file binding of it. */
function isPinoLogger(recv, bindings) {
  if (recv.getKind() === SyntaxKind.CallExpression) {
    return recv.getExpression().getText() === LOGGER_FACTORY;
  }
  if (recv.getKind() === SyntaxKind.Identifier) {
    return bindings.has(recv.getText());
  }
  return false;
}

/**
 * "ok" | "missing" | "not-literal" | "no-object".
 *
 * A non-literal `_logType` is reported rather than accepted: an alert rule is
 * written against a fixed string, so a value the gate cannot read is a value
 * the operator cannot match — the same failure as no value at all, arriving
 * with the appearance of compliance.
 */
function logTypeVerdict(arg) {
  if (!arg || arg.getKind() !== SyntaxKind.ObjectLiteralExpression) {
    return "no-object";
  }
  for (const prop of arg.getProperties()) {
    if (prop.getKind() !== SyntaxKind.PropertyAssignment) continue;
    if (prop.getName() !== LOGTYPE_PROP) continue;
    const value = prop.getInitializer();
    const kind = value?.getKind();
    if (
      kind === SyntaxKind.StringLiteral ||
      kind === SyntaxKind.NoSubstitutionTemplateLiteral
    ) {
      return value.getLiteralText().trim() ? "ok" : "not-literal";
    }
    return "not-literal";
  }
  return "missing";
}

const REASON = {
  missing: `no ${LOGTYPE_PROP}`,
  "not-literal": `${LOGTYPE_PROP} is not a non-empty string literal`,
  "no-object": `first argument is not an object literal, so it carries no ${LOGTYPE_PROP}`,
};

const project = createAstProject();
const violations = [];
let scanned = 0;
let callSites = 0;

for (const { rel: path, sf } of sourceFilesFrom(project, SEARCH_DIRS, REPO_ROOT)) {
  if (path.includes("__tests__") || path.includes("__fixtures__")) continue;
  scanned++;

  const bindings = loggerBindings(sf);

  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) continue;
    if (!ALERT_LEVELS.has(expr.getName())) continue;
    if (!isPinoLogger(expr.getExpression(), bindings)) continue;

    callSites++;
    const verdict = logTypeVerdict(call.getArguments()[0]);
    if (verdict === "ok") continue;
    violations.push({
      path,
      line: call.getStartLineNumber(),
      level: expr.getName(),
      reason: REASON[verdict],
    });
  }
}

if (scanned === 0) {
  // "Examined nothing" must not be spelled like "found nothing wrong".
  fail(
    `scanned 0 source files under ${SEARCH_DIRS.join(", ")} — scan root is wrong or the tree moved`,
  );
}
if (callSites === 0) {
  // Nor may "recognised no logger call" be. Every way this gate could stop
  // seeing its subject — a renamed factory, a changed call shape, a moved
  // worker — lands here, and each would otherwise print OK forever.
  fail(
    `recognised 0 ${LOGGER_FACTORY}() error/fatal call sites under ${SEARCH_DIRS.join(", ")} — ` +
      `the logger is reached some way this gate does not model`,
  );
}

console.log(
  `check-worker-logtype: scanned ${scanned} files, ${callSites} error/fatal logger call sites`,
);

if (violations.length > 0) {
  console.error(
    `\ncheck-worker-logtype: ${violations.length} worker alert-level log(s) a SIEM rule cannot match:\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.path}:${v.line}  .${v.level}()  ->  ${v.reason}`);
  }
  console.error(
    `\ndocs/operations/alerts.md tells operators to match on ${LOGTYPE_PROP}. Without one
this line cannot reach any alert rule, and its absence from the SIEM is
indistinguishable from a healthy pipeline. Add ${LOGTYPE_PROP} with the same
identifier as the message.\n`,
  );
  process.exit(1);
}

console.log("check-worker-logtype: OK");
