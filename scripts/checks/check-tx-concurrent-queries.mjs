#!/usr/bin/env node
/**
 * CI guard: no Promise combinator over queries on ONE interactive transaction
 * client (issue #975).
 *
 * An interactive transaction holds one pg connection. `Promise.all([tx.a(),
 * tx.b()])` issues both statements on it concurrently; pg queues them today and
 * prints "client is already executing a query", and a future major refuses
 * them. Statements on one connection never run in parallel anyway, so
 * sequential awaits cost nothing.
 *
 * The text grep `Promise\.all\(\[\s*tx\.` saw about half of the class. The
 * class is a combinator (`Promise.all` / `allSettled` / `any` / `race`) whose
 * argument reaches a transaction client that the argument did not open itself:
 *
 *   1. A binding that IS a transaction client, referenced anywhere inside the
 *      argument — `tx.model.op()`, `items.map((i) => tx.x.op(i))`, or `helper(tx)`
 *      (the helper queries on what it is handed). A binding is a client when:
 *        - its type annotation names `TransactionClient`, or a type alias
 *          derived from it (`TxOrPrisma`, `TxClient`, …, to a fixpoint);
 *        - it is the first parameter of a function passed in a callback
 *          position whose type is `(tx: <client>) => …` — derived from every
 *          declaration in the scanned tree (withBypassRls, withTenantRls,
 *          inSweepTx, …; an object-type property such as `inTx` likewise) — or
 *          passed to `<any>.$transaction(fn)`;
 *        - it is a `const` alias of such a binding.
 *      Names resolve to their innermost visible declaration (scope-bindings),
 *      and an import by its ORIGINAL name, so `import { withBypassRls as wb }`
 *      is still a wrapper and a shadowing `(tx) =>` that is no client is not.
 *      A client declared INSIDE the argument (each element opening its own
 *      `withBypassRls(prisma, (tx) => …)`) is a separate transaction per
 *      element, on its own connection, and is allowed.
 *
 *   2. The ambient `prisma` import (src/lib/prisma.ts). Inside any RLS context
 *      — withBypassRls / withTenantRls / withUserTenantRls / withTeamTenantRls,
 *      the last two of which hand their callback no client at all — that proxy
 *      routes every call to the context's transaction client. Whether the
 *      enclosing function runs inside a context is decided by its callers,
 *      which one file does not show (createTeamPassword issues its Promise.all
 *      with no context in sight and is only ever called inside
 *      withTeamTenantRls), so the ambient client is refused in a combinator
 *      everywhere. The one exception is the client ARGUMENT of a wrapper call
 *      (`withBypassRls(prisma, …)`), which opens a new transaction.
 *
 * Not seen: a helper that reaches the ambient client without being handed one
 * (`Promise.all([loadA(id), loadB(id)])` where loadA queries `prisma`). That is
 * a call-graph question this file-local gate cannot answer; the runtime
 * warning is the backstop there.
 *
 * The array form `prisma.$transaction([...])` is not a combinator here: the
 * proxy in src/lib/prisma.ts runs it sequentially inside a context.
 *
 * Exit 0 = OK. Exit 1 = a violation, or nothing was scanned.
 * Env: TX_CONCURRENT_ROOT overrides the repo root (used by the self-test).
 */
import { SyntaxKind, ts } from "ts-morph";
import { fileURLToPath } from "node:url";
import { posix } from "node:path";
import { createAstProject, sourceFilesFrom, unresolvedTargets } from "./lib/ast-project.mjs";
import {
  FN_KINDS,
  bindingIndex,
  resolveLocalFunction,
  unwrapExpression,
  visibleBinding,
} from "./lib/scope-bindings.mjs";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ROOT = process.env.TX_CONCURRENT_ROOT ?? REPO_ROOT;
const SCAN_TARGETS = ["src", "scripts"];
const COMBINATORS = new Set(["all", "allSettled", "any", "race"]);
const AMBIENT_MODULE = "src/lib/prisma";
const AMBIENT_EXPORT = "prisma";
// Wrappers the derivation must find whenever their defining file is scanned —
// a floor proving the signature match still sees the real openers.
const PINNED_WRAPPERS = new Map([
  ["src/lib/tenant-rls.ts", [["withBypassRls", 1], ["withTenantRls", 2]]],
]);

