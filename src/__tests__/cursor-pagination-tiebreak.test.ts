/**
 * Every Prisma cursor-paginated query orders by a unique key last.
 *
 * With `orderBy` on a non-unique column only (`createdAt`), Prisma 7 emits no
 * LIMIT: it reads every row from the cursor's value on (`created_at >= ...`)
 * and finds the cursor row in memory. Each page then reads the rest of the
 * table, and a skip-free page depends on PostgreSQL returning tied rows in the
 * same order twice, which it does not promise. A trailing `{ id: <dir> }` turns
 * the query into a keyset `(created_at, id)` comparison with a LIMIT.
 *
 * A site is a `cursor` property (either spelling) in the arguments of a
 * delegate call — the reads (finds, `count`, `aggregate`) and the writes that
 * take `include` / `select` — top-level or a relation's. The arguments it
 * pages must have an `orderBy` array literal ending in exactly `{ id: ... }`.
 *
 * What the check cannot read is refused rather than guessed: a read whose
 * arguments are not a literal, a spread that is not a literal (readable spreads
 * are read through), an `include` / `select` that is neither a literal nor a
 * `const` bound to one (resolved through the binder), a relation value that is
 * neither a boolean nor a literal, quoted or computed argument keys, an
 * object-literal cursor no delegate call can be found for, and any cursor in
 * an object bound to a variable.
 *
 * Boundaries, by design: a shorthand or named cursor that cannot be placed in a
 * call is not a site (CSS cursors and blob-store tokens share the key); a
 * write's arguments are read only when they are a literal and its receiver is
 * `<client>.<model>` or `<client>["<model>"]` — `map.delete(key)` shares the
 * shape, so a write on an aliased delegate is not read; `groupBy` takes no
 * cursor; a `where` may spread shared filters.
 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import { readFileSync } from "node:fs";
import { Node, SyntaxKind, VariableDeclarationKind } from "ts-morph";
import type {
  CallExpression,
  ObjectLiteralExpression,
  PropertyAccessExpression,
  PropertyAssignment,
  ShorthandPropertyAssignment,
  SourceFile,
} from "ts-morph";
import { createAstProject, walkSourceFiles } from "../../scripts/checks/lib/ast-project.mjs";

const REPO_ROOT = path.resolve(__dirname, "../..");
// The reads that take a cursor (or relation arguments) and the writes that take
// relation arguments: a cursor can sit at the top level of the first, under an
// `include` / `select` relation in both.
const FIND_METHODS: ReadonlySet<string> = new Set([
  "findMany", "findFirst", "findFirstOrThrow", "findUnique", "findUniqueOrThrow", "count", "aggregate",
]);
const WRITE_METHODS: ReadonlySet<string> = new Set([
  "create", "createManyAndReturn", "update", "updateManyAndReturn", "upsert", "delete",
]);

/** A property's name with string-literal quotes removed (`"cursor"` reads as cursor). */
function unquotedName(prop: PropertyAssignment | ShorthandPropertyAssignment): string {
  const nameNode = prop.getNameNode();
  return Node.isStringLiteral(nameNode) ? nameNode.getLiteralValue() : prop.getName();
}

/**
 * A delegate call. Any receiver for a read (`tx.a.findMany`, an aliased
 * `d.findMany`, `tx["a"].findMany`): no Map or Set method shares those names.
 * A write needs a delegate-shaped receiver, `<client>.<model>` or
 * `<client>["<model>"]`, since `map.delete(key)` shares its name; a write on an
 * aliased delegate (`d.update`) cannot be told apart from it and is not read.
 */
function isDelegateCall(call: Node): call is CallExpression {
  if (!Node.isCallExpression(call)) return false;
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return false;
  const method = callee.getName();
  if (FIND_METHODS.has(method)) return true;
  if (!WRITE_METHODS.has(method)) return false;
  const receiver = callee.getExpression();
  return (
    Node.isPropertyAccessExpression(receiver) ||
    (Node.isElementAccessExpression(receiver) && Node.isStringLiteral(receiver.getArgumentExpression()))
  );
}

