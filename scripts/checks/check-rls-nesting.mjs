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
 *     templates, own getter/setter accesses, `await` of an own `then`) and every
 *     function handed on as a value, wherever it is written. A root that
 *     reaches a base helper nests.
 *   - A WRAPPER is a function whose own parameter is reached from a context
 *     callback inside it, by whatever spelling (`fn()`, `const g = fn`,
 *     `fn.call`, `{ run: fn }`). Its argument at that position is a root at
 *     each call site. Derived to a fixpoint.
 *
 * Fail-closed: anything reached that the resolver cannot name — an
 * invocation, a function value, a parameter whose supplier is unknown — is
 * reported. So is a context function used as a value rather than called
 * directly (`withTenantRls.apply(…)`, passed to a library), and a context call
 * whose callback position follows a spread argument.
 *
 * Production code only — src/ and scripts/ minus tests, the CI tooling and
 * scripts/manual-tests (see isProductionPath).
 *
 * NOT covered, named so the next editor does not assume otherwise: the
 * iterator protocol (`for…of`/spread over an own iterable), implicit
 * conversions (toString/valueOf/Symbol.toPrimitive/toJSON), Proxy traps,
 * decorators, a getter reached through destructuring or a computed key, an
 * own function registered with a library earlier (an event listener, a timer)
 * and invoked by that library later — the library call that triggers it is
 * library code to this gate — a library object holding our code built OUTSIDE
 * the reached code (`const repo = makeRepo(prisma)` at module level), an object
 * literal's member written through an alias of an object that is returned
 * rather than held in a variable, and a module loaded through a non-literal
 * specifier (the production-boundary check reads literal ones only).
 */
import { SyntaxKind } from "ts-morph";
import { createProgramProject, ProgramBuildError } from "./lib/ast-project.mjs";
import {
  EXTERNAL_SHAPE_ALLOWLIST,
  LITERAL_FN_KINDS,
  createFunctionResolver,
  createReachability,
  NON_PRODUCTION_SCRIPTS,
  isDeclaredNonProduction,
  isProductionPath,
  toRelPosix,
  unwrap,
} from "./lib/function-resolver.mjs";
import { existsSync } from "node:fs";
import { join } from "node:path";

const HELPER_FILE = "src/lib/tenant-rls.ts";
const BASE_HELPERS = ["withTenantRls", "withBypassRls"];

// Callees that open a context only on a branch a call can opt out of. A call is
// exempt only when it is in the listed file, sits directly in a context
// callback, and passes that callback's own client as the `tx` property
// of its first argument — `derivePasskeyState({ …, tx })` inside
// `withBypassRls(prisma, async (tx) => …)`. Anything else (`tx` omitted,
// `tx: undefined`, an outer or optional parameter, a different file) is judged
// as the opener it is. An entry no call satisfies fails the run.
const CONDITIONAL_OPENER_ALLOWLIST = [
  // derivePasskeyState opens withBypassRls only when `params.tx` is absent
  // (src/lib/auth/policy/passkey-enforcement.ts).
  { file: "src/lib/mcp/oauth-server.ts", callee: "derivePasskeyState" },
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

const scanFiles = program.getSourceFiles().filter((sf) => isProductionPath(toRelPosix(sf.getFilePath())));
if (scanFiles.length === 0) {
  fail("no production source files under src/ or scripts/. Nothing was examined, so this is not a pass.");
}

const helperSf = program.getSourceFile(join(process.cwd(), HELPER_FILE));
if (!helperSf) fail(`${HELPER_FILE} is not in the Program; the base helpers cannot be resolved.`);

const resolver = createFunctionResolver({ program });
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

/**
 * The fns an edge must not count: a listed conditional opener called directly
 * in the context callback `root`, passing root's own first parameter as `tx`.
 */
function conditionallyExempt(edge, unit, root) {
  if (unit !== root || edge.kind !== "call" || edge.node.getKind() !== SyntaxKind.CallExpression) return [];
  const file = toRelPosix(edge.node.getSourceFile().getFilePath());
  const client = root.getParameters?.()[0];
  // The helper always passes its client to the callback, so the callback's
  // first parameter is defined at run time however it is declared.
  if (!client) return [];
  const arg = unwrap(edge.node.getArguments()[0]);
  if (arg?.getKind() !== SyntaxKind.ObjectLiteralExpression) return [];
  // A spread can override `tx` (`...(c ? { tx: undefined } : {})`), and a
  // second `tx` replaces the first: only one plain member decides.
  if (arg.getProperties().some((p) => p.getKind() === SyntaxKind.SpreadAssignment)) return [];
  if (arg.getProperties().filter((p) => p.getName?.() === "tx").length !== 1) return [];
  const prop = arg.getProperty("tx");
  let valueDecl = null;
  if (prop?.getKind() === SyntaxKind.ShorthandPropertyAssignment) {
    valueDecl = prop.getValueSymbol?.()?.getDeclarations()[0] ?? null;
  } else if (prop?.getKind() === SyntaxKind.PropertyAssignment) {
    const init = unwrap(prop.getInitializer());
    if (init?.getKind() === SyntaxKind.Identifier) valueDecl = init.getSymbol()?.getDeclarations()[0] ?? null;
  }
  if (valueDecl !== client) return [];
  const exempt = [];
  for (const fn of edge.r.fns) {
    const name = fn.getName?.() ?? fn.getParent()?.getName?.();
    const entry = CONDITIONAL_OPENER_ALLOWLIST.find((e) => e.file === file && e.callee === name);
    if (!entry) continue;
    usedConditional.add(`${entry.file}::${entry.callee}`);
    exempt.push(fn);
  }
  return exempt;
}

const reachHooks = {
  stop: (unit) => baseHelpers.has(unit),
  onParam: (param, _edge, _unit, root) => {
    if (param.getParent() === root) return "skip"; // the callback's own client
    if (enclosingParamHit(param, root)) return "skip"; // a wrapper; its callers' arguments are roots
    return undefined;
  },
  skipEdge: conditionallyExempt,
};

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
    const { info, unresolved } = reach(root, reachHooks);
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
    if (value.getType().getCallSignatures().length === 0) continue;
    const fns = resolveValue(value).fns.filter((f) => contextFns.has(f));
    if (fns.length === 0) continue;
    unfollowed.push({
      site: siteOf(value),
      outer: siteOf(value),
      reason: `context function ${label(fns[0])} used as a value; the callback it receives cannot be checked`,
    });
  }
}

