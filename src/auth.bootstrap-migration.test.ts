/**
 * The bootstrap migration's member set (rows 6 / 9a, `claimedTenantMembership`
 * in src/auth.ts), read from its transaction as it stands rather than listed by
 * hand. Round 3 of the claim-binding review found eight of the models
 * `STRANDED_COUNTERS` derives from the schema left behind by the migration, with
 * nothing to say so: the integration cells' table list had been copied off the
 * same transaction, so it agreed with the omission.
 *
 * Every model the transaction writes must be classified in
 * `@/__tests__/helpers/bootstrap-migration-set` — a migrated counter with its
 * treatment, or a named non-counter write — and every counter it does not
 * write must be in `NOT_MIGRATED` with a reason. A call the walk cannot
 * classify (an unknown method, a raw statement other than the audit procedure,
 * `tx` handed to a helper other than the known read-only check) fails the
 * test rather than being skipped.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Node, SyntaxKind } from "ts-morph";
import type { SourceFile } from "ts-morph";
import { parseRouteSource } from "@/__tests__/proxy/ast-guards";
import { STRANDED_COUNTERS } from "@/lib/tenant/stranded-rows";
import {
  MIGRATED_COUNTERS,
  MIGRATION_TREATMENT,
  NON_COUNTER_WRITES,
  NOT_MIGRATED,
} from "@/__tests__/helpers/bootstrap-migration-set";

const FUNCTION_NAME = "claimedTenantMembership";
const WRITE_METHODS = new Set(["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"]);
const READ_METHODS = new Set(["findMany", "findUnique", "findFirst", "count"]);
const AUDIT_MIGRATE_CALL = "CALL audit_log_tenant_migrate(";
/** Helpers the transaction may hand `tx` to: each reads only. */
const READ_ONLY_TX_HELPERS = new Set(["assertBootstrapSingleMember"]);

type MigrationWrite = { readonly handle: string; readonly method: string; readonly dataKeys: readonly string[] };

/** Every write the migration transaction makes, by Prisma handle; throws on anything it cannot classify. */
function migrationWrites(sf: SourceFile): MigrationWrite[] {
  const fn = sf.getFunction(FUNCTION_NAME);
  if (!fn) throw new Error(`${FUNCTION_NAME} not found`);
  const transactions = fn
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((call) => call.getExpression().getText() === "prisma.$transaction");
  if (transactions.length !== 1) {
    throw new Error(`${FUNCTION_NAME}: expected one prisma.$transaction, found ${transactions.length}`);
  }
  const callback = transactions[0].getArguments()[0];
  if (!callback || !(Node.isArrowFunction(callback) || Node.isFunctionExpression(callback))) {
    throw new Error(`${FUNCTION_NAME}: the prisma.$transaction callback is not a function literal`);
  }
  const tx = callback.getParameters()[0]?.getName();
  if (!tx) throw new Error(`${FUNCTION_NAME}: the transaction callback takes no client parameter`);

  const writes: MigrationWrite[] = [];
  for (const call of callback.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    const passesTx = call.getArguments().some((arg) => arg.getText() === tx);
    if (passesTx) {
      if (!READ_ONLY_TX_HELPERS.has(callee.getText())) {
        throw new Error(`${FUNCTION_NAME}: ${callee.getText()} receives ${tx}, and this walk cannot see its writes`);
      }
      continue;
    }
    if (!Node.isPropertyAccessExpression(callee)) continue;
    const model = callee.getExpression();
    if (!Node.isPropertyAccessExpression(model) || model.getExpression().getText() !== tx) {
      if (callee.getExpression().getText() === tx) {
        throw new Error(`${FUNCTION_NAME}: unclassified client call ${callee.getText()}`);
      }
      continue;
    }
    const method = callee.getName();
    if (READ_METHODS.has(method)) continue;
    if (!WRITE_METHODS.has(method)) throw new Error(`${FUNCTION_NAME}: unclassified method ${callee.getText()}`);
    const args = call.getArguments()[0];
    const data = Node.isObjectLiteralExpression(args) ? args.getProperty("data") : undefined;
    const dataValue = data && Node.isPropertyAssignment(data) ? data.getInitializer() : undefined;
    const dataKeys = Node.isObjectLiteralExpression(dataValue)
      ? dataValue.getProperties().map((p) => (Node.isPropertyAssignment(p) || Node.isShorthandPropertyAssignment(p) ? p.getName() : p.getText()))
      : [];
    writes.push({ handle: model.getName(), method, dataKeys });
  }
  for (const tagged of callback.getDescendantsOfKind(SyntaxKind.TaggedTemplateExpression)) {
    const tag = tagged.getTag().getText();
    if (!tag.startsWith(`${tx}.`)) continue;
    if (tag !== `${tx}.$executeRaw` || !tagged.getTemplate().getText().includes(AUDIT_MIGRATE_CALL)) {
      throw new Error(`${FUNCTION_NAME}: unclassified raw statement ${tagged.getText().slice(0, 80)}`);
    }
    writes.push({ handle: "auditLog", method: "$executeRaw", dataKeys: [] });
  }
  if (writes.length === 0) throw new Error(`${FUNCTION_NAME}: the transaction yielded no writes`);
  return writes;
}

