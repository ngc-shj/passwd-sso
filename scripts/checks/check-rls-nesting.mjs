#!/usr/bin/env node
/**
 * CI guard: no RLS context is opened from inside another one.
 *
 * `assertNoActiveRlsContext` (src/lib/tenant-rls.ts) refuses a nested
 * withTenantRls / withBypassRls at run time with INVALID_RLS_NESTING, and logs
 * the refusal. That runtime guard is the enforcement boundary. It is
 * fail-closed only for a caller that propagates the error: one that swallows it
 * — `invalidateUserSessions(...).catch(() => null)`, the best-effort
 * notification and lockout-audit paths — skips a security side effect, and no
 * test notices unless it drives that exact nesting. This gate is the
 * development-time check for that class, with the coverage stated below.
 *
 * Mechanism: REACHABILITY, answered by the type-checked Program through
 * lib/function-resolver.mjs (shared with check-bypass-rls), not by spelling.
 *
 *   - Every context callback is a root: the argument at a base helper's
 *     declared callback position, or at a wrapper's derived one.
 *   - From a root, everything that can run is reached: invocations (calls,
 *     `new` — its field initializers, constructor and base classes — tagged
 *     templates, own getter/setter accesses, `await` of an own `then`), every
 *     function handed on as a value, wherever it is written (a name, a call's
 *     result, a conditional), and the own functions an argument to library code
 *     carries as members. A root that reaches a base helper nests.
 *   - A WRAPPER is a function whose own parameter is reached from a context
 *     callback inside it, by whatever spelling (`fn()`, `const g = fn`,
 *     `fn.call`, `{ run: fn }`). Its argument at that position is a root at
 *     each call site. Derived to a fixpoint.
 *
 * The resolver names a function by its DECLARATION: a member holds its
 * initializer, a class member is that member in the class and every subclass,
 * an interface member is every production member of that name. That is sound
 * only while nothing puts a function anywhere by other means, so the decidable
 * subset is enforced rather than assumed (lib/soundness.mjs, G1-G7): no write
 * of a function to a member after its declaration, no object mutator used but
 * by a direct call on what cannot hold functions, no computed-key or
 * parameter-property function member, no class derivation the language
 * service cannot enumerate, no object holding functions widened to a type that
 * names none of them, no value of unknown origin narrowed to one that holds
 * functions but a registered external shape from its package. A member of an
 * object literal is that literal's only on a receiver that provably holds it;
 * otherwise every literal that can stand in for the receiver's type may be
 * there. A library-declared member our code implements (an Adapter, a
 * `Pick<Console, "log">`) is library code only on a receiver traced to the
 * library. The scan set is
 * every own file not declared non-production and what it loads, and a module in it the gates cannot read
 * (own JavaScript, a declaration over it, a non-literal specifier outside
 * NON_LITERAL_LOAD_ALLOWLIST) is refused.
 *
 * Fail-closed: anything reached that the resolver cannot name — an
 * invocation, a function value, a parameter whose supplier is unknown, a value
 * a library holds or returns that may be ours, a callee typed `any` — is
 * reported. So is a context function used as a value rather than called
 * directly (`withTenantRls.apply(…)`, passed to a library), and a context call
 * whose callback position follows a spread argument.
 *
 * NOT covered, named so the next editor does not assume otherwise: the
 * iterator protocol (`for…of`/spread over an own iterable), implicit
 * conversions (toString/valueOf/Symbol.toPrimitive/toJSON), Proxy traps,
 * decorators, and an own function a library was given OUTSIDE the reached code
 * (an event listener or timer registered at module level, a library object
 * built around our code there — `const repo = makeRepo(prisma)`) and invoked
 * by that library from a library call inside it (#909, pinned as a known-limit
 * fixture). Inside the reached code, what is handed to a library is reached.
 * For what is not covered, the runtime guard still refuses the nested context
 * and logs rls.nesting_refused; a caller that swallows the error silently
 * skips the work it guarded (a notification, a session invalidation, an audit
 * write), and the structured log is how that is noticed.
 */
import { SyntaxKind } from "ts-morph";
import { createProgramProject, ProgramBuildError } from "./lib/ast-project.mjs";
import {
  EXTERNAL_SHAPE_ALLOWLIST,
  LITERAL_FN_KINDS,
  createFunctionResolver,
  createReachability,
  isBindingWrite,
  literalKey,
  mayBeCallable,
  mayHoldOwnCode,
  toRelPosix,
  unwrap,
} from "./lib/function-resolver.mjs";
import { functionFlowViolations, productionScope } from "./lib/soundness.mjs";
import { existsSync } from "node:fs";
import { join } from "node:path";

