/**
 * Shared answer to "which function(s) can this expression or call be?" for the
 * Program-backed CI gates (check-rls-nesting, check-bypass-rls's cross-module
 * pass). Both gates used to carry their own copy, and the copies disagreed:
 * one counted interface implementations found in test files, the other did
 * not; neither saw subclass overrides; both believed a const table could not
 * gain members. One resolver, one set of rules.
 *
 * A result is { fns, external, params, unresolved }:
 *   - fns        own-code function bodies the value may be (a union — an
 *                interface member is every implementation, a const table every
 *                member, a class method every override);
 *   - external   library code may be the value (a declaration file or
 *                node_modules — it cannot import our helpers);
 *   - params     the value may be one of these parameters — `{ param,
 *                ownInvoker }`, every candidate, so `cond ? a : b` over two
 *                parameters keeps both (see classifyParameter for where each
 *                argument is checked);
 *   - unresolved a reason, when the value cannot be named. Callers fail closed.
 *
 * PRODUCTION is the scope the gates pass in: the import closure of src/ and
 * scripts/ minus tests and the CI tooling (lib/soundness.mjs productionScope),
 * or, without one, those path prefixes. Implementations, assignments and
 * callers found outside it never run in production and are ignored.
 *
 * A function is named by its DECLARATION — a member by its initializer, a
 * class member by every subclass's member of that name, an interface member by
 * every production member of that name. That is sound only within the subset
 * lib/soundness.mjs enforces (G1-G5); the gates check it on every run.
 */
import { SyntaxKind, ts } from "ts-morph";
import { relative, sep } from "node:path";

export const FN_KINDS = new Set([
  SyntaxKind.ArrowFunction,
  SyntaxKind.FunctionExpression,
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.Constructor,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
]);
export const LITERAL_FN_KINDS = new Set([SyntaxKind.ArrowFunction, SyntaxKind.FunctionExpression]);

const PRODUCTION_ROOTS = ["src/", "scripts/"];
// Under a production root but not production: the gates themselves, their
// fixtures and tests, the hand-run manual test scripts, and the dev/CI tooling
// at scripts/ top level. A script not listed here is production — a new one
// is judged by both gates until someone says otherwise.
const NON_PRODUCTION_PREFIXES = ["scripts/checks/", "scripts/__tests__/", "scripts/__fixtures__/", "scripts/manual-tests/"];
export const NON_PRODUCTION_SCRIPTS = [
  "scripts/check-env-docs.ts",
  "scripts/check-state-mutation-centralization.ts",
  "scripts/env-allowlist.ts",
  "scripts/env-descriptions.ts",
  "scripts/generate-env-example.ts",
  "scripts/generate-security-matrices.ts",
  "scripts/generate-team-key-fixture.ts",
  "scripts/init-env.ts",
  "scripts/regenerate-account-token-legacy-fixture.ts",
];

export function toRelPosix(absPath) {
  return relative(process.cwd(), absPath).split(sep).join("/");
}

/**
 * A cwd-relative path explicitly declared non-production: tests, the CI
 * tooling, the manual-test scripts. (A file merely outside src/ and scripts/ —
 * a root `sentry.server.config.ts` — is neither scanned nor declared.)
 */
export function isDeclaredNonProduction(rel) {
  if (NON_PRODUCTION_PREFIXES.some((prefix) => rel.startsWith(prefix))) return true;
  if (NON_PRODUCTION_SCRIPTS.includes(rel)) return true;
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel) || rel.includes("__tests__/");
}

/** A cwd-relative path that is production TypeScript. */
export function isProductionPath(rel) {
  if (!PRODUCTION_ROOTS.some((root) => rel.startsWith(root))) return false;
  if (NON_PRODUCTION_PREFIXES.some((prefix) => rel.startsWith(prefix))) return false;
  if (NON_PRODUCTION_SCRIPTS.includes(rel)) return false;
  if (!/\.tsx?$/.test(rel) || rel.endsWith(".d.ts")) return false;
  return !/\.(test|spec)\.tsx?$/.test(rel) && !rel.includes("__tests__");
}

/**
 * Whether a reference entry (from findReferences) writes the binding. The
 * language service also marks `{ x }` in an object literal as a write — it
 * writes the new object's member, and only reads `x` — unless that literal is
 * itself an assignment target (`({ x } = o)`).
 */
export function isBindingWrite(entry) {
  if (!entry.isWriteAccess()) return false;
  const parent = entry.getNode().getParent();
  if (parent?.getKind() !== SyntaxKind.ShorthandPropertyAssignment) return true;
  let literal = parent.getParent();
  while (literal?.getParent()?.getKind() === SyntaxKind.ObjectLiteralExpression ||
    literal?.getParent()?.getKind() === SyntaxKind.PropertyAssignment ||
    literal?.getParent()?.getKind() === SyntaxKind.ArrayLiteralExpression) {
    literal = literal.getParent();
  }
  const holder = literal?.getParent();
  return (
    (holder?.getKind() === SyntaxKind.BinaryExpression && holder.getLeft() === literal) ||
    holder?.getKind() === SyntaxKind.ForOfStatement || holder?.getKind() === SyntaxKind.ForInStatement
  );
}

