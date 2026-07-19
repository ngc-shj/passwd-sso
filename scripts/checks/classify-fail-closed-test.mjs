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
 *   <path>\texists=0|1 import=0|1 calls=<n> mock=0|1 redis=0|1 dynspec=0|1 distinct=<n> resultfake=0|1 resultmodulemock=0|1
 * Field semantics:
 *   import — ImportDeclaration from "@/__tests__/helpers/fail-closed"
 *            whose named imports include assertRedisFailClosed
 *   calls  — count of CallExpressions whose callee SYMBOL is the helper's
 *            local import binding (alias-aware; shadowing local functions
 *            never count) AND which execute from a real test: nearest
 *            enclosing function is the callback of a non-skipped it/test
 *            registration with no skipped suite ancestor. Calls in unused
 *            functions, at top level, or under it.skip/describe.skip do not
 *            count. This criterion stays PRECISION-first (symbol binding) —
 *            a miss is fail-loud by design (D11).
 *   mock   — production-mapping stub present as CODE (RT5 anti-pattern):
 *            vi.mock/vi.doMock of "@/lib/security/rate-limit-audit" (or a
 *            relative/normalized specifier resolving to the same module,
 *            incl. the `import("<spec>")` typed form), a property
 *            assignment `checkRateLimitOrFail: <vi.fn…>`, or any use of an
 *            identifier named mockCheckRateLimitOrFail. The `vi` callee
 *            resolution is RECALL-first (see resolveMockCallee below) — this
 *            criterion must never silently miss a stub because a file has
 *            no explicit `vitest` import (globals: true in both configs).
 *   redis  — `redisErrored` appears as a CODE property/identifier
 *            (object-literal key, property access, or binding) — string
 *            literals and comments do NOT count (legacy-direct criterion)
 *   dynspec — 1 when a vi.mock/vi.doMock callee (per the same RECALL-first
 *            resolution as `mock`) has a first argument that is NOT a
 *            recognized literal specifier form (StringLiteral,
 *            NoSubstitutionTemplateLiteral, or `import("<spec>")`) — e.g. a
 *            variable or a concatenated expression. Fail-loud signal for
 *            the gate (STUB_DYNAMIC_SPECIFIER); legitimate tests never need
 *            a dynamic mock specifier.
 *
 * Exit: 0 on success (missing files are reported as exists=0, not errors);
 * 1 on any internal failure — the caller MUST treat that as a gate failure
 * (fail closed), never fall back to a text match.
 */

import { readFileSync } from "node:fs";
import { dirname, posix as posixPath } from "node:path";
import { Project, SyntaxKind, ts } from "ts-morph";

const HELPER_MODULE = "@/__tests__/helpers/fail-closed";
// All shared fail-closed contract helpers count as a real helper-mode call.
// Three tiers, one per fail-closed call-site shape: the Response 503 helper
// (route handlers), the silent-drop helper (non-Response producers like
// auth.config's magic-link send), and the direct-result helper (limiter
// modules that return RateLimitResult rather than a Response, e.g.
// v1ApiKeyLimiter). A test using ANY of them is a genuine contract test —
// the gate must not misclassify the silent-drop / result tiers as the
// weaker "legacy redisErrored-reference" mode (external review 2026-07-19).
const HELPER_NAMES = new Set([
  "assertRedisFailClosed",
  "assertRedisFailClosedSilentDrop",
  "assertRedisFailClosedResult",
]);
// WHITELIST of production limiter bindings accepted by the direct-result tier
// (assertRedisFailClosedResult). The limiter argument MUST resolve — following
// alias chains to its root binding — to a named import of one of these exports
// from the rate-limiters module. Anything else (inline/const fake, factory
// result, import from a test module) is rejected as resultfake=1. A whitelist,
// not a fake-shape blacklist, so novel fake constructions cannot slip through
// (external review 2026-07-19, round 4).
const RESULT_LIMITER_MODULE_SUFFIX = "lib/security/rate-limiters";
const RESULT_LIMITER_EXPORTS = new Set(["v1ApiKeyLimiter"]);
// Suffix match target after normalization (extension stripped, relative
// specifiers resolved against the test file's directory) — catches alias
// forms (`@/lib/...`) and relative forms (`../../../lib/security/...`) alike.
const MAPPING_SUFFIX = "lib/security/rate-limit-audit";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: classify-fail-closed-test.mjs <file...>");
  process.exit(1);
}

