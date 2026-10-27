/**
 * Self-test for scripts/checks/check-tx-concurrent-queries.mjs — the gate
 * refusing a Promise combinator over queries on one interactive transaction
 * client (issue #975).
 *
 * Each fixture tree carries stubs of src/lib/tenant-rls.ts and
 * src/lib/tenant-context.ts (the openers the gate derives by signature) and
 * src/lib/prisma.ts (the ambient client), plus one site file. RT7: every red
 * cell names a shape that escaped an earlier version or the text grep; every
 * allow cell names a shape a spelling-based gate would refuse.
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
const TENANT_CONTEXT = `import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withTenantRls } from "@/lib/tenant-rls";
export async function withUserTenantRls<T>(
  userId: string,
  fn: ((tenantId: string, tx: Prisma.TransactionClient) => Promise<T>) | (() => Promise<T>),
): Promise<T> {
  return withTenantRls(prisma, userId, (tx) => (fn as (t: string, tx: Prisma.TransactionClient) => Promise<T>)(userId, tx));
}
export async function withTeamTenantRls<T>(
  teamId: string,
  fn: ((tenantId: string, tx: Prisma.TransactionClient) => Promise<T>) | (() => Promise<T>),
): Promise<T> {
  return withTenantRls(prisma, teamId, (tx) => (fn as (t: string, tx: Prisma.TransactionClient) => Promise<T>)(teamId, tx));
}
`;
const PRISMA = `import { PrismaClient } from "@prisma/client";
export const prisma = new PrismaClient();
`;
const HEADER = `import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withBypassRls, withTenantRls } from "@/lib/tenant-rls";
import { withUserTenantRls, withTeamTenantRls } from "@/lib/tenant-context";
import { load, fill } from "@/lib/elsewhere";
`;

let root;

function write(rel, contents) {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents, "utf8");
}

function seed({ tenantRls = TENANT_RLS, prisma = PRISMA, scripts = "export const noop = Promise.all([]);\n" } = {}) {
  write("src/lib/tenant-rls.ts", tenantRls);
  write("src/lib/tenant-context.ts", TENANT_CONTEXT);
  if (prisma !== null) write("src/lib/prisma.ts", prisma);
  write("scripts/noop.ts", scripts);
}

function site(body) {
  write("src/lib/site.ts", HEADER + body);
}

function runGuard(env = {}) {
  const r = spawnSync("node", [GUARD], {
    encoding: "utf8",
    env: { ...process.env, TX_CONCURRENT_ROOT: root, ...env },
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

function expectRefusal(fragment, env = {}) {
  const { exitCode, stderr } = runGuard(env);
  expect(exitCode).toBe(1);
  expect(stderr).toContain(fragment);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tx-concurrent-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-tx-concurrent-queries.mjs — refused: the client binding", () => {
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

  it("refuses the client withTeamTenantRls hands its callback as the second parameter", () => {
    seed();
    site(`export const f = (teamId: string) =>
  withTeamTenantRls(teamId, async (_tenantId, c) => Promise.all([c.user.count(), c.team.count()]));
`);
    expectRed("transaction client `c`");
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

  it("refuses a parameter typed Prisma.TransactionClient", () => {
    seed();
    site(`export async function count(db: Prisma.TransactionClient) {
  return Promise.allSettled([db.user.count(), db.team.count()]);
}
`);
    expectRed("Promise.allSettled over transaction client `db`");
  });

  it("refuses a parameter typed through an alias derived from a later alias (fixpoint)", () => {
    seed();
    site(`type Db = TxOrPrisma;
type TxOrPrisma = PrismaClient | Prisma.TransactionClient;
export async function count(db: Db) {
  return Promise.race([db.user.count(), db.team.count()]);
}
`);
    expectRed("transaction client `db`");
  });

  it("refuses an object parameter's client member, and allows its other members", () => {
    seed();
    site(`export async function count(params: { userId: string; tx: Prisma.TransactionClient }) {
  return Promise.all([params.tx.user.count(), params.tx.team.count()]);
}
`);
    expectRed("transaction client `params`");
  });

  it("allows Promise.all over an object parameter's non-client members", () => {
    seed();
    site(`export async function count(params: { userId: string; tx: Prisma.TransactionClient }) {
  return Promise.all([load(params.userId), load(params.userId)]);
}
`);
    expectGreen();
  });

  it("refuses a destructured client parameter", () => {
    seed();
    site(`export async function count({ tx }: { tx: Prisma.TransactionClient }) {
  return Promise.all([tx.user.count(), tx.team.count()]);
}
`);
    expectRed("transaction client `tx`");
  });

  it("refuses a client destructured through an interface", () => {
    seed();
    site(`interface Deps { tx: Prisma.TransactionClient; userId: string }
export async function count({ tx }: Deps) {
  return Promise.all([tx.user.count(), tx.team.count()]);
}
`);
    expectRed("transaction client `tx`");
  });

  it("refuses const tx = params.tx", () => {
    seed();
    site(`export async function count(params: { tx: Prisma.TransactionClient }) {
  const tx = params.tx;
  return Promise.all([tx.user.count(), tx.team.count()]);
}
`);
    expectRed("transaction client `params`");
  });

  it("refuses const { tx } = params", () => {
    seed();
    site(`export async function count(params: { tx: Prisma.TransactionClient }) {
  const { tx } = params;
  return Promise.all([tx.user.count(), tx.team.count()]);
}
`);
    expectRed("transaction client `tx`");
  });

  it("refuses const db = params.tx ?? prisma", () => {
    seed();
    site(`export async function count(params: { tx?: Prisma.TransactionClient }) {
  const db = params.tx ?? prisma;
  return Promise.all([db.user.count(), db.team.count()]);
}
`);
    expectRed("`db` → transaction client `params`");
  });

  it("refuses an object-type callback property's client parameter", () => {
    seed();
    site(`type Hooks = { inTx?: (tx: Prisma.TransactionClient) => Promise<void> };
export const hooks: Hooks = {
  inTx: async (t) => {
    await Promise.all([t.user.count(), t.team.count()]);
  },
};
`);
    expectRed("transaction client `t`");
  });

  it("refuses the callback client of a wrapper typed through a function-type alias", () => {
    seed();
    site(`type TxFn<T> = (tx: Prisma.TransactionClient) => Promise<T>;
async function inTx<T>(client: PrismaClient, fn: TxFn<T>) {
  return client.$transaction(async (tx) => fn(tx));
}
export const f = (client: PrismaClient) =>
  inTx(client, async (t) => Promise.all([t.user.count(), t.team.count()]));
`);
    expectRed("transaction client `t`");
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

  it('refuses Promise["all"]', () => {
    seed();
    site(`export const f = () =>
  withBypassRls(prisma, async (tx) => Promise["all"]([tx.user.count(), tx.team.count()]), "grant");
`);
    expectRed("transaction client `tx`");
  });
});

describe("check-tx-concurrent-queries.mjs — refused: following what the argument evaluates", () => {
  it("refuses a map whose callback queries the client", () => {
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

  it("refuses helpers handed the client", () => {
    seed();
    site(`export const f = () =>
  withBypassRls(prisma, async (tx) => Promise.all([load(tx), load(tx)]), "grant");
`);
    expectRed("transaction client `tx`");
  });

  it("refuses a const alias of the client inside the callback", () => {
    seed();
    site(`export const f = () =>
  withBypassRls(prisma, async (tx) => {
    const db = tx;
    return Promise.all([db.user.count(), db.team.count()]);
  }, "grant");
`);
    expectRed("`db` → transaction client `tx`");
  });

  it("refuses lazy queries held in consts and listed in the array", () => {
    seed();
    site(`export const f = () =>
  withBypassRls(prisma, async (tx) => {
    const a = tx.user.count();
    const b = tx.team.count();
    return Promise.all([a, b]);
  }, "grant");
`);
    expectRed("`a` → transaction client `tx`");
  });

  it("refuses a const array of lazy queries handed to Promise.all", () => {
    seed();
    site(`export const f = () =>
  withBypassRls(prisma, async (tx) => {
    const queries = [tx.user.count(), tx.team.count()];
    return Promise.all(queries);
  }, "grant");
`);
    expectRed("`queries` → transaction client `tx`");
  });

  it("refuses an array built with push", () => {
    seed();
    site(`export const f = () =>
  withBypassRls(prisma, async (tx) => {
    const queries: Promise<number>[] = [];
    queries.push(tx.user.count());
    queries.push(tx.team.count());
    return Promise.all(queries);
  }, "grant");
`);
    expectRed("`queries` → transaction client `tx`");
  });

  it("refuses Object.values over an object of lazy queries", () => {
    seed();
    site(`export const f = () =>
  withBypassRls(prisma, async (tx) => {
    const byModel = { users: tx.user.count(), teams: tx.team.count() };
    return Promise.all(Object.values(byModel));
  }, "grant");
`);
    expectRed("`byModel` → transaction client `tx`");
  });

  it("refuses a spread element, which holds any number of queries", () => {
    seed();
    site(`export const f = () =>
  withBypassRls(prisma, async (tx) => {
    const queries = [tx.user.count()];
    return Promise.all([...queries]);
  }, "grant");
`);
    expectRed("`queries` → transaction client `tx`");
  });

  it("refuses a closure mapped over the ids", () => {
    seed();
    site(`export const f = (ids: string[]) =>
  withBypassRls(prisma, async (tx) => {
    const one = (id: string) => tx.user.findUnique({ where: { id } });
    return Promise.all(ids.map(one));
  }, "grant");
`);
    expectRed("`one` → transaction client `tx`");
  });

  it("refuses a closure called once per element", () => {
    seed();
    site(`export const f = (a: string, b: string) =>
  withBypassRls(prisma, async (tx) => {
    async function one(id: string) {
      return tx.user.findUnique({ where: { id } });
    }
    return Promise.all([one(a), one(b)]);
  }, "grant");
`);
    expectRed("`one` → transaction client `tx`");
  });

  it("refuses a value that only awaits part of itself — the rest is a lazy query", () => {
    seed();
    site(`export const f = () =>
  withBypassRls(prisma, async (tx) => {
    const a = (await load(tx)).user.count();
    const b = (await load(tx)).team.count();
    return Promise.all([a, b]);
  }, "grant");
`);
    expectRed("`a` → transaction client `tx`");
  });

  it("refuses a container handed to a call it cannot see into", () => {
    seed();
    site(`export const f = () =>
  withBypassRls(prisma, async () => {
    const queries: Promise<number>[] = [];
    fill(queries);
    return Promise.all(queries);
  }, "grant");
`);
    expectRed("unanalysable write: `queries` passed to fill(…)");
  });
});

describe("check-tx-concurrent-queries.mjs — refused: the ambient client", () => {
  it("refuses ambient prisma in a combinator written inside a withUserTenantRls callback", () => {
    seed();
    site(`export const f = (userId: string) =>
  withUserTenantRls(userId, () => Promise.all([prisma.user.count(), prisma.team.count()]));
`);
    expectRed("ambient `prisma`");
  });

  it("refuses ambient prisma with no context in sight — the caller may open one", () => {
    seed();
    site(`export async function load2(id: string) {
  const [a, b] = await Promise.all([
    prisma.team.findUnique({ where: { id } }),
    prisma.teamFolder.findUnique({ where: { id } }),
  ]);
  return { a, b };
}
`);
    expectRed("ambient `prisma`");
  });

  it("refuses a relative import of the ambient client", () => {
    seed();
    write(
      "src/lib/site.ts",
      `import { prisma } from "./prisma";
export const f = () => Promise.all([prisma.user.count(), prisma.team.count()]);
`,
    );
    expectRed("ambient `prisma`");
  });

  it("refuses the ambient client through a namespace import", () => {
    seed();
    write(
      "src/lib/site.ts",
      `import * as db from "@/lib/prisma";
export const f = () => Promise.all([db.prisma.user.count(), db.prisma.team.count()]);
`,
    );
    expectRed("ambient `db`");
  });

  it("refuses a const alias of the ambient client", () => {
    seed();
    site(`const db = prisma;
export const f = () => Promise.all([db.user.count(), db.team.count()]);
`);
    expectRed("`db` → ambient `prisma`");
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

  it("allows one element that reaches the client beside ones that do not", () => {
    seed();
    site(`export const f = (url: string) =>
  withBypassRls(prisma, async (tx) => Promise.all([tx.user.count(), fetch(url)]), "grant");
`);
    expectGreen();
  });

  it("allows settled values computed from the client", () => {
    seed();
    site(`export const f = (urls: string[]) =>
  withBypassRls(prisma, async (tx) => {
    const count = await tx.user.count();
    return Promise.all(urls.map((u) => fetch(u + count)));
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

  it("allows elements that each open their own transaction on the ambient client", () => {
    seed();
    site(`export const f = (a: string, b: string) =>
  Promise.all([
    withBypassRls(prisma, async (tx) => tx.user.findUnique({ where: { id: a } }), "grant"),
    withBypassRls(prisma, async (tx) => tx.user.findUnique({ where: { id: b } }), "grant"),
  ]);
`);
    expectGreen();
  });

  it("allows withTeamTenantRls elements, each running the ambient client in a context of its own", () => {
    seed();
    site(`export const f = (a: string, b: string) =>
  Promise.all([
    withTeamTenantRls(a, async () => prisma.team.findUnique({ where: { id: a } })),
    withTeamTenantRls(b, async () => {
      const team = await prisma.team.findUnique({ where: { id: b } });
      return prisma.teamFolder.findMany({ where: { teamId: team?.id } });
    }),
  ]);
`);
    expectGreen();
  });

  it("allows promises held in variables that each open their own context (the invitations route)", () => {
    seed();
    site(`export async function f(teamId: string, email: string) {
  const inTeam = withTeamTenantRls(teamId, async () => {
    const inv = await prisma.teamInvitation.findFirst({ where: { email } });
    const team = await prisma.team.findUnique({ where: { id: teamId } });
    return [inv, team] as const;
  });
  const anywhere = withBypassRls(prisma, (tx) => tx.user.findUnique({ where: { email } }), "grant");
  return Promise.all([inTeam, anywhere, withUserTenantRls(email, async () => prisma.user.count())]);
}
`);
    expectGreen();
  });

  it("resolves an imported wrapper to its own module, not a same-named helper elsewhere", () => {
    seed();
    // A helper of the same name, with its callback first, in another file. Keyed
    // by name alone it made `prisma` (argument 0 of the real withTenantRls) read
    // as a callback slot, so the client argument was reported as ambient use.
    write(
      "src/lib/other.ts",
      `import type { Prisma } from "@prisma/client";
export async function withTenantRls<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return fn({} as Prisma.TransactionClient);
}
`,
    );
    site(`export const f = (a: string, b: string) =>
  Promise.all([
    withTenantRls(prisma, a, async (tx) => tx.user.count()),
    withTenantRls(prisma, b, async (tx) => tx.user.count()),
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
    expectRefusal("contributed no source file: scripts");
  });

  it("refuses a tree with no Promise combinator at all", () => {
    seed({ scripts: "export const noop = 1;\n" });
    write("src/lib/site.ts", "export const x = 1;\n");
    expectRefusal("no Promise combinator found");
  });

  it("refuses when the opener signatures no longer derive as wrappers", () => {
    seed({ tenantRls: TENANT_RLS.replaceAll("fn: (tx: Prisma.TransactionClient) => Promise<T>", "fn: Function") });
    site("export const x = Promise.all([]);\n");
    expectRefusal("derivation lost withBypassRls");
  });

  it("refuses, under the repo floors, a tree without src/lib/prisma.ts", () => {
    seed({ prisma: null });
    site("export const x = Promise.all([]);\n");
    expectRefusal("src/lib/prisma.ts was not scanned", { TX_CONCURRENT_STRICT: "1" });
  });

  it("refuses, under the repo floors, a prisma module that no longer exports prisma", () => {
    seed({ prisma: "export const db = 1;\n" });
    site("export const x = Promise.all([]);\n");
    expectRefusal("no longer exports `prisma`", { TX_CONCURRENT_STRICT: "1" });
  });

  it("refuses, under the repo floors, a tree where no ambient import resolves", () => {
    seed();
    write("src/lib/tenant-context.ts", TENANT_CONTEXT.replace('import { prisma } from "@/lib/prisma";', 'import { prisma } from "@/lib/db";'));
    write("src/lib/site.ts", "export const x = Promise.all([]);\n");
    expectRefusal("ambient matching is blind", { TX_CONCURRENT_STRICT: "1" });
  });

  it("refuses, under the repo floors, a missing opener file", () => {
    seed();
    rmSync(join(root, "src/lib/tenant-context.ts"));
    site("export const x = Promise.all([]);\n");
    expectRefusal("src/lib/tenant-context.ts was not scanned", { TX_CONCURRENT_STRICT: "1" });
  });

  it("passes the repo floors on a complete fixture tree", () => {
    seed();
    site("export const x = Promise.all([]);\n");
    const { exitCode, stdout, stderr } = runGuard({ TX_CONCURRENT_STRICT: "1" });
    expect(exitCode, stdout + stderr).toBe(0);
  });
});
