#!/usr/bin/env node
/**
 * CI guard: no Promise combinator over queries on ONE interactive transaction
 * client (issue #975).
 *
 * An interactive transaction holds one pg connection. `Promise.all([tx.a(),
 * tx.b()])` issues both statements on it concurrently; pg queues them today and
 * deprecates doing so, and pg@9 refuses them. Statements on one connection
 * never run in parallel anyway, so sequential awaits cost nothing.
 *
 * The class is a combinator (`Promise.all` / `allSettled` / `any` / `race`, also
 * spelled `Promise["all"]`) whose argument REACHES a transaction client the
 * argument did not open itself. "Reaches" follows what the argument evaluates:
 *
 *   - every identifier in it, not only a bare-identifier argument: a spread
 *     element, `Object.values(m)`, `xs.map(load)`, `[load(a), load(b)]`;
 *   - a local variable declared outside it, through its initializer AND every
 *     write to it in its scope — reassignment, element/property assignment and
 *     the arguments of any method called on it (`.push`, `.unshift`, `.splice`,
 *     `.set`, …). A value that IS an `await` expression is settled, not a lazy
 *     query; an `await` nested inside a value settles only part of it. Passing a
 *     variable that visibly holds a container (an array/object literal, a
 *     `new …`, or no initializer) to a call that is not a known reader is a
 *     write the gate cannot see, and is reported as such (fail closed);
 *   - a local function or closure it names: its body, recursively, for clients
 *     declared outside that body.
 *
 * What is a client:
 *   1. A binding that IS a transaction client: typed `TransactionClient` or a
 *      type alias derived from it (`TxOrPrisma`, `TxClient`, … to a fixpoint);
 *      a member of an object type, interface or object alias typed so (`params.tx`,
 *      `{ tx }: Params`, `const { tx } = params`); or a parameter in a
 *      client-callback position — derived from every declaration whose parameter
 *      type is a function type with a client parameter (withBypassRls,
 *      withTenantRls, withUserTenantRls / withTeamTenantRls's second parameter,
 *      inSweepTx, …; also through a function-type alias), an object-type or
 *      interface callback property (`inTx`, `__testHook`), and
 *      `<any>.$transaction(fn)`. Names resolve to their innermost visible
 *      declaration (scope-bindings), and an import by its ORIGINAL name.
 *   2. The ambient `prisma` (src/lib/prisma.ts) — a named import (aliased or
 *      not, `@/` or relative), `ns.prisma` through a namespace import, or a
 *      local alias of either (found by following the variable). Inside any RLS
 *      context that proxy routes every call to the context's transaction
 *      client, and whether the enclosing function runs inside one is decided by
 *      its callers (createTeamPassword issues its queries with no context in
 *      sight and is only ever called inside withTeamTenantRls), so the ambient
 *      client is refused everywhere — except as the client ARGUMENT of a wrapper
 *      call (`withBypassRls(prisma, …)`), and inside a wrapper callback written
 *      within the argument: that callback runs in a NEW context, one per element.
 * A client declared INSIDE the argument (each element opening its own
 * `withBypassRls(prisma, (tx) => …)`) is a separate transaction per element.
 *
 * Not seen (the runtime backstop in src/__tests__/db-integration/setup.ts
 * fails any integration test that runs two queries at once on one pg client,
 * whatever the spelling — Prisma's own concurrent loading of relation-join
 * children excepted, which no application code controls):
 *   - a helper in another module that reaches the ambient client without being
 *     handed one (`Promise.all([loadA(id), loadB(id)])`, loadA imported) — a
 *     call-graph question this file-local gate does not answer;
 *   - a parameter that holds lazy queries or a client without a client type
 *     (`function run(ps: Promise<unknown>[]) { return Promise.all(ps); }`);
 *   - a client typed through a generic (`<C extends Prisma.TransactionClient>(
 *     db: C)`), `typeof tx`, or an inferred type with no annotation at all;
 *   - a client held in a class field or module-level mutable state;
 *   - a container reached by aliasing (`const b = a; b.push(tx.x())`), a write
 *     to a nested member (`holder.list.push(tx.x())`), or a mutable container a
 *     call returned (`const ps = makeList(); fill(ps)`) — only a variable that is
 *     visibly a container is followed into unknown calls;
 *   - a value that is awaited and still holds lazy queries
 *     (`const ps = await buildQueries(tx)`) — a top-level `await` is settled;
 *   - a wrapper re-exported through another module (imports resolve to the
 *     module named, and its own declarations).
 *
 * The array form `prisma.$transaction([...])` is not a combinator here: the
 * proxy in src/lib/prisma.ts runs it sequentially inside a context.
 *
 * Exit 0 = OK. Exit 1 = a violation, or the scan cannot vouch for itself.
 * Env: TX_CONCURRENT_ROOT overrides the repo root (used by the self-test), which
 * relaxes the repo-shape floors (pinned opener files, src/lib/prisma.ts and its
 * `prisma` export, at least one resolved ambient import) unless
 * TX_CONCURRENT_STRICT=1.
 */