const HELPER_FILE = "src/lib/tenant-rls.ts";
const BASE_HELPERS = ["withTenantRls", "withBypassRls"];

// Callees that open a context only on a branch a call can opt out of. What is
// exempt is ONE edge inside the callee — the opener that is the false branch of
// `<first parameter>.<guard> ? … : opener(…)` — and only while every way the
// callee is entered in that context is an exempt call: in the listed file,
// directly in a context callback, passing that callback's own client (never
// reassigned) as the `<guard>` member of a plain object literal. The rest of
// the callee is checked as usual. An entry whose guarded opener is gone, or
// that no call uses, fails the run.
const CONDITIONAL_OPENER_ALLOWLIST = [
  {
    file: "src/lib/mcp/oauth-server.ts",
    callee: "derivePasskeyState",
    calleeFile: "src/lib/auth/policy/passkey-enforcement.ts",
    guard: "tx",
  },
];

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

const scope = productionScope(program);
const scanFiles = program.getSourceFiles().filter((sf) => scope.files.has(sf.getFilePath()));
if (scanFiles.length === 0) {
  fail("no production source files under src/ or scripts/. Nothing was examined, so this is not a pass.");
}

const helperSf = program.getSourceFile(join(process.cwd(), HELPER_FILE));
if (!helperSf) fail(`${HELPER_FILE} is not in the Program; the base helpers cannot be resolved.`);

const resolver = createFunctionResolver({ program, scope });
const { resolveValue, resolveCall } = resolver;
const { reach, chainTo } = createReachability(resolver);

/** fn → Set of callback parameter indices. */
const contextFns = new Map();
const baseHelpers = new Set();
for (const name of BASE_HELPERS) {
  const decl = helperSf.getFunction(name);
  if (!decl) fail(`${HELPER_FILE} declares no function ${name}.`);
  const impl = decl.getImplementation?.() ?? decl;
  const indices = new Set(
    impl
      .getParameters()
      .map((p, i) => (p.getType().getCallSignatures().length > 0 ? i : -1))
      .filter((i) => i >= 0),
  );
  if (indices.size === 0) fail(`${HELPER_FILE}'s ${name} declares no callback parameter.`);
  contextFns.set(impl, indices);
  baseHelpers.add(impl);
}

const label = (fn) => {
  const rel = toRelPosix(fn.getSourceFile().getFilePath());
  const name = fn.getName?.() ?? fn.getParent()?.getName?.() ?? "<anonymous>";
  return `${name} (${rel}:${fn.getStartLineNumber()})`;
};
const siteOf = (node) => `${toRelPosix(node.getSourceFile().getFilePath())}:${node.getStartLineNumber()}`;

const calls = scanFiles.flatMap((sf) => sf.getDescendantsOfKind(SyntaxKind.CallExpression));

// ─── Context calls and their roots ──────────────────────────────────────────

function contextIndicesOf(call) {
  const callee = unwrap(call.getExpression());
  // `.call`/`.apply` shift or pack the arguments; the receiver is reported as
  // a context function used as a value instead.
  if (callee?.getKind() === SyntaxKind.PropertyAccessExpression && ["call", "apply"].includes(callee.getName())) return null;
  const indices = new Set();
  for (const fn of resolveCall(call).fns) for (const i of contextFns.get(fn) ?? []) indices.add(i);
  return indices.size > 0 ? indices : null;
}

const paramIndexOf = (fn, param) => fn.getParameters?.().indexOf(param) ?? -1;
const isAncestor = (maybeAncestor, node) => node.getAncestors().includes(maybeAncestor);

/**
 * The roots a context call runs, the parameters it forwards (a wrapper's
 * pass-through), or a reason its callback cannot be located.
 */
