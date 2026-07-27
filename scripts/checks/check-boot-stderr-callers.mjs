#!/usr/bin/env node
/**
 * CI guard (AST, ts-morph): every `bootStderr(...)` call site must build its
 * message from provably non-secret parts.
 *
 * Why this exists as a SECOND gate: `check-console-sinks.mjs` proves the sink
 * file is shaped `console.error(message)` — it says nothing about how `message`
 * was built. That gap was verified, not assumed: a fixture containing
 *
 *     bootStderr(`auth token=${token}`)
 *
 * in a caller passes check-console-sinks with exit 0 AND passes `eslint`
 * (no-console is off in the sink, and the caller has no console call at all).
 * So the whole guarantee for the raw-stderr path rested on a prose caller
 * contract in boot-stderr.ts. Prose does not fail a build.
 *
 * The asymmetry that makes this worth guarding: the sink's own comment says the
 * override lands on "a file that cannot see a secret", but the message is
 * assembled in `src/lib/env.ts`, where every value in `process.env` is in scope.
 * The file cannot see a secret; the caller can.
 *
 * What is enforced, per call site:
 *   - a plain string literal                     → always OK (no interpolation)
 *   - a template literal / concatenation         → every interpolated expression
 *                                                  must resolve to a CLOSED TYPE
 *                                                  or an allowlisted safe form
 *   - anything else (bare identifier, call, …)   → must be listed in the manifest
 *                                                  with a reason
 *
 * "Closed type" is checked structurally without a Program (per
 * project_ast_guard_tsmorph_no_program): an interpolation is accepted when it is
 * a `this.<prop>` on a provider name, a numeric-looking local, or a parameter
 * the gate can tie back to a closed union declared in the same file. Anything it
 * cannot prove is a violation — the default is to FAIL, not to wave through.
 *
 * Completeness is enforced BOTH ways (mirrors check-bound-unknown-ip):
 *   - a call site not provably safe and not in the manifest → FAIL
 *   - a manifest entry whose file no longer calls bootStderr → FAIL (stale)
 *
 * BOOT_STDERR_CALLERS_ROOT overrides the scan root (self-test fixtures only).
 */
import { SyntaxKind } from "ts-morph";
import { readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createAstProject, sourceFiles } from "./lib/ast-project.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.BOOT_STDERR_CALLERS_ROOT
  ? process.env.BOOT_STDERR_CALLERS_ROOT
  : join(__dirname, "..", "..");
const SRC_DIR = join(REPO_ROOT, "src");
const MANIFEST_PATH = process.env.BOOT_STDERR_CALLERS_MANIFEST
  ? process.env.BOOT_STDERR_CALLERS_MANIFEST
  : join(__dirname, "boot-stderr-callers-manifest.json");

console.log(`check-boot-stderr-callers: SRC_DIR=${SRC_DIR} MANIFEST=${MANIFEST_PATH}`);

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
const exemptFiles = new Set(Object.keys(manifest.exempt_files ?? {}));

/** The sink module itself — it declares bootStderr, it does not call it. */
const SINK_FILE = "src/lib/boot-stderr.ts";

const project = createAstProject();

/**
 * Modules that re-export `bootStderr`, so an import of a barrel is recognized
 * as an import of the sink. Repo-relative POSIX paths WITHOUT extension, which
 * is the form a module specifier resolves to below.
 *
 * Seeded with the sink itself and grown by `indexReExports`. Without this a
 * `export { bootStderr } from "./boot-stderr"` barrel would make every caller
 * that imports through it invisible to the gate.
 */
const sinkModules = new Set(["src/lib/boot-stderr"]);

/** Resolve a relative/aliased specifier to a repo-relative path without extension. */
function resolveSpecifier(spec, fromRel) {
  if (spec.startsWith("@/")) return `src/${spec.slice(2)}`.replace(/\.tsx?$/, "");
  if (!spec.startsWith(".")) return null;
  const joined = join(dirname(fromRel), spec).split("\\").join("/");
  return joined.replace(/\.tsx?$/, "");
}

/**
 * Grow `sinkModules` transitively over re-export chains.
 *
 * Run to a fixed point before the main pass: a barrel that re-exports another
 * barrel must also count, and the file order of the walk is arbitrary.
 */
