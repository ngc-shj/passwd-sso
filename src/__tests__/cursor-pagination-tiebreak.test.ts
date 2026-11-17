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
 * A site is any `cursor:` property in src/. Its query's argument object must
 * have an `orderBy` array literal whose last element is exactly `{ id: ... }`.
 * A cursor whose argument object cannot be found, or whose `orderBy` is not a
 * literal, is refused rather than guessed.
 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import { readFileSync } from "node:fs";
import { Node, SyntaxKind } from "ts-morph";
import type { SourceFile } from "ts-morph";
import { createAstProject, walkSourceFiles } from "../../scripts/checks/lib/ast-project.mjs";

const REPO_ROOT = path.resolve(__dirname, "../..");
const QUERY_METHODS: ReadonlySet<string> = new Set(["findMany", "findFirst", "findFirstOrThrow"]);

/** The cursor sites found; a drop below this means the scan stopped seeing them. */
const MIN_SITES = 11;

function violations(sf: SourceFile, label: string): { sites: number; problems: string[] } {
  const problems: string[] = [];
  let sites = 0;
  const cursorProps = [
    ...sf.getDescendantsOfKind(SyntaxKind.PropertyAssignment),
    ...sf.getDescendantsOfKind(SyntaxKind.ShorthandPropertyAssignment),
  ].filter((prop) => prop.getName() === "cursor");
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
        const callee = parent.getExpression();
        if (Node.isPropertyAccessExpression(callee) && QUERY_METHODS.has(callee.getName())) {
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
      const holder = prop.getParent();
      const inBoundObject = Node.isObjectLiteralExpression(holder) && Node.isVariableDeclaration(holder.getParent());
      if (inBoundObject || (Node.isPropertyAssignment(prop) && Node.isObjectLiteralExpression(prop.getInitializer()))) {
        sites += 1;
        problems.push(`${where}: cursor outside a findMany/findFirst argument literal`);
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
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee) || !QUERY_METHODS.has(callee.getName())) continue;
    const [arg] = call.getArguments();
    if (!arg) continue;
    const where = `${label}:${call.getStartLineNumber()}`;
    if (!Node.isObjectLiteralExpression(arg)) {
      problems.push(`${where}: ${callee.getName()} arguments are not an object literal`);
      continue;
    }
    for (const spread of arg.getProperties().filter(Node.isSpreadAssignment)) {
      if (!isLiteralSpread(spread.getExpression())) {
        problems.push(`${where}: ${callee.getName()} spreads arguments that are not a literal`);
      }
    }
  }
  return { sites, problems };
}

function isLiteralSpread(expr: Node): boolean {
  const inner = Node.isParenthesizedExpression(expr) ? expr.getExpression() : expr;
  if (Node.isObjectLiteralExpression(inner)) return true;
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
  });

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
    expect(scanFixture(`tx.a.findMany({ orderBy: [{ id: "asc" }], ...(c ? { where: { a } } : {}) });`).problems).toEqual([]);
  });

  it("refuses a page object bound to a variable, whatever its cursor holds", () => {
    // Each also trips the spread rule; the bound-object rule is the one asserted here.
    for (const code of [
      `const page = { cursor, skip: 1 }; tx.a.findMany({ orderBy: { createdAt: "desc" }, ...page });`,
      `const page = { cursor: cur, skip: 1 }; tx.a.findMany({ orderBy: { createdAt: "desc" }, ...page });`,
    ]) {
      expect(scanFixture(code).problems).toContain("fixture:1: cursor outside a findMany/findFirst argument literal");
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
