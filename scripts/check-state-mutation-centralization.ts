/**
 * CI guard (C8): AST-based check that no file outside the allowlist writes
 * `data: { status: <value> }` against emergencyAccessGrant or accessRequest
 * tables via Prisma's update / updateMany calls.
 *
 * Uses ts-morph to walk the AST so it catches:
 *   - data: { status: "REVOKED" }
 *   - data: { status: someConst }
 *   - data: { ...rest, status: x }
 *   - multi-line / reformatted variants
 *
 * Exit 0 → no violations. Exit 1 → violations found (printed to stdout).
 *
 * Usage: npx tsx scripts/check-state-mutation-centralization.ts [--fixture <path>]
 *   --fixture <path>  Scan a single file instead of the full src tree (for self-tests).
 */
import { Project, Node } from "ts-morph";
import { resolve, relative } from "node:path";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";

// ─── Resolve repo root ────────────────────────────────────────────────────────
// The bash wrapper does `cd "$(git rev-parse --show-toplevel)"` before invoking
// this script, so process.cwd() is the repo root when called via the wrapper.
// As a fallback, resolve via git command.
function findRepoRoot(): string {
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  } catch {
    // If git is unavailable (unlikely in CI), fall back to process.cwd()
    return process.cwd();
  }
}

// ─── Allowlist ──────────────────────────────────────────────────────────────
const ROOT = findRepoRoot();
const ALLOWED = new Set([
  "src/lib/emergency-access/emergency-access-state.ts",
  "src/lib/access-request/access-request-state.ts",
]);

// ─── Targets: Prisma model names that own the status column ────────────────
const TARGET_MODELS = new Set([
  "emergencyAccessGrant",
  "accessRequest",
]);

// ─── Prisma mutating methods ─────────────────────────────────────────────────
const MUTATING_METHODS = new Set(["update", "updateMany"]);

// ─── Argument parsing ────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let fixturePath: string | undefined;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--fixture" && args[i + 1]) {
    fixturePath = resolve(args[i + 1]);
    i++;
  }
}

// ─── Build ts-morph project ──────────────────────────────────────────────────
const project = new Project({
  tsConfigFilePath: resolve(ROOT, "tsconfig.json"),
  skipAddingFilesFromTsConfig: true,
  skipFileDependencyResolution: true,
});

if (fixturePath) {
  // Self-test mode: scan a single file
  if (!existsSync(fixturePath)) {
    console.error(`check-state-mutation-centralization: fixture not found: ${fixturePath}`);
    process.exit(2);
  }
  project.addSourceFileAtPath(fixturePath);
} else {
  // Full scan: glob src/**/*.ts excluding test dirs and .next
  project.addSourceFilesFromTsConfig(resolve(ROOT, "tsconfig.json"));
  // Also add any files that might not be in tsconfig include (shouldn't be needed but defensive)
  project.addSourceFilesAtPaths([
    resolve(ROOT, "src/**/*.ts"),
    `!${resolve(ROOT, "src/**/__tests__/**")}`,
    `!${resolve(ROOT, "src/**/*.test.ts")}`,
    `!${resolve(ROOT, "src/**/*.integration.test.ts")}`,
    `!${resolve(ROOT, ".next/**")}`,
  ]);
}

// ─── Violation collector ─────────────────────────────────────────────────────
const violations: string[] = [];

/**
 * Recursively walk an ObjectLiteralExpression looking for a `status` property
 * whose initializer is not `null` and not a function/arrow-function.
 * Returns true if such a property is found.
 */
