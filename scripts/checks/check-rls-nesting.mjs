#!/usr/bin/env node
/**
 * CI guard: no RLS context is opened from inside another one.
 *
 * `assertNoActiveRlsContext` (src/lib/tenant-rls.ts) refuses a nested
 * withTenantRls / withBypassRls at run time with INVALID_RLS_NESTING. That is
 * fail-closed only for a caller that propagates the error. A caller that
 * swallows it — `invalidateUserSessions(...).catch(() => null)`, the
 * best-effort notification and lockout-audit paths — turns the refusal into a
 * silently skipped security side effect, which no test notices unless it drives
 * that exact nesting. This gate rejects the nesting before it runs.
 *
 * Everything is answered by the type-checked Program, not by spelling:
 *
 *   - OPENERS: the two base helpers, and every function that calls an opener
 *     or hands one on as a value — a fixpoint over resolved callees, so an
 *     alias, a namespace import, a re-export or `(fn)(…)` is the same callee.
 *   - CONTEXT FUNCTIONS: the base helpers (every function argument is a
 *     callback), and every WRAPPER — a function whose own parameter is called,
 *     or passed on as a callback, inside a context it opens
 *     (withUserTenantRls, withTeamTenantRls, a route's local withVaultTenantRls).
 *     Also a fixpoint.
 *   - A context callback is checked call by call. A function literal passed to
 *     an ordinary call inside it (`items.map(async (x) => …)`) runs inside the
 *     same context and is checked as part of it.
 *
 * Fail-closed: a call this gate cannot resolve to a function body is not
 * assumed harmless. Inside a callback it is reported. Anywhere else it marks
 * its enclosing function UNDECIDABLE, and calling an undecidable function from
 * a callback is reported too. A library call (a declaration file or
 * node_modules) is resolved — it cannot import these helpers — and any
 * function value handed to it from a callback is checked as a reference.
 *
 * Resolution follows the same rules as check-bypass-rls's cross-module pass:
 * an interface member is every implementation, a non-literal index into a
 * const object table is every member, and a member of an object held in a
 * `let`/`var`/parameter is refused, because the checker answers from the
 * declared type, not from the value.
 *
 * The scan root is `src/` (non-test) plus EXTRA_SCAN_FILES.
 */
import { SyntaxKind } from "ts-morph";
import { createProgramProject, ProgramBuildError } from "./lib/ast-project.mjs";
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

const HELPER_FILE = "src/lib/tenant-rls.ts";
const BASE_HELPERS = ["withTenantRls", "withBypassRls"];
const EXTRA_SCAN_FILES = ["scripts/tenant-domain.ts"];

// Call sites whose callee opens a context only on a branch the call does not
// take. Keyed "file::callee"; an entry that matches nothing fails the run.
const CONDITIONAL_OPENER_ALLOWLIST = new Map([
  // derivePasskeyState opens withBypassRls only when `params.tx` is absent
  // (src/lib/auth/policy/passkey-enforcement.ts); both calls here pass `tx`.
  ["src/lib/mcp/oauth-server.ts::derivePasskeyState", "passes tx"],
]);

// Interfaces declared here to type a value a LIBRARY produces, so no code of
// ours implements them. A call through one of their members runs library code.
// Keyed "file::Interface"; an entry that matches nothing fails the run.
const EXTERNAL_SHAPE_ALLOWLIST = new Map([
  // The cloud key providers' SDK clients, loaded lazily with require() so each
  // SDK package stays optional.
  ["src/lib/key-provider/aws-sm-provider.ts::SmClient", "@aws-sdk/client-secrets-manager"],
  ["src/lib/key-provider/azure-kv-provider.ts::KvSecretClient", "@azure/keyvault-secrets"],
  ["src/lib/key-provider/gcp-sm-provider.ts::SmClient", "@google-cloud/secret-manager"],
]);
const usedExternalShapes = new Set();

// Library functions that return a function of the library's own, never one a
// caller supplied. Keyed by the callee's name as written; an entry that matches
// nothing fails the run.
const LIBRARY_FACTORY_ALLOWLIST = new Map([
  // node:module's createRequire returns a require() bound to a path.
  ["createRequire", "node:module"],
]);
const usedLibraryFactories = new Set();

/**
 * `require("pkg")` / `import("pkg")` with a bare package specifier loads a
 * library module. A relative or `@/` specifier loads ours, and is not this.
 */
function isPackageModuleLoad(call) {
  const callee = unwrap(call.getExpression());
  const isLoader =
    callee?.getKind() === SyntaxKind.ImportKeyword ||
    (callee?.getKind() === SyntaxKind.Identifier && callee.getText() === "require");
  if (!isLoader) return false;
  const spec = literalKey(call.getArguments()[0]);
  return spec !== null && !spec.startsWith(".") && !spec.startsWith("@/") && !spec.startsWith("/");
}