import { SyntaxKind, ts } from "ts-morph";
import { fileURLToPath } from "node:url";
import { posix } from "node:path";
import { createAstProject, sourceFilesFrom, unresolvedTargets } from "./lib/ast-project.mjs";
import {
  FN_KINDS,
  bindingIndex,
  resolveLocalFunction,
  scopeOf,
  unwrapExpression,
  visibleBinding,
} from "./lib/scope-bindings.mjs";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ROOT = process.env.TX_CONCURRENT_ROOT ?? REPO_ROOT;
// The repo-shape floors below hold for the real tree; a fixture root opts in
// with TX_CONCURRENT_STRICT=1 (the self-test's floor cells).
const REQUIRE_REPO_FLOORS =
  process.env.TX_CONCURRENT_ROOT === undefined || process.env.TX_CONCURRENT_STRICT === "1";
const SCAN_TARGETS = ["src", "scripts"];
const COMBINATORS = new Set(["all", "allSettled", "any", "race"]);
const AMBIENT_MODULE = "src/lib/prisma";
const AMBIENT_FILE = `${AMBIENT_MODULE}.ts`;
const AMBIENT_EXPORT = "prisma";
// Wrappers the derivation must find whenever their defining file is scanned —
// a floor proving the signature match still sees the real openers. Each entry
// is [name, callback argument index, client parameter index].
const PINNED_WRAPPERS = new Map([
  ["src/lib/tenant-rls.ts", [["withBypassRls", 1, 0], ["withTenantRls", 2, 0]]],
  ["src/lib/tenant-context.ts", [["withUserTenantRls", 1, 1], ["withTeamTenantRls", 1, 1]]],
]);
// Calls that only READ a followed variable, so passing it to them is no write.
const READER_CALLS = new Set([
  "Object.values",
  "Object.entries",
  "Object.keys",
  "Array.from",
  "Array.isArray",
  "JSON.stringify",
  "String",
  "Number",
  "Boolean",
  ...[...COMBINATORS].map((c) => `Promise.${c}`),
]);

function fail(message) {
  console.error(`check-tx-concurrent-queries: ${message}`);
  process.exit(1);
}

const missing = unresolvedTargets(SCAN_TARGETS, ROOT);
if (missing.length > 0) fail(`scan target(s) contributed no source file: ${missing.join(", ")}`);

const project = createAstProject();
const files = [...sourceFilesFrom(project, SCAN_TARGETS, ROOT)];
if (files.length === 0) fail("scanned 0 files — refusing to report OK");

const sameNode = (a, b) => !!a && !!b && a.getStart() === b.getStart() && a.getEnd() === b.getEnd();
const within = (node, outer) => outer.getStart() <= node.getStart() && node.getEnd() <= outer.getEnd();

// ── Pass 1: derive client types, wrappers, callback properties ──

