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
 * treatment, or a named non-counter write — every counter it does not write
 * must be in `NOT_MIGRATED` with a reason, and every other user-bound model in
 * `TENANT_OWNED_LEFT`. Each counter write is scoped to the user (by the column
 * its counter counts by) and to the bootstrap tenant, and a revocation touches
 * only unrevoked rows.
 *
 * The walk refuses what it cannot read rather than skipping it (round 4, T19):
 * every reference to the client parameter inside the callback must be
 * `tx.<model>.<method>(`, the tag of `tx.$executeRaw`, or the exact argument of
 * a known read-only helper. An element access, an alias, a wrapped or cast
 * client, a use inside a nested function, or `prisma` itself throws.
 *
 * Round 5 refuses the rest of the undecidable class (T24): every call, tagged
 * template and `new` inside the callback must be a classified client call, a
 * read-only helper, or an exact-text `PURE_CALLS` entry, since a helper that
 * writes through the ALS-bound `prisma` proxy, an outer alias or an outer
 * `tx` never names the parameter. And each write's argument must be readable
 * (T25): one object literal whose `data` and `where` are object literals, no
 * spread anywhere in them, no nested write in `data`, and the non-counter
 * writes' `data` keys pinned in `NON_COUNTER_DATA_KEYS`.
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
  REVOKED_BY,
  TENANT_OWNED_LEFT,
} from "@/__tests__/helpers/bootstrap-migration-set";
import { handleOf, parseSchemaModels, userBoundModels } from "@/__tests__/helpers/user-bound-models";

const FUNCTION_NAME = "claimedTenantMembership";
const WRITE_METHODS = new Set(["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany"]);
const READ_METHODS = new Set(["findMany", "findUnique", "findFirst", "count"]);
const AUDIT_MIGRATE_CALL = "CALL audit_log_tenant_migrate(";
/** Helpers the transaction may hand `tx` to: each reads only. */
// The team-key-rotation-lock helpers write no rows: they lock team rows (and
// set the transaction's lock_timeout around that) and read memberships.
const READ_ONLY_TX_HELPERS = new Set([
  "assertBootstrapSingleMember",
  "lockTenantMemberTeamsAgainstRotation",
  "memberTeamIds",
  "assertTeamsLocked",
]);
/**
 * Calls and constructors the transaction may make that are not the client, by
 * exact callee text: only what the real body needs. A pure call's arguments
 * must be function literals, so the walk sees inside them.
 */
const PURE_CALLS = new Set(["migratedSessions.map", "Date"]);
/** Each non-counter write's `data` keys, by `<handle>.<method>`, read off the real body once and pinned. */
const NON_COUNTER_DATA_KEYS: Record<string, readonly string[]> = {
  "user.update": ["tenantId"],
  "teamMember.updateMany": ["keyDistributed"],
  "passwordEntryHistory.updateMany": ["tenantId"],
  "auditLog.$executeRaw": [],
  "emergencyAccessKeyPair.updateMany": ["tenantId"],
  "shareAccessLog.updateMany": ["tenantId"],
  "tenantMember.deleteMany": [],
  "tenantMember.create": ["tenantId", "userId", "role"],
};
/** The bootstrap tenant's id as `claimedTenantMembership` names it. */
const BOOTSTRAP_TENANT_ID = "existingTenantId";
/** The three moves by tenant alone (no user column). */
const TENANT_ONLY_MOVES = ["passwordEntryHistory", "emergencyAccessKeyPair", "shareAccessLog"] as const;

type MigrationWrite = {
  readonly handle: string;
  readonly method: string;
  readonly dataKeys: readonly string[];
  /** The `where` literal's properties, name -> initializer text. */
  readonly where: ReadonlyMap<string, string>;
};

function literalProperties(node: Node | undefined): Map<string, string> {
  const props = new Map<string, string>();
  if (!Node.isObjectLiteralExpression(node)) return props;
  for (const p of node.getProperties()) {
    if (Node.isPropertyAssignment(p)) props.set(p.getName(), p.getInitializerOrThrow().getText());
    else if (Node.isShorthandPropertyAssignment(p)) props.set(p.getName(), p.getName());
    else props.set(p.getText(), p.getText());
  }
  return props;
}