function libraryFactoryOf(call) {
  const callee = unwrap(call.getExpression());
  const name = callee?.getKind() === SyntaxKind.PropertyAccessExpression ? callee.getName() : callee?.getText();
  return LIBRARY_FACTORY_ALLOWLIST.has(name) ? name : null;
}

const FN_KINDS = new Set([
  SyntaxKind.ArrowFunction,
  SyntaxKind.FunctionExpression,
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.Constructor,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
]);
const LITERAL_FN_KINDS = new Set([SyntaxKind.ArrowFunction, SyntaxKind.FunctionExpression]);

function toRelPosix(absPath) {
  return relative(process.cwd(), absPath).split(sep).join("/");
}

function isScanFile(rel) {
  if (EXTRA_SCAN_FILES.includes(rel)) return true;
  return (
    rel.startsWith("src/") &&
    /\.tsx?$/.test(rel) &&
    !rel.endsWith(".d.ts") &&
    !/\.(test|spec)\.tsx?$/.test(rel) &&
    !rel.includes("__tests__")
  );
}

function isExternal(node) {
  const sf = node.getSourceFile();
  return sf.isDeclarationFile() || sf.getFilePath().includes("/node_modules/");
}

/** Own code outside the scan root — test files and fixtures, which never run in production. */
function isNonProduction(node) {
  return !isExternal(node) && !isScanFile(toRelPosix(node.getSourceFile().getFilePath()));
}

function unwrap(expr) {
  switch (expr?.getKind()) {
    case SyntaxKind.ParenthesizedExpression:
    case SyntaxKind.AsExpression:
    case SyntaxKind.NonNullExpression:
    case SyntaxKind.SatisfiesExpression:
    case SyntaxKind.TypeAssertionExpression:
      return unwrap(expr.getExpression());
    default:
      return expr;
  }
}

function literalKey(expr) {
  const e = unwrap(expr);
  if (!e) return null;
  if (e.getKind() === SyntaxKind.StringLiteral || e.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral) {
    return e.getLiteralText();
  }
  return null;
}

function fail(message) {
  console.error(`check-rls-nesting: ${message}`);
  process.exit(1);
}

// ─── Program ────────────────────────────────────────────────────────────────

let program;
try {
  program = createProgramProject(join(process.cwd(), "tsconfig.json"));
} catch (error) {
  if (error instanceof ProgramBuildError) fail(`PROGRAM_BUILD_FAILED: ${error.message}`);
  throw error;
}

const scanFiles = program
  .getSourceFiles()
  .filter((sf) => isScanFile(toRelPosix(sf.getFilePath())));
if (scanFiles.length === 0) {
  fail("no scannable source files under src/. Nothing was examined, so this is not a pass.");
}

const helperSf = program.getSourceFile(join(process.cwd(), HELPER_FILE));
if (!helperSf) fail(`${HELPER_FILE} is not in the Program; the base helpers cannot be resolved.`);
const baseHelpers = new Set();
for (const name of BASE_HELPERS) {
  const decl = helperSf.getFunction(name);
  if (!decl) fail(`${HELPER_FILE} declares no function ${name}.`);
  baseHelpers.add(decl.getImplementation?.() ?? decl);
}

// ─── Resolution ─────────────────────────────────────────────────────────────

/**
 * Result shape: { fns: Node[], external: boolean, param: Node|null, unresolved: string|null }.
 * `param` is the parameter declaration a callee names — its value is the
 * caller's argument, which is checked where it is passed.
 */
const EMPTY = Object.freeze({ fns: [], external: false, param: null, unresolved: null });
const unresolvedResult = (reason) => ({ ...EMPTY, unresolved: reason });

function functionOfDeclaration(decl) {
  const kind = decl.getKind();
  if (kind === SyntaxKind.FunctionDeclaration || kind === SyntaxKind.MethodDeclaration || kind === SyntaxKind.Constructor) {
    const impl = decl.getImplementation?.() ?? decl;
    return impl.getBody?.() ? impl : null;
  }
  if (FN_KINDS.has(kind)) return decl;
  return null;
}

function isConstVariable(decl) {
  return decl.getVariableStatement?.()?.getDeclarationKind() === "const";
}

function isObjectLiteralMember(decl) {
  return decl.getParent()?.getKind() === SyntaxKind.ObjectLiteralExpression;
}