const typeAliases = new Map(); // alias name -> type node
const objectTypes = new Map(); // interface / object-literal alias name -> member nodes
for (const { sf } of files) {
  for (const d of sf.getDescendantsOfKind(SyntaxKind.TypeAliasDeclaration)) {
    const node = d.getTypeNode();
    if (!node) continue;
    typeAliases.set(d.getName(), node);
    if (node.getKind() === SyntaxKind.TypeLiteral) objectTypes.set(d.getName(), node.getMembers());
  }
  for (const d of sf.getDescendantsOfKind(SyntaxKind.InterfaceDeclaration)) {
    objectTypes.set(d.getName(), [...(objectTypes.get(d.getName()) ?? []), ...d.getMembers()]);
  }
}

const clientAliases = new Set();
{
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, node] of typeAliases) {
      if (!clientAliases.has(name) && namesClientType(node.getText())) {
        clientAliases.add(name);
        grew = true;
      }
    }
  }
}

function namesClientType(text) {
  if (/\bTransactionClient\b/.test(text)) return true;
  for (const alias of clientAliases) {
    if (new RegExp(`\\b${alias.replace(/\$/g, "\\$")}\\b`).test(text)) return true;
  }
  return false;
}

const typeRefName = (typeNode) =>
  typeNode?.getKind() === SyntaxKind.TypeReference ? typeNode.getTypeName().getText() : null;

/**
 * True when a type annotation makes the WHOLE binding a client: `Prisma.TransactionClient`,
 * an alias of it, or a union/intersection holding one. An object type is not a
 * client — only the members `clientMembers` names are — and a function type is
 * a callback, not a client.
 */
function annotationIsClient(typeNode) {
  if (!typeNode) return false;
  switch (typeNode.getKind()) {
    case SyntaxKind.TypeLiteral:
    case SyntaxKind.FunctionType:
      return false;
    case SyntaxKind.UnionType:
    case SyntaxKind.IntersectionType:
      return typeNode.getTypeNodes().some(annotationIsClient);
    case SyntaxKind.ParenthesizedType:
      return annotationIsClient(typeNode.getTypeNode());
    default:
      return namesClientType(typeNode.getText());
  }
}

/** Members of an object type, an interface, an object alias, or an intersection of them. */
function membersOf(typeNode, seen = new Set()) {
  if (!typeNode) return [];
  switch (typeNode.getKind()) {
    case SyntaxKind.TypeLiteral:
      return typeNode.getMembers();
    case SyntaxKind.IntersectionType:
    case SyntaxKind.UnionType:
      return typeNode.getTypeNodes().flatMap((t) => membersOf(t, seen));
    case SyntaxKind.ParenthesizedType:
      return membersOf(typeNode.getTypeNode(), seen);
    default: {
      const name = typeRefName(typeNode);
      if (!name || seen.has(name)) return [];
      seen.add(name);
      return objectTypes.get(name) ?? [];
    }
  }
}

/** Property names of an object-shaped annotation that hold a client (`{ tx?: Prisma.TransactionClient }`). */
function clientMembers(typeNode) {
  const out = new Set();
  for (const member of membersOf(typeNode)) {
    if (member.getKind() === SyntaxKind.PropertySignature && annotationIsClient(member.getTypeNode())) {
      out.add(member.getName());
    }
  }
  return out;
}

/** Function types `typeNode` is, holds, or names through a type alias. */
function functionTypesOf(typeNode, seen = new Set()) {
  if (!typeNode) return [];
  if (typeNode.getKind() === SyntaxKind.FunctionType) return [typeNode];
  const name = typeRefName(typeNode);
  if (name && typeAliases.has(name) && !seen.has(name)) {
    seen.add(name);
    return functionTypesOf(typeAliases.get(name), seen);
  }
  return typeNode.getDescendantsOfKind(SyntaxKind.FunctionType);
}

/** Indices of the parameters a callback of type `typeNode` receives a client in. */
function clientParamIndices(typeNode) {
  const out = new Set();
  for (const fnType of functionTypesOf(typeNode)) {
    fnType.getParameters().forEach((p, j) => {
      if (annotationIsClient(p.getTypeNode())) out.add(j);
    });
  }
  return out;
}

/** argIndex -> client parameter indices, for a function whose parameters take client callbacks. */
function callbackSlots(fn) {
  const out = new Map();
  fn.getParameters().forEach((p, i) => {
    const indices = clientParamIndices(p.getTypeNode());
    if (indices.size > 0) out.set(i, indices);
  });
  return out;
}

