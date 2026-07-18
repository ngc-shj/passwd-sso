/**
 * AST classifier for fail-closed sibling tests — the code-vs-text oracle
 * behind check-fail-closed-routes-have-test.sh.
 *
 * Why AST: every grep-based predecessor of this classification was
 * false-green-able by construction — a comment, a describe label, or a
 * string literal satisfies a text match while carrying zero test semantics
 * (PR #680 external review; the same class recurred on the destructive-
 * wrapper and step-up guards before their AST passes). ts-morph parses the
 * file, so only real code nodes count: comments and string labels are
 * invisible to every check below.
 *
 * Usage: node scripts/checks/classify-fail-closed-test.mjs <file...>
 * Output (one line per input, tab-separated, stable order):
 *   <path>\texists=0|1 import=0|1 calls=<n> mock=0|1 redis=0|1
 * Field semantics:
 *   import — ImportDeclaration from "@/__tests__/helpers/fail-closed"
 *            whose named imports include assertRedisFailClosed
 *   calls  — count of CallExpressions whose callee SYMBOL is the helper's
 *            local import binding (alias-aware; shadowing local functions
 *            never count) AND which execute from a real test: nearest
 *            enclosing function is the callback of a non-skipped it/test
 *            registration with no skipped suite ancestor. Calls in unused
 *            functions, at top level, or under it.skip/describe.skip do not
 *            count.
 *   mock   — production-mapping stub present as CODE (RT5 anti-pattern):
 *            vi.mock("@/lib/security/rate-limit-audit", ...), a property
 *            assignment `checkRateLimitOrFail: <vi.fn…>`, or any use of an
 *            identifier named mockCheckRateLimitOrFail
 *   redis  — `redisErrored` appears as a CODE property/identifier
 *            (object-literal key, property access, or binding) — string
 *            literals and comments do NOT count (legacy-direct criterion)
 *
 * Exit: 0 on success (missing files are reported as exists=0, not errors);
 * 1 on any internal failure — the caller MUST treat that as a gate failure
 * (fail closed), never fall back to a text match.
 */

import { readFileSync } from "node:fs";
import { Project, SyntaxKind } from "ts-morph";

const HELPER_MODULE = "@/__tests__/helpers/fail-closed";
const HELPER_NAME = "assertRedisFailClosed";
const MAPPING_MODULE = "@/lib/security/rate-limit-audit";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: classify-fail-closed-test.mjs <file...>");
  process.exit(1);
}

const project = new Project({
  useInMemoryFileSystem: true,
  skipFileDependencyResolution: true,
  compilerOptions: { allowJs: true },
});

