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
 * The answer is the NEAREST enclosing call that opens a context around the code
 * the node is in:
 *   - an argument is evaluated before its call runs, in the context around the
 *     call. Only the function that IS the argument runs when the callee
 *     decides, and a read inside it runs in the context only through functions
 *     that run while it runs: an IIFE, or a function handed straight to a call
 *     that is not a scheduler. Round 7: a read that is itself the argument, or
 *     sits in a function nested inside the argument, was trusted. Round 8: a
 *     closure returned or stored out of the callback, an object method, a
 *     nested declaration or a `setTimeout` callback was trusted, and runs after
 *     the context has closed. A node evaluated at the call is stepped over;
 *     anything else is UNKNOWN — see `timingIn`;
 *   - an opener opens its context around its CALLBACK argument only — the
 *     position is in OPENERS. The client, tenant id and purpose are evaluated
 *     before the context exists (round 6, R49: a read inside `withBypassRls`'s
 *     client argument was trusted as a bypass). A spread at or before the
 *     callback's position hides which argument lands there: UNKNOWN;
 *   - a local name resolves to its innermost visible declaration (scope-bindings);
 *     only when none is visible does an import answer, by its ORIGINAL name;
 *   - a local wrapper opens a context only if it passes that argument's parameter
 *     into an opener's callback position (followed through further local
 *     wrappers). A spread at the call site hides which parameter receives the
 *     argument, so every parameter it could reach is asked;
 *   - a parameter, a `let`, a body-less declaration, a destructured or rest
 *     parameter, or a wrapper that also uses the callback outside its opener is
 *     UNKNOWN — the caller decides what runs, and a gate must not read that as
 *     either context.
 * A call that opens nothing this file can see (a `.map`, an imported helper that is
 * not an opener) is stepped over, and the walk continues outward, whatever
 * functions the argument holds: when such a helper runs them says nothing about
 * the context around the call. A helper handed a function inside an OPENER's
 * callback argument (`withBypassRls(prisma, pick(async (tx) => …), P)`) is the
 * other way round — whether `pick` runs it before the bypass opens is not in this
 * file — so that read is UNKNOWN, not trusted.
 */
import { SyntaxKind } from "ts-morph";
import { FN_KINDS, resolveLocalFunction, unwrapExpression, visibleBinding } from "./scope-bindings.mjs";

export const RLS_CONTEXT = Object.freeze({
  BYPASS: "bypass",
  TENANT: "tenant",
  UNKNOWN: "unknown",
});

/**
 * Each opener, the context it opens, and the argument index of the callback it
 * runs inside it — from the signatures in src/lib/tenant-rls.ts and
 * src/lib/tenant-context.ts.
 */
const OPENERS = new Map([
  ["withBypassRls", { context: RLS_CONTEXT.BYPASS, callback: 1 }], // (prisma, fn, purpose)
  ["withTenantRls", { context: RLS_CONTEXT.TENANT, callback: 2 }], // (prisma, tenantId, fn)
  ["withUserTenantRls", { context: RLS_CONTEXT.TENANT, callback: 1 }], // (userId, fn)
  ["withTeamTenantRls", { context: RLS_CONTEXT.TENANT, callback: 1 }], // (teamId, fn)
]);

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

/** When a node inside a call's argument runs, relative to the call. */
const TIMING = Object.freeze({ NOW: "now", LATER: "later", NESTED: "nested" });

/**
 * Every node that holds code which runs only when something calls it. FN_KINDS
 * alone missed an object method and a nested `function` declaration, so a read
 * in one read as if it ran where it was written (round 8, R8-S2).
 */
const FUNCTION_LIKE = new Set([
  ...FN_KINDS,
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
  SyntaxKind.Constructor,
]);

/** Calls that run their function argument after the current task instead of while the caller waits. */
const SCHEDULERS = new Set(["setTimeout", "setInterval", "setImmediate", "queueMicrotask", "nextTick"]);

/**
 * Does a function nested inside a callback run while that callback runs? Yes when
 * it is called on the spot (an IIFE), or handed straight to a call that is not a
 * scheduler (`.map(async …)`, `Promise.all(…)`, `.then(…)`, a helper). A function
 * that is returned, stored, attached to an object, declared, or scheduled runs
 * whenever something later calls it, which can be after the opener's transaction
 * has closed (round 8, R8-S2).
 */
function runsInline(fnNode) {
  let child = fnNode;
  let parent = fnNode.getParent();
  while (parent?.getKind() === SyntaxKind.ParenthesizedExpression) {
    child = parent;
    parent = parent.getParent();
  }
  if (parent?.getKind() !== SyntaxKind.CallExpression) return false;
  if (sameNode(parent.getExpression(), child)) return true;
  if (!parent.getArguments().some((arg) => sameNode(arg, child))) return false;
  const callee = unwrapExpression(parent.getExpression());
  const name = callee?.getKind() === SyntaxKind.PropertyAccessExpression ? callee.getName() : callee?.getText();
  return !SCHEDULERS.has(name);
}