const mergeSlots = (into, from) => {
  for (const [i, js] of from) {
    const bucket = into.get(i) ?? new Set();
    for (const j of js) bucket.add(j);
    into.set(i, bucket);
  }
  return into;
};

// Wrappers by the file that declares them — an import resolves to its module's
// own declaration, so a same-named helper elsewhere cannot change it. Methods
// are reached through a receiver this file-local gate cannot type, so they stay
// keyed by name alone.
const wrappersByFile = new Map(); // rel -> Map<name, Map<argIndex, Set<paramIndex>>>
const methodWrappers = new Map(); // method name -> Map<argIndex, Set<paramIndex>>
const callbackProps = new Map(); // object-type property name -> client parameter indices
let ambientImports = 0;
let ambientExportFound = false;
for (const { sf, rel } of files) {
  const fns = [
    ...sf.getDescendantsOfKind(SyntaxKind.FunctionDeclaration).map((f) => [f.getName(), f]),
    ...sf
      .getDescendantsOfKind(SyntaxKind.VariableDeclaration)
      .map((v) => [v.getName(), unwrapExpression(v.getInitializer())])
      .filter(([, init]) => init && FN_KINDS.has(init.getKind())),
  ];
  const own = new Map();
  for (const [name, fn] of fns) {
    if (!name) continue;
    const slots = callbackSlots(fn);
    if (slots.size > 0) own.set(name, mergeSlots(own.get(name) ?? new Map(), slots));
  }
  if (own.size > 0) wrappersByFile.set(rel, own);
  for (const method of sf.getDescendantsOfKind(SyntaxKind.MethodDeclaration)) {
    const slots = callbackSlots(method);
    if (slots.size > 0) methodWrappers.set(method.getName(), mergeSlots(methodWrappers.get(method.getName()) ?? new Map(), slots));
  }
  for (const kind of [SyntaxKind.PropertySignature, SyntaxKind.PropertyDeclaration]) {
    for (const prop of sf.getDescendantsOfKind(kind)) {
      const indices = clientParamIndices(prop.getTypeNode());
      if (indices.size > 0) callbackProps.set(prop.getName(), indices);
    }
  }
  for (const method of sf.getDescendantsOfKind(SyntaxKind.MethodSignature)) {
    const indices = new Set();
    method.getParameters().forEach((p, j) => {
      if (annotationIsClient(p.getTypeNode())) indices.add(j);
    });
    if (indices.size > 0) callbackProps.set(method.getName(), indices);
  }
  for (const decl of sf.getImportDeclarations()) {
    if (moduleKey(decl.getModuleSpecifierValue(), rel) !== AMBIENT_MODULE) continue;
    if (decl.getNamedImports().some((s) => s.getName() === AMBIENT_EXPORT) || decl.getNamespaceImport()) {
      ambientImports += 1;
    }
  }
  if (rel === AMBIENT_FILE) {
    ambientExportFound = sf
      .getVariableStatements()
      .some((s) => s.isExported() && s.getDeclarations().some((d) => d.getName() === AMBIENT_EXPORT));
  }
}

for (const [path, pins] of PINNED_WRAPPERS) {
  if (!files.some((f) => f.rel === path)) {
    if (REQUIRE_REPO_FLOORS) fail(`${path} was not scanned — the openers it defines cannot be derived`);
    continue;
  }
  for (const [name, arg, param] of pins) {
    if (!wrappersByFile.get(path)?.get(name)?.get(arg)?.has(param)) {
      fail(
        `derivation lost ${name} (callback argument ${arg}, client parameter ${param}) from ${path} — ` +
          `the signature match no longer sees a real opener, so its callbacks would read as plain functions`,
      );
    }
  }
}
if (REQUIRE_REPO_FLOORS) {
  if (!ambientExportFound) fail(`${AMBIENT_FILE} was not scanned or no longer exports \`${AMBIENT_EXPORT}\``);
  if (ambientImports === 0) fail(`no import of \`${AMBIENT_EXPORT}\` from ${AMBIENT_MODULE} resolved — ambient matching is blind`);
}

