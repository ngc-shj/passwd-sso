#!/usr/bin/env node
/**
 * CI tripwire (AST, ts-morph): a React state updater must be pure.
 *
 * React may call an updater more than once — StrictMode double-invokes it in
 * development, and a concurrent render can discard and replay it. A side effect
 * inside one therefore runs a different number of times than the code reads.
 * Three sites shipped that way (plan: close-coverage-and-clipboard-gaps, C7):
 * a nested setter that decremented an unread badge twice, a reveal timer that
 * a manual hide could not cancel, and a localStorage write per invocation.
 *
 * An UPDATER is a call to `set[A-Z]…` (other than setTimeout / setInterval /
 * setImmediate) whose single argument is an inline arrow or function
 * expression. Its body is flagged when it calls, anywhere inside it:
 *   - another setter (`set[A-Z]…`, which includes the timers);
 *   - a timer (`setTimeout`, `setInterval`, `setImmediate`, `clearTimeout`,
 *     `clearInterval`, `requestAnimationFrame`, `queueMicrotask`);
 *   - `toast` or a `toast.*` method;
 *   - storage (`localStorage.*`, `sessionStorage.*`, at any depth);
 *   - `fetch` / `fetchApi`;
 *   - an `on[A-Z]…` callback (`onChange(x)`, `props.onSave(x)`).
 *
 * CONTROL CLASS: best-effort tripwire over src/, not a boundary. Known
 * bypasses: a setter not named `set*`, an updater passed by reference
 * (`setX(update)`), and a side effect reached through a helper the updater
 * calls. Refuses (exit 1) an unparseable file and an empty file list, so
 * "examined nothing" never reads as "found nothing".
 *
 * Run: node scripts/checks/check-state-updater-purity.mjs
 *
 * STATE_UPDATER_PURITY_ROOT overrides the scan root (self-test fixtures only).
 */
import { SyntaxKind } from "ts-morph";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAstProject, sourceFilesFrom } from "./lib/ast-project.mjs";

const NAME = "check-state-updater-purity";
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.STATE_UPDATER_PURITY_ROOT || join(__dirname, "..", "..");

// The override exists for the self-test; left set in CI it would silently
// point the gate at another tree.
if (
  process.env.CI === "true" &&
  process.env.STATE_UPDATER_PURITY_ROOT &&
  process.env.STATE_UPDATER_PURITY_FIXTURE_MODE !== "1"
) {
  console.error(
    `${NAME}: STATE_UPDATER_PURITY_ROOT must not be set in CI. ` +
      "Set STATE_UPDATER_PURITY_FIXTURE_MODE=1 only from the self-test.",
  );
  process.exit(1);
}

const SCAN_ROOTS = ["src"];
const SETTER = /^set[A-Z]/;
const CALLBACK = /^on[A-Z]/;
const NOT_A_SETTER = new Set(["setTimeout", "setInterval", "setImmediate"]);
const TIMERS = new Set([
  "setTimeout",
  "setInterval",
  "setImmediate",
  "clearTimeout",
  "clearInterval",
  "requestAnimationFrame",
  "queueMicrotask",
]);
const FETCHERS = new Set(["fetch", "fetchApi"]);
const STORAGES = new Set(["localStorage", "sessionStorage"]);
const FUNCTION_KINDS = new Set([SyntaxKind.ArrowFunction, SyntaxKind.FunctionExpression]);

/** The identifier chain of a callee: `a.b.c(...)` → ["a", "b", "c"]; null for anything else. */
function calleeChain(expr) {
  if (expr.getKind() === SyntaxKind.Identifier) return [expr.getText()];
  if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
    const head = calleeChain(expr.getExpression());
    return head ? [...head, expr.getName()] : [expr.getName()];
  }
  return null;
}

function calleeName(call) {
  const chain = calleeChain(call.getExpression());
  return chain ? chain[chain.length - 1] : null;
}

function isUpdater(call) {
  const name = calleeName(call);
  if (name === null || !SETTER.test(name) || NOT_A_SETTER.has(name)) return false;
  const args = call.getArguments();
  return args.length === 1 && FUNCTION_KINDS.has(args[0].getKind());
}

/** Why `call` is a side effect, or null when it is not one this gate knows. */
function sideEffectKind(call) {
  const chain = calleeChain(call.getExpression());
  if (chain === null) return null;
  const name = chain[chain.length - 1];
  if (TIMERS.has(name)) return "timer";
  // Before the setter test: `localStorage.setItem` is storage, not a setter.
  if (chain.some((part) => STORAGES.has(part))) return "storage";
  if (chain[0] === "toast") return "toast";
  if (chain.length === 1 && FETCHERS.has(name)) return "fetch";
  if (CALLBACK.test(name)) return "callback";
  if (SETTER.test(name)) return "setter";
  return null;
}

let files;
try {
  files = [...sourceFilesFrom(createAstProject(), SCAN_ROOTS, ROOT)];
} catch (err) {
  console.error(`${NAME}: ${err.message}`);
  process.exit(1);
}

if (files.length === 0) {
  console.error(`ZERO_FILES_SCANNED: ${NAME} found no source files under ${SCAN_ROOTS.join(", ")} (root ${ROOT}).`);
  process.exit(1);
}

const parseErrors = [];
const sites = [];

for (const { rel, sf } of files) {
  const diagnostics = sf.compilerNode.parseDiagnostics;
  if (!Array.isArray(diagnostics) || diagnostics.length > 0) {
    parseErrors.push(rel);
    continue;
  }
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (!isUpdater(call)) continue;
    const body = call.getArguments()[0];
    const effects = body
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .map((inner) => ({ inner, kind: sideEffectKind(inner) }))
      .filter(({ kind }) => kind !== null)
      .map(({ inner, kind }) => `${kind} \`${inner.getExpression().getText()}\` (line ${inner.getStartLineNumber()})`);
    if (effects.length > 0) {
      sites.push({ rel, line: call.getStartLineNumber(), setter: calleeName(call), effects });
    }
  }
}

if (parseErrors.length > 0) {
  console.error(`PARSE_ERROR: ${NAME} could not analyse these files:`);
  for (const p of parseErrors) console.error(`  ${p}`);
  process.exit(1);
}

if (sites.length > 0) {
  console.error(`IMPURE_STATE_UPDATER: ${sites.length} updater(s) with side effects:`);
  for (const s of sites) {
    console.error(`  ${s.rel}:${s.line}  ${s.setter}(…) calls ${s.effects.join(", ")}`);
  }
  console.error(
    "\nReact may run an updater more than once. Compute the next state purely, and make the side " +
      "effect outside the updater (in the event handler, or in an effect keyed on the state).",
  );
  process.exit(1);
}

console.log(`${NAME}: OK (${files.length} files)`);
