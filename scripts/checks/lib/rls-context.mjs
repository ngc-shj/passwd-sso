/**
 * Which RLS context encloses a node, as far as one file can tell.
 *
 * Shared by check-owning-tenant-adjudicator (a read of a user's tenant identity
 * must sit inside a TENANT context) and check-required-user-relation (a read of a
 * required User relation is exempt only inside a BYPASS). Both used to find a
 * wrapper by its name anywhere in the file and to trust any wrapper whose body
 * mentioned an opener, and both were red-proved blind to it
 * (audit-tenant-adjudicator round 5, S3/T2):
 *   - a sibling function's `const run = …withBypassRls` answered for this
 *     function's own `const run = …withTenantRls`;
 *   - a parameter named like a module-level bypass wrapper was trusted as it;
 *   - a wrapper that opened a bypass for some other read and ran the callback
 *     outside it was trusted as a bypass;
 *   - `import { withTenantRls as withBypassRls }` was trusted by its spelling.
 *
 * The answer is the NEAREST enclosing call that opens a context around the
 * argument the node is in:
 *   - a local name resolves to its innermost visible declaration (scope-bindings);
 *     only when none is visible does an import answer, by its ORIGINAL name;
 *   - a local wrapper opens a context only if it passes that argument's parameter
 *     into an opener (followed through further local wrappers);
 *   - a parameter, a `let`, a body-less declaration, or a wrapper that also uses
 *     the callback outside its opener is UNKNOWN — the caller decides what runs,
 *     and a gate must not read that as either context.
 * A call that opens nothing this file can see (a `.map`, an imported helper that is
 * not an opener) is stepped over, and the walk continues outward.
 */
import { SyntaxKind } from "ts-morph";
import { resolveLocalFunction, unwrapExpression, visibleBinding } from "./scope-bindings.mjs";

export const RLS_CONTEXT = Object.freeze({
  BYPASS: "bypass",
  TENANT: "tenant",
  UNKNOWN: "unknown",
});

const BYPASS_OPENER = "withBypassRls";
const TENANT_OPENERS = new Set(["withTenantRls", "withUserTenantRls", "withTeamTenantRls"]);

function openerContext(name) {
  if (name === BYPASS_OPENER) return RLS_CONTEXT.BYPASS;
  if (TENANT_OPENERS.has(name)) return RLS_CONTEXT.TENANT;
  return null;
}

/** The exported name behind a local import binding, or null if `name` is not imported. */
function importedNameOf(name, sf) {
  for (const decl of sf.getImportDeclarations()) {
    for (const spec of decl.getNamedImports()) {
      const local = spec.getAliasNode()?.getText() ?? spec.getName();
      if (local === name) return spec.getName();
    }
  }
  return null;
}

const sameNode = (a, b) => !!a && !!b && a.getStart() === b.getStart() && a.getEnd() === b.getEnd();

/**
 * What a call to `calleeName` at `at` does to its argument at `argIndex`: opens a
 * context around it, might (UNKNOWN), or nothing this file can see (null).
 */
function contextOfCall(calleeName, at, argIndex, sf, bindingsFor, seen) {
  const binding = visibleBinding(calleeName, at, bindingsFor);
  if (!binding) return openerContext(importedNameOf(calleeName, sf) ?? calleeName);
  const fn = resolveLocalFunction(calleeName, at, bindingsFor);
  // Bound locally but not to a function this file can read: a parameter, a
  // `let`, a body-less signature. Whatever runs is chosen elsewhere.
  if (!fn) return RLS_CONTEXT.UNKNOWN;
  return wrapperContext(fn, argIndex, sf, bindingsFor, seen);
}

/** The context a local function opens around what its caller passes at `argIndex`. */
function wrapperContext(fn, argIndex, sf, bindingsFor, seen) {
  const key = `${fn.getStart()}:${argIndex}`;
  if (seen.has(key)) return RLS_CONTEXT.UNKNOWN;
  seen.add(key);

  const param = fn.getParameters()[argIndex];
  if (!param) return null;
  const nameNode = param.getNameNode();
  // Destructured or rest: which value lands where is not something the tree says.
  if (nameNode.getKind() !== SyntaxKind.Identifier || param.isRestParameter()) {
    return RLS_CONTEXT.UNKNOWN;
  }
  const name = nameNode.getText();

  const opened = new Set();
  let usedOutside = false;
  for (const id of fn.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (id.getText() !== name || sameNode(id, nameNode)) continue;
    // An inner binding of the same name is a different value.
    if (!sameNode(visibleBinding(name, id, bindingsFor), param)) continue;
    const parent = id.getParent();
    if (parent?.getKind() === SyntaxKind.CallExpression) {
      const position = parent.getArguments().findIndex((arg) => sameNode(unwrapExpression(arg), id));
      const callee = unwrapExpression(parent.getExpression());
      if (position !== -1 && callee?.getKind() === SyntaxKind.Identifier) {
        const context = contextOfCall(callee.getText(), parent, position, sf, bindingsFor, seen);
        if (context) {
          opened.add(context);
          continue;
        }
      }
    }
    // Called directly, returned, stored, or handed to something that opens
    // nothing: the callback also runs where no opener is known.
    usedOutside = true;
  }

  if (opened.size === 0) return null;
  if (opened.size > 1 || usedOutside) return RLS_CONTEXT.UNKNOWN;
  return [...opened][0];
}

/**
 * The RLS context `node` runs in, as far as this file can tell: BYPASS, TENANT,
 * UNKNOWN, or null when no enclosing call opens one.
 *
 * `bindingsFor` is a memoizing thunk over `bindingIndex(sf)`.
 */
export function rlsContextOf(node, sf, bindingsFor) {
  for (let n = node.getParent(); n; n = n.getParent()) {
    if (n.getKind() !== SyntaxKind.CallExpression) continue;
    const argIndex = n
      .getArguments()
      .findIndex((arg) => arg.getStart() <= node.getStart() && node.getEnd() <= arg.getEnd());
    if (argIndex === -1) continue;
    const callee = unwrapExpression(n.getExpression());
    if (callee?.getKind() !== SyntaxKind.Identifier) continue;
    const context = contextOfCall(callee.getText(), n, argIndex, sf, bindingsFor, new Set());
    if (context) return context;
  }
  return null;
}