// ── Pass 2: per file, judge each combinator ──

/** A module specifier as a repo-relative path without extension (`@/x` → `src/x`). */
function moduleKey(specifier, rel) {
  if (specifier.startsWith("@/")) return `src/${specifier.slice(2)}`;
  if (specifier.startsWith(".")) return posix.normalize(posix.join(posix.dirname(rel), specifier));
  return specifier;
}

/** The import a local name refers to: { original, module, namespace } — null when not imported. */
function importOf(name, sf, rel) {
  for (const decl of sf.getImportDeclarations()) {
    const moduleId = moduleKey(decl.getModuleSpecifierValue(), rel);
    if (decl.getNamespaceImport()?.getText() === name) return { original: null, module: moduleId, namespace: true };
    for (const spec of decl.getNamedImports()) {
      const local = spec.getAliasNode()?.getText() ?? spec.getName();
      if (local === name) return { original: spec.getName(), module: moduleId, namespace: false };
    }
  }
  return null;
}

/** Callback slots of the call `call` (argIndex -> client parameter indices); empty when it is no wrapper. */
function slotsOf(call, ctx) {
  const callee = unwrapExpression(call.getExpression());
  if (callee?.getKind() === SyntaxKind.PropertyAccessExpression) {
    const name = callee.getName();
    if (name === "$transaction") return new Map([[0, new Set([0])]]);
    return methodWrappers.get(name) ?? new Map();
  }
  if (callee?.getKind() !== SyntaxKind.Identifier) return new Map();
  const name = callee.getText();
  if (visibleBinding(name, callee, ctx.bindingsFor)) {
    const fn = resolveLocalFunction(name, callee, ctx.bindingsFor);
    return fn ? callbackSlots(fn) : new Map();
  }
  const imported = importOf(name, ctx.sf, ctx.rel);
  if (!imported || imported.namespace) return new Map();
  return wrappersOfModule(imported.module)?.get(imported.original) ?? new Map();
}

/** The wrappers a module key (`src/lib/tenant-rls`) declares, when that module was scanned. */
function wrappersOfModule(moduleId) {
  for (const candidate of [`${moduleId}.ts`, `${moduleId}.tsx`, `${moduleId}/index.ts`]) {
    if (wrappersByFile.has(candidate)) return wrappersByFile.get(candidate);
  }
  return null;
}

/** The position a function expression is written in, past type-level wrappers. */
function slotOf(fn) {
  let slot = fn;
  while (slot.getParent() && sameNode(unwrapExpression(slot.getParent()), fn)) slot = slot.getParent();
  return slot;
}

/** Client parameter indices `fn` receives from where it is written, or an empty set. */
function callbackClientParams(fn, ctx) {
  const slot = slotOf(fn);
  const holder = slot.getParent();
  if (holder?.getKind() === SyntaxKind.CallExpression) {
    const index = holder.getArguments().findIndex((arg) => sameNode(arg, slot));
    return (index !== -1 && slotsOf(holder, ctx).get(index)) || new Set();
  }
  if (holder?.getKind() === SyntaxKind.PropertyAssignment) {
    return callbackProps.get(holder.getName()) ?? new Set();
  }
  return new Set();
}

/** True when `fn` is the callback of a wrapper call — it runs in a context of its own. */
function isWrapperCallback(fn, ctx) {
  if (!FN_KINDS.has(fn.getKind())) return false;
  const slot = slotOf(fn);
  const holder = slot.getParent();
  if (holder?.getKind() !== SyntaxKind.CallExpression) return false;
  const callee = unwrapExpression(holder.getExpression());
  if (callee?.getKind() === SyntaxKind.PropertyAccessExpression && callee.getName() === "$transaction") return false;
  const index = holder.getArguments().findIndex((arg) => sameNode(arg, slot));
  return index !== -1 && slotsOf(holder, ctx).has(index);
}