function indexReExports(files) {
  let grew = true;
  while (grew) {
    grew = false;
    for (const { rel, sf } of files) {
      const self = rel.replace(/\.tsx?$/, "");
      if (sinkModules.has(self)) continue;
      for (const decl of sf.getExportDeclarations()) {
        const spec = decl.getModuleSpecifierValue?.();
        if (!spec) continue;
        const target = resolveSpecifier(spec, rel);
        if (!target || !sinkModules.has(target)) continue;
        // `export * from` re-exports everything; a named clause must name it.
        const named = decl.getNamedExports?.() ?? [];
        const reexportsSink =
          named.length === 0 || named.some((n) => n.getName() === "bootStderr");
        if (!reexportsSink) continue;
        sinkModules.add(self);
        grew = true;
      }
    }
  }
}

/**
 * How `bootStderr` is reachable in this file: bare local names, plus namespace
 * objects it must be called as a property of.
 *
 * Every import FORM has to be covered, not just the aliased-named one. Verified
 * as a real bypass, not a hypothetical: with named-import matching only,
 *
 *     import * as stderr from "@/lib/boot-stderr";
 *     stderr.bootStderr(process.env.AUTH_SECRET!);
 *
 * did not merely pass — the file was never even counted as a caller, so no
 * manifest entry could have caught it either. A detection gap is strictly worse
 * than a classification gap, because the exemption list cannot see it.
 */
function bootStderrBindings(sf, rel) {
  const direct = new Set();
  const namespaces = new Set();

  for (const decl of sf.getImportDeclarations()) {
    const target = resolveSpecifier(decl.getModuleSpecifierValue(), rel);
    if (!target || !sinkModules.has(target)) continue;

    for (const named of decl.getNamedImports()) {
      if (named.getName() !== "bootStderr") continue;
      direct.add((named.getAliasNode() ?? named.getNameNode()).getText());
    }
    const ns = decl.getNamespaceImport?.();
    if (ns) namespaces.add(ns.getText());
    // A default import of a module that has no default export cannot call the
    // sink, but `import boot from "..."` on a barrel with `export default` can.
    const def = decl.getDefaultImport?.();
    if (def) namespaces.add(def.getText());
  }

  return { direct, namespaces };
}

/** True when this call expression targets bootStderr under any import form. */
function isBootStderrCall(call, { direct, namespaces }) {
  const callee = call.getExpression();
  if (callee.getKind() === SyntaxKind.Identifier) {
    return direct.has(callee.getText());
  }
  if (callee.getKind() === SyntaxKind.PropertyAccessExpression) {
    if (callee.getName() !== "bootStderr") return false;
    const obj = callee.getExpression();
    return obj.getKind() === SyntaxKind.Identifier && namespaces.has(obj.getText());
  }
  return false;
}

/**
 * Identifiers whose declaration in this file pins them to a closed set.
 *
 * Collected from: union type aliases of string literals (`type KeyName = "a" |
 * "b"`), `as const` object literals, and numeric-typed parameters/locals. The
 * gate only trusts what it can see declared here — an imported type is NOT
 * assumed closed, because without a Program it cannot be read.
 */
function closedTypeNames(sf, rel) {
  const closed = new Set();

  const collect = (source) => {
    for (const alias of source.getTypeAliases()) {
      const node = alias.getTypeNode();
      if (!node) continue;
      const isLiteralUnion =
        node.getKind() === SyntaxKind.UnionType &&
        node.getTypeNodes().every((n) => n.getKind() === SyntaxKind.LiteralType);
      if (isLiteralUnion) closed.add(alias.getName());
    }
  };

  collect(sf);

  // Resolve type-only imports one hop by READING the declaring file, rather
  // than assuming an imported name is closed. Without a Program there is no
  // type resolution (project_ast_guard_tsmorph_no_program), and assuming would
  // be fail-open: `import type { Whatever }` would silently satisfy the gate.
  // One hop is enough for the shapes that occur here and keeps the failure mode
  // "unresolvable → violation".
  for (const decl of sf.getImportDeclarations()) {
    const spec = decl.getModuleSpecifierValue();
    if (!spec.startsWith(".")) continue;

    const imported = decl
      .getNamedImports()
      .map((n) => (n.getAliasNode() ?? n.getNameNode()).getText());
    if (imported.length === 0) continue;

    const baseDir = dirname(join(REPO_ROOT, rel));
    for (const ext of [".ts", ".tsx", "/index.ts"]) {
      const candidate = join(baseDir, spec + ext);
      let text;
      try {
        text = readFileSync(candidate, "utf8");
      } catch {
        continue;
      }
      const depName = relative(REPO_ROOT, candidate).split("\\").join("/");
      const dep = project.createSourceFile(depName, text, { overwrite: true });
      const before = new Set(closed);
      collect(dep);
      // Only keep names this file actually imported.
      for (const name of closed) {
        if (!before.has(name) && !imported.includes(name)) closed.delete(name);
      }
      break;
    }
  }

  return closed;
}

