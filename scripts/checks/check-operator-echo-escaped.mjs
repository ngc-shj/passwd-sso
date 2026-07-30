#!/usr/bin/env node
/**
 * CI guard: operator input rendered into a message must be escaped — AST,
 * per-interpolation, with the member set DERIVED rather than enumerated.
 *
 * ## The class
 *
 * An operator CLI turns `process.argv` into text and prints it. A value carrying
 * a bidi control, a zero-width character or a C0 control renders as something
 * other than what it is, and the reader is at incident time, acting on what they
 * see. `escapeUnsafeDisplayChars` (`src/lib/security/unsafe-display-chars.ts`)
 * rewrites each such character as its visible `<U+XXXX>` form — escaping, not
 * stripping, because stripping `ac<U+00AD>me.example` prints `acme.example`,
 * which is a DIFFERENT and existing claim.
 *
 * ## Why a gate and not another review round
 *
 * This class was closed by hand three times and reopened twice:
 *
 *   - round-3 A3/D-32 — "every CLI print site goes through the escape"
 *   - round-4 F4      — one site 80 lines below a fixed one printed raw
 *   - round-5 M3      — "all five operator echoes escaped"
 *   - round-6 F4      — SIX more, four of them in a sibling module round 5
 *                       never opened, and one inside a message string round 5
 *                       had edited
 *
 * Every one of those fixes enumerated sites by reading a file. That is the R42
 * signature, and the repo's standing rule is that a class which escapes a
 * hand-enumeration twice gets a mechanism, not a third list of cases.
 *
 * ## The mechanism
 *
 * A small intraprocedural taint analysis, per source file, with a fixed source
 * set — so the member set is computed from the code rather than written down:
 *
 *   SOURCES      `process.argv`; a parameter named `argv`; every parameter of a
 *                function named `cmd*` (the exported CLI command surface, whose
 *                arguments are the parsed flags); a call to `getStringFlag`,
 *                `flags.get` or `flags.has`.
 *   PROPAGATION  assignment from a tainted expression; property or element
 *                access on one; a method call ON one (`tok.slice(2)`); a call to
 *                a declared string normaliser with a tainted argument; either
 *                side of a ternary or a `??`/`||`.
 *   SINK         any template-literal interpolation of a tainted expression.
 *   DISCHARGE    the interpolated expression is a call to
 *                `escapeUnsafeDisplayChars`.
 *
 * Propagation deliberately does NOT cross an arbitrary free-function call:
 * `resolveTenantRef(tx, args.tenant)` returns a database row, not operator text,
 * and treating its result as tainted would demand escaping of `${tenant.id}`.
 * A call whose callee is a MEMBER of a tainted expression does propagate, since
 * that is how a string is sliced and cased.
 *
 * ## Escape hatch
 *
 * A line carrying `operator-echo-exempt:` followed by a reason is skipped. It
 * exists for interpolations that are not display — a lock key, a SQL fragment —
 * and requires the reason to be written where the exemption is taken.
 *
 * ## Scope
 *
 * All of `scripts/**` (`.ts`, `.tsx`, `.mjs`), excluding `__tests__` and this
 * `checks/` directory. Scoping it to the tenant-domain files would repeat round
 * 5's mistake, which was scoping the enumeration to one file. Pre-existing
 * violations in scripts unrelated to the tenant-claim registry are carried in
 * `operator-echo-baseline.txt` with a count per file; a NEW violation in any
 * scanned file fails, and a fixed one fails too (the baseline must shrink
 * deliberately).
 *
 * Env: OPERATOR_ECHO_CHECK_ROOT overrides the repo root (used by the self-test).
 * Exit 0 = OK, 1 = divergence.
 */
import { Node, SyntaxKind } from "ts-morph";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { createAstProject } from "./lib/ast-project.mjs";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const ROOT = process.env.OPERATOR_ECHO_CHECK_ROOT ?? REPO_ROOT;
const SCAN_ROOT = "scripts";
const BASELINE_FILE = "scripts/checks/operator-echo-baseline.txt";

const ESCAPE_FN = "escapeUnsafeDisplayChars";
const EXEMPT_MARKER = "operator-echo-exempt:";
/** Comment lines above an interpolation that may carry the exemption marker. */
const EXEMPT_LOOKBACK = 3;

/** Calls whose RESULT is operator text (the parsed-flag accessors). */
const FLAG_READERS = new Set(["getStringFlag"]);
/** Member calls on the parsed-flag map whose result is operator text. */
const FLAG_MAP_METHODS = new Set(["get", "has"]);
/**
 * Free functions that transform operator text and return operator text. Kept
 * tiny and explicit: a wider set would taint database rows through helper calls.
 */
const NORMALISERS = new Set(["normalizeTenantClaim", "String"]);

function isScannable(name) {
  const ext = extname(name);
  if (ext !== ".ts" && ext !== ".tsx" && ext !== ".mjs") return false;
  return !/\.test\.(ts|tsx|mjs)$/.test(name);
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "__tests__" || e.name === "checks" || e.name === "node_modules") continue;
      walk(full, out);
      continue;
    }
    if (e.isFile() && isScannable(e.name)) out.push(full);
  }
  return out;
}