function rootsOf(call) {
  const indices = contextIndicesOf(call);
  if (!indices) return null;
  const args = call.getArguments();
  if (args.slice(0, Math.max(...indices) + 1).some((a) => a.getKind() === SyntaxKind.SpreadElement)) {
    return { roots: [], forwarded: [], problem: "context call with a spread argument before its callback position" };
  }
  const roots = [];
  const forwarded = [];
  const problems = [];
  for (const i of indices) {
    const arg = unwrap(args[i]);
    if (!arg) continue;
    if (LITERAL_FN_KINDS.has(arg.getKind())) {
      roots.push(arg);
      continue;
    }
    const r = resolveValue(arg);
    for (const { param } of r.params) if (isAncestor(param.getParent(), call)) forwarded.push(param);
    roots.push(...r.fns);
    if (r.unresolved) problems.push(`callback is: ${r.unresolved}`);
  }
  return { roots, forwarded, problem: problems[0] ?? null };
}

/** A parameter of a function enclosing `root`: a caller-supplied callback running in this context. */
function enclosingParamHit(param, root) {
  const owner = param.getParent();
  return owner !== root && isAncestor(owner, root);
}

function registerWrapper(param) {
  const fn = param.getParent();
  const i = paramIndexOf(fn, param);
  if (i < 0) return false;
  const set = contextFns.get(fn) ?? new Set();
  if (set.has(i)) return false;
  set.add(i);
  contextFns.set(fn, set);
  return true;
}

// Wrapper fixpoint.
let grew = true;
while (grew) {
  grew = false;
  for (const call of calls) {
    const located = rootsOf(call);
    if (!located) continue;
    for (const p of located.forwarded) if (registerWrapper(p)) grew = true;
    for (const root of located.roots) {
      const hits = [];
      reach(root, {
        stop: (unit) => baseHelpers.has(unit),
        onParam: (param, _edge, _unit, r) => {
          if (param.getParent() === r) return "skip";
          if (enclosingParamHit(param, r)) {
            hits.push(param);
            return "skip";
          }
          return undefined;
        },
      });
      for (const p of hits) if (registerWrapper(p)) grew = true;
    }
  }
}

// ─── Conditional openers ────────────────────────────────────────────────────

const usedConditional = new Set();
const isWritten = (decl) =>
  decl.getNameNode().findReferences().some((g) => g.getReferences().some((r) => isBindingWrite(r) && r.getNode() !== decl.getNameNode()));

/** The callee and its guarded inner opener call for each entry, or a failure. */
const conditionalEntries = CONDITIONAL_OPENER_ALLOWLIST.filter((entry) => existsSync(entry.calleeFile)).map((entry) => {
  // (An entry whose callee's file is absent from the tree scanned — a fixture — is not judged.)
  const key = `${entry.file}::${entry.callee}`;
  const calleeFn = program.getSourceFile(join(process.cwd(), entry.calleeFile))?.getFunction(entry.callee);
  if (!calleeFn) fail(`CONDITIONAL_OPENER_ALLOWLIST ${key}: ${entry.calleeFile} declares no function ${entry.callee}.`);
  const params = calleeFn.getParameters()[0];
  if (!params) fail(`CONDITIONAL_OPENER_ALLOWLIST ${key}: ${entry.callee} has no parameter to guard on.`);
  const guarded = calleeFn.getDescendantsOfKind(SyntaxKind.CallExpression).filter((call) => {
    if (!resolveCall(call).fns.some((f) => baseHelpers.has(f))) return false;
    let cur = call;
    while ([SyntaxKind.AwaitExpression, SyntaxKind.ParenthesizedExpression].includes(cur.getParent()?.getKind())) cur = cur.getParent();
    const cond = cur.getParent();
    if (cond?.getKind() !== SyntaxKind.ConditionalExpression || cond.getWhenFalse() !== cur) return false;
    const test = unwrap(cond.getCondition());
    return (
      test?.getKind() === SyntaxKind.PropertyAccessExpression &&
      test.getName() === entry.guard &&
      unwrap(test.getExpression())?.getSymbol()?.getDeclarations()[0] === params
    );
  });
  if (guarded.length !== 1) fail(`CONDITIONAL_OPENER_ALLOWLIST ${key}: expected one opener guarded by ${params.getName()}.${entry.guard}, found ${guarded.length}.`);
  const change = guardChange(calleeFn, params, entry.guard);
  if (change) fail(`CONDITIONAL_OPENER_ALLOWLIST ${key}: ${change} inside ${entry.callee}, so its guard can change.`);
  return { ...entry, key, calleeFn, guardedCall: guarded[0] };
});