// The production boundary both gates rely on: production code must not import
// a module outside it (a listed tooling script would then run in production
// unexamined), and listed tooling must not open RLS contexts or reach the
// database client (it is excluded on the premise that it does not).
const boundaryViolations = [];
for (const sf of program.getSourceFiles()) {
  const rel = toRelPosix(sf.getFilePath());
  const production = isProductionPath(rel);
  const tooling = NON_PRODUCTION_SCRIPTS.includes(rel);
  if (!production && !tooling) continue;
  const loads = sf
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((c) => {
      const callee = c.getExpression();
      return callee.getKind() === SyntaxKind.ImportKeyword || (callee.getKind() === SyntaxKind.Identifier && callee.getText() === "require");
    });
  const targets = [
    ...[...sf.getImportDeclarations(), ...sf.getExportDeclarations()].map((decl) => ({ decl, target: decl.getModuleSpecifierSourceFile?.() })),
    // `await import("…")` / `require("…")`: the module a literal specifier loads.
    ...loads.map((decl) => {
      const spec = decl.getArguments()[0];
      if (spec?.getKind() !== SyntaxKind.StringLiteral && spec?.getKind() !== SyntaxKind.NoSubstitutionTemplateLiteral) {
        return { decl, unresolvable: true };
      }
      const resolved = spec.getSymbol?.()?.getDeclarations()[0]?.getSourceFile?.() ?? null;
      return { decl, target: resolved };
    }),
  ];
  for (const { decl, target, unresolvable } of targets) {
    // A non-literal load is not followed (named in the header).
    if (unresolvable || !target) continue;
    const targetRel = toRelPosix(target.getFilePath());
    if (target.isDeclarationFile() || targetRel.includes("node_modules/")) continue;
    if (production && isDeclaredNonProduction(targetRel)) {
      boundaryViolations.push(`${siteOf(decl)}  production code imports ${targetRel}, which is declared non-production`);
    }
    if (tooling && (targetRel === HELPER_FILE || targetRel === "src/lib/tenant-context.ts" || targetRel === "src/lib/prisma.ts")) {
      boundaryViolations.push(`${siteOf(decl)}  ${rel} is listed as non-production tooling but imports ${targetRel}`);
    }
  }
}

const staleAllowlist = [
  ...CONDITIONAL_OPENER_ALLOWLIST.map((e) => `${e.file}::${e.callee}`).filter((k) => !usedConditional.has(k)),
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
  console.error("The production boundary (isProductionPath / NON_PRODUCTION_SCRIPTS) does not hold:");
  for (const v of boundaryViolations) console.error(`  ${v}`);
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
