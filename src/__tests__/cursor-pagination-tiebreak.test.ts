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
  for (const prop of sf.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
    if (prop.getName() !== "cursor") continue;
    const where = `${label}:${prop.getStartLineNumber()}`;

    // Climb to the object literal passed straight to a query method, through
    // spreads and conditionals (`...(cursor ? { cursor, skip: 1 } : {})`).
    let args: Node | undefined;
    for (let n: Node | undefined = prop.getParent(); n; n = n.getParent()) {
      const parent = n.getParent();
      if (Node.isObjectLiteralExpression(n) && parent && Node.isCallExpression(parent)) {
        const callee = parent.getExpression();
        if (Node.isPropertyAccessExpression(callee) && QUERY_METHODS.has(callee.getName())) args = n;
        break;
      }
    }
    if (!args || !Node.isObjectLiteralExpression(args)) {
      // A Prisma cursor is a unique-where object literal (`{ id }`). Other
      // `cursor` keys (a CSS cursor, a blob-store continuation token) hold a
      // string and are not sites; an object-literal one we cannot place is.
      if (Node.isObjectLiteralExpression(prop.getInitializer())) {
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
  return { sites, problems };
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
    expect(scanFixture(`const page = { cursor: { id: c }, skip: 1 }; tx.a.findMany({ orderBy: [{ id: "asc" }], ...page });`).problems).toHaveLength(1);
  });
});
