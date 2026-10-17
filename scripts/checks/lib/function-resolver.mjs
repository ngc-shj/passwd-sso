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
 * PRODUCTION is src/ and scripts/ minus tests and the CI tooling itself.
 * Implementations, assignments and callers found outside it never run in
 * production and are ignored; everything inside it is scanned by both gates.
 */
import { SyntaxKind } from "ts-morph";
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

/** A cwd-relative path that is production TypeScript. */
export function isProductionPath(rel) {
  if (!PRODUCTION_ROOTS.some((root) => rel.startsWith(root))) return false;
  if (NON_PRODUCTION_PREFIXES.some((prefix) => rel.startsWith(prefix))) return false;
  if (NON_PRODUCTION_SCRIPTS.includes(rel)) return false;
  if (!/\.tsx?$/.test(rel) || rel.endsWith(".d.ts")) return false;
  return !/\.(test|spec)\.tsx?$/.test(rel) && !rel.includes("__tests__");
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
  ["src/lib/key-provider/azure-kv-provider.ts::KvSecretClient", "@azure/keyvault-secrets"],
  ["src/lib/key-provider/gcp-sm-provider.ts::SmClient", "@google-cloud/secret-manager"],
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
const OBJECT_MUTATORS = new Set(["Object.assign", "Object.defineProperty", "Object.defineProperties", "Object.setPrototypeOf", "Reflect.set", "Reflect.defineProperty"]);
const unresolvedResult = (reason) => ({ ...EMPTY, unresolved: reason });

export function merge(results) {
  const out = { fns: [], external: false, params: [], unresolved: null };
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

export function createFunctionResolver({ program, modelNames = new Set() }) {
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
    return !isExternal(node) && !isProductionPath(toRelPosix(node.getSourceFile().getFilePath()));
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
      return name !== "Function" && name !== "CallableFunction";
    }
    // Keywords and literals (`void`, `undefined`, `string`) are not functions of ours.
    return node.getKind() !== SyntaxKind.AnyKeyword && node.getKind() !== SyntaxKind.UnknownKeyword;
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

  /**
   * A member of an `any`-typed Prisma client: `db.$transaction`, a delegate
   * method `db.user.findMany`, or a method of a delegate destructured by a model
   * name (`const { user } = db`). The client API, not code of ours — the model
   * access itself is what the gates count.
   */
  function isUntypedClientApi(e) {
    if (e.getKind() !== SyntaxKind.PropertyAccessExpression) return false;
    const receiver = unwrap(e.getExpression());
    const t = receiver.getType();
    if (!t.isAny() && !t.isUnknown()) return false;
    if (e.getName().startsWith("$")) return true;
    if (receiver.getKind() === SyntaxKind.PropertyAccessExpression) return modelNames.has(receiver.getName());
    if (receiver.getKind() === SyntaxKind.ElementAccessExpression) return modelNames.has(literalKey(receiver.getArgumentExpression()) ?? "");
    if (receiver.getKind() === SyntaxKind.Identifier) {
      const decl = receiver.getSymbol()?.getDeclarations()[0];
      if (decl?.getKind() !== SyntaxKind.BindingElement) return false;
      const key = decl.getPropertyNameNode()?.getText().replace(/^["'`]|["'`]$/g, "") ?? decl.getName();
      return modelNames.has(key);
    }
    return false;
  }

  /** Own functions handed to a call as arguments, literal or by reference. */
  function functionArgsOf(call) {
    const out = [];
    for (const a of call.getArguments()) {
      const e = unwrap(a);
      const k = e?.getKind();
      if (LITERAL_FN_KINDS.has(k)) out.push({ ...EMPTY, fns: [e] });
      else if (k === SyntaxKind.Identifier || k === SyntaxKind.PropertyAccessExpression) {
        if (e.getType().getCallSignatures().length > 0) out.push(resolveValue(e));
      }
    }
    return out;
  }

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
      // The value of a call is what the callee returns: `const log = makeLogger()`.
      const callee = resolveCall(e);
      if (callee.unresolved || callee.params.length > 0) {
        return unresolvedResult("function returned by a call this gate cannot follow");
      }
      if (callee.external && callee.fns.length === 0) {
        if (isPackageModuleLoad(e)) return { ...EMPTY, external: true };
        // A library hands back library code, or one of ours: given here
        // (`debounce(fn)`), or stored earlier and returned through a type
        // parameter (`registry.get(k)` declared `V | undefined`), which cannot
        // be named. Judged on the declared return type, not the instantiated one.
        const returnsFunction = e.getType().getCallSignatures().length > 0;
        if (returnsFunction && !libraryReturnIsLibraryMade(e)) {
          return unresolvedResult("function returned by a library call");
        }
        return merge([{ ...EMPTY, external: true }, ...functionArgsOf(e)]);
      }
      return merge(callee.fns.map((fn) => returnedValue(fn)));
    }

    if (kind === SyntaxKind.ElementAccessExpression && literalKey(e.getArgumentExpression()) !== null) {
      const key = literalKey(e.getArgumentExpression());
      const decls = e.getExpression().getType().getProperty(key)?.getDeclarations() ?? [];
      // A member a library declares (`tx["$transaction"]`) is library code
      // whatever holds the receiver; only an own member needs a stable one.
      if (decls.length > 0 && decls.every(isExternal)) return { ...EMPTY, external: true };
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
    if (!symbol && isUntypedClientApi(e)) return { ...EMPTY, external: true };
    if (!symbol) return unresolvedResult("callee has no symbol");
    if (symbol.isAlias()) symbol = symbol.getAliasedSymbol();
    const decls = symbol?.getDeclarations() ?? [];
    if (decls.length === 0) return unresolvedResult("callee has no declaration");
    if (decls.every(isExternal)) return { ...EMPTY, external: true };
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
        if (!entry.isWriteAccess()) continue;
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

  /**
   * A member of an object literal holds its initializer and every production
   * write to that member (`ops.run = opener`, found through the member's symbol
   * however the object is reached). A container handed to Object.assign /
   * defineProperty, or written through a computed key, may hold anything.
   */
  const memberMemo = new Map();
  function objectMemberValue(memberDecl, initial) {
    const hit = memberMemo.get(memberDecl);
    if (hit) return hit;
    const result = objectMemberValueUncached(memberDecl, initial);
    memberMemo.set(memberDecl, result);
    return result;
  }

  function objectMemberValueUncached(memberDecl, initial) {
    const results = [initial];
    results.push(...writesTo(memberDecl.getNameNode(), (node) => {
      const access = node.getParent();
      if (access?.getKind() !== SyntaxKind.PropertyAccessExpression || access.getNameNode() !== node) return null;
      const assignment = access.getParent();
      return assignment?.getKind() === SyntaxKind.BinaryExpression && assignment.getLeft() === access ? assignment : null;
    }));
    const container = containerVariableOf(memberDecl.getParent());
    if (container) {
      for (const ref of container.getNameNode().findReferencesAsNodes()) {
        if (ref === container.getNameNode() || isNonProduction(ref) || isExternal(ref)) continue;
        const parent = ref.getParent();
        if (parent?.getKind() === SyntaxKind.CallExpression && parent.getExpression() !== ref) {
          const callee = parent.getExpression().getText();
          if (OBJECT_MUTATORS.has(callee)) {
            results.push(unresolvedResult(`object handed to ${callee} at ${toRelPosix(ref.getSourceFile().getFilePath())}:${ref.getStartLineNumber()}`));
          }
        }
        if (parent?.getKind() === SyntaxKind.ElementAccessExpression && parent.getExpression() === ref && literalKey(parent.getArgumentExpression()) === null) {
          const outer = parent.getParent();
          if (outer?.getKind() === SyntaxKind.BinaryExpression && outer.getLeft() === parent) {
            results.push(unresolvedResult(`object written through a computed key at ${toRelPosix(ref.getSourceFile().getFilePath())}:${ref.getStartLineNumber()}`));
          }
        }
      }
    }
    return merge(results);
  }

  function containerVariableOf(literal) {
    const holder = literal?.getParent();
    return holder?.getKind() === SyntaxKind.VariableDeclaration && unwrap(holder.getInitializer()) === literal ? holder : null;
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
      if (invoker.fns.length > 0 && !invoker.external && !invoker.unresolved) {
        // Our own function invokes the literal; what it passes is in its body.
        return { ...EMPTY, params: [{ param, ownInvoker: true }] };
      }
      const argIndex = holder.getArguments().indexOf(owner);
      const paramIndex = owner.getParameters().indexOf(param);
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
    if (decls.every(isExternal)) return { ...EMPTY, external: true };
    return merge(decls.filter((d) => !isExternal(d)).map((d) => resolveDeclaration(d, site)));
  }

  /**
   * The const object literal a non-literal index reads, or the reason it
   * cannot be one. Every production reference to the table must only READ a
   * member or enumerate its keys; one that assigns a member, or hands the table
   * somewhere that could (`Object.assign`, any call), means a member may exist
   * that the literal does not spell.
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
    for (const ref of decl.getNameNode().findReferencesAsNodes()) {
      if (isNonProduction(ref) || isExternal(ref) || ref === decl.getNameNode()) continue;
      if (!isReadOnlyTableUse(ref)) {
        return `table ${decl.getName()} is mutated or escapes at ${toRelPosix(ref.getSourceFile().getFilePath())}:${ref.getStartLineNumber()}`;
      }
    }
    return init;
  }

  function isReadOnlyTableUse(ref) {
    const parent = ref.getParent();
    const k = parent?.getKind();
    if (k === SyntaxKind.ImportSpecifier || k === SyntaxKind.ExportSpecifier || k === SyntaxKind.TypeQuery) return true;
    if (ref.getFirstAncestorByKind(SyntaxKind.TypeQuery)) return true;
    if (
      (k === SyntaxKind.PropertyAccessExpression || k === SyntaxKind.ElementAccessExpression) &&
      parent.getExpression() === ref
    ) {
      const outer = parent.getParent();
      const assigned =
        outer?.getKind() === SyntaxKind.BinaryExpression &&
        outer.getLeft() === parent &&
        outer.getOperatorToken().getKind() >= SyntaxKind.FirstAssignment &&
        outer.getOperatorToken().getKind() <= SyntaxKind.LastAssignment;
      const deleted = outer?.getKind() === SyntaxKind.DeleteExpression;
      return !assigned && !deleted;
    }
    if (k === SyntaxKind.CallExpression && parent.getExpression() !== ref) {
      const callee = parent.getExpression().getText();
      return callee === "Object.keys" || callee === "Object.values" || callee === "Object.entries";
    }
    return false;
  }

  function resolveMember(prop) {
    switch (prop.getKind()) {
      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.GetAccessor:
        return objectMemberValue(prop, { ...EMPTY, fns: [prop] });
      case SyntaxKind.PropertyAssignment:
        return objectMemberValue(prop, resolveValue(prop.getInitializer()));
      case SyntaxKind.ShorthandPropertyAssignment: {
        const valueDecl = prop.getValueSymbol?.()?.getDeclarations()[0];
        return objectMemberValue(
          prop,
          valueDecl ? resolveDeclaration(valueDecl, prop.getNameNode()) : unresolvedResult("shorthand with no value"),
        );
      }
      case SyntaxKind.SpreadAssignment:
        return unresolvedResult("spread member of a table");
      default:
        return unresolvedResult(`table member ${prop.getKindName()}`);
    }
  }

  /** A class method with a body, and every production override of it. */
  function withOverrides(method) {
    const out = [method];
    for (const impl of method.getNameNode().getImplementations()) {
      const node = impl.getNode();
      if (isExternal(node) || isNonProduction(node)) continue;
      const fn = node.getParent() ? functionOfDeclaration(node.getParent()) : null;
      if (fn && !out.includes(fn)) out.push(fn);
    }
    return out;
  }

  function resolveDeclaration(decl, site) {
    const kind = decl.getKind();
    const fn = functionOfDeclaration(decl);
    if (fn) {
      if (isObjectLiteralMember(decl) && !hasStableReceiver(site)) {
        return unresolvedResult("member of an object that may be rebound");
      }
      if (isObjectLiteralMember(decl)) return objectMemberValue(decl, { ...EMPTY, fns: [fn] });
      if (kind === SyntaxKind.MethodDeclaration && isClassMember(decl)) return { ...EMPTY, fns: withOverrides(fn) };
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
        return objectMemberValue(decl, resolveValue(decl.getInitializer()));
      case SyntaxKind.ShorthandPropertyAssignment: {
        if (!hasStableReceiver(site)) return unresolvedResult("member of an object that may be rebound");
        const valueDecl = decl.getValueSymbol?.()?.getDeclarations()[0];
        return objectMemberValue(
          decl,
          valueDecl ? resolveDeclaration(valueDecl, decl.getNameNode()) : unresolvedResult("shorthand with no value"),
        );
      }
      case SyntaxKind.ClassDeclaration:
      case SyntaxKind.ClassExpression:
        // The construction unit: field initializers, the constructor, the base.
        return { ...EMPTY, fns: [decl] };
      case SyntaxKind.MethodSignature:
      case SyntaxKind.PropertySignature:
      case SyntaxKind.PropertyDeclaration:
      case SyntaxKind.MethodDeclaration:
        return resolveImplementations(site);
      case SyntaxKind.BindingElement: {
        const pattern = decl.getParent();
        if (pattern?.getKind() === SyntaxKind.ArrayBindingPattern) {
          // `const [v, setV] = useState()`: an element of a library value is
          // library code; of anything else, it cannot be named.
          const holder = pattern.getParent();
          if (holder?.getKind() === SyntaxKind.VariableDeclaration && isConstVariable(holder) && holder.getInitializer()) {
            const source = resolveValue(holder.getInitializer());
            if (source.external && !source.unresolved && source.params.length === 0) return source;
          }
          return unresolvedResult("function from an array pattern");
        }
        if (pattern?.getKind() !== SyntaxKind.ObjectBindingPattern) return unresolvedResult("function from a binding pattern");
        const name = decl.getPropertyNameNode()?.getText() ?? decl.getName();
        const holder = pattern.getParent();
        if (holder?.getKind() === SyntaxKind.VariableDeclaration && !isConstVariable(holder)) {
          return unresolvedResult("function destructured into a let/var");
        }
        if (holder?.getKind() !== SyntaxKind.VariableDeclaration && holder?.getKind() !== SyntaxKind.Parameter) {
          return unresolvedResult("function destructured from a nested pattern");
        }
        if (holder.getKind() === SyntaxKind.VariableDeclaration && holder.getInitializer()) {
          const source = resolveValue(holder.getInitializer());
          // Destructured off a library value (`require("node:module")`):
          // library code, plus anything of ours that value was built from.
          if (source.external && !source.unresolved && source.params.length === 0) return source;
        }
        const sourceType =
          holder.getKind() === SyntaxKind.VariableDeclaration ? holder.getInitializer()?.getType() : holder.getType();
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

  function memberNameOf(e) {
    return e.getKind() === SyntaxKind.PropertyAccessExpression ? e.getName() : e.getText();
  }

  function resolveObjectMember(literal, name) {
    if (literal.getProperties().some((p) => p.getKind() === SyntaxKind.SpreadAssignment)) {
      return unresolvedResult("object literal with a spread supplies the member");
    }
    const prop = literal.getProperty(name);
    return prop ? resolveMember(prop) : EMPTY;
  }

  /** A member with no body here: every production implementation the language service finds. */
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
        results.push(valueDecl ? resolveDeclaration(valueDecl, node) : unresolvedResult("shorthand with no value"));
      } else if (node.getKind() === SyntaxKind.Identifier) {
        results.push(resolveValue(node));
      } else if (parent?.getKind() === SyntaxKind.ObjectLiteralExpression) {
        // A whole object literal implementing the type (`options = {}`): only
        // the member it actually spells supplies a value.
        results.push(resolveObjectMember(parent, memberNameOf(e)));
      } else {
        results.push(
          unresolvedResult(
            `implementation ${node.getKindName()} at ${toRelPosix(node.getSourceFile().getFilePath())}:${node.getStartLineNumber()}`,
          ),
        );
      }
    }
    return merge(results);
  }

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

  function ownedNodes(unit) {
    let out = ownedMemo.get(unit);
    if (out) return out;
    out = [];
    const visit = (node) => {
      for (const child of node.getChildren()) {
        if (isTypePosition(child)) continue;
        if (CLASS_KINDS.has(child.getKind())) continue;
        if (FN_KINDS.has(child.getKind()) && !isInlineArgument(child)) continue;
        out.push(child);
        visit(child);
      }
    };
    if (CLASS_KINDS.has(unit.getKind())) {
      for (const prop of unit.getProperties?.() ?? []) {
        if (prop.isStatic?.()) continue;
        const init = prop.getInitializer?.();
        if (!init) continue;
        out.push(init);
        if (!(FN_KINDS.has(init.getKind()) && !isInlineArgument(init))) visit(init);
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
      // The receiver of `a.b` is not handed on by the access — except
      // `fn.bind/.call/.apply`, which hand `fn` itself to the runtime.
      else if (!["bind", "call", "apply"].includes(parent.getName())) return null;
    }
    if (calleeNodes.has(value)) return null;
    let symbol = value.getSymbol?.();
    if (symbol?.isAlias()) symbol = symbol.getAliasedSymbol();
    const decls = symbol?.getDeclarations() ?? [];
    if (decls.length === 0 || decls.every(isExternal)) return null;
    if (value.getType().getCallSignatures().length === 0) return null;
    return value;
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
      if (node.getKind() === SyntaxKind.Identifier) {
        const value = referenceValueOf(node, calleeNodes);
        if (value && !(value !== node && invocationOf(value))) edges.push({ node: value, r: resolveValue(value), kind: "value" });
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
