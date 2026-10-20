/**
 * The relations a Prisma delegate call's argument object literal reaches, read
 * from the schema — shared by check-required-user-relation (which asks whether
 * a path reaches a REQUIRED User relation) and check-bypass-rls (which charges
 * every related model a bypassed call reaches to the call's grant).
 *
 * The walk is a visitor: it finds each relation field the argument names and
 * each value it cannot read, and the caller decides what either means.
 *
 * Followed:
 *   - `select` / `include`, recursively, the `where` of each nested relation,
 *     and `_count` (`true`, or `select` of relations with their `where`);
 *   - `where`, through `AND`/`OR`/`NOT` and `is`/`isNot`/`some`/`every`/`none`,
 *     plus a direct to-one relation filter;
 *   - `orderBy` on relation fields, `_count` ordering included (opt-in);
 *   - nested writes under `data` (and an upsert's `create`/`update`): `create`,
 *     `createMany`, `connect`, `connectOrCreate`, `update`, `updateMany`,
 *     `upsert`, `delete`, `deleteMany`, `set`, `disconnect` (opt-in).
 * A `where` (or a filter inside one, or a whole argument) given as a name or a
 * shorthand is followed to the `const` object literal the name is bound to
 * where it is written, provided nothing in the file assigns into, deletes
 * from, or `Object.assign`s onto it; both branches of a conditional are
 * followed. Anything else is reported to the visitor as unreadable.
 *
 * With `full` (check-bypass-rls) two more shapes are read, in a `where`, a
 * `data`, a projection and the call's argument itself:
 *   - a conditional spread `...(c ? A : B)`, or a spread of a name bound to an
 *     unmutated `const` whose initializer is one, each branch an object
 *     literal, such a name, or `{}`/`undefined`/`null`: each non-empty branch
 *     is walked as if written inline, so a relation in either branch counts;
 *   - any other spread, and a whole `where`/`data` value that is not a literal,
 *     by its type (`ctx.checker`, the gate's Program type checker): readable,
 *     reaching nothing, only when every union member is an object type with a
 *     finite property set — no index signature, no type variable, at least one
 *     property — none of which the position could read a relation through (a
 *     relation field of the model; in a `where` also AND/OR/NOT and the
 *     relation-filter keys). Anything else stays unreadable. A type bounds the
 *     keys a value is declared with, not every key it carries at run time
 *     (structural width): this reads the declared contract, not a proof.
 */
import { SyntaxKind, ts } from "ts-morph";
import { existsSync, readFileSync } from "node:fs";
import { resolveLocalObjectLiteral, unwrapExpression, visibleBinding } from "./scope-bindings.mjs";

/** Calls that return rows, and so carry `select` / `include`. */
export const RETURNING = new Set([
  "findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "findMany",
  "create", "update", "upsert", "delete", "createManyAndReturn", "updateManyAndReturn",
]);
/** Calls whose `where` decides which rows are touched or counted. */
export const FILTERING = new Set([...RETURNING, "count", "aggregate", "groupBy", "updateMany", "deleteMany"]);
/** Calls that take `orderBy`. */
export const ORDERING = new Set([
  "findMany", "findFirst", "findFirstOrThrow", "aggregate", "groupBy", "count",
]);
/** Calls that write rows, and the argument keys holding what they write. */
export const WRITING = new Map([
  ["create", ["data"]],
  ["createMany", ["data"]],
  ["createManyAndReturn", ["data"]],
  ["update", ["data"]],
  ["updateMany", ["data"]],
  ["updateManyAndReturn", ["data"]],
  ["upsert", ["create", "update"]],
]);

const LOGICAL = new Set(["AND", "OR", "NOT"]);
export const RELATION_FILTERS = new Set(["is", "isNot", "some", "every", "none"]);
/** Nested-write operations whose value is a filter on the related model. */
const WRITE_FILTER_OPS = new Set(["connect", "set", "disconnect", "delete", "deleteMany"]);

/** A named failure for a schema this module cannot read; each gate prints it its own way. */
export class SchemaReadError extends Error {
  constructor(message) {
    super(message);
    this.name = "SchemaReadError";
  }
}

/**
 * `model -> (field -> { type, list, optional })` from the schema itself, plus the
 * client handle each model answers to. Throws on a schema it cannot read: a walk
 * that resolved every field to "not a relation" would pass every call.
 */