// SYNTACTIC project — used for the whole-file scans (mock / dynspec / redis /
// vitest-`vi` resolution) on every one of the ~1000 scanned files. These never
// call getSymbol, so this project's language service never initializes and each
// file is cheap.
const project = new Project({
  useInMemoryFileSystem: true,
  skipFileDependencyResolution: true,
  compilerOptions: { allowJs: true, jsx: ts.JsxEmit.ReactJSX },
});

// SEMANTIC project — a SEPARATE project used ONLY for the limiter binding
// resolution (alias chains, shorthand `{ limiter }`, production-import
// whitelist) that genuinely needs TypeScript's scope-aware symbol resolution
// rather than a name scan (which ignores lexical scope — external review round 8
// Major). Only the ~54 files that import the fail-closed helper ever get a
// source file here, so the language service's whole-project cost is bounded to
// that set; a single shared semantic project (created once) is far cheaper than
// one project per file (measured 0.7s vs 5.4s over the 54 files). Isolating it
// from the syntactic project keeps the 950+ non-helper files off the language
// service entirely.
const semanticProject = new Project({
  useInMemoryFileSystem: true,
  skipFileDependencyResolution: true,
  compilerOptions: { allowJs: true, jsx: ts.JsxEmit.ReactJSX },
});

function classify(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { exists: 0, import: 0, calls: 0, mock: 0, redis: 0, dynspec: 0 };
  }

  // .tsx inputs need a .tsx virtual path so JSX syntax parses (a .ts
  // virtual path on JSX content is a CLASSIFIER_FAILURE upstream).
  const virtualExt = path.endsWith(".tsx") ? ".tsx" : ".ts";
  const virtualName = `/virtual/${path.replaceAll("\\", "_").replaceAll("/", "_")}${virtualExt}`;
  const sf = project.createSourceFile(virtualName, text, { overwrite: true });

  // Resolve which CallExpressions are `vi.mock`/`vi.doMock` (or namespaced
  // `<ns>.vi.mock`) calls. RECALL-first (plan C6): both vitest configs run
  // `globals: true`, so a file with NO explicit vitest import legitimately
  // uses the global `vi` — precision-first symbol binding (as used for the
  // `calls` criterion above) would silently classify that shape as mock=0,
  // a regression from the prior text-match gate. Counted callee roots:
  //   (a) the `vitest` named-import binding `vi` (alias-aware)
  //   (b) a bare `vi` identifier with NO local declaration (the global)
  //   (c) `<ns>.vi` where ns = `import * as ns from "vitest"`
  // A locally-declared `vi` shadow (e.g. `const vi = { mock() {} };`) is
  // fail-loud (VI_SHADOWED), never a silent pass — see the resolveMockCallee /
  // viShadowed resolution below.
  // Resolve the `vi` binding SYNTACTICALLY (by name) from the "vitest" imports.
  // `viImportName` = the local name of a named `vi` import (`vi`, or the alias
  // in `{ vi as viz }`). `viNamespaceName` = the binding of `import * as ns`.
  let viImportName; // local name of the named `vi` import, if any
  let viNamespaceName; // local name of the `import * as ns from "vitest"`, if any
  for (const imp of sf.getImportDeclarations()) {
    if (imp.getModuleSpecifierValue() !== "vitest") continue;
    const nsImport = imp.getNamespaceImport();
    if (nsImport !== undefined) {
      viNamespaceName = nsImport.getText();
    }
    for (const spec of imp.getNamedImports()) {
      if (spec.getName() !== "vi") continue;
      viImportName = (spec.getAliasNode() ?? spec.getNameNode()).getText();
    }
  }
  // Collect every LOCAL (non-import) declaration name — variable / function /
  // class declarations and parameters — in one pass. A name here shadows a
  // same-named import (`vi`, `it`, a helper), so the by-name binding resolution
  // below must treat it as NOT the import. Replaces per-name getSymbol shadow
  // checks (which forced the language service; see the note above).
  const localDeclaredNames = new Set();
  for (const decl of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const n = decl.getName();
    if (n) localDeclaredNames.add(n);
  }
  for (const decl of sf.getDescendantsOfKind(SyntaxKind.FunctionDeclaration)) {
    const n = decl.getName();
    if (n) localDeclaredNames.add(n);
  }
  for (const decl of sf.getDescendantsOfKind(SyntaxKind.Parameter)) {
    const n = decl.getName();
    if (n) localDeclaredNames.add(n);
  }
  const viLocallyDeclared = localDeclaredNames.has("vi");
  let viShadowed = false;

  // Returns the mock-call callee kind for a CallExpression's outer
  // PropertyAccessExpression callee (`X.mock` / `X.doMock`), or null. `method`
  // is "mock" or "doMock". Resolution is by NAME (no getSymbol) — see the
  // language-service note above.
  function resolveMockCallee(callee) {
    if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) return null;
    const method = callee.getName();
    if (method !== "mock" && method !== "doMock") return null;
    const target = callee.getExpression();
    if (target.getKind() === SyntaxKind.Identifier) {
      const text = target.getText();
      if (viImportName !== undefined) {
        // A named `vitest` import of `vi` exists (aliased or not): its local
        // name is the real vi. `import { vi as viz }` → `viz.mock(...)` counts.
        if (text === viImportName) return method;
        // A callee spelled `vi` that is NOT the import's local name is a local
        // shadow of the global name — fail loud rather than miscount.
        if (text === "vi") viShadowed = true;
        return null;
      }
      // No named `vi` import in this file. Only the bare global `vi` counts
      // (globals:true), and only when nothing locally shadows the name.
      if (text !== "vi") return null;
      if (viLocallyDeclared) {
        // A local `vi` declaration exists — the callee's `vi` binds to it, not
        // the global. Fail loud rather than silently (mis)counting.
        viShadowed = true;
        return null;
      }
      return method;
    }
    if (target.getKind() === SyntaxKind.PropertyAccessExpression) {
      // `<ns>.vi.mock` — target is `<ns>.vi`.
      if (target.getName() !== "vi") return null;
      const nsExpr = target.getExpression();
      if (nsExpr.getKind() !== SyntaxKind.Identifier) return null;
      if (viNamespaceName !== undefined && nsExpr.getText() === viNamespaceName) {
        return method;
      }
      return null;
    }
    return null;
  }

  // Normalize a mock specifier for suffix matching: strip a trailing
  // `.ts`/`.js` extension and resolve a relative specifier against the test
  // file's own directory (POSIX join; the repo uses POSIX-style paths
  // throughout — Windows separators are normalized upstream in `path`).
  function normalizeSpecifier(spec) {
    let normalized = spec.replace(/\.(ts|tsx|js|jsx)$/, "");
    if (normalized.startsWith(".")) {
      const base = dirname(path).replaceAll("\\", "/");
      normalized = posixPath.normalize(posixPath.join(base, normalized));
    }
    return normalized;
  }

  function isMappingSpecifier(spec) {
    return normalizeSpecifier(spec).endsWith(MAPPING_SUFFIX);
  }

  // Resolve the LOCAL binding symbol of the helper's named import (alias-aware:
  // `{ assertRedisFailClosed as assertFailClosed }` binds the alias). Calls are
  // then matched by SYMBOL, not by name text — a local function shadowing the
  // imported name has a different symbol and never counts, while a legitimate
  // alias call does (PR #680 review round 3, 7.1).
  // Binding resolution is done SYNTACTICALLY (by local name within this file),
  // never via getSymbol()/getDefinitionNodes(): those invoke the ts-morph
  // language service, and once it initializes on the shared in-memory project
  // every subsequent symbol lookup type-checks the whole ~1000-file scan set —
  // a ~600× slowdown that timed out CI (external review round 7 follow-up).
  // The classifier only ever resolves SAME-FILE bindings (vitest imports,
  // helper imports, local limiter consts), for which a name+shadow scan is
  // equivalent to symbol resolution.
  let hasImport = false;
  const helperNames = new Map(); // local binding NAME -> imported tier name
  for (const imp of sf.getImportDeclarations()) {
    if (imp.getModuleSpecifierValue() !== HELPER_MODULE) continue;
    for (const spec of imp.getNamedImports()) {
      if (!HELPER_NAMES.has(spec.getName())) continue;
      hasImport = true;
      const local = (spec.getAliasNode() ?? spec.getNameNode()).getText();
      helperNames.set(local, spec.getName());
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
  const vitestBindings = new Map(); // local NAME -> imported name
  for (const imp of sf.getImportDeclarations()) {
    if (imp.getModuleSpecifierValue() !== "vitest") continue;
    for (const spec of imp.getNamedImports()) {
      const imported = spec.getName();
      if (imported !== "it" && imported !== "test" && imported !== "describe" && imported !== "suite") {
        continue;
      }
      const local = (spec.getAliasNode() ?? spec.getNameNode()).getText();
      vitestBindings.set(local, imported);
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
    // A local declaration of the same name shadows the vitest import — not a
    // real registration. Match by name against the vitest import bindings.
    const nm = expr.getText();
    if (localDeclaredNames.has(nm)) return null;
    const imported = vitestBindings.get(nm);
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

  // Extract the `limiter:` property value node from a helper call's first
  // (options-object) argument, or undefined when absent / not an object literal.
  // Handles both `limiter: expr` (PropertyAssignment) and the shorthand
  // `limiter` (ShorthandPropertyAssignment → the shorthand identifier is the
  // value node itself, whose symbol resolves to the referenced binding).
  function limiterArgOf(call) {
    const arg = call.getArguments()[0];
    if (arg === undefined || arg.getKind() !== SyntaxKind.ObjectLiteralExpression) {
      return undefined;
    }
    for (const prop of arg.getProperties()) {
      if (
        prop.getKind() === SyntaxKind.PropertyAssignment &&
        prop.getName() === "limiter"
      ) {
        return prop.getInitializer();
      }
      if (
        prop.getKind() === SyntaxKind.ShorthandPropertyAssignment &&
        prop.getName() === "limiter"
      ) {
        return prop.getNameNode();
      }
    }
    return undefined;
  }

  // The SAME file loaded into the semantic project, created lazily on first use
  // (only helper files ever reach limiter resolution). A parse failure here is
  // FAIL-CLOSED: the classifier throws rather than silently falling back to a
  // scope-blind scan (external review round 8). Reused for every limiter lookup
  // in this file.
  let semanticSf;
  function getSemanticSf() {
    if (semanticSf === undefined) {
      semanticSf = semanticProject.createSourceFile(virtualName, text, { overwrite: true });
    }
    return semanticSf;
  }

  // Locate the node in the SEMANTIC source file that corresponds to a node from
  // the syntactic `sf` — same source text and position, so getStart() is a
  // stable key. Throws (fail-closed) if the semantic file lacks a node at that
  // position, which would mean the two parses diverged.
  function toSemantic(node) {
    const semSf = getSemanticSf();
    const n = semSf.getDescendantAtPos(node.getStart());
    if (n === undefined) {
      throw new Error(`${path}: semantic node not found at ${node.getStart()} (parse divergence)`);
    }
    // getDescendantAtPos returns the deepest node starting at/covering pos;
    // walk up to the node whose start matches exactly and kind agrees. `cur`
    // starts non-undefined (n) and is only reassigned to a non-undefined
    // parent, so it never becomes undefined inside the loop.
    let cur = n;
    while (cur.getStart() === node.getStart()) {
      if (cur.getKind() === node.getKind()) return cur;
      const parent = cur.getParent();
      if (parent === undefined || parent.getStart() !== node.getStart()) break;
      cur = parent;
    }
    return n;
  }

  // Resolve the binding declaration(s) an identifier refers to using
  // TypeScript's SCOPE-AWARE symbol resolution on the semantic project. A pure
  // by-name file scan is WRONG — it ignores lexical scope and would bind a
  // reference to an unrelated same-name declaration in a sibling function
  // (external review round 8 Major). The symbol lookup runs only for helper
  // files (bounded to the semantic project's ~54 members), so the language
  // service cost does not touch the ~1000-file syntactic scan.
  function bindingDeclsOf(semIdNode) {
    // A shorthand property `{ limiter }`: the name node's own symbol is the
    // ShorthandPropertyAssignment, not the referenced binding. The type
    // checker's getShorthandAssignmentValueSymbol yields the value binding
    // (the referenced `const`/import), scope-correctly.
    let sym;
    const parent = semIdNode.getParent();
    if (parent !== undefined && parent.getKind() === SyntaxKind.ShorthandPropertyAssignment) {
      const tc = semanticProject.getTypeChecker().compilerObject;
      const valueSym = tc.getShorthandAssignmentValueSymbol(parent.compilerNode);
      const compilerDecls = valueSym?.declarations ?? [];
      if (compilerDecls.length > 0) {
        // Re-locate each declaration as a ts-morph node via its source position
        // (consistent with toSemantic — the semantic sf is the same text).
        const semSf = getSemanticSf();
        const out = [];
        for (const d of compilerDecls) {
          const node = semSf.getDescendantAtPos(d.getStart(semSf.compilerNode));
          const match = node?.getFirstAncestorByKind?.(d.kind) ?? node;
          if (match !== undefined) out.push(match);
        }
        if (out.length > 0) return out;
      }
    }
    sym = semIdNode.getSymbol();
    if (sym === undefined) return [];
    // The LOCAL binding's own declarations (e.g. the ImportSpecifier for an
    // imported name, or the VariableDeclaration for a local const). These are
    // available WITHOUT resolving the imported module — the in-memory project
    // has no node_modules / cross-file targets, so `@/lib/...` imports never
    // resolve to their definition, but the local import specifier still tells
    // us the module + exported name (external review round 8: track the local
    // import binding even when the target module is unresolvable).
    const local = sym.getDeclarations() ?? [];
    if (local.length > 0) return local;
    // Only when the local symbol itself has no declarations (a pure alias whose
    // target is unresolvable) fall back to the aliased symbol.
    const aliased = sym.getAliasedSymbol?.();
    return aliased?.getDeclarations() ?? [];
  }

  // A stable identity key for a declaration node: its kind + start position in
  // the source. Two aliases resolving to the SAME `const shared = ...` share
  // this key, so they collapse even when the initializer is a call/object whose
  // value the AST cannot compare (external review 2026-07-19, round 5).
  function declKey(decl) {
    return `decl@${decl.getStart()}`;
  }

  // Normalize a limiter-argument expression to its ROOT binding, following
  // `const b = a` alias chains (with a visited guard against cycles) until the
  // initializer is no longer a bare identifier. Returns a descriptor:
  //   { kind: "import", moduleSpec, name }  — a named import (production candidate)
  //   { kind: "object", key }               — an inline/const object literal (fake)
  //   { kind: "call", key }                 — initialized by a call (factory result)
  //   { kind: "identity", key }             — an opaque root binding, keyed stably
  //   { kind: "unknown", key }              — unresolved; keyed by text
  // The `key` is the ROOT declaration's identity (not the alias's text), so
  // aliases of one root collapse. Used for BOTH distinct-limiter accounting and
  // the direct-result whitelist (external review 2026-07-19, rounds 4-5).
  // `expr` may be a syntactic-project node (the first call from limiterArgOf) or
  // an already-semantic node (recursive alias-chain calls). `semantic` marks
  // which, so the top-level call bridges to the semantic project exactly once.
  function resolveRootBinding(expr, visited = new Set(), semantic = false) {
    if (expr === undefined) return { kind: "unknown", key: "undefined" };
    if (expr.getKind() === SyntaxKind.ObjectLiteralExpression) {
      return { kind: "object", key: `objlit@${expr.getStart()}` };
    }
    if (expr.getKind() !== SyntaxKind.Identifier) {
      return { kind: "unknown", key: `text:${expr.getText()}` };
    }
    const semExpr = semantic ? expr : toSemantic(expr);
    for (const decl of bindingDeclsOf(semExpr)) {
      const dk = decl.getKind();
      if (dk === SyntaxKind.ImportSpecifier) {
        const imp = decl.getFirstAncestorByKind?.(SyntaxKind.ImportDeclaration);
        const moduleSpec = imp !== undefined ? normalizeSpecifier(imp.getModuleSpecifierValue()) : "";
        // The IMPORTED name (not the local alias) identifies the export.
        const name = decl.getNameNode?.().getText() ?? semExpr.getText();
        return { kind: "import", moduleSpec, name };
      }
      if (dk === SyntaxKind.ImportClause) {
        return { kind: "import", moduleSpec: "", name: semExpr.getText() };
      }
      if (dk === SyntaxKind.VariableDeclaration) {
        const init = decl.getInitializer?.();
        if (init === undefined) return { kind: "identity", key: declKey(decl) };
        if (init.getKind() === SyntaxKind.ObjectLiteralExpression) {
          return { kind: "object", key: declKey(decl) };
        }
        if (init.getKind() === SyntaxKind.Identifier) {
          // Alias chain: `const b = a` — recurse into `a` (already a semantic
          // node) with a cycle guard keyed on the resolved declaration.
          const guardKey = declKey(decl);
          if (visited.has(guardKey)) return { kind: "identity", key: guardKey };
          visited.add(guardKey);
          return resolveRootBinding(init, visited, true);
        }
        // Any other initializer (call/factory result, member access, etc.):
        // the ROOT is this variable declaration — key on IT, not the alias.
        return { kind: "call", key: declKey(decl) };
      }
    }
    // No resolvable declaration (e.g. an ambient/global) — key by name.
    return { kind: "identity", key: `name:${semExpr.getText()}` };
  }

  // Stable distinct-key for a limiter argument: its ROOT binding identity, so
  // two aliases of the SAME limiter (`const x = realLimiter; limiter: x`, or
  // `const s = make(); const a = s; const b = s`) count once, and two genuinely
  // different limiters count twice.
  function distinctKeyOf(expr) {
    const root = resolveRootBinding(expr);
    if (root.kind === "import") return `import:${root.moduleSpec}#${root.name}`;
    return root.key;
  }

  // Direct-result tier: the limiter must resolve to a WHITELISTED production
  // import (a named export from the rate-limiters module). Everything else —
  // inline/const fake, factory result, import from a test module — is rejected.
  function isProductionResultLimiter(expr) {
    const root = resolveRootBinding(expr);
    if (root.kind !== "import") return false;
    return (
      root.moduleSpec.endsWith(RESULT_LIMITER_MODULE_SUFFIX) &&
      RESULT_LIMITER_EXPORTS.has(root.name)
    );
  }

  // The static module specifier of a `vi.mock`/`vi.doMock` call's first arg, or
  // undefined when it is not a recognized static form. Handles the string /
  // template-literal forms AND the vitest-3 typed form `vi.mock(import("..."))`
  // — the single source of truth for BOTH the mapping-stub scan and the
  // rate-limiters module-mock detection, so neither can lag the other on a new
  // arg shape (external review 2026-07-19, round 6). `flags.dynamic` is set when
  // the arg exists but is not a static specifier, so the caller can flag
  // STUB_DYNAMIC_SPECIFIER.
  function mockSpecifierOf(call, flags) {
    const firstArg = call.getArguments()[0];
    if (firstArg === undefined) {
      flags.dynamic = true;
      return undefined;
    }
    if (
      firstArg.getKind() === SyntaxKind.StringLiteral ||
      firstArg.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral
    ) {
      return firstArg.getLiteralText();
    }
    if (
      firstArg.getKind() === SyntaxKind.CallExpression &&
      firstArg.getExpression().getKind() === SyntaxKind.ImportKeyword &&
      firstArg.getArguments()[0]?.getKind() === SyntaxKind.StringLiteral
    ) {
      // vitest 3 typed form: vi.mock(import("<specifier>"), ...)
      return firstArg.getArguments()[0].getLiteralText();
    }
    flags.dynamic = true;
    return undefined;
  }

  let calls = 0;
  let mock = false;
  let dynspec = false;
  const distinctLimiterKeys = new Set(); // distinct ROOT-binding keys
  // Whether the rate-limiters module is itself mocked — a `vi.mock(
  // "@/lib/security/rate-limiters", ...)` in any static form leaves the import
  // binding looking production-legitimate while replacing v1ApiKeyLimiter with
  // a fake (external review rounds 5-6). Detected in the single CallExpression
  // pass below (a separate pre-pass doubled the whole-tree walk over ~1000
  // files and timed out CI, round 7 follow-up). Direct-result limiter exprs are
  // stashed and re-checked against this flag AFTER the loop, since a mock can
  // syntactically follow the helper call.
  let resultLimiterModuleMocked = false;
  const directResultLimiterExprs = [];
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    // Match the helper call by the import's local NAME (alias-aware); a local
    // declaration of that name shadows the import and does not count.
    const calleeName = callee.getKind() === SyntaxKind.Identifier ? callee.getText() : undefined;
    if (
      calleeName !== undefined &&
      helperNames.has(calleeName) &&
      !localDeclaredNames.has(calleeName) &&
      isExecutedFromTest(call)
    ) {
      calls += 1;
      const tierName = helperNames.get(calleeName);
      const limiterExpr = limiterArgOf(call);
      // Distinct-limiter accounting keyed on the ROOT binding, so aliases of the
      // SAME limiter collapse to one and genuinely different limiters count
      // separately (external review 2026-07-19, round 4).
      if (limiterExpr !== undefined) {
        distinctLimiterKeys.add(distinctKeyOf(limiterExpr));
      }
      if (tierName === "assertRedisFailClosedResult") {
        directResultLimiterExprs.push(limiterExpr);
      }
    }
    // vi.mock(...) / vi.doMock(...) / <ns>.vi.mock(...) / <ns>.vi.doMock(...)
    if (resolveMockCallee(callee) !== null) {
      const flags = { dynamic: false };
      const specifier = mockSpecifierOf(call, flags);
      if (flags.dynamic) dynspec = true;
      if (
        specifier !== undefined &&
        normalizeSpecifier(specifier).endsWith(RESULT_LIMITER_MODULE_SUFFIX)
      ) {
        resultLimiterModuleMocked = true;
      }
      if (specifier !== undefined && isMappingSpecifier(specifier)) {
        mock = true;
      }
    }
  }

  // Direct-result tier verdict (deferred until the full mock set is known): the
  // limiter must resolve to a whitelisted production import AND the rate-limiters
  // module must not be mocked out from under the binding. Anything else (fake,
  // factory result, test-module import, mocked module) is rejected.
  let resultFakeLimiter = false;
  for (const limiterExpr of directResultLimiterExprs) {
    if (!isProductionResultLimiter(limiterExpr) || resultLimiterModuleMocked) {
      resultFakeLimiter = true;
      break;
    }
  }

  // redis / mock property detection. Each getDescendantsOfKind(...) below wraps
  // a whole node kind across the file; skip the walks entirely for files whose
  // raw text contains neither token (the vast majority), so only relevant files
  // pay the AST cost — the ~1000-file scan otherwise timed out CI (external
  // review round 7 follow-up). The AST walks still run for files that DO contain
  // the token, preserving comment/string exclusion.
  let redis = false;
  const hasRedisText = text.includes("redisErrored");
  const hasMapText = text.includes("checkRateLimitOrFail");
  if (hasRedisText || hasMapText) {
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
    if (!redis && hasRedisText) {
      for (const node of sf.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
        if (node.getName() === "redisErrored") {
          redis = true;
          break;
        }
      }
    }
  }
  // Last-resort presence checks (destructuring / standalone identifier bindings
  // such as `const { redisErrored } = rl`, or a `mockCheckRateLimitOrFail`
  // reference). getDescendantsOfKind(Identifier) wraps EVERY identifier node in
  // the file (thousands per test file); running that over the ~1000-file scan
  // dominated runtime and timed out CI (external review round 7 follow-up).
  // Gate the AST walk behind a cheap raw-text prefilter: only the rare files
  // that actually contain the token pay for the identifier-precise scan (which
  // still excludes comments/strings, preserving exact prior behavior).
  if (!redis && text.includes("redisErrored")) {
    for (const node of sf.getDescendantsOfKind(SyntaxKind.Identifier)) {
      if (node.getText() === "redisErrored") {
        redis = true;
        break;
      }
    }
  }
  if (!mock && text.includes("mockCheckRateLimitOrFail")) {
    for (const node of sf.getDescendantsOfKind(SyntaxKind.Identifier)) {
      if (node.getText() === "mockCheckRateLimitOrFail") {
        mock = true;
        break;
      }
    }
  }

  sf.forget();
  // Drop the semantic source file too (helper files only) so the semantic
  // project does not accumulate across the scan.
  if (semanticSf !== undefined) semanticProject.removeSourceFile(semanticSf);

  // A locally-declared `vi` shadow is a suspicious construct — fail-loud
  // rather than silently classifying its mock calls as mock=0 (C6).
  if (viShadowed) {
    throw new Error(`${path}: local declaration shadows the global/import "vi" binding (VI_SHADOWED)`);
  }

  return {
    exists: 1,
    import: hasImport ? 1 : 0,
    calls,
    mock: mock ? 1 : 0,
    redis: redis ? 1 : 0,
    dynspec: dynspec ? 1 : 0,
    distinct: distinctLimiterKeys.size,
    resultfake: resultFakeLimiter ? 1 : 0,
    // Independent of any helper call: 1 iff this file mocks the rate-limiters
    // module. A setup file carries no helper call, so resultfake stays 0 there
    // even though registering the file in setupFiles replaces the production
    // limiter for EVERY test — the C6 whole-file/setup scan rejects this flag
    // directly (external review 2026-07-19, round 7).
    resultmodulemock: resultLimiterModuleMocked ? 1 : 0,
  };
}

try {
  for (const file of files) {
    const r = classify(file);
    process.stdout.write(
      `${file}\texists=${r.exists} import=${r.import} calls=${r.calls} mock=${r.mock} redis=${r.redis} dynspec=${r.dynspec} distinct=${r.distinct} resultfake=${r.resultfake} resultmodulemock=${r.resultmodulemock}\n`,
    );
  }
} catch (err) {
  console.error(`classify-fail-closed-test: internal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
