#!/usr/bin/env node
/**
 * Quality-bar scan of test files: does every test assert something?
 *
 * Usage:
 *   node scripts/checks/scan-test-assertions.mjs [--base <ref>] <test-file>...
 *   git diff --name-only main -- '*.test.*' | node scripts/checks/scan-test-assertions.mjs
 *
 * A one-off measurement tool for the C3 quality bar, kept in the repo with its
 * self-test so the measurement can be re-run. Not a pre-pr gate: the suite has
 * pre-existing tests it would flag, and the bar applies to new and changed files.
 *
 * Every `it`/`test` callback must contain at least one of:
 *   - an `expect(...)` call (any matcher, `expect.soft`, an awaited
 *     `.rejects`/`.resolves` chain);
 *   - a call to a helper named `expect*`/`assert*` that is imported, or that is
 *     declared in the same file and itself asserts (an expect, or a throw);
 *   - a Testing Library `getBy*`/`getAllBy*`/`findBy*`/`findAllBy*` call, which
 *     throws when the element is absent.
 *
 * Refused anywhere in the file:
 *   - snapshot matchers;
 *   - `it.skip`/`it.todo`/`test.skip`/`test.todo` (with --base <ref>, only when
 *     the file has more of them than at <ref>);
 *   - a test whose only assertions are `toBeDefined()`/`toBeTruthy()`/
 *     `not.toThrow()`;
 *   - `vi.mock`/`vi.doMock` of the test's own subject (the co-located file the
 *     test is named after).
 *
 * Exit 0 = no violations; 1 = violations, an unreadable file, or no input files.
 *
 * Background: docs/archive/review/close-coverage-and-clipboard-gaps-plan.md, C3.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const TEST_FNS = new Set(["it", "test"]);
const SKIP_MODIFIERS = new Set(["skip", "todo"]);
const SNAPSHOT_MATCHERS = new Set([
  "toMatchSnapshot",
  "toMatchInlineSnapshot",
  "toMatchFileSnapshot",
  "toThrowErrorMatchingSnapshot",
  "toThrowErrorMatchingInlineSnapshot",
]);
const QUERY_THROWS = /^(getBy|getAllBy|findBy|findAllBy)/;
const HELPER_NAME = /^(expect|assert)/;

/** `it.only.each` → ["it", "only", "each"]; null when the callee is not a property chain on an identifier. */
function calleePath(expr) {
  const parts = [];
  let cur = expr;
  for (;;) {
    if (ts.isIdentifier(cur)) {
      parts.unshift(cur.text);
      return parts;
    }
    if (ts.isPropertyAccessExpression(cur)) {
      parts.unshift(cur.name.text);
      cur = cur.expression;
      continue;
    }
    if (ts.isCallExpression(cur)) {
      // it.each(table)(name, fn)
      cur = cur.expression;
      continue;
    }
    return null;
  }
}

/** The root call of a matcher chain: `expect(x).not.toBe(y)` → the `expect(x)` call. */
function expectRoot(expr) {
  let cur = expr;
  while (ts.isPropertyAccessExpression(cur) || ts.isCallExpression(cur)) {
    if (ts.isCallExpression(cur)) {
      const callee = cur.expression;
      if (ts.isIdentifier(callee) && callee.text === "expect") return cur;
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "expect") {
        return cur; // expect.soft(x) / expect.poll(fn)
      }
      cur = callee;
    } else {
      cur = cur.expression;
    }
  }
  return null;
}

function collectImports(sf) {
  const names = new Set();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue;
    const clause = stmt.importClause;
    if (clause.name) names.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) names.add(el.name.text);
    }
  }
  return names;
}

function collectLocalFunctions(sf) {
  const fns = new Map();
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) fns.set(node.name.text, node.body);
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      fns.set(node.name.text, node.initializer.body);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return fns;
}

function containsThrow(node) {
  if (ts.isThrowStatement(node)) return true;
  return ts.forEachChild(node, containsThrow) ?? false;
}

/**
 * Classify the assertions inside `body`: strong (a real matcher, a throwing
 * query, an asserting helper) and weak (toBeDefined / toBeTruthy / not.toThrow).
 */
