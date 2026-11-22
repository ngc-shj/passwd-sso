#!/usr/bin/env node
/**
 * CI guard (AST, ts-morph, no Program): client code reads a mutation's
 * response body only through `parseJsonBodyOnce`.
 *
 * ## The class (plan: close-coverage-and-clipboard-gaps, C11)
 *
 * A client mutation whose server-side write has committed (`res.ok`) was
 * reported as failed, or skipped its completion, because `await res.json()`
 * sat in the same `try` as the request and threw. For an endpoint that mints a
 * once-shown secret (API key, SCIM/SA/operator/JIT token, invite or share
 * link) the secret was lost and the user was told nothing had been created.
 * `parseJsonBodyOnce` never rejects (an unreadable body is `null`), so a site
 * that uses it cannot fail that way.
 *
 * ## What is denied
 *
 * A `.json()` call on a Response that comes from a MUTATING source call, in
 * client code (src/components, src/hooks, src/app outside src/app/api, and
 * src/lib except server modules — see "Client code under src/lib"):
 *   - `const res = await src(...)` / `res = await src(...)`, then `res.json()`
 *     anywhere the name still means that binding (scope-aware, lib/scope-bindings);
 *   - `(await src(...)).json()`;
 *   - `const p = src(...)`, then `(await p).json()` or `p.then((r) => r.json())`;
 *   - `src(...).then((r) => r.json())`, arrow or function, expression or block body.
 *
 * A SOURCE is a call to `fetchApi` (bare, a property `x.fetchApi` for an
 * injected one, or a local name holding it — a parameter defaulting to it, a
 * `const` alias) or to a RESPONSE HELPER: a function (declaration, or a `const`
 * bound to an arrow/function expression or to `useCallback(fn, deps)`) under
 * src/lib or a scan root that returns a source call, directly or through a
 * local `const` it was awaited into — derived to a fixpoint, not listed by
 * hand. A helper whose returned call takes the request init from one of its
 * own parameters forwards the question to its call site's argument at that
 * position; any other helper is mutating when its returned call is. A local
 * helper resolves through the file's own binding (lib/scope-bindings); an
 * imported name resolves to an exported helper of that name (by name, so two
 * exported helpers sharing a name can only over-report).
 *
 * The error path is covered too: every `.json()` on such a response is denied,
 * since `readApiErrorBody` reads through `parseJsonBodyOnce` as well.
 *
 * ## When a call is mutating
 *
 * Resolved from the init argument: absent, or an object literal with no
 * `method`, is GET. A `method` that is a string literal, a template without
 * substitutions, a conditional of such, or a local `const` holding one, is read;
 * GET and HEAD are safe, anything else mutates. Everything else — a spread after
 * which no `method` is written, an init the file cannot resolve to a `const`
 * object literal, a `method` that is a parameter or any other expression —
 * counts as mutating, so the gate fails closed.
 *
 * ## Control class (R49)
 *
 * A fail-closed verification gate adjudicated by the TypeScript AST, with
 * name-based helper discovery. Known bypasses:
 *   - the Response crosses a function boundary (passed as an argument, returned
 *     from a function that is not a derived helper — an object or class
 *     method, a `useMemo`-built function, a returned `let`), or is aliased
 *     (`const r2 = res`, destructured from `Promise.all`);
 *   - a fetcher injected under another name with no `= fetchApi` default
 *     (`deps.fetch`, `fetchImpl`), and raw `fetch` (banned in client code by
 *     eslint `CallExpression[callee.name='fetch']`);
 *   - body readers other than `.json()` (`.text()`, `.blob()`, `.arrayBuffer()`)
 *     and `res.clone().json()`.
 *
 * ## Client code under src/lib
 *
 * "Imported only from client code" is not decidable here without a Program and
 * a full import graph, and a `"use client"` directive marks only components
 * (vault-context.tsx has one; passkey-reauth-client.ts does not, yet runs only
 * in the browser). So the rule is the sound over-approximation: every src/lib
 * module is a deny root unless it is SERVER code, recognised by a value import
 * the bundler refuses in a client bundle — `server-only`, `next/headers`, or
 * the Prisma singleton `@/lib/prisma` (it pulls in `pg`). Excluding those loses
 * nothing: `fetchApi` throws outside a browser (`typeof window === "undefined"`),
 * so a source call in a server module never yields a Response to read. A module
 * with no marker is treated as client code even if only the server imports it —
 * it fails closed. `import type` erases and does not count as a marker.
 *
 * Refuses (exit 1) an unparseable file and an empty file list, so "examined
 * nothing" never reads as "found nothing".
 *
 * Run: node scripts/checks/check-mutation-response-read.mjs
 *
 * MUTATION_RESPONSE_READ_ROOT overrides the scan root (self-test fixtures only).
 */