function classify(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { exists: 0, import: 0, calls: 0, mock: 0, redis: 0 };
  }

  const sf = project.createSourceFile(
    `/virtual/${path.replaceAll("\\", "_").replaceAll("/", "_")}.ts`,
    text,
    { overwrite: true },
  );

  // Resolve the LOCAL binding symbol of the helper's named import (alias-aware:
  // `{ assertRedisFailClosed as assertFailClosed }` binds the alias). Calls are
  // then matched by SYMBOL, not by name text — a local function shadowing the
  // imported name has a different symbol and never counts, while a legitimate
  // alias call does (PR #680 review round 3, 7.1).
  let hasImport = false;
  let helperSymbol;
  for (const imp of sf.getImportDeclarations()) {
    if (imp.getModuleSpecifierValue() !== HELPER_MODULE) continue;
    const spec = imp.getNamedImports().find((n) => n.getName() === HELPER_NAME);
    if (spec !== undefined) {
      hasImport = true;
      helperSymbol = (spec.getAliasNode() ?? spec.getNameNode()).getSymbol();
      break;
    }
  }

  const FUNCTION_LIKE = new Set([
    SyntaxKind.ArrowFunction,
    SyntaxKind.FunctionExpression,
    SyntaxKind.FunctionDeclaration,
    SyntaxKind.MethodDeclaration,
  ]);

  // Registration identifiers are bound to the "vitest" import's local symbols
  // (alias-aware), NOT matched by name — a local fake `it` or another
  // library's `test` has a different symbol and never registers anything
  // vitest would run (PR #680 review round 4, Major 1). Files using implicit
  // globals (no vitest import) yield zero registrations — fail-LOUD for this
  // repo, whose tests import from "vitest" explicitly.
  const vitestBindings = new Map(); // localSymbol -> imported name
  for (const imp of sf.getImportDeclarations()) {
    if (imp.getModuleSpecifierValue() !== "vitest") continue;
    for (const spec of imp.getNamedImports()) {
      const imported = spec.getName();
      if (imported !== "it" && imported !== "test" && imported !== "describe" && imported !== "suite") {
        continue;
      }
      const sym = (spec.getAliasNode() ?? spec.getNameNode()).getSymbol();
      if (sym !== undefined) vitestBindings.set(sym, imported);
    }
  }

  // Modifier ALLOWLIST: anything else (skip, todo, skipIf, runIf, fails,
  // unknown future APIs) means the callback is conditionally or never run —
  // treated as skipped rather than enumerating every skip-flavored API
  // (PR #680 review round 4, Major 2). Known residual (documented):
  // `it.each([])` with a statically empty array never runs its callback but
  // still counts — array-emptiness is the next rung, not taken here.
  const ALLOWED_MODIFIERS = new Set(["only", "concurrent", "sequential", "each"]);

  // Classify a CallExpression as a vitest registration: {kind, skipped} or null.
  // Handles `it(...)`, allowed modifiers, and the double-call shapes
  // `it.each(cases)(...)` / `it.skipIf(cond)(...)` (callee is a CallExpression).
  function registrationInfo(callExpr) {
    let expr = callExpr.getExpression();
    if (expr.getKind() === SyntaxKind.CallExpression) {
      expr = expr.getExpression(); // unwrap it.each(cases)(...) / it.skipIf(c)(...)
    }
    const modifiers = [];
    while (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
      modifiers.push(expr.getName());
      expr = expr.getExpression();
    }
    if (expr.getKind() !== SyntaxKind.Identifier) return null;
    const imported = vitestBindings.get(expr.getSymbol());
    if (imported === undefined) return null; // not a vitest binding (fake/local `it`)
    const skipped = modifiers.some((m) => !ALLOWED_MODIFIERS.has(m));
    if (imported === "describe" || imported === "suite") return { kind: "suite", skipped };
    return { kind: "test", skipped };
  }

  // A helper call counts ONLY when it executes from a real test: its nearest
  // enclosing function must be a callback argument of a non-skipped it/test
  // registration, with no skipped suite/test ancestor. Calls parked in unused
  // functions, at top level, or under it.skip/describe.skip never run in CI
  // and therefore never count (PR #680 review round 3, 7.2). Known residual
  // (documented): a call inside dead branches of a RUNNING test callback
  // (e.g. `if (false)`) still counts — static reachability inside a running
  // test is out of scope; deliberate evasion of that shape is a review matter.
  function isExecutedFromTest(call) {
    let node = call.getParent();
    let nearestFn;
    while (node !== undefined) {
      if (FUNCTION_LIKE.has(node.getKind())) {
        nearestFn = node;
        break;
      }
      node = node.getParent();
    }
    if (nearestFn === undefined) return false; // top-level call — vitest never runs it
    const parent = nearestFn.getParent();
    if (parent === undefined || parent.getKind() !== SyntaxKind.CallExpression) return false;
    if (!parent.getArguments().includes(nearestFn)) return false;
    const reg = registrationInfo(parent);
    if (reg === null || reg.kind !== "test" || reg.skipped) return false;
    let anc = parent.getParent();
    while (anc !== undefined) {
      if (anc.getKind() === SyntaxKind.CallExpression) {
        const ancReg = registrationInfo(anc);
        if (ancReg !== null && ancReg.skipped) return false;
      }
      anc = anc.getParent();
    }
    return true;
  }

  let calls = 0;
  let mock = false;
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (
      helperSymbol !== undefined &&
      callee.getKind() === SyntaxKind.Identifier &&
      callee.getSymbol() === helperSymbol &&
      isExecutedFromTest(call)
    ) {
      calls += 1;
    }
    // vi.mock("@/lib/security/rate-limit-audit", ...)
    if (
      callee.getKind() === SyntaxKind.PropertyAccessExpression &&
      callee.getText() === "vi.mock"
    ) {
      const firstArg = call.getArguments()[0];
      if (
        firstArg !== undefined &&
        firstArg.getKind() === SyntaxKind.StringLiteral &&
        firstArg.getLiteralText() === MAPPING_MODULE
      ) {
        mock = true;
      }
    }
  }

  let redis = false;
  for (const node of sf.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
    const name = node.getNameNode();
    if (name.getKind() === SyntaxKind.Identifier) {
      const id = name.getText();
      if (id === "redisErrored") redis = true;
      // `checkRateLimitOrFail: <anything>` inside a module-factory object is
      // the return-value-stub shape regardless of the initializer's spelling.
      if (id === "checkRateLimitOrFail") mock = true;
    }
  }
  for (const node of sf.getDescendantsOfKind(SyntaxKind.ShorthandPropertyAssignment)) {
    const id = node.getName();
    if (id === "redisErrored") redis = true;
    if (id === "checkRateLimitOrFail") mock = true;
  }
  if (!redis) {
    for (const node of sf.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
      if (node.getName() === "redisErrored") {
        redis = true;
        break;
      }
    }
  }
  if (!redis) {
    // Destructuring / standalone identifier bindings (e.g. `const { redisErrored } = rl`).
    for (const node of sf.getDescendantsOfKind(SyntaxKind.Identifier)) {
      if (node.getText() === "redisErrored") {
        redis = true;
        break;
      }
    }
  }
  if (!mock) {
    for (const node of sf.getDescendantsOfKind(SyntaxKind.Identifier)) {
      if (node.getText() === "mockCheckRateLimitOrFail") {
        mock = true;
        break;
      }
    }
  }

  sf.forget();
  return { exists: 1, import: hasImport ? 1 : 0, calls, mock: mock ? 1 : 0, redis: redis ? 1 : 0 };
}

try {
  for (const file of files) {
    const r = classify(file);
    process.stdout.write(
      `${file}\texists=${r.exists} import=${r.import} calls=${r.calls} mock=${r.mock} redis=${r.redis}\n`,
    );
  }
} catch (err) {
  console.error(`classify-fail-closed-test: internal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
