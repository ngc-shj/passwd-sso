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
 * Measured before this gate existed: **25** error-level pino calls across
 * src/workers, **22** of which carried no `_logType`. The three that did were
 * the ones somebody had written an alert rule for; the rule was true of those
 * and of nothing else, which is why a declaration in prose could not hold.
 * (An earlier revision of this docblock said "22 calls, three of which carried
 * one" — the violation count restated as the total, which does not even
 * self-agree: 22 - 3 = 19. Re-derive rather than copy:
 *   T=$(mktemp -d); git archive <ref> | tar -x -C "$T"
 *   WORKER_LOGTYPE_ROOT=$T WORKER_LOGTYPE_DIRS=src/workers \
 *     WORKER_LOGTYPE_FIXTURE_MODE=1 node scripts/checks/check-worker-logtype.mjs
 * The default SEARCH_DIRS scans more than src/workers, so the printed
 * `scanned` count there is larger; the call-site count is the comparable one.)
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
 *   MISSED   a logger reached through a parameter, a field, or a data structure;
 *            `getLogger().child({...})`, whose result is a pino logger this gate
 *            does not follow; and an ASSIGNMENT-form binding (`let log; log =
 *            getLogger()`) — `loggerBindings` reads `const` initializers only.
 *            The receiver has to be `getLogger()` itself or a `const`-declared
 *            identifier initialized directly from it. All three were measured
 *            against a synthetic tree, and none occurs under the scan roots
 *            today; `.child()` is the one to watch, being pino's canonical
 *            per-worker pattern.
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
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAstProject,
  sourceFilesFrom,
  unresolvedTargets,
} from "./lib/ast-project.mjs";

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

// Directories, plus SINGLE FILES a worker drives from outside them.
//
// src/lib/webhook-dispatcher.ts is here because audit-outbox-worker.ts lazily
// imports deliverToWebhookRecords from it, so its error logs are emitted BY a
// worker while living outside src/workers — the gap between the class the doc
// states ("emitted by a worker") and the class a directory scan can see. Named
// individually rather than by widening to src/lib: most of src/lib only ever
// runs in a request, and a gate that reports hundreds of those is a gate that
// gets routed around.
const SEARCH_DIRS = (
  process.env.WORKER_LOGTYPE_DIRS ??
  "src/workers,scripts,src/lib/webhook-dispatcher.ts"
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

// The namespace set lives in alerts.md, not here, and is READ from there. A
// copy in the gate would be a second list to keep in step with the document the
// gate exists to keep true — and the first version of this gate demonstrated
// exactly that failure at one remove: it required a `_logType` to be PRESENT and
// never looked at its value, so `_logType: "zzz"` passed the gate and matched no
// rule in the document. `outbox.depth.alert` was already outside the documented
// namespaces when this was written, surviving only on a hand-written section.
const ALERT_NAMESPACE_MARKER = /<!--\s*alert-namespaces:\s*([^>]*?)\s*-->/;
const ALERTS_DOC = "docs/operations/alerts.md";

function loadAlertNamespaces() {
  const p = join(REPO_ROOT, ALERTS_DOC);
  let raw;
  try {
    raw = readFileSync(p, "utf8");
  } catch (err) {
    // Fail loudly: an unreadable contract must not be spelled like a satisfied one.
    fail(`cannot read ${p}: ${err.message}`);
  }
  const m = ALERT_NAMESPACE_MARKER.exec(raw);
  if (!m) {
    fail(
      `no '<!-- alert-namespaces: ... -->' marker in ${ALERTS_DOC} — the gate ` +
        `reads the enforced namespace set from there, and cannot enforce a set it cannot find`,
    );
  }
  const namespaces = m[1].split(/\s+/).filter(Boolean);
  if (namespaces.length === 0) {
    fail(`the alert-namespaces marker in ${ALERTS_DOC} lists no namespaces`);
  }
  return new Set(namespaces);
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
 * "ok" | "missing" | "not-literal" | "no-object" | "unknown-namespace".
 *
 * A non-literal `_logType` is reported rather than accepted: an alert rule is
 * written against a fixed string, so a value the gate cannot read is a value
 * the operator cannot match — the same failure as no value at all, arriving
 * with the appearance of compliance.
 *
 * The namespace check is what makes this about the DOCUMENT rather than about
 * the field's presence. `_logType: "zzz"` is a perfectly good string literal
 * and matches no rule alerts.md defines.
 */
function logTypeVerdict(arg, namespaces) {
  if (!arg || arg.getKind() !== SyntaxKind.ObjectLiteralExpression) {
    return { verdict: "no-object" };
  }
  for (const prop of arg.getProperties()) {
    if (prop.getKind() !== SyntaxKind.PropertyAssignment) continue;
    if (prop.getName() !== LOGTYPE_PROP) continue;
    const value = prop.getInitializer();
    const kind = value?.getKind();
    if (
      kind !== SyntaxKind.StringLiteral &&
      kind !== SyntaxKind.NoSubstitutionTemplateLiteral
    ) {
      return { verdict: "not-literal" };
    }
    const text = value.getLiteralText().trim();
    if (!text) return { verdict: "not-literal" };
    // The namespace is everything before the first dot; a bare identifier with
    // no dot is its own namespace, and must still be one the document names.
    const namespace = text.split(".")[0];
    if (!namespaces.has(namespace)) {
      return { verdict: "unknown-namespace", detail: namespace };
    }
    return { verdict: "ok" };
  }
  return { verdict: "missing" };
}

const REASON = {
  missing: () => `no ${LOGTYPE_PROP}`,
  "not-literal": () => `${LOGTYPE_PROP} is not a non-empty string literal`,
  "no-object": () =>
    `first argument is not an object literal, so it carries no ${LOGTYPE_PROP}`,
  "unknown-namespace": (ns) =>
    `${LOGTYPE_PROP} namespace "${ns}" is not one ${ALERTS_DOC} declares`,
};

// Same per-entry floor as check-rls-read-context: this gate also names a single
// file (src/lib/webhook-dispatcher.ts), and `callSites === 0` cannot fire while
// src/workers still resolves.
{
  const missing = unresolvedTargets(SEARCH_DIRS, REPO_ROOT);
  if (missing.length > 0) {
    fail(
      `scan target(s) resolved to no source file: ${missing.join(", ")} — ` +
        `moved, renamed, or misspelled. A target the gate cannot find is not a target it may skip.`,
    );
  }
}

const alertNamespaces = loadAlertNamespaces();
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
    const { verdict, detail } = logTypeVerdict(call.getArguments()[0], alertNamespaces);
    if (verdict === "ok") continue;
    violations.push({
      path,
      line: call.getStartLineNumber(),
      level: expr.getName(),
      reason: REASON[verdict](detail),
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
  `check-worker-logtype: scanned ${scanned} files, ${callSites} error/fatal logger call sites, ` +
    `namespaces from ${ALERTS_DOC}: ${[...alertNamespaces].sort().join(", ")}`,
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