/**
 * How the guard `<params>.<guard>` can change inside `fn`, or null. Reading
 * the parameter (`params.userId`), copying it (`{ ...params }`) and
 * destructuring it are fine. What can change the guard: an assignment to the
 * member or the parameter (plain, compound, a destructuring target, a for-of
 * target), a `delete`, or the parameter leaving as a value (passed on,
 * aliased, returned), where anything could write it — an object mutator
 * included.
 */
function guardChange(fn, params, guard) {
  const name = params.getName();
  const inside = (node) => node.getAncestors().includes(fn);
  for (const group of params.getNameNode().findReferences()) {
    for (const entry of group.getReferences()) {
      const ref = entry.getNode();
      if (ref === params.getNameNode() || !inside(ref)) continue;
      if (isBindingWrite(entry)) return `${name} is reassigned`;
      const parent = ref.getParent();
      const pk = parent?.getKind();
      if ((pk === SyntaxKind.PropertyAccessExpression || pk === SyntaxKind.ElementAccessExpression) && parent.getExpression() === ref) {
        const member = pk === SyntaxKind.PropertyAccessExpression ? parent.getName() : literalKey(parent.getArgumentExpression());
        if (member !== null && member !== guard) {
          // A member that may be a function runs with the parameter as `this`
          // (or closes over it) wherever it is called: read as a function, the
          // parameter leaves as a value. Any other member is data.
          if (mayHoldOwnCode(parent.getType())) return `${name}.${member}, which may be a function, is read at ${siteOf(parent)}`;
          continue;
        }
        if (isWriteTarget(parent)) return member === null ? `${name} is written through a computed key` : `${name}.${guard} is written`;
        continue;
      }
      if (pk === SyntaxKind.SpreadAssignment || pk === SyntaxKind.SpreadElement) continue;
      if (pk === SyntaxKind.VariableDeclaration && parent.getInitializer() === ref && parent.getNameNode().getKind() === SyntaxKind.ObjectBindingPattern) continue;
      return `${name} leaves as a value at ${siteOf(ref)}`;
    }
  }
  return null;
}

/** Whether a member access is written: assigned, compound-assigned, deleted, incremented, or a destructuring/for-of target. */
function isWriteTarget(access) {
  let cur = access;
  while (cur.getParent()?.getKind() === SyntaxKind.ParenthesizedExpression) cur = cur.getParent();
  const parent = cur.getParent();
  switch (parent?.getKind()) {
    case SyntaxKind.BinaryExpression: {
      const op = parent.getOperatorToken().getKind();
      if (op >= SyntaxKind.FirstAssignment && op <= SyntaxKind.LastAssignment && parent.getLeft() === cur) return true;
      return false;
    }
    case SyntaxKind.DeleteExpression:
      return true;
    case SyntaxKind.PrefixUnaryExpression:
    case SyntaxKind.PostfixUnaryExpression: {
      const op = parent.getOperatorToken();
      return op === SyntaxKind.PlusPlusToken || op === SyntaxKind.MinusMinusToken;
    }
    case SyntaxKind.ForOfStatement:
    case SyntaxKind.ForInStatement:
      return parent.getInitializer() === cur;
    case SyntaxKind.PropertyAssignment:
    case SyntaxKind.ShorthandPropertyAssignment:
    case SyntaxKind.ArrayLiteralExpression:
    case SyntaxKind.SpreadElement:
    case SyntaxKind.SpreadAssignment: {
      // A leaf of a destructuring assignment: `({ tx: p.tx } = o)`, `[p.tx] = a`.
      let up = parent;
      while ([SyntaxKind.PropertyAssignment, SyntaxKind.ShorthandPropertyAssignment, SyntaxKind.ObjectLiteralExpression,
        SyntaxKind.ArrayLiteralExpression, SyntaxKind.SpreadElement, SyntaxKind.SpreadAssignment].includes(up.getParent()?.getKind())) {
        up = up.getParent();
      }
      const holder = up.getParent();
      return holder?.getKind() === SyntaxKind.BinaryExpression && holder.getOperatorToken().getKind() === SyntaxKind.EqualsToken && holder.getLeft() === up;
    }
    default:
      return false;
  }
}

