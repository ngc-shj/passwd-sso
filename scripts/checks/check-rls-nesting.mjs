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
 * Everything is answered by the type-checked Program through
 * lib/function-resolver.mjs (shared with check-bypass-rls), not by spelling:
 *
 *   - OPENERS: the two base helpers, and every function that invokes an opener
 *     or holds one as a value — a fixpoint over resolved callees.
 *   - CONTEXT FUNCTIONS: the base helpers, whose callback is the argument at
 *     their declared callback position, and every WRAPPER — a function whose
 *     own parameter runs inside a context it opens (withUserTenantRls,
 *     withTeamTenantRls, a route's local withVaultTenantRls). Also a fixpoint.
 *   - A context callback is checked invocation by invocation, and every value
 *     reference inside it — `items.map(opener)`, `[opener]`, `opener.bind(…)`,
 *     an opener in an object literal. A function literal passed to an ordinary
 *     call inside the callback (`items.map(async (x) => …)`) runs inside the
 *     same context and is checked as part of it.
 *   - Invocations are calls, `new`, tagged templates, property reads and writes
 *     that land on an own getter/setter, and `await` of a value whose `then` is
 *     an own method.
 *
 * Fail-closed: an invocation or function-valued reference the resolver cannot
 * name is not assumed harmless. Inside a callback it is reported. Anywhere else
 * it marks its enclosing function UNDECIDABLE, and reaching an undecidable
 * function from a callback is reported too. A context function used as a value
 * rather than called directly (`withTenantRls.apply(…)`, passed to a library)
 * is reported wherever it occurs, because its callback cannot be checked; so is
 * a context call whose callback position follows a spread argument.
 *
 * Production code only — src/ and scripts/ minus tests, the CI tooling and
 * scripts/manual-tests (see isProductionPath).
 *
 * NOT covered, named so the next editor does not assume otherwise: the
 * iterator protocol (`for…of`/spread over an own iterable), implicit
 * conversions (toString/valueOf/Symbol.toPrimitive/toJSON), Proxy traps,
 * decorators, a getter reached through destructuring or a computed key, and an
 * own function registered with a library earlier (an event listener, a timer)
 * and invoked by that library later — the library call that triggers it is
 * library code to this gate.
 */
import { SyntaxKind } from "ts-morph";
import { createProgramProject, ProgramBuildError } from "./lib/ast-project.mjs";
import {
  EXTERNAL_SHAPE_ALLOWLIST,
  FN_KINDS,
  LITERAL_FN_KINDS,
  createFunctionResolver,
  isProductionPath,
  toRelPosix,
  unwrap,
} from "./lib/function-resolver.mjs";
import { existsSync } from "node:fs";
import { join } from "node:path";

const HELPER_FILE = "src/lib/tenant-rls.ts";
const BASE_HELPERS = ["withTenantRls", "withBypassRls"];

// Callees that open a context only on a branch a call can opt out of. A call is
// exempt only when it is in the listed file AND its first argument is an object
// literal whose `tx` property names a parameter of an enclosing function — the
// outer context's client. Anything else (`tx` omitted, `tx: undefined`, a
// different file) is judged as the opener it is. An entry no call satisfies
// fails the run.
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
const { resolveValue, resolveCall, isExternal } = resolver;

/** fn → Set of callback parameter indices. */
const contextFns = new Map();
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
}

const label = (fn) => {
  const rel = toRelPosix(fn.getSourceFile().getFilePath());
  const name = fn.getName?.() ?? fn.getParent()?.getName?.() ?? "<anonymous>";
  return `${name} (${rel}:${fn.getStartLineNumber()})`;
};
const siteOf = (node) => `${toRelPosix(node.getSourceFile().getFilePath())}:${node.getStartLineNumber()}`;

// ─── Invocations and references ─────────────────────────────────────────────

const ownAccessorNames = new Set();
for (const sf of scanFiles) {
  for (const k of [SyntaxKind.GetAccessor, SyntaxKind.SetAccessor]) {
    for (const a of sf.getDescendantsOfKind(k)) ownAccessorNames.add(a.getName());
  }
}

/** An awaited value whose `then` is an own method: `await` calls it. */
function thenOf(awaitExpr) {
  const prop = awaitExpr.getExpression().getType().getProperty("then");
  const decls = (prop?.getDeclarations() ?? []).filter((d) => !isExternal(d));
  if (decls.length === 0) return null;
  const fns = [];
  for (const d of decls) {
    const fn = resolver.functionOfDeclaration(d) ?? (d.getKind() === SyntaxKind.PropertyAssignment ? resolveValue(d.getInitializer()).fns[0] : null);
    if (!fn) return { fns: [], external: false, param: null, unresolved: "awaited value's then() cannot be named" };
    fns.push(fn);
  }
  return { fns, external: false, param: null, unresolved: null };
}

