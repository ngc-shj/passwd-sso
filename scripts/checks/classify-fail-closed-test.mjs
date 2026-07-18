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
 *   calls  — CallExpression count with callee Identifier assertRedisFailClosed
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

  const sf = project.createSourceFile(`/virtual/${path.replaceAll("/", "_")}.ts`, text, {
    overwrite: true,
  });

  let hasImport = false;
  for (const imp of sf.getImportDeclarations()) {
    if (imp.getModuleSpecifierValue() !== HELPER_MODULE) continue;
    if (imp.getNamedImports().some((n) => n.getName() === HELPER_NAME)) {
      hasImport = true;
      break;
    }
  }

  let calls = 0;
  let mock = false;
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (callee.getKind() === SyntaxKind.Identifier && callee.getText() === HELPER_NAME) {
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