/** True when `decl` binds a transaction client as a whole. */
function isClientDecl(decl, ctx) {
  const kind = decl.getKind();
  if (kind !== SyntaxKind.Parameter && kind !== SyntaxKind.VariableDeclaration) return false;
  if (decl.getNameNode().getKind() !== SyntaxKind.Identifier) return false;
  if (annotationIsClient(decl.getTypeNode())) return true;
  if (kind !== SyntaxKind.Parameter) return false;
  const fn = decl.getParent();
  if (!fn || !FN_KINDS.has(fn.getKind())) return false;
  return callbackClientParams(fn, ctx).has(fn.getParameters().findIndex((p) => sameNode(p, decl)));
}

/** True when the reference `id`, bound by `decl`, is a client. */
function refersToClient(id, decl, ctx) {
  const nameNode = decl.getNameNode?.();
  if (!nameNode) return false;
  if (nameNode.getKind() === SyntaxKind.Identifier) {
    if (isClientDecl(decl, ctx)) return true;
    // `params.tx` where `params: { tx?: Prisma.TransactionClient; … }`.
    const parent = id.getParent();
    return (
      parent?.getKind() === SyntaxKind.PropertyAccessExpression &&
      sameNode(parent.getExpression(), id) &&
      clientMembers(decl.getTypeNode?.()).has(parent.getName())
    );
  }
  // `{ tx }: Params` or `const { tx } = params` — the element's property name decides.
  const element = nameNode.getDescendantsOfKind(SyntaxKind.BindingElement).find((el) => el.getName() === id.getText());
  if (!element) return false;
  const property = element.getPropertyNameNode()?.getText() ?? element.getName();
  if (clientMembers(decl.getTypeNode?.()).has(property)) return true;
  const init = decl.getKind() === SyntaxKind.VariableDeclaration ? unwrapExpression(decl.getInitializer()) : null;
  if (init?.getKind() !== SyntaxKind.Identifier) return false;
  const source = visibleBinding(init.getText(), init, ctx.bindingsFor);
  return !!source && clientMembers(source.getTypeNode?.()).has(property);
}

/** True when `id` is a name position, not a reference to a binding. */
function isNamePosition(id) {
  const parent = id.getParent();
  if (!parent) return false;
  switch (parent.getKind()) {
    case SyntaxKind.PropertyAccessExpression:
      return sameNode(parent.getNameNode(), id);
    case SyntaxKind.PropertyAssignment:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.PropertySignature:
    case SyntaxKind.Parameter:
    case SyntaxKind.VariableDeclaration:
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.BindingElement:
    case SyntaxKind.QualifiedName:
      return sameNode(parent.getNameNode?.() ?? parent.getRight?.(), id);
    default:
      return false;
  }
}

const inTypePosition = (id, stop) => {
  for (let p = id.getParent(); p && !sameNode(p, stop); p = p.getParent()) {
    if (ts.isTypeNode(p.compilerNode)) return true;
  }
  return false;
};

/** True when `id` is a non-callback argument of a wrapper call — the client it opens a transaction on. */
function isWrapperClientArgument(id, ctx) {
  const slot = slotOf(id);
  const call = slot.getParent();
  if (call?.getKind() !== SyntaxKind.CallExpression) return false;
  const index = call.getArguments().findIndex((arg) => sameNode(arg, slot));
  if (index === -1) return false;
  const slots = slotsOf(call, ctx);
  return slots.size > 0 && !slots.has(index);
}

/** True when a wrapper callback written inside `scope` encloses `id` — a context of its own. */
function inOwnContext(id, scope, ctx) {
  for (let p = id.getParent(); p && !sameNode(p, scope); p = p.getParent()) {
    if (isWrapperCallback(p, ctx)) return true;
  }
  return false;
}

/**
 * True when a followed value is settled: the value expression itself is an
 * `await`, so the variable holds its result. An `await` deeper inside
 * (`(await getClient(tx)).user.count()`) settles only part of it.
 */
const isSettledValue = (value) => unwrapExpression(value)?.getKind() === SyntaxKind.AwaitExpression;