/** Every link of a member-access receiver names a value that cannot be rebound. */
function hasStableReceiver(expr) {
  const e = unwrap(expr);
  if (e.getKind() !== SyntaxKind.PropertyAccessExpression && e.getKind() !== SyntaxKind.ElementAccessExpression) {
    return true;
  }
  const receiver = unwrap(e.getExpression());
  if (!receiver) return false;
  if (receiver.getKind() === SyntaxKind.PropertyAccessExpression) return hasStableReceiver(receiver);
  if (receiver.getKind() !== SyntaxKind.Identifier) return false;
  const decls = receiver.getSymbol()?.getDeclarations() ?? [];
  if (decls.length !== 1) return false;
  const d = decls[0];
  switch (d.getKind()) {
    case SyntaxKind.ImportSpecifier:
    case SyntaxKind.ImportClause:
    case SyntaxKind.NamespaceImport:
      return true;
    case SyntaxKind.VariableDeclaration:
      return isConstVariable(d);
    default:
      return false;
  }
}

function merge(results) {
  const out = { fns: [], external: false, param: null, unresolved: null };
  for (const r of results) {
    out.fns.push(...r.fns);
    out.external ||= r.external;
    out.param ??= r.param;
    out.unresolved ??= r.unresolved;
  }
  return out;
}

const valueMemo = new Map();

/** What function(s) an expression evaluates to. */
// Expressions being resolved right now, across resolveCall/returnedValue
// re-entry. A re-entered one is a cycle (recursion, `const a = b; const b = a`)
// and names no function.
const resolving = new Set();

function resolveValue(expr, seen = resolving) {
  const e = unwrap(expr);
  if (!e) return unresolvedResult("empty expression");
  const memoHit = valueMemo.get(e);
  if (memoHit) return memoHit;
  if (resolving.has(e)) return unresolvedResult("cyclic definition");
  resolving.add(e);
  try {
    const result = resolveValueUncached(e, seen);
    valueMemo.set(e, result);
    return result;
  } finally {
    resolving.delete(e);
  }
}

function resolveValueUncached(e, seen) {
  const kind = e.getKind();
  if (LITERAL_FN_KINDS.has(kind)) return { ...EMPTY, fns: [e] };
  if (kind === SyntaxKind.ImportKeyword || kind === SyntaxKind.SuperKeyword) return { ...EMPTY, external: true };
  if (kind === SyntaxKind.AwaitExpression) return resolveValue(e.getExpression(), seen);
  if (kind === SyntaxKind.ConditionalExpression) {
    return merge([resolveValue(e.getWhenTrue(), seen), resolveValue(e.getWhenFalse(), seen)]);
  }
  if (kind === SyntaxKind.BinaryExpression) {
    const op = e.getOperatorToken().getKind();
    if (op === SyntaxKind.QuestionQuestionToken || op === SyntaxKind.BarBarToken) {
      return merge([resolveValue(e.getLeft(), seen), resolveValue(e.getRight(), seen)]);
    }
    if (op === SyntaxKind.AmpersandAmpersandToken) return resolveValue(e.getRight(), seen);
    return unresolvedResult("binary expression as a function value");
  }
  if (kind === SyntaxKind.CallExpression) {
    // The value of a call is what the callee returns: `const log = makeLogger()`.
    const callee = resolveCall(e);
    if (callee.unresolved || callee.param) {
      return unresolvedResult("function returned by a call this gate cannot follow");
    }
    if (callee.external && callee.fns.length === 0) {
      // A library cannot name these helpers, but a function it hands back may
      // be one of ours it was given — here (`debounce(fn)`) or anywhere
      // (`registry.set(k, fn)` … `registry.get(k)()`). Only a reviewed factory
      // that returns its own code is followed as library code.
      if (isPackageModuleLoad(e)) return { ...EMPTY, external: true };
      const factory = libraryFactoryOf(e);
      if (factory) {
        usedLibraryFactories.add(factory);
        return { ...EMPTY, external: true };
      }
      return unresolvedResult("function returned by a library call");
    }
    return merge(callee.fns.map((fn) => returnedValue(fn, seen)));
  }

  if (kind === SyntaxKind.ElementAccessExpression && literalKey(e.getArgumentExpression()) !== null) {
    if (!hasStableReceiver(e)) return unresolvedResult("member of an object that may be rebound");
    return resolvePropertyOfType(e.getExpression().getType(), literalKey(e.getArgumentExpression()), e, seen);
  }
  if (kind === SyntaxKind.ElementAccessExpression && literalKey(e.getArgumentExpression()) === null) {
    if (!hasStableReceiver(e)) return unresolvedResult("non-literal index into a value that may be rebound");
    const table = tableOf(e.getExpression());
    if (!table) return unresolvedResult("non-literal index into something other than a const object literal");
    const members = table.getProperties().map((p) => resolveMember(p, seen));
    return merge(members);
  }

  let symbol = e.getSymbol();
  if (!symbol) return unresolvedResult("callee has no symbol");
  if (symbol.isAlias()) symbol = symbol.getAliasedSymbol();
  const decls = symbol?.getDeclarations() ?? [];
  if (decls.length === 0) return unresolvedResult("callee has no declaration");
  if (decls.every(isExternal)) return { ...EMPTY, external: true };

  const results = [];
  for (const decl of decls) {
    if (isExternal(decl)) continue;
    results.push(resolveDeclaration(decl, e, seen));
  }
  return merge(results);
}