/**
 * Expressions that read ambient process state — the origin of every secret this
 * gate cares about. `process.env.X`, `process.env["X"]`, and any member access
 * beneath them.
 */
function readsProcessState(node) {
  for (const access of node.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
    if (access.getExpression().getText().startsWith("process.env")) return true;
    if (access.getText().startsWith("process.env")) return true;
  }
  for (const el of node.getDescendantsOfKind(SyntaxKind.ElementAccessExpression)) {
    if (el.getExpression().getText().startsWith("process.env")) return true;
  }
  return false;
}

/**
 * Functions whose BODY is inspected and found free of ambient secret sources.
 *
 * A return-type annotation is not evidence of data origin: `function values():
 * string[] { return [process.env.AUTH_SECRET!] }` satisfies `string[]` while
 * returning a credential, and that exact shape was verified to pass an earlier
 * version of this gate. The annotation says what SHAPE comes out, never where
 * it came from — so the body is what gets checked, and the annotation is only
 * used to reject non-string-ish returns early.
 *
 * A function that touches `process.env`, or calls something this pass has not
 * cleared, is not safe. Unresolvable → unsafe, so the default stays fail-closed.
 */
function safeReturningFunctions(sf) {
  const candidates = new Map();
  for (const fn of sf.getFunctions()) {
    const rt = fn.getReturnTypeNode?.();
    if (!rt) continue;
    const text = rt.getText().replace(/\s+/g, "");
    if (text !== "string[]" && text !== "readonlystring[]" && text !== "number") continue;
    const name = fn.getName();
    if (name) candidates.set(name, fn);
  }

  const safe = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, fn] of candidates) {
      if (safe.has(name)) continue;
      const body = fn.getBody?.();
      if (!body) continue;
      if (readsProcessState(body)) continue;

      // Every call the body makes must itself be cleared, or be a bounded
      // string/array builder. An unknown callee could reach anywhere.
      const callsOk = body.getDescendantsOfKind(SyntaxKind.CallExpression).every((c) => {
        const callee = c.getExpression();
        if (callee.getKind() === SyntaxKind.Identifier) {
          return safe.has(callee.getText());
        }
        if (callee.getKind() === SyntaxKind.PropertyAccessExpression) {
          const m = callee.getName();
          return ["map", "join", "filter", "slice", "repeat", "toString", "flatMap"].includes(m);
        }
        return false;
      });
      if (!callsOk) continue;

      safe.add(name);
      grew = true;
    }
  }
  return safe;
}

/**
 * `<expr>.join(...)`, `<expr>.repeat(n)`, `<expr>.toString()` — string builders
 * whose output is bounded by their receiver. Accepted only when the receiver is
 * itself provably safe, so `secret.repeat(2)` is still a violation.
 */
function isSafeStringBuilder(sf, expr, closed, safeFns) {
  if (expr.getKind() !== SyntaxKind.CallExpression) return false;
  const callee = expr.getExpression();
  if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) return false;

  const method = callee.getName();
  if (method !== "join" && method !== "repeat" && method !== "toString") return false;

  const receiver = callee.getExpression();
  const rk = receiver.getKind();

  // `"=".repeat(60)` — a literal receiver.
  if (rk === SyntaxKind.StringLiteral || rk === SyntaxKind.NoSubstitutionTemplateLiteral) {
    return true;
  }
  // `failedVariableNames(...).join("\n")` — a safe-returning call.
  if (rk === SyntaxKind.CallExpression) {
    const inner = receiver.getExpression();
    return inner.getKind() === SyntaxKind.Identifier && safeFns.has(inner.getText());
  }
  // `names.join("\n")` where `names` is a proven binding.
  if (rk === SyntaxKind.Identifier) {
    return isProvablyClosedBinding(sf, receiver.getText(), closed, safeFns, receiver);
  }
  return false;
}