export function loadPrismaSchema(abs) {
  if (!existsSync(abs)) throw new SchemaReadError(`prisma schema not found at ${abs}.`);
  const models = new Map();
  let current = null;
  for (const line of readFileSync(abs, "utf8").split("\n")) {
    const open = /^model\s+(\w+)\s*\{/.exec(line);
    if (open) {
      current = new Map();
      models.set(open[1], current);
      continue;
    }
    if (/^\}/.test(line)) {
      current = null;
      continue;
    }
    if (!current) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith("@@") || trimmed.startsWith("//")) continue;
    const field = /^[ \t]+(\w+)[ \t]+([A-Za-z_]\w*)(\[\])?(\?)?/.exec(line);
    if (field) current.set(field[1], { type: field[2], list: !!field[3], optional: !!field[4] });
  }
  if (models.size === 0) throw new SchemaReadError(`parsed zero models from ${abs}.`);
  const handles = new Map([...models.keys()].map((m) => [m[0].toLowerCase() + m.slice(1), m]));
  return { models, handles };
}

/**
 * unwrapExpression plus the angle-bracket assertion `<T>x`, which (like `as`)
 * states a type the value need not have. Kept apart from the shared helper so
 * the gates that use that one read exactly what they did.
 */
function unwrapAssertions(expr) {
  const value = unwrapExpression(expr);
  return value?.getKind() === SyntaxKind.TypeAssertionExpression ? unwrapAssertions(value.getExpression()) : value;
}

const asObject = (node) => (node && node.getKind() === SyntaxKind.ObjectLiteralExpression ? node : null);
const initializerOf = (prop) => prop?.getInitializer?.() ?? null;
const sameNode = (a, b) => !!a && !!b && a.getStart() === b.getStart() && a.getEnd() === b.getEnd();

/** Does anything in the file assign into, delete from, or Object.assign onto this binding? */
function assignedInto(name, declaration, ctx) {
  const sf = declaration.getSourceFile();
  const rootOf = (expr) => {
    let node = unwrapExpression(expr);
    while (
      node &&
      (node.getKind() === SyntaxKind.PropertyAccessExpression || node.getKind() === SyntaxKind.ElementAccessExpression)
    ) {
      node = unwrapExpression(node.getExpression());
    }
    return node;
  };
  const refersHere = (node) =>
    node?.getKind() === SyntaxKind.Identifier &&
    node.getText() === name &&
    sameNode(visibleBinding(name, node, ctx.bindingsFor), declaration);
  for (const bin of sf.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    const op = bin.getOperatorToken().getKind();
    if (op < SyntaxKind.FirstAssignment || op > SyntaxKind.LastAssignment) continue;
    const left = unwrapExpression(bin.getLeft());
    if (left?.getKind() === SyntaxKind.Identifier) continue; // a const cannot be rebound
    if (refersHere(rootOf(left))) return true;
  }
  for (const del of sf.getDescendantsOfKind(SyntaxKind.DeleteExpression)) {
    if (refersHere(rootOf(del.getExpression()))) return true;
  }
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (call.getExpression().getText() !== "Object.assign") continue;
    if (refersHere(unwrapExpression(call.getArguments()[0]))) return true;
  }
  return false;
}

/**
 * The object literals a value can be: the literal itself, the `const` a bare
 * name is bound to where the name is written provided nothing assigns into it,
 * or both branches of a conditional. Null when this file cannot say.
 */
export function objectLiterals(node, ctx) {
  const value = unwrapExpression(node);
  if (!value) return null;
  if (value.getKind() === SyntaxKind.ObjectLiteralExpression) return [value];
  if (value.getKind() === SyntaxKind.ConditionalExpression) {
    const whenTrue = objectLiterals(value.getWhenTrue(), ctx);
    const whenFalse = objectLiterals(value.getWhenFalse(), ctx);
    return whenTrue && whenFalse ? [...whenTrue, ...whenFalse] : null;
  }
  if (value.getKind() !== SyntaxKind.Identifier) return null;
  // Resolved at the name itself. A name inside a literal followed from the call —
  // an OR branch of a module-level `where` — means the binding visible THERE, and
  // resolving it at the call let a same-named local of the calling function answer
  // for it (round 6, R46).
  const literal = resolveLocalObjectLiteral(value.getText(), value, ctx.bindingsFor);
  if (!literal) return null;
  return assignedInto(value.getText(), literal.getParent(), ctx) ? null : [literal];
}

/** The value node of a named property, including a shorthand `{ where }`. */
export function propertyValue(objectLiteral, name) {
  const prop = objectLiteral.getProperty(name);
  if (!prop) return null;
  if (prop.getKind() === SyntaxKind.ShorthandPropertyAssignment) return prop.getNameNode();
  return initializerOf(prop);
}

