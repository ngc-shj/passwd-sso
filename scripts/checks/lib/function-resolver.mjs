/**
 * Shared answer to "which function(s) can this expression or call be?" for the
 * Program-backed CI gates (check-rls-nesting, check-bypass-rls's cross-module
 * pass). Both gates used to carry their own copy, and the copies disagreed:
 * one counted interface implementations found in test files, the other did
 * not; neither saw subclass overrides; both believed a const table could not
 * gain members. One resolver, one set of rules.
 *
 * A result is { fns, external, param, unresolved }:
 *   - fns        own-code function bodies the value may be (a union — an
 *                interface member is every implementation, a const table every
 *                member, a class method every override);
 *   - external   library code may be the value (a declaration file or
 *                node_modules — it cannot import our helpers);
 *   - param      the value is a parameter: the caller's argument (see
 *                classifyParameter for where that argument is checked);
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

const EMPTY = Object.freeze({ fns: [], external: false, param: null, unresolved: null });
const unresolvedResult = (reason) => ({ ...EMPTY, unresolved: reason });

export function merge(results) {
  const out = { fns: [], external: false, param: null, unresolved: null };
  for (const r of results) {
    for (const fn of r.fns) if (!out.fns.includes(fn)) out.fns.push(fn);
    out.external ||= r.external;
    out.param ??= r.param;
    out.unresolved ??= r.unresolved;
  }
  return out;
}

export function createFunctionResolver({ program }) {
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
   * A function value's call signatures are declared by a library, and the
   * value is not the catch-all `Function`: the library produced it. A
   * signature declared in our code (`Map<string, () => Promise<void>>`) says
   * the value is one of OURS, held somewhere this resolver cannot see.
   */
  function hasLibrarySignature(type) {
    if (type.isAny() || type.isUnknown()) return false;
    const text = type.getText();
    if (text === "Function" || text === "CallableFunction") return false;
    const sigs = type.getCallSignatures();
    if (sigs.length === 0) return false;
    return sigs.every((sig) => {
      const d = sig.getDeclaration();
      return d ? isExternal(d) : false;
    });
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
    if (kind === SyntaxKind.ImportKeyword || kind === SyntaxKind.SuperKeyword) return { ...EMPTY, external: true };
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
      if (callee.unresolved || callee.param) {
        return unresolvedResult("function returned by a call this gate cannot follow");
      }
      if (callee.external && callee.fns.length === 0) {
        if (isPackageModuleLoad(e)) return { ...EMPTY, external: true };
        // A library hands back library code, or one of ours it was given here
        // (`debounce(fn)`). A function typed by OUR signature (`registry.get(k)`)
        // is one of ours stored elsewhere, and cannot be named.
        // `any` from a library (require()) is the library's own untyped value.
        const type = e.getType();
        const returnsFunction = type.getCallSignatures().length > 0;
        if (returnsFunction && !hasLibrarySignature(type)) {
          return unresolvedResult("function returned by a library call");
        }
        return merge([{ ...EMPTY, external: true }, ...functionArgsOf(e)]);
      }
      return merge(callee.fns.map((fn) => returnedValue(fn)));
    }

    if (kind === SyntaxKind.ElementAccessExpression && literalKey(e.getArgumentExpression()) !== null) {
      if (!hasStableReceiver(e)) return unresolvedResult("member of an object that may be rebound");
      return resolvePropertyOfType(e.getExpression().getType(), literalKey(e.getArgumentExpression()), e);
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
    for (const ref of decl.getNameNode().findReferencesAsNodes()) {
      if (isNonProduction(ref) || isExternal(ref)) continue;
      const parent = ref.getParent();
      if (parent?.getKind() !== SyntaxKind.BinaryExpression || parent.getLeft() !== ref) continue;
      if (parent.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) {
        results.push(unresolvedResult("compound assignment to a function variable"));
        continue;
      }
      const rhs = resolveValue(parent.getRight());
      results.push(rhs.param ? resolveParameterFromCallers(rhs.param) : rhs);
    }
    return results.length > 0 ? merge(results) : unresolvedResult("let/var with no value");
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
      return hasLibrarySignature(param.getType())
        ? { ...EMPTY, external: true }
        : unresolvedResult("function supplied to a callback's parameter");
    }
    if (directOwnerOf(site) === owner) return { ...EMPTY, param };
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
        return resolveValue(decl.getInitializer());
      case SyntaxKind.ShorthandPropertyAssignment: {
        if (!hasStableReceiver(site)) return unresolvedResult("member of an object that may be rebound");
        const valueDecl = decl.getValueSymbol?.()?.getDeclarations()[0];
        return valueDecl ? resolveDeclaration(valueDecl, decl.getNameNode()) : unresolvedResult("shorthand with no value");
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
        const pattern = decl.getParent();
        if (pattern?.getKind() === SyntaxKind.ArrayBindingPattern) {
          // `const [v, setV] = useState()`: an element of a library value is
          // library code; of anything else, it cannot be named.
          const holder = pattern.getParent();
          if (holder?.getKind() === SyntaxKind.VariableDeclaration && isConstVariable(holder) && holder.getInitializer()) {
            const source = resolveValue(holder.getInitializer());
            if (source.external && !source.unresolved && !source.param) return source;
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
          if (source.external && !source.unresolved && !source.param) return source;
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
        hit = target.fns.length > 0 || target.unresolved || target.param ? target : resolveValue(callee);
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
    hasLibrarySignature,
    usedExternalShapes,
    program,
  };
}
