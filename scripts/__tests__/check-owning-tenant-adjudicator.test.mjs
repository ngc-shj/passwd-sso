import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const GATE = join(REPO, "scripts", "checks", "check-owning-tenant-adjudicator.mjs");
const MANIFEST_REL = "scripts/checks/owning-tenant-adjudicator-manifest.json";

let root;

function run() {
  try {
    return {
      code: 0,
      out: execFileSync("node", [GATE], {
        encoding: "utf8",
        env: { ...process.env, OWNING_TENANT_CHECK_ROOT: root },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function write(rel, body) {
  mkdirSync(join(root, dirname(rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

function manifest(obj) {
  write(MANIFEST_REL, JSON.stringify(obj, null, 2));
}

/** The adjudicator read, as the helper issues it. */
const HELPER_CALL = `const t = await resolveOwningTenantIdFromClient(tx, userId);\n`;

/** A raw read of a user's tenant identity, unwrapped. */
const RAW_READ = `const u = await tx.user.findUnique({ where: { id }, select: { tenantId: true } });\n`;

const inBypass = (body) => `await withBypassRls(prisma, async (tx) => {\n${body}});\n`;
const inTenantScope = (body) => `await withUserTenantRls(userId, async (tx) => {\n${body}});\n`;

/**
 * The gate resolves every projection key against the schema under its ROOT, so
 * the fixture supplies one. Written here rather than pointed at the real schema
 * because two cells below turn on what the schema DECLARES — that a relation is
 * seen because its type is `User`, not because it is spelled `user`.
 */
const SCHEMA = `model User {
  id        String @id
  email     String
  tenantId  String
  tenant    Tenant @relation(fields: [tenantId], references: [id])
  tenantMemberships TenantMember[]
}

model Tenant {
  id    String @id
  users User[]
}

model TenantMember {
  id       String @id
  tenantId String
  userId   String
  user     User   @relation(fields: [userId], references: [id])
}

model Team {
  id      String @id
  owner   User   @relation(fields: [ownerId], references: [id])
  ownerId String
  members TenantMember[]
}

model Session {
  id     String @id
  userId String
  user   User   @relation(fields: [userId], references: [id])
}
`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "owning-tenant-"));
  // ts-morph resolves nothing here, but the lib helper still needs the dir.
  mkdirSync(join(root, "src"), { recursive: true });
  write("prisma/schema.prisma", SCHEMA);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-owning-tenant-adjudicator", () => {
  it("passes when an adjudicator file uses the helper and holds no raw read", () => {
    write("src/lib/thing.ts", inBypass(HELPER_CALL));
    manifest({ "src/lib/thing.ts": { disposition: "adjudicator" } });
    const { code, out } = run();
    expect(code).toBe(0);
    expect(out).toContain("no unconstrained read");
  });

  it("fails when an adjudicator file re-inlines a raw read under a bypass", () => {
    // The regression the gate exists for: the helper call stays, and a raw read
    // is added beside it. A file-set gate that only asked "does this file mention
    // the helper" reports clean on exactly this.
    write("src/lib/thing.ts", inBypass(HELPER_CALL + RAW_READ));
    manifest({ "src/lib/thing.ts": { disposition: "adjudicator" } });
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("OUTSIDE any tenant-scoped context");
    expect(out).toContain("src/lib/thing.ts");
  });

  it("fails when an adjudicator file stops referencing the helper", () => {
    write("src/lib/thing.ts", inTenantScope(RAW_READ));
    manifest({ "src/lib/thing.ts": { disposition: "adjudicator" } });
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("never references");
  });

  // ─── the completeness halves ──────────────────────────────────────────────

  it("fails when a file reads a user's tenant with no manifest entry", () => {
    // The half that stops the class growing silently. It went 1 -> 2 -> 4 -> 16
    // by hand before it was derived; a new site must not be able to join quietly.
    write("src/lib/known.ts", inBypass(HELPER_CALL));
    write("src/lib/newcomer.ts", inBypass(RAW_READ));
    manifest({ "src/lib/known.ts": { disposition: "adjudicator" } });
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("no MANIFEST entry");
    expect(out).toContain("src/lib/newcomer.ts");
  });

  it("fails when a manifest entry outlives the read it describes", () => {
    write("src/lib/thing.ts", inBypass(HELPER_CALL));
    write("src/lib/gone.ts", `export const x = 1;\n`);
    manifest({
      "src/lib/thing.ts": { disposition: "adjudicator" },
      "src/lib/gone.ts": { disposition: "adjudicator" },
    });
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("MANIFEST entry with no user-tenant read");
    expect(out).toContain("src/lib/gone.ts");
  });

  // ─── the allow side ───────────────────────────────────────────────────────

  it("does not flag a read inside a tenant-scoped opener", () => {
    // Without this the gate is indistinguishable from one that bans the column
    // outright — 13 safe sites in the real tree read it this way, and RLS is what
    // makes them safe.
    write("src/lib/scoped.ts", inTenantScope(RAW_READ));
    manifest({ "src/lib/scoped.ts": { disposition: "tenant-scoped" } });
    expect(run().code).toBe(0);
  });

  it("resolves a LOCAL wrapper that delegates to a tenant-scoped opener", () => {
    // `withVaultTenantRls` in the real tree. A name-matching pass calls this
    // unconstrained — measured on the discovery pass — and the two files it
    // affects would then need manifest exceptions they do not deserve.
    write(
      "src/lib/local-wrapper.ts",
      `const withVaultTenantRls = (fn) => tenantId ? withTenantRls(prisma, tenantId, fn) : withUserTenantRls(userId, fn);\n` +
        `await withVaultTenantRls(async (tx) => {\n${RAW_READ}});\n`,
    );
    manifest({ "src/lib/local-wrapper.ts": { disposition: "tenant-scoped" } });
    expect(run().code).toBe(0);
  });

  it("does NOT accept a local wrapper that can reach a bypass", () => {
    // The deny half of the clause above. A wrapper falling back to withBypassRls
    // leaves the read unconstrained on that arm, so resolving it as safe would
    // be a fail-open in the resolver itself.
    write(
      "src/lib/leaky-wrapper.ts",
      `const maybeScoped = (fn) => tenantId ? withTenantRls(prisma, tenantId, fn) : withBypassRls(prisma, fn);\n` +
        `await maybeScoped(async (tx) => {\n${RAW_READ}});\n`,
    );
    manifest({ "src/lib/leaky-wrapper.ts": { disposition: "tenant-scoped" } });
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("OUTSIDE any tenant-scoped context");
  });

  // ─── read shapes the detector must not be blind to ────────────────────────
  //
  // Round 2 red-proved the first version blind to every one of these. The cells
  // below are per-SHAPE, not one loop: each was observed failing on its own, and
  // a single parameterised cell would let one spelling regress behind another.

  it.each([
    ["a bare findUnique with no select", `tx.user.findUnique({ where: { id } })`],
    ["an unprojected findFirst", `tx.user.findFirst({ where: { email } })`],
    // `accounts`, not `tenant`: with `include: { tenant: true }` this row passed
    // through the relation-name regex, so it was green whether or not the gate
    // handled `include` at all. An include-only read returns every scalar.
    ["include of an unrelated relation", `tx.user.findUnique({ where: { id }, include: { accounts: true } })`],
    ["include alongside a tenant-free select", `tx.user.findUnique({ where: { id }, include: { tenant: true } })`],
    ["findMany", `tx.user.findMany({ where: {}, select: { tenantId: true } })`],
    ["findUniqueOrThrow", `tx.user.findUniqueOrThrow({ where: { id }, select: { tenantId: true } })`],
    ["findFirstOrThrow", `tx.user.findFirstOrThrow({ where: { id }, select: { tenantId: true } })`],
    ["a select that is not an inline literal", `tx.user.findUnique({ where: { id }, select: SEL })`],
  ])("sees %s", (_label, read) => {
    // A Prisma read with no projection returns every scalar, `tenantId` among
    // them — so "no select" is the BROADEST shape, not an exempt one.
    write("src/lib/unlisted.ts", inBypass(`const u = await ${read};\n`));
    manifest({ "src/lib/other.ts": { disposition: "adjudicator" } });
    write("src/lib/other.ts", inBypass(HELPER_CALL));
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("no MANIFEST entry");
    expect(out).toContain("src/lib/unlisted.ts");
  });

  // ─── reached through a RELATION, not through `prisma.user` ────────────────
  //
  // The receiver-keyed version of this gate saw none of these: it required the
  // read to be issued on `.user`, while `User.tenantId` comes back through any
  // projection that descends into a User-typed relation.

  it.each([
    ["a user relation selecting tenantId", `tx.tenantMember.findFirst({ select: { user: { select: { tenantId: true } } } })`],
    ["a user relation taken whole", `tx.session.findUnique({ where: { id }, include: { user: true } })`],
    ["a user relation with include but no select", `tx.session.findUnique({ where: { id }, select: { user: { include: { tenant: true } } } })`],
    ["a chain through a second relation", `tx.team.findUnique({ select: { members: { select: { user: { select: { tenantId: true } } } } } })`],
    ["a relation projected by a non-literal", `tx.session.findUnique({ where: { id }, select: { user: { select: SEL } } })`],
  ])("sees %s", (_label, read) => {
    write("src/lib/unlisted.ts", inBypass(`const r = await ${read};\n`));
    write("src/lib/other.ts", inBypass(HELPER_CALL));
    manifest({ "src/lib/other.ts": { disposition: "adjudicator" } });
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("no MANIFEST entry");
    expect(out).toContain("src/lib/unlisted.ts");
  });

  it("sees a User relation that is not spelled `user`", () => {
    // `owner` is typed `User` in the fixture schema, so the walk has to descend
    // into it. What this cell catches is a pass that treats a User-typed field not
    // spelled `user` as opaque — keying only the User branch on the name is not
    // enough to fail it, because the generic relation descent still reaches
    // `tenantId`. (The fixture declares one such field; prisma/schema.prisma, 16.)
    write(
      "src/lib/owner-read.ts",
      inBypass(`const t = await tx.team.findUnique({ select: { owner: { select: { tenantId: true } } } });\n`),
    );
    write("src/lib/other.ts", inBypass(HELPER_CALL));
    manifest({ "src/lib/other.ts": { disposition: "adjudicator" } });
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("src/lib/owner-read.ts");
  });

  it.each([
    ["a user relation projected to other scalars", `tx.tenantMember.findMany({ select: { userId: true, user: { select: { email: true } } } })`],
    ["a user used only as a WHERE filter", `tx.tenantMember.findMany({ where: { user: { email } }, select: { tenantId: true } })`],
    ["a sibling relation taken whole", `tx.user.findUnique({ where: { id }, select: { tenantMemberships: { select: { tenantId: true } } } })`],
  ])("does not flag %s", (_label, read) => {
    // The third is the authoritative source, not the stale copy: the tenantId on
    // a TenantMember row IS the membership. Flagging it would push the
    // adjudicator's own query shape into the manifest.
    write("src/lib/safe.ts", inBypass(`const r = await ${read};\n`));
    write("src/lib/other.ts", inBypass(HELPER_CALL));
    manifest({ "src/lib/other.ts": { disposition: "adjudicator" } });
    const { code, out } = run();
    expect(code, out).toBe(0);
  });

  // ─── the schema the walk resolves against ─────────────────────────────────

  it("fails when the prisma schema is missing", () => {
    // Without it every key resolves to "unknown". Whichever way that were
    // defaulted, the walk would report on the default rather than on the code.
    rmSync(join(root, "prisma", "schema.prisma"));
    write("src/lib/thing.ts", inBypass(HELPER_CALL));
    manifest({ "src/lib/thing.ts": { disposition: "adjudicator" } });
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("prisma schema not found");
  });

  it("fails when the prisma schema declares no User model", () => {
    write("prisma/schema.prisma", `model Tenant {\n  id String @id\n}\n`);
    write("src/lib/thing.ts", inBypass(HELPER_CALL));
    manifest({ "src/lib/thing.ts": { disposition: "adjudicator" } });
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("no User model");
  });

  it("fails when the prisma schema declares no models at all", () => {
    write("prisma/schema.prisma", `datasource db {\n  provider = "postgresql"\n}\n`);
    write("src/lib/thing.ts", inBypass(HELPER_CALL));
    manifest({ "src/lib/thing.ts": { disposition: "adjudicator" } });
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("zero models");
  });

  it("does NOT resolve a wrapper that reaches a bypass through a SECOND wrapper", () => {
    // Depth 2. The outer wrapper's own text names a tenant opener and never
    // names withBypassRls, so the one-level version resolved it SAFE — the exact
    // fail-open the leaky-wrapper cell above exists to prevent, one indirection
    // away. Measured on the shipped gate before the recursion was added.
    write(
      "src/lib/deep-wrapper.ts",
      `const inner = (fn) => withBypassRls(prisma, fn);\n` +
        `const outer = (fn) => tenantId ? withTenantRls(prisma, tenantId, fn) : inner(fn);\n` +
        `await outer(async (tx) => {\n${RAW_READ}});\n`,
    );
    manifest({ "src/lib/deep-wrapper.ts": { disposition: "tenant-scoped" } });
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("OUTSIDE any tenant-scoped context");
  });

  it("fails when an adjudicator file only IMPORTS the helper without calling it", () => {
    // `usesHelper` matched any identifier, so an unused import satisfied the
    // disposition on its own — while a raw read sat beside it.
    write(
      "src/lib/import-only.ts",
      `import { resolveOwningTenantIdFromClient } from "@/lib/tenant-context";\n` +
        inBypass(RAW_READ),
    );
    manifest({ "src/lib/import-only.ts": { disposition: "adjudicator" } });
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("never references");
  });

  // ─── column-intended ──────────────────────────────────────────────────────

  it("permits an unconstrained read only with a stated reason", () => {
    write("src/lib/deliberate.ts", inBypass(RAW_READ));
    manifest({ "src/lib/deliberate.ts": { disposition: "column-intended", reason: "this IS the adjudicator" } });
    expect(run().code).toBe(0);
  });

  it("fails a column-intended entry with no reason", () => {
    write("src/lib/deliberate.ts", inBypass(RAW_READ));
    manifest({ "src/lib/deliberate.ts": { disposition: "column-intended" } });
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("without a reason");
  });

  // ─── refusals: examined nothing must not read as found nothing ────────────

  it("fails when the manifest is missing", () => {
    write("src/lib/thing.ts", inBypass(HELPER_CALL));
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("manifest not found");
  });

  it("fails when the manifest is empty", () => {
    write("src/lib/thing.ts", inBypass(HELPER_CALL));
    manifest({});
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("is empty");
  });

  it("fails when the manifest is not valid JSON", () => {
    write("src/lib/thing.ts", inBypass(HELPER_CALL));
    write(MANIFEST_REL, "{ not json");
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("not valid JSON");
  });

  it("fails when the scan root holds no source files", () => {
    manifest({ "src/lib/thing.ts": { disposition: "adjudicator" } });
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("zero source files");
  });

  it("fails when the scan root does not exist", () => {
    rmSync(join(root, "src"), { recursive: true, force: true });
    manifest({ "src/lib/thing.ts": { disposition: "adjudicator" } });
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("does not exist");
  });

  // ─── wiring ───────────────────────────────────────────────────────────────

  it("is wired into scripts/pre-pr.sh", () => {
    // The gate, this self-test and check-gate-selftest-coverage.sh all stay green
    // if the runner line is deleted — an orphaned gate reports PASS by never
    // running. Same remedy as check-emergency-activate-atomic.test.mjs.
    const prePr = readFileSync(join(REPO, "scripts", "pre-pr.sh"), "utf8");
    expect(prePr).toMatch(/^(queue|run)_step .*check-owning-tenant-adjudicator\.mjs/m);
  });

  it("the shipped manifest carries a reason on every column-intended entry", () => {
    // Asserted against the REAL manifest, not a synthetic one: the reason is the
    // only thing standing between "deliberate exception" and "silently exempt",
    // and the gate can only check the entries a given root happens to exercise.
    const real = JSON.parse(readFileSync(join(REPO, MANIFEST_REL), "utf8"));
    const exempt = Object.entries(real).filter(([, v]) => v.disposition === "column-intended");
    expect(exempt.length).toBeGreaterThan(0);
    for (const [path, v] of exempt) {
      expect(v.reason, `${path} is column-intended with no reason`).toBeTruthy();
    }
  });
});

describe("check-owning-tenant-adjudicator — context by scope, not by spelling (round 5 S3/T2)", () => {
  const TENANT_SCOPED_FILE = { "src/lib/thing.ts": { disposition: "tenant-scoped" } };

  it("does not treat an import aliased to a tenant opener's name as tenant-scoped", () => {
    write(
      "src/lib/thing.ts",
      'import { withBypassRls as withUserTenantRls } from "@/lib/tenant-rls";\n' + inTenantScope(RAW_READ),
    );
    manifest(TENANT_SCOPED_FILE);
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("OUTSIDE any tenant-scoped context");
  });

  it("does not trust a parameter that shadows a local tenant wrapper", () => {
    write(
      "src/lib/thing.ts",
      "const scoped = (fn) => withUserTenantRls(userId, fn);\n" +
        `export async function f(scoped) {\n  await scoped(async (tx) => {\n${RAW_READ}});\n}\n`,
    );
    manifest(TENANT_SCOPED_FILE);
    expect(run().code).toBe(1);
  });

  it("does not trust a wrapper that runs the callback outside its tenant opener", () => {
    write(
      "src/lib/thing.ts",
      "async function guarded(fn) {\n  await withUserTenantRls(userId, async () => {});\n  return fn(prisma);\n}\n" +
        `export const f = () => guarded(async (tx) => {\n${RAW_READ}});\n`,
    );
    manifest(TENANT_SCOPED_FILE);
    expect(run().code).toBe(1);
  });

  it("passes a read inside a local wrapper that hands the callback to a tenant opener", () => {
    write(
      "src/lib/thing.ts",
      "const scoped = (fn) => withUserTenantRls(userId, fn);\n" +
        `export const f = () => scoped(async (tx) => {\n${RAW_READ}});\n`,
    );
    manifest(TENANT_SCOPED_FILE);
    const { code, out } = run();
    expect(code).toBe(0);
    expect(out).toContain("no unconstrained read");
  });
});

describe("check-owning-tenant-adjudicator — an opener's context covers its callback only (round 6 R49)", () => {
  const TENANT_SCOPED_FILE = { "src/lib/thing.ts": { disposition: "tenant-scoped" } };
  const TENANT_READ = "prisma.user.findUnique({ where: { id }, select: { tenantId: true } })";

  it("does not treat a read in withTenantRls's tenantId argument as tenant-scoped", () => {
    // The tenant id is computed before the context opens, so the read supplying it
    // returns the unconstrained copy.
    write("src/lib/thing.ts", `await withTenantRls(prisma, (await ${TENANT_READ}).tenantId, async (tx) => {});\n`);
    manifest(TENANT_SCOPED_FILE);
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("OUTSIDE any tenant-scoped context");
  });

  it("does not treat a read in a function handed to withTenantRls's tenantId argument as tenant-scoped", () => {
    write("src/lib/thing.ts", `await withTenantRls(prisma, await tenantOf(async () => ${TENANT_READ}), async (tx) => {});\n`);
    manifest(TENANT_SCOPED_FILE);
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("OUTSIDE any tenant-scoped context");
  });
});

describe("check-owning-tenant-adjudicator — every fail-closed branch has a cell (round 6 RT7/RT10)", () => {
  const TENANT_SCOPED_FILE = { "src/lib/thing.ts": { disposition: "tenant-scoped" } };

  it("does not trust a wrapper whose callback parameter is destructured", () => {
    write(
      "src/lib/thing.ts",
      "const scoped = ({ fn }) => withUserTenantRls(userId, fn);\n" +
        `export const f = () => scoped({ fn: async (tx) => {\n${RAW_READ}} });\n`,
    );
    manifest(TENANT_SCOPED_FILE);
    expect(run().code).toBe(1);
  });

  it("does not trust a wrapper whose callback parameter is a rest parameter", () => {
    write(
      "src/lib/thing.ts",
      "const scoped = (...args) => withUserTenantRls(userId, args[0]);\n" +
        `export const f = () => scoped(async (tx) => {\n${RAW_READ}});\n`,
    );
    manifest(TENANT_SCOPED_FILE);
    expect(run().code).toBe(1);
  });

  it("does not let an outer tenant opener answer for a callee bound to a parameter", () => {
    // The one shape where null and UNKNOWN differ: null walks on to the opener.
    write(
      "src/lib/thing.ts",
      `export function f(run) {\n  return withUserTenantRls(userId, async () => run(async (tx) => {\n${RAW_READ}}));\n}\n`,
    );
    manifest(TENANT_SCOPED_FILE);
    expect(run().code).toBe(1);
  });
});

describe("check-owning-tenant-adjudicator — a read runs in an opener's context only inside its callback function (round 7 R7-S1/F-R7-1)", () => {
  const TENANT_SCOPED_FILE = { "src/lib/thing.ts": { disposition: "tenant-scoped" } };
  const TENANT_READ = "prisma.user.findUnique({ where: { id }, select: { tenantId: true } })";

  it("does not treat a read that IS withUserTenantRls's callback argument, inside an arrow, as tenant-scoped", () => {
    write("src/lib/thing.ts", `export const f = async () => withUserTenantRls(userId, ${TENANT_READ});\n`);
    manifest(TENANT_SCOPED_FILE);
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("OUTSIDE any tenant-scoped context");
  });

  it("does not treat an IIFE in the callback position as tenant-scoped", () => {
    write(
      "src/lib/thing.ts",
      `export const f = () => withUserTenantRls(userId, (() => {\n  const early = ${TENANT_READ};\n  return async (tx) => early;\n})());\n`,
    );
    manifest(TENANT_SCOPED_FILE);
    expect(run().code).toBe(1);
  });

  it("does not treat a function passed in withTenantRls's tenantId position as tenant-scoped", () => {
    // Pins the callback position itself: the function IS the argument.
    write("src/lib/thing.ts", `export const f = () => withTenantRls(prisma, async () => ${TENANT_READ}, async (tx) => {});\n`);
    manifest(TENANT_SCOPED_FILE);
    expect(run().code).toBe(1);
  });

  it("passes a read inside withTeamTenantRls's callback", () => {
    // R7-T4: the one opener whose callback position no cell pinned.
    write("src/lib/thing.ts", `await withTeamTenantRls(teamId, async (tx) => {\n${RAW_READ}});\n`);
    manifest(TENANT_SCOPED_FILE);
    const { code, out } = run();
    expect(code, out).toBe(0);
    expect(out).toContain("no unconstrained read");
  });

  it("does not treat a read in a function inside withTeamTenantRls's teamId argument as tenant-scoped", () => {
    write("src/lib/thing.ts", `await withTeamTenantRls(await teamOf(async () => ${TENANT_READ}), async (tx) => {});\n`);
    manifest(TENANT_SCOPED_FILE);
    expect(run().code).toBe(1);
  });
});

describe("check-owning-tenant-adjudicator — a wrong null cannot hide behind an outer tenant opener (round 7 R7-T1)", () => {
  const TENANT_SCOPED_FILE = { "src/lib/thing.ts": { disposition: "tenant-scoped" } };
  const inOuterTenant = (inner) => `export const f = (args) => withUserTenantRls(userId, async () => ${inner});\n`;

  it("does not defer to an outer tenant opener for a destructured callback parameter", () => {
    write(
      "src/lib/thing.ts",
      "const run = ({ fn }) => withBypassRls(prisma, fn, PURPOSE);\n" + inOuterTenant(`run({ fn: async (tx) => {\n${RAW_READ}} })`),
    );
    manifest(TENANT_SCOPED_FILE);
    expect(run().code).toBe(1);
  });

  it("does not defer to an outer tenant opener for mutually recursive wrappers", () => {
    write(
      "src/lib/thing.ts",
      "function ping(fn) {\n  return pong(fn);\n}\nfunction pong(fn) {\n  return ping(fn);\n}\n" +
        inOuterTenant(`ping(async (tx) => {\n${RAW_READ}})`),
    );
    manifest(TENANT_SCOPED_FILE);
    expect(run().code).toBe(1);
  });

  it("does not defer to an outer tenant opener for a rest callback parameter", () => {
    write(
      "src/lib/thing.ts",
      "const run = (...args) => withBypassRls(prisma, args[0], PURPOSE);\n" + inOuterTenant(`run(async (tx) => {\n${RAW_READ}})`),
    );
    manifest(TENANT_SCOPED_FILE);
    expect(run().code).toBe(1);
  });

  it("does not defer to an outer tenant opener when a spread hides which wrapper parameter receives the callback", () => {
    write(
      "src/lib/thing.ts",
      "const run = (client, fn) => withBypassRls(client, fn, PURPOSE);\n" + inOuterTenant(`run(...args, async (tx) => {\n${RAW_READ}})`),
    );
    manifest(TENANT_SCOPED_FILE);
    expect(run().code).toBe(1);
  });
});

describe("check-owning-tenant-adjudicator — a function that outlives the callback does not run in its context (round 8 R8-S2/T8-2)", () => {
  const TENANT_SCOPED_FILE = { "src/lib/thing.ts": { disposition: "tenant-scoped" } };
  const inTenant = (body) => `export const f = () => withUserTenantRls(userId, async (tx) => ${body});\n`;

  it("does not treat a closure returned out of the callback as tenant-scoped", () => {
    write("src/lib/thing.ts", inTenant(`async () => {\n${RAW_READ}}`));
    manifest(TENANT_SCOPED_FILE);
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("OUTSIDE any tenant-scoped context");
  });

  it("does not treat an object method built in the callback as tenant-scoped", () => {
    write("src/lib/thing.ts", inTenant(`({ async load() {\n${RAW_READ}} })`));
    manifest(TENANT_SCOPED_FILE);
    expect(run().code).toBe(1);
  });

  it("does not treat a function declared in the callback as tenant-scoped", () => {
    write("src/lib/thing.ts", inTenant(`{\n  async function load() {\n${RAW_READ}}\n  return load;\n}`));
    manifest(TENANT_SCOPED_FILE);
    expect(run().code).toBe(1);
  });

  it("does not treat a callback handed to a scheduler as tenant-scoped", () => {
    write("src/lib/thing.ts", inTenant(`{\n  setTimeout(async () => {\n${RAW_READ}}, 0);\n}`));
    manifest(TENANT_SCOPED_FILE);
    expect(run().code).toBe(1);
  });

  it("passes a read in an IIFE inside the callback", () => {
    write("src/lib/thing.ts", inTenant(`{\n  await (async () => {\n${RAW_READ}})();\n}`));
    manifest(TENANT_SCOPED_FILE);
    const { code, out } = run();
    expect(code, out).toBe(0);
    expect(out).toContain("no unconstrained read");
  });

  it("does not let an outer tenant opener answer for a function a helper receives inside an inner bypass callback", () => {
    write(
      "src/lib/thing.ts",
      `export const f = () => withUserTenantRls(userId, async () => withBypassRls(prisma, pick(async (tx) => {\n${RAW_READ}}), PURPOSE));\n`,
    );
    manifest(TENANT_SCOPED_FILE);
    expect(run().code).toBe(1);
  });
});