/**
 * A write's `data` keys and `where` literal; throws unless the argument is one
 * object literal whose `data` and `where`, where present, are object literals,
 * with no spread in any of them and no nested write (an object-literal value)
 * in `data`.
 */
function writeArgument(at: string, call: Node): Pick<MigrationWrite, "dataKeys" | "where"> {
  if (!Node.isCallExpression(call)) throw new Error(`${FUNCTION_NAME}: ${at} is not a call`);
  const args = call.getArguments();
  const [arg] = args;
  if (args.length !== 1 || !Node.isObjectLiteralExpression(arg)) {
    throw new Error(`${FUNCTION_NAME}: ${at}'s argument is not one object literal`);
  }
  if (arg.getProperties().some((p) => Node.isSpreadAssignment(p))) {
    throw new Error(`${FUNCTION_NAME}: ${at}'s argument contains a spread`);
  }
  const part = (name: string) => {
    const prop = arg.getProperty(name);
    if (!prop) return undefined;
    const init = Node.isPropertyAssignment(prop) ? prop.getInitializer() : undefined;
    if (!Node.isObjectLiteralExpression(init)) throw new Error(`${FUNCTION_NAME}: ${at}'s ${name} is not an object literal`);
    if (init.getProperties().some((p) => Node.isSpreadAssignment(p))) {
      throw new Error(`${FUNCTION_NAME}: ${at}'s ${name} contains a spread`);
    }
    return init;
  };
  const data = part("data");
  for (const p of data?.getProperties() ?? []) {
    if (Node.isPropertyAssignment(p) && Node.isObjectLiteralExpression(p.getInitializer())) {
      throw new Error(`${FUNCTION_NAME}: ${at}'s data.${p.getName()} is a nested write`);
    }
  }
  return { dataKeys: [...literalProperties(data).keys()], where: literalProperties(part("where")) };
}

/** `<tx>.<model>.<method>` or `<tx>.<member>`, rooted at the client parameter's name. */
function isClientMember(node: Node, tx: string): boolean {
  if (!Node.isPropertyAccessExpression(node)) return false;
  const object = node.getExpression();
  if (Node.isIdentifier(object)) return object.getText() === tx;
  return Node.isPropertyAccessExpression(object) && Node.isIdentifier(object.getExpression()) && object.getExpression().getText() === tx;
}

/**
 * Refuses any call, tagged template or `new` inside the callback that is not a
 * client call (`tx.<model>.<method>(`, the `tx.$executeRaw` tag, already
 * classified by the identifier walk), a read-only helper, or a `PURE_CALLS`
 * entry whose arguments are function literals.
 */
function refuseUnclassifiedCalls(callback: Node, tx: string): void {
  const refuse = (callee: Node) =>
    new Error(`${FUNCTION_NAME}: \`${callee.getText().slice(0, 80)}\` is called inside the transaction, and this walk cannot see its writes`);
  for (const node of callback.getDescendants()) {
    if (Node.isTaggedTemplateExpression(node)) {
      if (!isClientMember(node.getTag(), tx)) throw refuse(node.getTag());
      continue;
    }
    if (!Node.isCallExpression(node) && !Node.isNewExpression(node)) continue;
    const callee = node.getExpression();
    if (Node.isCallExpression(node) && isClientMember(callee, tx)) continue;
    if (Node.isCallExpression(node) && Node.isIdentifier(callee) && READ_ONLY_TX_HELPERS.has(callee.getText())) continue;
    if (!PURE_CALLS.has(callee.getText())) throw refuse(callee);
    for (const arg of node.getArguments()) {
      if (!Node.isArrowFunction(arg) && !Node.isFunctionExpression(arg)) {
        throw new Error(`${FUNCTION_NAME}: \`${arg.getText().slice(0, 80)}\` is passed to ${callee.getText()}, and this walk cannot see inside it`);
      }
    }
  }
}

