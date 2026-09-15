/**
 * Scope-aware name resolution for AST gates that run without a Program.
 *
 * Extracted from check-bypass-rls, whose five review rounds each found a
 * predicate that judged code by its spelling — the last one a callback name
 * resolved against the whole file, so an unrelated same-named binding elsewhere
 * answered for it. The tenant gates (check-owning-tenant-adjudicator,
 * check-required-user-relation) then copied the file-wide version and shipped the
 * same defect (audit-tenant-adjudicator round 5, S3/T2). One implementation, so
 * the next fix lands in every gate that decides a question by a name.
 *
 * Without a Program there is no symbol table; this answers "which declaration
 * does this name mean HERE" from the tree alone: the innermost declaration whose
 * scope encloses the use. It does not follow imports, and it refuses — returns
 * null — rather than guessing when the answer is a parameter, a `let`, or an
 * initializer that is not a function.
 */
import { SyntaxKind } from "ts-morph";

export const FN_KINDS = new Set([SyntaxKind.ArrowFunction, SyntaxKind.FunctionExpression]);

// Node kinds that open a scope, for deciding whether a declaration is visible
// from a call site.
const SCOPE_KINDS = new Set([
  SyntaxKind.SourceFile,
  SyntaxKind.Block,
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.Constructor,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
  SyntaxKind.ModuleDeclaration,
]);

/** The nearest ancestor of `node` that introduces a scope. */
export function scopeOf(node) {
  for (let p = node.getParent(); p; p = p.getParent()) {
    if (SCOPE_KINDS.has(p.getKind())) return p;
  }
  return null;
}

/**
 * Every declaration in the file that binds a name, indexed by that name.
 * Build it once per source file and pass a memoizing thunk (`bindingsFor`):
 * rebuilding it per lookup walks the whole tree for every call considered.
 *
 * All binding kinds are indexed, not only the function-valued ones. Counting
 * only functions is what let an unrelated `const job = async (tx) => …` in a
 * sibling function satisfy a `job` that actually refers to the enclosing
 * function's own parameter — the gate then scanned a body the call never runs
 * and reported OK, in place of the "could not be resolved" report.
 */
export function bindingIndex(sf) {
  const index = new Map();
  const add = (name, decl) => {
    const bucket = index.get(name);
    if (bucket) bucket.push(decl);
    else index.set(name, [decl]);
  };
  const kinds = [
    SyntaxKind.VariableDeclaration,
    SyntaxKind.FunctionDeclaration,
    SyntaxKind.Parameter,
  ];
  for (const kind of kinds) {
    for (const decl of sf.getDescendantsOfKind(kind)) {
      // A destructuring declaration binds each element's name, not the pattern.
      // `getName()` returns the pattern text ("{ job }"), which no identifier can
      // equal — so indexing by it would leave `job` looking unbound, and an
      // unrelated `job` elsewhere would then resolve as the unique candidate.
      const nameNode = decl.getNameNode?.();
      if (nameNode && nameNode.getKind() !== SyntaxKind.Identifier) {
        for (const el of nameNode.getDescendantsOfKind(SyntaxKind.BindingElement)) {
          add(el.getName(), decl);
        }
        continue;
      }
      const name = decl.getName?.();
      if (name) add(name, decl);
    }
  }
  return index;
}

/**
 * The declaration `name` refers to at `at`: of the declarations whose scope
 * encloses `at`, the innermost — JavaScript picks the innermost binding, so the
 * gate does too. Null when none is visible.
 */
export function visibleBinding(name, at, bindingsFor) {
  const visible = (bindingsFor().get(name) ?? []).filter((decl) => {
    const scope = scopeOf(decl);
    return scope && scope.getStart() <= at.getStart() && at.getEnd() <= scope.getEnd();
  });
  if (visible.length === 0) return null;
  let best = visible[0];
  let span = scopeOf(best).getEnd() - scopeOf(best).getStart();
  for (const candidate of visible.slice(1)) {
    const scope = scopeOf(candidate);
    const width = scope.getEnd() - scope.getStart();
    if (width < span) {
      span = width;
      best = candidate;
    }
  }
  return best;
}

/**
 * The function `name` names at `at`, when this file can say. Ambiguity,
 * invisibility, or a binding that is not a function all return null, and the
 * caller reports the site: guessing is how these gates were wrong.
 */
export function resolveLocalFunction(name, at, bindingsFor, seen = new Set()) {
  const decl = visibleBinding(name, at, bindingsFor);
  if (!decl) return null;

  const id = `${decl.getStart()}:${decl.getEnd()}`;
  if (seen.has(id)) return null;
  seen.add(id);

  // A declaration without a body (an ambient or overload signature) says the
  // implementation is elsewhere, so this file cannot answer.
  if (decl.getKind() === SyntaxKind.FunctionDeclaration) {
    return decl.getBody() ? decl : null;
  }

  // Only a `const` initializer answers "which function runs here". A
  // parameter's initializer is its DEFAULT — one of the values a caller may
  // supply, not the one supplied at any call that passes an argument. A
  // `let`/`var` binding can hold a different function by the time it runs.
  if (decl.getKind() !== SyntaxKind.VariableDeclaration) return null;
  if (decl.getVariableStatement?.()?.getDeclarationKind() !== "const") return null;
  const init = unwrapExpression(decl.getInitializer());
  if (init && FN_KINDS.has(init.getKind())) return init;
  // `const aliasedQuery = query` names a function without being one. Follow it
  // from the ALIAS's own position, not the call's — that is where the name it
  // mentions is resolved — and stop on a declaration already visited, which
  // ends a cycle without a depth limit a longer chain could step over.
  if (init?.getKind() === SyntaxKind.Identifier) {
    return resolveLocalFunction(init.getText(), init, bindingsFor, seen);
  }
  return null;
}

/**
 * The object literal a local `const` name is bound to at `at`, if any. The
 * binding is chosen FIRST and then asked what it holds: filtering candidates to
 * object literals before choosing lets an outer object answer for an inner
 * `const x = other`.
 */
export function resolveLocalObjectLiteral(name, at, bindingsFor) {
  const best = visibleBinding(name, at, bindingsFor);
  if (!best || best.getKind() !== SyntaxKind.VariableDeclaration) return null;
  // `let`/`var` can hold a different object by the time the call runs, so only
  // a `const` initializer answers what this name holds.
  if (best.getVariableStatement?.()?.getDeclarationKind() !== "const") return null;
  const init = unwrapExpression(best.getInitializer());
  return init?.getKind() === SyntaxKind.ObjectLiteralExpression ? init : null;
}

/** An expression with its type-level wrappers removed. */
export function unwrapExpression(expr) {
  switch (expr?.getKind()) {
    case SyntaxKind.ParenthesizedExpression:
    case SyntaxKind.AsExpression:
    case SyntaxKind.NonNullExpression:
    case SyntaxKind.SatisfiesExpression:
      return unwrapExpression(expr.getExpression());
    default:
      return expr;
  }
}