/** What a function returns, as a function value. */
function returnedValue(fn, seen) {
  const body = fn.getBody?.();
  if (!body) return unresolvedResult("function with no body");
  if (body.getKind() !== SyntaxKind.Block) return resolveValue(body, seen);
  const returns = body
    .getDescendantsOfKind(SyntaxKind.ReturnStatement)
    .filter((r) => r.getFirstAncestor((a) => FN_KINDS.has(a.getKind())) === fn && r.getExpression());
  if (returns.length === 0) return unresolvedResult("function returns no value");
  return merge(returns.map((r) => resolveValue(r.getExpression(), seen)));
}

/**
 * Every value a `let`/`var` can hold: its initializer and every plain
 * assignment to it in production code. An assignment from a parameter is that
 * function's production callers' argument; a setter only tests call adds
 * nothing.
 */
function resolveMutableVariable(decl, seen) {
  const results = [];
  if (decl.getInitializer()) results.push(resolveValue(decl.getInitializer(), seen));
  for (const ref of decl.getNameNode().findReferencesAsNodes()) {
    if (isNonProduction(ref) || isExternal(ref)) continue;
    const parent = ref.getParent();
    if (parent?.getKind() !== SyntaxKind.BinaryExpression || parent.getLeft() !== ref) continue;
    if (parent.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) {
      results.push(unresolvedResult("compound assignment to a function variable"));
      continue;
    }
    const rhs = resolveValue(parent.getRight(), seen);
    results.push(rhs.param ? resolveParameterFromCallers(rhs.param, seen) : rhs);
  }
  return results.length > 0 ? merge(results) : unresolvedResult("let/var with no value");
}

/** A parameter's value: the argument at its position in every production call. */
function resolveParameterFromCallers(param, seen) {
  const fn = param.getParent();
  const index = fn.getParameters?.().indexOf(param) ?? -1;
  const nameNode = fn.getNameNode?.() ?? fn.getParent()?.getNameNode?.();
  if (index < 0 || !nameNode) return unresolvedResult("parameter of an anonymous function");
  const results = [];
  for (const ref of nameNode.findReferencesAsNodes()) {
    if (isNonProduction(ref) || isExternal(ref)) continue;
    const call = ref.getParent();
    if (call?.getKind() !== SyntaxKind.CallExpression || call.getExpression() !== ref) {
      if (ref === nameNode) continue;
      if (call?.getKind() === SyntaxKind.ImportSpecifier || call?.getKind() === SyntaxKind.ExportSpecifier) continue;
      results.push(unresolvedResult("setter referenced other than by a direct call"));
      continue;
    }
    const arg = call.getArguments()[index];
    if (arg) results.push(resolveValue(arg, seen));
  }
  return merge(results);
}

/**
 * A member read off a value by its TYPE: the declarations of that property.
 * Used for a destructured binding, whose name node carries no symbol of its
 * own that the checker would follow to the source object.
 */
function resolvePropertyOfType(type, name, site, seen) {
  const prop = type.getProperty(name);
  if (!prop) return unresolvedResult(`no property ${name} on the destructured value`);
  const decls = prop.getDeclarations();
  if (decls.length === 0) return unresolvedResult(`property ${name} has no declaration`);
  if (decls.every(isExternal)) return { ...EMPTY, external: true };
  return merge(decls.filter((d) => !isExternal(d)).map((d) => resolveDeclaration(d, site, seen)));
}

function tableOf(receiverExpr) {
  let symbol = unwrap(receiverExpr)?.getSymbol();
  if (symbol?.isAlias()) symbol = symbol.getAliasedSymbol();
  const decl = symbol?.getDeclarations().find((d) => d.getKind() === SyntaxKind.VariableDeclaration);
  if (!decl || !isConstVariable(decl)) return null;
  const init = unwrap(decl.getInitializer());
  return init?.getKind() === SyntaxKind.ObjectLiteralExpression ? init : null;
}

function resolveMember(prop, seen) {
  switch (prop.getKind()) {
    case SyntaxKind.MethodDeclaration:
      return { ...EMPTY, fns: [prop] };
    case SyntaxKind.PropertyAssignment:
      return resolveValue(prop.getInitializer(), seen);
    case SyntaxKind.ShorthandPropertyAssignment: {
      const valueDecl = prop.getValueSymbol?.()?.getDeclarations()[0];
      return valueDecl ? resolveDeclaration(valueDecl, prop.getNameNode(), seen) : unresolvedResult("shorthand with no value");
    }
    case SyntaxKind.SpreadAssignment:
      return unresolvedResult("spread member of a table");
    default:
      return unresolvedResult(`table member ${prop.getKindName()}`);
  }
}