import { SyntaxKind } from "ts-morph";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { createAstProject, sourceFilesFrom } from "./lib/ast-project.mjs";
import {
  FN_KINDS,
  bindingIndex,
  resolveLocalObjectLiteral,
  unwrapExpression,
  visibleBinding,
} from "./lib/scope-bindings.mjs";

const NAME = "check-mutation-response-read";
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.MUTATION_RESPONSE_READ_ROOT || join(__dirname, "..", "..");

// The override exists for the self-test; left set in CI it would silently
// point the gate at another tree.
if (
  process.env.CI === "true" &&
  process.env.MUTATION_RESPONSE_READ_ROOT &&
  process.env.MUTATION_RESPONSE_READ_FIXTURE_MODE !== "1"
) {
  console.error(
    `${NAME}: MUTATION_RESPONSE_READ_ROOT must not be set in CI. ` +
      "Set MUTATION_RESPONSE_READ_FIXTURE_MODE=1 only from the self-test.",
  );
  process.exit(1);
}

const DENY_ROOTS = ["src/components", "src/hooks", "src/app", "src/lib"];
const EXCLUDED_PREFIX = "src/app/api/";
const SERVER_MARKER_MODULES = new Set(["server-only", "next/headers", "@/lib/prisma"]);
const SAFE_METHODS = new Set(["GET", "HEAD"]);
const FUNCTION_LIKE = new Set([...FN_KINDS, SyntaxKind.FunctionDeclaration]);

/**
 * True when `sf` value-imports a module a client bundle cannot contain. A
 * relative specifier counts when it names src/lib/prisma, as `@/lib/prisma` does.
 */
function isServerModule(sf, rel) {
  return sf.getImportDeclarations().some((decl) => {
    if (decl.isTypeOnly()) return false;
    const named = decl.getNamedImports();
    const valueBinding =
      named.length === 0 || decl.getDefaultImport() || decl.getNamespaceImport() || named.some((n) => !n.isTypeOnly());
    if (!valueBinding) return false;
    const spec = decl.getModuleSpecifierValue();
    if (SERVER_MARKER_MODULES.has(spec)) return true;
    if (!spec.startsWith(".")) return false;
    return posix.join(posix.dirname(rel), spec) === "src/lib/prisma";
  });
}

let files;
try {
  const project = createAstProject();
  files = [...sourceFilesFrom(project, DENY_ROOTS, ROOT)]
    .filter(({ rel }) => !rel.startsWith(EXCLUDED_PREFIX))
    .map((f) => ({ ...f, deny: !(f.rel.startsWith("src/lib/") && isServerModule(f.sf, f.rel)) }));
} catch (err) {
  console.error(`${NAME}: ${err.message}`);
  process.exit(1);
}

const denyCount = files.filter((f) => f.deny).length;
if (denyCount === 0) {
  console.error(`ZERO_FILES_SCANNED: ${NAME} found no source files under ${DENY_ROOTS.join(", ")} (root ${ROOT}).`);
  process.exit(1);
}

const parseErrors = files
  .filter(({ sf }) => {
    const diagnostics = sf.compilerNode.parseDiagnostics;
    return !Array.isArray(diagnostics) || diagnostics.length > 0;
  })
  .map(({ rel }) => rel);