const invocations = [];
const invocationResult = new Map();
for (const sf of scanFiles) {
  invocations.push(...sf.getDescendantsOfKind(SyntaxKind.CallExpression));
  invocations.push(...sf.getDescendantsOfKind(SyntaxKind.NewExpression));
  invocations.push(...sf.getDescendantsOfKind(SyntaxKind.TaggedTemplateExpression));
  for (const pae of sf.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
    if (ownAccessorNames.has(pae.getName()) && resolver.isAccessorInvocation(pae)) invocations.push(pae);
  }
  for (const aw of sf.getDescendantsOfKind(SyntaxKind.AwaitExpression)) {
    const then = thenOf(aw);
    if (then) {
      invocations.push(aw);
      invocationResult.set(aw, then);
    }
  }
}

const resolveInvocation = (node) => invocationResult.get(node) ?? resolveCall(node);
const invocationSet = new Set(invocations);

/** The callee expression of an invocation, which is not a "value reference". */
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

const DECLARATION_NAME_PARENTS = new Set([
  SyntaxKind.VariableDeclaration,
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.Parameter,
  SyntaxKind.BindingElement,
  SyntaxKind.PropertyAssignment,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.PropertyDeclaration,
  SyntaxKind.PropertySignature,
  SyntaxKind.MethodSignature,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
  SyntaxKind.ClassDeclaration,
  SyntaxKind.InterfaceDeclaration,
  SyntaxKind.TypeAliasDeclaration,
  SyntaxKind.EnumDeclaration,
  SyntaxKind.EnumMember,
  SyntaxKind.ImportSpecifier,
  SyntaxKind.ExportSpecifier,
  SyntaxKind.ImportClause,
  SyntaxKind.NamespaceImport,
  SyntaxKind.LabeledStatement,
]);

const calleeNodes = new Set(invocations.map(calleeNodeOf).filter(Boolean));

/**
 * A function value used other than as the callee of an invocation: the value
 * expression (an identifier, or the whole `a.b` for a member name) and what it
 * resolves to. Only identifiers whose symbol is declared in our code and whose
 * type is callable are considered — a data value cannot be an opener.
 */
const references = [];
for (const sf of scanFiles) {
  for (const id of sf.getDescendantsOfKind(SyntaxKind.Identifier)) {
    const parent = id.getParent();
    let value = id;
    if (parent?.getKind() === SyntaxKind.PropertyAccessExpression) {
      if (parent.getNameNode() === id) value = parent;
      // The receiver of `a.b` is not handed on by the access — except
      // `fn.bind/.call/.apply`, which hand `fn` itself to the runtime.
      else if (!["bind", "call", "apply"].includes(parent.getName())) continue;
    }
    if (DECLARATION_NAME_PARENTS.has(parent?.getKind()) && parent.getNameNode?.() === id) continue;
    if (id.getFirstAncestor((a) => a.getKind() >= SyntaxKind.FirstTypeNode && a.getKind() <= SyntaxKind.LastTypeNode)) continue;
    if (calleeNodes.has(value) || invocationSet.has(value)) continue;
    // A JSX tag is rendered by React after the enclosing function returns, not
    // invoked where it is written.
    const tagHolder = value.getParent()?.getKind();
    if (tagHolder === SyntaxKind.JsxOpeningElement || tagHolder === SyntaxKind.JsxSelfClosingElement || tagHolder === SyntaxKind.JsxClosingElement) continue;
    // A `.call`/`.apply`/`.bind` receiver IS a value reference: handled below.
    let symbol = value.getSymbol?.();
    if (symbol?.isAlias()) symbol = symbol.getAliasedSymbol();
    const decls = symbol?.getDeclarations() ?? [];
    if (decls.length === 0 || decls.every(isExternal)) continue;
    if (value.getType().getCallSignatures().length === 0) continue;
    references.push(value);
  }
}

// ─── Context calls ──────────────────────────────────────────────────────────

function contextIndicesOf(call) {
  if (call.getKind() !== SyntaxKind.CallExpression) return null;
  const callee = unwrap(call.getExpression());
  // `.call`/`.apply` shift or pack the arguments; the receiver is reported as
  // a context function used as a value instead.
  if (callee?.getKind() === SyntaxKind.PropertyAccessExpression && ["call", "apply"].includes(callee.getName())) return null;
  const indices = new Set();
  for (const fn of resolveCall(call).fns) for (const i of contextFns.get(fn) ?? []) indices.add(i);
  return indices.size > 0 ? indices : null;
}

/** The arguments of a context call that run inside the context, or a reason they cannot be located. */
function callbackArgsOf(call) {
  const indices = contextIndicesOf(call);
  if (!indices) return { args: [] };
  const args = call.getArguments();
  const last = Math.max(...indices);
  if (args.slice(0, last + 1).some((a) => a.getKind() === SyntaxKind.SpreadElement)) {
    return { args: [], problem: "context call with a spread argument before its callback position" };
  }
  return { args: [...indices].map((i) => args[i]).filter(Boolean) };
}

