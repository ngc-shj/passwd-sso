/**
 * CI guard (C8): AST-based check that no file outside the allowlist writes
 * `status: <value>` against emergencyAccessGrant or accessRequest tables via
 * Prisma's update / updateMany / upsert calls.
 *
 * Uses ts-morph to walk the AST so it catches:
 *   - data: { status: "REVOKED" }
 *   - data: { status: someConst }
 *   - data: { ...rest, status: x }
 *   - update: { status: ... } / create: { status: ... } in upsert
 *   - { [computedKey]: ... } escape hatch (flagged unconditionally — opaque)
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
// `upsert` carries status writes on `create` and/or `update` keys (not `data`),
// so it MUST be checked alongside update / updateMany.
const MUTATING_METHODS = new Set(["update", "updateMany", "upsert"]);

// Top-level keys that hold the status-bearing payload, indexed by mutating method.
const PAYLOAD_KEYS_BY_METHOD: Record<string, ReadonlyArray<string>> = {
  update: ["data"],
  updateMany: ["data"],
  upsert: ["update", "create"],
};

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
 * Walk an ObjectLiteralExpression looking for a status assignment.
 * Returns a finding kind:
 *   - "status" — explicit `status: <value>` or `{ status }` shorthand
 *   - "computed" — `{ [key]: ... }` whose key cannot be statically resolved;
 *     flagged as a violation regardless because it is an escape hatch that
 *     can hide a status write
 *   - null — no violation
 *
 * Computed property names are intentionally flagged unconditionally (no
 * partial-resolution attempts) — partial resolution invites bypass via
 * indirection (`const k = "stat" + "us"`). If a legitimate use case appears,
 * add the file to ALLOWED.
 */
type StatusFinding = "status" | "computed" | null;

/** Unwrap `(expr)`, `expr as T`, `<T>expr`, `expr satisfies T` chains. */
function unwrap(node: Node): Node {
  let n = node;
  while (
    Node.isParenthesizedExpression(n) ||
    Node.isAsExpression(n) ||
    Node.isTypeAssertion(n) ||
    Node.isSatisfiesExpression(n)
  ) {
    n = n.getExpression();
  }
  return n;
}

function findStatusAssignment(objLiteral: Node): StatusFinding {
  const target = unwrap(objLiteral);
  if (!Node.isObjectLiteralExpression(target)) return null;
  for (const prop of target.getProperties()) {
    if (Node.isPropertyAssignment(prop)) {
      const nameNode = prop.getNameNode();
      // Computed property name: `{ [key]: value }` — cannot statically resolve.
      if (Node.isComputedPropertyName(nameNode)) {
        return "computed";
      }
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
        return "status";
      }
    } else if (Node.isShorthandPropertyAssignment(prop)) {
      // { status } shorthand — the variable name is "status"
      if (prop.getName() === "status") return "status";
    } else if (Node.isSpreadAssignment(prop)) {
      // { ...extraData, status: ... } — cannot statically resolve the spread.
      // The plain property following a spread will still be caught on its own.
      continue;
    }
  }
  return null;
}

/**
 * Given a call expression, check whether it is a Prisma mutating call on a
 * target model with a status-bearing payload.
 *
 * Matches: <x>.emergencyAccessGrant.update({ data: { status: ... } })
 *          <x>.accessRequest.upsert({ update: { status: ... }, create: {...} })
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

  // Found a relevant call — inspect the method-specific payload key(s)
  const callArgs = call.getArguments();
  if (callArgs.length === 0) return;
  const firstArg = callArgs[0];
  if (!Node.isObjectLiteralExpression(firstArg)) return;

  const payloadKeys = PAYLOAD_KEYS_BY_METHOD[methodName] ?? [];
  for (const prop of firstArg.getProperties()) {
    if (!Node.isPropertyAssignment(prop)) continue;
    if (!payloadKeys.includes(prop.getName())) continue;
    const payloadValue = prop.getInitializer();
    if (!payloadValue) continue;
    const finding = findStatusAssignment(payloadValue);
    if (!finding) continue;
    const line = call.getStartLineNumber();
    const col = call.getStart() - call.getSourceFile().getFullText().lastIndexOf("\n", call.getStart());
    const rel = filePath.startsWith(ROOT)
      ? relative(ROOT, filePath)
      : filePath;
    const detail =
      finding === "computed"
        ? `${methodName}({${prop.getName()}:{[<computed>]:...}}) — computed property name is opaque, refactor to a plain key`
        : `${methodName}({${prop.getName()}:{status:...}}) mutation outside allowlist`;
    violations.push(`${rel}:${line}:${col} ${detail}`);
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