const missing = unresolvedTargets(SCAN_TARGETS, ROOT);
if (missing.length > 0) {
  console.error(`check-tx-concurrent-queries: scan target(s) contributed no source file: ${missing.join(", ")}`);
  process.exit(1);
}

const project = createAstProject();
const files = [...sourceFilesFrom(project, SCAN_TARGETS, ROOT)];
if (files.length === 0) {
  console.error("check-tx-concurrent-queries: scanned 0 files — refusing to report OK");
  process.exit(1);
}

const sameNode = (a, b) => !!a && !!b && a.getStart() === b.getStart() && a.getEnd() === b.getEnd();
const within = (node, outer) => outer.getStart() <= node.getStart() && node.getEnd() <= outer.getEnd();

// ── Pass 1: derive client type aliases, wrappers and callback properties ──

const clientAliases = new Set();
{
  const aliases = files.flatMap(({ sf }) =>
    sf.getDescendantsOfKind(SyntaxKind.TypeAliasDeclaration).map((d) => [d.getName(), d.getTypeNode()?.getText() ?? ""]),
  );
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, text] of aliases) {
      if (!clientAliases.has(name) && namesClientType(text)) {
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

/** True when `typeNode` is (or is a union/optional holding) a function type whose first parameter is a client. */
function isClientCallbackType(typeNode) {
  if (!typeNode) return false;
  const fnTypes =
    typeNode.getKind() === SyntaxKind.FunctionType
      ? [typeNode]
      : typeNode.getDescendantsOfKind(SyntaxKind.FunctionType);
  return fnTypes.some((fnType) => {
    const first = fnType.getParameters()[0];
    return !!first && namesClientType(first.getTypeNode()?.getText() ?? "");
  });
}

/** Indices of a function's parameters that take a client callback. */
function callbackIndices(fn) {
  const out = new Set();
  fn.getParameters().forEach((p, i) => {
    if (isClientCallbackType(p.getTypeNode())) out.add(i);
  });
  return out;
}

const wrappers = new Map(); // name -> Set<callback index>, from every scanned declaration
const callbackProps = new Set(); // object-type property names typed as a client callback
for (const { sf } of files) {
  const fns = [
    ...sf.getDescendantsOfKind(SyntaxKind.FunctionDeclaration).map((f) => [f.getName(), f]),
    ...sf.getDescendantsOfKind(SyntaxKind.MethodDeclaration).map((m) => [m.getName(), m]),
    ...sf
      .getDescendantsOfKind(SyntaxKind.VariableDeclaration)
      .map((v) => [v.getName(), unwrapExpression(v.getInitializer())])
      .filter(([, init]) => init && FN_KINDS.has(init.getKind())),
  ];
  for (const [name, fn] of fns) {
    if (!name) continue;
    const indices = callbackIndices(fn);
    if (indices.size === 0) continue;
    const bucket = wrappers.get(name) ?? new Set();
    for (const i of indices) bucket.add(i);
    wrappers.set(name, bucket);
  }
  for (const kind of [SyntaxKind.PropertySignature, SyntaxKind.PropertyDeclaration]) {
    for (const prop of sf.getDescendantsOfKind(kind)) {
      if (isClientCallbackType(prop.getTypeNode())) callbackProps.add(prop.getName());
    }
  }
}

for (const [path, pins] of PINNED_WRAPPERS) {
  if (!files.some((f) => f.rel === path)) continue;
  for (const [name, index] of pins) {
    if (!wrappers.get(name)?.has(index)) {
      console.error(
        `check-tx-concurrent-queries: derivation lost ${name} (callback index ${index}) from ${path} — ` +
          `the signature match no longer sees a real opener, so its callbacks would read as plain functions`,
      );
      process.exit(1);
    }
  }
}

// ── Pass 2: per file, judge each combinator ──

/** The import a local name refers to, as { original, module } — null when not imported. */
function importOf(name, sf, rel) {
  for (const decl of sf.getImportDeclarations()) {
    for (const spec of decl.getNamedImports()) {
      const local = spec.getAliasNode()?.getText() ?? spec.getName();
      if (local !== name) continue;
      return { original: spec.getName(), module: moduleKey(decl.getModuleSpecifierValue(), rel) };
    }
  }
  return null;
}

/** A module specifier as a repo-relative path without extension (`@/x` → `src/x`). */
function moduleKey(specifier, rel) {
  if (specifier.startsWith("@/")) return `src/${specifier.slice(2)}`;
  if (specifier.startsWith(".")) return posix.normalize(posix.join(posix.dirname(rel), specifier));
  return specifier;
}

/** Callback indices of the call `call`, or an empty set when it is no wrapper. */
function wrapperIndicesOf(call, ctx) {
  const callee = unwrapExpression(call.getExpression());
  if (callee?.getKind() === SyntaxKind.PropertyAccessExpression) {
    const name = callee.getName();
    if (name === "$transaction") return new Set([0]);
    return wrappers.get(name) ?? new Set();
  }
  if (callee?.getKind() !== SyntaxKind.Identifier) return new Set();
  const name = callee.getText();
  if (visibleBinding(name, callee, ctx.bindingsFor)) {
    const fn = resolveLocalFunction(name, callee, ctx.bindingsFor);
    return fn ? callbackIndices(fn) : new Set();
  }
  const imported = importOf(name, ctx.sf, ctx.rel);
  return wrappers.get(imported ? imported.original : name) ?? new Set();
}

/** True when `param` is the first parameter of a function in a client-callback position. */
function isCallbackClientParam(param, ctx) {
  const fn = param.getParent();
  if (!fn || !FN_KINDS.has(fn.getKind()) || !sameNode(fn.getParameters()[0], param)) return false;
  // Climb past type-level wrappers to the position the function is written in.
  let slot = fn;
  while (slot.getParent() && sameNode(unwrapExpression(slot.getParent()), fn)) slot = slot.getParent();
  const holder = slot.getParent();
  if (holder?.getKind() === SyntaxKind.CallExpression) {
    const index = holder.getArguments().findIndex((arg) => sameNode(arg, slot));
    return index !== -1 && wrapperIndicesOf(holder, ctx).has(index);
  }
  if (holder?.getKind() === SyntaxKind.PropertyAssignment) {
    return callbackProps.has(holder.getName());
  }
  return false;
}

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

/** Property names of an object-type annotation that hold a client (`{ tx?: Prisma.TransactionClient }`). */
function clientMembers(typeNode) {
  const out = new Set();
  if (typeNode?.getKind() !== SyntaxKind.TypeLiteral) return out;
  for (const member of typeNode.getMembers()) {
    if (member.getKind() === SyntaxKind.PropertySignature && annotationIsClient(member.getTypeNode())) {
      out.add(member.getName());
    }
  }
  return out;
}

/** True when `decl` binds a transaction client as a whole. */
function isClientDecl(decl, ctx, seen = new Set()) {
  const id = `${decl.getStart()}:${decl.getEnd()}`;
  if (seen.has(id)) return false;
  seen.add(id);
  const kind = decl.getKind();
  if (kind !== SyntaxKind.Parameter && kind !== SyntaxKind.VariableDeclaration) return false;
  if (decl.getNameNode().getKind() !== SyntaxKind.Identifier) return false;
  if (annotationIsClient(decl.getTypeNode())) return true;
  if (kind === SyntaxKind.Parameter) return isCallbackClientParam(decl, ctx);
  if (decl.getVariableStatement?.()?.getDeclarationKind() !== "const") return false;
  const init = unwrapExpression(decl.getInitializer());
  if (init?.getKind() === SyntaxKind.Identifier) {
    const target = visibleBinding(init.getText(), init, ctx.bindingsFor);
    return !!target && isClientDecl(target, ctx, seen);
  }
  // `const tx = params.tx` over an object-typed binding with a client member.
  if (init?.getKind() === SyntaxKind.PropertyAccessExpression) {
    const object = unwrapExpression(init.getExpression());
    if (object?.getKind() !== SyntaxKind.Identifier) return false;
    const target = visibleBinding(object.getText(), object, ctx.bindingsFor);
    return !!target && clientMembers(target.getTypeNode?.()).has(init.getName());
  }
  return false;
}

/** True when the reference `id`, bound by `decl`, reaches a client. */
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
  // `{ tx }: { tx: Prisma.TransactionClient }` — the element's property name decides.
  const element = nameNode
    .getDescendantsOfKind(SyntaxKind.BindingElement)
    .find((el) => el.getName() === id.getText());
  if (!element) return false;
  const property = element.getPropertyNameNode()?.getText() ?? element.getName();
  return clientMembers(decl.getTypeNode?.()).has(property);
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
  const call = id.getParent();
  if (call?.getKind() !== SyntaxKind.CallExpression) return false;
  const index = call.getArguments().findIndex((arg) => sameNode(arg, id));
  if (index === -1) return false;
  const indices = wrapperIndicesOf(call, ctx);
  return indices.size > 0 && !indices.has(index);
}

/** Why `root`'s subtree reaches a shared client — one entry per offending reference. */
function sharedClientReferences(root, ctx) {
  const reasons = [];
  const ids = root.getKind() === SyntaxKind.Identifier ? [root] : root.getDescendantsOfKind(SyntaxKind.Identifier);
  for (const id of ids) {
    if (isNamePosition(id) || inTypePosition(id, root)) continue;
    const name = id.getText();
    const decl = visibleBinding(name, id, ctx.bindingsFor);
    if (decl) {
      if (!within(decl, root) && refersToClient(id, decl, ctx)) {
        reasons.push(`transaction client \`${name}\` (declared line ${decl.getStartLineNumber()})`);
      }
      continue;
    }
    const imported = importOf(name, ctx.sf, ctx.rel);
    if (imported?.original === AMBIENT_EXPORT && imported.module === AMBIENT_MODULE && !isWrapperClientArgument(id, ctx)) {
      reasons.push(`ambient \`${name}\` (routes to the RLS context's transaction client)`);
    }
  }
  return reasons;
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
    const roots = [arg];
    // `const ps = [tx.a(), tx.b()]; await Promise.all(ps)` — Prisma promises are
    // lazy, so the combinator is what issues them.
    const bare = unwrapExpression(arg);
    if (bare?.getKind() === SyntaxKind.Identifier) {
      const decl = visibleBinding(bare.getText(), bare, ctx.bindingsFor);
      const init = decl?.getKind() === SyntaxKind.VariableDeclaration ? decl.getInitializer() : null;
      if (init) roots.push(init);
    }
    const reasons = roots.flatMap((root) => sharedClientReferences(root, ctx));
    if (reasons.length > 0) {
      violations.push(`${rel}:${call.getStartLineNumber()}: Promise.${combinator} over ${[...new Set(reasons)].join(", ")}`);
    }
  }
}

if (examined === 0) {
  console.error(`check-tx-concurrent-queries: ${files.length} file(s) scanned but no Promise combinator found — refusing to report OK`);
  process.exit(1);
}

if (violations.length > 0) {
  console.error("Promise combinator issuing concurrent queries on one transaction client:");
  console.error("Replace it with sequential awaits in the same order (statements on one connection never run in parallel).");
  console.error("");
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}

console.log(
  `check-tx-concurrent-queries: OK (${files.length} files, ${examined} combinator calls, ${wrappers.size} derived client-callback wrappers)`,
);
