/**
 * Self-test for scripts/checks/check-tx-concurrent-queries.mjs — the gate
 * refusing a Promise combinator over queries on one interactive transaction
 * client (issue #975).
 *
 * Each fixture tree carries stubs of src/lib/tenant-rls.ts (the openers the
 * gate derives by signature) and src/lib/prisma.ts (the ambient client), plus
 * one site file. RT7: every red case names the shape that escaped the text
 * grep; every allow case names a shape a spelling-based gate would refuse.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GUARD = fileURLToPath(new URL("../checks/check-tx-concurrent-queries.mjs", import.meta.url));

const TENANT_RLS = `import type { Prisma, PrismaClient } from "@prisma/client";
export async function withTenantRls<T>(
  prisma: PrismaClient,
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => fn(tx));
}
export async function withBypassRls<T>(
  prisma: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  grant: string,
): Promise<T> {
  return prisma.$transaction(async (tx) => fn(tx));
}
`;
const PRISMA = `import { PrismaClient } from "@prisma/client";
export const prisma = new PrismaClient();
`;
const HEADER = `import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withBypassRls, withTenantRls } from "@/lib/tenant-rls";
import { withUserTenantRls } from "@/lib/tenant-context";
`;

let root;

function write(rel, contents) {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents, "utf8");
}

function seed({ tenantRls = TENANT_RLS } = {}) {
  write("src/lib/tenant-rls.ts", tenantRls);
  write("src/lib/prisma.ts", PRISMA);
  write("scripts/noop.ts", "export const noop = Promise.all([]);\n");
}

function site(body) {
  write("src/lib/site.ts", HEADER + body);
}

function runGuard() {
  const r = spawnSync("node", [GUARD], {
    encoding: "utf8",
    env: { ...process.env, TX_CONCURRENT_ROOT: root },
  });
  return { exitCode: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function expectRed(fragment) {
  const { exitCode, stdout, stderr } = runGuard();
  expect(exitCode, stdout + stderr).toBe(1);
  expect(stderr).toContain("src/lib/site.ts:");
  expect(stderr).toContain(fragment);
}

function expectGreen() {
  const { exitCode, stdout, stderr } = runGuard();
  expect(exitCode, stdout + stderr).toBe(0);
  expect(stdout).toContain("check-tx-concurrent-queries: OK");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tx-concurrent-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-tx-concurrent-queries.mjs — refused", () => {
  it("refuses Promise.all over direct calls on an opener's callback client", () => {
    seed();
    site(`export const f = (id: string) =>
  withBypassRls(prisma, async (tx) => {
    const [a, b] = await Promise.all([tx.user.count(), tx.team.count()]);
    return a + b;
  }, "grant");
`);
    expectRed("transaction client `tx`");
  });

  it("refuses Promise.all over a map whose callback queries the client", () => {
    seed();
    site(`export const f = (ids: string[]) =>
  withTenantRls(prisma, "t", async (tx) => {
    await Promise.all(ids.map(async (id) => {
      await tx.user.update({ where: { id }, data: {} });
    }));
  });
`);
    expectRed("transaction client `tx`");
  });

  it("refuses Promise.all over helpers handed the client", () => {
    seed();
    site(`async function countUsers(db: unknown) { return db; }
export const f = () =>
  withBypassRls(prisma, async (tx) => Promise.all([countUsers(tx), countUsers(tx)]), "grant");
`);
    expectRed("transaction client `tx`");
  });

  it("refuses Promise.all through an aliased wrapper import", () => {
    seed();
    write(
      "src/lib/site.ts",
      `import { prisma as db } from "@/lib/prisma";
import { withBypassRls as wb } from "@/lib/tenant-rls";
export const f = () => wb(db, async (c) => Promise.all([c.user.count(), c.team.count()]), "grant");
`,
    );
    expectRed("transaction client `c`");
  });

  it("refuses the ambient prisma inside withUserTenantRls, which hands its callback no client", () => {
    seed();
    site(`export const f = (userId: string) =>
  withUserTenantRls(userId, () => Promise.all([prisma.user.count(), prisma.team.count()]));
`);
    expectRed("ambient `prisma`");
  });

  it("refuses the ambient prisma with no context in sight — the caller may open one", () => {
    seed();
    site(`export async function load(id: string) {
  const [a, b] = await Promise.all([
    prisma.team.findUnique({ where: { id } }),
    prisma.teamFolder.findUnique({ where: { id } }),
  ]);
  return { a, b };
}
`);
    expectRed("ambient `prisma`");
  });

  it("refuses a parameter typed Prisma.TransactionClient", () => {
    seed();
    site(`export async function count(db: Prisma.TransactionClient) {
  return Promise.allSettled([db.user.count(), db.team.count()]);
}
`);
    expectRed("Promise.allSettled over transaction client `db`");
  });

  it("refuses a parameter typed through a derived alias of the client type", () => {
    seed();
    site(`type TxOrPrisma = PrismaClient | Prisma.TransactionClient;
type Db = TxOrPrisma;
export async function count(db: Db) {
  return Promise.race([db.user.count(), db.team.count()]);
}
`);
    expectRed("transaction client `db`");
  });

  it("refuses an object parameter's client member", () => {
    seed();
    site(`export async function count(params: { userId: string; tx: Prisma.TransactionClient }) {
  return Promise.all([params.tx.user.count(), params.tx.team.count()]);
}
`);
    expectRed("transaction client `params`");
  });

  it("refuses the callback client of a locally derived wrapper", () => {
    seed();
    site(`async function inSweepTx<T>(client: PrismaClient, fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  return client.$transaction(async (tx) => fn(tx));
}
export const f = (client: PrismaClient) =>
  inSweepTx(client, async (t) => Promise.all([t.user.count(), t.team.count()]));
`);
    expectRed("transaction client `t`");
  });

  it("refuses the callback client of $transaction on any receiver", () => {
    seed();
    site(`export const f = (worker: PrismaClient) =>
  worker.$transaction(async (tx) => Promise.all([tx.user.count(), tx.team.count()]));
`);
    expectRed("transaction client `tx`");
  });

  it("refuses a const array of lazy queries handed to Promise.all", () => {
    seed();
    site(`export const f = () =>
  withBypassRls(prisma, async (tx) => {
    const queries = [tx.user.count(), tx.team.count()];
    return Promise.all(queries);
  }, "grant");
`);
    expectRed("transaction client `tx`");
  });
});

describe("check-tx-concurrent-queries.mjs — allowed", () => {
  it("allows sequential awaits on the client", () => {
    seed();
    site(`export const f = () =>
  withBypassRls(prisma, async (tx) => {
    const a = await tx.user.count();
    const b = await tx.team.count();
    return a + b;
  }, "grant");
`);
    expectGreen();
  });

  it("allows Promise.all over a non-transaction PrismaClient and over pure promises", () => {
    seed();
    site(`export async function f(worker: PrismaClient, urls: string[]) {
  await Promise.all([worker.user.count(), worker.team.count()]);
  await Promise.all(urls.map((u) => fetch(u)));
}
`);
    expectGreen();
  });

  it("allows elements that each open their own transaction", () => {
    seed();
    site(`export const f = (a: string, b: string) =>
  Promise.all([
    withBypassRls(prisma, async (tx) => tx.user.findUnique({ where: { id: a } }), "grant"),
    withBypassRls(prisma, async (tx) => tx.user.findUnique({ where: { id: b } }), "grant"),
  ]);
`);
    expectGreen();
  });

  it("allows a shadowing local named like a client that is not one", () => {
    seed();
    // The client alias comes first in the file, so a file-wide lookup of `tx`
    // answers with it; only the innermost visible binding is the plain object.
    site(`export const g = () =>
  withBypassRls(prisma, async (client) => {
    const tx = client;
    return tx.user.count();
  }, "grant");
export async function h(items: number[]) {
  const tx = { id: 1 };
  return Promise.all(items.map(async (n) => n + tx.id));
}
`);
    expectGreen();
  });
});

describe("check-tx-concurrent-queries.mjs — fails closed", () => {
  it("refuses a scan root that contributes no source file", () => {
    write("src/lib/site.ts", "export const x = Promise.all([]);\n");
    const { exitCode, stderr } = runGuard();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("contributed no source file: scripts");
  });

  it("refuses when the opener signatures no longer derive as wrappers", () => {
    seed({ tenantRls: TENANT_RLS.replaceAll("fn: (tx: Prisma.TransactionClient) => Promise<T>", "fn: Function") });
    site("export const x = Promise.all([]);\n");
    const { exitCode, stderr } = runGuard();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("derivation lost withBypassRls");
  });
});