export function unwrap(expr) {
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

export function literalKey(expr) {
  const e = unwrap(expr);
  if (!e) return null;
  if (e.getKind() === SyntaxKind.StringLiteral || e.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral) {
    return e.getLiteralText();
  }
  return null;
}

/**
 * Interfaces declared in our code to type a value a LIBRARY produces, so no
 * code of ours implements them. A call through one of their members runs
 * library code. Keyed "file::Interface".
 */
export const EXTERNAL_SHAPE_ALLOWLIST = new Map([
  // The cloud key providers' SDK clients, loaded lazily with require() so each
  // SDK package stays optional.
  ["src/lib/key-provider/aws-sm-provider.ts::SmClient", "@aws-sdk/client-secrets-manager"],
  ["src/lib/key-provider/aws-sm-provider.ts::AwsSmModule", "@aws-sdk/client-secrets-manager"],
  ["src/lib/key-provider/azure-kv-provider.ts::KvSecretClient", "@azure/keyvault-secrets"],
  ["src/lib/key-provider/azure-kv-provider.ts::AzureKvModule", "@azure/keyvault-secrets"],
  ["src/lib/key-provider/azure-kv-provider.ts::AzureIdentityModule", "@azure/identity"],
  ["src/lib/key-provider/gcp-sm-provider.ts::SmClient", "@google-cloud/secret-manager"],
  ["src/lib/key-provider/gcp-sm-provider.ts::GcpSmModule", "@google-cloud/secret-manager"],
  // The Prisma transaction client, narrowed to the one raw-query method the
  // readback assertion uses.
  ["scripts/lib/assert-bypass-rls-active.ts::TxProbe", "Prisma transaction client"],
]);

const EMPTY = Object.freeze({ fns: Object.freeze([]), external: false, params: Object.freeze([]), unresolved: null });
const NON_FUNCTION_KINDS = new Set([
  SyntaxKind.NullKeyword, SyntaxKind.TrueKeyword, SyntaxKind.FalseKeyword, SyntaxKind.NumericLiteral,
  SyntaxKind.BigIntLiteral, SyntaxKind.StringLiteral, SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.TemplateExpression, SyntaxKind.RegularExpressionLiteral, SyntaxKind.VoidExpression,
]);
const unresolvedResult = (reason) => ({ ...EMPTY, unresolved: reason });
// A value taken from a library module by `require`/`import()`: library code,
// even where `require` erased its type to `any`.
const LIBRARY_MODULE = Object.freeze({ ...EMPTY, external: true, libraryModule: true });

export function merge(results) {
  const out = { fns: [], external: false, params: [], unresolved: null };
  // Library code known by the module it was loaded from, though typed `any`:
  // kept only while every library part of the union is.
  const libraryParts = results.filter((r) => r.external);
  if (libraryParts.length > 0 && libraryParts.every((r) => r.libraryModule)) out.libraryModule = true;
  for (const r of results) {
    for (const fn of r.fns) if (!out.fns.includes(fn)) out.fns.push(fn);
    out.external ||= r.external;
    for (const p of r.params) if (!out.params.some((q) => q.param === p.param)) out.params.push(p);
    out.unresolved ??= r.unresolved;
  }
  return out;
}

/** The Prisma client's model accessor names: the client type's members that are not `$` API. */
export function prismaModelNames(clientType) {
  return new Set((clientType?.getProperties() ?? []).map((p) => p.getName()).filter((n) => !n.startsWith("$")));
}

export function createFunctionResolver({ program, scope = null }) {
  const usedExternalShapes = new Set();
  const valueMemo = new Map();
  const callMemo = new Map();
  // Expressions being resolved right now. A re-entered one is a cycle
  // (recursion, `const a = b; const b = a`) and names no function.
  const resolving = new Set();

  function isExternal(node) {
    const sf = node.getSourceFile();
    return sf.isDeclarationFile() || sf.getFilePath().includes("/node_modules/");
  }

  /** Own code outside PRODUCTION — tests and fixtures, which never run there. */
  function isNonProduction(node) {
    if (isExternal(node)) return false;
    return scope ? !scope.isProduction(node) : !isProductionPath(toRelPosix(node.getSourceFile().getFilePath()));
  }

  function isConstVariable(decl) {
    return decl.getVariableStatement?.()?.getDeclarationKind() === "const";
  }

  function isObjectLiteralMember(decl) {
    return decl.getParent()?.getKind() === SyntaxKind.ObjectLiteralExpression;
  }

  function isClassMember(decl) {
    const k = decl.getParent()?.getKind();
    return k === SyntaxKind.ClassDeclaration || k === SyntaxKind.ClassExpression;
  }

  /** Every link of a member-access receiver names a value that cannot be rebound. */
  function hasStableReceiver(expr) {
    const e = unwrap(expr);
    if (e.getKind() !== SyntaxKind.PropertyAccessExpression && e.getKind() !== SyntaxKind.ElementAccessExpression) {
      return true;
    }
    const receiver = unwrap(e.getExpression());
    if (!receiver) return false;
    if (receiver.getKind() === SyntaxKind.ThisKeyword) return true;
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

  function functionOfDeclaration(decl) {
    const kind = decl.getKind();
    if (kind === SyntaxKind.FunctionDeclaration || kind === SyntaxKind.MethodDeclaration || kind === SyntaxKind.Constructor) {
      const impl = decl.getImplementation?.() ?? decl;
      return impl.getBody?.() ? impl : null;
    }
    if (FN_KINDS.has(kind)) return decl;
    return null;
  }

  /**
   * Whether a type NODE, as a library DECLARES it (before instantiation), can
   * only be a value the library itself makes. A reference to one of the
   * declaration's type parameters (`V` in `Map.get(): V | undefined`, `T` in
   * `forEach((value: T) => …)`) is whatever the caller put in — possibly one of
   * our functions — so it is not. A function type (`resolve: (value: T) =>
   * void`) or a concrete library type (`NodeRequire`) is.
   */
  function isLibraryMadeTypeNode(typeNode) {
    if (!typeNode) return false;
    const node = typeNode.getKind() === SyntaxKind.ParenthesizedType ? typeNode.getTypeNode() : typeNode;
    if (node.getKind() === SyntaxKind.UnionType || node.getKind() === SyntaxKind.IntersectionType) {
      return node.getTypeNodes().every(isLibraryMadeTypeNode);
    }
    if (node.getKind() === SyntaxKind.FunctionType || node.getKind() === SyntaxKind.ConstructorType) return true;
    if (node.getKind() === SyntaxKind.TypeReference) {
      const decl = node.getTypeName().getSymbol()?.getDeclarations()[0];
      if (!decl) return false;
      if (decl.getKind() === SyntaxKind.TypeParameter) return false;
      const name = node.getTypeName().getText();
      if (name === "Function" || name === "CallableFunction") return false;
      // `OmitThisParameter<T>`, `NonNullable<V>`: built from what the caller put in.
      return node.getTypeArguments().every((arg) => !mentionsTypeParameter(arg));
    }
    if (node.getKind() === SyntaxKind.AnyKeyword || node.getKind() === SyntaxKind.UnknownKeyword) return false;
    // Any other shape (`P extends keyof T ? T[P] : any`, `T[K]`, a mapped
    // type) is library-made only when nothing of the caller's flows into it.
    return !mentionsTypeParameter(node);
  }

  function mentionsTypeParameter(typeNode) {
    const refs = [typeNode, ...typeNode.getDescendantsOfKind(SyntaxKind.TypeReference)].filter(
      (n) => n.getKind() === SyntaxKind.TypeReference,
    );
    return refs.some((r) => r.getTypeName().getSymbol()?.getDeclarations()[0]?.getKind() === SyntaxKind.TypeParameter);
  }

  /** The declaration a library call resolves to, before instantiation, or null. */
  function librarySignatureDeclarationOf(call) {
    const sig = program.getTypeChecker().getResolvedSignature(call);
    const decl = sig?.getDeclaration();
    return decl && isExternal(decl) ? decl : null;
  }

  /**
   * The value a library CALL returns, judged on its declared return type: a
   * library-made value, or (a type parameter) possibly one of ours.
   */
  function libraryReturnIsLibraryMade(call) {
    const decl = librarySignatureDeclarationOf(call);
    const node = decl?.getReturnTypeNode?.();
    return node ? isLibraryMadeTypeNode(node) : false;
  }

  /**
   * The value a library passes to parameter `paramIndex` of the callback given
   * as argument `argIndex`, judged on the library's declared callback type.
   */
  function libraryCallbackParamIsLibraryMade(call, argIndex, paramIndex) {
    const decl = librarySignatureDeclarationOf(call);
    if (!decl) return false;
    const params = decl.getParameters?.() ?? [];
    const p = params[Math.min(argIndex, params.length - 1)];
    if (!p || (argIndex >= params.length && !p.getDotDotDotToken())) return false;
    let cbType = p.getTypeNode();
    if (cbType?.getKind() === SyntaxKind.ParenthesizedType) cbType = cbType.getTypeNode();
    if (cbType?.getKind() !== SyntaxKind.FunctionType) return false;
    return isLibraryMadeTypeNode(cbType.getParameters()[paramIndex]?.getTypeNode());
  }

  /**
   * A member a library declares, read as a function. Library code — unless
   * its declared type is whatever the library's user stored there
   * (`RefObject<T>.current: T`, a property typed `any`), which may be ours.
   */
  function libraryMemberValue(decls) {
    const holdsUsersValue = decls.some((d) => {
      const k = d.getKind();
      if (k !== SyntaxKind.PropertySignature && k !== SyntaxKind.PropertyDeclaration) return false;
      return !isLibraryMadeTypeNode(d.getTypeNode?.());
    });
    return holdsUsersValue
      ? unresolvedResult("function held in a library member typed by what its user stored")
      : { ...EMPTY, external: true };
  }

  function resolveValue(expr) {
    const e = unwrap(expr);
    if (!e) return unresolvedResult("empty expression");
    const memoHit = valueMemo.get(e);
    if (memoHit) return memoHit;
    if (resolving.has(e)) return unresolvedResult("cyclic definition");
    resolving.add(e);
    try {
      const result = resolveValueUncached(e);
      valueMemo.set(e, result);
      return result;
    } finally {
      resolving.delete(e);
    }
  }

  /** Own functions handed to a call as arguments, literal or by reference. */
  function functionArgsOf(call) {
    const out = [];
    for (const a of call.getArguments()) {
      const e = unwrap(a);
      const k = e?.getKind();
      if (LITERAL_FN_KINDS.has(k)) out.push({ ...EMPTY, fns: [e] });
      else if (k === SyntaxKind.Identifier || k === SyntaxKind.PropertyAccessExpression) {
        if (mayBeCallable(e.getType())) out.push(resolveValue(e));
      }
    }
    return out;
  }

  function resolveValueUncached(e) {
    const kind = e.getKind();
    if (LITERAL_FN_KINDS.has(kind)) return { ...EMPTY, fns: [e] };
    // Values that cannot be functions: an initial `null`, a literal.
    if (NON_FUNCTION_KINDS.has(kind) || (kind === SyntaxKind.Identifier && e.getText() === "undefined")) return { ...EMPTY };
    if (kind === SyntaxKind.ImportKeyword) return { ...EMPTY, external: true };
    if (kind === SyntaxKind.SuperKeyword) {
      // `super(...)`: the base class's construction.
      const cls = e.getFirstAncestor((a) => a.getKind() === SyntaxKind.ClassDeclaration || a.getKind() === SyntaxKind.ClassExpression);
      const base = cls?.getExtends?.()?.getExpression();
      return base ? resolveValue(base) : { ...EMPTY };
    }
    if (kind === SyntaxKind.AwaitExpression) return resolveValue(e.getExpression());
    if (kind === SyntaxKind.ConditionalExpression) {
      return merge([resolveValue(e.getWhenTrue()), resolveValue(e.getWhenFalse())]);
    }
    if (kind === SyntaxKind.BinaryExpression) {
      const op = e.getOperatorToken().getKind();
      if (op === SyntaxKind.QuestionQuestionToken || op === SyntaxKind.BarBarToken) {
        return merge([resolveValue(e.getLeft()), resolveValue(e.getRight())]);
      }
      if (op === SyntaxKind.AmpersandAmpersandToken) return resolveValue(e.getRight());
      return unresolvedResult("binary expression as a function value");
    }
    if (kind === SyntaxKind.CallExpression) {
      // `fn.bind(...)` is `fn` with its arguments fixed.
      const calleeExpr = unwrap(e.getExpression());
      if (calleeExpr?.getKind() === SyntaxKind.PropertyAccessExpression && calleeExpr.getName() === "bind") {
        const target = resolveValue(calleeExpr.getExpression());
        // Binding a library method (`WeakMap.prototype.get.bind(m)`) is library code.
        return target.fns.length > 0 || target.unresolved || target.params.length > 0 ? target : { ...EMPTY, external: true };
      }
      // The value of a call is what the callee returns: `const log = makeLogger()`.
      const callee = resolveCall(e);
      if (callee.unresolved || callee.params.length > 0) {
        return unresolvedResult("function returned by a call this gate cannot follow");
      }
      if (callee.external && callee.fns.length === 0) {
        // A library hands back library code, or one of ours: given here
        // (`debounce(fn)`), or stored earlier and returned through a type
        // parameter (`registry.get(k)` declared `V | undefined`), which cannot
        // be named. Judged on the declared return type, not the instantiated one.
        // A library value invoked as a function (`Reflect.get(o, "f")()`) or
        // callable after removing undefined (`registry.get(k)?.()`).
        // A value is resolved only where it is used as a function, so an
        // `any`/`unknown` result here may be one.
        const t = e.getType();
        const returnsFunction = mayBeCallable(t) || t.isAny() || t.isUnknown();
        if (returnsFunction && !callee.libraryModule && !libraryReturnIsLibraryMade(e)) {
          return unresolvedResult("function returned by a library call");
        }
        return merge([callee.libraryModule ? LIBRARY_MODULE : { ...EMPTY, external: true }, ...functionArgsOf(e)]);
      }
      return merge(callee.fns.map((fn) => returnedValue(fn)));
    }

    if (kind === SyntaxKind.ElementAccessExpression && literalKey(e.getArgumentExpression()) !== null) {
      const key = literalKey(e.getArgumentExpression());
      const decls = e.getExpression().getType().getProperty(key)?.getDeclarations() ?? [];
      // A member a library declares (`tx["$transaction"]`) is library code
      // whatever holds the receiver; only an own member needs a stable one.
      if (decls.length > 0 && decls.every(isExternal)) return libraryMemberValue(decls);
      if (!hasStableReceiver(e)) return unresolvedResult("member of an object that may be rebound");
      return resolvePropertyOfType(e.getExpression().getType(), key, e);
    }
    if (kind === SyntaxKind.ElementAccessExpression) {
      if (!hasStableReceiver(e)) return unresolvedResult("non-literal index into a value that may be rebound");
      const table = tableOf(e.getExpression());
      if (typeof table === "string") return unresolvedResult(table);
      return merge(table.getProperties().map((p) => resolveMember(p)));
    }

    let symbol = e.getSymbol();
    if (!symbol) return unresolvedResult("callee has no symbol");
    if (symbol.isAlias()) symbol = symbol.getAliasedSymbol();
    const decls = symbol?.getDeclarations() ?? [];
    if (decls.length === 0) return unresolvedResult("callee has no declaration");
    if (decls.every(isExternal)) return libraryMemberValue(decls);
    return merge(decls.filter((d) => !isExternal(d)).map((d) => resolveDeclaration(d, e)));
  }

  /** What a function returns, as a function value. */
  function returnedValue(fn) {
    const body = fn.getBody?.();
    if (!body) return unresolvedResult("function with no body");
    if (body.getKind() !== SyntaxKind.Block) return resolveValue(body);
    const returns = body
      .getDescendantsOfKind(SyntaxKind.ReturnStatement)
      .filter((r) => r.getFirstAncestor((a) => FN_KINDS.has(a.getKind())) === fn && r.getExpression());
    if (returns.length === 0) return unresolvedResult("function returns no value");
    return merge(returns.map((r) => resolveValue(r.getExpression())));
  }

  /**
   * Every value a `let`/`var` can hold: its initializer and every plain
   * assignment to it in production code. An assignment from a parameter is
   * that function's production callers' argument; a setter only tests call
   * adds nothing.
   */
  function resolveMutableVariable(decl) {
    const results = [];
    if (decl.getInitializer()) results.push(resolveValue(decl.getInitializer()));
    results.push(...writesTo(decl.getNameNode(), (node) => {
      const parent = node.getParent();
      return parent?.getKind() === SyntaxKind.BinaryExpression && parent.getLeft() === node ? parent : null;
    }));
    return results.length > 0 ? merge(results) : unresolvedResult("let/var with no value");
  }

  /**
   * Every production WRITE to the symbol `nameNode` declares, as the language
   * service classifies it (isWriteAccess) — not by spelling. A plain `=` whose
   * left side `assignmentOf` recognises contributes its right-hand side; any
   * other write (`||=`, a destructuring target, `++`, a `for…of` binding)
   * cannot be named and is unresolved.
   */
  function writesTo(nameNode, assignmentOf) {
    const out = [];
    for (const group of nameNode.findReferences()) {
      for (const entry of group.getReferences()) {
        if (!isBindingWrite(entry)) continue;
        const node = entry.getNode();
        if (node === nameNode || isNonProduction(node) || isExternal(node)) continue;
        if (entry.isInString?.()) continue;
        // A DECLARATION (a function, a variable, a member of another object
        // literal of the same shape) initialises a binding or a different
        // object; it is not a later write to this one.
        if (node.getParent()?.getNameNode?.() === node && node.getParent().getKind() !== SyntaxKind.PropertyAccessExpression) {
          continue;
        }
        const assignment = assignmentOf(node);
        if (!assignment || assignment.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) {
          out.push(unresolvedResult(`write other than a plain assignment at ${toRelPosix(node.getSourceFile().getFilePath())}:${node.getStartLineNumber()}`));
          continue;
        }
        const rhs = resolveValue(assignment.getRight());
        out.push(merge([{ ...rhs, params: [] }, ...rhs.params.map((p) => resolveParameterFromCallers(p.param))]));
      }
    }
    return out;
  }

  /** A parameter's value: the argument at its position in every production call. */
  function resolveParameterFromCallers(param) {
    const fn = param.getParent();
    const index = fn.getParameters?.().indexOf(param) ?? -1;
    const nameNode = fn.getNameNode?.() ?? fn.getParent()?.getNameNode?.();
    if (index < 0 || !nameNode) return unresolvedResult("parameter of an anonymous function");
    if (param.getDotDotDotToken()) return unresolvedResult("rest parameter");
    const results = [];
    for (const ref of nameNode.findReferencesAsNodes()) {
      if (isNonProduction(ref) || isExternal(ref)) continue;
      const call = ref.getParent();
      if (call?.getKind() !== SyntaxKind.CallExpression || call.getExpression() !== ref) {
        if (ref === nameNode) continue;
        const k = call?.getKind();
        if (k === SyntaxKind.ImportSpecifier || k === SyntaxKind.ExportSpecifier || k === SyntaxKind.ImportClause) continue;
        results.push(unresolvedResult("function referenced other than by a direct call, so its arguments are unknown"));
        continue;
      }
      const args = call.getArguments();
      if (args.slice(0, index + 1).some((a) => a.getKind() === SyntaxKind.SpreadElement)) {
        results.push(unresolvedResult("spread argument at the parameter's position"));
        continue;
      }
      if (args[index]) results.push(resolveValue(args[index]));
    }
    return merge(results);
  }

  /**
   * Where a called parameter's value comes from, judged from the call site:
   *   - a parameter of a function literal handed to a call: whoever invokes the
   *     literal supplies it. A library-typed signature (Promise's `resolve`) is
   *     library code; anything else cannot be named.
   *   - a parameter of the function the call sits in: the caller's argument,
   *     which is checked where it is passed — returned as `param`.
   *   - a parameter captured by a closure that outlives the call (`const run =
   *     make(fn)`, then `run()`): every production caller's argument.
   */
  function classifyParameter(param, site) {
    const owner = param.getParent();
    const holder = owner.getParent();
    const isInlineArg =
      LITERAL_FN_KINDS.has(owner.getKind()) &&
      (holder?.getKind() === SyntaxKind.CallExpression || holder?.getKind() === SyntaxKind.NewExpression) &&
      holder.getArguments().includes(owner);
    if (isInlineArg) {
      const invoker = resolveCall(holder);
      const argIndex = holder.getArguments().indexOf(owner);
      const paramIndex = owner.getParameters().indexOf(param);
      if (invoker.fns.length > 0 && !invoker.external && !invoker.unresolved) {
        // Our own function invokes the literal. Whatever it passes is a value
        // in the invoker's body, which this call reaches: that value is an
        // edge there, so nothing is added here.
        return { ...EMPTY };
      }
      return invoker.external && !invoker.unresolved && libraryCallbackParamIsLibraryMade(holder, argIndex, paramIndex)
        ? { ...EMPTY, external: true }
        : unresolvedResult("function supplied to a callback's parameter");
    }
    if (directOwnerOf(site) === owner) return { ...EMPTY, params: [{ param, ownInvoker: false }] };
    return resolveParameterFromCallers(param);
  }

  /** The function a node runs in, climbing past function literals passed inline to calls. */
  function directOwnerOf(node) {
    for (let cur = node.getParent(); cur; cur = cur.getParent()) {
      if (!FN_KINDS.has(cur.getKind())) continue;
      const parent = cur.getParent();
      const isInlineArg =
        LITERAL_FN_KINDS.has(cur.getKind()) &&
        (parent?.getKind() === SyntaxKind.CallExpression || parent?.getKind() === SyntaxKind.NewExpression) &&
        parent.getArguments().includes(cur);
      if (isInlineArg) continue;
      return cur;
    }
    return null;
  }

  /**
   * A member read off a value by its TYPE: the declarations of that property.
   * Used for a destructured binding and a literal-key index, whose node
   * carries no symbol the checker would follow to the source object.
   */
  function resolvePropertyOfType(type, name, site) {
    const prop = type.getProperty(name);
    if (!prop) return unresolvedResult(`no property ${name} on the value`);
    const decls = prop.getDeclarations();
    if (decls.length === 0) return unresolvedResult(`property ${name} has no declaration`);
    if (decls.every(isExternal)) return libraryMemberValue(decls);
    return merge(decls.filter((d) => !isExternal(d)).map((d) => resolveDeclaration(d, site)));
  }

  /**
   * The const object literal a non-literal index reads, or the reason it
   * cannot be one. Its members hold only what the literal spells: the
   * soundness rules (G1-G3) refuse every other way to put a function in it.
   */
  function tableOf(receiverExpr) {
    let symbol = unwrap(receiverExpr)?.getSymbol();
    if (symbol?.isAlias()) symbol = symbol.getAliasedSymbol();
    const decl = symbol?.getDeclarations().find((d) => d.getKind() === SyntaxKind.VariableDeclaration);
    if (!decl || !isConstVariable(decl)) return "non-literal index into something other than a const object literal";
    const init = unwrap(decl.getInitializer());
    if (init?.getKind() !== SyntaxKind.ObjectLiteralExpression) {
      return "non-literal index into something other than a const object literal";
    }
    return init;
  }

  function resolveMember(prop) {
    switch (prop.getKind()) {
      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.GetAccessor:
        return { ...EMPTY, fns: [prop] };
      case SyntaxKind.PropertyAssignment:
        return resolveValue(prop.getInitializer());
      case SyntaxKind.ShorthandPropertyAssignment: {
        const valueDecl = prop.getValueSymbol?.()?.getDeclarations()[0];
        return valueDecl ? resolveDeclaration(valueDecl, prop.getNameNode()) : unresolvedResult("shorthand with no value");
      }
      case SyntaxKind.SpreadAssignment:
        return unresolvedResult("spread member of a table");
      default:
        return unresolvedResult(`table member ${prop.getKindName()}`);
    }
  }

  /**
   * Every production class deriving from `cls`, transitively. Derivation is
   * by name only (G5 refuses class expressions and computed bases), so the
   * language service's references to the class name find them all.
   */
  const derivedMemo = new Map();
  function derivedClassesOf(cls) {
    let out = derivedMemo.get(cls);
    if (out) return out;
    out = [];
    const queue = [cls];
    while (queue.length > 0) {
      const c = queue.shift();
      for (const d of c.getDerivedClasses?.() ?? []) {
        if (isExternal(d) || isNonProduction(d) || out.includes(d)) continue;
        out.push(d);
        queue.push(d);
      }
    }
    derivedMemo.set(cls, out);
    return out;
  }

  /**
   * What a class member `name` may run: the member itself and every member of
   * that name a production subclass declares, method or field alike.
   */
  function classMemberValue(member) {
    const cls = member.getParent();
    const name = member.getName?.();
    const results = [ownClassMemberValue(member)];
    if (name && cls?.getKind() === SyntaxKind.ClassDeclaration) {
      for (const d of derivedClassesOf(cls)) {
        for (const m of d.getMembers()) {
          if (m.getName?.() === name && !m.isStatic?.()) results.push(ownClassMemberValue(m));
        }
      }
    }
    return merge(results);
  }

  function ownClassMemberValue(member) {
    const fn = functionOfDeclaration(member);
    if (fn) return { ...EMPTY, fns: [fn] };
    if (member.getKind() === SyntaxKind.PropertyDeclaration) {
      // A field holds its initializer; G1 refuses every other write.
      return member.getInitializer() ? resolveValue(member.getInitializer()) : { ...EMPTY };
    }
    if (member.getKind() === SyntaxKind.MethodDeclaration) return { ...EMPTY }; // abstract or an overload
    return unresolvedResult(`class member ${member.getKindName()}`);
  }

  function unwrapAwait(expr) {
    let e = unwrap(expr);
    while (e?.getKind() === SyntaxKind.AwaitExpression) e = unwrap(e.getExpression());
    return e;
  }

  /**
   * The module an `import("…")` / `require("…")` call loads: { library: true },
   * { sf } for an own module, or null when the call is not a module load. A
   * non-literal or unresolvable own specifier is a module nobody can name.
   */
  function moduleLoadedBy(call) {
    if (call?.getKind() !== SyntaxKind.CallExpression) return null;
    const callee = unwrap(call.getExpression());
    const isLoad =
      callee?.getKind() === SyntaxKind.ImportKeyword ||
      (callee?.getKind() === SyntaxKind.Identifier && callee.getText() === "require" && callee.getSymbol()?.getDeclarations().every(isExternal));
    if (!isLoad) return null;
    const spec = literalKey(call.getArguments()[0]);
    if (spec === null) return { sf: null };
    const resolved = ts.resolveModuleName(spec, call.getSourceFile().getFilePath(), program.getCompilerOptions(), ts.sys).resolvedModule;
    if (!resolved) return spec.startsWith(".") || spec.startsWith("@/") ? { sf: null } : { library: true };
    if (resolved.isExternalLibraryImport || resolved.resolvedFileName.includes("/node_modules/")) return { library: true };
    return { sf: program.getSourceFile(resolved.resolvedFileName) ?? null };
  }

  function resolveExport(sf, name, site) {
    if (!sf) return unresolvedResult("function from a module this gate cannot resolve");
    const decls = sf.getExportedDeclarations().get(name) ?? [];
    if (decls.length === 0) return unresolvedResult(`module ${toRelPosix(sf.getFilePath())} exports no ${name}`);
    return merge(decls.map((d) => (isExternal(d) ? libraryMemberValue([d]) : resolveDeclaration(d, site))));
  }

  function resolveDeclaration(decl, site) {
    const kind = decl.getKind();
    const fn = functionOfDeclaration(decl);
    if (fn) {
      if (isObjectLiteralMember(decl) && !hasStableReceiver(site)) {
        return unresolvedResult("member of an object that may be rebound");
      }
      if (isObjectLiteralMember(decl)) return { ...EMPTY, fns: [fn] };
      if (kind === SyntaxKind.MethodDeclaration && isClassMember(decl)) return classMemberValue(decl);
      return { ...EMPTY, fns: [fn] };
    }
    switch (kind) {
      case SyntaxKind.ImportSpecifier:
      case SyntaxKind.ExportSpecifier:
      case SyntaxKind.ImportClause: {
        // A specifier the first alias step stopped on (a re-export chain).
        const target = decl.getSymbol()?.getAliasedSymbol();
        const next = (target?.getDeclarations() ?? []).filter((d) => d !== decl);
        if (next.length === 0) return unresolvedResult("import with no resolvable declaration");
        if (next.every(isExternal)) return { ...EMPTY, external: true };
        return merge(next.filter((d) => !isExternal(d)).map((d) => resolveDeclaration(d, site)));
      }
      case SyntaxKind.Parameter:
        return classifyParameter(decl, site);
      case SyntaxKind.VariableDeclaration:
        if (!isConstVariable(decl)) return resolveMutableVariable(decl);
        if (!decl.getInitializer()) return unresolvedResult("const with no initializer");
        return resolveValue(decl.getInitializer());
      case SyntaxKind.PropertyAssignment:
        if (!hasStableReceiver(site)) return unresolvedResult("member of an object that may be rebound");
        return resolveValue(decl.getInitializer());
      case SyntaxKind.ShorthandPropertyAssignment: {
        if (!hasStableReceiver(site)) return unresolvedResult("member of an object that may be rebound");
        const valueDecl = decl.getValueSymbol?.()?.getDeclarations()[0];
        return valueDecl ? resolveDeclaration(valueDecl, decl.getNameNode()) : unresolvedResult("shorthand with no value");
      }
      case SyntaxKind.ClassDeclaration:
      case SyntaxKind.ClassExpression:
        // The construction unit: field initializers, the constructor, the base.
        return { ...EMPTY, fns: [decl] };
      case SyntaxKind.PropertyDeclaration:
        return classMemberValue(decl);
      case SyntaxKind.MethodDeclaration:
        // No body: abstract, or an overload signature.
        if (isClassMember(decl)) return classMemberValue(decl);
        return resolveImplementations(site, decl);
      case SyntaxKind.MethodSignature:
      case SyntaxKind.PropertySignature:
        return resolveImplementations(site, decl);
      case SyntaxKind.BindingElement: {
        const pattern = decl.getParent();
        const holder = pattern?.getParent();
        if (holder?.getKind() === SyntaxKind.VariableDeclaration && !isConstVariable(holder)) {
          return unresolvedResult("function destructured into a let/var");
        }
        if (holder?.getKind() !== SyntaxKind.VariableDeclaration && holder?.getKind() !== SyntaxKind.Parameter) {
          return unresolvedResult("function destructured from a nested pattern");
        }
        const init = holder.getKind() === SyntaxKind.VariableDeclaration ? holder.getInitializer() : null;
        if (pattern.getKind() === SyntaxKind.ArrayBindingPattern) {
          // `const [v, setV] = useState()`: an element of what a library call
          // returns is library code only when the library makes it.
          const call = init ? unwrapAwait(init) : null;
          if (call?.getKind() === SyntaxKind.CallExpression && resolveCall(call).external && libraryReturnIsLibraryMade(call)) {
            return { ...EMPTY, external: true };
          }
          return unresolvedResult("function from an array pattern");
        }
        if (pattern.getKind() !== SyntaxKind.ObjectBindingPattern) return unresolvedResult("function from a binding pattern");
        const name = decl.getPropertyNameNode()?.getText() ?? decl.getName();
        // `const { f } = await import("…")` / `require("…")`: the module's export.
        const loaded = init ? moduleLoadedBy(unwrapAwait(init)) : null;
        if (loaded) return loaded.library ? LIBRARY_MODULE : resolveExport(loaded.sf, name, decl.getNameNode());
        const sourceType = init ? init.getType() : holder.getType();
        if (!sourceType) return unresolvedResult("destructured const with no initializer");
        return resolvePropertyOfType(sourceType, name, decl.getNameNode());
      }
      default:
        return unresolvedResult(`callee declared as ${decl.getKindName()}`);
    }
  }

  /** The EXTERNAL_SHAPE_ALLOWLIST key for the interface declaring `nameNode`'s member, if listed. */
  function externalShapeOf(nameNode) {
    for (const decl of nameNode.getSymbol()?.getDeclarations() ?? []) {
      let owner = decl.getParent();
      if (owner?.getKind() === SyntaxKind.TypeLiteral && owner.getParent()?.getKind() === SyntaxKind.TypeAliasDeclaration) {
        owner = owner.getParent();
      }
      if (owner?.getKind() !== SyntaxKind.InterfaceDeclaration && owner?.getKind() !== SyntaxKind.TypeAliasDeclaration) continue;
      const key = `${toRelPosix(owner.getSourceFile().getFilePath())}::${owner.getName()}`;
      if (EXTERNAL_SHAPE_ALLOWLIST.has(key)) return key;
    }
    return null;
  }

  /**
   * Every production member that may hold a function, keyed by name: object
   * literal members and instance class members. An interface member can be
   * any of them — a structural assignment or a cast decides which object
   * stands behind an interface, and neither renames a member — so dispatch
   * through one is the union over its name. (The language service's
   * implementations miss an object literal or class that matches only
   * structurally.)
   */
  let membersByName = null;
  function membersNamed(name) {
    if (!membersByName) {
      membersByName = new Map();
      for (const sf of program.getSourceFiles()) {
        if (sf.isDeclarationFile() || sf.getFilePath().includes("/node_modules/")) continue;
        sf.forEachDescendant((node) => {
          const k = node.getKind();
          const pk = node.getParent()?.getKind();
          const inLiteral =
            pk === SyntaxKind.ObjectLiteralExpression &&
            (k === SyntaxKind.PropertyAssignment || k === SyntaxKind.ShorthandPropertyAssignment || k === SyntaxKind.MethodDeclaration);
          const inClass =
            (pk === SyntaxKind.ClassDeclaration || pk === SyntaxKind.ClassExpression) &&
            (k === SyntaxKind.MethodDeclaration || k === SyntaxKind.PropertyDeclaration) &&
            !node.isStatic?.();
          if (!inLiteral && !inClass) return;
          if (node.getNameNode().getKind() === SyntaxKind.ComputedPropertyName) return; // G3
          if (!mayBeCallable(node.getType())) return;
          const key = node.getSymbol()?.getName();
          if (!key) return;
          const list = membersByName.get(key) ?? [];
          list.push(node);
          membersByName.set(key, list);
        });
      }
    }
    return membersByName.get(name) ?? [];
  }

  function candidateValue(member) {
    switch (member.getKind()) {
      case SyntaxKind.MethodDeclaration:
        return isClassMember(member) ? ownClassMemberValue(member) : { ...EMPTY, fns: [member] };
      case SyntaxKind.PropertyDeclaration:
        return ownClassMemberValue(member);
      case SyntaxKind.PropertyAssignment:
        return resolveValue(member.getInitializer());
      case SyntaxKind.ShorthandPropertyAssignment: {
        const valueDecl = member.getValueSymbol?.()?.getDeclarations()[0];
        return valueDecl ? resolveDeclaration(valueDecl, member.getNameNode()) : unresolvedResult("shorthand with no value");
      }
      default:
        return unresolvedResult(`member ${member.getKindName()}`);
    }
  }

  /** A member with no body here (an interface or type member): every production member of its name. */
  function resolveImplementations(site, decl) {
    const e = unwrap(site);
    const nameNode =
      e.getKind() === SyntaxKind.PropertyAccessExpression ? e.getNameNode() : e.getKind() === SyntaxKind.Identifier ? e : null;
    const shape = nameNode ? externalShapeOf(nameNode) : null;
    if (shape) {
      // Declared by us to type a library value; nothing of ours implements it.
      usedExternalShapes.add(shape);
      return { ...EMPTY, external: true };
    }
    const name = decl.getSymbol()?.getName();
    if (!name) return unresolvedResult("member with no name to search");
    const all = membersNamed(name);
    const candidates = all.filter((m) => !isNonProduction(m));
    if (candidates.length === 0) {
      // Only tests supply one (an injected seam): production never does.
      return all.length > 0 ? { ...EMPTY } : unresolvedResult(`member ${name} with no body and no member of that name`);
    }
    const hit = dispatchMemo.get(name);
    if (hit) return hit;
    // Re-entered while its own candidates are being resolved (a member whose
    // value is the same interface member): fail closed, as resolveValue does.
    if (dispatching.has(name)) return unresolvedResult("cyclic definition");
    dispatching.add(name);
    try {
      const result = merge(candidates.map(candidateValue));
      dispatchMemo.set(name, result);
      return result;
    } finally {
      dispatching.delete(name);
    }
  }
  const dispatchMemo = new Map();
  const dispatching = new Set();

  /**
   * What an invocation runs: a call or `new`, a tagged template's tag, or a
   * property read/write that lands on an own accessor.
   */
  function resolveCall(node) {
    let hit = callMemo.get(node);
    if (hit) return hit;
    const kind = node.getKind();
    if (kind === SyntaxKind.TaggedTemplateExpression) {
      hit = resolveValue(node.getTag());
    } else if (kind === SyntaxKind.PropertyAccessExpression) {
      hit = accessorsOf(node);
    } else {
      const callee = unwrap(node.getExpression());
      if (
        kind === SyntaxKind.CallExpression &&
        callee?.getKind() === SyntaxKind.PropertyAccessExpression &&
        ["call", "apply"].includes(callee.getName())
      ) {
        const target = resolveValue(callee.getExpression());
        // A library `.call`/`.apply` on an own function is that function.
        hit = target.fns.length > 0 || target.unresolved || target.params.length > 0 ? target : resolveValue(callee);
      } else {
        hit = resolveValue(callee);
      }
      // A function value typed `any`/`unknown` that resolves to no own code:
      // whatever was stored in it is unknown, however the `any` arrived.
      const k = callee?.getKind();
      if (!hit.unresolved && !hit.libraryModule && hit.fns.length === 0 && hit.params.length === 0 && k !== SyntaxKind.ImportKeyword && k !== SyntaxKind.SuperKeyword) {
        const t = callee.getType();
        if (t.isAny() || t.isUnknown()) hit = unresolvedResult("function value typed any or unknown");
      }
    }
    callMemo.set(node, hit);
    return hit;
  }

  /** The own getter/setter a property access invokes, if any. */
  function accessorsOf(access) {
    const symbol = access.getNameNode().getSymbol();
    const fns = [];
    for (const d of symbol?.getDeclarations() ?? []) {
      const k = d.getKind();
      if ((k === SyntaxKind.GetAccessor || k === SyntaxKind.SetAccessor) && !isExternal(d) && d.getBody?.()) fns.push(d);
    }
    return { ...EMPTY, fns };
  }

  /** True when a property access lands on an own accessor and is therefore an invocation. */
  function isAccessorInvocation(access) {
    return accessorsOf(access).fns.length > 0;
  }

  return {
    resolveValue,
    resolveCall,
    resolvePropertyOfType,
    resolveParameterFromCallers,
    functionOfDeclaration,
    isAccessorInvocation,
    isExternal,
    isNonProduction,
    usedExternalShapes,
    program,
  };
}

// ─── Reachability ───────────────────────────────────────────────────────────

const CLASS_KINDS = new Set([SyntaxKind.ClassDeclaration, SyntaxKind.ClassExpression]);

/** A unit of execution: a function body, or a class's construction. */
export function isUnit(node) {
  return FN_KINDS.has(node.getKind()) || CLASS_KINDS.has(node.getKind());
}

export function isInlineArgument(fn) {
  const parent = fn.getParent();
  return (
    LITERAL_FN_KINDS.has(fn.getKind()) &&
    (parent?.getKind() === SyntaxKind.CallExpression || parent?.getKind() === SyntaxKind.NewExpression) &&
    parent.getArguments().includes(fn)
  );
}

/**
 * Whether a value of type `t` may be a function: some member of the union,
 * after `undefined`/`null` are removed, has a call signature. `T | undefined`
 * (an optional callback, `Map.get`) is callable; `any` is decided by caller.
 */
export function mayBeCallable(t) {
  const types = t.isUnion() ? t.getUnionTypes() : [t];
  return types.some((u) => u.getNonNullableType().getCallSignatures().length > 0);
}

const WRAPPER_KINDS = new Set([
  SyntaxKind.ParenthesizedExpression, SyntaxKind.NonNullExpression, SyntaxKind.AsExpression,
  SyntaxKind.SatisfiesExpression, SyntaxKind.TypeAssertionExpression,
]);
// Expressions whose value may be a function without being a name.
const COMPUTED_VALUE_KINDS = new Set([
  SyntaxKind.CallExpression, SyntaxKind.ConditionalExpression, SyntaxKind.BinaryExpression, SyntaxKind.AwaitExpression,
]);

const isTypePosition = (node) =>
  node.getKind() >= SyntaxKind.FirstTypeNode && node.getKind() <= SyntaxKind.LastTypeNode;

const DECLARATION_NAME_PARENTS = new Set([
  SyntaxKind.VariableDeclaration, SyntaxKind.FunctionDeclaration, SyntaxKind.FunctionExpression,
  SyntaxKind.Parameter, SyntaxKind.BindingElement, SyntaxKind.PropertyAssignment, SyntaxKind.MethodDeclaration,
  SyntaxKind.PropertyDeclaration, SyntaxKind.PropertySignature, SyntaxKind.MethodSignature, SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor, SyntaxKind.ClassDeclaration, SyntaxKind.ClassExpression, SyntaxKind.InterfaceDeclaration,
  SyntaxKind.TypeAliasDeclaration, SyntaxKind.EnumDeclaration, SyntaxKind.EnumMember, SyntaxKind.LabeledStatement,
]);
const SPECIFIER_KINDS = new Set([
  SyntaxKind.ImportSpecifier, SyntaxKind.ExportSpecifier, SyntaxKind.ImportClause, SyntaxKind.NamespaceImport,
  SyntaxKind.NamespaceExport, SyntaxKind.ImportEqualsDeclaration,
]);

/**
 * What runs when a unit runs, through the shared resolver. A unit's OWN nodes
 * are its subtree minus other units, except that a function literal passed
 * inline to a call is part of the unit (it runs in the unit's dynamic extent
 * as far as this analysis can tell — conservative). A class unit owns its
 * instance field initializers; its constructor and its base class's
 * construction are edges.
 *
 * Edges are invocations (calls, `new`, tagged templates, own getter/setter
 * accesses, `await` of an own `then`) and function-valued references (a
 * function handed on as a value, anywhere: an argument, an array or object
 * member, a `.bind`/`.call`/`.apply` receiver).
 */
export function createReachability(resolver) {
  const { resolveValue, resolveCall, isExternal, resolveParameterFromCallers, functionOfDeclaration } = resolver;
  const ownedMemo = new Map();
  const edgesMemo = new Map();

  /**
   * A unit's own nodes: its WHOLE lexical subtree, nested functions and
   * classes included. Whatever is written inside a unit may run while it runs
   * — a callback a library keeps (`new ReadableStream({ start })`), an object
   * member, a class's static block — so lexical containment is the floor and
   * reach only adds what is written elsewhere. A class reached as a unit (by
   * `new`) owns its field initializers and static blocks; its constructor and
   * base are edges, its methods are reached when invoked.
   */
  function ownedNodes(unit) {
    let out = ownedMemo.get(unit);
    if (out) return out;
    out = [];
    const visit = (node) => {
      for (const child of node.getChildren()) {
        if (isTypePosition(child)) continue;
        out.push(child);
        visit(child);
      }
    };
    if (CLASS_KINDS.has(unit.getKind())) {
      for (const member of unit.getMembers?.() ?? []) {
        const k = member.getKind();
        if (k === SyntaxKind.PropertyDeclaration) {
          const init = member.getInitializer?.();
          if (init) {
            out.push(init);
            visit(init);
          }
        } else if (k === SyntaxKind.ClassStaticBlockDeclaration) {
          out.push(member);
          visit(member);
        }
      }
    } else {
      visit(unit);
    }
    ownedMemo.set(unit, out);
    return out;
  }

  /** An awaited value whose `then` is an own method: `await` calls it. */
  function thenOf(awaitExpr) {
    const prop = awaitExpr.getExpression().getType().getProperty("then");
    const decls = (prop?.getDeclarations() ?? []).filter((d) => !isExternal(d));
    if (decls.length === 0) return null;
    const fns = [];
    for (const d of decls) {
      const fn =
        functionOfDeclaration(d) ??
        (d.getKind() === SyntaxKind.PropertyAssignment ? resolveValue(d.getInitializer()).fns[0] : null);
      if (!fn) return { fns: [], external: false, params: [], unresolved: "awaited value's then() cannot be named" };
      fns.push(fn);
    }
    return { fns, external: false, params: [], unresolved: null };
  }

  /** The resolution of `node` as an invocation, or null when it is not one. */
  function invocationOf(node) {
    switch (node.getKind()) {
      case SyntaxKind.CallExpression:
      case SyntaxKind.NewExpression:
      case SyntaxKind.TaggedTemplateExpression:
        return resolveCall(node);
      case SyntaxKind.PropertyAccessExpression: {
        const r = resolveCall(node);
        return r.fns.length > 0 ? r : null;
      }
      case SyntaxKind.AwaitExpression:
        return thenOf(node);
      default:
        return null;
    }
  }

  function calleeNodeOf(node) {
    switch (node.getKind()) {
      case SyntaxKind.CallExpression:
      case SyntaxKind.NewExpression:
        return unwrap(node.getExpression());
      case SyntaxKind.TaggedTemplateExpression:
        return unwrap(node.getTag());
      default:
        return null;
    }
  }

  /** The value node an identifier contributes as a function-valued reference, or null. */
  function referenceValueOf(id, calleeNodes) {
    const parent = id.getParent();
    if (!parent) return null;
    if (SPECIFIER_KINDS.has(parent.getKind())) return null;
    if (DECLARATION_NAME_PARENTS.has(parent.getKind()) && parent.getNameNode?.() === id) return null;
    if (parent.getKind() === SyntaxKind.PropertyAssignment || parent.getKind() === SyntaxKind.ShorthandPropertyAssignment) {
      if (parent.getNameNode?.() === id && parent.getKind() === SyntaxKind.PropertyAssignment) return null;
    }
    const pk = parent.getKind();
    if (pk === SyntaxKind.JsxOpeningElement || pk === SyntaxKind.JsxSelfClosingElement || pk === SyntaxKind.JsxClosingElement) {
      // Rendered by React after the enclosing function returns.
      return null;
    }
    let value = id;
    if (pk === SyntaxKind.PropertyAccessExpression) {
      if (parent.getNameNode() === id) value = parent;
      // The receiver of `a.b` is not handed on by the access. (`fn.bind(…)`
      // hands on a call's result, an edge where it is used; `fn.call(…)` is an
      // invocation of `fn`.)
      else return null;
    }
    if (calleeNodes.has(value)) return null;
    let symbol = value.getSymbol?.();
    if (symbol?.isAlias()) symbol = symbol.getAliasedSymbol();
    const decls = symbol?.getDeclarations() ?? [];
    if (decls.length === 0 || decls.every(isExternal)) return null;
    if (!mayBeCallable(value.getType())) return null;
    return value;
  }

  /**
   * Whether `node`, climbing past parentheses and casts, is used as a value
   * that leaves the expression: an argument, an initializer, a returned or
   * assigned value, an element. Not a callee, a receiver or a condition.
   */
  function isHandedOn(node) {
    let cur = node;
    while (WRAPPER_KINDS.has(cur.getParent()?.getKind())) cur = cur.getParent();
    const parent = cur.getParent();
    switch (parent?.getKind()) {
      case SyntaxKind.CallExpression:
      case SyntaxKind.NewExpression:
        return (parent.getArguments?.() ?? []).includes(cur);
      case SyntaxKind.VariableDeclaration:
      case SyntaxKind.PropertyAssignment:
      case SyntaxKind.PropertyDeclaration:
        return parent.getInitializer?.() === cur;
      case SyntaxKind.ReturnStatement:
      case SyntaxKind.ArrayLiteralExpression:
      case SyntaxKind.SpreadElement:
      case SyntaxKind.YieldExpression:
        return true;
      case SyntaxKind.ArrowFunction:
        return parent.getBody() === cur;
      case SyntaxKind.BinaryExpression: {
        const op = parent.getOperatorToken().getKind();
        return op === SyntaxKind.EqualsToken && parent.getRight() === cur;
      }
      default:
        return false;
    }
  }

  /**
   * Edges to the own functions an argument carries as members, found through
   * its TYPE (bounded depth): a member whose declaration is production code
   * and may hold a function. An array or tuple of functions handed to library
   * code is unnameable unless it is written inline (its elements are then
   * values in reach).
   */
  function memberFunctionEdges(arg, depth = 0, seen = new Set()) {
    const e = unwrap(arg);
    if (!e || depth > 2) return [];
    if (LITERAL_FN_KINDS.has(e.getKind())) return [];
    const out = [];
    const visitType = (type, d) => {
      const t = type.getNonNullableType();
      if (seen.has(t.compilerType)) return;
      seen.add(t.compilerType);
      if (t.isUnion()) return t.getUnionTypes().forEach((u) => visitType(u, d));
      if (t.isIntersection()) return t.getIntersectionTypes().forEach((u) => visitType(u, d));
      if (t.getCallSignatures().length > 0) return; // the argument itself: a value edge already
      const element = t.getArrayElementType?.() ?? null;
      const tuple = t.isTuple?.() ? t.getTupleElements() : null;
      for (const el of element ? [element] : tuple ?? []) {
        if (mayBeCallable(el) && e.getKind() !== SyntaxKind.ArrayLiteralExpression) {
          out.push({ node: e, r: { fns: [], external: false, params: [], unresolved: "array of functions handed to library code" }, kind: "value" });
        }
      }
      for (const prop of t.getProperties()) {
        const decls = prop.getDeclarations();
        if (!decls.some((dcl) => !isExternal(dcl) && !resolver.isNonProduction(dcl))) continue;
        const at = prop.getValueDeclaration() ?? decls[0];
        const pt = prop.getTypeAtLocation(at);
        if (mayBeCallable(pt)) {
          out.push({ node: e, r: resolver.resolvePropertyOfType(t, prop.getName(), e), kind: "value" });
        } else if (d < 2) {
          visitType(pt, d + 1);
        }
      }
    };
    visitType(e.getType(), depth);
    return out;
  }

  /** { node, r, kind: "call" | "value" } for every edge out of `unit`. */
  function edgesOf(unit) {
    let edges = edgesMemo.get(unit);
    if (edges) return edges;
    edges = [];
    const owned = ownedNodes(unit);
    const calleeNodes = new Set();
    for (const node of owned) {
      const c = calleeNodeOf(node);
      if (c) calleeNodes.add(c);
    }
    for (const node of owned) {
      const r = invocationOf(node);
      if (r) edges.push({ node, r, kind: "call" });
      if (node.getKind() === SyntaxKind.Identifier || node.getKind() === SyntaxKind.PrivateIdentifier) {
        const value = referenceValueOf(node, calleeNodes);
        if (value && !(value !== node && invocationOf(value))) edges.push({ node: value, r: resolveValue(value), kind: "value" });
      } else if (node.getKind() === SyntaxKind.ElementAccessExpression && !calleeNodes.has(node)) {
        // `TBL["a"]`, `TBL[k]` handed on as a value.
        const parent = node.getParent();
        const isWriteTarget = parent?.getKind() === SyntaxKind.BinaryExpression && parent.getLeft() === node;
        // A receiver is read, not handed on. (`TBL["a"].bind(…)` hands on the
        // bound function, a call's result, which is an edge where it is used.)
        const isReceiver =
          (parent?.getKind() === SyntaxKind.PropertyAccessExpression || parent?.getKind() === SyntaxKind.ElementAccessExpression) &&
          parent.getExpression() === node;
        if (!isWriteTarget && !isReceiver && mayBeCallable(node.getType())) {
          edges.push({ node, r: resolveValue(node), kind: "value" });
        }
      } else if (COMPUTED_VALUE_KINDS.has(node.getKind()) && isHandedOn(node) && mayBeCallable(node.getType())) {
        // A function value that is not a name: a call's result, a
        // conditional, an `await` — `retry(registry.get("a")!)`.
        edges.push({ node, r: resolveValue(node), kind: "value" });
      }
      if (node.getKind() === SyntaxKind.CallExpression || node.getKind() === SyntaxKind.NewExpression) {
        // Library code may call any function an argument carries as a member:
        // `new ReadableStream(source)`, `lib(opts)`.
        const r = invocationOf(node);
        if (r && r.external && !r.unresolved) {
          for (const arg of node.getArguments?.() ?? []) edges.push(...memberFunctionEdges(arg));
        }
      }
    }
    if (CLASS_KINDS.has(unit.getKind())) {
      const ctor = unit.getConstructors?.()[0];
      if (ctor) edges.push({ node: ctor, r: { fns: [ctor.getImplementation?.() ?? ctor], external: false, params: [], unresolved: null }, kind: "call" });
      const ext = unit.getExtends?.()?.getExpression();
      if (ext && !ctor) edges.push({ node: ext, r: resolveValue(ext), kind: "call" });
    }
    edgesMemo.set(unit, edges);
    return edges;
  }

  /**
   * Breadth-first reach from `root`. Hooks:
   *   stop(unit)             — do not expand this unit (still recorded);
   *   skipEdge(edge, unit)   — returns the fns to drop from this edge;
   *   onParam(param, edge, unit) — "skip" | "follow" | undefined (default rule).
   * Default rule for a parameter reached: a value its OWN function's caller
   * passed is checked where it was passed — unless that function was itself
   * reached as a value (then its invoker is unknown) or the parameter was
   * captured by a closure; then every production caller's argument is reached.
   */
  function reach(root, hooks = {}) {
    const info = new Map([[root, { parent: null, edge: null, valueReached: false }]]);
    const queue = [root];
    const unresolved = [];
    const visitEdgeFns = (fns, edge, from) => {
      for (const fn of fns) {
        const known = info.get(fn);
        if (!known) {
          info.set(fn, { parent: from, edge, valueReached: edge.kind === "value" });
          queue.push(fn);
        } else if (edge.kind === "value" && !known.valueReached) {
          known.valueReached = true;
          queue.push(fn);
        }
      }
    };
    while (queue.length > 0) {
      const unit = queue.shift();
      if (hooks.stop?.(unit)) continue;
      for (const edge of edgesOf(unit)) {
        const drop = hooks.skipEdge?.(edge, unit, root) ?? [];
        const r = edge.r;
        if (r.unresolved) unresolved.push({ node: edge.node, reason: r.unresolved, unit });
        visitEdgeFns(r.fns.filter((f) => !drop.includes(f)), edge, unit);
        for (const { param, ownInvoker } of r.params) {
          if (ownInvoker) continue;
          const decision = hooks.onParam?.(param, edge, unit, root);
          if (decision === "skip") continue;
          if (decision !== "follow" && !info.get(param.getParent())?.valueReached) continue;
          const fromCallers = resolveParameterFromCallers(param);
          if (fromCallers.unresolved) unresolved.push({ node: edge.node, reason: fromCallers.unresolved, unit });
          visitEdgeFns(fromCallers.fns, { ...edge, kind: "call" }, unit);
        }
      }
    }
    return { info, unresolved };
  }

  /** root → … → unit, as "name (file:line)" labels joined for a report. */
  function chainTo(info, unit) {
    const steps = [];
    for (let u = unit; u; u = info.get(u)?.parent) steps.unshift(u);
    return steps;
  }

  return { reach, chainTo, ownedNodes, edgesOf };
}
