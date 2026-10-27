import { describe, it, expect } from "vitest";
import { fromPrismaJoinChildren, isPrismaJoinChildLoad } from "./prisma-join-children";

// Shaped like the minified interpreter in @prisma/client/runtime/client.js:
// the join-children load, then the `transaction` arm that also calls interpretNode.
const SOURCE =
  "let o=await Promise.all(t.args.children.map(async s=>({joinExpr:s,childRecords:(await this.interpretNode(s.child,r)).value})));" +
  'return{value:Va(n,o)}}case"transaction":return this.#l(r,n=>this.interpretNode(t.args,n));';
const CHILD_COLUMN = SOURCE.indexOf("interpretNode(s.child") + 1;
const TRANSACTION_COLUMN = SOURCE.indexOf("interpretNode(t.args") + 1;

describe("isPrismaJoinChildLoad", () => {
  it("matches the column of the join-children interpretNode call", () => {
    expect(isPrismaJoinChildLoad(SOURCE, CHILD_COLUMN)).toBe(true);
  });

  it("does not match the transaction arm's interpretNode call a few characters on", () => {
    expect(isPrismaJoinChildLoad(SOURCE, TRANSACTION_COLUMN)).toBe(false);
  });

  it("does not match a column merely after childRecords", () => {
    expect(isPrismaJoinChildLoad(SOURCE, CHILD_COLUMN + 3)).toBe(false);
    expect(isPrismaJoinChildLoad(SOURCE, CHILD_COLUMN - 1)).toBe(false);
  });
});

describe("fromPrismaJoinChildren", () => {
  const read = (_path: string, line: number) => (line === 11 ? SOURCE : null);
  const frame = (column: number) =>
    `Error: x\n    at Client.query (/repo/setup.ts:1:1)\n    at /repo/node_modules/@prisma/client/runtime/client.js:11:${column}`;

  it("exempts a stack whose Prisma frame is the join-children load", () => {
    expect(fromPrismaJoinChildren(frame(CHILD_COLUMN), read)).toBe(true);
  });

  it("reports a stack whose Prisma frame is any other interpreter call", () => {
    expect(fromPrismaJoinChildren(frame(TRANSACTION_COLUMN), read)).toBe(false);
  });

  it("reports a stack with no Prisma frame", () => {
    expect(fromPrismaJoinChildren("Error: x\n    at f (/repo/src/lib/a.ts:3:4)", read)).toBe(false);
  });
});