/** Whether `edge`, from the context callback `root`, is an exempt call to `entry`'s callee. */
function isExemptCall(entry, edge, unit, root) {
  if (unit !== root || edge.kind !== "call" || edge.node.getKind() !== SyntaxKind.CallExpression) return false;
  if (toRelPosix(edge.node.getSourceFile().getFilePath()) !== entry.file) return false;
  const client = root.getParameters?.()[0];
  // The helper always passes its client, so the first parameter is defined;
  // reassigning it could replace it with anything.
  if (!client || isWritten(client)) return false;
  const arg = unwrap(edge.node.getArguments()[0]);
  if (arg?.getKind() !== SyntaxKind.ObjectLiteralExpression) return false;
  // A spread can override the member, and a second one replaces the first.
  if (arg.getProperties().some((p) => p.getKind() === SyntaxKind.SpreadAssignment)) return false;
  if (arg.getProperties().filter((p) => p.getName?.() === entry.guard).length !== 1) return false;
  const prop = arg.getProperty(entry.guard);
  let valueDecl = null;
  if (prop?.getKind() === SyntaxKind.ShorthandPropertyAssignment) {
    valueDecl = prop.getValueSymbol?.()?.getDeclarations()[0] ?? null;
  } else if (prop?.getKind() === SyntaxKind.PropertyAssignment) {
    const init = unwrap(prop.getInitializer());
    if (init?.getKind() === SyntaxKind.Identifier) valueDecl = init.getSymbol()?.getDeclarations()[0] ?? null;
  }
  return valueDecl === client;
}

/** Reach hooks for one root; `state` records how each listed callee was entered. */
function hooksFor(state) {
  return {
    stop: (unit) => baseHelpers.has(unit),
    onParam: (param, _edge, _unit, root) => {
      if (param.getParent() === root) return "skip"; // the callback's own client
      if (enclosingParamHit(param, root)) return "skip"; // a wrapper; its callers' arguments are roots
      return undefined;
    },
    skipEdge: (edge, unit, root) => {
      for (const entry of conditionalEntries) {
        if (!edge.r.fns.includes(entry.calleeFn)) continue;
        if (!state.disabled && isExemptCall(entry, edge, unit, root)) {
          state.exempt.add(entry.calleeFn);
          usedConditional.add(entry.key);
        } else {
          state.plain.add(entry.calleeFn);
        }
      }
      if (state.disabled) return [];
      const entry = conditionalEntries.find((e) => e.calleeFn === unit && e.guardedCall === edge.node);
      return entry && state.exempt.has(unit) ? edge.r.fns.filter((f) => baseHelpers.has(f)) : [];
    },
  };
}

/** Reach from `root`; once more without exemptions if a listed callee was also entered plainly. */
function reachRoot(root) {
  const state = { exempt: new Set(), plain: new Set(), disabled: false };
  const result = reach(root, hooksFor(state));
  if (![...state.exempt].some((fn) => state.plain.has(fn))) return result;
  return reach(root, hooksFor({ exempt: new Set(), plain: new Set(), disabled: true }));
}

// ─── Check every root ───────────────────────────────────────────────────────

const violations = [];
const unfollowed = [];

/** "calls X (…) reaches Y (…)" from the root's first edge to `unit`. */
function describeChain(info, unit) {
  const steps = chainTo(info, unit).slice(1);
  if (steps.length === 0) return { site: null, text: "" };
  const first = info.get(steps[0]).edge;
  const how = first.kind === "value" ? "hands on" : "calls";
  return { site: siteOf(first.node), text: `${how} ${steps.map(label).join(" reaches ")}` };
}

let callbackCount = 0;
let contextCallCount = 0;
for (const call of calls) {
  const located = rootsOf(call);
  if (!located) continue;
  contextCallCount += 1;
  if (located.problem) unfollowed.push({ site: siteOf(call), outer: siteOf(call), reason: located.problem });
  for (const root of located.roots) {
    callbackCount += 1;
    const { info, unresolved } = reachRoot(root);
    for (const unit of info.keys()) {
      if (!baseHelpers.has(unit) || unit === root) continue;
      const { site, text } = describeChain(info, unit);
      violations.push({ site: site ?? siteOf(call), outer: siteOf(call), what: text });
    }
    for (const u of unresolved) {
      if (u.unit === root) {
        unfollowed.push({ site: siteOf(u.node), outer: siteOf(call), reason: u.reason });
      } else {
        const { site, text } = describeChain(info, u.unit);
        unfollowed.push({ site: site ?? siteOf(u.node), outer: siteOf(call), reason: `${text}, which ${u.reason} at ${siteOf(u.node)}` });
      }
    }
  }
}