/**
 * Whether a class property `this.<prop>` is pinned to a closed set.
 *
 * Resolves the member declaration on the enclosing class: a closed-union
 * annotation, a numeric type, or a string-literal initializer all qualify. An
 * unannotated or `string`-typed member does NOT.
 */
function isProvablyClosedMember(sf, prop, closed, fromNode) {
  for (let scope = fromNode.getParent(); scope; scope = scope.getParent()) {
    const members = scope.getMembers?.();
    if (!members) continue;
    for (const m of members) {
      if (m.getName?.() !== prop) continue;
      const t = m.getTypeNode?.();
      if (t) {
        const text = t.getText();
        return closed.has(text) || text === "number";
      }
      const init = m.getInitializer?.();
      if (!init) return false;
      const ik = init.getKind();
      return (
        ik === SyntaxKind.StringLiteral ||
        ik === SyntaxKind.NoSubstitutionTemplateLiteral ||
        ik === SyntaxKind.NumericLiteral
      );
    }
  }
  return false;
}

/**
 * Whether the binding `name` VISIBLE FROM `fromNode` is provably bounded.
 *
 * Resolution walks outward from the use site instead of scanning the whole
 * file, because a file-wide "does any declaration of this name qualify?" scan
 * is fail-open in exactly the case that matters. Verified: with a file-wide
 * scan, widening `logStaleWarning(name: KeyName)` to `name: string` still
 * passed — the unrelated `getKey(name: KeyName, …)` parameter several methods
 * away satisfied the lookup and masked the widened one. The gate greened on the
 * precise regression it exists to catch (R46: scope-blind binding resolution).
 *
 * The nearest enclosing declaration wins, and only that one is judged.
 */
function isProvablyClosedBinding(sf, name, closed, safeFns, fromNode) {
  const judge = (decl) => {
    const t = decl.getTypeNode?.();
    if (t) {
      const text = t.getText();
      if (closed.has(text)) return true;
      if (text === "number") return true;
      // An annotation the gate could not resolve to a closed union is NOT
      // assumed safe — an unknown type name must fail, not pass.
      return false;
    }
    const init = decl.getInitializer?.();
    if (!init) return false;
    // `const elapsed = 5` — a numeric initializer cannot carry a string secret.
    if (init.getKind() === SyntaxKind.NumericLiteral) return true;
    // `const formatted = failedVariableNames(...).join("\n")`.
    return isSafeStringBuilder(sf, init, closed, safeFns);
  };

  const matches = (decl) => decl.getNameNode?.()?.getText() === name;

  // Walk ancestors outward; the first scope declaring `name` decides.
  for (let scope = fromNode.getParent(); scope; scope = scope.getParent()) {
    const params = scope.getParameters?.() ?? [];
    const hit = params.find(matches);
    if (hit) return judge(hit);

    for (const stmt of scope.getStatements?.() ?? []) {
      if (stmt.getKind() !== SyntaxKind.VariableStatement) continue;
      const decl = stmt.getDeclarations().find(matches);
      if (decl) return judge(decl);
    }
  }

  // Module scope.
  const moduleDecl = sf
    .getVariableStatements()
    .flatMap((s) => s.getDeclarations())
    .find(matches);
  return moduleDecl ? judge(moduleDecl) : false;
}

/**
 * Whether one interpolated expression is provably secret-free.
 *
 * Accepted forms are deliberately few. Everything else is a violation, so the
 * failure mode of an unrecognized shape is a red build, not a silent pass.
 */
function isSafeInterpolation(sf, expr, closed, safeFns) {
  const kind = expr.getKind();

  // A nested literal with no substitutions of its own.
  if (
    kind === SyntaxKind.StringLiteral ||
    kind === SyntaxKind.NoSubstitutionTemplateLiteral ||
    kind === SyntaxKind.NumericLiteral
  ) {
    return true;
  }

  // `this.<prop>` — accepted only when the property's DECLARED type is a closed
  // union or a literal initializer. Matching the text `this.name` alone was a
  // real hole: the declaration was `abstract readonly name: string`, so a future
  // provider deriving its name from config could put that value on stderr with
  // the gate none the wiser. The class member is what gets checked, not the
  // spelling of the access.
  if (kind === SyntaxKind.PropertyAccessExpression) {
    const obj = expr.getExpression();
    if (obj.getKind() !== SyntaxKind.ThisKeyword) return false;
    return isProvablyClosedMember(sf, expr.getName(), closed, expr);
  }

  // `"=".repeat(60)`, `names.join("\n")`.
  if (kind === SyntaxKind.CallExpression) {
    return isSafeStringBuilder(sf, expr, closed, safeFns);
  }

  // A binding this file declares with a closed or numeric type.
  if (kind === SyntaxKind.Identifier) {
    return isProvablyClosedBinding(sf, expr.getText(), closed, safeFns, expr);
  }

  // Arithmetic (`a - b`, `x / y`) over numbers is safe; `+` on strings is not,
  // so string concatenation deliberately does NOT land here.
  if (kind === SyntaxKind.BinaryExpression) {
    const op = expr.getOperatorToken().getText();
    if (op === "-" || op === "*" || op === "/" || op === "%") return true;
    return false;
  }

  return false;
}