const callbackMemo = new Map();
function callbacksOf(call) {
  if (!callbackMemo.has(call)) callbackMemo.set(call, callbackArgsOf(call));
  return callbackMemo.get(call);
}

function isInlineArgument(fn) {
  const parent = fn.getParent();
  return (
    LITERAL_FN_KINDS.has(fn.getKind()) &&
    (parent?.getKind() === SyntaxKind.CallExpression || parent?.getKind() === SyntaxKind.NewExpression) &&
    parent.getArguments().includes(fn)
  );
}

/** The function a node's execution belongs to, climbing past inline literals of ordinary calls. */
function ownerOf(node) {
  for (let cur = node.getParent(); cur; cur = cur.getParent()) {
    if (!FN_KINDS.has(cur.getKind())) continue;
    if (isInlineArgument(cur) && !callbacksOf(cur.getParent()).args.includes(cur)) continue;
    return cur;
  }
  return null;
}

// Wrapper fixpoint: a function whose own parameter runs inside a context it opens.
function paramIndexOf(fn, paramDecl) {
  return fn.getParameters?.().indexOf(paramDecl) ?? -1;
}

/**
 * The enclosing function's parameters this callback literal runs: invoked, or
 * handed on as a function value. A data parameter it merely reads (`req`,
 * `userId`) does not make the enclosing function a wrapper.
 */
function paramsRunIn(literal) {
  const out = [];
  for (const id of literal.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (id.getType().getCallSignatures().length === 0) continue;
    const parent = id.getParent();
    const invoked = calleeNodes.has(id);
    const handedOn =
      (parent?.getKind() === SyntaxKind.CallExpression || parent?.getKind() === SyntaxKind.NewExpression) &&
      parent.getArguments().includes(id);
    if (!invoked && !handedOn) continue;
    const decl = id.getSymbol()?.getDeclarations()[0];
    if (decl?.getKind() === SyntaxKind.Parameter) out.push(decl);
  }
  return out;
}

let grew = true;
while (grew) {
  grew = false;
  for (const call of invocations) {
    const { args } = callbacksOf(call);
    if (args.length === 0) continue;
    const wrapper = ownerOf(call);
    if (!wrapper) continue;
    const found = new Set();
    for (const cb of args) {
      const e = unwrap(cb);
      const params = LITERAL_FN_KINDS.has(e?.getKind())
        ? paramsRunIn(e)
        : [e?.getKind() === SyntaxKind.Identifier ? e.getSymbol()?.getDeclarations()[0] : null].filter(
            (d) => d?.getKind() === SyntaxKind.Parameter,
          );
      for (const p of params) {
        const i = paramIndexOf(wrapper, p);
        if (i >= 0) found.add(i);
      }
    }
    if (found.size === 0) continue;
    const set = contextFns.get(wrapper) ?? new Set();
    const before = set.size;
    for (const i of found) set.add(i);
    if (!contextFns.has(wrapper) || set.size !== before) {
      contextFns.set(wrapper, set);
      grew = true;
      callbackMemo.clear();
    }
  }
}

/** A parameter that is a wrapper's callback: its argument is checked at the wrapper's call site. */
function isWrapperCallbackParam(param) {
  const fn = param.getParent();
  return contextFns.get(fn)?.has(paramIndexOf(fn, param)) ?? false;
}

// ─── Opener fixpoint ────────────────────────────────────────────────────────

const OPENS = "opens";
const UNDECIDABLE = "undecidable";
/** fn → { status, why } */
const status = new Map([...contextFns.keys()].map((fn) => [fn, { status: OPENS, why: "opens an RLS context" }]));

const owners = new Map();
for (const node of [...invocations, ...references]) owners.set(node, ownerOf(node));

function verdictOf(node, r) {
  const opener = r.fns.find((f) => status.get(f)?.status === OPENS);
  if (opener) return { status: OPENS, why: `reaches ${label(opener)} at ${siteOf(node)}` };
  if (r.unresolved) return { status: UNDECIDABLE, why: `${r.unresolved} at ${siteOf(node)}` };
  const maybe = r.fns.find((f) => status.get(f)?.status === UNDECIDABLE);
  if (maybe) return { status: UNDECIDABLE, why: `reaches ${label(maybe)}, which ${status.get(maybe).why}` };
  return null;
}