/** An identifier in a name position (`a.<id>`, `{ <id>: v }`) rather than a reference. */
function isNamePosition(id: Node): boolean {
  const parent = id.getParent();
  if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === id) return true;
  if (Node.isPropertyAssignment(parent) && parent.getNameNode() === id) return true;
  return false;
}

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
  const param = callback.getParameters()[0];
  const tx = param?.getName();
  if (!param || !tx) throw new Error(`${FUNCTION_NAME}: the transaction callback takes no client parameter`);

  const writes: MigrationWrite[] = [];
  for (const id of callback.getDescendantsOfKind(SyntaxKind.Identifier)) {
    const text = id.getText();
    if (text !== tx && text !== "prisma") continue;
    if (isNamePosition(id) || id === param.getNameNode()) continue;
    if (text === "prisma") {
      throw new Error(`${FUNCTION_NAME}: prisma is used inside the transaction callback: ${id.getParent()?.getText().slice(0, 80)}`);
    }
    const scope = id.getFirstAncestor((n) => Node.isFunctionLikeDeclaration(n));
    if (scope !== callback) {
      throw new Error(`${FUNCTION_NAME}: unclassified use of ${tx} inside a nested function: ${id.getParent()?.getText().slice(0, 80)}`);
    }

    const parent = id.getParentOrThrow();
    if (Node.isCallExpression(parent) && parent.getArguments().includes(id)) {
      const callee = parent.getExpression().getText();
      if (!READ_ONLY_TX_HELPERS.has(callee)) {
        throw new Error(`${FUNCTION_NAME}: ${callee} receives ${tx}, and this walk cannot see its writes`);
      }
      continue;
    }
    if (!Node.isPropertyAccessExpression(parent) || parent.getExpression() !== id) {
      throw new Error(`${FUNCTION_NAME}: unclassified use of ${tx}: ${parent.getText().slice(0, 80)}`);
    }
    const grand = parent.getParentOrThrow();
    if (Node.isTaggedTemplateExpression(grand) && grand.getTag() === parent) {
      if (parent.getName() !== "$executeRaw" || !grand.getTemplate().getText().includes(AUDIT_MIGRATE_CALL)) {
        throw new Error(`${FUNCTION_NAME}: unclassified raw statement ${grand.getText().slice(0, 80)}`);
      }
      writes.push({ handle: "auditLog", method: "$executeRaw", dataKeys: [], where: new Map() });
      continue;
    }
    if (Node.isCallExpression(grand) && grand.getExpression() === parent) {
      throw new Error(`${FUNCTION_NAME}: unclassified client call ${parent.getText()}`);
    }
    const call = grand.getParent();
    if (!Node.isPropertyAccessExpression(grand) || grand.getExpression() !== parent || !Node.isCallExpression(call) || call.getExpression() !== grand) {
      throw new Error(`${FUNCTION_NAME}: unclassified use of ${tx}: ${grand.getText().slice(0, 80)}`);
    }
    const method = grand.getName();
    if (READ_METHODS.has(method)) continue;
    if (!WRITE_METHODS.has(method)) throw new Error(`${FUNCTION_NAME}: unclassified method ${grand.getText()}`);
    writes.push({ handle: parent.getName(), method, ...writeArgument(`${parent.getName()}.${method}`, call) });
  }
  refuseUnclassifiedCalls(callback, tx);
  if (writes.length === 0) throw new Error(`${FUNCTION_NAME}: the transaction yielded no writes`);
  return writes;
}