function resolveDeclaration(decl, site, seen) {
  const kind = decl.getKind();
  const fn = functionOfDeclaration(decl);
  if (fn) {
    if (isObjectLiteralMember(decl) && !hasStableReceiver(site)) {
      return unresolvedResult("member of an object that may be rebound");
    }
    return { ...EMPTY, fns: [fn] };
  }
  switch (kind) {
    case SyntaxKind.Parameter:
      return { ...EMPTY, param: decl };
    case SyntaxKind.VariableDeclaration:
      if (!isConstVariable(decl)) return resolveMutableVariable(decl, seen);
      if (!decl.getInitializer()) return unresolvedResult("const with no initializer");
      return resolveValue(decl.getInitializer(), seen);
    case SyntaxKind.PropertyAssignment:
      if (!hasStableReceiver(site)) return unresolvedResult("member of an object that may be rebound");
      return resolveValue(decl.getInitializer(), seen);
    case SyntaxKind.ShorthandPropertyAssignment: {
      if (!hasStableReceiver(site)) return unresolvedResult("member of an object that may be rebound");
      const valueDecl = decl.getValueSymbol?.()?.getDeclarations()[0];
      return valueDecl ? resolveDeclaration(valueDecl, decl.getNameNode(), seen) : unresolvedResult("shorthand with no value");
    }
    case SyntaxKind.ClassDeclaration: {
      const ctor = decl.getConstructors?.()[0];
      return { ...EMPTY, fns: ctor ? [ctor.getImplementation?.() ?? ctor] : [] };
    }
    case SyntaxKind.MethodSignature:
    case SyntaxKind.PropertySignature:
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.MethodDeclaration:
      return resolveImplementations(site);
    case SyntaxKind.BindingElement: {
      // Resolved by the destructured value's type: `const { fn } = opts` reads
      // `fn` off opts's declared shape, `const { createHash } = await
      // import("node:crypto")` off the module's.
      const pattern = decl.getParent();
      if (pattern?.getKind() !== SyntaxKind.ObjectBindingPattern) return unresolvedResult("function from an array pattern");
      const name = decl.getPropertyNameNode()?.getText() ?? decl.getName();
      let holder = pattern.getParent();
      if (holder?.getKind() === SyntaxKind.VariableDeclaration && !isConstVariable(holder)) {
        return unresolvedResult("function destructured into a let/var");
      }
      if (holder?.getKind() !== SyntaxKind.VariableDeclaration && holder?.getKind() !== SyntaxKind.Parameter) {
        return unresolvedResult("function destructured from a nested pattern");
      }
      if (holder.getKind() === SyntaxKind.VariableDeclaration && holder.getInitializer()) {
        const source = resolveValue(holder.getInitializer(), seen);
        // Destructured off a library value (`require("node:module")`): library
        // code, plus anything of ours that value was built from.
        if (source.external && !source.unresolved && !source.param) return source;
      }
      const sourceType =
        holder.getKind() === SyntaxKind.VariableDeclaration ? holder.getInitializer()?.getType() : holder.getType();
      if (!sourceType) return unresolvedResult("destructured const with no initializer");
      return resolvePropertyOfType(sourceType, name, decl.getNameNode(), seen);
    }
    default:
      return unresolvedResult(`callee declared as ${decl.getKindName()}`);
  }
}

/** The EXTERNAL_SHAPE_ALLOWLIST key for the interface declaring `nameNode`'s member, if listed. */
function externalShapeOf(nameNode) {
  for (const decl of nameNode.getSymbol()?.getDeclarations() ?? []) {
    const owner = decl.getParent();
    if (owner?.getKind() !== SyntaxKind.InterfaceDeclaration) continue;
    const key = `${toRelPosix(owner.getSourceFile().getFilePath())}::${owner.getName()}`;
    if (EXTERNAL_SHAPE_ALLOWLIST.has(key)) return key;
  }
  return null;
}

function memberName(e) {
  if (e.getKind() === SyntaxKind.PropertyAccessExpression) return e.getName();
  return e.getText();
}

function resolveObjectMember(literal, name) {
  if (literal.getProperties().some((p) => p.getKind() === SyntaxKind.SpreadAssignment)) {
    return unresolvedResult("object literal with a spread supplies the member");
  }
  const prop = literal.getProperty(name);
  return prop ? resolveMember(prop, resolving) : EMPTY;
}