let changed = true;
while (changed) {
  changed = false;
  for (const node of [...invocations, ...references]) {
    const owner = owners.get(node);
    if (!owner || status.get(owner)?.status === OPENS) continue;
    const r = invocationSet.has(node) ? resolveInvocation(node) : resolveValue(node);
    const next = verdictOf(node, r);
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
const usedConditional = new Set();

/** An enclosing function declares this parameter: the call passes the outer context's client. */
function passesEnclosingClient(call) {
  const arg = unwrap(call.getArguments()[0]);
  if (arg?.getKind() !== SyntaxKind.ObjectLiteralExpression) return false;
  const prop = arg.getProperty("tx");
  if (!prop) return false;
  let value = null;
  if (prop.getKind() === SyntaxKind.ShorthandPropertyAssignment) value = prop.getNameNode();
  else if (prop.getKind() === SyntaxKind.PropertyAssignment) value = unwrap(prop.getInitializer());
  if (value?.getKind() !== SyntaxKind.Identifier) return false;
  const decl =
    prop.getKind() === SyntaxKind.ShorthandPropertyAssignment
      ? prop.getValueSymbol?.()?.getDeclarations()[0]
      : value.getSymbol()?.getDeclarations()[0];
  if (decl?.getKind() !== SyntaxKind.Parameter) return false;
  return call.getAncestors().includes(decl.getParent());
}

function conditionallyExempt(node, fn, how) {
  if (how !== "calls" || node.getKind() !== SyntaxKind.CallExpression) return false;
  const file = toRelPosix(node.getSourceFile().getFilePath());
  const name = fn.getName?.() ?? fn.getParent()?.getName?.();
  const entry = CONDITIONAL_OPENER_ALLOWLIST.find((e) => e.file === file && e.callee === name);
  if (!entry || !passesEnclosingClient(node)) return false;
  usedConditional.add(`${entry.file}::${entry.callee}`);
  return true;
}

function judge(node, r, outer, how) {
  for (const fn of r.fns) {
    const s = status.get(fn);
    if (!s) continue;
    if (conditionallyExempt(node, fn, how)) continue;
    if (s.status === OPENS) {
      violations.push({ site: siteOf(node), outer: siteOf(outer), how, what: `${label(fn)} ${s.why}` });
    } else {
      unfollowed.push({ site: siteOf(node), outer: siteOf(outer), reason: `${how} ${label(fn)}, which ${s.why}` });
    }
  }
  if (r.unresolved) unfollowed.push({ site: siteOf(node), outer: siteOf(outer), reason: `${how}: ${r.unresolved}` });
}

const ownedBy = new Map();
for (const [node, owner] of owners) {
  if (!owner) continue;
  if (!ownedBy.has(owner)) ownedBy.set(owner, []);
  ownedBy.get(owner).push(node);
}

let callbackCount = 0;
let contextCallCount = 0;
for (const call of invocations) {
  const { args, problem } = callbacksOf(call);
  if (problem) {
    unfollowed.push({ site: siteOf(call), outer: siteOf(call), reason: problem });
    continue;
  }
  if (args.length === 0) continue;
  contextCallCount += 1;
  for (const cb of args) {
    callbackCount += 1;
    const e = unwrap(cb);
    if (!LITERAL_FN_KINDS.has(e?.getKind())) {
      const r = resolveValue(cb);
      // The enclosing wrapper's own callback parameter: checked at its caller.
      if (r.param && isWrapperCallbackParam(r.param) && r.fns.length === 0 && !r.unresolved) continue;
      judge(call, r, call, "callback is");
      continue;
    }
    for (const node of ownedBy.get(e) ?? []) {
      if (invocationSet.has(node)) judge(node, resolveInvocation(node), call, "calls");
      else judge(node, resolveValue(node), call, "hands on");
    }
  }
}

// A context function used as a value: its callback is out of sight.
for (const ref of references) {
  const fns = resolveValue(ref).fns.filter((f) => contextFns.has(f));
  if (fns.length === 0) continue;
  // The wrapper fixpoint's own forwarding (`withUserTenantRls(userId, fn)` is
  // a call, not this); an export of the helper is not a use.
  unfollowed.push({
    site: siteOf(ref),
    outer: siteOf(ref),
    reason: `context function ${label(fns[0])} used as a value; the callback it receives cannot be checked`,
  });
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
    console.error(`  ${v.site}  (inside the context opened at ${v.outer}) ${v.how} ${v.what}`);
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

if (staleAllowlist.length > 0) {
  failed = true;
  console.error("");
  console.error("An allowlist entry matches nothing (CONDITIONAL_OPENER_ALLOWLIST / EXTERNAL_SHAPE_ALLOWLIST). Remove it:");
  for (const k of staleAllowlist) console.error(`  ${k}`);
}

if (failed) process.exit(1);

const openerCount = [...status.values()].filter((s) => s.status === OPENS).length;
console.log(
  `check-rls-nesting: OK (${scanFiles.length} files, ${openerCount} openers, ` +
    `${contextFns.size} context functions, ${contextCallCount} context calls, ${callbackCount} callbacks checked)`,
);