/** Each counter's user column, read off the `where` of its count in `STRANDED_COUNTERS`. */
function counterUserColumns(sf: SourceFile): Map<string, string> {
  const decl = sf.getVariableDeclarationOrThrow("STRANDED_COUNTERS");
  const init = decl.getInitializerOrThrow();
  const object = Node.isSatisfiesExpression(init) ? init.getExpression() : init;
  if (!Node.isObjectLiteralExpression(object)) throw new Error("STRANDED_COUNTERS is not an object literal");
  const columns = new Map<string, string>();
  for (const prop of object.getProperties()) {
    if (!Node.isPropertyAssignment(prop)) throw new Error(`unreadable counter ${prop.getText().slice(0, 60)}`);
    const counter = prop.getInitializerOrThrow();
    if (!Node.isArrowFunction(counter)) throw new Error(`counter ${prop.getName()} is not an arrow function`);
    const userParam = counter.getParameters()[1]?.getName();
    const where = counter
      .getDescendantsOfKind(SyntaxKind.PropertyAssignment)
      .find((p) => p.getName() === "where");
    const user = [...literalProperties(where?.getInitializer()).entries()].find(([, value]) => value === userParam);
    if (!user) throw new Error(`counter ${prop.getName()} counts by no user column`);
    columns.set(prop.getName(), user[0]);
  }
  return columns;
}

/**
 * What is wrong with a counter write's `where`: it must name the user by the
 * column the counter counts by, the bootstrap tenant, and for a revocation
 * the revocation column as null.
 */
function scopeProblems(
  write: MigrationWrite,
  userColumn: string,
  userParam: string,
  revokedBy: string | null,
): string[] {
  const problems: string[] = [];
  if (write.where.get(userColumn) !== userParam) problems.push(`${write.handle}: where.${userColumn} is not ${userParam}`);
  if (write.where.get("tenantId") !== BOOTSTRAP_TENANT_ID) {
    problems.push(`${write.handle}: where.tenantId is not ${BOOTSTRAP_TENANT_ID}`);
  }
  if (revokedBy !== null && write.where.get(revokedBy) !== "null") {
    problems.push(`${write.handle}: where.${revokedBy} is not null`);
  }
  return problems;
}

const auth = parseRouteSource(
  readFileSync(path.resolve(__dirname, "auth.ts"), "utf8"),
  "src/auth.ts",
);
const strandedRows = parseRouteSource(
  readFileSync(path.resolve(__dirname, "lib/tenant/stranded-rows.ts"), "utf8"),
  "src/lib/tenant/stranded-rows.ts",
);
const revokedByOf = (handle: string): string | null =>
  (REVOKED_BY as Record<string, string>)[handle] ?? null;