/** The identifier a declaration binds, or null for a destructuring pattern. */
function declaredName(node) {
  const name = node.getNameNode?.();
  return name && Node.isIdentifier(name) ? name.getText() : null;
}

function isFunctionLike(node) {
  return (
    Node.isFunctionDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isArrowFunction(node) ||
    Node.isFunctionExpression(node)
  );
}

function functionName(fn) {
  if (Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn)) return fn.getName() ?? "";
  const parent = fn.getParent();
  if (Node.isVariableDeclaration(parent)) return declaredName(parent) ?? "";
  return "";
}

/**
 * `process.argv[0]` and `[1]` are the node binary and the script path, which the
 * shell supplied rather than the operator. Every usage banner in `scripts/`
 * prints `process.argv[1]`, and requiring an escape there would be a rule about
 * argv's shape, not about operator text.
 */
function isArgvProgramSlot(expr) {
  if (!Node.isElementAccessExpression(expr)) return false;
  if (expr.getExpression().getText() !== "process.argv") return false;
  const index = expr.getArgumentExpression()?.getText();
  return index === "0" || index === "1";
}

/**
 * Taint analysis over ONE scope. Scopes are function-like nodes plus the module
 * top level, and a nested scope inherits its parent's set.
 *
 * Per-scope rather than per-file, because a per-file set keyed on identifier
 * NAMES conflates unrelated bindings: `parseFlags`'s `name` (a slice of
 * `process.argv`) and `valuelessError`'s `name` (a `ValueFlag` literal) are two
 * different values, and treating them as one produced a finding against a
 * parameter whose type admits five known spellings.
 */
function analyseScope(scope, inherited) {
  const tainted = new Set(inherited);

  if (isFunctionLike(scope)) {
    const isCommand = /^cmd[A-Z]/.test(functionName(scope));
    for (const p of scope.getParameters()) {
      const pName = declaredName(p);
      if (!pName) continue;
      // `argv` is operator input by name; a `cmd*` function's parameters are the
      // parsed flags, i.e. operator input by role.
      if (pName === "argv" || isCommand) tainted.add(pName);
    }
  }

  const isTainted = (expr) => {
    if (!expr) return false;
    if (Node.isIdentifier(expr)) return tainted.has(expr.getText());
    if (Node.isPropertyAccessExpression(expr) || Node.isElementAccessExpression(expr)) {
      if (isArgvProgramSlot(expr)) return false;
      const target = expr.getExpression();
      if (target.getText() === "process.argv") return true;
      return isTainted(target);
    }
    if (Node.isCallExpression(expr)) {
      const callee = expr.getExpression();
      if (Node.isIdentifier(callee)) {
        if (FLAG_READERS.has(callee.getText())) return true;
        if (NORMALISERS.has(callee.getText())) {
          return expr.getArguments().some((a) => isTainted(a));
        }
        // Any other free call: NOT propagated. `resolveTenantRef(tx, args.tenant)`
        // returns a database row, and treating it as operator text would demand
        // an escape on `${tenant.id}`.
        return false;
      }
      if (Node.isPropertyAccessExpression(callee)) {
        const method = callee.getName();
        const receiver = callee.getExpression();
        // `flags.get("days")` / `flags.has("yes")` read operator input.
        if (FLAG_MAP_METHODS.has(method) && receiver.getText().includes("flags")) return true;
        // A method call ON tainted text stays tainted (`tok.slice(2)`).
        return isTainted(receiver);
      }
      return false;
    }
    if (Node.isParenthesizedExpression(expr)) return isTainted(expr.getExpression());
    if (Node.isNonNullExpression(expr) || Node.isAsExpression(expr)) {
      return isTainted(expr.getExpression());
    }
    if (Node.isConditionalExpression(expr)) {
      return isTainted(expr.getWhenTrue()) || isTainted(expr.getWhenFalse());
    }
    if (Node.isBinaryExpression(expr)) {
      return isTainted(expr.getLeft()) || isTainted(expr.getRight());
    }
    // `await f(x)` follows the free-call rule above: not propagated.
    return false;
  };

  // Declarations and assignments in THIS scope only (a nested function's own
  // declarations belong to its own scope). Iterated to a fixed point so a
  // `tok -> body -> name` chain closes regardless of statement order.
  const ownNodes = (kind) =>
    scope
      .getDescendantsOfKind(kind)
      .filter((n) => nearestScope(n.getParent()) === scope);

  for (let pass = 0; pass < 8; pass++) {
    const before = tainted.size;
    for (const d of ownNodes(SyntaxKind.VariableDeclaration)) {
      const name = declaredName(d);
      if (!name || tainted.has(name)) continue;
      if (isTainted(d.getInitializer())) tainted.add(name);
    }
    for (const b of ownNodes(SyntaxKind.BinaryExpression)) {
      if (b.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) continue;
      const left = b.getLeft();
      if (!Node.isIdentifier(left) || tainted.has(left.getText())) continue;
      if (isTainted(b.getRight())) tainted.add(left.getText());
    }
    if (tainted.size === before) break;
  }

  return { tainted, isTainted };
}