const isLiteralTrue = (node) => unwrapExpression(node)?.getKind() === SyntaxKind.TrueKeyword;
const isBooleanLiteral = (node) => {
  const k = unwrapExpression(node)?.getKind();
  return k === SyntaxKind.TrueKeyword || k === SyntaxKind.FalseKeyword;
};

/**
 * Walk one delegate call's argument object literal. `visitor`:
 *   relation({ trail, model, key, field, position }) — a relation field of
 *     `model` the argument names; `position` is "select", "count", "where",
 *     "orderBy" or "data". Return false to not descend into it.
 *   unreadable({ trail, model, kind, key?, field?, root? }) — a value the walk
 *     cannot read. `kind`: "where" (a `where` of `model`), "logical" (an
 *     AND/OR/NOT branch, `key`), "filter" (a relation field's filter, `field`),
 *     "relation-op" (`key` under a relation filter, `field`), "projection"
 *     (`root` select/include), "spread" (a projection spread),
 *     "unresolved-field" (a projection key the model does not declare),
 *     "shorthand-filter" (`{ relation }` in a where, `field`), "orderBy",
 *     "data".
 * `full: true` also walks `orderBy` (the call's and each nested relation's) and
 * nested writes, reads spreads and non-literal `where`/`data` values as the
 * module header describes (`ctx.checker` for the typed reading; without one
 * those stay unreadable), and reports a computed key in a `where` as
 * unreadable. Without it (check-required-user-relation) none of this is read
 * and a `where` spread or computed key is skipped, as that gate always has.
 */
export function walkCallArgs(args, model, method, { models, visitor, ctx, full = false }) {
  createWalker(models, visitor, ctx, full).callArgs(args, model, method, [model]);
}

/** Argument keys the walk reads a relation through; a typed argument spread holding one is unreadable. */
const ARG_KEYS = new Set(["select", "include", "where", "cursor", "orderBy", "data", "create", "update"]);
const F = ts.TypeFlags;
/** Types whose property set depends on a type argument not known here. */
const GENERIC = F.TypeParameter | F.IndexedAccess | F.Index | F.Conditional | F.Substitution;

/** Does this type, or a type argument it was instantiated with, hold a type variable? */
function isGeneric(type, checker, depth = 0) {
  if (depth > 8) return true;
  if (type.flags & GENERIC) return true;
  if (type.flags & (F.Union | F.Intersection)) return type.types.some((t) => isGeneric(t, checker, depth + 1));
  const args = [...(type.aliasTypeArguments ?? [])];
  if (type.flags & F.Object && type.objectFlags & ts.ObjectFlags.Reference) args.push(...checker.getTypeArguments(type));
  return args.some((t) => isGeneric(t, checker, depth + 1));
}

/** The property names of an object type whose property set is finite and known, or null. */
function objectKeys(type, checker) {
  if (type.flags & F.Intersection) {
    if (!type.types.every((part) => objectKeys(part, checker))) return null;
  } else if (!(type.flags & F.Object)) return null;
  if (isGeneric(type, checker)) return null;
  if (checker.getIndexInfosOfType(type).length > 0) return null;
  // No property at all is `{}`/`object`, which any value is assignable to.
  const props = checker.getPropertiesOfType(type);
  if (type.flags & F.Object && type.objectFlags & ts.ObjectFlags.Mapped) {
    // A mapped type written inline (`{ [K in keyof T]: T[K] }`) carries no alias
    // whose arguments isGeneric could check, and its key set is whatever T is
    // instantiated with. Only an alias's instantiation is read; its constraint
    // and modifiers types, once the property read above has resolved them,
    // must not hold a type variable either.
    if (!type.aliasSymbol) return null;
    for (const part of [type.constraintType, type.modifiersType]) {
      if (part && isGeneric(part, checker)) return null;
    }
  }
  return props.length > 0 ? props.map((p) => p.getName()) : null;
}

/**
 * Every key a value of this type can be declared with, or null when that set
 * is not finite and known. `undefined`/`null` contribute nothing (nor, spread,
 * does a boolean: `...(c && { k })`). `any`, `unknown` and `never` are not
 * object types, so objectKeys refuses them.
 */
function finiteKeys(type, checker, spread) {
  const keys = new Set();
  for (const member of type.flags & F.Union ? type.types : [type]) {
    if (member.flags & (F.Undefined | F.Null | F.Void)) continue;
    if (spread && member.flags & F.BooleanLiteral) continue;
    const own = objectKeys(member, checker);
    if (!own) return null;
    for (const k of own) keys.add(k);
  }
  return keys;
}