/** The cursor sites found; a drop below this means the scan stopped seeing them. */
const MIN_SITES = 11;

function violations(sf: SourceFile, label: string): { sites: number; problems: string[] } {
  const problems: string[] = [];
  let sites = 0;
  const cursorProps = [
    ...sf.getDescendantsOfKind(SyntaxKind.PropertyAssignment),
    ...sf.getDescendantsOfKind(SyntaxKind.ShorthandPropertyAssignment),
  ].filter((prop) => unquotedName(prop) === "cursor");
  for (const prop of cursorProps) {
    const where = `${label}:${prop.getStartLineNumber()}`;

    // The arguments the cursor pages: the nearest object literal that is a
    // relation's args (`include: { rel: { cursor, orderBy } }`) or, failing
    // that, the literal passed straight to a query method — reached through
    // spreads and conditionals (`...(cursor ? { cursor, skip: 1 } : {})`).
    let args: Node | undefined;
    let inQuery = false;
    for (let n: Node | undefined = prop.getParent(); n; n = n.getParent()) {
      const parent = n.getParent();
      if (!Node.isObjectLiteralExpression(n) || !parent) continue;
      if (Node.isCallExpression(parent)) {
        if (isDelegateCall(parent)) {
          args ??= n;
          inQuery = true;
        }
        break;
      }
      if (Node.isPropertyAssignment(parent)) args ??= n;
    }
    if (!inQuery || !args || !Node.isObjectLiteralExpression(args)) {
      // A Prisma cursor is a unique-where object literal (`{ id }`). Other
      // `cursor` keys (a CSS cursor, a blob-store continuation token, a
      // shorthand handed to a non-Prisma call) are not sites; an object-literal
      // one we cannot place is, and so is any cursor in an object bound to a
      // variable — a page object spread into a query (`...page`) hides its
      // orderBy pairing from this check.
      const inBoundObject = isInVariableBoundLiteral(prop);
      if (inBoundObject || (Node.isPropertyAssignment(prop) && Node.isObjectLiteralExpression(prop.getInitializer()))) {
        sites += 1;
        problems.push(`${where}: cursor outside a delegate call's argument literal`);
      }
      continue;
    }
    sites += 1;
    const orderBy = args.getProperty("orderBy");
    const init = orderBy && Node.isPropertyAssignment(orderBy) ? orderBy.getInitializer() : undefined;
    const last = init && Node.isArrayLiteralExpression(init) ? init.getElements().at(-1) : undefined;
    const keys = last && Node.isObjectLiteralExpression(last) ? last.getProperties() : [];
    const isIdTiebreak = keys.length === 1 && Node.isPropertyAssignment(keys[0]) && keys[0].getName() === "id";
    if (!isIdTiebreak) problems.push(`${where}: orderBy must be an array literal ending in { id: ... }`);
  }

  // Where the query consumes its arguments: they must be a literal this check
  // can read, and so must every top-level spread (a literal, or a conditional
  // of literals). A page object built anywhere else — a variable, a helper's
  // return, an assignment — would carry a cursor past the orderBy check.
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (!isDelegateCall(call)) continue;
    const callee = call.getExpression() as PropertyAccessExpression;
    const [arg] = call.getArguments();
    if (!arg) continue;
    const where = `${label}:${call.getStartLineNumber()}`;
    if (!Node.isObjectLiteralExpression(arg)) {
      // A find's arguments must be readable. A write's argument is read only
      // when it is a literal: `ref.current.delete(key)` has the same shape.
      if (FIND_METHODS.has(callee.getName())) problems.push(`${where}: ${callee.getName()} arguments are not an object literal`);
      continue;
    }
    for (const problem of unreadableArgs(arg)) problems.push(`${where}: ${callee.getName()} ${problem}`);
  }
  return { sites, problems };
}

/**
 * What in a query's (or a relation's) argument literal this check cannot read:
 * a spread that is not a literal, an `include` / `select` that is not a
 * literal, a spread inside one, or a relation value that is neither a boolean
 * nor a literal. Relation arguments are followed to any depth. A `where` may
 * spread shared filters: it carries no cursor.
 */