/** Describe why an argument was rejected, for an actionable failure message. */
function classifyArgument(sf, arg, closed, safeFns) {
  const kind = arg.getKind();

  if (
    kind === SyntaxKind.StringLiteral ||
    kind === SyntaxKind.NoSubstitutionTemplateLiteral
  ) {
    return { safe: true };
  }

  if (kind === SyntaxKind.TemplateExpression) {
    const bad = [];
    for (const span of arg.getDescendantsOfKind(SyntaxKind.TemplateSpan)) {
      const expr = span.getExpression();
      if (!isSafeInterpolation(sf, expr, closed, safeFns)) bad.push(expr.getText());
    }
    return bad.length === 0
      ? { safe: true }
      : { safe: false, why: `interpolates unproven expression(s): ${bad.join(", ")}` };
  }

  if (kind === SyntaxKind.Identifier) {
    if (isProvablyClosedBinding(sf, arg.getText(), closed, safeFns, arg)) {
      return { safe: true };
    }
    return {
      safe: false,
      why: `passes the bare identifier \`${arg.getText()}\` — the gate cannot see how it was built`,
    };
  }

  return {
    safe: false,
    why: `argument is a ${arg.getKindName()} the gate cannot prove secret-free`,
  };
}

const violations = [];
const callingFiles = new Set();

// Materialize the walk once: the re-export index needs a full pass over the
// tree before any caller can be classified, since a barrel may be visited after
// the file importing through it.
const allFiles = [...sourceFiles(project, SRC_DIR, REPO_ROOT)];
indexReExports(allFiles);

for (const { rel, sf } of allFiles) {
  if (rel === SINK_FILE) continue;

  const bindings = bootStderrBindings(sf, rel);
  if (bindings.direct.size === 0 && bindings.namespaces.size === 0) continue;

  const closed = closedTypeNames(sf, rel);
  const safeFns = safeReturningFunctions(sf);

  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (!isBootStderrCall(call, bindings)) continue;

    callingFiles.add(rel);
    if (exemptFiles.has(rel)) continue;

    const args = call.getArguments();
    const line = call.getStartLineNumber();

    if (args.length !== 1) {
      violations.push({ rel, line, why: `expected exactly 1 argument, got ${args.length}` });
      continue;
    }

    const verdict = classifyArgument(sf, args[0], closed, safeFns);
    if (!verdict.safe) violations.push({ rel, line, why: verdict.why });
  }
}

let failed = false;

if (violations.length > 0) {
  failed = true;
  console.error("bootStderr call site(s) whose message is not provably secret-free:");
  for (const v of violations) {
    console.error(`  ${v.rel}:${v.line}  ${v.why}`);
  }
  console.error("");
  console.error("bootStderr writes to a raw console with NO redaction. Build the message");
  console.error("from string literals and closed-union/numeric values only, or add the file");
  console.error("to boot-stderr-callers-manifest.json with a reason.");
}

// Stale-manifest completeness: an exemption for a file that no longer calls
// bootStderr is dead weight that hides the next real one.
for (const rel of exemptFiles) {
  if (!callingFiles.has(rel)) {
    failed = true;
    console.error(`Stale manifest entry: "${rel}" no longer calls bootStderr — remove it.`);
  }
}

if (failed) {
  console.error("");
  console.error("FAIL: bootStderr caller contract violated.");
  process.exit(1);
}

console.log(
  `OK (${callingFiles.size} calling file(s) verified, ${exemptFiles.size} documented-exemption)`,
);