function createWalker(models, visitor, ctx, full) {
  const relationField = (model, key) => {
    const field = models.get(model)?.get(key);
    return field && models.has(field.type) ? field : null;
  };
  const whereKey = (model) => (k) => !!relationField(model, k) || LOGICAL.has(k) || RELATION_FILTERS.has(k);
  const dataKey = (model) => (k) => !!relationField(model, k);
  const projectionKey = (model) => (k) => k === "_count" || !models.get(model)?.has(k) || !!relationField(model, k);
  const argKey = (k) => ARG_KEYS.has(k);

  /**
   * (`full` only.) The object literals a value can be, `[]` when it is readable
   * and holds none to walk, null when it is unreadable. `opensKey(k)` says
   * whether a key could carry a relation in this position; a value read by its
   * type is readable only if no key it can hold does.
   */
  function readValue(node, opensKey, spread = false, seen = new Set()) {
    const value = unwrapAssertions(node);
    if (!value) return null;
    switch (value.getKind()) {
      case SyntaxKind.ObjectLiteralExpression:
        return [value];
      case SyntaxKind.NullKeyword:
        return [];
      case SyntaxKind.ConditionalExpression: {
        const whenTrue = readValue(value.getWhenTrue(), opensKey, spread, seen);
        const whenFalse = readValue(value.getWhenFalse(), opensKey, spread, seen);
        return whenTrue && whenFalse ? [...whenTrue, ...whenFalse] : null;
      }
      case SyntaxKind.Identifier: {
        const name = value.getText();
        const binding = visibleBinding(name, value, ctx.bindingsFor);
        if (!binding) {
          if (name === "undefined") return [];
          break;
        }
        // Something assigns into it: neither its initializer nor its declared type says what it holds.
        if (assignedInto(name, binding, ctx)) return null;
        // Nor for a name rebound after its declaration: `w = other` is checked
        // only for assignability, and a wider object is assignable.
        if (binding.getKind() === SyntaxKind.VariableDeclaration && binding.getParent()?.getDeclarationKind?.() !== "const") return null;
        if (rebound(name, binding)) return null;
        // A destructured name (`const { w } = …`) is indexed under its whole
        // declaration, whose initializer is not what the name holds.
        if (
          binding.getKind() === SyntaxKind.VariableDeclaration &&
          binding.getNameNode().getKind() === SyntaxKind.Identifier &&
          binding.getVariableStatement?.()?.getDeclarationKind() === "const" &&
          binding.getInitializer() &&
          !seen.has(binding)
        ) {
          return readValue(binding.getInitializer(), opensKey, spread, new Set([...seen, binding]));
        }
        break;
      }
    }
    const checker = ctx.checker;
    if (!checker) return null;
    const types = declaredTypes(value, checker);
    if (!types) return null;
    const keys = new Set();
    for (const type of types) {
      const own = finiteKeys(type, checker, spread);
      if (!own) return null;
      for (const k of own) keys.add(k);
    }
    return ![...keys].some(opensKey) ? [] : null;
  }

  /**
   * The types a value is declared with — never the flow-narrowed type at the
   * use site, which a user-defined type guard can narrow to anything — or null.
   *   - A name, or a chain of plain property reads off one: the root's declared
   *     type, each property looked up on every non-nullish member of the type
   *     before it (any member lacking it: null). The root must be a binding in
   *     this file that nothing assigns into, rebinds, or (for `let`/`var`)
   *     could rebind, since a member's type says nothing about a value
   *     written through a cast.
   *   - A call through such a chain: the return type of every call signature
   *     of the callee's declared types, each of which must be non-generic and
   *     carry an explicit return-type annotation (an inferred one is whatever
   *     the body returned, narrowing included).
   * Anything else (`await w`, `w ?? x`, an element access, …) is null.
   */
  function declaredTypes(value, checker) {
    if (value.getKind() === SyntaxKind.CallExpression) {
      const callees = declaredTypes(unwrapAssertions(value.getExpression()), checker);
      if (!callees) return null;
      const out = [];
      for (const callee of callees) {
        const signatures = checker.getSignaturesOfType(callee, ts.SignatureKind.Call);
        if (signatures.length === 0) return null;
        for (const signature of signatures) {
          const decl = signature.getDeclaration();
          if (!decl?.type || decl.typeParameters?.length || signature.getTypeParameters()?.length) return null;
          out.push(checker.getReturnTypeOfSignature(signature));
        }
      }
      return out;
    }
    const names = [];
    let root = value;
    while (root.getKind() === SyntaxKind.PropertyAccessExpression) {
      names.unshift(root.getName());
      root = root.getExpression();
    }
    if (root.getKind() !== SyntaxKind.Identifier) return null;
    const binding = visibleBinding(root.getText(), root, ctx.bindingsFor);
    if (!binding) return null;
    if (assignedInto(root.getText(), binding, ctx) || rebound(root.getText(), binding)) return null;
    if (binding.getKind() === SyntaxKind.VariableDeclaration && binding.getParent()?.getDeclarationKind?.() !== "const") return null;
    let symbol = checker.getSymbolAtLocation(root.compilerNode);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    if (!symbol) return null;
    const nullish = F.Undefined | F.Null | F.Void;
    let types = [checker.getTypeOfSymbol(symbol)];
    for (const name of names) {
      const next = [];
      for (const type of types) {
        for (const member of type.flags & F.Union ? type.types : [type]) {
          if (member.flags & nullish) continue;
          const prop = checker.getPropertyOfType(member, name);
          if (!prop) return null;
          next.push(checker.getTypeOfSymbol(prop));
        }
      }
      types = next;
    }
    return types;
  }

  /** Is `name` (bound at `binding`) the target of a plain or destructuring assignment, or a for-in/of head? */
  function rebound(name, binding) {
    const refersHere = (node) =>
      node?.getKind() === SyntaxKind.Identifier &&
      node.getText() === name &&
      sameNode(visibleBinding(name, node, ctx.bindingsFor), binding);
    const targets = (left) => {
      const l = unwrapAssertions(left);
      if (refersHere(l)) return true;
      const k = l?.getKind();
      if (k !== SyntaxKind.ObjectLiteralExpression && k !== SyntaxKind.ArrayLiteralExpression) return false;
      return l.getDescendantsOfKind(SyntaxKind.Identifier).some(refersHere);
    };
    const sf = binding.getSourceFile();
    for (const bin of sf.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
      const op = bin.getOperatorToken().getKind();
      if (op >= SyntaxKind.FirstAssignment && op <= SyntaxKind.LastAssignment && targets(bin.getLeft())) return true;
    }
    for (const kind of [SyntaxKind.ForOfStatement, SyntaxKind.ForInStatement]) {
      for (const loop of sf.getDescendantsOfKind(kind)) {
        if (targets(loop.getInitializer())) return true;
      }
    }
    return false;
  }

  /** (`full` only.) The elements an array literal holds, spreads of array literals (or conditionals of them) flattened; null otherwise. */
  function arrayElements(node) {
    const value = unwrapExpression(node);
    if (value?.getKind() === SyntaxKind.ConditionalExpression) {
      const whenTrue = arrayElements(value.getWhenTrue());
      const whenFalse = arrayElements(value.getWhenFalse());
      return whenTrue && whenFalse ? [...whenTrue, ...whenFalse] : null;
    }
    if (value?.getKind() !== SyntaxKind.ArrayLiteralExpression) return null;
    const out = [];
    for (const el of value.getElements()) {
      if (el.getKind() !== SyntaxKind.SpreadElement) {
        out.push(el);
        continue;
      }
      const inner = arrayElements(el.getExpression());
      if (!inner) return null;
      out.push(...inner);
    }
    return out;
  }

  /** The call's argument object: select/include, where, orderBy and nested writes. */
  function callArgs(args, model, method, trail) {
    if (full) {
      for (const prop of args.getProperties()) {
        if (prop.getKind() !== SyntaxKind.SpreadAssignment) continue;
        const spread = readValue(prop.getExpression(), argKey, true);
        if (!spread) visitor.unreadable({ trail, model, kind: "args" });
        else for (const literal of spread) callArgs(literal, model, method, trail);
      }
    }
    if (RETURNING.has(method)) {
      for (const root of ["select", "include"]) {
        const node = initializerOf(args.getProperty(root));
        if (!node) continue;
        if (!asObject(node)) visitor.unreadable({ trail, model, kind: "projection", root });
        else projection(asObject(node), model, trail);
      }
    }
    if (FILTERING.has(method)) whereOf(args, model, trail);
    if (full && FILTERING.has(method)) cursorOf(args, model, trail);
    if (full && ORDERING.has(method)) {
      const order = propertyValue(args, "orderBy");
      if (order) orderBy(order, model, [...trail, "orderBy"]);
    }
    if (full && WRITING.has(method)) {
      for (const key of WRITING.get(method)) {
        const value = propertyValue(args, key);
        if (value) data(value, model, [...trail, key]);
      }
    }
  }

  /** (`full` only.) A `cursor` is a unique filter, which can name relations like a `where`. */
  function cursorOf(node, model, trail) {
    const value = propertyValue(node, "cursor");
    if (!value) return;
    const cursors = readValue(value, whereKey(model));
    if (cursors) for (const c of cursors) where(c, model, [...trail, "cursor"]);
    else visitor.unreadable({ trail, model, kind: "where" });
  }

  /** Scan the `where` held by `node` (a projection argument or a call's args), or report it unreadable. */
  function whereOf(node, model, trail) {
    const value = propertyValue(node, "where");
    if (!value) return;
    const wheres = full ? readValue(value, whereKey(model)) : objectLiterals(value, ctx);
    if (wheres) for (const w of wheres) where(w, model, [...trail, "where"]);
    else visitor.unreadable({ trail, model, kind: "where" });
  }

  /** `_count: true` counts every to-many relation; `_count: { select: { rel: { where } } }` named ones. */
  function count(value, model, trail) {
    if (isLiteralTrue(value)) {
      for (const [key, field] of models.get(model) ?? []) {
        if (field.list && models.has(field.type)) visitor.relation({ trail: [...trail, key], model, key, field, position: "count" });
      }
      return;
    }
    const counted = asObject(unwrapExpression(value));
    if (!counted) return;
    const select = asObject(initializerOf(counted.getProperty("select")));
    if (!select) return;
    for (const prop of select.getProperties()) {
      if (prop.getKind() !== SyntaxKind.PropertyAssignment) continue;
      const key = prop.getName();
      const field = relationField(model, key);
      if (!field) continue;
      const here = [...trail, key];
      if (visitor.relation({ trail: here, model, key, field, position: "count" }) === false) continue;
      const nested = asObject(initializerOf(prop));
      if (nested) whereOf(nested, field.type, here);
    }
  }

  /** Every relation a projection of `model` reaches. */
  function projection(node, model, trail) {
    for (const prop of node.getProperties()) {
      if (full && prop.getKind() === SyntaxKind.SpreadAssignment) {
        const spread = readValue(prop.getExpression(), projectionKey(model), true);
        if (!spread) visitor.unreadable({ trail, model, kind: "spread" });
        else for (const literal of spread) projection(literal, model, trail);
        continue;
      }
      if (prop.getKind() !== SyntaxKind.PropertyAssignment) {
        visitor.unreadable({ trail, model, kind: "spread" });
        continue;
      }
      if (prop.getNameNode().getKind() === SyntaxKind.ComputedPropertyName) continue;
      const key = prop.getName();
      if (key === "_count") {
        count(initializerOf(prop), model, [...trail, "_count"]);
        continue;
      }
      const declared = models.get(model)?.get(key);
      const here = [...trail, key];
      if (!declared) {
        visitor.unreadable({ trail: here, model, kind: "unresolved-field", key });
        continue;
      }
      if (!models.has(declared.type)) continue;
      if (visitor.relation({ trail: here, model, key, field: declared, position: "select" }) === false) continue;
      const nested = asObject(initializerOf(prop));
      if (!nested) continue;
      whereOf(nested, declared.type, here);
      if (full) cursorOf(nested, declared.type, here);
      for (const root of ["select", "include"]) {
        const sub = initializerOf(nested.getProperty(root));
        if (!sub) continue;
        if (!asObject(sub)) {
          visitor.unreadable({ trail: here, model: declared.type, kind: "projection", root });
          continue;
        }
        projection(asObject(sub), declared.type, here);
      }
      if (full && nested.getProperty("orderBy")) {
        orderBy(propertyValue(nested, "orderBy"), declared.type, [...here, "orderBy"]);
      }
    }
  }

  /** Every relation a `where` of `model` filters through. */
  function where(node, model, trail) {
    for (const prop of node.getProperties()) {
      if (prop.getKind() === SyntaxKind.ShorthandPropertyAssignment) {
        // `{ user }` names a filter held by a variable; treat it like `user: user`.
        const field = relationField(model, prop.getName());
        if (field) visitor.unreadable({ trail: [...trail, prop.getName()], model, kind: "shorthand-filter", key: prop.getName(), field });
        continue;
      }
      if (full && prop.getKind() === SyntaxKind.SpreadAssignment) {
        const spread = readValue(prop.getExpression(), whereKey(model), true);
        // A branch naming is/some/… would make the enclosing relation filter a
        // wrapped one, which the walk decided from the literal's own keys.
        const wraps = (literal) => literal.getProperties().some((p) => p.getName?.() && RELATION_FILTERS.has(p.getName()));
        if (!spread || spread.some(wraps)) visitor.unreadable({ trail, model, kind: "where" });
        else for (const literal of spread) where(literal, model, trail);
        continue;
      }
      if (prop.getKind() !== SyntaxKind.PropertyAssignment || prop.getNameNode().getKind() === SyntaxKind.ComputedPropertyName) {
        if (full) visitor.unreadable({ trail, model, kind: "where" });
        continue;
      }
      const key = prop.getName();
      const value = unwrapExpression(initializerOf(prop));
      if (LOGICAL.has(key)) {
        let branches = value?.getKind() === SyntaxKind.ArrayLiteralExpression ? value.getElements() : [value];
        if (full && value?.getKind() === SyntaxKind.ArrayLiteralExpression) {
          const flat = arrayElements(value);
          if (flat) branches = flat;
        }
        for (const branch of branches) {
          const objs = full && branch?.getKind() !== SyntaxKind.SpreadElement ? readValue(branch, whereKey(model)) : objectLiterals(branch, ctx);
          if (objs) for (const obj of objs) where(obj, model, [...trail, key]);
          else if (branch) visitor.unreadable({ trail, model, kind: "logical", key });
        }
        continue;
      }
      const field = relationField(model, key);
      if (!field) continue;
      const here = [...trail, key];
      if (visitor.relation({ trail: here, model, key, field, position: "where" }) === false) continue;
      const nestedFilters = objectLiterals(value, ctx);
      if (!nestedFilters) {
        if (value) visitor.unreadable({ trail: here, model, kind: "filter", key, field });
        continue;
      }
      for (const nested of nestedFilters) {
        const wrapped = nested.getProperties().some(
          (p) => p.getKind() === SyntaxKind.PropertyAssignment && RELATION_FILTERS.has(p.getName()),
        );
        if (!wrapped) {
          where(nested, field.type, here);
          continue;
        }
        // Beside is/some/…, a spread could hold another of them.
        if (full && nested.getProperties().some((p) => p.getKind() !== SyntaxKind.PropertyAssignment)) {
          visitor.unreadable({ trail: here, model, kind: "filter", key, field });
        }
        for (const op of RELATION_FILTERS) {
          const opValue = propertyValue(nested, op);
          if (!opValue) continue;
          const subs = objectLiterals(opValue, ctx);
          if (subs) for (const sub of subs) where(sub, field.type, [...here, op]);
          else visitor.unreadable({ trail: [...here, op], model, kind: "relation-op", key: op, field });
        }
      }
    }
  }

  /** Every relation an `orderBy` of `model` sorts through (an object or an array of them). */
  function orderBy(value, model, trail) {
    const v = unwrapExpression(value);
    const items = v?.getKind() === SyntaxKind.ArrayLiteralExpression ? v.getElements() : [v];
    for (const item of items) {
      const objs = objectLiterals(item, ctx);
      if (!objs) {
        visitor.unreadable({ trail, model, kind: "orderBy" });
        continue;
      }
      for (const obj of objs) {
        for (const prop of obj.getProperties()) {
          if (prop.getKind() !== SyntaxKind.PropertyAssignment || prop.getNameNode().getKind() === SyntaxKind.ComputedPropertyName) {
            visitor.unreadable({ trail, model, kind: "orderBy" });
            continue;
          }
          const key = prop.getName();
          const field = relationField(model, key);
          if (!field) continue;
          const here = [...trail, key];
          if (visitor.relation({ trail: here, model, key, field, position: "orderBy" }) === false) continue;
          // `{ relation: { _count: "desc" } }` or a to-one `{ relation: { col: "asc" } }`.
          const nested = initializerOf(prop);
          const nestedObj = asObject(unwrapExpression(nested));
          if (nestedObj) orderBy(nestedObj, field.type, here);
          else if (nested && unwrapExpression(nested)?.getKind() !== SyntaxKind.StringLiteral) {
            visitor.unreadable({ trail: here, model: field.type, kind: "orderBy" });
          }
        }
      }
    }
  }

  /** Every relation a `data` of `model` writes through (an object or an array of them). */
  function data(value, model, trail) {
    const v = unwrapExpression(value);
    const items = v?.getKind() === SyntaxKind.ArrayLiteralExpression ? v.getElements() : [v];
    for (const item of items) {
      const objs = item?.getKind() === SyntaxKind.SpreadElement ? null : readValue(item, dataKey(model));
      if (!objs) {
        visitor.unreadable({ trail, model, kind: "data" });
        continue;
      }
      for (const obj of objs) dataObject(obj, model, trail);
    }
  }

  /** Every relation one `data` object literal of `model` writes through. */
  function dataObject(obj, model, trail) {
    for (const prop of obj.getProperties()) {
      if (prop.getKind() === SyntaxKind.SpreadAssignment) {
        const spread = readValue(prop.getExpression(), dataKey(model), true);
        if (!spread) visitor.unreadable({ trail, model, kind: "data" });
        else for (const literal of spread) dataObject(literal, model, trail);
        continue;
      }
      if (prop.getKind() === SyntaxKind.ShorthandPropertyAssignment) {
        const field = relationField(model, prop.getName());
        if (field) {
          visitor.relation({ trail: [...trail, prop.getName()], model, key: prop.getName(), field, position: "data" });
          visitor.unreadable({ trail: [...trail, prop.getName()], model, kind: "data" });
        }
        continue;
      }
      if (prop.getKind() !== SyntaxKind.PropertyAssignment || prop.getNameNode().getKind() === SyntaxKind.ComputedPropertyName) {
        visitor.unreadable({ trail, model, kind: "data" });
        continue;
      }
      const key = prop.getName();
      const field = relationField(model, key);
      if (!field) continue;
      const here = [...trail, key];
      if (visitor.relation({ trail: here, model, key, field, position: "data" }) === false) continue;
      nestedWrite(initializerOf(prop), field.type, here);
    }
  }

  /** `{ create, connect, update, … }` on a relation of the written model. */
  function nestedWrite(value, model, trail) {
    const ops = objectLiterals(value, ctx);
    if (!ops) {
      visitor.unreadable({ trail, model, kind: "data" });
      return;
    }
    const each = (node, fn) => {
      const v = unwrapExpression(node);
      for (const el of v?.getKind() === SyntaxKind.ArrayLiteralExpression ? v.getElements() : [v]) fn(el);
    };
    const asFilter = (node, here) => {
      if (isBooleanLiteral(node)) return;
      const objs = objectLiterals(node, ctx);
      if (objs) for (const o of objs) where(o, model, here);
      else visitor.unreadable({ trail: here, model, kind: "where" });
    };
    // `{ where, data }` (update/updateMany of a to-many) or the data itself (to-one update).
    const whereAndData = (node, here) => {
      const objs = objectLiterals(node, ctx);
      if (!objs) {
        visitor.unreadable({ trail: here, model, kind: "data" });
        return;
      }
      for (const o of objs) {
        if (o.getProperty("data")) {
          const w = propertyValue(o, "where");
          if (w) asFilter(w, [...here, "where"]);
          data(propertyValue(o, "data"), model, [...here, "data"]);
        } else data(o, model, here);
      }
    };
    for (const opsObj of ops) {
      for (const prop of opsObj.getProperties()) {
        if (prop.getKind() !== SyntaxKind.PropertyAssignment) {
          visitor.unreadable({ trail, model, kind: "data" });
          continue;
        }
        const op = prop.getName();
        const opValue = initializerOf(prop);
        const here = [...trail, op];
        if (op === "create") each(opValue, (el) => data(el, model, here));
        else if (op === "createMany") {
          const objs = objectLiterals(opValue, ctx);
          if (objs) for (const o of objs) data(propertyValue(o, "data"), model, [...here, "data"]);
          else visitor.unreadable({ trail: here, model, kind: "data" });
        } else if (op === "connectOrCreate") {
          each(opValue, (el) => {
            const objs = objectLiterals(el, ctx);
            if (!objs) return visitor.unreadable({ trail: here, model, kind: "data" });
            for (const o of objs) {
              const w = propertyValue(o, "where");
              if (w) asFilter(w, [...here, "where"]);
              const c = propertyValue(o, "create");
              if (c) data(c, model, [...here, "create"]);
            }
          });
        } else if (op === "update" || op === "updateMany") each(opValue, (el) => whereAndData(el, here));
        else if (op === "upsert") {
          each(opValue, (el) => {
            const objs = objectLiterals(el, ctx);
            if (!objs) return visitor.unreadable({ trail: here, model, kind: "data" });
            for (const o of objs) {
              const w = propertyValue(o, "where");
              if (w) asFilter(w, [...here, "where"]);
              for (const k of ["create", "update"]) {
                const d = propertyValue(o, k);
                if (d) data(d, model, [...here, k]);
              }
            }
          });
        } else if (WRITE_FILTER_OPS.has(op)) each(opValue, (el) => asFilter(el, here));
        else visitor.unreadable({ trail: here, model, kind: "data" });
      }
    }
  }

  return { callArgs };
}