const auth = parseRouteSource(
  readFileSync(path.resolve(__dirname, "auth.ts"), "utf8"),
  "src/auth.ts",
);

describe("bootstrap migration member set", () => {
  it("classifies every counter exactly once: migrated or not, never both", () => {
    const migrated = Object.keys(MIGRATED_COUNTERS);
    const left = Object.keys(NOT_MIGRATED);
    expect(migrated.filter((h) => left.includes(h))).toEqual([]);
    expect([...migrated, ...left].sort()).toEqual(Object.keys(STRANDED_COUNTERS).sort());
  });

  it("writes exactly the migrated counters and the named non-counter writes", () => {
    const written = new Set(migrationWrites(auth).map((w) => w.handle));
    const expected = [...Object.keys(MIGRATED_COUNTERS), ...Object.keys(NON_COUNTER_WRITES)].sort();
    expect([...written].sort()).toEqual(expected);
  });

  it("writes no counter it names as not migrated", () => {
    const written = new Set(migrationWrites(auth).map((w) => w.handle));
    expect(Object.keys(NOT_MIGRATED).filter((h) => written.has(h))).toEqual([]);
  });

  it("moves each MOVE counter's tenantId and revokes each REVOKE counter", () => {
    const writes = migrationWrites(auth);
    for (const [handle, treatment] of Object.entries(MIGRATED_COUNTERS)) {
      const own = writes.filter((w) => w.handle === handle);
      expect(own, `${handle} is written once`).toHaveLength(1);
      expect(own[0].method, handle).toBe("updateMany");
      if (treatment === MIGRATION_TREATMENT.MOVE) {
        expect(own[0].dataKeys, handle).toEqual(["tenantId"]);
      } else {
        expect(own[0].dataKeys, handle).toEqual([handle === "mcpAuthorizationCode" ? "usedAt" : "revokedAt"]);
      }
    }
  });

  describe("the walk refuses what it cannot read", () => {
    // One virtual path per sample: the shared project overwrites a file of the same path.
    let samples = 0;
    const sample = (body: string) =>
      parseRouteSource(
        `async function ${FUNCTION_NAME}() {\n  await prisma.$transaction(async (tx) => {\n${body}\n  });\n}\n`,
        `bootstrap-migration-sample-${(samples += 1)}.ts`,
      );

    it("reads a write and the audit procedure from its own sample", () => {
      const writes = migrationWrites(
        sample("await tx.tag.updateMany({ where: {}, data: { tenantId: t } });\nawait tx.$executeRaw`CALL audit_log_tenant_migrate(${a})`;"),
      );
      expect(writes).toEqual([
        { handle: "tag", method: "updateMany", dataKeys: ["tenantId"] },
        { handle: "auditLog", method: "$executeRaw", dataKeys: [] },
      ]);
    });

    it.each([
      ["the function is missing", parseRouteSource("async function other() {}\n", "bootstrap-migration-sample-none.ts"), "not found"],
      ["the transaction yields no writes", sample("await tx.session.findMany({});"), "no writes"],
      ["tx goes to an unknown helper", sample("await moveEverything(tx, a);"), "cannot see its writes"],
      ["a method is unclassified", sample("await tx.tag.aggregate({});"), "unclassified method"],
      ["a raw statement is not the audit procedure", sample("await tx.$executeRaw`UPDATE tags SET x = 1`;"), "unclassified raw statement"],
      ["a raw call is not a tagged template", sample("await tx.$executeRawUnsafe('UPDATE tags SET x = 1');"), "unclassified client call"],
    ])("throws when %s", (_case, sf, text) => {
      expect(() => migrationWrites(sf)).toThrow(text);
    });
  });
});