/** An interface/class member with no body here: every implementation the language service finds. */
function resolveImplementations(site) {
  const e = unwrap(site);
  const nameNode =
    e.getKind() === SyntaxKind.PropertyAccessExpression ? e.getNameNode() : e.getKind() === SyntaxKind.Identifier ? e : null;
  if (!nameNode) return unresolvedResult("member with no body and no name to search");
  const impls = nameNode.getImplementations();
  if (impls.length === 0) {
    const shape = externalShapeOf(nameNode);
    if (shape) {
      usedExternalShapes.add(shape);
      return { ...EMPTY, external: true };
    }
    return unresolvedResult("member with no body and no implementation");
  }
  const results = [];
  for (const impl of impls) {
    const node = impl.getNode();
    // Supplied only by tests: production never passes one.
    if (isExternal(node) || isNonProduction(node)) continue;
    const parent = node.getParent();
    const fn = parent ? functionOfDeclaration(parent) : null;
    if (fn) {
      results.push({ ...EMPTY, fns: [fn] });
    } else if (parent?.getKind() === SyntaxKind.PropertyAssignment) {
      results.push(resolveValue(parent.getInitializer()));
    } else if (parent?.getKind() === SyntaxKind.ShorthandPropertyAssignment) {
      const valueDecl = parent.getValueSymbol?.()?.getDeclarations()[0];
      results.push(valueDecl ? resolveDeclaration(valueDecl, node, new Set()) : unresolvedResult("shorthand with no value"));
    } else if (node.getKind() === SyntaxKind.Identifier) {
      results.push(resolveValue(node));
    } else if (parent?.getKind() === SyntaxKind.ObjectLiteralExpression) {
      // A whole object literal implementing the type (`options = {}`): only the
      // member it actually spells supplies a value.
      results.push(resolveObjectMember(parent, memberName(e)));
    } else {
      results.push(unresolvedResult(`implementation ${node.getKindName()} under ${node.getParent()?.getKindName()} at ${toRelPosix(node.getSourceFile().getFilePath())}:${node.getStartLineNumber()}`));
    }
  }
  return merge(results);
}

const callMemo = new Map();

/** What a call or `new` invokes. */
function resolveCall(call) {
  let hit = callMemo.get(call);
  if (hit) return hit;
  let callee = unwrap(call.getExpression());
  if (
    call.getKind() === SyntaxKind.CallExpression &&
    callee?.getKind() === SyntaxKind.PropertyAccessExpression &&
    ["call", "apply"].includes(callee.getName())
  ) {
    const target = resolveValue(callee.getExpression());
    // A library `.call`/`.apply` on an own function is that function.
    hit = target.fns.length > 0 || target.unresolved || target.param ? target : resolveValue(callee);
  } else {
    hit = resolveValue(callee);
  }
  callMemo.set(call, hit);
  return hit;
}

// ─── Units and context calls ────────────────────────────────────────────────

const allCalls = [];
for (const sf of scanFiles) {
  allCalls.push(...sf.getDescendantsOfKind(SyntaxKind.CallExpression));
  allCalls.push(...sf.getDescendantsOfKind(SyntaxKind.NewExpression));
}

/** fn → Set of callback parameter indices, or "all" for the base helpers. */
const contextFns = new Map([...baseHelpers].map((fn) => [fn, "all"]));

function contextIndicesOf(call) {
  const indices = new Set();
  let all = false;
  for (const fn of resolveCall(call).fns) {
    const entry = contextFns.get(fn);
    if (entry === "all") all = true;
    else if (entry) for (const i of entry) indices.add(i);
  }
  if (all) return "all";
  return indices.size > 0 ? indices : null;
}

function isFunctionValued(arg) {
  const e = unwrap(arg);
  if (!e) return false;
  if (LITERAL_FN_KINDS.has(e.getKind())) return true;
  return e.getType().getCallSignatures().length > 0;
}

/** The arguments of a context call that run inside the context. */
function callbackArgsOf(call) {
  const indices = contextIndicesOf(call);
  if (!indices) return [];
  const args = call.getArguments();
  if (indices === "all") return args.filter(isFunctionValued);
  return [...indices].map((i) => args[i]).filter(Boolean);
}

/** The function a node's execution belongs to, climbing past inline literals of ordinary calls. */
function ownerOf(node) {
  for (let cur = node.getParent(); cur; cur = cur.getParent()) {
    if (!FN_KINDS.has(cur.getKind())) continue;
    const parent = cur.getParent();
    const isInlineArg =
      LITERAL_FN_KINDS.has(cur.getKind()) &&
      (parent?.getKind() === SyntaxKind.CallExpression || parent?.getKind() === SyntaxKind.NewExpression) &&
      parent.getArguments().includes(cur);
    if (isInlineArg && !callbackArgsOf(parent).includes(cur)) continue;
    return cur;
  }
  return null;
}