function unreadableArgs(args: ObjectLiteralExpression): string[] {
  const problems: string[] = [];
  // Argument keys are read by name: a quoted or computed one would be skipped.
  for (const prop of args.getProperties()) {
    if (Node.isPropertyAssignment(prop) && !Node.isIdentifier(prop.getNameNode())) {
      problems.push(`has an argument key that is not a plain name (${prop.getNameNode().getText()})`);
    }
  }
  for (const spread of args.getProperties().filter(Node.isSpreadAssignment)) {
    if (!isLiteralSpread(spread.getExpression())) {
      problems.push("spreads arguments that are not a literal");
      continue;
    }
    // A readable spread is still arguments: read what each of its literals holds.
    for (const arm of literalArms(spread.getExpression())) problems.push(...unreadableArgs(arm));
  }
  for (const key of ["include", "select"]) {
    const prop = args.getProperty(key);
    if (!prop) continue;
    const initializer = Node.isPropertyAssignment(prop) ? prop.getInitializer() : undefined;
    const value = initializer && Node.isIdentifier(initializer) ? constLiteral(initializer) : initializer;
    if (!value || !Node.isObjectLiteralExpression(value)) {
      problems.push(`${key} is not an object literal`);
      continue;
    }
    for (const rel of value.getProperties()) {
      const relValue = Node.isPropertyAssignment(rel) ? rel.getInitializer() : undefined;
      // A boolean selects a field (a computed field name included): no relation arguments.
      if (relValue && (Node.isTrueLiteral(relValue) || Node.isFalseLiteral(relValue))) continue;
      if (Node.isPropertyAssignment(rel) && Node.isComputedPropertyName(rel.getNameNode())) {
        problems.push(`${key} names a relation by a computed key`);
        continue;
      }
      if (relValue && Node.isObjectLiteralExpression(relValue)) {
        problems.push(...unreadableArgs(relValue));
        continue;
      }
      problems.push(`${key} holds a relation that is neither a boolean nor an object literal`);
    }
  }
  return problems;
}

/**
 * The object literal the `const` this identifier names is bound to (`as const`
 * unwrapped), or undefined. Followed only for an
 * `include` / `select` value; anything else named stays unreadable.
 */
function constLiteral(id: Node): ObjectLiteralExpression | undefined {
  // Through the binder: a parameter, `let`, loop or catch binding that shadows
  // an outer `const` resolves to itself, not to the outer literal.
  const declarations = id.getSymbol()?.getDeclarations() ?? [];
  if (declarations.length !== 1) return undefined;
  const [decl] = declarations;
  if (!Node.isVariableDeclaration(decl)) return undefined;
  const list = decl.getParent();
  if (!Node.isVariableDeclarationList(list) || list.getDeclarationKind() !== VariableDeclarationKind.Const) return undefined;
  let init = decl.getInitializer();
  if (init && Node.isAsExpression(init)) init = init.getExpression();
  return init && Node.isObjectLiteralExpression(init) ? init : undefined;
}

/**
 * Whether the property sits in an object literal, at any nesting depth, that a
 * variable is bound to. The walk stays inside the literal (object literals,
 * their properties, parentheses, conditionals, `as`): a method body or a call
 * ends it, so a value returned from inside `const store = { list() { ... } }`
 * is not "bound".
 */
function isInVariableBoundLiteral(prop: Node): boolean {
  for (let n: Node | undefined = prop.getParent(); n; n = n.getParent()) {
    if (Node.isVariableDeclaration(n)) return true;
    const isLiteralPart =
      Node.isObjectLiteralExpression(n) ||
      Node.isPropertyAssignment(n) ||
      Node.isParenthesizedExpression(n) ||
      Node.isConditionalExpression(n) ||
      Node.isAsExpression(n);
    if (!isLiteralPart) return false;
  }
  return false;
}