function classify(body, ctx, visiting = new Set()) {
  let strong = 0;
  let weak = 0;
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && expectRoot(callee.expression)) {
        const matcher = callee.name.text;
        const negated =
          ts.isPropertyAccessExpression(callee.expression) && callee.expression.name.text === "not";
        if ((!negated && (matcher === "toBeDefined" || matcher === "toBeTruthy")) || (negated && matcher === "toThrow")) {
          weak++;
        } else {
          strong++;
        }
      } else if (ts.isPropertyAccessExpression(callee) && QUERY_THROWS.test(callee.name.text)) {
        strong++;
      } else if (ts.isIdentifier(callee)) {
        const name = callee.text;
        if (QUERY_THROWS.test(name)) {
          strong++;
        } else if (HELPER_NAME.test(name) && name !== "expect") {
          if (ctx.imports.has(name)) {
            strong++;
          } else if (ctx.locals.has(name) && !visiting.has(name)) {
            const helperBody = ctx.locals.get(name);
            const inner = classify(helperBody, ctx, new Set([...visiting, name]));
            // A local helper asserts by calling expect or by throwing on failure.
            if (inner.strong > 0 || containsThrow(helperBody)) strong++;
            else if (inner.weak > 0) weak++;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return { strong, weak };
}

function lineOf(sf, node) {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function stripExt(p) {
  return p.slice(0, p.length - extname(p).length);
}

/** Paths (without extension) the test is named after: co-located, or one level up from __tests__/. */
function subjectCandidates(absPath) {
  const base = basename(absPath).replace(/\.(test|spec)\.[cm]?[jt]sx?$/, "");
  const dir = dirname(absPath);
  const candidates = [join(dir, base)];
  if (basename(dir) === "__tests__") candidates.push(join(dirname(dir), base));
  return candidates;
}

function resolveSpecifier(spec, absPath, root) {
  if (spec.startsWith("./") || spec.startsWith("../")) return stripExt(resolve(dirname(absPath), spec));
  if (spec.startsWith("@/")) return stripExt(resolve(root, "src", spec.slice(2)));
  return null;
}

function countSkips(source, path) {
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind(path));
  let n = 0;
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const p = calleePath(node.expression);
      if (p && TEST_FNS.has(p[0]) && p.slice(1).some((m) => SKIP_MODIFIERS.has(m))) n++;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return n;
}

function scriptKind(path) {
  return /\.[cm]?[jt]sx$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

/**
 * Violations in one test file's source. `path` is used for line reports and to
 * find the subject; `baseSource`, when given, is the file at the base ref and
 * makes skip/todo a violation only when their count grew.
 */
export function scanTestSource(path, source, { root = REPO_ROOT, baseSource } = {}) {
  const absPath = resolve(root, path);
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind(path));
  const ctx = { imports: collectImports(sf), locals: collectLocalFunctions(sf) };
  const subjects = new Set(subjectCandidates(absPath));
  const violations = [];
  const skipNodes = [];

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const path_ = calleePath(callee);

      if (ts.isPropertyAccessExpression(callee) && SNAPSHOT_MATCHERS.has(callee.name.text)) {
        violations.push(`${path}:${lineOf(sf, node)}: SNAPSHOT: ${callee.name.text}`);
      }

      if (
        path_ &&
        path_.length === 2 &&
        path_[0] === "vi" &&
        (path_[1] === "mock" || path_[1] === "doMock") &&
        node.arguments.length > 0 &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        const target = resolveSpecifier(node.arguments[0].text, absPath, root);
        if (target && subjects.has(target)) {
          violations.push(`${path}:${lineOf(sf, node)}: SELF_MOCK: vi.${path_[1]}("${node.arguments[0].text}") mocks the subject under test`);
        }
      }

      // `it.each(table)` is the callee of the real test call; count only the outer one.
      const isCalleeOfCall = ts.isCallExpression(node.parent) && node.parent.expression === node;
      if (path_ && TEST_FNS.has(path_[0]) && !isCalleeOfCall) {
        const modifiers = path_.slice(1);
        if (modifiers.some((m) => SKIP_MODIFIERS.has(m))) {
          skipNodes.push(node);
        } else {
          const fn = [...node.arguments].reverse().find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
          if (fn) {
            const title = node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) ? node.arguments[0].text : "<dynamic title>";
            const { strong, weak } = classify(fn.body, ctx);
            if (strong === 0 && weak === 0) {
              violations.push(`${path}:${lineOf(sf, node)}: NO_ASSERTION: "${title}"`);
            } else if (strong === 0) {
              violations.push(`${path}:${lineOf(sf, node)}: WEAK_ASSERTIONS_ONLY: "${title}" asserts only toBeDefined/toBeTruthy/not.toThrow`);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  const baseSkips = baseSource === undefined ? 0 : countSkips(baseSource, path);
  if (skipNodes.length > baseSkips) {
    for (const node of skipNodes) {
      violations.push(`${path}:${lineOf(sf, node)}: SKIP_OR_TODO: ${node.expression.getText(sf)}`);
    }
  }
  return violations;
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function main() {
  const args = process.argv.slice(2);
  let base;
  const files = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--base") {
      base = args[++i];
      if (!base) {
        console.error("scan-test-assertions: --base needs a ref");
        process.exit(1);
      }
    } else {
      files.push(args[i]);
    }
  }
  if (files.length === 0 && !process.stdin.isTTY) {
    files.push(...readStdin().split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  }
  if (files.length === 0) {
    console.error("scan-test-assertions: FAIL — SCAN_EMPTY_INPUT: no test files given (args or stdin); scanning nothing proves nothing");
    process.exit(1);
  }

  const failures = [];
  for (const file of files) {
    let source;
    try {
      source = readFileSync(resolve(file), "utf8");
    } catch (err) {
      failures.push(`${file}: UNREADABLE: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    let baseSource;
    if (base) {
      try {
        baseSource = execFileSync("git", ["show", `${base}:${file}`], {
          cwd: REPO_ROOT,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
      } catch {
        baseSource = ""; // new file: every skip/todo is new
      }
    }
    failures.push(...scanTestSource(file, source, { baseSource }));
  }

  if (failures.length > 0) {
    console.error(`scan-test-assertions: FAIL (${files.length} files scanned)`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`scan-test-assertions: OK (${files.length} files scanned)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main();
}
