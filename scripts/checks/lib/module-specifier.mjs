/**
 * "May this module specifier load module X", for gates that refuse every way a
 * file can reach a module other than a named import.
 *
 * check-crypto-domains (Check E) and check-mutation-response-read each carried
 * their own copy of this; one implementation, so a form the next review finds
 * is closed in both. Every answer it cannot decide is "may": these gates refuse
 * on "may", so an unreadable specifier fails closed.
 *
 * Targets are repo-relative module paths without an extension
 * (`src/lib/url-helpers`); `@/` is read as `src/`. Unlike `specifiersOf` in
 * function-resolver.mjs this asks no compiler: it decides one target by the
 * specifier's text, without resolving it to a file.
 */
import { posix } from "node:path";
import { SyntaxKind } from "ts-morph";
import { unwrapExpression, visibleBinding } from "./scope-bindings.mjs";

const isStringLiteral = (e) =>
  e?.getKind() === SyntaxKind.StringLiteral || e?.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral;

/**
 * Whether module specifier `spec` written in `fromRel` may name the module
 * `target`. With `prefixOnly`, `spec` is the literal head of a template: a
 * bundler resolves the template to files under that head, so it may name
 * `target` when `target` lies under it. A `..` in the template's dynamic tail
 * is outside that premise and is not considered.
 */
export function specifierMayName(spec, fromRel, target, prefixOnly = false) {
  let base;
  if (spec.startsWith("@/")) base = `src/${spec.slice(2)}`;
  else if (spec.startsWith(".")) base = posix.join(posix.dirname(fromRel), spec);
  // A head that stops inside "@/" ("" or "@") may still continue into the alias.
  else return prefixOnly && "@/".startsWith(spec);
  if (prefixOnly) return target.startsWith(base) || `${target}/index`.startsWith(base);
  return base.replace(/\.(tsx?|jsx?|mjs)$/, "").replace(/\/index$/, "") === target;
}

/** "import()" or "require()" when `call` loads a module by its argument, else null. */
export function moduleLoaderOf(call) {
  const callee = call.getExpression();
  if (callee.getKind() === SyntaxKind.ImportKeyword) return "import()";
  if (callee.getKind() === SyntaxKind.Identifier && callee.getText() === "require") return "require()";
  return null;
}

/**
 * Whether the module argument `arg` of an `import(…)` / `require(…)` in
 * `fromRel` may load any of `targets`: a string names one or not; a template
 * is matched on its literal head, and an identifier on the `const` string it is
 * bound to. A missing argument or any other expression may name any module.
 * `bindingsFor` is the memoizing thunk scope-bindings' `visibleBinding` takes.
 */
export function loadArgumentMayName(arg, fromRel, targets, bindingsFor) {
  const mayName = (spec, prefixOnly = false) => targets.some((t) => specifierMayName(spec, fromRel, t, prefixOnly));
  const e = unwrapExpression(arg);
  if (!e) return true;
  if (isStringLiteral(e)) return mayName(e.getLiteralText());
  if (e.getKind() === SyntaxKind.TemplateExpression) return mayName(e.getHead().getLiteralText(), true);
  if (e.getKind() === SyntaxKind.Identifier) {
    const decl = visibleBinding(e.getText(), e, bindingsFor);
    // Only a plain `const name = "…"` holds the string itself: a destructuring
    // (`const [s] = "./x"`) binds a piece of it, which may be "." or "@".
    const init =
      decl?.getKind() === SyntaxKind.VariableDeclaration &&
      decl.getNameNode().getKind() === SyntaxKind.Identifier &&
      decl.getVariableStatement?.()?.getDeclarationKind() === "const"
        ? unwrapExpression(decl.getInitializer())
        : null;
    if (isStringLiteral(init)) return mayName(init.getLiteralText());
  }
  return true;
}