/** The object literals a readable spread can contribute (through parentheses and both conditional arms). */
function literalArms(expr: Node): ObjectLiteralExpression[] {
  const inner = Node.isParenthesizedExpression(expr) ? expr.getExpression() : expr;
  if (Node.isObjectLiteralExpression(inner)) return [inner];
  if (Node.isConditionalExpression(inner)) return [...literalArms(inner.getWhenTrue()), ...literalArms(inner.getWhenFalse())];
  return [];
}

/** A literal, a parenthesised or conditional choice of literals, whose own spreads are literals too. */
function isLiteralSpread(expr: Node): boolean {
  const inner = Node.isParenthesizedExpression(expr) ? expr.getExpression() : expr;
  if (Node.isObjectLiteralExpression(inner)) {
    return inner.getProperties().filter(Node.isSpreadAssignment).every((s) => isLiteralSpread(s.getExpression()));
  }
  if (Node.isConditionalExpression(inner)) return isLiteralSpread(inner.getWhenTrue()) && isLiteralSpread(inner.getWhenFalse());
  return false;
}


function scanFixture(code: string) {
  return violations(createAstProject().createSourceFile("fixture.ts", code), "fixture");
}

describe("cursor pagination orders by a unique key last", () => {
  it("every cursor query in src/ ends its orderBy with { id }", () => {
    const project = createAstProject();
    let sites = 0;
    const problems: string[] = [];
    for (const abs of walkSourceFiles(path.join(REPO_ROOT, "src"), [".ts", ".tsx"]) as string[]) {
      const rel = path.relative(REPO_ROOT, abs);
      const result = violations(project.createSourceFile(rel, readFileSync(abs, "utf8"), { overwrite: true }), rel);
      sites += result.sites;
      problems.push(...result.problems);
    }
    expect(problems).toEqual([]);
    expect(sites).toBeGreaterThanOrEqual(MIN_SITES);
    // Parses and binds every file under src/: about 2 s locally, past the 10 s
    // default on a sharded CI runner.
  }, 60_000);

  it("accepts a spread cursor with an id tiebreak", () => {
    expect(scanFixture(`tx.a.findMany({ orderBy: [{ createdAt: "desc" }, { id: "desc" }], ...(c ? { cursor: { id: c }, skip: 1 } : {}) });`).problems).toEqual([]);
  });

  it("refuses an orderBy on a non-unique column only", () => {
    expect(scanFixture(`tx.a.findMany({ orderBy: { createdAt: "desc" }, cursor: { id: c }, skip: 1 });`).problems).toHaveLength(1);
  });

  it("refuses an id that is not the last key", () => {
    expect(scanFixture(`tx.a.findMany({ orderBy: [{ id: "asc" }, { createdAt: "asc" }], cursor: { id: c } });`).problems).toHaveLength(1);
  });

  it("refuses an orderBy that is not a literal", () => {
    expect(scanFixture(`tx.a.findMany({ orderBy: order, cursor: { id: c } });`).problems).toHaveLength(1);
  });

  it("refuses a cursor built outside the query's argument literal", () => {
    // Refused twice: the cursor is outside a query literal, and the query spreads a non-literal.
    expect(scanFixture(`const page = { cursor: { id: c }, skip: 1 }; tx.a.findMany({ orderBy: [{ id: "asc" }], ...page });`).problems).toHaveLength(2);
  });

  it("refuses a shorthand cursor on a non-unique order, and accepts it with the tiebreak", () => {
    expect(scanFixture(`tx.a.findMany({ orderBy: { createdAt: "desc" }, cursor, skip: 1 });`)).toEqual({
      sites: 1,
      problems: ["fixture:1: orderBy must be an array literal ending in { id: ... }"],
    });
    expect(scanFixture(`tx.a.findMany({ orderBy: [{ createdAt: "desc" }, { id: "desc" }], cursor });`)).toEqual({ sites: 1, problems: [] });
  });

  it("refuses query arguments or spreads it cannot read, however the page object is built", () => {
    for (const code of [
      `tx.a.findMany(args);`,
      `tx.a.findMany({ orderBy: { createdAt: "desc" }, ...(c ? page : {}) });`,
      `tx.a.findMany({ orderBy: { createdAt: "desc" }, ...(page as const) });`,
      `page = { cursor: cur }; tx.a.findMany({ orderBy: { createdAt: "desc" }, ...page });`,
      `tx.a.findMany({ orderBy: { createdAt: "desc" }, ...pageOf(cur) });`,
    ]) {
      expect(scanFixture(code).problems, code).toHaveLength(1);
    }
    for (const code of [
      `tx.a.findMany({ include: rels });`,
      `tx.a.findMany({ include: { rel: relPage } });`,
      `tx.a.findMany({ include: { rel } });`,
      `tx.a.findMany({ "include": rels });`,
      `tx.a.findMany({ ["include"]: rels });`,
      `tx.a.findMany({ include: { ["rel"]: { cursor, orderBy: [{ id: "asc" }] } } });`,
      `tx.a.findMany({ include: { rel: { include: { sub: { orderBy: { createdAt: "asc" }, ...page } } } } });`,
      `tx.a.findMany({ select: { rel: { orderBy: { createdAt: "asc" }, ...page } } });`,
      `tx.a.findMany({ orderBy: { createdAt: "desc" }, ...({ ...page }) });`,
      `tx.a.findMany({ orderBy: { createdAt: "desc" }, ...(c ? {} : page) });`,
      `tx.a.findMany({ include: { rel: { orderBy: { createdAt: "asc" }, ...page } } });`,
    ]) {
      expect(scanFixture(code).problems, code).toHaveLength(1);
    }
    expect(scanFixture(`tx.a.findMany({ orderBy: [{ id: "asc" }], ...(c ? { where: { a } } : {}) });`).problems).toEqual([]);
    // A where may spread a shared filter; it carries no cursor.
    expect(scanFixture(`tx.a.findMany({ where: { ...ACTIVE }, orderBy: [{ id: "asc" }] });`).problems).toEqual([]);
    // Refused twice: the cursor sits in a variable-bound object, and the include spreads it.
    expect(
      scanFixture(`const rels = { rel: { orderBy: { createdAt: "asc" }, cursor, skip: 1 } }; tx.a.findMany({ include: { ...rels } });`).problems,
    ).toHaveLength(2);
    // Inside a readable spread's literals, and on any delegate method.
    for (const code of [
      `tx.a.findMany({ ...(c ? { include: { rel: page(cur) } } : {}) });`,
      `tx.a.findMany({ ...{ include: rels } });`,
      `tx.a.findMany({ include: { rel: { ...({ include: { sub: subPage } }) } } });`,
      `tx.a.findUnique({ where: { id }, include: { posts: postsPage } });`,
      `tx.a.update({ where: { id }, data: {}, include: { rel: page(cur) } });`,
    ]) {
      expect(scanFixture(code).problems, code).toHaveLength(1);
    }
    // A relation cursor under any delegate method is a site, judged by its own orderBy.
    expect(scanFixture(`tx.a.findUnique({ include: { posts: { cursor, orderBy: { createdAt: "asc" }, skip: 1 } } });`).problems).toHaveLength(1);
    expect(
      scanFixture(`tx.a.findUnique({ include: { posts: { cursor, orderBy: [{ createdAt: "asc" }, { id: "asc" }], skip: 1 } } });`),
    ).toEqual({ sites: 1, problems: [] });
    // A const include is read; a cursor anywhere in a variable-bound object is refused.
    expect(scanFixture(`const sel = { user: { select: { id: true } } } as const; tx.a.update({ where: { id }, data: {}, include: sel });`).problems).toEqual([]);
    expect(scanFixture(`const sel = { posts: { cursor, orderBy: { createdAt: "asc" } } }; tx.a.findUnique({ include: sel });`).problems).toHaveLength(1);
    // A quoted cursor key is still a site.
    expect(scanFixture(`tx.a.findMany({ orderBy: { createdAt: "asc" }, "cursor": { id: c } });`).problems).toEqual([
      "fixture:1: orderBy must be an array literal ending in { id: ... }",
      'fixture:1: findMany has an argument key that is not a plain name ("cursor")',
    ]);
    // A computed field name selected with a boolean is readable (retention-gc sweep).
    expect(scanFixture(`tx.a.findMany({ where: { [col]: { not: null } }, select: { id: true, [col]: true } });`).problems).toEqual([]);
    // Any receiver for a read; a string-keyed delegate for a write.
    for (const code of [
      `const d = tx.auditLog; d.findMany({ orderBy: { createdAt: "asc" }, cursor, skip: 1 });`,
      `const d = tx.auditLog; d.findMany(args);`,
      `tx["auditLog"].findMany({ orderBy: { createdAt: "asc" }, cursor, skip: 1 });`,
      `tx["a"].update({ where: { id }, data: {}, include: { rel: { cursor, orderBy: { createdAt: "asc" } } } });`,
      `tx.a.count({ orderBy: { createdAt: "asc" }, cursor, skip: 1 });`,
      `tx.a.aggregate({ orderBy: { createdAt: "asc" }, cursor, skip: 1, _count: true });`,
    ]) {
      expect(scanFixture(code).problems, code).toHaveLength(1);
    }
    // A name resolves to its own binding: a parameter or `let` shadowing an outer const is unread,
    // and a `let` is unread even with a literal initializer (a reassignment can carry a cursor).
    for (const code of [
      `const sel = { id: true }; function f(sel) { return tx.a.findMany({ where: { id }, include: sel }); }`,
      `const sel = { id: true }; { let sel = { rel: true }; tx.a.findMany({ where: { id }, include: sel }); }`,
      `const sel = { id: true }; for (const sel of xs) tx.a.findMany({ where: { id }, include: sel });`,
    ]) {
      expect(scanFixture(code).problems, code).toEqual(["fixture:1: findMany include is not an object literal"]);
    }
    // A write on an aliased delegate is not read (the stated boundary: `map.delete` shares the shape).
    expect(scanFixture(`const d = tx.a; d.update({ where: { id }, data: {}, include: { rel: relPage } });`).problems).toEqual([]);
    // Not a delegate call: `map.delete(key)`.
    expect(scanFixture(`timers.delete(key); ref.current.delete(key);`).problems).toEqual([]);
    expect(scanFixture(`tx.a.findMany({ ...(c ? { include: { rel: { where: { a } } } } : {}) });`).problems).toEqual([]);
    // Readable relation arguments, at any depth and under select, pass.
    expect(
      scanFixture(`tx.a.findMany({ select: { id: true, rel: { select: { sub: { where: { ...F }, take: 1 } } } } });`).problems,
    ).toEqual([]);
  });

  it("refuses a page object bound to a variable, whatever its cursor holds", () => {
    // Each also trips the spread rule; the bound-object rule is the one asserted here.
    for (const code of [
      `const page = { cursor, skip: 1 }; tx.a.findMany({ orderBy: { createdAt: "desc" }, ...page });`,
      `const page = { cursor: cur, skip: 1 }; tx.a.findMany({ orderBy: { createdAt: "desc" }, ...page });`,
    ]) {
      expect(scanFixture(code).problems).toContain("fixture:1: cursor outside a delegate call's argument literal");
    }
  });

  it("does not count a shorthand cursor handed to a call that is not a query", () => {
    expect(scanFixture(`store.listObjects(prefix, { cursor, pageSize });`)).toEqual({ sites: 0, problems: [] });
  });

  it("judges a relation's cursor by the relation's own orderBy", () => {
    expect(
      scanFixture(`tx.a.findMany({ orderBy: [{ id: "asc" }], include: { rel: { cursor: { id: c }, orderBy: { createdAt: "asc" } } } });`).problems,
    ).toHaveLength(1);
    expect(
      scanFixture(`tx.a.findMany({ orderBy: { createdAt: "asc" }, include: { rel: { cursor: { id: c }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] } } });`).problems,
    ).toEqual([]);
  });
});