if (parseErrors.length > 0) {
  console.error(`PARSE_ERROR: ${NAME} could not analyse these files:`);
  for (const p of parseErrors) console.error(`  ${p}`);
  process.exit(1);
}

const bindingCache = new Map();
function bindingsOf(sf) {
  return () => {
    let index = bindingCache.get(sf);
    if (!index) {
      index = bindingIndex(sf);
      bindingCache.set(sf, index);
    }
    return index;
  };
}

// ── Method resolution ────────────────────────────────────────────────────────

/** True when `expr` (a `method` value) may name a mutating method. */
function methodMutates(expr, sf, seen = new Set()) {
  const e = unwrapExpression(expr);
  if (!e) return true;
  switch (e.getKind()) {
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
      return !SAFE_METHODS.has(e.getLiteralText().toUpperCase());
    case SyntaxKind.ConditionalExpression:
      return methodMutates(e.getWhenTrue(), sf, seen) || methodMutates(e.getWhenFalse(), sf, seen);
    case SyntaxKind.Identifier: {
      const decl = visibleBinding(e.getText(), e, bindingsOf(sf));
      if (!decl || decl.getKind() !== SyntaxKind.VariableDeclaration) return true;
      if (decl.getVariableStatement?.()?.getDeclarationKind() !== "const") return true;
      if (seen.has(decl)) return true;
      seen.add(decl);
      return methodMutates(decl.getInitializer(), sf, seen);
    }
    default:
      return true;
  }
}