/** Arguments of `call` that hand a function on by reference (not a literal). */
function functionReferenceArgs(call) {
  return call.getArguments().filter((a) => {
    const e = unwrap(a);
    const k = e?.getKind();
    return (k === SyntaxKind.Identifier || k === SyntaxKind.PropertyAccessExpression || k === SyntaxKind.ElementAccessExpression) && isFunctionValued(e);
  });
}

// Wrapper fixpoint: a function whose parameter runs inside a context it opens.
function paramIndexOf(fn, paramDecl) {
  return fn.getParameters?.().indexOf(paramDecl) ?? -1;
}

let grew = true;
while (grew) {
  grew = false;
  for (const call of allCalls) {
    const callbacks = callbackArgsOf(call);
    if (callbacks.length === 0) continue;
    const wrapper = ownerOf(call);
    if (!wrapper) continue;
    const found = new Set();
    for (const cb of callbacks) {
      const r = resolveValue(cb);
      if (r.param) {
        const i = paramIndexOf(wrapper, r.param);
        if (i >= 0) found.add(i);
      }
      for (const lit of r.fns.filter((f) => LITERAL_FN_KINDS.has(f.getKind()) && f === unwrap(cb))) {
        for (const inner of [...lit.getDescendantsOfKind(SyntaxKind.CallExpression), ...lit.getDescendantsOfKind(SyntaxKind.NewExpression)]) {
          const ir = resolveCall(inner);
          const touched = [ir, ...functionReferenceArgs(inner).map((a) => resolveValue(a))];
          for (const t of touched) {
            if (!t.param) continue;
            const i = paramIndexOf(wrapper, t.param);
            if (i >= 0) found.add(i);
          }
        }
      }
    }
    if (found.size === 0) continue;
    const entry = contextFns.get(wrapper);
    if (entry === "all") continue;
    const set = entry ?? new Set();
    const before = set.size;
    for (const i of found) set.add(i);
    if (!entry || set.size !== before) {
      contextFns.set(wrapper, set);
      grew = true;
      callMemo.clear();
    }
  }
}

// ─── Opener fixpoint ────────────────────────────────────────────────────────

const OPENS = "opens";
const UNDECIDABLE = "undecidable";
/** fn → { status, why } */
const status = new Map([...contextFns.keys()].map((fn) => [fn, { status: OPENS, why: "opens an RLS context" }]));

const label = (fn) => {
  const rel = toRelPosix(fn.getSourceFile().getFilePath());
  const name = fn.getName?.() ?? fn.getParent()?.getName?.() ?? "<anonymous>";
  return `${name} (${rel}:${fn.getStartLineNumber()})`;
};

/** Every resolution a call contributes: its callee, and functions it is handed by reference. */
function touchedBy(call) {
  return [resolveCall(call), ...functionReferenceArgs(call).map((a) => resolveValue(a))];
}

const owners = new Map(allCalls.map((c) => [c, ownerOf(c)]));
let changed = true;
while (changed) {
  changed = false;
  for (const call of allCalls) {
    const owner = owners.get(call);
    if (!owner || status.get(owner)?.status === OPENS) continue;
    // A context callback's content belongs to the callback, but the callback
    // itself is not an opener of anything the context call's caller does: the
    // context call already makes that caller an opener.
    let next = null;
    for (const r of touchedBy(call)) {
      const opener = r.fns.find((f) => status.get(f)?.status === OPENS);
      if (opener) {
        next = { status: OPENS, why: `calls ${label(opener)} at ${toRelPosix(call.getSourceFile().getFilePath())}:${call.getStartLineNumber()}` };
        break;
      }
      if (!next && r.unresolved) {
        next = { status: UNDECIDABLE, why: `${r.unresolved} at ${toRelPosix(call.getSourceFile().getFilePath())}:${call.getStartLineNumber()}` };
      }
      const maybe = r.fns.find((f) => status.get(f)?.status === UNDECIDABLE);
      if (!next && maybe) next = { status: UNDECIDABLE, why: `calls ${label(maybe)}, which ${status.get(maybe).why}` };
    }
    if (!next) continue;
    const current = status.get(owner);
    if (current?.status === next.status) continue;
    if (current?.status === UNDECIDABLE && next.status !== OPENS) continue;
    status.set(owner, next);
    changed = true;
  }
}

// ─── Check every context callback ───────────────────────────────────────────

const violations = [];
const unfollowed = [];
const usedAllowlist = new Set();

function siteOf(node) {
  return `${toRelPosix(node.getSourceFile().getFilePath())}:${node.getStartLineNumber()}`;
}