/** True when `id` resolves to the ambient client: a named or namespace import of src/lib/prisma. */
function isAmbient(id, ctx) {
  const imported = importOf(id.getText(), ctx.sf, ctx.rel);
  if (!imported || imported.module !== AMBIENT_MODULE) return false;
  if (!imported.namespace) return imported.original === AMBIENT_EXPORT;
  const parent = id.getParent();
  return parent?.getKind() === SyntaxKind.PropertyAccessExpression && parent.getName() === AMBIENT_EXPORT;
}

const calleeText = (call) => unwrapExpression(call.getExpression())?.getText();

const CONTAINER_KINDS = new Set([
  SyntaxKind.ArrayLiteralExpression,
  SyntaxKind.ObjectLiteralExpression,
  SyntaxKind.NewExpression,
]);

/**
 * True when `decl` visibly holds a container a callee could fill: initialized
 * to an array or object literal or a `new …`, or declared without a value. Only
 * these are failed closed when handed to an unknown call. A value obtained any
 * other way may be a mutable container too (a call's return value, an alias of
 * another container); the header's "Not seen" lists those.
 */
function isContainer(decl) {
  const init = unwrapExpression(decl.getInitializer());
  return !init || CONTAINER_KINDS.has(init.getKind());
}

/**
 * Every write to the variable `decl` in its scope: the expressions whose values
 * can end up in it, plus a reason for each write the gate cannot see.
 */
function writesTo(decl, ctx) {
  const values = [];
  const opaque = [];
  const name = decl.getName();
  const scope = scopeOf(decl) ?? decl.getSourceFile();
  for (const id of scope.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (id.getText() !== name || isNamePosition(id)) continue;
    if (!sameNode(visibleBinding(name, id, ctx.bindingsFor), decl)) continue;
    const parent = id.getParent();
    const kind = parent?.getKind();
    if (kind === SyntaxKind.BinaryExpression && sameNode(parent.getLeft(), id)) {
      if (parent.getOperatorToken().getText().endsWith("=")) values.push(parent.getRight());
      continue;
    }
    if (kind === SyntaxKind.PropertyAccessExpression || kind === SyntaxKind.ElementAccessExpression) {
      // `x.p = v` / `x[i] = v`
      const grand = parent.getParent();
      if (grand?.getKind() === SyntaxKind.BinaryExpression && sameNode(grand.getLeft(), parent)) {
        values.push(grand.getRight());
        continue;
      }
      // Any method called on it may store its arguments (`push`, `unshift`, `splice`, `set`, …).
      if (grand?.getKind() === SyntaxKind.CallExpression && sameNode(grand.getExpression(), parent)) {
        values.push(...grand.getArguments());
      }
      continue;
    }
    if (kind === SyntaxKind.CallExpression && !sameNode(parent.getExpression(), id)) {
      const callee = calleeText(parent);
      if (isContainer(decl) && !READER_CALLS.has(callee)) opaque.push(`\`${name}\` passed to ${callee}(…) at line ${id.getStartLineNumber()}`);
    }
  }
  return { values, opaque };
}

/**
 * Why evaluating `node` reaches a client shared beyond `scope` — one entry per
 * offending reference. Declarations inside `scope` are its own; a local variable
 * or function declared outside it is followed.
 */
function reach(node, scope, ctx, state) {
  const reasons = [];
  const ids = node.getKind() === SyntaxKind.Identifier ? [node] : node.getDescendantsOfKind(SyntaxKind.Identifier);
  for (const id of ids) {
    if (isNamePosition(id) || inTypePosition(id, node)) continue;
    if (isWrapperClientArgument(id, ctx)) continue;
    const name = id.getText();
    const decl = visibleBinding(name, id, ctx.bindingsFor);
    if (!decl) {
      if (isAmbient(id, ctx) && !inOwnContext(id, scope, ctx)) {
        reasons.push(`ambient \`${name}\` (routes to the RLS context's transaction client)`);
      }
      continue;
    }
    if (within(decl, scope)) continue;
    if (refersToClient(id, decl, ctx)) {
      reasons.push(`transaction client \`${name}\` (declared line ${decl.getStartLineNumber()})`);
      continue;
    }
    const key = `${decl.getStart()}:${decl.getEnd()}`;
    if (state.seen.has(key)) continue;
    state.seen.add(key);
    reasons.push(...follow(decl, ctx, state).map((r) => `\`${name}\` → ${r}`));
  }
  return reasons;
}