/**
 * When `node`, inside `arg`, runs relative to the call that `arg` is passed to.
 *
 * - NOW: evaluated while the arguments are built — `node` is the argument itself,
 *   or no function lies between them.
 * - LATER: inside the function that IS the argument, after unwrapping parentheses
 *   and type assertions, and reached only through functions that run while it
 *   runs (`runsInline`). The callee decides when that runs.
 * - NESTED: anything else with a function in between — a function written within
 *   the argument that is not the argument (an IIFE, which runs BEFORE the callee,
 *   or `pick(fn)`, whose timing this file cannot see), or a function inside the
 *   callback that outlives it (round 8, R8-S2).
 *
 * Round 7 (R7-S1 / F-R7-1): the walk used to start at the node's parent and answer
 * "later" at the first function it met. A node that is the argument never meets
 * the argument, so it climbed out of the call and took whatever arrow enclosed the
 * call for the callback; and any function inside the argument counted, IIFEs
 * included.
 */
function timingIn(node, arg) {
  if (sameNode(node, arg)) return TIMING.NOW;
  const fn = unwrapExpression(arg);
  let nested = false;
  let outlives = false;
  for (let p = node.getParent(); p; p = p.getParent()) {
    if (FUNCTION_LIKE.has(p.getKind())) {
      if (sameNode(p, fn)) return outlives ? TIMING.NESTED : TIMING.LATER;
      nested = true;
      if (!runsInline(p)) outlives = true;
    }
    if (sameNode(p, arg)) break;
  }
  return nested ? TIMING.NESTED : TIMING.NOW;
}

/**
 * What a call to `calleeName` at `at` does to its argument at `argIndex`: opens a
 * context around it, might (UNKNOWN), or nothing this file can see (null).
 */
function contextOfCall(calleeName, at, argIndex, sf, bindingsFor, seen) {
  // Arguments before the first spread sit at their own index; from the spread on,
  // the index a parameter sees depends on the spread's length.
  const spread = at.getArguments().findIndex((arg) => arg.getKind() === SyntaxKind.SpreadElement);
  const shifted = spread !== -1 && spread <= argIndex;

  const binding = visibleBinding(calleeName, at, bindingsFor);
  if (!binding) {
    const opener = OPENERS.get(importedNameOf(calleeName, sf) ?? calleeName);
    if (!opener) return null;
    if (shifted && spread <= opener.callback) return RLS_CONTEXT.UNKNOWN;
    return argIndex === opener.callback ? opener.context : null;
  }
  const fn = resolveLocalFunction(calleeName, at, bindingsFor);
  // Bound locally but not to a function this file can read: a parameter, a
  // `let`, a body-less signature. Whatever runs is chosen elsewhere.
  if (!fn) return RLS_CONTEXT.UNKNOWN;
  if (shifted) {
    // Any parameter from the spread's index on may receive this argument. If none
    // of them reaches an opener, the call opens nothing whichever one it is.
    for (let i = spread; i < fn.getParameters().length; i += 1) {
      if (wrapperContext(fn, i, sf, bindingsFor, seen)) return RLS_CONTEXT.UNKNOWN;
    }
    return null;
  }
  return wrapperContext(fn, argIndex, sf, bindingsFor, seen);
}

/** The context a local function opens around what its caller passes at `argIndex`. */
function wrapperContext(fn, argIndex, sf, bindingsFor, seen) {
  const key = `${fn.getStart()}:${argIndex}`;
  if (seen.has(key)) return RLS_CONTEXT.UNKNOWN;
  seen.add(key);

  const params = fn.getParameters();
  const last = params.at(-1);
  // A rest parameter also collects every argument past its own index; reading
  // only `params[argIndex]` made those look like no parameter at all (null), and an
  // outer opener then answered for a callback this wrapper runs.
  const param = params[argIndex] ?? (last?.isRestParameter() ? last : null);
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
    // nothing — including an opener's non-callback argument: the callback also
    // runs where no opener is known.
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
    const args = n.getArguments();
    const argIndex = args.findIndex((arg) => arg.getStart() <= node.getStart() && node.getEnd() <= arg.getEnd());
    if (argIndex === -1) continue;
    const callee = unwrapExpression(n.getExpression());
    if (callee?.getKind() !== SyntaxKind.Identifier) continue;
    const context = contextOfCall(callee.getText(), n, argIndex, sf, bindingsFor, new Set());
    // A call that opens nothing around this argument says nothing about when the
    // node runs relative to the context outside it: keep walking.
    if (!context) continue;
    const timing = timingIn(node, args[argIndex]);
    if (timing === TIMING.LATER) return context;
    if (timing === TIMING.NESTED) return RLS_CONTEXT.UNKNOWN;
    // NOW: evaluated before this call opens anything, in the context around it.
  }
  return null;
}