/** True when a request with init argument `init` may mutate. */
function initMutates(init, sf) {
  const e = unwrapExpression(init);
  if (!e) return false; // no init: GET
  let literal = null;
  if (e.getKind() === SyntaxKind.ObjectLiteralExpression) literal = e;
  else if (e.getKind() === SyntaxKind.Identifier) literal = resolveLocalObjectLiteral(e.getText(), e, bindingsOf(sf));
  if (!literal) return true;
  // The last write of `method` wins; a spread after it (or with none) may set it.
  let verdict = false;
  for (const prop of literal.getProperties()) {
    const kind = prop.getKind();
    if (kind === SyntaxKind.SpreadAssignment) {
      verdict = true;
      continue;
    }
    if (kind === SyntaxKind.PropertyAssignment) {
      const nameNode = prop.getNameNode();
      if (nameNode.getKind() === SyntaxKind.ComputedPropertyName) {
        verdict = true;
        continue;
      }
      if (prop.getName().replace(/^["']|["']$/g, "") === "method") {
        verdict = methodMutates(prop.getInitializer(), sf);
      }
      continue;
    }
    if (kind === SyntaxKind.ShorthandPropertyAssignment && prop.getName() === "method") {
      verdict = methodMutates(prop.getNameNode(), sf);
      continue;
    }
    if (prop.getName?.() === "method") verdict = true; // accessor or method
  }
  return verdict;
}

// ── Source calls and response helpers ────────────────────────────────────────

/** name → [{ sf, fn, exported, forward: number | null }] */
const helpers = new Map();

/**
 * `fetchApi`, `x.fetchApi`, or a local name that holds it: a parameter
 * defaulting to it (`fetcher: FetchLike = fetchApi`) or a `const` alias.
 */
function isFetchApiCallee(callee, sf) {
  if (callee.getKind() === SyntaxKind.PropertyAccessExpression) return callee.getName() === "fetchApi";
  if (callee.getKind() !== SyntaxKind.Identifier) return false;
  if (callee.getText() === "fetchApi") return true;
  const decl = visibleBinding(callee.getText(), callee, bindingsOf(sf));
  if (!decl) return false;
  const isConst =
    decl.getKind() === SyntaxKind.Parameter ||
    (decl.getKind() === SyntaxKind.VariableDeclaration &&
      decl.getVariableStatement()?.getDeclarationKind() === "const");
  return isConst && unwrapExpression(decl.getInitializer?.())?.getText() === "fetchApi";
}

/** The helper record a call's callee names, or null. */
function helperFor(call, sf) {
  const callee = call.getExpression();
  if (callee.getKind() !== SyntaxKind.Identifier) return null;
  const name = callee.getText();
  const candidates = helpers.get(name);
  if (!candidates) return null;
  const local = visibleBinding(name, callee, bindingsOf(sf));
  if (local) {
    const fn = local.getKind() === SyntaxKind.VariableDeclaration ? hookWrapped(unwrapExpression(local.getInitializer())) : local;
    return candidates.find((h) => h.fn === fn) ?? null;
  }
  // Not bound in this file: an import (or a global). Match an exported helper.
  return candidates.find((h) => h.exported) ?? null;
}

/**
 * How `call` requests: null when it is not a source call; otherwise
 * { mutates, initIndex } where initIndex is the argument carrying the init.
 */
function sourceShape(call, sf) {
  const callee = call.getExpression();
  if (isFetchApiCallee(callee, sf)) return { helper: null, initIndex: 1 };
  const helper = helperFor(call, sf);
  if (!helper) return null;
  return { helper, initIndex: helper.forward };
}

function callMutates(call, sf) {
  const shape = sourceShape(call, sf);
  if (!shape) return false;
  if (shape.initIndex === null) return true; // a helper that mutates on its own
  return initMutates(call.getArguments()[shape.initIndex], sf);
}

function isSourceCall(node, sf) {
  return node?.getKind() === SyntaxKind.CallExpression && sourceShape(node, sf) !== null;
}

/** The function-like node `node` belongs to (null at module level). */
function enclosingFunction(node) {
  return node.getFirstAncestor((a) => FUNCTION_LIKE.has(a.getKind()) || a.getKind() === SyntaxKind.MethodDeclaration) ?? null;
}

/** Expressions `fn` returns: `return x` at its own level, or an arrow's expression body. */
function returnedExpressions(fn) {
  const body = fn.getBody?.();
  if (!body) return [];
  if (body.getKind() !== SyntaxKind.Block) return [body];
  return body
    .getDescendantsOfKind(SyntaxKind.ReturnStatement)
    .filter((r) => enclosingFunction(r) === fn)
    .map((r) => r.getExpression())
    .filter(Boolean);
}

function stripAwait(expr) {
  let e = unwrapExpression(expr);
  while (e?.getKind() === SyntaxKind.AwaitExpression) e = unwrapExpression(e.getExpression());
  return e;
}

/** `useCallback(fn, deps)` names `fn`; anything else is returned as is. */
function hookWrapped(init) {
  if (init?.getKind() !== SyntaxKind.CallExpression) return init;
  const callee = init.getExpression();
  const name = callee.getKind() === SyntaxKind.PropertyAccessExpression ? callee.getName() : callee.getText();
  if (name !== "useCallback") return init;
  return unwrapExpression(init.getArguments()[0]);
}

/**
 * The source call a returned expression carries: the call itself, or the
 * awaited call a local `const` returned by name was initialised with.
 */
function returnedCall(ret, sf) {
  const e = stripAwait(ret);
  if (e?.getKind() !== SyntaxKind.Identifier) return e;
  const decl = visibleBinding(e.getText(), e, bindingsOf(sf));
  if (decl?.getKind() !== SyntaxKind.VariableDeclaration) return e;
  if (decl.getVariableStatement?.()?.getDeclarationKind() !== "const") return e;
  return stripAwait(decl.getInitializer());
}

function functionCandidates(sf) {
  const out = [];
  for (const fn of sf.getDescendantsOfKind(SyntaxKind.FunctionDeclaration)) {
    if (fn.getName() && fn.getBody()) out.push({ name: fn.getName(), fn, exported: fn.isExported() });
  }
  for (const decl of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    if (decl.getNameNode().getKind() !== SyntaxKind.Identifier) continue;
    if (decl.getVariableStatement?.()?.getDeclarationKind() !== "const") continue;
    const init = hookWrapped(unwrapExpression(decl.getInitializer()));
    if (!init || !FN_KINDS.has(init.getKind())) continue;
    out.push({ name: decl.getName(), fn: init, exported: decl.getVariableStatement()?.isExported() ?? false });
  }
  return out;
}

/** The helper record `fn` earns from its returned source calls, or null. */
function classifyHelper({ fn, exported }, sf) {
  let forward = null;
  let mutating = false;
  let any = false;
  for (const ret of returnedExpressions(fn)) {
    const call = returnedCall(ret, sf);
    if (!isSourceCall(call, sf)) continue;
    any = true;
    const shape = sourceShape(call, sf);
    if (shape.initIndex === null) {
      mutating = true;
      continue;
    }
    const init = unwrapExpression(call.getArguments()[shape.initIndex]);
    const params = fn.getParameters();
    const paramIndex =
      init?.getKind() === SyntaxKind.Identifier
        ? params.findIndex((p) => p.getName() === init.getText() && visibleBinding(init.getText(), init, bindingsOf(sf)) === p)
        : -1;
    if (paramIndex >= 0 && forward === null) forward = paramIndex;
    else if (paramIndex >= 0 && forward !== paramIndex) mutating = true;
    else if (initMutates(init, sf)) mutating = true;
  }
  if (!any) return null;
  if (mutating) return { sf, fn, exported, forward: null };
  if (forward !== null) return { sf, fn, exported, forward };
  return null; // only GET requests
}

const candidates = files.flatMap(({ sf }) => functionCandidates(sf).map((c) => ({ ...c, sf })));
for (let changed = true; changed; ) {
  changed = false;
  for (const c of candidates) {
    const bucket = helpers.get(c.name) ?? [];
    const existing = bucket.find((h) => h.fn === c.fn);
    const next = classifyHelper(c, c.sf);
    if (!next) continue;
    if (!existing) {
      helpers.set(c.name, [...bucket, next]);
      changed = true;
    } else if (existing.forward !== next.forward) {
      existing.forward = next.forward;
      changed = true;
    }
  }
}

// ── Response tracking ────────────────────────────────────────────────────────

const sites = [];

function isJsonCallOn(node) {
  const access = node.getParent();
  if (access?.getKind() !== SyntaxKind.PropertyAccessExpression || access.getExpression() !== node) return false;
  if (access.getName() !== "json") return false;
  const call = access.getParent();
  return call?.getKind() === SyntaxKind.CallExpression && call.getExpression() === access;
}

/** Climb from `expr` past parentheses, type wrappers and conditional branches to the expression a parent sees. */
function outermost(expr) {
  let e = expr;
  for (let p = e.getParent(); p; p = e.getParent()) {
    const k = p.getKind();
    if (k === SyntaxKind.ParenthesizedExpression || k === SyntaxKind.AsExpression || k === SyntaxKind.NonNullExpression || k === SyntaxKind.SatisfiesExpression) {
      e = p;
      continue;
    }
    // `cond ? await a : await b` holds whichever branch ran.
    if (k === SyntaxKind.ConditionalExpression && p.getCondition() !== e) {
      e = p;
      continue;
    }
    break;
  }
  return e;
}

/** The declaration an expression's value is stored in (`const x = e`, `x = e`), or null. */
function storedIn(expr, sf) {
  const outer = outermost(expr);
  const parent = outer.getParent();
  if (parent?.getKind() === SyntaxKind.VariableDeclaration && parent.getInitializer() === outer) {
    return parent.getNameNode().getKind() === SyntaxKind.Identifier ? parent : null;
  }
  if (
    parent?.getKind() === SyntaxKind.BinaryExpression &&
    parent.getOperatorToken().getKind() === SyntaxKind.EqualsToken &&
    parent.getRight() === outer
  ) {
    const left = unwrapExpression(parent.getLeft());
    if (left.getKind() === SyntaxKind.Identifier) return visibleBinding(left.getText(), left, bindingsOf(sf));
  }
  return null;
}

/** Identifiers that refer to `decl` (scope-aware). */
function referencesTo(decl, sf) {
  const name = decl.getName();
  const scope = decl.getFirstAncestor((a) => a.getKind() === SyntaxKind.SourceFile || a.getKind() === SyntaxKind.Block || FUNCTION_LIKE.has(a.getKind())) ?? sf;
  return scope
    .getDescendantsOfKind(SyntaxKind.Identifier)
    .filter((id) => id.getText() === name && id !== decl.getNameNode() && visibleBinding(name, id, bindingsOf(sf)) === decl);
}

/** Report each `.json()` read of a response held in `decl` (or of a promise of one). */
function trackBinding(decl, holdsPromise, origin, sf, rel) {
  for (const id of referencesTo(decl, sf)) {
    if (!holdsPromise) {
      if (isJsonCallOn(outermost(id))) report(rel, id, origin);
      continue;
    }
    trackPromise(id, origin, sf, rel);
  }
}

/** `p` is an expression whose value is a Promise<Response>. */
function trackPromise(p, origin, sf, rel) {
  const outer = outermost(p);
  const parent = outer.getParent();
  if (parent?.getKind() === SyntaxKind.AwaitExpression) {
    trackResponse(parent, origin, sf, rel);
    return;
  }
  if (parent?.getKind() === SyntaxKind.PropertyAccessExpression && parent.getExpression() === outer && parent.getName() === "then") {
    const call = parent.getParent();
    if (call?.getKind() !== SyntaxKind.CallExpression) return;
    const cb = unwrapExpression(call.getArguments()[0]);
    if (!cb || !FN_KINDS.has(cb.getKind())) return;
    const param = cb.getParameters()[0];
    if (param && param.getNameNode().getKind() === SyntaxKind.Identifier) trackBinding(param, false, origin, sf, rel);
    return;
  }
  const decl = storedIn(p, sf);
  if (decl) trackBinding(decl, true, origin, sf, rel);
}

/** `r` is an expression whose value is a Response. */
function trackResponse(r, origin, sf, rel) {
  if (isJsonCallOn(outermost(r))) {
    report(rel, r, origin);
    return;
  }
  const decl = storedIn(r, sf);
  if (decl) trackBinding(decl, false, origin, sf, rel);
}

function report(rel, at, origin) {
  sites.push({ rel, line: at.getStartLineNumber(), origin: `${origin.getExpression().getText()}(…) line ${origin.getStartLineNumber()}` });
}

for (const { rel, sf, deny } of files) {
  if (!deny) continue;
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (!callMutates(call, sf)) continue;
    trackPromise(call, call, sf, rel);
  }
}

// One row per read; a read reached from two requests (`c ? await a : await b`) names both.
const reads = new Map();
for (const s of sites) {
  const key = `${s.rel}:${s.line}`;
  const row = reads.get(key) ?? { rel: s.rel, line: s.line, origins: [] };
  if (!row.origins.includes(s.origin)) row.origins.push(s.origin);
  reads.set(key, row);
}
const unique = [...reads.values()].sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line);

if (unique.length > 0) {
  console.error(`MUTATION_RESPONSE_JSON_READ: ${unique.length} read(s) of a mutation response body outside parseJsonBodyOnce:`);
  for (const s of unique) console.error(`  ${s.rel}:${s.line}  .json() on the response of ${s.origins.join(" / ")}`);
  console.error(
    "\nA mutation that committed must not be reported as failed because its body could not be read. " +
      "Run the completion (refresh, onSuccess, reset) right after res.ok, then read the body with " +
      "`await parseJsonBodyOnce(res)` (src/lib/http/read-api-error-body.ts) and handle `null`.",
  );
  process.exit(1);
}

const helperCount = [...helpers.values()].reduce((n, b) => n + b.length, 0);
console.log(`${NAME}: OK (${denyCount} files, ${helperCount} response helper(s))`);