/** What a local variable or function declared outside the argument contributes. */
function follow(decl, ctx, state) {
  if (decl.getKind() === SyntaxKind.FunctionDeclaration) {
    const body = decl.getBody();
    return body ? reach(body, decl, ctx, state) : [];
  }
  if (decl.getKind() !== SyntaxKind.VariableDeclaration) return [];
  const init = decl.getInitializer();
  const fnInit = unwrapExpression(init);
  if (fnInit && FN_KINDS.has(fnInit.getKind())) return reach(fnInit, fnInit, ctx, state);
  const reasons = [];
  if (init && !isSettledValue(init)) reasons.push(...reach(init, init, ctx, state));
  if (decl.getNameNode().getKind() !== SyntaxKind.Identifier) return reasons;
  const { values, opaque } = writesTo(decl, ctx);
  for (const value of values) {
    if (!isSettledValue(value)) reasons.push(...reach(value, value, ctx, state));
  }
  reasons.push(...opaque.map((o) => `unanalysable write: ${o}`));
  return reasons;
}

/**
 * Why the combinator argument `arg` runs two or more evaluations that reach a
 * shared client at once. An array literal does only when two of its elements
 * reach one (or a spread element does — it holds any number); any other
 * argument (`xs.map(…)`, a variable, `Object.values(m)`) holds any number.
 */
function concurrentReasons(arg, ctx) {
  const bare = unwrapExpression(arg);
  if (bare?.getKind() !== SyntaxKind.ArrayLiteralExpression) return reach(arg, arg, ctx, { seen: new Set() });
  const reaching = bare.getElements().map((el) => ({
    spread: el.getKind() === SyntaxKind.SpreadElement,
    reasons: reach(el, arg, ctx, { seen: new Set() }),
  })).filter((e) => e.reasons.length > 0);
  if (reaching.length >= 2 || reaching.some((e) => e.spread)) return reaching.flatMap((e) => e.reasons);
  return [];
}

function combinatorName(call) {
  const callee = unwrapExpression(call.getExpression());
  if (callee?.getKind() === SyntaxKind.PropertyAccessExpression) {
    if (callee.getExpression().getText() !== "Promise") return null;
    return COMBINATORS.has(callee.getName()) ? callee.getName() : null;
  }
  if (callee?.getKind() === SyntaxKind.ElementAccessExpression) {
    if (callee.getExpression().getText() !== "Promise") return null;
    const key = callee.getArgumentExpression();
    if (key?.getKind() !== SyntaxKind.StringLiteral) return null;
    return COMBINATORS.has(key.getLiteralValue()) ? key.getLiteralValue() : null;
  }
  return null;
}

const violations = [];
let examined = 0;
for (const { rel, sf } of files) {
  let index;
  const ctx = { sf, rel, bindingsFor: () => (index ??= bindingIndex(sf)) };
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const combinator = combinatorName(call);
    if (!combinator) continue;
    examined += 1;
    const arg = call.getArguments()[0];
    if (!arg) continue;
    const reasons = concurrentReasons(arg, ctx);
    if (reasons.length > 0) {
      violations.push(`${rel}:${call.getStartLineNumber()}: Promise.${combinator} over ${[...new Set(reasons)].join(", ")}`);
    }
  }
}

if (examined === 0) fail(`${files.length} file(s) scanned but no Promise combinator found — refusing to report OK`);

if (violations.length > 0) {
  console.error("Promise combinator issuing concurrent queries on one transaction client:");
  console.error("Replace it with sequential awaits in the same order (statements on one connection never run in parallel).");
  console.error("");
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}

console.log(
  `check-tx-concurrent-queries: OK (${files.length} files, ${examined} combinator calls, ${[...wrappersByFile.values()].reduce((n, m) => n + m.size, 0) + methodWrappers.size} derived client-callback wrappers, ${ambientImports} ambient imports)`,
);