function hasStatusAssignment(objLiteral: Node): boolean {
  if (!Node.isObjectLiteralExpression(objLiteral)) return false;
  for (const prop of objLiteral.getProperties()) {
    if (Node.isPropertyAssignment(prop)) {
      const name = prop.getName();
      if (name === "status") {
        const init = prop.getInitializer();
        if (!init) continue;
        // Allow `status: null` (null-clear, not a status assignment)
        if (Node.isNullLiteral(init)) continue;
        // Allow function / arrow-function expressions (e.g., factory callbacks)
        if (
          Node.isFunctionExpression(init) ||
          Node.isArrowFunction(init)
        ) continue;
        return true;
      }
    } else if (Node.isShorthandPropertyAssignment(prop)) {
      // { status } shorthand — the variable name is "status"
      if (prop.getName() === "status") return true;
    } else if (Node.isSpreadAssignment(prop)) {
      // { ...extraData, status: ... } — recursively check the spread source?
      // We cannot statically resolve the spread variable, so ignore it.
      // The plain property following a spread will still be caught.
      continue;
    }
  }
  return false;
}

/**
 * Given a call expression, check whether it is a Prisma update/updateMany
 * call on a target model and has a data:{status:...} argument.
 *
 * Matches: <x>.emergencyAccessGrant.update({ data: { status: ... } })
 * where <x> is any identifier (prisma, tx, db, etc.).
 */
function checkCallExpression(call: Node, filePath: string): void {
  if (!Node.isCallExpression(call)) return;
  const expr = call.getExpression();
  if (!Node.isPropertyAccessExpression(expr)) return;

  const methodName = expr.getName();
  if (!MUTATING_METHODS.has(methodName)) return;

  // expr.getExpression() → <x>.emergencyAccessGrant or similar
  const modelExpr = expr.getExpression();
  if (!Node.isPropertyAccessExpression(modelExpr)) return;
  const modelName = modelExpr.getName();
  if (!TARGET_MODELS.has(modelName)) return;

  // Found a relevant call — now inspect the `data` property
  const callArgs = call.getArguments();
  if (callArgs.length === 0) return;
  const firstArg = callArgs[0];
  if (!Node.isObjectLiteralExpression(firstArg)) return;

  for (const prop of firstArg.getProperties()) {
    if (
      Node.isPropertyAssignment(prop) &&
      prop.getName() === "data"
    ) {
      const dataValue = prop.getInitializer();
      if (dataValue && hasStatusAssignment(dataValue)) {
        const pos = call.getStartLineNumber();
        const col = call.getStart() - call.getSourceFile().getFullText().lastIndexOf("\n", call.getStart());
        const rel = filePath.startsWith(ROOT)
          ? relative(ROOT, filePath)
          : filePath;
        violations.push(`${rel}:${pos}:${col} data:{status:...} mutation outside allowlist`);
      }
    }
  }
}

// ─── Walk all source files ────────────────────────────────────────────────────
for (const sf of project.getSourceFiles()) {
  const filePath = sf.getFilePath();
  const rel = filePath.startsWith(ROOT) ? relative(ROOT, filePath) : filePath;

  // Skip allowlisted files (they ARE the SSoT)
  if (ALLOWED.has(rel)) continue;
  // Skip node_modules, .next, and scripts fixtures (CI self-test files)
  if (rel.includes("node_modules") || rel.includes(".next")) continue;
  // Skip CI self-test fixtures only during full scan (not --fixture mode)
  if (!fixturePath && rel.includes("__fixtures__")) continue;
  // Skip test files (unit tests may assert shapes)
  if (
    rel.includes("__tests__") ||
    rel.endsWith(".test.ts") ||
    rel.endsWith(".test.tsx")
  ) continue;

  sf.forEachDescendant((node) => {
    if (Node.isCallExpression(node)) {
      checkCallExpression(node, filePath);
    }
  });
}

// ─── Report ───────────────────────────────────────────────────────────────────
if (violations.length > 0) {
  console.error(
    "check-state-mutation-centralization: found inline status mutations outside allowlist:\n",
  );
  for (const v of violations) {
    console.error(`  ${v}`);
  }
  console.error(
    "\nRoute all status mutations through transition() / bulkTransition() in " +
      "src/lib/emergency-access/emergency-access-state.ts or " +
      "src/lib/access-request/access-request-state.ts.",
  );
  process.exit(1);
} else {
  console.log("check-state-mutation-centralization: OK — no inline status mutations found.");
  process.exit(0);
}