describe("bootstrap migration member set", () => {
  it("classifies every counter exactly once: migrated or not, never both", () => {
    const migrated = Object.keys(MIGRATED_COUNTERS);
    const left = Object.keys(NOT_MIGRATED);
    expect(migrated.filter((h) => left.includes(h))).toEqual([]);
    expect([...migrated, ...left].sort()).toEqual(Object.keys(STRANDED_COUNTERS).sort());
  });

  it("classifies every user-bound model that is not a counter: written, or left with a reason", () => {
    const bound = [...userBoundModels(parseSchemaModels()).keys()].map(handleOf);
    const counters = new Set(Object.keys(STRANDED_COUNTERS));
    const others = bound.filter((h) => !counters.has(h));
    expect(others.length).toBeGreaterThan(0);
    const classified = new Set([...Object.keys(NON_COUNTER_WRITES), ...Object.keys(TENANT_OWNED_LEFT)]);
    expect(others.filter((h) => !classified.has(h))).toEqual([]);
    // And nothing named left that the schema does not bind to a user.
    expect(Object.keys(TENANT_OWNED_LEFT).filter((h) => !bound.includes(h))).toEqual([]);
  });

  it("writes exactly the migrated counters and the named non-counter writes", () => {
    const written = new Set(migrationWrites(auth).map((w) => w.handle));
    const expected = [...Object.keys(MIGRATED_COUNTERS), ...Object.keys(NON_COUNTER_WRITES)].sort();
    expect([...written].sort()).toEqual(expected);
  });

  it("writes no model it names as not migrated or left", () => {
    const written = new Set(migrationWrites(auth).map((w) => w.handle));
    expect([...Object.keys(NOT_MIGRATED), ...Object.keys(TENANT_OWNED_LEFT)].filter((h) => written.has(h))).toEqual([]);
  });

  it("moves each MOVE counter's tenantId and revokes each REVOKE counter by its column", () => {
    const writes = migrationWrites(auth);
    for (const [handle, treatment] of Object.entries(MIGRATED_COUNTERS)) {
      const own = writes.filter((w) => w.handle === handle);
      expect(own, `${handle} is written once`).toHaveLength(1);
      expect(own[0].method, handle).toBe("updateMany");
      if (treatment === MIGRATION_TREATMENT.MOVE) {
        expect(own[0].dataKeys, handle).toEqual(["tenantId"]);
      } else {
        expect(own[0].dataKeys, handle).toEqual([revokedByOf(handle)]);
      }
    }
  });

  it("scopes each counter write to the user and the bootstrap tenant, and each revocation to unrevoked rows", () => {
    const userParam = auth.getFunctionOrThrow(FUNCTION_NAME).getParameters()[0].getName();
    const userColumns = counterUserColumns(strandedRows);
    const problems = migrationWrites(auth)
      .filter((w) => w.handle in MIGRATED_COUNTERS)
      .flatMap((w) => {
        const column = userColumns.get(w.handle);
        if (!column) return [`${w.handle}: no counter names its user column`];
        return scopeProblems(w, column, userParam, revokedByOf(w.handle));
      });
    expect(problems).toEqual([]);
  });

  it("scopes the moves by tenant alone to the bootstrap tenant it checked has one member", () => {
    const writes = migrationWrites(auth);
    for (const handle of TENANT_ONLY_MOVES) {
      const own = writes.filter((w) => w.handle === handle);
      expect(own, handle).toHaveLength(1);
      expect([...own[0].where], handle).toEqual([["tenantId", BOOTSTRAP_TENANT_ID]]);
    }
    const check = auth
      .getFunctionOrThrow(FUNCTION_NAME)
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter((c) => c.getExpression().getText() === "assertBootstrapSingleMember");
    expect(check.map((c) => c.getArguments()[1]?.getText())).toEqual([BOOTSTRAP_TENANT_ID]);
  });

  it("writes each non-counter with exactly the data keys pinned for it", () => {
    const pinned = migrationWrites(auth)
      .filter((w) => w.handle in NON_COUNTER_WRITES)
      .map((w) => [`${w.handle}.${w.method}`, w.dataKeys]);
    expect(Object.fromEntries(pinned)).toEqual(NON_COUNTER_DATA_KEYS);
    expect(pinned).toHaveLength(Object.keys(NON_COUNTER_DATA_KEYS).length);
  });

  it("reads each counter's user column off STRANDED_COUNTERS", () => {
    const columns = counterUserColumns(strandedRows);
    expect([...columns.keys()].sort()).toEqual(Object.keys(STRANDED_COUNTERS).sort());
    expect(columns.get("operatorToken")).toBe("subjectUserId");
    expect(columns.get("attachment")).toBe("createdById");
  });

  describe("the walk refuses what it cannot read", () => {
    // One virtual path per sample: the shared project overwrites a file of the same path.
    let samples = 0;
    const source = (text: string) => parseRouteSource(text, `bootstrap-migration-sample-${(samples += 1)}.ts`);
    // A readable write ahead of each refused shape, so a removed refusal shows
    // as a walk that returns, not as some other throw.
    const WRITE = "await tx.tag.updateMany({ data: { tenantId: x } });\n";
    const sample = (body: string) =>
      source(`async function ${FUNCTION_NAME}() {\n  await prisma.$transaction(async (tx) => {\n${body}\n  });\n}\n`);

    it("reads a write, a read-only helper, a pure call and the audit procedure from its own sample", () => {
      const writes = migrationWrites(
        sample(
          "await assertBootstrapSingleMember(tx, existingTenantId);\n" +
            "const migratedSessions = await tx.session.findMany({});\n" +
            "tokens = migratedSessions.map((s) => s.sessionToken);\n" +
            "const revokedAt = new Date();\n" +
            "await tx.tag.updateMany({ where: { userId, tenantId: existingTenantId }, data: { tenantId: t } });\n" +
            "await tx.$executeRaw`CALL audit_log_tenant_migrate(${a})`;\n" +
            "await tx.tenantMember.deleteMany({ where: { userId, tenantId: existingTenantId } });\n" +
            "await tx.tenantMember.create({ data: { tenantId: target.id, userId, role: TENANT_ROLE.MEMBER } });",
        ),
      );
      expect(writes).toEqual([
        {
          handle: "tag",
          method: "updateMany",
          dataKeys: ["tenantId"],
          where: new Map([["userId", "userId"], ["tenantId", "existingTenantId"]]),
        },
        { handle: "auditLog", method: "$executeRaw", dataKeys: [], where: new Map() },
        {
          handle: "tenantMember",
          method: "deleteMany",
          dataKeys: [],
          where: new Map([["userId", "userId"], ["tenantId", "existingTenantId"]]),
        },
        { handle: "tenantMember", method: "create", dataKeys: ["tenantId", "userId", "role"], where: new Map() },
      ]);
    });

    it.each([
      ["the function is missing", source("async function other() {}\n"), "not found"],
      ["there is no transaction", source(`async function ${FUNCTION_NAME}() {}\n`), "found 0"],
      [
        "there are two transactions",
        source(
          `async function ${FUNCTION_NAME}() {\n  await prisma.$transaction(async (tx) => { await tx.tag.updateMany({}); });\n` +
            "  await prisma.$transaction(async (tx) => { await tx.tag.updateMany({}); });\n}\n",
        ),
        "found 2",
      ],
      ["the callback is not a function literal", source(`async function ${FUNCTION_NAME}() {\n  await prisma.$transaction(run);\n}\n`), "not a function literal"],
      [
        "the callback takes no client parameter",
        source(`async function ${FUNCTION_NAME}() {\n  await prisma.$transaction(async () => {});\n}\n`),
        "no client parameter",
      ],
      ["the transaction yields no writes", sample("await tx.session.findMany({});"), "no writes"],
      ["tx goes to an unknown helper", sample(`${WRITE}await moveEverything(tx, a);`), "cannot see its writes"],
      ["a method is unclassified", sample("await tx.tag.aggregate({});"), "unclassified method"],
      ["a raw statement is not the audit procedure", sample("await tx.$executeRaw`UPDATE tags SET x = 1`;"), "unclassified raw statement"],
      ["a raw call is not a tagged template", sample("await tx.$executeRawUnsafe('UPDATE tags SET x = 1');"), "unclassified client call"],
      ["a model is reached by element access", sample(`${WRITE}await tx[model].updateMany({ data: { tenantId: t } });`), "unclassified use of tx"],
      ["tx is aliased", sample(`${WRITE}const t = tx;\nawait t.tag.updateMany({ data: { tenantId: x } });`), "unclassified use of tx"],
      ["a delegate is aliased", sample(`${WRITE}const tags = tx.tag;\nawait tags.updateMany({ data: { tenantId: x } });`), "unclassified use of tx"],
      ["tx is wrapped in an object", sample(`${WRITE}await move({ tx });`), "unclassified use of tx"],
      ["tx is cast", sample(`${WRITE}await (tx as Client).tag.updateMany({ data: { tenantId: x } });`), "unclassified use of tx"],
      ["tx is asserted non-null", sample(`${WRITE}await tx!.tag.updateMany({ data: { tenantId: x } });`), "unclassified use of tx"],
      ["tx is spread", sample(`${WRITE}await move(...tx);`), "unclassified use of tx"],
      ["prisma writes inside the callback", sample(`${WRITE}await prisma.tag.updateMany({ data: { tenantId: x } });`), "prisma is used inside"],
      [
        "tx is used inside a nested arrow passed as an argument",
        sample(`${WRITE}await Promise.all(ids.map((id) => tx.tag.updateMany({ where: { id }, data: { tenantId: x } })));`),
        "inside a nested function",
      ],
      // T24: calls that never name the client parameter.
      ["a helper is called without tx", sample(`${WRITE}await moveEverything(userId);`), "`moveEverything` is called inside the transaction"],
      [
        "an alias declared outside the callback writes",
        source(
          `async function ${FUNCTION_NAME}() {\n  const db = prisma;\n  await prisma.$transaction(async (tx) => {\n` +
            `${WRITE}await db.tag.updateMany({ data: { tenantId: x } });\n  });\n}\n`,
        ),
        "`db.tag.updateMany` is called inside the transaction",
      ],
      [
        "an outer tx writes past a renamed parameter",
        source(
          `async function ${FUNCTION_NAME}(tx) {\n  await prisma.$transaction(async (client) => {\n` +
            "await client.tag.updateMany({ data: { tenantId: x } });\nawait tx.tag.updateMany({ data: { tenantId: x } });\n  });\n}\n",
        ),
        "`tx.tag.updateMany` is called inside the transaction",
      ],
      ["the callee is an element access", sample(`${WRITE}await movers[kind](userId);`), "`movers[kind]` is called inside the transaction"],
      ["the callee is a call", sample(`${WRITE}await moverFor(kind)(userId);`), "`moverFor(kind)` is called inside the transaction"],
      ["a tagged template is not the client's", sample(`${WRITE}await sql\`UPDATE tags SET x = 1\`;`), "`sql` is called inside the transaction"],
      ["a constructor is not a pure one", sample(`${WRITE}new Mover(userId);`), "`Mover` is called inside the transaction"],
      ["a pure call is handed a function it cannot see", sample(`${WRITE}migratedSessions.map(moveOne);`), "`moveOne` is passed to migratedSessions.map"],
      [
        "a pure call's arrow uses tx",
        sample(`${WRITE}migratedSessions.map((s) => tx.tag.updateMany({ where: { id: s.id }, data: { tenantId: x } }));`),
        "inside a nested function",
      ],
      // T25: writes whose argument the walk cannot read.
      ["a write's argument is not an object literal", sample(`${WRITE}await tx.tag.updateMany(args);`), "tag.updateMany's argument is not one object literal"],
      ["a write's argument is spread", sample(`${WRITE}await tx.tag.updateMany({ ...args });`), "tag.updateMany's argument contains a spread"],
      ["data is not an object literal", sample(`${WRITE}await tx.tag.updateMany({ data: payload });`), "tag.updateMany's data is not an object literal"],
      ["data is shorthand", sample(`${WRITE}await tx.tag.updateMany({ data });`), "tag.updateMany's data is not an object literal"],
      ["where is not an object literal", sample(`${WRITE}await tx.tag.updateMany({ where: scope, data: { tenantId: x } });`), "tag.updateMany's where is not an object literal"],
      ["data contains a spread", sample(`${WRITE}await tx.tag.updateMany({ data: { ...payload } });`), "tag.updateMany's data contains a spread"],
      ["where contains a spread", sample(`${WRITE}await tx.tag.updateMany({ where: { ...scope }, data: { tenantId: x } });`), "tag.updateMany's where contains a spread"],
      [
        "data holds a nested write",
        sample(`${WRITE}await tx.user.update({ where: { id: u }, data: { tenant: { connect: { id: t } } } });`),
        "user.update's data.tenant is a nested write",
      ],
    ])("throws when %s", (_case, sf, text) => {
      expect(() => migrationWrites(sf)).toThrow(text);
    });

    it("finds a counter write whose where omits the user column, the tenant, or the null predicate", () => {
      const [write] = migrationWrites(
        sample("await tx.mcpAccessToken.updateMany({ where: { tenantId: other }, data: { revokedAt } });"),
      );
      expect(scopeProblems(write, "userId", "userId", "revokedAt")).toEqual([
        "mcpAccessToken: where.userId is not userId",
        "mcpAccessToken: where.tenantId is not existingTenantId",
        "mcpAccessToken: where.revokedAt is not null",
      ]);
    });
  });
});