/** The nearest enclosing function-like node, or the source file. */
function nearestScope(node) {
  let cur = node;
  while (cur) {
    if (isFunctionLike(cur) || Node.isSourceFile(cur)) return cur;
    cur = cur.getParent();
  }
  return null;
}

/** Every scope in a file, outermost first, each with its inherited taint set. */
function* scopesOf(sf) {
  const analysed = new Map();
  const root = analyseScope(sf, new Set());
  analysed.set(sf, root);
  yield { scope: sf, ...root };
  const fns = sf.getDescendants().filter(isFunctionLike);
  // Outermost first, so a parent's set is always available when a child is
  // analysed.
  fns.sort((a, b) => a.getStart() - b.getStart() || b.getEnd() - a.getEnd());
  for (const fn of fns) {
    const parent = nearestScope(fn.getParent()) ?? sf;
    const inherited = analysed.get(parent)?.tainted ?? new Set();
    const result = analyseScope(fn, inherited);
    analysed.set(fn, result);
    yield { scope: fn, ...result };
  }
}

function isEscaped(expr) {
  if (Node.isCallExpression(expr)) {
    const callee = expr.getExpression();
    if (Node.isIdentifier(callee) && callee.getText() === ESCAPE_FN) return true;
    if (Node.isPropertyAccessExpression(callee) && callee.getName() === ESCAPE_FN) return true;
  }
  // `cond ? escape(a) : escape(b)` — both arms must discharge.
  if (Node.isConditionalExpression(expr)) {
    return isEscaped(expr.getWhenTrue()) && isEscaped(expr.getWhenFalse());
  }
  if (Node.isParenthesizedExpression(expr)) return isEscaped(expr.getExpression());
  return false;
}

function loadBaseline() {
  const counts = new Map();
  let text;
  try {
    text = readFileSync(join(ROOT, BASELINE_FILE), "utf8");
  } catch {
    return counts;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [count, file] = trimmed.split(/\s+/, 2);
    if (!file) continue;
    counts.set(file, Number(count));
  }
  return counts;
}

function main() {
  const project = createAstProject();
  const scanDir = join(ROOT, SCAN_ROOT);
  let files;
  try {
    statSync(scanDir);
    files = walk(scanDir);
  } catch {
    console.error(`operator-echo: scan root not found: ${SCAN_ROOT}`);
    process.exit(1);
  }

  const findings = [];
  for (const file of files) {
    const rel = relative(ROOT, file).split("\\").join("/");
    const sf = project.createSourceFile(rel, readFileSync(file, "utf8"), { overwrite: true });
    const lines = sf.getFullText().split("\n");
    const seen = new Set();
    for (const { scope, isTainted } of scopesOf(sf)) {
      for (const span of scope.getDescendantsOfKind(SyntaxKind.TemplateSpan)) {
        // Each span is checked in ITS OWN scope, so a nested function's
        // bindings are not adjudicated by its parent's taint set.
        if (nearestScope(span.getParent()) !== scope) continue;
        const expr = span.getExpression();
        if (!isTainted(expr)) continue;
        if (isEscaped(expr)) continue;
        const line = expr.getStartLineNumber();
        // The marker may sit on the interpolation's own line or in a comment
        // immediately above it — the reason usually needs more room than a
        // trailing comment leaves.
        const nearby = lines.slice(Math.max(0, line - 1 - EXEMPT_LOOKBACK), line);
        if (nearby.some((l) => l.includes(EXEMPT_MARKER))) continue;
        const key = `${line}:${expr.getText()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({ rel, line, text: expr.getText() });
      }
    }
  }

  const perFile = new Map();
  for (const f of findings) perFile.set(f.rel, (perFile.get(f.rel) ?? 0) + 1);
  const baseline = loadBaseline();

  const problems = [];
  for (const [rel, count] of perFile) {
    const allowed = baseline.get(rel) ?? 0;
    if (count > allowed) {
      problems.push(
        `${rel}: ${count} unescaped operator-input interpolation(s), baseline allows ${allowed}`,
      );
      for (const f of findings.filter((x) => x.rel === rel)) {
        problems.push(`    ${rel}:${f.line}  \${${f.text}}`);
      }
    }
  }
  for (const [rel, allowed] of baseline) {
    const count = perFile.get(rel) ?? 0;
    if (count < allowed) {
      problems.push(
        `${rel}: baseline allows ${allowed} unescaped interpolation(s) but ${count} remain — ` +
          `lower the count in ${BASELINE_FILE}`,
      );
    }
  }

  if (problems.length > 0) {
    console.error("Operator input rendered without escapeUnsafeDisplayChars:\n");
    for (const p of problems) console.error(`  ${p}`);
    console.error(
      `\nWrap the interpolation in ${ESCAPE_FN}() (import it from ` +
        "@/lib/security/unsafe-display-chars), or annotate the line with " +
        `"${EXEMPT_MARKER} <reason>" if it is not display output.`,
    );
    process.exit(1);
  }

  console.log(
    `operator-echo: OK (${files.length} file(s) scanned, ${findings.length} baselined interpolation(s))`,
  );
}

main();