// A context function used as a value: its callback is out of sight.
for (const sf of scanFiles) {
  const calleeNodes = new Set();
  for (const k of [SyntaxKind.CallExpression, SyntaxKind.NewExpression]) {
    for (const c of sf.getDescendantsOfKind(k)) calleeNodes.add(unwrap(c.getExpression()));
  }
  for (const id of sf.getDescendantsOfKind(SyntaxKind.Identifier)) {
    const parent = id.getParent();
    const pk = parent?.getKind();
    if (
      pk === SyntaxKind.ImportSpecifier ||
      pk === SyntaxKind.ExportSpecifier ||
      pk === SyntaxKind.ImportClause ||
      pk === SyntaxKind.NamespaceImport ||
      (parent?.getNameNode?.() === id && pk !== SyntaxKind.PropertyAccessExpression)
    ) {
      continue;
    }
    if (id.getFirstAncestor((a) => a.getKind() >= SyntaxKind.FirstTypeNode && a.getKind() <= SyntaxKind.LastTypeNode)) continue;
    let value = id;
    if (pk === SyntaxKind.PropertyAccessExpression) {
      if (parent.getNameNode() === id) value = parent;
      else if (!["bind", "call", "apply"].includes(parent.getName())) continue;
    }
    if (calleeNodes.has(value)) continue;
    if (!mayBeCallable(value.getType())) continue;
    const fns = resolveValue(value).fns.filter((f) => contextFns.has(f));
    if (fns.length === 0) continue;
    unfollowed.push({
      site: siteOf(value),
      outer: siteOf(value),
      reason: `context function ${label(fns[0])} used as a value; the callback it receives cannot be checked`,
    });
  }
}

// What the resolver's answers rest on: the production boundary, and the rules
// that make a member hold only what its declaration says (lib/soundness.mjs).
// check-bypass-rls checks the same itself, so each gate refuses on its own.
const boundaryViolations = scope.violations;
const flowViolations = functionFlowViolations(program, scope, resolver.usedExternalShapes);

const staleAllowlist = [
  ...conditionalEntries.map((e) => e.key).filter((k) => !usedConditional.has(k)),
  ...[...EXTERNAL_SHAPE_ALLOWLIST.keys()].filter((k) => !resolver.usedExternalShapes.has(k)),
].filter((k) => existsSync(k.split("::")[0]));

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
    console.error(`  ${v.site}  (inside the context opened at ${v.outer}) ${v.what}`);
  }
}

if (unfollowed.length > 0) {
  failed = true;
  if (violations.length > 0) console.error("");
  console.error("A context callback reaches something this gate cannot follow, so whether it");
  console.error("opens a nested RLS context is unknown. Make the callee resolvable (a function");
  console.error("with a body, held in a const or imported) or move it out of the callback:");
  console.error("");
  for (const u of dedupe(unfollowed, (u) => `${u.site}|${u.reason}`)) {
    const where = u.outer === u.site ? "" : `(inside the context opened at ${u.outer}) `;
    console.error(`  ${u.site}  ${where}${u.reason}`);
  }
}

if (boundaryViolations.length > 0) {
  failed = true;
  console.error("");
  console.error("The production boundary does not hold. Production is every own file not declared");
  console.error("non-production (NON_PRODUCTION / NON_PRODUCTION_SCRIPTS), and every module it loads;");
  console.error("each must be code the gates can read, and each declaration must name a real file:");
  for (const v of boundaryViolations) console.error(`  ${v}`);
}

if (flowViolations.length > 0) {
  failed = true;
  console.error("");
  console.error("A function is put somewhere its declaration does not say, so neither RLS gate can");
  console.error("tell what runs there (lib/soundness.mjs G1-G5). Give the member its value where it");
  console.error("is declared, or make it a method:");
  for (const v of flowViolations) console.error(`  ${v}`);
}

if (staleAllowlist.length > 0) {
  failed = true;
  console.error("");
  console.error("An allowlist entry matches nothing (CONDITIONAL_OPENER_ALLOWLIST / EXTERNAL_SHAPE_ALLOWLIST). Remove it:");
  for (const k of staleAllowlist) console.error(`  ${k}`);
}

if (failed) process.exit(1);

console.log(
  `check-rls-nesting: OK (${scanFiles.length} files, ${contextFns.size} context functions, ` +
    `${contextCallCount} context calls, ${callbackCount} callbacks checked)`,
);