function allowlisted(call, fn) {
  const name = fn.getName?.() ?? fn.getParent()?.getName?.();
  const key = `${toRelPosix(call.getSourceFile().getFilePath())}::${name}`;
  if (!CONDITIONAL_OPENER_ALLOWLIST.has(key)) return false;
  usedAllowlist.add(key);
  return true;
}

function judge(call, r, outer, how) {
  for (const fn of r.fns) {
    const s = status.get(fn);
    if (!s) continue;
    if (allowlisted(call, fn)) continue;
    if (s.status === OPENS) {
      violations.push({ site: siteOf(call), outer: siteOf(outer), how, what: `${label(fn)} ${s.why}` });
    } else {
      unfollowed.push({ site: siteOf(call), outer: siteOf(outer), reason: `${how} ${label(fn)}, which ${s.why}` });
    }
  }
  if (r.unresolved) unfollowed.push({ site: siteOf(call), outer: siteOf(outer), reason: `${how}: ${r.unresolved}` });
}

let callbackCount = 0;
let contextCallCount = 0;
for (const call of allCalls) {
  const callbacks = callbackArgsOf(call);
  if (callbacks.length === 0) continue;
  contextCallCount += 1;
  for (const cb of callbacks) {
    callbackCount += 1;
    const r = resolveValue(cb);
    const literal = r.fns.find((f) => f === unwrap(cb) && LITERAL_FN_KINDS.has(f.getKind()));
    if (!literal) {
      // A callback by reference: a parameter is the wrapper's caller's to
      // check; a named function is judged by what it is.
      if (r.param && r.fns.length === 0 && !r.unresolved) continue;
      judge(call, r, call, "callback is");
      continue;
    }
    for (const inner of allCalls) {
      if (owners.get(inner) !== literal) continue;
      judge(inner, resolveCall(inner), call, "calls");
      for (const arg of functionReferenceArgs(inner)) judge(inner, resolveValue(arg), call, "hands on");
    }
  }
}

const staleAllowlist = [
  ...[...CONDITIONAL_OPENER_ALLOWLIST.keys()].filter((k) => !usedAllowlist.has(k)),
  ...[...EXTERNAL_SHAPE_ALLOWLIST.keys()].filter((k) => !usedExternalShapes.has(k)),
].filter((k) => existsSync(k.split("::")[0]));
// Keyed by name, not file, so judged only on a tree that has a scan file at all.
const staleFactories = [...LIBRARY_FACTORY_ALLOWLIST.keys()].filter(
  (k) => !usedLibraryFactories.has(k) && existsSync(HELPER_FILE) && existsSync(EXTRA_SCAN_FILES[0]),
);

// ─── Report ─────────────────────────────────────────────────────────────────

let failed = false;
const dedupe = (rows, key) => [...new Map(rows.map((r) => [key(r), r])).values()];

if (violations.length > 0) {
  failed = true;
  console.error("An RLS context is opened from inside another one. At run time this throws");
  console.error("INVALID_RLS_NESTING, and a caller that swallows it silently skips the work.");
  console.error("Move the call outside the outer callback, or pass the outer `tx` down.");
  console.error("");
  for (const v of dedupe(violations, (v) => `${v.site}|${v.what}`)) {
    console.error(`  ${v.site}  (inside the context opened at ${v.outer}) ${v.how} ${v.what}`);
  }
}

if (unfollowed.length > 0) {
  failed = true;
  if (violations.length > 0) console.error("");
  console.error("A context callback reaches a call this gate cannot follow, so whether it");
  console.error("opens a nested RLS context is unknown. Make the callee resolvable (a function");
  console.error("with a body, held in a const or imported) or move it out of the callback:");
  console.error("");
  for (const u of dedupe(unfollowed, (u) => `${u.site}|${u.reason}`)) {
    console.error(`  ${u.site}  (inside the context opened at ${u.outer}) ${u.reason}`);
  }
}

if (staleAllowlist.length > 0) {
  failed = true;
  console.error("");
  console.error("An allowlist entry matches nothing (CONDITIONAL_OPENER_ALLOWLIST / EXTERNAL_SHAPE_ALLOWLIST). Remove it:");
  for (const k of staleAllowlist) console.error(`  ${k}`);
}

if (staleFactories.length > 0) {
  failed = true;
  console.error("");
  console.error("LIBRARY_FACTORY_ALLOWLIST has an entry no followed call uses. Remove it:");
  for (const k of staleFactories) console.error(`  ${k}`);
}

if (failed) process.exit(1);

const openerCount = [...status.values()].filter((s) => s.status === OPENS).length;
console.log(
  `check-rls-nesting: OK (${scanFiles.length} files, ${openerCount} openers, ` +
    `${contextFns.size} context functions, ${contextCallCount} context calls, ${callbackCount} callbacks checked)`,
);
