/**
 * Self-test for scripts/checks/check-bearer-passkey-gate.mjs — the C7 gate
 * (plan: docs/archive/review/api-key-passkey-requirement-plan.md) that every
 * tokenHash/codeHash/replacedByHash lookup is classified, that `per-use-gated` validators
 * really gate per use, and that only the three pinned call sites pass
 * `passkeyExemption`.
 *
 * Every refusal rule has a fixture the gate must FAIL on, paired with the
 * passing base fixture (or a named good variant) it differs from by that rule
 * alone, so each cell is able to fail for the reason it names. Where a variant
 * is built by `.replace` on the base, `swap` asserts the replace took effect. The gate is
 * driven against fixtures through BEARER_PASSKEY_GATE_ROOT (scan root, schema
 * and manifest together); tracked files are never mutated.
 *
 * The cells of plan bearer-passkey-gate-coverage (C1, C2) assert the outcome exactly
 * (`expectViolations` / `expectFatal`): the whole set of failure lines and the count line, not
 * a pattern, so a second violation or a changed figure fails the cell. A cell's fixture produces
 * one violation unless a pair is inherent (a builder and its caller), and then declares both.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GUARD = join(REPO_ROOT, "scripts/checks/check-bearer-passkey-gate.mjs");
const MANIFEST = "scripts/checks/bearer-passkey-gate-manifest.json";

// Every digest field is @mapped to its column and every model to its table, as the gate's
// schema checks require; the token tables are api_keys, extension_tokens and auth_codes.
const SCHEMA = `
model User {
  id        String     @id
  apiKeys   ApiKey[]
  authCodes AuthCode[]

  @@map("users")
}

model Profile {
  id     String @id
  userId String @map("user_id")
  user   User   @relation(fields: [userId], references: [id])

  @@map("profiles")
}

model ApiKey {
  id        String @id
  tokenHash String @unique @map("token_hash")
  userId    String @map("user_id")
  user      User   @relation(fields: [userId], references: [id])

  @@map("api_keys")
}

model ExtensionToken {
  id             String  @id
  tokenHash      String  @unique @map("token_hash")
  replacedByHash String? @map("replaced_by_hash")

  @@map("extension_tokens")
}

model AuthCode {
  id       String @id
  codeHash String @unique @map("code_hash")
  userId   String @map("user_id")
  user     User   @relation(fields: [userId], references: [id])

  @@map("auth_codes")
}

model Note {
  id    String @id
  title String

  @@map("notes")
}
`;

const GATE_IMPORT = `import { passkeyGateBlocks } from "@/lib/auth/policy/passkey-gate";`;

/** `base` with `from` replaced by `to`, asserting the replace changed something. */
function swap(base, from, to) {
  const variant = base.replace(from, to);
  expect(variant).not.toBe(base);
  return variant;
}

/** An API-key validator file with the given function body. */
const apiKey = (body, header = GATE_IMPORT) =>
  `${header}\nexport async function validateApiKey(req: Request) {\n${body}\n}\n`;

const LOOKUP = `  const key = await withBypassRls(prisma, async (tx) => tx.apiKey.findUnique({ where: { tokenHash: h(req) } }));`;
const GATE = `  if (await passkeyGateBlocks({ userId: key.userId })) return { ok: false, error: "PASSKEY_REQUIRED" };`;
const GATED_BODY = [
  LOOKUP,
  `  if (!key) return { ok: false, error: "INVALID" };`,
  GATE,
  `  return { ok: true, data: key };`,
].join("\n");

const EXT_TOKEN = `${GATE_IMPORT}
export async function validateExtensionToken(req: Request, opts?: { passkeyExemption?: string }) {
  const token = await tx.extensionToken.findUnique({ where: { tokenHash: h(req) } });
  if (!token) return { ok: false, error: "INVALID" };
  if (!opts?.passkeyExemption) {
    if (await passkeyGateBlocks({ userId: token.userId })) {
      return { ok: false, error: "PASSKEY_REQUIRED" };
    }
  }
  return { ok: true, data: token };
}
`;

const ROUTE_IMPORTS = `import { validateExtensionToken } from "@/lib/auth/tokens/extension-token";
import { PASSKEY_EXEMPTION } from "@/lib/auth/tokens/extension-token-types";`;
const exemptRoute = (handler, member) => `${ROUTE_IMPORTS}
async function ${handler}(req: Request) {
  const r = await validateExtensionToken(req, { passkeyExemption: PASSKEY_EXEMPTION.${member} });
  return r;
}
export const X = withRequestLog(${handler});
`;
const plainRoute = (body = `  return validateExtensionToken(req);`) => `${ROUTE_IMPORTS}
async function handleGET(req: Request) {
${body}
}
`;

const MIGRATION = "prisma/migrations/20240101000000_init/migration.sql";
const RAW_SQL_MODULE_FILE = "src/lib/prisma/raw-sql.ts";
const POOL_FACTORY_FILE = "src/lib/db/pool-factory.ts";
/** raw-sql.ts as the gate reads it: the frozen list of the schema's token tables. */
const rawSqlModule = (tables = ["api_keys", "extension_tokens", "auth_codes"]) =>
  `export const TOKEN_TABLE_NAMES: readonly string[] = Object.freeze(${JSON.stringify(tables)});\n`;
const POOL_FACTORY = `export function createPool() {\n  return {};\n}\nexport function createClient() {\n  return {};\n}\n`;

const BASE_FILES = {
  "prisma/schema.prisma": SCHEMA,
  [MIGRATION]: `CREATE TABLE "notes" ("id" TEXT NOT NULL);\n`,
  [RAW_SQL_MODULE_FILE]: rawSqlModule(),
  [POOL_FACTORY_FILE]: POOL_FACTORY,
  "src/lib/auth/policy/passkey-gate.ts": `export async function passkeyGateBlocks(args: { userId: string }): Promise<boolean> {\n  return false;\n}\n`,
  "src/lib/auth/tokens/extension-token-types.ts": `export const PASSKEY_EXEMPTION = { SELF_REVOCATION: "self_revocation", TAMPER_REPORT: "tamper_report" } as const;\n`,
  "src/lib/auth/tokens/extension-token.ts": EXT_TOKEN,
  "src/lib/auth/tokens/api-key.ts": apiKey(GATED_BODY),
  "src/app/api/extension/token/route.ts": exemptRoute("handleDELETE", "SELF_REVOCATION"),
  "src/app/api/extension/key/reset/route.ts": exemptRoute("handlePOST", "SELF_REVOCATION"),
  "src/app/api/mobile/cache-rollback-report/route.ts": exemptRoute("handlePOST", "TAMPER_REPORT"),
  "src/app/api/plain/route.ts": plainRoute(),
};

const REASON = "a reason long enough to satisfy the gate";
const BASE_MANIFEST = {
  "src/lib/auth/tokens/api-key.ts#validateApiKey": { class: "per-use-gated", calls: 1, reason: REASON },
  "src/lib/auth/tokens/extension-token.ts#validateExtensionToken": { class: "per-use-gated", calls: 1, reason: REASON },
};
// The base fixture has no AuthCode lookup, so the model is listed; a cell adding one deletes it.
const BASE_MODELS = { AuthCode: { reason: REASON } };
const NO_AUTHCODE_ENTRY = { AuthCode: null };

/**
 * Write the base fixture into `root`, `files` overriding (null deletes), and `manifest` /
 * `models` / `sqlObjects` / `pgPools` / `nonBearerHashFields` merged over the base sections (null deletes).
 */
function fixture(root, { files = {}, manifest = {}, models = {}, sqlObjects = {}, pgPools = {}, nonBearerHashFields = {}, rawManifest } = {}) {
  const all = { ...BASE_FILES, ...files };
  for (const [rel, contents] of Object.entries(all)) {
    if (contents === null) continue;
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents, "utf8");
  }
  const merged = (base, over) => Object.fromEntries(Object.entries({ ...base, ...over }).filter(([, v]) => v !== null));
  const full = join(root, MANIFEST);
  mkdirSync(dirname(full), { recursive: true });
  const body = {
    functions: merged(BASE_MANIFEST, manifest),
    models: merged(BASE_MODELS, models),
    sqlObjects: merged({}, sqlObjects),
    pgPools: merged({}, pgPools),
    nonBearerHashFields: merged({}, nonBearerHashFields),
  };
  if (rawManifest !== null) writeFileSync(full, rawManifest ?? JSON.stringify(body, null, 2), "utf8");
}

/** Run the gate (async, so concurrent cells overlap) with `env` merged over process.env. */
function spawnGuard(env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("node", [GUARD], { env: { ...process.env, ...env } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", (exitCode) => resolvePromise({ exitCode, out }));
  });
}

const ROOT_PREFIX = "bearer-passkey-gate-";
const STALE_ROOT_MS = 60 * 60 * 1000;

/**
 * A killed run never reaches its `finally`, so its fixture root stays in the temp directory.
 * Roots older than an hour cannot belong to a live cell (each takes seconds); remove them.
 */
function sweepStaleRoots(now = Date.now()) {
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith(ROOT_PREFIX)) continue;
    const path = join(tmpdir(), name);
    try {
      if (now - statSync(path).mtimeMs > STALE_ROOT_MS) rmSync(path, { recursive: true, force: true });
    } catch {
      // gone already, or not ours to remove: the next run tries again
    }
  }
}
beforeAll(() => sweepStaleRoots());

/** Each cell gets its own fixture root, so cells can run concurrently. */
async function run(options) {
  const root = mkdtempSync(join(tmpdir(), ROOT_PREFIX));
  try {
    fixture(root, options);
    return { ...(await spawnGuard({ BEARER_PASSKEY_GATE_ROOT: root })), root };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Asserts the gate fails and names `pattern`. */
async function expectFail(options, pattern) {
  const { exitCode, out } = await run(options);
  expect(exitCode, out).toBe(1);
  expect(out).toMatch(pattern);
}

async function expectPass(options) {
  const { exitCode, out } = await run(options);
  expect(exitCode, out).toBe(0);
  expect(out).toContain("OK (every digest lookup is classified");
}

/** The gate's violation lines (a multi-line violation keeps its continuation lines), without the two-space indent. */
function violationLines(out) {
  const lines = out.split("\n");
  const start = lines.indexOf("Bearer passkey gate violations (plan C7):");
  if (start < 0) return [];
  const found = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("FAIL:")) break;
    if (/^ {2}\S/.test(line)) found.push(line.slice(2));
    else if (line.trim() !== "") found[found.length - 1] += `\n${line}`;
  }
  return found;
}

/** Exact outcome, violation form: the gate fails with exactly this set of whole failure lines and the matching count line. */
async function expectViolations(options, expected) {
  const { exitCode, out } = await run(options);
  expect(exitCode, out).toBe(1);
  expect(violationLines(out).sort(), out).toEqual([...expected].sort());
  expect(out.split("\n").filter((l) => l.startsWith("FAIL:")), out).toEqual([`FAIL: ${expected.length} violation(s).`]);
}

/** Exact outcome, fatal form: the gate stops on this single `FAIL:` line and prints no violation summary. `message` may be a function of the fixture root, for a line that names it. */
async function expectFatal(options, message) {
  const { exitCode, out, root } = await run(options);
  expect(exitCode, out).toBe(1);
  expect(out.split("\n").filter((l) => l.startsWith("FAIL:")), out).toEqual([`FAIL: ${typeof message === "function" ? message(root) : message}`]);
  expect(out, out).not.toContain("Bearer passkey gate violations");
}

const NOTE_FN = (body) => `export async function lookup(t: string) {\n${body}\n}\n`;
const LISTED_LOOKUP = { "src/lib/other.ts#lookup": { class: "exempt", calls: 1, reason: REASON } };
const RAW_SQL_IMPORT = `import { renderSql, trustedSql } from "@/lib/prisma/raw-sql";`;
const ENFORCEMENT_IMPORT = `import { passkeyEnforcementBlocks } from "@/lib/auth/policy/passkey-enforcement";`;
const ROTATE_BODY =
  "export function rotate(s: unknown) {\n  return withBypassRls(prisma, async () => {\n    if (passkeyEnforcementBlocks(s)) return { ok: false, error: \"PASSKEY_REQUIRED\" };\n  });\n}\nexport function ungated() {\n  return null;\n}\n";
const ROTATE = `${ENFORCEMENT_IMPORT}\n${ROTATE_BODY}`;

describe.concurrent("check-bearer-passkey-gate.mjs — inputs", { timeout: 60_000 }, () => {
  it("passes on the base fixture and prints the analysed count", async () => {
    const { exitCode, out } = await run();
    expect(exitCode, out).toBe(0);
    expect(out).toMatch(/analysed=2 /);
  });

  it("FAILS when the schema declares no digest-field model", async () => {
    await expectFail({ files: { "prisma/schema.prisma": "model Note {\n  id String @id\n}\n" } }, /no model with a tokenHash\/codeHash\/replacedByHash field/);
  });

  it("FAILS when the manifest is missing", async () => {
    await expectFail({ rawManifest: null }, /manifest not found/);
  });

  it("FAILS when the schema is missing", async () => {
    await expectFail({ files: { "prisma/schema.prisma": null } }, /prisma schema not found/);
  });

  it("FAILS when the manifest is not valid JSON", async () => {
    await expectFail({ rawManifest: "{" }, /is not valid JSON/);
  });

  it("FAILS when the manifest has no functions object", async () => {
    await expectFail({ rawManifest: JSON.stringify({ models: BASE_MODELS }) }, /has no "functions" object/);
  });

  it("FAILS when the manifest's models is not an object", async () => {
    await expectFail({ rawManifest: JSON.stringify({ functions: BASE_MANIFEST, models: [] }) }, /"models" that is not an object/);
  });

  it("FAILS when no source file is scanned", async () => {
    const files = Object.fromEntries(Object.keys(BASE_FILES).filter((k) => k.startsWith("src/")).map((k) => [k, null]));
    await expectFail({ files: { ...files, "src/README.md": "no sources\n" } }, /scanned zero source files/);
  });

  it("FAILS when passkey-gate does not export passkeyGateBlocks", async () => {
    const gate = swap(BASE_FILES["src/lib/auth/policy/passkey-gate.ts"], "export async function", "async function");
    await expectFail({ files: { "src/lib/auth/policy/passkey-gate.ts": gate } }, /does not export function passkeyGateBlocks/);
  });

  it("FAILS when extension-token does not export validateExtensionToken", async () => {
    const ext = swap(EXT_TOKEN, "export async function validateExtensionToken", "async function validateExtensionToken");
    await expectFail({ files: { "src/lib/auth/tokens/extension-token.ts": ext } }, /does not export function validateExtensionToken/);
  });

  it("FAILS when extension-token-types does not declare PASSKEY_EXEMPTION", async () => {
    await expectFail({ files: { "src/lib/auth/tokens/extension-token-types.ts": "export const OTHER = {};\n" } }, /does not declare PASSKEY_EXEMPTION/);
  });

  it("FAILS when no digest lookup is analysed at all", async () => {
    await expectFail(
      {
        files: {
          "src/lib/auth/tokens/api-key.ts": null,
          "src/lib/auth/tokens/extension-token.ts": `${GATE_IMPORT}\nexport async function validateExtensionToken(req: Request) {\n  return { ok: true };\n}\n`,
        },
        manifest: {
          "src/lib/auth/tokens/api-key.ts#validateApiKey": null,
          "src/lib/auth/tokens/extension-token.ts#validateExtensionToken": null,
        },
      },
      /analysed zero functions/,
    );
  });
});

describe.concurrent("digest lookup detection", { timeout: 60_000 }, () => {
  it("FAILS on an unlisted function with where: { tokenHash }", async () => {
    await expectFail({ files: { "src/lib/other.ts": NOTE_FN(`  return tx.apiKey.findFirst({ where: { tokenHash: t } });`) } }, /UNLISTED: src\/lib\/other\.ts#lookup/);
  });

  it("passes when that function is listed", async () => {
    await expectPass({ files: { "src/lib/other.ts": NOTE_FN(`  return tx.apiKey.findFirst({ where: { tokenHash: t } });`) }, manifest: LISTED_LOOKUP });
  });

  it("FAILS on a codeHash lookup nested under OR", async () => {
    await expectFail({ files: { "src/lib/other.ts": NOTE_FN(`  return prisma.authCode.findFirst({ where: { OR: [{ codeHash: t }] } });`) } }, /UNLISTED: src\/lib\/other\.ts#lookup/);
  });

  it("FAILS on a lookup reached through a relation filter of a non-token model", async () => {
    await expectFail(
      { files: { "src/lib/other.ts": NOTE_FN(`  return tx.user.findFirst({ where: { apiKeys: { some: { tokenHash: t } } } });`) } },
      /UNLISTED: src\/lib\/other\.ts#lookup/,
    );
  });

  it("FAILS on a lookup whose where is a const-bound literal (followed, not opaque)", async () => {
    await expectFail(
      { files: { "src/lib/other.ts": NOTE_FN(`  const w = { tokenHash: t };\n  return tx.apiKey.findFirst({ where: w });`) } },
      /UNLISTED: src\/lib\/other\.ts#lookup \(lines 3\) — 1 digest lookup/,
    );
  });

  it("does not analyse a where without a digest key (passes unlisted)", async () => {
    await expectPass({ files: { "src/lib/other.ts": NOTE_FN(`  return tx.apiKey.findFirst({ where: { id: t } });`) } });
  });

  it("attributes to a const-bound arrow and to a class method by name", async () => {
    const files = {
      "src/lib/other.ts": [
        `const helper = async (t: string) => tx.apiKey.findFirst({ where: { tokenHash: t } });`,
        `class Repo { async find(t: string) { return tx.authCode.findUnique({ where: { codeHash: t } }); } }`,
      ].join("\n"),
    };
    await expectFail({ files }, /UNLISTED: src\/lib\/other\.ts#helper[\s\S]*UNLISTED: src\/lib\/other\.ts#find/);
    await expectPass({
      files,
      manifest: {
        "src/lib/other.ts#helper": { class: "exempt", calls: 1, reason: REASON },
        "src/lib/other.ts#find": { class: "exempt", calls: 1, reason: REASON },
      },
      models: NO_AUTHCODE_ENTRY,
    });
  });

  it("FAILS on a digest key in a cursor (a cursor is a unique where)", async () => {
    await expectFail({ files: { "src/lib/other.ts": NOTE_FN(`  return tx.apiKey.findMany({ cursor: { tokenHash: t } });`) } }, /UNLISTED: src\/lib\/other\.ts#lookup.*1 digest lookup/);
  });

  it("does not analyse a cursor without a digest key (passes unlisted)", async () => {
    await expectPass({ files: { "src/lib/other.ts": NOTE_FN(`  return tx.apiKey.findMany({ cursor: { id: t } });`) } });
  });

  const EXPORT_LIST = (exported) =>
    `${exported ? "export " : ""}const X = { find: (t: string) => tx.apiKey.findFirst({ where: { tokenHash: t } }) };\n${exported ? "" : "export { X };\n"}`;

  it("FAILS on a lookup in a const exported only through an export list (not attributed to it)", async () => {
    await expectFail({ files: { "src/lib/other.ts": EXPORT_LIST(false) }, manifest: { "src/lib/other.ts#X": { class: "exempt", calls: 1, reason: REASON } } }, /cannot be attributed/);
  });

  it("passes on the same lookup in an `export const`, attributed to it", async () => {
    await expectPass({ files: { "src/lib/other.ts": EXPORT_LIST(true) }, manifest: { "src/lib/other.ts#X": { class: "exempt", calls: 1, reason: REASON } } });
  });

  it("FAILS on a lookup at module scope (cannot be attributed)", async () => {
    await expectFail({ files: { "src/lib/other.ts": `void tx.apiKey.findFirst({ where: { tokenHash: "x" } });\n` } }, /cannot be attributed/);
  });
});

// Whether a call is a lookup does not depend on its receiver: each spelling and each filter
// position is a deny cell with `tokenHash`, paired with the same call filtering by `id`.
describe.concurrent("lookups, whatever the receiver", { timeout: 60_000 }, () => {
  // The whole message, so "11 digest lookup(s)" or an opaque site does not match.
  const LOOKUP_IN_OTHER = /UNLISTED: src\/lib\/other\.ts#lookup \(lines \d+\) — 1 digest lookup\(s\), 0 opaque site\(s\)\./;
  const other = (code) => ({ files: { "src/lib/other.ts": NOTE_FN(`  ${code}`) } });
  const cells = (code) => [other(code.replaceAll("%K%", "tokenHash")), other(code.replaceAll("%K%", "id"))];

  const RECEIVERS = [
    ["Reflect.get", `return Reflect.get(tx, "apiKey").findUnique({ where: { %K%: t } });`],
    ["a delegate a function returns", `return delegateFor(tx).findFirst({ where: { %K%: t } });`],
    ["$parent", `return tx.$parent.findFirst({ where: { %K%: t } });`],
    ["a bare name that is no handle (a parameter-passed delegate)", `return d.findFirst({ where: { %K%: t } });`],
    ["a .call of the method", `return tx.repo.findFirst.call(null, { where: { %K%: t } });`],
    ["an argument other than the first", `return find(tx, { where: { %K%: t } });`],
  ];
  it.each(RECEIVERS)("FAILS on a lookup through %s", async (_label, code) => {
    await expectFail(cells(code)[0], LOOKUP_IN_OTHER);
  });
  it.each(RECEIVERS)("passes on the same call through %s filtering by id", async (_label, code) => {
    await expectPass(cells(code)[1]);
  });

  const POSITIONS = [
    ["a shorthand key", `const %K% = t;\n  return x.findFirst({ where: { %K% } });`],
    ["a string-literal key", `return x.findFirst({ where: { "%K%": t } });`],
    ["a having", `return x.groupBy({ by: ["id"], having: { %K%: t } });`],
    ["a relation filter under a logical", `return x.findFirst({ where: { AND: [{ user: { apiKeys: { some: { %K%: t } } } }] } });`],
    ["an include relation's where", `return x.findFirst({ include: { apiKeys: { where: { %K%: t } } } });`],
    ["a select relation's where", `return x.findFirst({ select: { apiKeys: { where: { %K%: t } } } });`],
    ["a _count.select relation's where", `return x.findFirst({ select: { _count: { select: { apiKeys: { where: { %K%: t } } } } } });`],
    ["an include nested under an include", `return x.findFirst({ include: { user: { include: { apiKeys: { where: { %K%: t } } } } } });`],
    ["a nested update's where", `return x.update({ where: { id: t }, data: { apiKeys: { update: { where: { %K%: t }, data: {} } } } });`],
    ["a nested updateMany's where", `return x.update({ where: { id: t }, data: { apiKeys: { updateMany: [{ where: { %K%: t }, data: {} }] } } });`],
    ["a nested upsert's where", `return x.update({ where: { id: t }, data: { apiKeys: { upsert: { where: { %K%: t }, create: {}, update: {} } } } });`],
    ["a nested connectOrCreate's where", `return x.create({ data: { apiKeys: { connectOrCreate: { where: { %K%: t }, create: {} } } } });`],
    ["a nested connect", `return x.create({ data: { apiKeys: { connect: { %K%: t } } } });`],
    ["a nested connect array", `return x.create({ data: { apiKeys: { connect: [{ %K%: t }] } } });`],
    ["a nested disconnect", `return x.update({ where: { id: t }, data: { apiKeys: { disconnect: { %K%: t } } } });`],
    ["a nested set", `return x.update({ where: { id: t }, data: { apiKeys: { set: [{ %K%: t }] } } });`],
    ["a nested delete", `return x.update({ where: { id: t }, data: { apiKeys: { delete: { %K%: t } } } });`],
    ["a nested deleteMany", `return x.update({ where: { id: t }, data: { apiKeys: { deleteMany: { %K%: t } } } });`],
    ["a nested write in a nested create", `return x.create({ data: { user: { create: { apiKeys: { connect: { %K%: t } } } } } });`],
    ["a to-one update given its data directly", `return x.update({ where: { id: t }, data: { user: { update: { apiKeys: { connect: { %K%: t } } } } } });`],
    ["an upsert's top-level update", `return x.upsert({ where: { id: t }, create: {}, update: { apiKeys: { connect: { %K%: t } } } });`],
    ["a const-bound argument", `const args = { where: { %K%: t } };\n  return x.findFirst(args);`],
  ];
  it.each(POSITIONS)("FAILS on a digest key in %s", async (_label, code) => {
    await expectFail(cells(code)[0], LOOKUP_IN_OTHER);
  });
  it.each(POSITIONS)("passes on an id key in %s", async (_label, code) => {
    await expectPass(cells(code)[1]);
  });

  it("FAILS on an escaped string-literal key (read cooked)", async () => {
    await expectFail(other(`return x.findFirst({ where: { "token\\x48ash": t } });`), LOOKUP_IN_OTHER);
  });

  it("FAILS on an identifier key spelled with a unicode escape (read cooked)", async () => {
    await expectFail(other(`return x.findFirst({ where: { token\\u0048ash: t } });`), LOOKUP_IN_OTHER);
  });

  // A write is placed only on a receiver that resolves to a model declaring the field (C1), so the
  // receiver here is the model's delegate: the same call on an unresolved `x` is a floating key.
  it("passes on a digest written as data (a write, not a lookup)", async () => {
    await expectPass(other(`await tx.apiKey.create({ data: { tokenHash: t } });\n  return tx.apiKey.update({ where: { id: t }, data: { tokenHash: t } });`));
  });

  it("FAILS on a replacedByHash key in a where (the rotation successor's digest)", async () => {
    await expectFail(other(`return x.findFirst({ where: { replacedByHash: t } });`), LOOKUP_IN_OTHER);
  });

  it("passes on a replacedByHash written as data (the rotation CAS, a write)", async () => {
    await expectPass(other(`return tx.extensionToken.updateMany({ where: { id: t, rotatedAt: null }, data: { replacedByHash: t } });`));
  });

  // A computed key is read when the file pins its name: a string literal, or a const bound to one.
  const COMPUTED = [
    ["a const-bound name", `const k = "%K%";\n  return x.findFirst({ where: { [k]: t } });`],
    ["a string literal", `return x.findFirst({ where: { ["%K%"]: t } });`],
  ];
  it.each(COMPUTED)("FAILS on a computed digest key spelled through %s", async (_label, code) => {
    await expectFail(cells(code)[0], LOOKUP_IN_OTHER);
  });
  it.each(COMPUTED)("passes on the same computed key naming id through %s", async (_label, code) => {
    await expectPass(cells(code)[1]);
  });

  // C1 and C2 close the former residual: the `let` string is a floating key and the computed key
  // in the filter is opaque (a key this gate cannot pin hides which field the filter names).
  it("FAILS on a computed key bound by let (an unpinned key: floating string and an opaque filter)", async () => {
    await expectViolations(other(`let k = "tokenHash";\n  return x.findFirst({ where: { [k]: t } });`), [
      `UNLISTED: src/lib/other.ts#lookup (lines 2, 3) — 0 digest lookup(s), 1 opaque site(s), 1 floating key(s): line 3: unresolved where: computed key; floating: line 2 string. Classify it in ${MANIFEST}.`,
    ]);
  });

  it("passes on a digest key outside any filter position once its two floating keys are counted", async () => {
    await expectPass({
      ...other(`return log({ meta: { tokenHash: t }, orderBy: { tokenHash: "asc" } });`),
      manifest: { "src/lib/other.ts#lookup": { class: "exempt", calls: 2, reason: REASON } },
    });
  });

  describe("model coverage through the position, not the receiver", () => {
    const authCodeListed = { manifest: LISTED_LOOKUP, models: NO_AUTHCODE_ENTRY };

    it("passes when a nested include on a resolved receiver reaches the model", async () => {
      await expectPass({ ...other(`return tx.user.findFirst({ include: { authCodes: { where: { codeHash: t } } } });`), ...authCodeListed });
    });

    it("FAILS as UNCOVERED_MODEL when the only lookup's receiver does not resolve", async () => {
      await expectFail({ ...other(`return Reflect.get(tx, "authCode").findFirst({ where: { codeHash: t } });`), ...authCodeListed }, /UNCOVERED_MODEL: AuthCode/);
    });
  });
});

describe.concurrent("delegate receivers by element access", { timeout: 60_000 }, () => {
  const fn = (decl, call) => ({ files: { "src/lib/other.ts": `export async function lookup(t: string, k: string) {\n  ${decl}\n  return ${call};\n}\n` } });
  const UNREADABLE_KEY = /element access whose key this gate cannot read/;

  it("FAILS on a where-taking method on an element access with a parameter key", async () => {
    await expectFail(fn("", `tx[k].findFirst({ where: { id: t } })`), UNREADABLE_KEY);
  });

  it("FAILS on the same call when the key is a let, not a const", async () => {
    await expectFail(fn(`let h = "apiKey";`, `tx[h].findFirst({ where: { id: t } })`), UNREADABLE_KEY);
  });

  it("passes on the same call with a const-bound key", async () => {
    await expectPass(fn(`const h = "apiKey";`, `tx[h].findFirst({ where: { id: t } })`));
  });

  it("passes on a method that takes no where (create) on that element access", async () => {
    await expectPass(fn("", `tx[k].create({ data: { id: t } })`));
  });

  it("FAILS on an opaque where through a const-bound handle (the handle is followed)", async () => {
    await expectFail(fn(`const h = "apiKey";`, `tx[h].findFirst({ where: t })`), /ApiKey where: not an object literal/);
  });

  it("passes on that where when the const-bound handle names a model without a digest column", async () => {
    await expectPass(fn(`const h = "note";`, `tx[h].findFirst({ where: t })`));
  });

  it("FAILS on a token-model delegate bound through a const-bound handle", async () => {
    await expectFail(fn(`const h = "apiKey";\n  const d = tx[h];`, `run(d)`), /token-model delegate referenced other than as/);
  });

  it("passes on the same binding when the handle names a model without a digest column", async () => {
    await expectPass(fn(`const h = "note";\n  const d = tx[h];`, `run(d)`));
  });
});

// A projection, write or argument on a token model or a model related to one, that the gate
// cannot read, could hold a nested lookup: it is opaque. Each deny is paired with the same
// shape on Note (no token relation) or in a readable spelling.
describe.concurrent("opaque projections, writes and arguments", { timeout: 60_000 }, () => {
  const other = (code) => ({ files: { "src/lib/other.ts": NOTE_FN(`  ${code}`) } });
  const CASES = [
    ["a non-literal include", `return tx.%M%.findFirst({ include: t });`, /User include: not an object literal/],
    ["a select spread", `return tx.%M%.findFirst({ select: { ...t } });`, /User select: spread/],
    ["a computed select key", `return tx.%M%.findFirst({ select: { [t]: true } });`, /User select: computed key/],
    ["a non-literal data", `return tx.%M%.update({ where: { id: t }, data: t });`, /User data: not an object literal/],
    ["a data spread", `return tx.%M%.create({ data: { ...t } });`, /User data: spread/],
    ["a non-literal argument", `return tx.%M%.findFirst(t);`, /User argument: not an object literal/],
    ["an argument spread", `return tx.%M%.findFirst({ ...t, where: { id: t } });`, /User argument: spread/],
    ["a non-literal upsert create", `return tx.%M%.upsert({ where: { id: t }, create: t, update: {} });`, /User create: not an object literal/],
  ];
  it.each(CASES)("FAILS on %s on a model related to a token model", async (_label, code, pattern) => {
    await expectFail(other(code.replace("%M%", "user")), pattern);
  });
  it.each(CASES)("passes on %s on a model with no token relation", async (_label, code) => {
    await expectPass(other(code.replace("%M%", "note")));
  });

  it("passes on readable spreads in a data and a select (conditional, &&, const-bound)", async () => {
    await expectPass(
      other(
        `const extra = { id: t };\n  return tx.user.update({ where: { id: t }, data: { ...(t ? { id: t } : {}), ...(t && { id: t }), ...extra }, select: { ...(t ? { id: true } : null) } });`,
      ),
    );
  });

  it("passes on a non-literal data of updateMany (scalar columns only)", async () => {
    await expectPass(other(`return tx.user.updateMany({ where: { id: t }, data: t });`));
  });

  it("FAILS on a non-literal where of a relation under include on a token model", async () => {
    await expectFail(other(`return tx.user.findFirst({ include: { apiKeys: { where: t } } });`), /ApiKey where: not an object literal/);
  });

  it("FAILS on a non-literal nested connect into a token model", async () => {
    await expectFail(other(`return tx.user.update({ where: { id: t }, data: { apiKeys: { connect: t } } });`), /ApiKey apiKeys\.connect: not an object literal/);
  });

  it("FAILS on a non-literal relation value under include into a token model", async () => {
    await expectFail(other(`return tx.user.findFirst({ include: { apiKeys: t } });`), /ApiKey apiKeys: not an object literal/);
  });

  it("passes on a non-literal data two relation hops from a token model (declared residual)", async () => {
    await expectPass(other(`return tx.profile.update({ where: { id: t }, data: t });`));
  });
});

describe.concurrent("raw SQL", { timeout: 60_000 }, () => {
  const rawFile = (stmt, header = "") => `${header}\nexport async function q(tx: any, t: string) {\n  ${stmt}\n}\n`;

  it("passes on literal raw SQL that does not name a digest column", async () => {
    await expectPass({
      files: {
        "src/lib/raw.ts": rawFile(
          "await tx.$queryRaw`SELECT id FROM notes WHERE id = ${t}`; await tx.$executeRawUnsafe(\"SELECT 1\"); await tx.$executeRawUnsafe(renderSql(trustedSql`DELETE FROM notes`));",
          RAW_SQL_IMPORT,
        ),
      },
    });
  });

  it("FAILS on raw SQL naming TOKEN_HASH in upper case (the column rule is case-insensitive)", async () => {
    await expectFail({ files: { "src/lib/raw.ts": rawFile("await tx.$executeRawUnsafe(\"SELECT id FROM api_keys WHERE TOKEN_HASH = $1\");") } }, /names a digest column/);
  });

  it("FAILS on raw SQL naming replaced_by_hash", async () => {
    await expectFail({ files: { "src/lib/raw.ts": rawFile("await tx.$executeRawUnsafe(\"SELECT id FROM mcp_refresh_tokens WHERE replaced_by_hash = $1\");") } }, /names a digest column/);
  });

  it("FAILS on tagged raw SQL naming token_hash", async () => {
    await expectFail({ files: { "src/lib/raw.ts": rawFile("await tx.$queryRaw`SELECT id FROM api_keys WHERE token_hash = ${t}`;") } }, /names a digest column/);
  });

  it("FAILS on a string literal naming token_hash only once cooked (an escape)", async () => {
    await expectFail({ files: { "src/lib/raw.ts": rawFile("const frag = \"token\\x5fhash = $1\"; return frag;") } }, /names a digest column/);
  });

  it("FAILS on a template head naming code_hash only once cooked (an escape)", async () => {
    await expectFail({ files: { "src/lib/raw.ts": rawFile("const frag = Prisma.sql`code\\u005fhash = ${t}`; return frag;") } }, /names a digest column/);
  });

  const RENDER = "await tx.$executeRawUnsafe(renderSql(trustedSql`DELETE FROM notes`));";

  it("passes on renderSql(trustedSql`...`) imported from raw-sql", async () => {
    await expectPass({ files: { "src/lib/raw.ts": rawFile(RENDER, RAW_SQL_IMPORT) } });
  });

  it("FAILS on renderSql(trustedSql`...`) when renderSql is a local function", async () => {
    await expectFail(
      { files: { "src/lib/raw.ts": rawFile(RENDER, `import { trustedSql } from "@/lib/prisma/raw-sql";\nconst renderSql = (f: unknown) => String(f);`) } },
      /SQL argument is not a literal/,
    );
  });

  it("FAILS on renderSql(trustedSql`...`) when trustedSql comes from another module", async () => {
    await expectFail(
      { files: { "src/lib/raw.ts": rawFile(RENDER, `import { renderSql } from "@/lib/prisma/raw-sql";\nimport { trustedSql } from "@/lib/fake-sql";`) } },
      /SQL argument is not a literal/,
    );
  });

  it("FAILS on a SQL fragment literal naming code_hash anywhere", async () => {
    await expectFail({ files: { "src/lib/raw.ts": rawFile("const frag = Prisma.sql`code_hash = ${t}`; return frag;") } }, /names a digest column/);
  });

  it("FAILS on an Unsafe call whose SQL argument is not a literal", async () => {
    await expectFail({ files: { "src/lib/raw.ts": rawFile("const sql = 'SELECT 1'; await tx.$queryRawUnsafe(sql);") } }, /SQL argument is not a literal/);
  });

  it("FAILS on a raw method used as a value", async () => {
    await expectFail({ files: { "src/lib/raw.ts": rawFile("const run = tx.$queryRaw; return run;") } }, /used other than as a template tag/);
  });

  it("FAILS on a template middle naming token_hash", async () => {
    await expectFail({ files: { "src/lib/raw.ts": rawFile("return `${t} token_hash ${t}`;") } }, /names a digest column/);
  });

  it("FAILS on a template tail naming code_hash", async () => {
    await expectFail({ files: { "src/lib/raw.ts": rawFile("return `${t} code_hash`;") } }, /names a digest column/);
  });

  it("passes on a template whose middle and tail name no digest column", async () => {
    await expectPass({ files: { "src/lib/raw.ts": rawFile("return `${t} token ${t} hash`;") } });
  });

  it("FAILS on a regular expression literal naming token_hash (its .source is that text)", async () => {
    await expectFail({ files: { "src/lib/raw.ts": rawFile("return /token_hash/.source;") } }, /names a digest column/);
  });

  it("passes on a regular expression literal naming no digest column", async () => {
    await expectPass({ files: { "src/lib/raw.ts": rawFile("return /token-hash/.source;") } });
  });

  const UNICODE = /holds U& \/ UESCAPE/;

  it("FAILS on U& in a literal (a Unicode-escaped identifier)", async () => {
    await expectFail({ files: { "src/lib/raw.ts": rawFile(`return "SELECT id FROM api_keys WHERE U&\\"token\\\\005fhash\\" = $1";`) } }, UNICODE);
  });

  it("FAILS on UESCAPE in a template literal, any case", async () => {
    await expectFail({ files: { "src/lib/raw.ts": rawFile("return `SELECT 1 FROM t WHERE x = 'a' uEscape '!'`;") } }, UNICODE);
  });

  it("FAILS on U& spelled only once cooked (an escape)", async () => {
    await expectFail({ files: { "src/lib/raw.ts": rawFile(`return "U\\x26'x'";`) } }, UNICODE);
  });

  it("passes on an ampersand that is no U& prefix", async () => {
    await expectPass({ files: { "src/lib/raw.ts": rawFile(`return "SELECT a & b, 'escape' FROM t";`) } });
  });

  // Same set as renderSql: PostgreSQL reads the prefix only when `&` follows
  // the `U` directly, so a spaced `u &` is an operator, not U&.
  it("passes on a spaced u & that is no U& prefix", async () => {
    await expectPass({ files: { "src/lib/raw.ts": rawFile(`return "SELECT u & b FROM t";`) } });
  });

  it("FAILS on a raw method reached by element access", async () => {
    await expectFail({ files: { "src/lib/raw.ts": rawFile('return tx["$executeRawUnsafe"]("SELECT 1");') } }, /reached by element access/);
  });
});

describe.concurrent("opaque where", { timeout: 60_000 }, () => {
  const spreadWhere = NOTE_FN(`  return tx.extensionToken.updateMany({ where: { ...t }, data: {} });`);
  const opaqueEntry = { "src/lib/other.ts#lookup": { class: "opaque-where", calls: 1, reason: REASON } };

  it("FAILS on an unlisted spread where on a token model", async () => {
    await expectFail({ files: { "src/lib/other.ts": spreadWhere } }, /UNLISTED: src\/lib\/other\.ts#lookup.*1 opaque/);
  });

  it("passes when listed opaque-where with its call count", async () => {
    await expectPass({ files: { "src/lib/other.ts": spreadWhere }, manifest: opaqueEntry });
  });

  it("FAILS when a new opaque site is added to a listed function (count mismatch)", async () => {
    await expectFail(
      {
        files: { "src/lib/other.ts": NOTE_FN(`  await tx.extensionToken.updateMany({ where: { ...t }, data: {} });\n  return tx.apiKey.deleteMany({ where: t });`) },
        manifest: opaqueEntry,
      },
      /COUNT_MISMATCH: src\/lib\/other\.ts#lookup/,
    );
  });

  it("FAILS on a non-literal where classified as anything but opaque-where", async () => {
    await expectFail(
      { files: { "src/lib/other.ts": NOTE_FN(`  return tx.apiKey.findFirst({ where: t });`) }, manifest: LISTED_LOOKUP },
      /OPAQUE_WHERE: src\/lib\/other\.ts#lookup/,
    );
  });

  it("FAILS on an opaque cursor on a token model", async () => {
    await expectFail({ files: { "src/lib/other.ts": NOTE_FN(`  return tx.apiKey.findMany({ cursor: t });`) } }, /ApiKey cursor: not an object literal/);
  });

  it("ignores an opaque cursor on a model without a digest column", async () => {
    await expectPass({ files: { "src/lib/other.ts": NOTE_FN(`  return tx.note.findMany({ cursor: t });`) } });
  });

  it("FAILS on a computed key in a token-model where", async () => {
    await expectFail({ files: { "src/lib/other.ts": NOTE_FN(`  return tx.apiKey.findFirst({ where: { [t]: "x" } });`) } }, /ApiKey where: computed key/);
  });

  it("FAILS on an accessor in a token-model where", async () => {
    await expectFail({ files: { "src/lib/other.ts": NOTE_FN(`  return tx.apiKey.findFirst({ where: { get tokenHash() { return t; } } });`) } }, /ApiKey where: accessor\/method/);
  });

  it("FAILS on a spread under OR in a token-model where", async () => {
    await expectFail({ files: { "src/lib/other.ts": NOTE_FN(`  return tx.apiKey.findFirst({ where: { OR: [...t] } });`) } }, /ApiKey where: OR spread/);
  });

  it("FAILS on a spread argument to a token-model call", async () => {
    await expectFail({ files: { "src/lib/other.ts": NOTE_FN(`  return tx.apiKey.findFirst(...t);`) } }, /ApiKey argument: spread/);
  });

  it("FAILS on a non-literal relation filter into a token model", async () => {
    await expectFail({ files: { "src/lib/other.ts": NOTE_FN(`  return tx.user.findFirst({ where: { apiKeys: t } });`) } }, /ApiKey relation filter: not an object literal/);
  });

  it("FAILS on a non-literal argument to a token-model call", async () => {
    await expectFail({ files: { "src/lib/other.ts": NOTE_FN(`  return tx.apiKey.findFirst(t);`) } }, /ApiKey argument: not an object literal/);
  });

  it("FAILS when an opaque-where function's where has become readable (stale opaque)", async () => {
    await expectFail(
      { files: { "src/lib/other.ts": NOTE_FN(`  return tx.apiKey.findFirst({ where: { tokenHash: t } });`) }, manifest: opaqueEntry },
      /STALE_OPAQUE: src\/lib\/other\.ts#lookup/,
    );
  });

  it("ignores an opaque where on a model without a digest column", async () => {
    await expectPass({ files: { "src/lib/other.ts": NOTE_FN(`  return tx.note.findMany({ where: { ...t } });`) } });
  });
});

describe.concurrent("manifest entries", { timeout: 60_000 }, () => {
  const files = { "src/lib/other.ts": NOTE_FN(`  return tx.apiKey.findFirst({ where: { tokenHash: t } });`) };

  it("FAILS on a stale entry", async () => {
    await expectFail({ manifest: { "src/lib/gone.ts#gone": { class: "exempt", calls: 1, reason: REASON } } }, /STALE_ENTRY: src\/lib\/gone\.ts#gone/);
  });

  it("FAILS on an unknown class", async () => {
    await expectFail({ files, manifest: { "src/lib/other.ts#lookup": { class: "fine", calls: 1, reason: REASON } } }, /BAD_ENTRY: .* has class "fine"/);
  });

  it("FAILS on a missing reason", async () => {
    await expectFail({ files, manifest: { "src/lib/other.ts#lookup": { class: "exempt", calls: 1, reason: "short" } } }, /needs a reason/);
  });

  it("FAILS on a lookup-count mismatch", async () => {
    await expectFail({ files, manifest: { "src/lib/other.ts#lookup": { class: "exempt", calls: 2, reason: REASON } } }, /COUNT_MISMATCH/);
  });

  // A second, ungated function sharing the gated validator's key: only one of them can be adjudicated.
  const shadowMethod = (name) =>
    apiKey(GATED_BODY) + `class Shadow {\n  ${name}(t: string) {\n    return tx.apiKey.findFirst({ where: { tokenHash: t } });\n  }\n}\n`;

  it("FAILS when two functions of one file share a key (AMBIGUOUS_KEY)", async () => {
    await expectFail(
      {
        files: { "src/lib/auth/tokens/api-key.ts": shadowMethod("validateApiKey") },
        manifest: { "src/lib/auth/tokens/api-key.ts#validateApiKey": { class: "per-use-gated", calls: 2, reason: REASON } },
      },
      /AMBIGUOUS_KEY: src\/lib\/auth\/tokens\/api-key\.ts#validateApiKey/,
    );
  });

  it("passes when the second function has its own name and entry", async () => {
    await expectPass({
      files: { "src/lib/auth/tokens/api-key.ts": shadowMethod("other") },
      manifest: { "src/lib/auth/tokens/api-key.ts#other": { class: "exempt", calls: 1, reason: REASON } },
    });
  });

  describe("model coverage", () => {
    const authCodeLookup = { "src/lib/other.ts": NOTE_FN(`  return tx.authCode.findFirst({ where: { codeHash: t } });`) };

    it("FAILS on a token model no analysed lookup reaches and the manifest does not list", async () => {
      await expectFail({ models: NO_AUTHCODE_ENTRY }, /UNCOVERED_MODEL: AuthCode/);
    });

    it("passes once a lookup reaches that model and its entry is gone", async () => {
      await expectPass({ files: authCodeLookup, manifest: LISTED_LOOKUP, models: NO_AUTHCODE_ENTRY });
    });

    it("FAILS on a models entry for a model that has an analysed lookup (stale)", async () => {
      await expectFail({ files: authCodeLookup, manifest: LISTED_LOOKUP }, /STALE_MODEL: AuthCode/);
    });

    it("FAILS on a models entry naming a model without a digest column", async () => {
      await expectFail({ models: { Note: { reason: REASON } } }, /"models" names Note/);
    });

    it("FAILS on a models entry without a reason", async () => {
      await expectFail({ models: { AuthCode: { reason: "short" } } }, /"models" entry AuthCode needs a reason/);
    });
  });

  describe("refresh-bound", () => {
    const refreshFiles = {
      ...files,
      "src/lib/ttl.ts": "export const TOKEN_TTL = 3600;\nconst LOCAL_TTL = 1;\n",
      "src/lib/rotate.ts": ROTATE,
      "src/app/api/token/route.ts": "export const POST = () => null;\n",
    };
    const entry = (over) => ({
      "src/lib/other.ts#lookup": {
        class: "refresh-bound",
        calls: 1,
        reason: REASON,
        refreshRoute: "src/app/api/token/route.ts",
        lifetime: "src/lib/ttl.ts#TOKEN_TTL",
        inlineGate: "src/lib/rotate.ts#rotate",
        ...over,
      },
    });

    it("passes with an existing route, an exported lifetime and a gated inline gate", async () => {
      await expectPass({ files: refreshFiles, manifest: entry({}) });
    });

    it("FAILS when the refresh route does not exist", async () => {
      await expectFail({ files: refreshFiles, manifest: entry({ refreshRoute: "src/app/api/nope/route.ts" }) }, /refreshRoute .* does not exist/);
    });

    it("FAILS when the lifetime is not an exported const", async () => {
      await expectFail({ files: refreshFiles, manifest: entry({ lifetime: "src/lib/ttl.ts#LOCAL_TTL" }) }, /lifetime "src\/lib\/ttl\.ts#LOCAL_TTL" is not a <path>#<name>/);
    });

    it("FAILS when the inline gate does not call the passkey gate", async () => {
      await expectFail({ files: refreshFiles, manifest: entry({ inlineGate: "src/lib/rotate.ts#ungated" }) }, /relies on inline gate/);
    });

    it("FAILS when no inlineGate is named", async () => {
      await expectFail({ files: refreshFiles, manifest: entry({ inlineGate: undefined }) }, /names no inlineGate/);
    });

    it("FAILS when the lifetime is a bare name, not <path>#<name>", async () => {
      await expectFail({ files: refreshFiles, manifest: entry({ lifetime: "TOKEN_TTL" }) }, /lifetime "TOKEN_TTL" is not a <path>#<name>/);
    });

    it("FAILS when the lifetime has a trailing #segment", async () => {
      await expectFail({ files: refreshFiles, manifest: entry({ lifetime: "src/lib/ttl.ts#TOKEN_TTL#x" }) }, /is not a <path>#<name>/);
    });

    it("FAILS when the lifetime names an exported const of another file", async () => {
      await expectFail({ files: refreshFiles, manifest: entry({ lifetime: "src/lib/rotate.ts#TOKEN_TTL" }) }, /is not a <path>#<name>/);
    });

    it("FAILS when the inline gate calls a local function of the gate's name", async () => {
      const local = `${ROTATE_BODY}function passkeyEnforcementBlocks(_: unknown) {\n  return false;\n}\n`;
      await expectFail({ files: { ...refreshFiles, "src/lib/rotate.ts": local }, manifest: entry({}) }, /relies on inline gate/);
    });

    it("FAILS when the inline gate's call is not an if condition", async () => {
      const assigned = `${ENFORCEMENT_IMPORT}\nexport function rotate(s: unknown) {\n  const blocked = passkeyEnforcementBlocks(s);\n  if (blocked) return null;\n  return 1;\n}\n`;
      await expectFail({ files: { ...refreshFiles, "src/lib/rotate.ts": assigned }, manifest: entry({}) }, /relies on inline gate/);
    });

    it("passes with passkeyGateBlocks from passkey-gate as the inline gate", async () => {
      const viaGate = `${GATE_IMPORT}\nexport async function rotate(u: string) {\n  if (await passkeyGateBlocks({ userId: u })) return { ok: false, error: "PASSKEY_REQUIRED" };\n  return 1;\n}\n`;
      await expectPass({ files: { ...refreshFiles, "src/lib/rotate.ts": viaGate }, manifest: entry({}) });
    });

    it("FAILS when the inline gate's passkeyEnforcementBlocks is imported from another module", async () => {
      const fake = swap(ROTATE, ENFORCEMENT_IMPORT, `import { passkeyEnforcementBlocks } from "@/lib/fake-enforcement";`);
      await expectFail({ files: { ...refreshFiles, "src/lib/rotate.ts": fake }, manifest: entry({}) }, /relies on inline gate/);
    });

    it("FAILS when the lifetime is an exported let, not a const", async () => {
      const ttl = { ...refreshFiles, "src/lib/ttl.ts": "export let TOKEN_TTL = 3600;\n" };
      await expectFail({ files: ttl, manifest: entry({}) }, /lifetime "src\/lib\/ttl\.ts#TOKEN_TTL" is not a <path>#<name>/);
    });

    it("passes when the inline gate key names an overloaded function (signatures have no body)", async () => {
      const overloaded = `${ENFORCEMENT_IMPORT}\nexport function rotate(s: string): unknown;\nexport function rotate(s: number): unknown;\n${swap(ROTATE_BODY, "export function rotate(s: unknown) {", "export function rotate(s: unknown): unknown {")}`;
      await expectPass({ files: { ...refreshFiles, "src/lib/rotate.ts": overloaded }, manifest: entry({}) });
    });

    // M1: the condition is exactly the call, the consequent a refusal. Each variant changes
    // the base ROTATE's gate `if` and nothing else.
    const GATE_IF = `if (passkeyEnforcementBlocks(s)) return { ok: false, error: "PASSKEY_REQUIRED" };`;
    const inlineVariant = (to) => ({ files: { ...refreshFiles, "src/lib/rotate.ts": swap(ROTATE, GATE_IF, to) }, manifest: entry({}) });
    const INLINE_DENY = [
      ["a negated condition", `if (!passkeyEnforcementBlocks(s)) return { ok: false, error: "PASSKEY_REQUIRED" };`],
      ["a conjunct", `if (s && passkeyEnforcementBlocks(s)) return { ok: false, error: "PASSKEY_REQUIRED" };`],
      ["a disjunct", `if (passkeyEnforcementBlocks(s) || s) return { ok: false, error: "PASSKEY_REQUIRED" };`],
      ["an else branch", `if (passkeyEnforcementBlocks(s)) return { ok: false, error: "PASSKEY_REQUIRED" }; else void 0;`],
      ["a consequent returning null", `if (passkeyEnforcementBlocks(s)) return null;`],
      ["a consequent returning ok: true", `if (passkeyEnforcementBlocks(s)) return { ok: true, error: "PASSKEY_REQUIRED" };`],
      ["a consequent returning type: success", `if (passkeyEnforcementBlocks(s)) return { type: "success" };`],
      ["a consequent literal with a spread", `if (passkeyEnforcementBlocks(s)) return { error: "PASSKEY_REQUIRED", ...s };`],
      ["a consequent that is no return", `if (passkeyEnforcementBlocks(s)) { void s; }`],
    ];
    it.each(INLINE_DENY)("FAILS when the inline gate if has %s", async (_label, to) => {
      await expectFail(inlineVariant(to), /relies on inline gate/);
    });

    const INLINE_ALLOW = [
      ["an error literal", `if (passkeyEnforcementBlocks(s)) { return { error: "access_denied" as const, userId: s }; }`],
      ["a non-success type literal", `if (passkeyEnforcementBlocks(s)) return { type: "passkey_required" as const };`],
      ["an awaited condition", `if (await passkeyEnforcementBlocks(s)) return { ok: false, error: "PASSKEY_REQUIRED" };`],
    ];
    it.each(INLINE_ALLOW)("passes when the inline gate if returns %s", async (_label, to) => {
      await expectPass(inlineVariant(to));
    });

    it("FAILS when the inline gate key names two functions (AMBIGUOUS_KEY)", async () => {
      const twice = `${ROTATE}class R {\n  rotate(s: unknown) {\n    return s;\n  }\n}\n`;
      await expectFail({ files: { ...refreshFiles, "src/lib/rotate.ts": twice }, manifest: entry({}) }, /AMBIGUOUS_KEY: inline gate "src\/lib\/rotate\.ts#rotate"/);
    });
  });
});

describe.concurrent("per-use-gated predicate", { timeout: 60_000 }, () => {
  const withBody = (body, header) => ({ files: { "src/lib/auth/tokens/api-key.ts": apiKey(body, header) } });
  const NOT_GATED = /NOT_GATED: src\/lib\/auth\/tokens\/api-key\.ts#validateApiKey/;

  it("FAILS when the gate is removed", async () => {
    await expectFail(withBody([LOOKUP, `  if (!key) return { ok: false, error: "INVALID" };`, `  return { ok: true, data: key };`].join("\n")), NOT_GATED);
  });

  it("FAILS when an ok: true return precedes the gate", async () => {
    await expectFail(withBody([LOOKUP, `  if (key.fast) return { ok: true, data: key };`, GATE, `  return { ok: true, data: key };`].join("\n")), /returns something other than an `ok: false` literal before the gate/);
  });

  it("FAILS when a non-literal return precedes the gate", async () => {
    await expectFail(withBody([LOOKUP, `  const r = { ok: false as const };`, `  if (!key) return r;`, GATE, `  return { ok: true, data: key };`].join("\n")), /before the gate/);
  });

  it("FAILS when an ok: false literal before the gate carries a spread", async () => {
    await expectFail(withBody([LOOKUP, `  if (!key) return { ok: false, ...key };`, GATE, `  return { ok: true, data: key };`].join("\n")), /before the gate/);
  });

  it("FAILS when the gate is nested in a block rather than a direct statement", async () => {
    await expectFail(withBody([LOOKUP, `  if (key) {`, `  ${GATE}`, `  }`, `  return { ok: true, data: key };`].join("\n")), NOT_GATED);
  });

  it("FAILS when the gate is not awaited", async () => {
    await expectFail(withBody([LOOKUP, swap(GATE, "await ", ""), `  return { ok: true, data: key };`].join("\n")), NOT_GATED);
  });

  it("FAILS when the gate's consequent does not return ok: false", async () => {
    await expectFail(withBody([LOOKUP, `  if (await passkeyGateBlocks({ userId: key.userId })) {}`, `  return { ok: true, data: key };`].join("\n")), NOT_GATED);
  });

  // Each variant changes the gate's consequent literal and nothing else.
  const consequent = (literal) => swap(GATED_BODY, `{ ok: false, error: "PASSKEY_REQUIRED" }`, literal);

  it("FAILS when the gate's consequent returns ok: true", async () => {
    await expectFail(withBody(consequent(`{ ok: true, error: "PASSKEY_REQUIRED" }`)), NOT_GATED);
  });

  it("FAILS when the gate's consequent literal has a duplicate ok key", async () => {
    await expectFail(withBody(consequent(`{ ok: false, error: "PASSKEY_REQUIRED", ok: true }`)), NOT_GATED);
  });

  it("FAILS when the gate's consequent literal has a shorthand ok", async () => {
    await expectFail(withBody(consequent(`{ ok, error: "PASSKEY_REQUIRED" }`)), NOT_GATED);
  });

  it("FAILS when the gate's consequent literal has a computed key", async () => {
    await expectFail(withBody(consequent(`{ ok: false, error: "PASSKEY_REQUIRED", ["ok"]: true }`)), NOT_GATED);
  });

  it("FAILS when the gate if has an else", async () => {
    await expectFail(withBody(swap(GATED_BODY, GATE, `${GATE} else void 0;`)), NOT_GATED);
  });

  it("FAILS on two gates", async () => {
    await expectFail(withBody(swap(GATED_BODY, GATE, `${GATE}\n${GATE}`)), /found 2/);
  });

  it("FAILS on an expression-bodied arrow (no block body)", async () => {
    const arrow = `${GATE_IMPORT}\nexport const validateApiKey = async (req: Request) => tx.apiKey.findUnique({ where: { tokenHash: h(req) } });\n`;
    await expectFail({ files: { "src/lib/auth/tokens/api-key.ts": arrow } }, /validateApiKey is per-use-gated but has no block body/);
  });

  // An exported const whose initializer is not a function: each site attributes to the const,
  // but the predicate can only read one function. (A direct lookup: inside the expression-bodied
  // withBypassRls callback of LOOKUP, the innermost function would be that callback.)
  const DIRECT_LOOKUP = `  const key = await tx.apiKey.findUnique({ where: { tokenHash: h(req) } });`;
  const twoFns = (second) =>
    `${GATE_IMPORT}\nexport const validateApiKey = {\n  a: async (req: Request) => {\n${swap(GATED_BODY, LOOKUP, DIRECT_LOOKUP)}\n  },\n${second ? `  b: async (req: Request) => {\n${DIRECT_LOOKUP}\n    return { ok: true, data: key };\n  },\n` : ""}};\n`;

  it("FAILS when a per-use-gated key's sites sit in two functions", async () => {
    await expectFail(
      {
        files: { "src/lib/auth/tokens/api-key.ts": twoFns(true) },
        manifest: { "src/lib/auth/tokens/api-key.ts#validateApiKey": { class: "per-use-gated", calls: 2, reason: REASON } },
      },
      /its sites sit in 2 functions/,
    );
  });

  it("passes when that key's one site sits in a gated function", async () => {
    await expectPass({ files: { "src/lib/auth/tokens/api-key.ts": twoFns(false) } });
  });

  it("FAILS when no return follows the gate", async () => {
    await expectFail(withBody([LOOKUP, GATE].join("\n")), /no return follows the gate/);
  });

  it("FAILS when passkeyGateBlocks is imported from another module", async () => {
    await expectFail(withBody(GATED_BODY, `import { passkeyGateBlocks } from "@/lib/fake-gate";`), NOT_GATED);
  });

  it("FAILS when passkeyGateBlocks is shadowed by a local binding", async () => {
    await expectFail(withBody([`  const passkeyGateBlocks = async (_: unknown) => false;`, GATED_BODY].join("\n")), NOT_GATED);
  });

  it("passes with an aliased import of the gate (import resolution, not spelling)", async () => {
    await expectPass(withBody(swap(GATED_BODY, "passkeyGateBlocks(", "gate("), `import { passkeyGateBlocks as gate } from "../policy/passkey-gate";`));
  });

  it("passes when an ok: true return before the gate sits in a nested function", async () => {
    await expectPass(withBody([`  const fallback = () => ({ ok: true });`, `  void (() => { return { ok: true }; });`, GATED_BODY].join("\n")));
  });

  it("FAILS when the exemption wrapper tests something other than the function's own parameter", async () => {
    const ext = swap(EXT_TOKEN, "if (!opts?.passkeyExemption)", "if (!globalOpts.passkeyExemption)");
    await expectFail({ files: { "src/lib/auth/tokens/extension-token.ts": ext } }, /NOT_GATED: src\/lib\/auth\/tokens\/extension-token\.ts#validateExtensionToken/);
  });

  it("FAILS when the exemption wrapper has an else branch", async () => {
    const ext = swap(EXT_TOKEN, "  }\n  return { ok: true, data: token };", "  } else {\n    void 0;\n  }\n  return { ok: true, data: token };");
    await expectFail({ files: { "src/lib/auth/tokens/extension-token.ts": ext } }, /NOT_GATED: src\/lib\/auth\/tokens\/extension-token\.ts#validateExtensionToken/);
  });
});

describe.concurrent("exemption pin", { timeout: 60_000 }, () => {
  const PIN = /EXEMPTION_PIN/;

  it("FAILS on a fourth passkeyExemption call site", async () => {
    await expectFail({ files: { "src/app/api/extra/route.ts": exemptRoute("handlePOST", "SELF_REVOCATION") } }, PIN);
  });

  it("FAILS when a pinned site passes the wrong member", async () => {
    await expectFail({ files: { "src/app/api/mobile/cache-rollback-report/route.ts": exemptRoute("handlePOST", "SELF_REVOCATION") } }, PIN);
  });

  it("FAILS when a pinned site is missing", async () => {
    await expectFail({ files: { "src/app/api/extension/key/reset/route.ts": plainRoute() } }, PIN);
  });

  it("FAILS when the options are not the inline literal", async () => {
    await expectFail(
      { files: { "src/app/api/plain/route.ts": plainRoute(`  const o = { passkeyExemption: PASSKEY_EXEMPTION.SELF_REVOCATION };\n  return validateExtensionToken(req, o);`) } },
      /options must be the inline literal/,
    );
  });

  it("FAILS on a spread argument to validateExtensionToken", async () => {
    await expectFail({ files: { "src/app/api/plain/route.ts": plainRoute(`  return validateExtensionToken(...[req]);`) } }, /called with a spread argument/);
  });

  it("FAILS on three arguments to validateExtensionToken", async () => {
    await expectFail({ files: { "src/app/api/plain/route.ts": plainRoute(`  return validateExtensionToken(req, undefined, 1);`) } }, /called with 3 arguments/);
  });

  it("FAILS when a pinned site's options literal has an extra property", async () => {
    const variant = swap(exemptRoute("handleDELETE", "SELF_REVOCATION"), "PASSKEY_EXEMPTION.SELF_REVOCATION }", "PASSKEY_EXEMPTION.SELF_REVOCATION, extra: 1 }");
    await expectFail({ files: { "src/app/api/extension/token/route.ts": variant } }, /options must be the inline literal/);
  });

  it("FAILS on an exempt call that cannot be attributed to a handler", async () => {
    await expectFail(
      { files: { "src/app/api/extra/route.ts": `${ROUTE_IMPORTS}\nconst r = validateExtensionToken(req, { passkeyExemption: PASSKEY_EXEMPTION.SELF_REVOCATION });\nvoid r;\n` } },
      /cannot be attributed to a named handler/,
    );
  });

  it("FAILS on a default import", async () => {
    await expectFail({ files: { "src/lib/def.ts": `import ext from "@/lib/auth/tokens/extension-token";\nexport const f = ext;\n` } }, /default import of extension-token/);
  });

  it("FAILS on an import-equals of the module", async () => {
    await expectFail({ files: { "src/lib/ie.ts": `import ext = require("@/lib/auth/tokens/extension-token");\nexport const f = ext;\n` } }, /import-equals of a module/);
  });

  it("passes on an import-equals of a package", async () => {
    await expectPass({ files: { "src/lib/ie.ts": `import fs = require("node:fs");\nexport const f = fs;\n` } });
  });

  it("FAILS on require() of the module", async () => {
    await expectFail({ files: { "src/lib/req.ts": `export function f() {\n  return require("@/lib/auth/tokens/extension-token");\n}\n` } }, /dynamic import\/require of extension-token/);
  });

  it("passes on require() of a package", async () => {
    await expectPass({ files: { "src/lib/req.ts": `export function f() {\n  return require("node:fs");\n}\n` } });
  });

  it("FAILS on a value reference", async () => {
    await expectFail({ files: { "src/app/api/plain/route.ts": plainRoute(`  const v = validateExtensionToken;\n  return v(req);`) } }, /used as a value/);
  });

  it("FAILS on a value reference inside the extension-token module itself", async () => {
    await expectFail({ files: { "src/lib/auth/tokens/extension-token.ts": `${EXT_TOKEN}export const alias = validateExtensionToken;\n` } }, /used as a value/);
  });

  it("FAILS on .call", async () => {
    await expectFail({ files: { "src/app/api/plain/route.ts": plainRoute(`  return validateExtensionToken.call(null, req);`) } }, /used as a value/);
  });

  it("FAILS on a named re-export", async () => {
    await expectFail({ files: { "src/lib/barrel.ts": `export { validateExtensionToken } from "@/lib/auth/tokens/extension-token";\n` } }, /re-export of validateExtensionToken/);
  });

  it("FAILS on export *", async () => {
    await expectFail({ files: { "src/lib/barrel.ts": `export * from "./auth/tokens/extension-token";\n` } }, /`export \*` of extension-token/);
  });

  it("FAILS on a namespace import", async () => {
    await expectFail({ files: { "src/lib/ns.ts": `import * as ext from "@/lib/auth/tokens/extension-token";\nexport const f = (r: Request) => ext.validateExtensionToken(r);\n` } }, /namespace import of extension-token/);
  });

  it("FAILS on a dynamic import of the module", async () => {
    await expectFail({ files: { "src/lib/dyn.ts": `export async function f() {\n  const m = await import("@/lib/auth/tokens/extension-token");\n  return m;\n}\n` } }, /dynamic import\/require of extension-token/);
  });

  it("FAILS on a dynamic import whose specifier cannot be read", async () => {
    await expectFail({ files: { "src/lib/dyn.ts": `export async function f(p: string) {\n  return import(p);\n}\n` } }, /cannot read/);
  });

  it("passes on dynamic imports this gate can rule out (a const package name, a .json template)", async () => {
    await expectPass({
      files: {
        "src/lib/dyn.ts": "export async function f(l: string) {\n  const name = \"hash-wasm\";\n  await import(name);\n  return import(`../messages/${l}.json`);\n}\n",
      },
    });
  });

  const shadowed = (param) =>
    plainRoute(`  return validateExtensionToken(req);\n}\nexport function h(${param}) {\n  return validateExtensionToken;`);

  it("ignores a same-named parameter that shadows the import (scope-aware)", async () => {
    await expectPass({ files: { "src/app/api/plain/route.ts": shadowed("validateExtensionToken: unknown") } });
  });

  it("FAILS on the same value reference once the shadowing parameter is gone", async () => {
    await expectFail({ files: { "src/app/api/plain/route.ts": shadowed("") } }, /used as a value/);
  });
});

describe.concurrent("token-model delegate references", { timeout: 60_000 }, () => {
  const other = (body) => ({ files: { "src/lib/other.ts": NOTE_FN(body) } });
  const REF = /token-model delegate referenced other than as/;

  it("passes on a direct delegate call (listed)", async () => {
    await expectPass({ ...other(`  return tx.apiKey.findFirst({ where: { tokenHash: t } });`), manifest: LISTED_LOOKUP });
  });

  it("FAILS on a delegate bound to a variable", async () => {
    await expectFail({ ...other(`  const d = tx.apiKey;\n  return d.findFirst({ where: { tokenHash: t } });`), manifest: LISTED_LOOKUP }, REF);
  });

  it("FAILS on a delegate reached by string element access and bound", async () => {
    await expectFail(other(`  const d = tx["apiKey"];\n  return run(d);`), REF);
  });

  it("FAILS on an element-access method call", async () => {
    await expectFail(other(`  return tx.apiKey["findFirst"]({ where: { tokenHash: t } });`), REF);
  });

  it("FAILS on .call of a delegate method", async () => {
    await expectFail(other(`  return tx.apiKey.findFirst.call(null, { where: { tokenHash: t } });`), REF);
  });

  it("FAILS on .apply of a delegate method", async () => {
    await expectFail(other(`  return tx.apiKey.findFirst.apply(null, [{ where: { tokenHash: t } }]);`), REF);
  });

  it("FAILS on a delegate passed as an argument", async () => {
    await expectFail(other(`  return run(tx.apiKey);`), REF);
  });

  it("FAILS on a delegate method read without a call", async () => {
    await expectFail(other(`  return tx.apiKey.findFirst;`), REF);
  });

  it("FAILS on a delegate's fields read (a delegate member, not a row field)", async () => {
    await expectFail(other(`  return tx.apiKey.fields.tokenHash;`), REF);
  });

  it("says how to comply: call a method, read a row field, or rename the property", async () => {
    await expectFail(other(`  return run(tx.apiKey);`), /read a row's relation field \(`x\.<handle>\.<field>`[^)]*\), or rename a non-Prisma property/);
  });

  it("passes on a destructured alias's same-named non-references (keys, types, other bindings)", async () => {
    const body = [
      `  const { apiKey: k } = tx;`,
      `  const o = { k: 1 };`,
      `  type T = typeof k;`,
      `  const { k: z } = o;`,
      `  const g = (k: number) => run(k);`,
      `  void (null as unknown as T);`,
      `  await k.findFirst({ where: { id: t } });`,
      `  return [o.k, z, g(1)];`,
    ].join("\n");
    await expectPass(other(body));
  });

  it("passes on a row's relation field read (a name no delegate has)", async () => {
    await expectPass(other(`  return row.apiKey.userId;`));
  });

  it("FAILS on a lookup through a renamed destructured delegate (it is analysed)", async () => {
    await expectFail(other(`  const { apiKey: k } = tx;\n  return k.findFirst({ where: { tokenHash: t } });`), /UNLISTED: src\/lib\/other\.ts#lookup.*1 digest lookup/);
  });

  it("passes on that lookup once listed", async () => {
    await expectPass({ ...other(`  const { apiKey: k } = tx;\n  return k.findFirst({ where: { tokenHash: t } });`), manifest: LISTED_LOOKUP });
  });

  it("FAILS on a renamed destructured delegate used as a value", async () => {
    await expectFail(other(`  const { apiKey: k } = tx;\n  return run(k);`), REF);
  });

  it("FAILS on a destructured delegate (string-literal computed key) used as a value", async () => {
    await expectFail(other(`  const { ["apiKey"]: k } = tx;\n  return run(k);`), REF);
  });

  it("FAILS on a destructured delegate parameter used as a value", async () => {
    await expectFail({ files: { "src/lib/other.ts": `export function f({ apiKey }: any) {\n  return run(apiKey);\n}\n` } }, REF);
  });

  it("FAILS on a delegate destructured into a nested pattern", async () => {
    await expectFail(other(`  const { apiKey: { findFirst } } = tx;\n  return findFirst({ where: { tokenHash: t } });`), /nested pattern/);
  });

  it("FAILS on $extends", async () => {
    await expectFail({ files: { "src/lib/client.ts": `export const x = prisma.$extends({});\n` } }, /\$extends: a client extension/);
  });

  it("FAILS on $extends by element access", async () => {
    await expectFail({ files: { "src/lib/client.ts": `export const x = prisma["$extends"]({});\n` } }, /\$extends: a client extension/);
  });

  it("ignores the same references to a model without a digest column", async () => {
    await expectPass(other(`  const d = tx.note;\n  return run(d, tx.note.findFirst);`));
  });
});

describe.concurrent("forbidden reads in src/lib/auth/tokens", { timeout: 60_000 }, () => {
  const tokenFile = (body) => ({ files: { "src/lib/auth/tokens/policy-read.ts": `export function f(t: any) {\n${body}\n}\n` } });

  it("FAILS on a property access", async () => {
    await expectFail(tokenFile(`  return t.requirePasskey;`), /reads requirePasskey/);
  });

  it("FAILS on an element access", async () => {
    await expectFail(tokenFile(`  return t["hasPasskey"];`), /reads hasPasskey by element access/);
  });

  it("FAILS on destructuring", async () => {
    await expectFail(tokenFile(`  const { requirePasskey: r } = t;\n  return r;`), /destructures requirePasskey/);
  });

  it("passes on an object-literal key (a select is not a read)", async () => {
    await expectPass(tokenFile(`  return { select: { requirePasskey: true, hasPasskey: true } };`));
  });

  it("passes on the same read outside src/lib/auth/tokens, or in a test file there", async () => {
    await expectPass({
      files: {
        "src/lib/auth/policy/reader.ts": `export const f = (t: any) => t.requirePasskey;\n`,
        "src/lib/auth/tokens/policy-read.test.ts": `export const f = (t: any) => t.requirePasskey;\n`,
      },
    });
  });
});

// ─── Exact-outcome cells (plan bearer-passkey-gate-coverage, C1 and C2) ──────────────────────

const OTHER = "src/lib/other.ts";
const LOOKUP_KEY = `${OTHER}#lookup`;
const exempt = (calls) => ({ class: "exempt", calls, reason: REASON });
/** `src/lib/other.ts` holding `lookup` whose body is `body` (its first line is line 2). */
const inLookup = (body) => ({ files: { [OTHER]: NOTE_FN(`  ${body}`) } });
const listed = (options, calls = 1) => ({ ...options, manifest: { [LOOKUP_KEY]: exempt(calls) } });

/** The UNLISTED line for `key`: floating entries are `[line, role]`, builder calls `[line, name]`; `lines` defaults to theirs. */
function unlisted(key, { lines, lookups = 0, opaque = [], floating = [], builderCalls = [] }) {
  const at = lines ?? [...floating.map(([l]) => l), ...builderCalls.map(([l]) => l)].sort((a, b) => a - b);
  const counts = [`${lookups} digest lookup(s)`, `${opaque.length} opaque site(s)`];
  if (floating.length) counts.push(`${floating.length} floating key(s)`);
  if (builderCalls.length) counts.push(`${builderCalls.length} builder call(s)`);
  const details = [];
  if (opaque.length) details.push(opaque.join("; "));
  if (floating.length) details.push(`floating: ${floating.map(([l, role]) => `line ${l} ${role}`).join(", ")}`);
  if (builderCalls.length) details.push(`builder calls: ${builderCalls.map(([l, n]) => `line ${l} ${n}`).join(", ")}`);
  return `UNLISTED: ${key} (lines ${at.join(", ")}) — ${counts.join(", ")}${details.length ? `: ${details.join("; ")}` : ""}. Classify it in ${MANIFEST}.`;
}

/** The COUNT_MISMATCH line: `sites` is the computed total, `declared` the manifest's. */
const countMismatch = (key, lines, sites, parts, declared) => {
  const { lookups = 0, opaque = 0, floating = 0, builderCalls = 0 } = parts;
  return `COUNT_MISMATCH: ${key} (lines ${lines.join(", ")}) has ${sites} site(s) (${lookups} lookup, ${opaque} opaque call(s), ${floating} floating key(s), ${builderCalls} builder call(s)); the manifest says ${declared}.`;
};

const unattributed = (line, role) =>
  `src/lib/other.ts:${line}  digest-key spelling (${role}) cannot be attributed to a named function, method or exported const: move it into a named function or an exported const`;

describe.concurrent("the summary line and the fatal outcome", { timeout: 60_000 }, () => {
  it("prints the census on the base fixture: both lookups placed, nothing floating", async () => {
    const { exitCode, out } = await run();
    expect(exitCode, out).toBe(0);
    expect(out).toContain("digest-keys=2 placed=2 floating=0");
  });

  it("counts a floating key in the summary line", async () => {
    const { exitCode, out } = await run(listed(inLookup(`return { tokenHash: t };`)));
    expect(exitCode, out).toBe(0);
    expect(out).toContain("digest-keys=3 placed=2 floating=1");
  });

  it("stops on a single FAIL line, and no violation summary, when the schema has no digest model", async () => {
    await expectFatal(
      { files: { "prisma/schema.prisma": "model Note {\n  id String @id\n}\n" } },
      "prisma/schema.prisma declares no model with a tokenHash/codeHash/replacedByHash field, so no lookup can be classified.",
    );
  });

  it("reports violations as the exact set of lines plus the count line, not as a fatal", async () => {
    await expectViolations(inLookup(`return { tokenHash: t };`), [unlisted(LOOKUP_KEY, { floating: [[2, "property"]] })]);
  });
});

// C1: each role of a digest-key spelling. Every deny cell spells the key; its paired allow cell
// is the same code naming `id`, so the spelling alone separates them.
describe.concurrent("digest-key spelling census — roles (A-1)", { timeout: 60_000 }, () => {
  const ROLES = [
    ["a property", `return { %K%: t };`, 2, "property"],
    ["a string-literal property", `return { "%K%": t };`, 2, "property"],
    ["a computed property naming a string", `return { ["%K%"]: t };`, 2, "computed property"],
    ["a computed property named by a const", `const k = "%K%";\n  return { [k]: t };`, 2, "string"],
    ["a shorthand property over a local binding", `const %K% = t;\n  return { %K% };`, 3, "shorthand property"],
    ["a method (attributed to itself, a named method)", `return { %K%() { return t; } };`, 2, "other (MethodDeclaration)", "tokenHash"],
    ["an accessor (attributed to itself, a named accessor)", `return { get %K%() { return t; } };`, 2, "other (GetAccessor)", "tokenHash"],
    ["a member read", `return row.%K%;`, 2, "member access"],
    ["a member assignment", `row.%K% = t;`, 2, "member access"],
    ["an element read", `return row["%K%"];`, 2, "element access"],
    ["a destructured property", `const { %K% } = row;\n  return %K%;`, 2, "destructured property"],
    ["a renamed destructured property", `const { %K%: h } = row;\n  return h;`, 2, "destructured property"],
    ["a string in a list", `return ["%K%"];`, 2, "string"],
    ["a no-substitution template in a list", "return [`%K%`];", 2, "string"],
    ["a string passed to a call", `return Reflect.get(row, "%K%");`, 2, "string"],
    ["a string compared", `return t === "%K%";`, 2, "string"],
    ["a string handed to a decorator (attributed to the decorated method)", `class C {\n    @dec("%K%")\n    m() {}\n  }\n  return C;`, 3, "string", "m"],
    ["a reference with no visible binding", `return %K%;`, 2, "unresolved reference"],
    ["a class's extends expression with no visible binding", `class C extends %K% {}\n  return C;`, 2, "unresolved reference"],
  ];
  it.each(ROLES)("FAILS on %s", async (_label, code, line, role, fn = "lookup") => {
    await expectViolations(inLookup(code.replaceAll("%K%", "tokenHash")), [unlisted(`${OTHER}#${fn}`, { floating: [[line, role]] })]);
  });
  it.each(ROLES)("passes on the same code naming id: %s", async (_label, code) => {
    await expectPass(inLookup(code.replaceAll("%K%", "id")));
  });

  it.each(["tokenHash", "codeHash", "replacedByHash"])("FAILS on %s alone as a string in a list (every digest key is a spelling)", async (key) => {
    await expectViolations(inLookup(`return ["${key}"];`), [unlisted(LOOKUP_KEY, { floating: [[2, "string"]] })]);
  });

  it("FAILS on a string that is a digest key only once cooked (an escape)", async () => {
    await expectViolations(inLookup(`return ["token\\x48ash"];`), [unlisted(LOOKUP_KEY, { floating: [[2, "string"]] })]);
  });

  it("passes on a string that merely contains a digest key (SC3: text, not a key)", async () => {
    await expectPass(inLookup(`return ["the tokenHash column"];`));
  });

  it("passes once the spelling's function is listed with the figure", async () => {
    await expectPass(listed(inLookup(`return ["tokenHash"];`)));
  });

  const BINDINGS = [
    ["a const and its reference", `const tokenHash = t;\n  return tokenHash;`],
    ["a const used as a member receiver", `const tokenHash = t;\n  return tokenHash.length;`],
    ["a const read as an initializer", `const tokenHash = t;\n  const copy = tokenHash;\n  return copy;`],
    ["a const extended by a class", `const tokenHash = Base;\n  class C extends tokenHash {}\n  return C;`],
    ["a name in an implements clause (a type position)", `class C implements tokenHash {}\n  return C;`],
    ["a function declaration and its call", `function tokenHash() {\n    return t;\n  }\n  return tokenHash();`],
    ["a renamed destructuring target", `const { id: tokenHash } = row;\n  return tokenHash;`],
    ["an array destructuring element", `const [tokenHash] = row;\n  return tokenHash;`],
    ["a parameter of a nested function", `return [1].map((tokenHash) => tokenHash);`],
  ];
  it.each(BINDINGS)("passes on %s (a binding, not a spelling)", async (_label, code) => {
    await expectPass(inLookup(code));
  });

  it("passes on a parameter named as a digest key (a binding)", async () => {
    await expectPass({ files: { [OTHER]: `export function lookup(tokenHash: string) {\n  return tokenHash;\n}\n` } });
  });

  it("passes on an import specifier named as a digest key (a binding)", async () => {
    await expectPass({ files: { [OTHER]: `import { tokenHash } from "./h";\nexport const x = 1;\n` } });
  });

  const TYPES = [
    ["a type alias member", `type Row = { tokenHash: string };\n  return null as unknown as Row;`],
    ["a string literal type", `type K = "tokenHash";\n  return null as unknown as K;`],
    ["a type argument", `return null as unknown as Pick<Row, "tokenHash">;`],
    ["a typeof query", `const tokenHash = t;\n  type K = typeof tokenHash;\n  return null as unknown as K;`],
  ];
  it.each(TYPES)("passes on %s (a type position, not a spelling)", async (_label, code) => {
    await expectPass(inLookup(code));
  });

  it("passes on an interface member and a parameter annotation", async () => {
    await expectPass({ files: { [OTHER]: `interface Row {\n  tokenHash: string;\n}\nexport function lookup(row: { tokenHash: string }) {\n  return row;\n}\n` } });
  });

  it("FAILS on a class member outside any function with the attribution line", async () => {
    await expectViolations({ files: { [OTHER]: `class Repo {\n  tokenHash = 1;\n}\nexport const x = Repo;\n` } }, [unattributed(2, "other (PropertyDeclaration)")]);
  });

  it("passes on the same class member inside a named function with an entry", async () => {
    await expectPass(listed(inLookup(`class Repo {\n    tokenHash = 1;\n  }\n  return Repo;`)));
  });

  it("FAILS on a non-exported top-level const holding a spelling with the attribution line", async () => {
    await expectViolations({ files: { [OTHER]: `const BLOCK = ["tokenHash"];\nexport const x = BLOCK;\n` } }, [unattributed(1, "string")]);
  });

  it("passes on the same list in an exported const with an entry", async () => {
    await expectPass({ files: { [OTHER]: `export const BLOCK = ["tokenHash"];\n` }, manifest: { [`${OTHER}#BLOCK`]: exempt(1) } });
  });
});

// A-1b: positions rare enough that only the default arm (an unrecognised role is a key) sees them.
describe.concurrent("digest-key spelling census — the default arm (A-1b)", { timeout: 60_000 }, () => {
  const DEFAULT_ARM = [
    ["an enum member", inLookup, `enum E { %K% = 1 }\n  return E;`, [[2, "other (EnumMember)"]]],
    ["a labelled statement and its break", inLookup, `%K%: for (;;) { break %K%; }`, [[2, "other (LabeledStatement)"], [2, "other (BreakStatement)"]]],
  ];
  it.each(DEFAULT_ARM)("FAILS on %s", async (_label, build, code, floating) => {
    await expectViolations(build(code.replaceAll("%K%", "tokenHash")), [unlisted(LOOKUP_KEY, { floating })]);
  });
  it.each(DEFAULT_ARM)("passes on %s naming id", async (_label, build, code) => {
    await expectPass(build(code.replaceAll("%K%", "id")));
  });

  const jsx = (name) => ({ files: { "src/lib/other.tsx": `export function lookup() {\n  return <div ${name}="x" />;\n}\n` } });
  it("FAILS on a JSX attribute", async () => {
    await expectViolations(jsx("tokenHash"), [unlisted("src/lib/other.tsx#lookup", { floating: [[2, "other (JsxAttribute)"]] })]);
  });
  it("passes on a JSX attribute naming id", async () => {
    await expectPass(jsx("id"));
  });

  const aliasExport = (name) => ({ files: { [OTHER]: `const x = 1;\nexport { x as ${name} };\n` } });
  it("FAILS on an export specifier alias (with the attribution line)", async () => {
    await expectViolations(aliasExport("tokenHash"), [unattributed(2, "other (ExportSpecifier)")]);
  });
  it("passes on an export specifier alias naming id", async () => {
    await expectPass(aliasExport("id"));
  });

  it("passes on an export specifier that exports a local binding named as a digest key", async () => {
    await expectPass({ files: { [OTHER]: `const tokenHash = 1;\nexport { tokenHash as exported };\n` } });
  });

  const importedAs = (name) => ({ files: { [OTHER]: `import { ${name} as local } from "./h";\nexport const x = local;\n` } });
  it("FAILS on the imported name of an aliased import specifier (with the attribution line)", async () => {
    await expectViolations(importedAs("tokenHash"), [unattributed(1, "other (ImportSpecifier)")]);
  });
  it("passes on that import naming id", async () => {
    await expectPass(importedAs("id"));
  });
});

// A-2, A-3: the shapes the issue's residuals named. Each fixture passes the gate as it stood before
// C1 (recorded in the deviation log) and now fails; the paired allow cell names id instead.
describe.concurrent("formerly unread shapes (A-2, A-3)", { timeout: 60_000 }, () => {
  const SHAPES = [
    ["a conditional spread", `return %R%.findFirst({ where: { ...(c ? { %K%: t } : {}) } });`, 2],
    ["an && spread", `return %R%.findFirst({ where: { ...(c && { %K%: t }) } });`, 2],
    ["an && expression as the where", `return %R%.findFirst({ where: c && { %K%: t } });`, 2],
    ["an || expression as the where", `return %R%.findFirst({ where: c || { %K%: t } });`, 2],
    ["a ?? expression as the where", `return %R%.findFirst({ where: c ?? { %K%: t } });`, 2],
    ["a computed key pinned by a const, under a spread", `const k = "%K%";\n  return %R%.findFirst({ where: { ...(c && { [k]: t }) } });`, 2],
  ];
  const RECEIVERS = [
    ["an unresolved receiver", "x"],
    ["a non-token model", "tx.note"],
  ];
  const cases = SHAPES.flatMap(([shape, code, line]) => RECEIVERS.map(([receiver, r]) => [`${shape} on ${receiver}`, code.replaceAll("%R%", r), line]));
  it.each(cases)("FAILS on %s", async (_label, code, line) => {
    await expectViolations(inLookup(code.replaceAll("%K%", "tokenHash")), [unlisted(LOOKUP_KEY, { floating: [[line, code.includes("const k") ? "string" : "property"]] })]);
  });
  it.each(cases)("passes on the same shape naming id: %s", async (_label, code) => {
    await expectPass(inLookup(code.replaceAll("%K%", "id")));
  });

  // A helper's return: the helper spells the key (a builder) and its caller is one site of the caller (A-4b).
  const helperFile = (key) => ({ files: { [OTHER]: `function build(h: string) {\n  return { ${key}: h };\n}\nexport function lookup(t: string) {\n  return x.findFirst({ where: build(t) });\n}\n` } });
  it("FAILS on a helper's return as the where, as the helper and its caller", async () => {
    await expectViolations(helperFile("tokenHash"), [
      unlisted(`${OTHER}#build`, { floating: [[2, "property"]] }),
      unlisted(LOOKUP_KEY, { builderCalls: [[5, "build"]] }),
    ]);
  });
  it("passes on the same helper returning id", async () => {
    await expectPass(helperFile("id"));
  });

  const REFLECT = (key) => `const w: Record<string, unknown> = { ${key}: t };\n  w.extra = 1;\n  return Reflect.get(tx, "apiKey").findFirst({ where: w });`;
  it("FAILS on a digest key in a where held in an assigned-into variable, on a Reflect.get receiver", async () => {
    await expectViolations(inLookup(REFLECT("tokenHash")), [unlisted(LOOKUP_KEY, { floating: [[2, "property"]] })]);
  });
  it("passes on the same where naming id", async () => {
    await expectPass(inLookup(REFLECT("id")));
  });

  const TWO_HOP = (key) =>
    `const held: Record<string, unknown> = { user: { update: { data: { apiKeys: { connect: { ${key}: t } } } } } };\n  held.extra = 1;\n  return tx.profile.update({ where: { id: t }, data: held });`;
  it("FAILS on a digest key in a two-hop data held in an assigned-into variable", async () => {
    await expectViolations(inLookup(TWO_HOP("tokenHash")), [unlisted(LOOKUP_KEY, { floating: [[2, "property"]] })]);
  });
  it("passes on the same data naming id", async () => {
    await expectPass(inLookup(TWO_HOP("id")));
  });
});

// A-4: what a floating key adds to `calls`, told apart by the COUNT_MISMATCH figure.
describe.concurrent("digest-key spelling census — site counting (A-4)", { timeout: 60_000 }, () => {
  const LOOKUP_CALL = `tx.apiKey.findFirst({ where: { tokenHash: t }, %META% })`;
  const withMeta = (meta) => LOOKUP_CALL.replace("%META%", meta);

  it("adds 0 for a floating key inside a counted lookup call of the same function", async () => {
    await expectPass(listed(inLookup(`return ${withMeta("meta: { tokenHash: t }")};`)));
  });
  it("FAILS that cell when the manifest counts the floating key too", async () => {
    await expectViolations(listed(inLookup(`return ${withMeta("meta: { tokenHash: t }")};`), 2), [countMismatch(LOOKUP_KEY, [2], 1, { lookups: 1 }, 2)]);
  });

  it("adds 1 for the same floating key outside the counted call", async () => {
    await expectViolations(listed(inLookup(`const meta = { tokenHash: t };\n  return ${withMeta("meta")};`)), [
      countMismatch(LOOKUP_KEY, [2, 3], 2, { lookups: 1, floating: 1 }, 1),
    ]);
  });
  it("passes when the manifest counts that floating key", async () => {
    await expectPass(listed(inLookup(`const meta = { tokenHash: t };\n  return ${withMeta("meta")};`), 2));
  });

  it("adds 1 for a floating key that follows the counted call (not inside it)", async () => {
    await expectViolations(
      listed(inLookup(`const found = tx.apiKey.findFirst({ where: { tokenHash: t } });\n  const meta = { tokenHash: t };\n  return [found, meta];`)),
      [countMismatch(LOOKUP_KEY, [2, 3], 2, { lookups: 1, floating: 1 }, 1)],
    );
  });

  const IN_FLOATING = `return { tokenHash: function inner() {\n    return { tokenHash: t };\n  } };`;
  it("adds 1 under its own key for a floating key in a nested named function inside another floating key", async () => {
    await expectViolations(listed(inLookup(IN_FLOATING)), [unlisted(`${OTHER}#inner`, { floating: [[3, "property"]] })]);
  });
  it("passes once both functions are listed", async () => {
    await expectPass({ ...inLookup(IN_FLOATING), manifest: { [LOOKUP_KEY]: exempt(1), [`${OTHER}#inner`]: exempt(1) } });
  });

  it("adds 1 for nested computed floating keys too", async () => {
    await expectPass(listed(inLookup(`return { ["tokenHash"]: { ["tokenHash"]: t } };`)));
  });

  it("adds 1 for nested floating keys (the inner is part of the outer's spelling)", async () => {
    await expectPass(listed(inLookup(`return { tokenHash: { tokenHash: t } };`)));
  });
  it("FAILS the nested cell when the manifest counts both", async () => {
    await expectViolations(listed(inLookup(`return { tokenHash: { tokenHash: t } };`), 2), [countMismatch(LOOKUP_KEY, [2], 1, { floating: 1 }, 2)]);
  });

  it("adds 2 for two sibling floating keys", async () => {
    await expectViolations(listed(inLookup(`return [{ tokenHash: t }, { tokenHash: t }];`)), [countMismatch(LOOKUP_KEY, [2, 2], 2, { floating: 2 }, 1)]);
  });
  it("passes when the manifest counts both siblings", async () => {
    await expectPass(listed(inLookup(`return [{ tokenHash: t }, { tokenHash: t }];`), 2));
  });

  const NESTED_FN = (fnName) =>
    `return ${withMeta(`meta: function ${fnName}() {\n    return { tokenHash: t };\n  }`)};`;
  it("adds 1 under its own key for a floating key in a nested named function inside a counted call", async () => {
    await expectViolations(listed(inLookup(NESTED_FN("inner"))), [unlisted(`${OTHER}#inner`, { floating: [[3, "property"]] })]);
  });
  it("passes once that nested function has its own entry", async () => {
    await expectPass({ ...inLookup(NESTED_FN("inner")), manifest: { [LOOKUP_KEY]: exempt(1), [`${OTHER}#inner`]: exempt(1) } });
  });
  it("adds 0 when the nested function is anonymous (it attributes to the counted call's function)", async () => {
    await expectPass(listed(inLookup(`return ${withMeta("meta: () => ({ tokenHash: t })")};`)));
  });

  it("goes STALE_ENTRY once a floating-only function's key is placed", async () => {
    await expectViolations(listed(inLookup(`return tx.apiKey.create({ data: { tokenHash: t } });`)), [
      `STALE_ENTRY: ${LOOKUP_KEY} is in the manifest but no digest lookup, opaque site, floating digest key or builder call is attributed to it.`,
    ]);
  });
  it("is not stale while the same write is on a receiver that does not resolve (floating)", async () => {
    await expectPass(listed(inLookup(`return x.create({ data: { tokenHash: t } });`)));
  });

  it("never lets a floating key satisfy model coverage (UNCOVERED_MODEL stays)", async () => {
    await expectViolations({ ...inLookup(`return x.create({ data: { codeHash: t } });`), manifest: { [LOOKUP_KEY]: exempt(1) }, models: NO_AUTHCODE_ENTRY }, [
      'UNCOVERED_MODEL: AuthCode declares a digest column but no analysed lookup reaches it — find its lookups, or list it in "models" with a reason.',
    ]);
  });
});

// A-4b: a function that spells a digest key outside every position the walk reads builds a
// digest-keyed object; a direct call of it is one site of the caller, one level only.
describe.concurrent("digest-key spelling census — builders and their callers (A-4b)", { timeout: 60_000 }, () => {
  const BUILDER = `${OTHER}#build`;
  const CALLER = `${OTHER}#lookup`;
  const callerOf = (callee) => `export function lookup(t: string) {\n  return x.findFirst({ where: ${callee}(t) });\n}\n`;
  const local = (builder, caller = callerOf("build")) => ({ files: { [OTHER]: `${builder}${caller}` } });
  const BUILD_FNS = [
    ["an object literal", `function build(h: string) {\n  return { tokenHash: h };\n}\n`, "property"],
    ["a string-literal property", `function build(h: string) {\n  return { "tokenHash": h };\n}\n`, "property"],
    ["a shorthand property", `function build(tokenHash: string) {\n  return { tokenHash };\n}\n`, "shorthand property"],
    ["a computed property", `function build(h: string) {\n  return { ["tokenHash"]: h };\n}\n`, "computed property"],
    ["an assignment to a member", `function build(h: string) {\n  const w: Record<string, unknown> = {};\n  w.tokenHash = h;\n  return w;\n}\n`, "member access"],
    ["an assignment to an element", `function build(h: string) {\n  const w: Record<string, unknown> = {};\n  w["tokenHash"] = h;\n  return w;\n}\n`, "element access"],
    ["Object.fromEntries", `function build(h: string) {\n  return Object.fromEntries([["tokenHash", h]]);\n}\n`, "string"],
    ["Reflect.set", `function build(h: string) {\n  const w: Record<string, unknown> = {};\n  Reflect.set(w, "tokenHash", h);\n  return w;\n}\n`, "string"],
  ];
  const lineOf = (builder) => builder.split("\n").findLastIndex((l) => l.includes("tokenHash")) + 1;
  const callerLine = (builder) => builder.split("\n").length - 1 + 2;

  it.each(BUILD_FNS)("FAILS on a helper building the key by %s, and on the same-file caller", async (_label, builder, role) => {
    await expectViolations(local(builder), [
      unlisted(BUILDER, { floating: [[lineOf(builder), role]] }),
      unlisted(CALLER, { builderCalls: [[callerLine(builder), "build"]] }),
    ]);
  });
  it.each(BUILD_FNS)("passes when both are listed: %s", async (_label, builder) => {
    await expectPass({ ...local(builder), manifest: { [BUILDER]: exempt(1), [CALLER]: exempt(1) } });
  });

  it("FAILS on the caller of a builder reached by a named import, in another file", async () => {
    await expectViolations(
      {
        files: {
          "src/lib/builder.ts": `export function build(h: string) {\n  return { tokenHash: h };\n}\n`,
          [OTHER]: `import { build } from "./builder";\n${callerOf("build")}`,
        },
      },
      [unlisted("src/lib/builder.ts#build", { floating: [[2, "property"]] }), unlisted(CALLER, { builderCalls: [[3, "build"]] })],
    );
  });
  it("FAILS on the caller through an aliased import", async () => {
    await expectViolations(
      {
        files: {
          "src/lib/builder.ts": `export function build(h: string) {\n  return { tokenHash: h };\n}\n`,
          [OTHER]: `import { build as mk } from "./builder";\n${callerOf("mk")}`,
        },
      },
      [unlisted("src/lib/builder.ts#build", { floating: [[2, "property"]] }), unlisted(CALLER, { builderCalls: [[3, "build"]] })],
    );
  });

  const BUILDER_FILE = { "src/lib/builder.ts": `export function build(h: string) {\n  return { tokenHash: h };\n}\n` };
  const BUILDER_ENTRY = { "src/lib/builder.ts#build": exempt(1) };
  it("passes on a same-named local function shadowing the import", async () => {
    await expectPass({
      files: { ...BUILDER_FILE, [OTHER]: `import { build } from "./builder";\nexport function lookup(t: string) {\n  const build = (h: string) => ({ id: h });\n  return x.findFirst({ where: build(t) });\n}\n` },
      manifest: BUILDER_ENTRY,
    });
  });
  it("passes on a caller of a function that only reads the key", async () => {
    await expectPass({
      files: {
        "src/lib/reader.ts": `export function read(row: { id: string }) {\n  return row.tokenHash;\n}\n`,
        [OTHER]: `import { read } from "./reader";\nexport function lookup(t: string) {\n  return x.findFirst({ where: read(t) });\n}\n`,
      },
      manifest: { "src/lib/reader.ts#read": exempt(1) },
    });
  });
  it("passes on a caller of a function that only lists the key as a string", async () => {
    await expectPass({
      files: { [OTHER]: `function names() {\n  return ["tokenHash"];\n}\nexport function lookup(t: string) {\n  return x.findFirst({ where: pick(names()) });\n}\n` },
      manifest: { [`${OTHER}#names`]: exempt(1) },
    });
  });
  const readerCaller = (reader) => ({
    files: {
      "src/lib/reader.ts": reader,
      [OTHER]: `import { read } from "./reader";\nexport function lookup(t: string) {\n  return x.findFirst({ where: read(t) });\n}\n`,
    },
    manifest: { "src/lib/reader.ts#read": exempt(1) },
  });
  it("passes on a caller of a function that compares the key", async () => {
    await expectPass(readerCaller(`export function read(row: { id: string }, h: string) {\n  return row.tokenHash === h;\n}\n`));
  });
  it("passes on a caller of a function that copies the key from a row (the member is the right side)", async () => {
    await expectPass(readerCaller(`export function read(row: { id: string }, w: Record<string, unknown>) {\n  w.id = row.tokenHash;\n  return w;\n}\n`));
  });
  it("passes on a caller of a caller (one level only)", async () => {
    await expectPass({
      files: {
        [OTHER]: `function build(h: string) {\n  return { tokenHash: h };\n}\nfunction mid(h: string) {\n  return build(h);\n}\nexport function lookup(t: string) {\n  return x.findFirst({ where: mid(t) });\n}\n`,
      },
      manifest: { [BUILDER]: exempt(1), [`${OTHER}#mid`]: exempt(1) },
    });
  });
  it("FAILS on the middle function of that chain when it has no entry", async () => {
    await expectViolations(
      { files: { [OTHER]: `function build(h: string) {\n  return { tokenHash: h };\n}\nfunction mid(h: string) {\n  return build(h);\n}\n` }, manifest: { [BUILDER]: exempt(1) } },
      [unlisted(`${OTHER}#mid`, { builderCalls: [[5, "build"]] })],
    );
  });
  it("passes on a method call of a builder method (SC6)", async () => {
    await expectPass({
      files: { [OTHER]: `class Repo {\n  build(h: string) {\n    return { tokenHash: h };\n  }\n}\nexport function lookup(t: string, repo: Repo) {\n  return x.findFirst({ where: repo.build(t) });\n}\n` },
      manifest: { [BUILDER]: exempt(1) },
    });
  });
  it("passes on a call through a namespace import (SC6)", async () => {
    await expectPass({
      files: { ...BUILDER_FILE, [OTHER]: `import * as b from "./builder";\nexport function lookup(t: string) {\n  return x.findFirst({ where: b.build(t) });\n}\n` },
      manifest: BUILDER_ENTRY,
    });
  });
  it("passes on a builder passed as a value (SC6)", async () => {
    await expectPass({ ...local(`function build(h: string) {\n  return { tokenHash: h };\n}\n`, `export function lookup(t: string) {\n  return [t].map(build);\n}\n`), manifest: { [BUILDER]: exempt(1) } });
  });
  it("counts each direct call of a builder as a site of its caller", async () => {
    await expectPass({ ...local(`function build(h: string) {\n  return { tokenHash: h };\n}\n`, `export function lookup(t: string) {\n  return [build(t), build(t)];\n}\n`), manifest: { [BUILDER]: exempt(1), [CALLER]: exempt(2) } });
  });
});

// A-5: a digest key written or projected is placed only on a receiver that resolves to a model
// declaring the field. Every pass cell has a fail twin differing in the receiver alone.
describe.concurrent("digest-key placement (A-5)", { timeout: 60_000 }, () => {
  const POSITIONS = [
    ["a data", `return %R%.create({ data: { %K%: t } });`],
    ["an updateMany data", `return %R%.updateMany({ where: { id: t }, data: { %K%: t } });`],
    ["a createMany data", `return %R%.createMany({ data: [{ %K%: t }] });`],
    ["an upsert's create and update", `return %R%.upsert({ where: { id: t }, create: { %K%: t }, update: { id: t } });`],
    ["a select", `return %R%.findFirst({ where: { id: t }, select: { %K%: true } });`],
    ["an omit", `return %R%.findFirst({ where: { id: t }, omit: { %K%: true } });`],
  ];
  it.each(POSITIONS)("passes on %s of a digest key on a model declaring it", async (_label, code) => {
    await expectPass(inLookup(code.replace("%R%", "tx.apiKey").replace("%K%", "tokenHash")));
  });
  it.each(POSITIONS)("FAILS on %s of a digest key on a model that does not declare it", async (_label, code) => {
    await expectViolations(inLookup(code.replace("%R%", "tx.note").replace("%K%", "tokenHash")), [unlisted(LOOKUP_KEY, { floating: [[2, "property"]] })]);
  });
  it.each(POSITIONS)("FAILS on %s of a digest key on an unresolved receiver", async (_label, code) => {
    await expectViolations(inLookup(code.replace("%R%", "x").replace("%K%", "tokenHash")), [unlisted(LOOKUP_KEY, { floating: [[2, "property"]] })]);
  });

  it("FAILS on a digest key under an include (a projection for placement is select or omit only)", async () => {
    await expectViolations(inLookup(`return tx.apiKey.findFirst({ where: { id: t }, include: { tokenHash: true } });`), [unlisted(LOOKUP_KEY, { floating: [[2, "property"]] })]);
  });

  it("FAILS on a digest key the model declares under another name (codeHash on ApiKey)", async () => {
    await expectViolations(inLookup(`return tx.apiKey.create({ data: { codeHash: t } });`), [unlisted(LOOKUP_KEY, { floating: [[2, "property"]] })]);
  });

  const NESTED = [
    ["a nested create", `return tx.%M%.update({ where: { id: t }, data: { apiKeys: { create: { tokenHash: t } } } });`],
    ["a nested createMany", `return tx.%M%.update({ where: { id: t }, data: { apiKeys: { createMany: { data: [{ tokenHash: t }] } } } });`],
    ["a nested updateMany's data", `return tx.%M%.update({ where: { id: t }, data: { apiKeys: { updateMany: { where: { id: t }, data: { tokenHash: t } } } } });`],
    ["a select under a relation", `return tx.%M%.findFirst({ where: { id: t }, select: { apiKeys: { select: { tokenHash: true } } } });`],
  ];
  it.each(NESTED)("passes on %s whose relation resolves to the token model", async (_label, code) => {
    await expectPass(inLookup(code.replace("%M%", "user")));
  });
  it.each(NESTED)("FAILS on %s whose relation does not resolve", async (_label, code) => {
    await expectViolations(inLookup(code.replace("%M%", "note")), [unlisted(LOOKUP_KEY, { floating: [[2, "property"]] })]);
  });

  it("places a key without changing what the walkers read: a non-literal updateMany data on a related model is still not opaque", async () => {
    await expectPass(inLookup(`return tx.user.updateMany({ where: { id: t }, data: t });`));
  });
});

// C2: a computed key this file cannot pin is opaque in every filter position, on any model; the
// walk's reach is unchanged (an unresolved receiver is walked only in a file that spells a digest key).
describe.concurrent("an unpinned computed key in a filter (A-7)", { timeout: 60_000 }, () => {
  const POSITIONS = [
    ["a where", `return tx.note.findFirst({ where: { [%C%]: 1 } });`, "Note where"],
    ["a cursor", `return tx.note.findMany({ cursor: { [%C%]: 1 } });`, "Note cursor"],
    ["a having", `return tx.note.groupBy({ by: ["id"], having: { [%C%]: 1 } });`, "Note having"],
    ["a where under a logical", `return tx.note.findFirst({ where: { AND: [{ [%C%]: 1 }] } });`, "Note where"],
    ["a relation filter under is", `return tx.profile.findFirst({ where: { user: { is: { [%C%]: 1 } } } });`, "User where"],
    ["a direct to-one relation filter", `return tx.profile.findFirst({ where: { user: { [%C%]: 1 } } });`, "User relation filter"],
    ["a nested update's where", `return tx.profile.update({ where: { id: t }, data: { user: { update: { where: { [%C%]: 1 }, data: {} } } } });`, "User user.update.where"],
    ["an include relation's where", `return tx.profile.findFirst({ include: { user: { where: { [%C%]: 1 } } } });`, "User where"],
  ];
  it.each(POSITIONS)("FAILS on an unpinned computed key in %s on a non-token model", async (_label, code, label) => {
    await expectViolations(inLookup(code.replace("%C%", "t")), [unlisted(LOOKUP_KEY, { lines: [2], opaque: [`line 2: ${label}: computed key`] })]);
  });
  it.each(POSITIONS)("passes on the same key pinned by a const in %s", async (_label, code) => {
    await expectPass(inLookup(`const k = "id";\n  ${code.replace("%C%", "k")}`));
  });
  it.each(POSITIONS)("passes once the opaque position is listed opaque-where: %s", async (_label, code) => {
    await expectPass({ ...inLookup(code.replace("%C%", "t")), manifest: { [LOOKUP_KEY]: { class: "opaque-where", calls: 1, reason: REASON } } });
  });

  it("passes on an unpinned computed key under data on a non-token model", async () => {
    await expectPass(inLookup(`return tx.note.create({ data: { [t]: 1 } });`));
  });
  it("passes on an unpinned computed key under select on a non-token model", async () => {
    await expectPass(inLookup(`return tx.note.findFirst({ select: { [t]: true } });`));
  });

  it("FAILS on an unpinned computed key in a where on an unresolved receiver in a file that spells a digest key", async () => {
    await expectViolations(
      { files: { [OTHER]: `// tokenHash\nexport async function lookup(t: string) {\n  return x.findFirst({ where: { [t]: 1 } });\n}\n` } },
      [unlisted(LOOKUP_KEY, { lines: [3], opaque: ["line 3: unresolved where: computed key"] })],
    );
  });
  it("passes on that call in a file that spells no digest key (the walk's reach is unchanged)", async () => {
    await expectPass(inLookup(`return x.findFirst({ where: { [t]: 1 } });`));
  });
});


// ─── Raw SQL static rules W1-W6 (C3) ─────────────────────────────────────────────────────────
// Each deny cell fires one rule once (SQL naming no digest column, so the column rule stays
// silent); its paired allow cell differs in the one thing the rule reads.

const SQL_FILE = "src/lib/raw.ts";
const TRUSTED_IMPORT = `import { trustedSql } from "@/lib/prisma/raw-sql";`;
/** `src/lib/raw.ts` whose function body is `stmt` (on line 3). */
const sqlBody = (stmt) => ({ files: { [SQL_FILE]: `${TRUSTED_IMPORT}\nexport async function q(tx: any, t: string, tbl: any, parent: any) {\n  ${stmt}\n}\n` } });
const viaTag = (sql) => sqlBody("await tx.$queryRaw`" + sql + "`;");
const viaUnsafe = (sql) => sqlBody(`await tx.$executeRawUnsafe(${JSON.stringify(sql)});`);
const viaTrusted = (sql) => sqlBody("return trustedSql`" + sql + "`;");
const ruleAt = (rule, message, line = 3) => `${SQL_FILE}:${line}  ${rule}: ${message}`;
const W = {
  star: 'a "*" other than count(*) reads whole rows, digest column included',
  table: (name) => `token table ${name} outside relation position (and not qualifying one of its columns)`,
  alias: (name) => `alias ${name} of a token relation outside relation position (and not qualifying a declared column)`,
  aliasList: (name) => `alias ${name} of a token relation is followed by a column alias list`,
  string: (name) => `a string names token table ${name}: SQL inside a string is not read`,
  looseFrom: "a substitution after a FROM that is not a relation FROM",
  valueRelation: "a substitution in relation position followed by :: / [ / ( is a value, not a relation",
  qualifier: (name) => `a substituted qualifier names ${name}, not a column of any schema model`,
  adjacent: "a substitution adjacent to a word character, - or / assembles a name or a comment marker from parts",
};

describe.concurrent("raw SQL: W1 whole-row projections", { timeout: 60_000 }, () => {
  const DENY = [
    ["a * on a token table", viaTag("SELECT * FROM api_keys")],
    ["a qualified .* on a token alias", viaTag("SELECT k.* FROM api_keys k")],
    ["RETURNING * on a token table", viaUnsafe("DELETE FROM api_keys WHERE id = $1 RETURNING *")],
    ["a * in a trustedSql template that names no token table", viaTrusted("SELECT * FROM notes")],
  ];
  it.each(DENY)("FAILS on %s", async (_label, options) => {
    await expectViolations(options, [ruleAt("W1", W.star)]);
  });
  const ALLOW = [
    ["count(*) on a token table", viaTag("SELECT count(*) FROM api_keys")],
    ["a * in a literal that names no token table", viaTag("SELECT * FROM notes")],
    ["RETURNING * on a table that is not a token table", viaUnsafe("DELETE FROM notes WHERE id = $1 RETURNING *")],
    ["a multiplication in a literal that names no token table", viaTag("SELECT 2 * 3 FROM notes")],
    ["count(*) in a trustedSql template", viaTrusted("SELECT count(*) FROM notes")],
  ];
  it.each(ALLOW)("passes on %s", async (_label, options) => {
    await expectPass(options);
  });
});

describe.concurrent("raw SQL: W2 a token table's name or alias outside relation position", { timeout: 60_000 }, () => {
  const DENY = [
    ["to_jsonb(alias)", viaTag("SELECT to_jsonb(k) FROM api_keys k"), W.alias("k")],
    ["alias::text", viaTag("SELECT k::text FROM api_keys k"), W.alias("k")],
    ["an alias qualifying something that is not a column", viaTag("SELECT k.to_jsonb FROM api_keys k"), W.alias("k")],
    ["a token table's name in a function call", viaTag("SELECT row_to_json(api_keys) FROM api_keys"), W.table("api_keys")],
    ["TABLE <token table>", viaTag("TABLE api_keys"), W.table("api_keys")],
    ["a token table in a comma list", viaTag("SELECT 1 FROM notes n, api_keys"), W.table("api_keys")],
    ["a relation cast to text", viaTag("SELECT 1 FROM api_keys::text"), W.table("api_keys")],
    ["FOR UPDATE OF <token table>", viaTag("SELECT 1 FROM api_keys FOR UPDATE OF api_keys"), W.table("api_keys")],
    ["a name in another case", viaTag("SELECT row_to_json(API_KEYS) FROM api_keys"), W.table("api_keys")],
    ["an alias after a comment between FROM and the name", viaTag("SELECT to_jsonb(k) FROM /* c */ api_keys k"), W.alias("k")],
    ["an alias on a schema-qualified relation", viaTag("SELECT to_jsonb(k) FROM public.api_keys k"), W.alias("k")],
    ["an alias on a quoted relation", viaTag('SELECT to_jsonb(k) FROM "api_keys" k'), W.alias("k")],
    ["an alias of a substituted relation", viaTrusted("SELECT to_jsonb(k) FROM ${tbl} k"), W.alias("k")],
    ["an alias of a substituted relation qualifying a non-column", viaTrusted("SELECT k.to_jsonb FROM ${tbl} k"), W.alias("k")],
  ];
  it.each(DENY)("FAILS on %s", async (_label, options, message) => {
    await expectViolations(options, [ruleAt("W2", message)]);
  });
  const ALLOW = [
    ["an alias qualifying a declared column", viaTag("SELECT k.user_id FROM api_keys k")],
    ["the table's own name qualifying a declared column", viaTag("SELECT api_keys.user_id FROM api_keys")],
    ["a schema-qualified relation", viaTag("SELECT 1 FROM public.api_keys")],
    ["a quoted relation, and a differently-cased quoted name (no such table)", viaTag('SELECT 1 FROM "api_keys" WHERE 1 = 1 UNION SELECT 1 FROM "API_KEYS"')],
    ["UPDATE ... SET", viaTag("UPDATE api_keys SET user_id = $1 WHERE id = $2")],
    ["INSERT INTO t (cols) VALUES", viaTag("INSERT INTO api_keys (id, user_id) VALUES ($1, $2)")],
    ["DELETE FROM", viaTag("DELETE FROM api_keys WHERE id = $1")],
    ["a join", viaTag("SELECT 1 FROM notes JOIN api_keys k ON k.user_id = notes.id")],
    ["a NOT EXISTS subquery", viaTag("SELECT 1 FROM notes n WHERE NOT EXISTS (SELECT 1 FROM api_keys r WHERE r.user_id = n.id)")],
    ["ON CONFLICT ... DO UPDATE", viaTag("INSERT INTO api_keys (id) VALUES ($1) ON CONFLICT (id) DO UPDATE SET user_id = $2")],
    ["FROM <substitution> WHERE ( split by a newline", viaTrusted("SELECT 1 FROM\n  ${tbl} WHERE (id = 1)")],
    ["a substituted relation's alias qualifying a declared column", viaTrusted("SELECT k.user_id FROM ${tbl} k")],
    ["a substituted qualifier naming a declared column", viaTrusted("SELECT ${parent}.id FROM ${tbl}")],
  ];
  it.each(ALLOW)("passes on %s", async (_label, options) => {
    await expectPass(options);
  });
});

describe.concurrent("raw SQL: trustedSql is recognised by import, not by spelling", { timeout: 60_000 }, () => {
  it("FAILS on a trustedSql template reached through an aliased import", async () => {
    await expectViolations({ files: { [SQL_FILE]: `import { trustedSql as ts } from "@/lib/prisma/raw-sql";\nexport function q() {\n  return ts\`SELECT * FROM notes\`;\n}\n` } }, [ruleAt("W1", W.star)]);
  });
  it("passes on a local function of that name (not the raw-sql export)", async () => {
    await expectPass({ files: { [SQL_FILE]: `const trustedSql = (s: TemplateStringsArray) => s;\nexport function q() {\n  return trustedSql\`SELECT * FROM notes\`;\n}\n` } });
  });
});

describe.concurrent("raw SQL: W3 a column alias list on a token relation", { timeout: 60_000 }, () => {
  it("FAILS on AS alias(columns) after a token table", async () => {
    await expectViolations(viaTag("SELECT 1 FROM api_keys AS k(a, b)"), [ruleAt("W3", W.aliasList("k"))]);
  });
  it("FAILS on alias(columns) after a substituted relation", async () => {
    await expectViolations(viaTrusted("SELECT 1 FROM ${tbl} k(a)"), [ruleAt("W3", W.aliasList("k"))]);
  });
  it("passes on the same alias without a column list", async () => {
    await expectPass(viaTag("SELECT 1 FROM api_keys AS k"));
  });
  it("passes on the column list after INSERT INTO <token table>", async () => {
    await expectPass(viaTag("INSERT INTO api_keys (id) VALUES ($1)"));
  });
  it("passes on a column alias list after a table that is not a token table", async () => {
    await expectPass(viaTag("SELECT 1 FROM notes AS n(a, b)"));
  });
});

describe.concurrent("raw SQL: W4 dynamic SQL and object definitions", { timeout: 60_000 }, () => {
  const DENY = [
    ["EXECUTE", viaUnsafe("EXECUTE stmt"), "EXECUTE builds SQL the lexer cannot read"],
    ["PREPARE", viaUnsafe("PREPARE p AS SELECT 1"), "PREPARE builds SQL the lexer cannot read"],
    ["a statement-initial DO", viaUnsafe("DO NOTHING"), "a DO block runs SQL the lexer cannot read"],
    ["CREATE FUNCTION", viaUnsafe("CREATE FUNCTION f() RETURNS int LANGUAGE sql AS 'select 1'"), "CREATE FUNCTION defines an object whose body the lexer cannot read"],
    ["CREATE OR REPLACE VIEW", viaUnsafe("CREATE OR REPLACE VIEW v AS SELECT 1"), "CREATE VIEW defines an object whose body the lexer cannot read"],
    ["CREATE MATERIALIZED VIEW", viaUnsafe("CREATE MATERIALIZED VIEW v AS SELECT 1"), "CREATE VIEW defines an object whose body the lexer cannot read"],
    ["CREATE PROCEDURE", viaUnsafe("CREATE PROCEDURE p() LANGUAGE sql AS 'select 1'"), "CREATE PROCEDURE defines an object whose body the lexer cannot read"],
    ["CREATE RULE", viaUnsafe("CREATE RULE r AS ON INSERT TO notes DO NOTHING"), "CREATE RULE defines an object whose body the lexer cannot read"],
    ["ALTER FUNCTION", viaUnsafe("ALTER FUNCTION f() OWNER TO x"), "ALTER FUNCTION defines an object whose body the lexer cannot read"],
    ["query_to_xml(...)", viaUnsafe("SELECT query_to_xml('select 1', true, false, '')"), "query_to_xml(...) reads whole rows or runs SQL given as a string"],
    ["table_to_xml_and_xmlschema(...)", viaUnsafe("SELECT table_to_xml_and_xmlschema('notes', true, false, '')"), "table_to_xml_and_xmlschema(...) reads whole rows or runs SQL given as a string"],
    ["dblink(...)", viaUnsafe("SELECT dblink('c', 'select 1')"), "dblink(...) reads whole rows or runs SQL given as a string"],
    ["ts_stat(...)", viaUnsafe("SELECT ts_stat('select 1')"), "ts_stat(...) runs SQL given as a string"],
  ];
  it.each(DENY)("FAILS on %s in a literal that names no token table", async (_label, options, message) => {
    await expectViolations(options, [ruleAt("W4", message)]);
  });
  it("FAILS on query_to_xml in a literal that names a token table as a relation", async () => {
    await expectViolations(viaTag("SELECT query_to_xml('select 1', true, false, '') FROM api_keys"), [ruleAt("W4", "query_to_xml(...) reads whole rows or runs SQL given as a string")]);
  });
  it("FAILS on EXECUTE in a trustedSql template", async () => {
    await expectViolations(viaTrusted("EXECUTE stmt"), [ruleAt("W4", "EXECUTE builds SQL the lexer cannot read")]);
  });
  const ALLOW = [
    ["execute inside a string", viaUnsafe("SELECT 'execute' FROM notes")],
    ["execute inside a comment", viaUnsafe("SELECT 1 -- execute")],
    ["prepare inside a string", viaUnsafe("SELECT 'prepare'")],
    ["DO inside ON CONFLICT", viaUnsafe("INSERT INTO notes (id) VALUES ($1) ON CONFLICT (id) DO NOTHING")],
    ["CREATE TABLE and ALTER TABLE", viaUnsafe("ALTER TABLE notes ADD COLUMN c int")],
    ["a query_to_xml name inside a string", viaUnsafe("SELECT 'query_to_xml'")],
    ["a column named like dblink without a call", viaUnsafe("SELECT dblinks FROM notes")],
  ];
  it.each(ALLOW)("passes on %s", async (_label, options) => {
    await expectPass(options);
  });
});

describe.concurrent("raw SQL: W5 a token table's name inside a string", { timeout: 60_000 }, () => {
  it("FAILS on a token table named in a string", async () => {
    await expectViolations(viaTag("SELECT 1 FROM notes WHERE x = 'api_keys'"), [ruleAt("W5", W.string("api_keys"))]);
  });
  it("FAILS on a name in another case", async () => {
    await expectViolations(viaTag("SELECT 1 FROM notes WHERE x = 'API_KEYS'"), [ruleAt("W5", W.string("api_keys"))]);
  });
  it("FAILS on a name inside a dollar-quoted string", async () => {
    await expectViolations(viaTag("SELECT 1 FROM notes WHERE x = $$ select 1 from api_keys $$"), [ruleAt("W5", W.string("api_keys"))]);
  });
  it("FAILS on a name inside a string in a trustedSql template", async () => {
    await expectViolations(viaTrusted("SELECT 'api_keys'"), [ruleAt("W5", W.string("api_keys"))]);
  });
  it("passes on a longer word containing the name", async () => {
    await expectPass(viaTag("SELECT 1 FROM notes WHERE x = 'api_keys_old'"));
  });
  it("passes on a similar name", async () => {
    await expectPass(viaTag("SELECT 1 FROM notes WHERE x = 'api_key'"));
  });
  it("passes on a name that is only the end of a longer word", async () => {
    await expectPass(viaTag("SELECT 1 FROM notes WHERE x = 'old_api_keys'"));
  });
});

describe.concurrent("raw SQL: W6 the syntax around a substituted table", { timeout: 60_000 }, () => {
  const DENY = [
    ["IS DISTINCT FROM <substitution>", viaTrusted("SELECT 1 WHERE a IS DISTINCT FROM ${tbl}"), W.looseFrom],
    ["trim(x FROM <substitution>)", viaTrusted("SELECT trim(a FROM ${tbl})"), W.looseFrom],
    ["extract(f FROM <substitution>)", viaTrusted("SELECT extract(epoch FROM ${tbl})"), W.looseFrom],
    ["<substitution>::text in relation position", viaTrusted("SELECT 1 FROM ${tbl}::text"), W.valueRelation],
    ["<substitution>(args) in relation position", viaTrusted("SELECT 1 FROM ${tbl}(1)"), W.valueRelation],
    ["a substituted qualifier naming a non-column", viaTrusted("SELECT ${tbl}.to_jsonb FROM ${tbl}"), W.qualifier("to_jsonb")],
    ["a quoted substituted qualifier naming a non-column", viaTrusted('SELECT "${tbl}".to_jsonb FROM ${tbl}'), W.qualifier("to_jsonb")],
    ["a substituted qualifier naming a substitution", viaTrusted("SELECT ${tbl}.${parent} FROM ${tbl}"), W.qualifier("a substitution")],
    ["a substitution assembling a name (api_${x})", viaTrusted("SELECT 1 FROM api_${tbl}"), W.adjacent],
    ["a substitution directly followed by a word character", viaTrusted("SELECT 1 FROM ${tbl}x"), W.adjacent],
  ];
  it.each(DENY)("FAILS on %s", async (_label, options, message) => {
    await expectViolations(options, [ruleAt("W6", message)]);
  });
  const ALLOW = [
    ["FROM <substitution>", viaTrusted("SELECT 1 FROM ${tbl}")],
    ["INSERT INTO <substitution> (cols)", viaTrusted("INSERT INTO ${tbl} (id) VALUES (1)")],
    ["a quoted substitution as a relation", viaTrusted('SELECT 1 FROM "${tbl}"')],
    ["a substitution next to a space or a cast", viaTrusted("SELECT 1 FROM notes WHERE id = ${t}::uuid")],
    ["a bound parameter after DISTINCT FROM in a $queryRaw template (W6 reads trustedSql only)", viaTag("SELECT 1 FROM api_keys WHERE user_id IS DISTINCT FROM ${t}")],
    ["trim(x FROM y) without a substitution", viaTrusted("SELECT trim(a FROM b)")],
    ["a substituted qualifier naming a declared column", viaTrusted("SELECT ${tbl}.id FROM ${tbl}")],
  ];
  it.each(ALLOW)("passes on %s", async (_label, options) => {
    await expectPass(options);
  });
});

describe.concurrent("TOKEN_TABLE_NAMES must equal the schema's token tables", { timeout: 60_000 }, () => {
  const RAW_SQL_REL = "src/lib/prisma/raw-sql.ts";
  const withList = (contents) => ({ files: { [RAW_SQL_REL]: contents } });
  const at = (message) => `${RAW_SQL_REL}:1  ${message}`;
  it("FAILS on a token table missing from the list", async () => {
    await expectViolations(withList(rawSqlModule(["api_keys", "extension_tokens"])), [at("TOKEN_TABLE_NAMES lacks auth_codes, a token table of the schema")]);
  });
  it("FAILS on a name that is not a token table", async () => {
    await expectViolations(withList(rawSqlModule(["api_keys", "extension_tokens", "auth_codes", "notes"])), [at("TOKEN_TABLE_NAMES lists notes, which is not a token table of the schema")]);
  });
  it("FAILS on a name swapped for another (a missing and an extra name, inherently a pair)", async () => {
    await expectViolations(withList(rawSqlModule(["api_keys", "extension_tokens", "notes"])), [
      at("TOKEN_TABLE_NAMES lacks auth_codes, a token table of the schema"),
      at("TOKEN_TABLE_NAMES lists notes, which is not a token table of the schema"),
    ]);
  });
  it("FAILS on an element that is not a string literal", async () => {
    await expectViolations(withList(`const other = "x";\nexport const TOKEN_TABLE_NAMES: readonly string[] = Object.freeze(["api_keys", "extension_tokens", "auth_codes", other]);\n`), [
      `${RAW_SQL_REL}:2  TOKEN_TABLE_NAMES element is not a string literal`,
    ]);
  });
  it("passes on the same set in another order", async () => {
    await expectPass(withList(rawSqlModule(["auth_codes", "extension_tokens", "api_keys"])));
  });
  it("passes on the module's own freeze alias and on a bare array", async () => {
    await expectPass(withList(`const freeze = Object.freeze;\nexport const TOKEN_TABLE_NAMES: readonly string[] = freeze(["api_keys", "extension_tokens", "auth_codes"]);\n`));
    await expectPass(withList(`export const TOKEN_TABLE_NAMES = ["api_keys", "extension_tokens", "auth_codes"];\n`));
  });
  it("is fatal when raw-sql does not declare the list", async () => {
    await expectFatal(withList(`export const OTHER = 1;\n`), `${RAW_SQL_REL} does not export TOKEN_TABLE_NAMES: the list sqlIdentifier refuses.`);
  });
  it("is fatal when the list is declared but not exported", async () => {
    await expectFatal(withList(`const TOKEN_TABLE_NAMES = ["api_keys", "extension_tokens", "auth_codes"];\n`), `${RAW_SQL_REL} does not export TOKEN_TABLE_NAMES: the list sqlIdentifier refuses.`);
  });
  it("is fatal when the list is not an array literal", async () => {
    await expectFatal(withList(`export const TOKEN_TABLE_NAMES = build();\n`), `${RAW_SQL_REL}: TOKEN_TABLE_NAMES is not an array literal of string literals (optionally frozen).`);
  });
  it("is fatal when raw-sql is missing", async () => {
    await expectFatal({ files: { [RAW_SQL_REL]: null } }, `${RAW_SQL_REL} does not export TOKEN_TABLE_NAMES: the list sqlIdentifier refuses.`);
  });
});

// ─── SQL files (C4) ──────────────────────────────────────────────────────────────────────────

describe.concurrent("database objects defined in SQL files (A-10)", { timeout: 60_000 }, () => {
  const MIG = "prisma/migrations/20240201000000_extra/migration.sql";
  const withSql = (sql, path = MIG) => ({ files: { [path]: sql } });
  const listedSql = (sql, path = MIG) => ({ ...withSql(sql, path), sqlObjects: { [path]: { reason: REASON } } });
  const unlistedLine = (whys, path = MIG) =>
    `SQL_OBJECT_UNLISTED: ${path} — ${whys.map(([line, why]) => `line ${line}: ${why}`).join("; ")}. List it in "sqlObjects" in ${MANIFEST} with a reason.`;
  const PLAIN = "statement naming a digest column that is not a plain definition, index, drop or seed";

  const DENY = [
    ["a function naming a token table", "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT count(*) FROM api_keys $$;", [[1, "CREATE FUNCTION naming a token table or a digest column"]]],
    ["a function with a single-quoted body naming a token table", "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS 'SELECT count(*) FROM api_keys';", [[1, "CREATE FUNCTION naming a token table or a digest column"]]],
    ["a function with a non-ASCII dollar tag", "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $é$ SELECT count(*) FROM api_keys $é$;", [[1, "CREATE FUNCTION naming a token table or a digest column"]]],
    ["a procedure naming a token table", "CREATE PROCEDURE p() LANGUAGE sql AS $$ DELETE FROM api_keys $$;", [[1, "CREATE PROCEDURE naming a token table or a digest column"]]],
    ["a view naming a token table", "CREATE VIEW v AS SELECT id FROM api_keys;", [[1, "CREATE VIEW naming a token table or a digest column"]]],
    ["a materialized view naming a token table", "CREATE MATERIALIZED VIEW v AS SELECT id FROM api_keys;", [[1, "CREATE VIEW naming a token table or a digest column"]]],
    ["a trigger on a token table", "CREATE TRIGGER trg BEFORE INSERT ON api_keys FOR EACH ROW EXECUTE FUNCTION f();", [[1, "CREATE TRIGGER naming a token table or a digest column"]]],
    ["a rule on a token table", "CREATE RULE r AS ON INSERT TO api_keys DO NOTHING;", [[1, "CREATE RULE naming a token table or a digest column"]]],
    ["a routine body holding EXECUTE", "CREATE FUNCTION g() RETURNS void LANGUAGE plpgsql AS $$ BEGIN EXECUTE 'select 1'; END $$;", [[1, "CREATE FUNCTION whose body holds EXECUTE"]]],
    ["a DO block creating a view that names a token table", "DO $$ BEGIN EXECUTE 'CREATE VIEW v AS SELECT id FROM api_keys'; END $$;", [[1, "DO block creating a database object and naming a token table or a digest column"], [1, "DO block executing a CREATE or ALTER of a database object"]]],
    ["a copy (CREATE TABLE AS)", "CREATE TABLE copy AS SELECT token_hash FROM notes;", [[1, PLAIN + " (CREATE)"]]],
    ["a copy (INSERT ... SELECT)", "INSERT INTO t SELECT token_hash FROM notes;", [[1, PLAIN + " (INSERT)"]]],
    ["a copy (SELECT INTO)", "SELECT token_hash INTO tmp FROM notes;", [[1, PLAIN + " (SELECT)"]]],
    ["a rename", "ALTER TABLE notes RENAME COLUMN token_hash TO h;", [[1, PLAIN + " (ALTER)"]]],
    ["a generated column", "ALTER TABLE notes ADD COLUMN h text GENERATED ALWAYS AS (token_hash) STORED;", [[1, PLAIN + " (ALTER)"]]],
    ["a foreign key to a digest column", "ALTER TABLE notes ADD CONSTRAINT fk FOREIGN KEY (a) REFERENCES t (token_hash);", [[1, PLAIN + " (ALTER)"]]],
    ["a policy", "CREATE POLICY p ON notes USING (token_hash IS NOT NULL);", [[1, PLAIN + " (CREATE)"]]],
    ["an UPDATE", "UPDATE notes SET token_hash = 'x';", [[1, PLAIN + " (UPDATE)"]]],
    ["a seed that upserts over a digest column", "INSERT INTO notes (id, token_hash) VALUES ('a', 'b') ON CONFLICT (id) DO UPDATE SET token_hash = 'c';", [[1, PLAIN + " (INSERT)"]]],
    ["a statement after the first", "SELECT 1;\nUPDATE notes SET token_hash = 'x';", [[2, PLAIN + " (UPDATE)"]]],
    ["an unterminated dollar quote", "SELECT $q$ x;", [[1, "unterminated dollar quote: the file cannot be read"]]],
  ];
  it.each(DENY)("FAILS on %s with no entry", async (_label, sql, whys) => {
    await expectViolations(withSql(sql), [unlistedLine(whys)]);
  });
  it.each(DENY)("passes on %s once listed", async (_label, sql) => {
    await expectPass(listedSql(sql));
  });

  const PLAIN_FORMS = [
    ["CREATE TABLE naming a digest column", "CREATE TABLE t2 (id text, token_hash text NOT NULL);"],
    ["ADD COLUMN without GENERATED", "ALTER TABLE notes ADD COLUMN token_hash text;"],
    ["ADD CONSTRAINT and DROP CONSTRAINT", "ALTER TABLE notes ADD CONSTRAINT u UNIQUE (token_hash), DROP CONSTRAINT old;"],
    ["DROP COLUMN", "ALTER TABLE notes DROP COLUMN token_hash;"],
    ["CREATE INDEX", "CREATE UNIQUE INDEX i ON notes (token_hash);"],
    ["DROP INDEX", "DROP INDEX i, token_hash;"],
    ["an INSERT ... VALUES seed", "INSERT INTO notes (id, token_hash) VALUES ('a', 'b');"],
    ["a REFERENCES clause that names no digest column", "ALTER TABLE notes ADD COLUMN token_hash text, ADD CONSTRAINT fk FOREIGN KEY (a) REFERENCES t (id);"],
    ["a routine on a table that is not a token table", "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT count(*) FROM notes $$;"],
    ["a trigger with EXECUTE FUNCTION only", "CREATE TRIGGER trg BEFORE INSERT ON notes FOR EACH ROW EXECUTE FUNCTION f();"],
    ["a DO block that creates nothing that names a token table", "DO $$ BEGIN CREATE VIEW v AS SELECT 1; END $$;"],
    ["a DO block that executes without creating", "DO $$ BEGIN EXECUTE 'SELECT 1'; END $$;"],
    ["a token table named only in a comment", "-- api_keys token_hash\nSELECT 1;"],
  ];
  it.each(PLAIN_FORMS)("passes on %s, with no entry", async (_label, sql) => {
    await expectPass(withSql(sql));
  });

  it("FAILS on a stale entry (a listed file that needs none)", async () => {
    await expectViolations({ sqlObjects: { [MIGRATION]: { reason: REASON } } }, [`STALE_SQL_OBJECT: ${MIGRATION} is in "sqlObjects" but no statement in it (or no such file) needs an entry.`]);
  });
  it("FAILS on an entry with a short reason", async () => {
    await expectViolations({ ...withSql("CREATE VIEW v AS SELECT id FROM api_keys;"), sqlObjects: { [MIG]: { reason: "short" } } }, [`BAD_ENTRY: "sqlObjects" entry ${MIG} needs a reason of at least 20 characters.`]);
  });

  const OTHER_ROOTS = ["infra/postgres/initdb/01-extra.sql", "scripts/extra.sql"];
  it.each(OTHER_ROOTS)("FAILS on a qualifying statement in %s with no entry", async (path) => {
    await expectViolations(withSql("CREATE VIEW v AS SELECT id FROM api_keys;", path), [unlistedLine([[1, "CREATE VIEW naming a token table or a digest column"]], path)]);
  });
  it.each(OTHER_ROOTS)("passes on %s once listed", async (path) => {
    await expectPass(listedSql("CREATE VIEW v AS SELECT id FROM api_keys;", path));
  });
  it("does not read SQL outside the three roots", async () => {
    await expectPass(withSql("CREATE VIEW v AS SELECT id FROM api_keys;", "docs/extra.sql"));
  });

  it("is fatal when there is no migration to read", async () => {
    await expectFatal({ files: { [MIGRATION]: null } }, (root) => `no prisma/migrations/<name>/migration.sql under ${root}: no SQL file was read, so no database object could be classified.`);
  });
  it("counts the SQL files and the qualifying ones in the summary line", async () => {
    const { exitCode, out } = await run({ files: { ...listedSql("CREATE VIEW v AS SELECT id FROM api_keys;").files, ...viaTag("SELECT count(*) FROM api_keys").files }, sqlObjects: { [MIG]: { reason: REASON } } });
    expect(exitCode, out).toBe(0);
    expect(out).toContain("sql-literals=1 token-table-literals=1 sql-files=2 sql-qualifying=1");
  });
  it("counts nothing on the base fixture", async () => {
    const { out } = await run();
    expect(out).toContain("sql-literals=0 token-table-literals=0 sql-files=1 sql-qualifying=0");
  });
});

describe.concurrent("schema checks (A-10)", { timeout: 60_000 }, () => {
  const SCHEMA_PREFIX = "prisma/schema.prisma:";
  const schema = (from, to) => ({ files: { "prisma/schema.prisma": swap(SCHEMA, from, to) } });
  const addToNote = (line) => schema('model Note {\n  id    String @id\n  title String\n', `model Note {\n  id    String @id\n  title String\n  ${line}\n`);
  const DIGEST_SET = "token_hash/code_hash/replaced_by_hash";

  it("is fatal when a digest-key field maps to another column", async () => {
    await expectFatal(schema(`tokenHash String @unique @map("token_hash")\n  userId    String @map("user_id")`, `tokenHash String @unique\n  userId    String @map("user_id")`), `${SCHEMA_PREFIX} ApiKey.tokenHash maps to column "tokenHash", which is not a digest column (${DIGEST_SET}): map it, or the gate's digest-column set is out of date.`);
  });
  it("passes when it maps to its column", async () => {
    await expectPass();
  });
  it("is fatal when another field is mapped to a digest column", async () => {
    await expectFatal(addToNote('legacy String? @map("token_hash")'), `${SCHEMA_PREFIX} Note.legacy is mapped to digest column "token_hash" but is not named tokenHash/codeHash/replacedByHash: a lookup by it would not be recognised.`);
  });
  it("is fatal when no field maps to a digest column", async () => {
    await expectFatal(schema('  replacedByHash String? @map("replaced_by_hash")\n', ""), `${SCHEMA_PREFIX} no digest-key field maps to column "replaced_by_hash": the digest-column set and the schema disagree.`);
  });
  it("is fatal on a view block", async () => {
    await expectFatal({ files: { "prisma/schema.prisma": `${SCHEMA}\nview Summary {\n  id String @id\n}\n` } }, `${SCHEMA_PREFIX} view Summary: a database view can project a digest column without naming it in a query.`);
  });
  it("is fatal on a relation that references a digest key", async () => {
    await expectFatal(addToNote("link ApiKey @relation(fields: [title], references: [tokenHash])"), `${SCHEMA_PREFIX} Note.link references tokenHash: a foreign key gives another column the digest's values.`);
  });
  it("passes on a relation that references an id", async () => {
    await expectPass(addToNote("link ApiKey @relation(fields: [title], references: [id])"));
  });

  const UNIQUE_HASH = "is a unique String ending in hash/digest but is not a digest key (tokenHash/codeHash/replacedByHash): name it one, or list";
  const listing = (key) => `${SCHEMA_PREFIX} ${key} ${UNIQUE_HASH} "${key}" in the manifest's "nonBearerHashFields" with a reason.`;
  it("is fatal on a unique String field ending in hash", async () => {
    await expectFatal(addToNote("contentHash String @unique"), listing("Note.contentHash"));
  });
  it("is fatal on a unique String field whose column ends in hash", async () => {
    await expectFatal(addToNote('fp String @unique @map("fp_hash")'), listing("Note.fp"));
  });
  it("is fatal on a unique String field whose name ends in hash but whose column does not", async () => {
    await expectFatal(addToNote('contentHash String @unique @map("content")'), listing("Note.contentHash"));
  });
  it("is fatal on a @@unique member ending in digest", async () => {
    await expectFatal(addToNote("bodyDigest String\n  @@unique([bodyDigest])"), listing("Note.bodyDigest"));
  });
  it("passes on a field that is not unique", async () => {
    await expectPass(addToNote("contentHash String"));
  });
  it("passes on a unique field that is not a String", async () => {
    await expectPass(addToNote("contentHash Int @unique"));
  });
  it("passes on a unique String that does not end in hash or digest", async () => {
    await expectPass(addToNote("slug String @unique"));
  });
  it("passes on a listed field", async () => {
    await expectPass({ ...addToNote("contentHash String @unique"), nonBearerHashFields: { "Note.contentHash": { reason: REASON } } });
  });
  it("FAILS on a listed field that no longer exists (stale)", async () => {
    await expectViolations({ nonBearerHashFields: { "Note.contentHash": { reason: REASON } } }, [`STALE_NON_BEARER_HASH: "Note.contentHash" is in "nonBearerHashFields" but names no unique non-digest String field ending in hash or digest.`]);
  });
  it("FAILS on a listed field with a short reason", async () => {
    await expectViolations({ ...addToNote("contentHash String @unique"), nonBearerHashFields: { "Note.contentHash": { reason: "short" } } }, [`BAD_ENTRY: "nonBearerHashFields" entry Note.contentHash needs a reason of at least 20 characters.`]);
  });
});

describe.concurrent("manifest sections", { timeout: 60_000 }, () => {
  const BASE_BODY = { functions: BASE_MANIFEST, models: BASE_MODELS };
  it.each(["sqlObjects", "pgPools", "nonBearerHashFields"])("is fatal when %s is not an object", async (section) => {
    await expectFatal({ rawManifest: JSON.stringify({ ...BASE_BODY, [section]: [] }) }, (root) => `manifest at ${root}/${MANIFEST} has a "${section}" that is not an object.`);
  });
  it("passes when the three sections are absent (each is empty)", async () => {
    await expectPass({ rawManifest: JSON.stringify(BASE_BODY) });
  });
  it("FAILS when a section is absent but the code needs an entry", async () => {
    await expectViolations(
      { rawManifest: JSON.stringify(BASE_BODY), files: { "src/lib/pg.ts": `import { createPool } from "@/lib/db/pool-factory";\nexport const pool = createPool();\n` } },
      [`PG_POOL_UNLISTED: src/lib/pg.ts imports createPool / createClient from pool-factory — list it in "pgPools" in ${MANIFEST} with a reason.`],
    );
  });
});

// ─── The pg driver (C5) ──────────────────────────────────────────────────────────────────────

describe.concurrent("the pg driver's query and pool factory (A-11)", { timeout: 60_000 }, () => {
  const PG = "src/lib/pg.ts";
  const POOL_IMPORT = `import { createPool } from "@/lib/db/pool-factory";`;
  const queryMessage = "C5: `.query(...)` must take a string literal (or a no-substitution template) as its SQL argument: its text cannot be read";
  const referenceMessage = "C5: a reference to `query` other than a direct call with a literal SQL argument (a value, .call / .apply / .bind, a destructuring): the pool's SQL cannot be read";
  const listedPg = (contents) => ({ files: { [PG]: contents }, pgPools: { [PG]: { reason: REASON } } });
  /** A file that imports the pool factory (so it is listed) whose function body, on line 3, is `stmt`. */
  const importer = (stmt) => listedPg(`${POOL_IMPORT}\nexport function run(pool: any, sql: string) {\n  ${stmt}\n}\n`);
  const plain = (stmt) => ({ files: { [SQL_FILE]: `export function run(pool: any, sql: string) {\n  ${stmt}\n}\n` } });

  const CALLEES = [
    ["a property access", (arg) => `return pool.query(${arg});`],
    ["an optional chain", (arg) => `return pool?.query(${arg});`],
    ["an element access with a pinned key", (arg) => `return pool["query"](${arg});`],
  ];
  const ARGS = [
    ["a variable", "sql", false],
    ["a template with a substitution", "`SELECT ${sql}`", false],
    ["no argument", "", false],
    ["a string literal", '"SELECT 1"', true],
    ["a no-substitution template", "`SELECT 1`", true],
  ];
  const cases = CALLEES.flatMap(([callee, call]) => ARGS.map(([arg, text, ok]) => [`${callee} with ${arg}`, call(text), ok]));
  it.each(cases)("%s", async (_label, stmt, ok) => {
    if (ok) await expectPass(plain(stmt));
    else await expectViolations(plain(stmt), [`${SQL_FILE}:2  ${queryMessage}`]);
  });
  it("reads the literal argument as SQL (a * on a token table)", async () => {
    await expectViolations(plain('return pool.query("SELECT * FROM api_keys");'), [`${SQL_FILE}:2  W1: ${W.star}`]);
  });
  it("passes on the same literal naming count(*)", async () => {
    await expectPass(plain('return pool.query("SELECT count(*) FROM api_keys");'));
  });

  it("FAILS on an importer with no pgPools entry", async () => {
    await expectViolations({ files: { [PG]: `${POOL_IMPORT}\nexport const pool = createPool();\n` } }, [`PG_POOL_UNLISTED: ${PG} imports createPool / createClient from pool-factory — list it in "pgPools" in ${MANIFEST} with a reason.`]);
  });
  it("passes once the importer is listed", async () => {
    await expectPass(listedPg(`${POOL_IMPORT}\nexport const pool = createPool();\n`));
  });
  it("treats createClient as a pool too", async () => {
    await expectViolations({ files: { [PG]: `import { createClient as mk } from "@/lib/db/pool-factory";\nexport const pool = mk();\n` } }, [`PG_POOL_UNLISTED: ${PG} imports createPool / createClient from pool-factory — list it in "pgPools" in ${MANIFEST} with a reason.`]);
  });
  it("is not an importer by a type-only import", async () => {
    await expectPass({ files: { [PG]: `import type { createPool } from "@/lib/db/pool-factory";\nexport type P = typeof createPool;\n` } });
  });
  it("FAILS on a stale entry (a listed file that does not import the factory)", async () => {
    await expectViolations({ files: { [PG]: "export const x = 1;\n" }, pgPools: { [PG]: { reason: REASON } } }, [`STALE_PG_POOL: ${PG} is in "pgPools" but imports neither createPool nor createClient from pool-factory.`]);
  });
  it("FAILS on an entry with a short reason", async () => {
    await expectViolations({ files: { [PG]: `${POOL_IMPORT}\nexport const pool = createPool();\n` }, pgPools: { [PG]: { reason: "short" } } }, [`BAD_ENTRY: "pgPools" entry ${PG} needs a reason of at least 20 characters.`]);
  });
  it("passes on a fixture with no pool-factory and no entry", async () => {
    await expectPass({ files: { [POOL_FACTORY_FILE]: null } });
  });
  it("FAILS on an entry in a fixture with no pool-factory (stale)", async () => {
    await expectViolations({ files: { [POOL_FACTORY_FILE]: null, [PG]: "export const x = 1;\n" }, pgPools: { [PG]: { reason: REASON } } }, [`STALE_PG_POOL: ${PG} is in "pgPools" but imports neither createPool nor createClient from pool-factory.`]);
  });

  const REFERENCES = [
    ["a value", "return pool.query;"],
    ["a .call", 'return pool.query.call(pool, "SELECT 1");'],
    ["an .apply", 'return pool.query.apply(pool, ["SELECT 1"]);'],
    ["a .bind", "return pool.query.bind(pool);"],
    ["a destructuring", "const { query } = pool;\n  return query;"],
    ["an element access value", 'return pool["query"];'],
  ];
  it.each(REFERENCES)("FAILS on %s of query in an importer", async (_label, stmt) => {
    await expectViolations(importer(stmt), [`${PG}:3  ${referenceMessage}`]);
  });
  it.each(REFERENCES)("passes on %s of query outside an importer", async (_label, stmt) => {
    await expectPass(plain(stmt));
  });
  it("passes on a direct call with a literal in an importer", async () => {
    await expectPass(importer('return pool.query("SELECT 1");'));
  });
  it("FAILS on a value reference to query inside pool-factory itself", async () => {
    await expectViolations({ files: { [POOL_FACTORY_FILE]: `${POOL_FACTORY}export function leak(p: any) {\n  return p.query;\n}\n` } }, [`${POOL_FACTORY_FILE}:8  ${referenceMessage}`]);
  });
  it("passes on a direct literal call inside pool-factory", async () => {
    await expectPass({ files: { [POOL_FACTORY_FILE]: `${POOL_FACTORY}export function ping(p: any) {\n  return p.query("SELECT 1");\n}\n` } });
  });

  const LOADS = [
    ["a namespace import", 'import * as pf from "@/lib/db/pool-factory";\nexport const x = pf;\n', 1, "namespace import of pool-factory: its pools cannot be followed"],
    ["a default import", 'import pf from "@/lib/db/pool-factory";\nexport const x = pf;\n', 1, "default import of pool-factory: its pools cannot be followed"],
    ["a named re-export", 'export { createPool } from "@/lib/db/pool-factory";\n', 1, "re-export of pool-factory: its pools cannot be followed"],
    ["an export *", 'export * from "@/lib/db/pool-factory";\n', 1, "re-export of pool-factory: its pools cannot be followed"],
    ["a dynamic import", 'export function f() {\n  return import("@/lib/db/pool-factory");\n}\n', 2, "dynamic import/require of pool-factory: its pools cannot be followed"],
    ["a require", 'export function f() {\n  return require("@/lib/db/pool-factory");\n}\n', 2, "dynamic import/require of pool-factory: its pools cannot be followed"],
    ["an import-equals", 'import pf = require("@/lib/db/pool-factory");\nexport const x = pf;\n', 1, "import-equals of pool-factory: its pools cannot be followed"],
    ["a relative specifier", 'import * as pf from "./db/pool-factory";\nexport const x = pf;\n', 1, "namespace import of pool-factory: its pools cannot be followed"],
  ];
  it.each(LOADS)("FAILS on %s", async (_label, contents, line, message) => {
    await expectViolations({ files: { [PG]: contents } }, [`${PG}:${line}  C5: ${message}`]);
  });
  it("passes on a dynamic import of a package, and on a named import listed as a pool", async () => {
    await expectPass({ files: { [PG]: 'export function f() {\n  return import("node:fs");\n}\n' } });
    await expectPass(listedPg(`import { createPool } from "./db/pool-factory";\nexport const pool = createPool();\n`));
  });
});


// More shapes for the clauses above: one cell per arm of the relation-position reading, so each
// arm has something to turn red.
describe.concurrent("raw SQL: relation position, alias and qualifier arms", { timeout: 60_000 }, () => {
  const DENY = [
    ["FOR UPDATE <token table> (a lock clause, no relation)", viaTag("SELECT 1 FROM notes FOR UPDATE api_keys"), 3, "W2", W.table("api_keys")],
    ["a qualifier naming a column of another model", viaTag("SELECT api_keys.title FROM api_keys"), 3, "W2", W.table("api_keys")],
    ["an alias qualifying a column of another model", viaTag("SELECT k.title FROM api_keys k"), 3, "W2", W.alias("k")],
    ["a quoted alias in a value position", viaTag('SELECT to_jsonb("k") FROM api_keys "k"'), 3, "W2", W.alias('"k"')],
    ["max(*) (only count(*) is exempt)", viaTag("SELECT max(*) FROM api_keys"), 3, "W1", W.star],
    ["a * on the second line of a literal", viaTag("SELECT\n  * FROM api_keys"), 4, "W1", W.star],
    ["a * qualified by a substitution", viaTrusted("SELECT ${tbl}.* FROM ${tbl}"), 3, "W1", W.star],
    ["<substitution>[1] in relation position", viaTrusted("SELECT 1 FROM ${tbl}[1]"), 3, "W6", W.valueRelation],
    ["a substitution directly followed by a digit", viaTrusted("SELECT 1 FROM ${tbl}1"), 3, "W6", W.adjacent],
    ["a substitution directly after a dollar sign", viaTrusted("SELECT 1 FROM x$${tbl}"), 3, "W6", W.adjacent],
    ["a substitution assembling a name on the second line", viaTrusted("SELECT 1\n  FROM api_${tbl}"), 4, "W6", W.adjacent],
  ];
  it.each(DENY)("FAILS on %s", async (_label, options, line, rule, message) => {
    await expectViolations(options, [ruleAt(rule, message, line)]);
  });
  const ALLOW = [
    ["FROM ONLY <token table>", viaTag("SELECT 1 FROM ONLY api_keys")],
    ["a relation ended by a semicolon", viaTag("SELECT 1 FROM api_keys;")],
    ["a relation ended by a closing parenthesis", viaTag("SELECT 1 FROM notes WHERE id IN (SELECT 1 FROM api_keys)")],
    ["a relation followed by a comma", viaTag("SELECT 1 FROM api_keys, notes")],
    ["a quoted alias qualifying a declared column", viaTag('SELECT "k".user_id FROM api_keys "k"')],
    ["a member named like the alias (after a dot)", viaTag("SELECT 1 FROM api_keys k WHERE notes.k = 1")],
    ["a bound-parameter relation in a $queryRaw template (not a token relation)", viaTag("SELECT to_jsonb(k) FROM ${tbl} k")],
    ["a bound-parameter relation next to a token table (not a token relation)", viaTag("SELECT to_jsonb(k) FROM api_keys a JOIN ${tbl} k ON true")],
    ["the alias of a table that is not a token table, next to a token table", viaTag("SELECT to_jsonb(n) FROM notes n JOIN api_keys k ON k.user_id = n.id")],
  ];
  it.each(ALLOW)("passes on %s", async (_label, options) => {
    await expectPass(options);
  });
});

describe.concurrent("database objects defined in SQL files (more shapes)", { timeout: 60_000 }, () => {
  const MIG = "prisma/migrations/20240201000000_extra/migration.sql";
  const withSql = (sql) => ({ files: { [MIG]: sql } });
  const unlistedLine = (whys) => `SQL_OBJECT_UNLISTED: ${MIG} — ${whys.map(([line, why]) => `line ${line}: ${why}`).join("; ")}. List it in "sqlObjects" in ${MANIFEST} with a reason.`;
  const PLAIN = (first) => `statement naming a digest column that is not a plain definition, index, drop or seed (${first})`;
  const nested = (levels) => {
    let sql = "SELECT 1";
    for (let k = 0; k < levels; k++) sql = `SELECT '${sql.replaceAll("'", "''")}'`;
    return `${sql};`;
  };

  it("FAILS on CREATE OR REPLACE FUNCTION naming a token table", async () => {
    await expectViolations(withSql("CREATE OR REPLACE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT count(*) FROM api_keys $$;"), [unlistedLine([[1, "CREATE FUNCTION naming a token table or a digest column"]])]);
  });
  it("FAILS on a function naming only a digest column, as the object and as the non-plain statement (a pair)", async () => {
    await expectViolations(withSql("CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT token_hash FROM notes $$;"), [
      unlistedLine([[1, "CREATE FUNCTION naming a token table or a digest column"], [1, PLAIN("CREATE")]]),
    ]);
  });
  it("FAILS on an INSERT with no VALUES and no SELECT (a table copy)", async () => {
    await expectViolations(withSql("INSERT INTO notes (id, token_hash) TABLE other;"), [unlistedLine([[1, PLAIN("INSERT")]])]);
  });
  it("FAILS on a function whose dollar-quoted body holds an empty string before a token table", async () => {
    await expectViolations(withSql("CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT '' AS e FROM api_keys $$;"), [unlistedLine([[1, "CREATE FUNCTION naming a token table or a digest column"]])]);
  });
  it("FAILS on an INSERT ... VALUES whose value is a SELECT of a digest column", async () => {
    await expectViolations(withSql("INSERT INTO notes (id) VALUES ((SELECT token_hash FROM notes LIMIT 1));"), [unlistedLine([[1, PLAIN("INSERT")]])]);
  });
  it("FAILS on an ALTER TABLE whose second action is not plain", async () => {
    await expectViolations(withSql("ALTER TABLE notes ADD COLUMN token_hash text, ALTER COLUMN id SET NOT NULL;"), [unlistedLine([[1, PLAIN("ALTER")]])]);
  });
  it("FAILS on strings nested one level past the limit", async () => {
    await expectViolations(withSql(nested(9)), [unlistedLine([[1, "strings nested more than 8 deep, which this scan does not read"]])]);
  });
  it("passes on strings nested up to the limit", async () => {
    await expectPass(withSql(nested(8)));
  });
  const ALLOW = [
    ["a DO block naming a token table without creating an object", "DO $$ BEGIN DELETE FROM api_keys; END $$;"],
    ["ALTER TABLE ONLY", "ALTER TABLE ONLY notes ADD COLUMN token_hash text;"],
    ["ALTER TABLE IF EXISTS", "ALTER TABLE IF EXISTS notes ADD COLUMN token_hash text;"],
    ["a schema-qualified ALTER TABLE", "ALTER TABLE public.notes ADD COLUMN token_hash text;"],
    ["a generated column that reads no digest column (ADD COLUMN)", "ALTER TABLE notes ADD COLUMN token_hash text, ADD COLUMN n int GENERATED ALWAYS AS (1 + 1) STORED;"],
    ["a generated column that reads no digest column (CREATE TABLE)", "CREATE TABLE t3 (token_hash text, n int GENERATED ALWAYS AS (1 + 1) STORED);"],
  ];
  it.each(ALLOW)("passes on %s, with no entry", async (_label, sql) => {
    await expectPass(withSql(sql));
  });
});

describe.concurrent("the pg pool factory (more shapes)", { timeout: 60_000 }, () => {
  it("is not an importer when it imports something other than createPool / createClient", async () => {
    await expectPass({ files: { "src/lib/pg.ts": `import { somethingElse } from "@/lib/db/pool-factory";\nexport const x = somethingElse;\n` } });
  });
});


// ─── Self-check fixes ────────────────────────────────────────────────────────────────────────
// The sentinel, quoted function names, tight dollar bodies, and one cell per member of every
// keyword set the gate reads (so removing a single member turns a cell red).

describe.concurrent("raw SQL: the substitution marker U+E000 in a literal", { timeout: 60_000 }, () => {
  const SENTINEL = "SQL_SENTINEL: the literal holds U+E000, the lexer's substitution marker: a quoted identifier holding it could not be told from a substitution";
  const withAlias = (alias) => `SELECT "${alias}".user_id FROM api_keys AS "${alias}"`;
  it("FAILS on U+E000 inside a quoted alias in an Unsafe literal (it would hide the alias from W2)", async () => {
    await expectViolations(viaUnsafe(withAlias("k")), [`${SQL_FILE}:3  ${SENTINEL}`]);
  });
  it("passes on the same statement with an ordinary alias", async () => {
    await expectPass(viaUnsafe(withAlias("kk")));
  });
  it("still refuses the whole-row use of an ordinary alias (W2), which the marker would hide", async () => {
    await expectViolations(viaUnsafe('SELECT to_jsonb("kk") FROM api_keys AS "kk"'), [ruleAt("W2", W.alias('"kk"'))]);
  });
  it("FAILS on U+E000 in a $queryRaw template", async () => {
    await expectViolations(viaTag(withAlias("k")), [`${SQL_FILE}:3  ${SENTINEL}`]);
  });
  it("FAILS on U+E000 in a trustedSql template", async () => {
    await expectViolations(viaTrusted(withAlias("k")), [`${SQL_FILE}:3  ${SENTINEL}`]);
  });
  it("FAILS on U+E000 in a SQL file", async () => {
    const MIG = "prisma/migrations/20240201000000_extra/migration.sql";
    await expectViolations({ files: { [MIG]: "SELECT 1;\n-- \n" } }, [
      `SQL_OBJECT_UNLISTED: ${MIG} — line 2: holds U+E000, the lexer's substitution marker: the file cannot be read. List it in "sqlObjects" in ${MANIFEST} with a reason.`,
    ]);
  });
  it("passes on the same SQL file without it", async () => {
    await expectPass({ files: { "prisma/migrations/20240201000000_extra/migration.sql": "SELECT 1;\n-- \n" } });
  });
});

describe.concurrent("raw SQL: a quoted function name is the same function (W4, W1)", { timeout: 60_000 }, () => {
  const MESSAGE = (name) => (name === "ts_stat" ? "ts_stat(...) runs SQL given as a string" : `${name}(...) reads whole rows or runs SQL given as a string`);
  const DENY = [
    ['a quoted "ts_stat"', 'SELECT "ts_stat"(1) FROM api_keys', "ts_stat"],
    ['a quoted "query_to_xml"', `SELECT "query_to_xml"($$select 1$$, true, true, '') FROM api_keys`, "query_to_xml"],
    ['a schema-qualified quoted "query_to_xml"', `SELECT pg_catalog."query_to_xml"($$select 1$$, true, true, '') FROM api_keys`, "query_to_xml"],
    ['an unquoted upper-case QUERY_TO_XML', "SELECT QUERY_TO_XML('select 1', true, true, '') FROM api_keys", "query_to_xml"],
  ];
  it.each(DENY)("FAILS on %s", async (_label, sql, name) => {
    await expectViolations(viaUnsafe(sql), [ruleAt("W4", MESSAGE(name))]);
  });
  const ALLOW = [
    ['a quoted upper-case "QUERY_TO_XML" (a different, absent function)', `SELECT "QUERY_TO_XML"('select 1', true, true, '') FROM api_keys`],
    ['a quoted "ts_stat" that is no call', 'SELECT "ts_stat" FROM api_keys'],
  ];
  it.each(ALLOW)("passes on %s", async (_label, sql) => {
    await expectPass(viaUnsafe(sql));
  });
  it('treats a quoted "count"(*) as count(*) (W1)', async () => {
    await expectPass(viaUnsafe('SELECT "count"(*) FROM api_keys'));
  });
  it('still refuses a quoted "max"(*) (W1)', async () => {
    await expectViolations(viaUnsafe('SELECT "max"(*) FROM api_keys'), [ruleAt("W1", W.star)]);
  });
});

describe.concurrent("raw SQL: W4 function calls, every name the pattern admits", { timeout: 60_000 }, () => {
  const NAMES = [
    "query_to_xml", "query_to_xml_and_xmlschema", "query_to_xmlschema",
    "table_to_xml", "table_to_xml_and_xmlschema", "table_to_xmlschema",
    "cursor_to_xml", "cursor_to_xmlschema",
    "schema_to_xml", "schema_to_xml_and_xmlschema", "schema_to_xmlschema",
    "database_to_xml", "database_to_xml_and_xmlschema", "database_to_xmlschema",
    "dblink", "dblink_exec", "dblink_connect",
  ];
  it.each(NAMES)("FAILS on %s(...)", async (name) => {
    await expectViolations(viaUnsafe(`SELECT ${name}('a')`), [ruleAt("W4", `${name}(...) reads whole rows or runs SQL given as a string`)]);
  });
  it.each(NAMES)("passes on %s inside a string", async (name) => {
    await expectPass(viaUnsafe(`SELECT '${name}'`));
  });
});

describe.concurrent("raw SQL: relation FROM exclusions and the UPDATE-after-X words (W6, W2)", { timeout: 60_000 }, () => {
  const LOOSE = [
    ["substring(x FROM <substitution>)", "SELECT substring(a FROM ${tbl})"],
    ["overlay(x PLACING y FROM <substitution>)", "SELECT overlay(a PLACING b FROM ${tbl})"],
    ["trim(x FROM <substitution>)", "SELECT trim(a FROM ${tbl})"],
    ["extract(f FROM <substitution>)", "SELECT extract(epoch FROM ${tbl})"],
    ["IS DISTINCT FROM <substitution>", "SELECT 1 WHERE a IS DISTINCT FROM ${tbl}"],
  ];
  it.each(LOOSE)("FAILS on %s", async (_label, sql) => {
    await expectViolations(viaTrusted(sql), [ruleAt("W6", W.looseFrom)]);
  });
  it.each(["FOR", "ON", "DO", "KEY", "OF", "OR", "AFTER", "BEFORE"])("treats UPDATE after %s as no relation keyword", async (word) => {
    await expectViolations(viaTag(`SELECT 1 FROM notes ${word} UPDATE api_keys`), [ruleAt("W2", W.table("api_keys"))]);
  });
  it("treats UPDATE after another word as a relation keyword", async () => {
    await expectPass(viaTag("WITH x AS (SELECT 1) UPDATE api_keys SET user_id = $1"));
  });
});

describe.concurrent("raw SQL: every word of the relation follow-set", { timeout: 60_000 }, () => {
  const FOLLOW = [
    "WHERE", "SET", "ON", "USING", "VALUES", "RETURNING", "SELECT", "DEFAULT", "OVERRIDING",
    "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "NATURAL", "LATERAL", "OUTER",
    "UNION", "INTERSECT", "EXCEPT", "GROUP", "ORDER", "HAVING", "LIMIT", "OFFSET", "FETCH",
    "FOR", "WINDOW", "WITH", "TABLESAMPLE",
  ];
  // A follow word is no alias, so its second occurrence is not a use of an alias of the token relation.
  it.each(FOLLOW)("%s after a token relation is no alias", async (word) => {
    await expectPass(viaTag(`SELECT 1 FROM api_keys ${word} x ${word} y`));
  });
  it("reads any other word after a token relation as its alias", async () => {
    await expectViolations(viaTag("SELECT 1 FROM api_keys other x other y"), [ruleAt("W2", W.alias("other"))]);
  });
});

describe.concurrent("raw SQL: every relation keyword", { timeout: 60_000 }, () => {
  const KEYWORDS = [
    ["FROM", "SELECT 1 FROM api_keys"],
    ["JOIN", "SELECT 1 FROM notes JOIN api_keys ON true"],
    ["UPDATE", "UPDATE api_keys SET user_id = $1"],
    ["INTO", "INSERT INTO api_keys (id) VALUES ($1)"],
    ["ONLY", "SELECT 1 FROM ONLY api_keys"],
  ];
  it.each(KEYWORDS)("a token table after %s is in relation position", async (_kw, sql) => {
    await expectPass(viaTag(sql));
  });
  it.each(["TABLE", "LOCK TABLE", "TRUNCATE", "COPY"])("a token table after %s is not", async (word) => {
    await expectViolations(viaTag(`${word} api_keys`), [ruleAt("W2", W.table("api_keys"))]);
  });
});

describe.concurrent("raw SQL: W4 object modifiers, every word", { timeout: 60_000 }, () => {
  const CASES = [
    ["OR REPLACE", "CREATE OR REPLACE VIEW v AS SELECT 1", "VIEW"],
    ["TEMP", "CREATE TEMP VIEW v AS SELECT 1", "VIEW"],
    ["TEMPORARY", "CREATE TEMPORARY VIEW v AS SELECT 1", "VIEW"],
    ["RECURSIVE", "CREATE RECURSIVE VIEW v (a) AS SELECT 1", "VIEW"],
    ["MATERIALIZED", "CREATE MATERIALIZED VIEW v AS SELECT 1", "VIEW"],
    ["CONSTRAINT", "CREATE CONSTRAINT TRIGGER t AFTER INSERT ON notes", "TRIGGER"],
    ["EVENT", "CREATE EVENT TRIGGER t ON ddl_command_start", "TRIGGER"],
    ["UNLOGGED", "CREATE UNLOGGED VIEW v AS SELECT 1", "VIEW"],
    ["GLOBAL", "CREATE GLOBAL VIEW v AS SELECT 1", "VIEW"],
    ["LOCAL", "CREATE LOCAL VIEW v AS SELECT 1", "VIEW"],
    ["ALTER ... TRIGGER", "ALTER TRIGGER t ON notes RENAME TO u", "TRIGGER"],
  ];
  it.each(CASES)("FAILS on %s", async (_label, sql, kind) => {
    await expectViolations(viaUnsafe(sql), [ruleAt("W4", `${sql.split(" ")[0]} ${kind} defines an object whose body the lexer cannot read`)]);
  });
  it.each(["TEMP", "UNLOGGED", "GLOBAL TEMP"])("passes on CREATE %s TABLE (no object kind)", async (word) => {
    await expectPass(viaUnsafe(`CREATE ${word} TABLE x (a int)`));
  });
});

describe.concurrent("database objects in SQL files: every CREATE modifier", { timeout: 60_000 }, () => {
  const MIG = "prisma/migrations/20240201000000_extra/migration.sql";
  const withSql = (sql) => ({ files: { [MIG]: sql } });
  const unlistedLine = (why) => `SQL_OBJECT_UNLISTED: ${MIG} — line 1: ${why}. List it in "sqlObjects" in ${MANIFEST} with a reason.`;
  const OBJECTS = [
    ["OR REPLACE", "CREATE OR REPLACE VIEW v AS SELECT id FROM api_keys;", "VIEW"],
    ["TEMP", "CREATE TEMP VIEW v AS SELECT id FROM api_keys;", "VIEW"],
    ["TEMPORARY", "CREATE TEMPORARY VIEW v AS SELECT id FROM api_keys;", "VIEW"],
    ["RECURSIVE", "CREATE RECURSIVE VIEW v (a) AS SELECT id FROM api_keys;", "VIEW"],
    ["MATERIALIZED", "CREATE MATERIALIZED VIEW v AS SELECT id FROM api_keys;", "VIEW"],
    ["CONSTRAINT", "CREATE CONSTRAINT TRIGGER t AFTER INSERT ON api_keys;", "TRIGGER"],
    ["EVENT", "CREATE EVENT TRIGGER t ON api_keys;", "TRIGGER"],
    ["UNLOGGED", "CREATE UNLOGGED VIEW v AS SELECT id FROM api_keys;", "VIEW"],
    ["GLOBAL", "CREATE GLOBAL VIEW v AS SELECT id FROM api_keys;", "VIEW"],
    ["LOCAL", "CREATE LOCAL VIEW v AS SELECT id FROM api_keys;", "VIEW"],
  ];
  it.each(OBJECTS)("FAILS on CREATE %s of an object naming a token table", async (_label, sql, kind) => {
    await expectViolations(withSql(sql), [unlistedLine(`CREATE ${kind} naming a token table or a digest column`)]);
  });
  it.each(OBJECTS)("passes on the same statement naming no token table: %s", async (_label, sql) => {
    await expectPass(withSql(sql.replace("api_keys", "notes")));
  });
  it.each(["GLOBAL", "LOCAL", "TEMP", "TEMPORARY", "UNLOGGED"])("passes on CREATE %s TABLE naming a digest column (a plain definition)", async (word) => {
    await expectPass(withSql(`CREATE ${word} TABLE t4 (token_hash text);`));
  });
  it("FAILS on CREATE TEMP TABLE ... AS naming a digest column (a copy)", async () => {
    await expectViolations(withSql("CREATE TEMP TABLE t4 AS SELECT token_hash FROM notes;"), [
      unlistedLine("statement naming a digest column that is not a plain definition, index, drop or seed (CREATE)"),
    ]);
  });
  it("FAILS on a tightly glued untagged dollar body naming a token table", async () => {
    await expectViolations(withSql("CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$SELECT count(*) FROM api_keys$$;"), [unlistedLine("CREATE FUNCTION naming a token table or a digest column")]);
  });
  it("FAILS on a tightly glued tagged dollar body naming a token table", async () => {
    await expectViolations(withSql("CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $q$SELECT count(*) FROM api_keys$q$;"), [unlistedLine("CREATE FUNCTION naming a token table or a digest column")]);
  });
  it("passes on the same glued bodies naming no token table", async () => {
    await expectPass(withSql("CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$SELECT count(*) FROM notes$$;\nCREATE FUNCTION g() RETURNS int LANGUAGE sql AS $q$SELECT count(*) FROM notes$q$;"));
  });
});

// B1 census: every member of the role sets has a cell.
describe.concurrent("digest-key spelling census — every member of the binding, value and type sets", { timeout: 60_000 }, () => {
  const BOUND = "const tokenHash = t;\n  ";
  const VALUE_POSITIONS = [
    ["CallExpression", "f(tokenHash);"],
    ["NewExpression", "new F(tokenHash);"],
    ["BinaryExpression", "const r = tokenHash + 1;"],
    ["PrefixUnaryExpression", "const r = -tokenHash;"],
    ["PostfixUnaryExpression", "tokenHash++;"],
    ["ConditionalExpression", "const r = c ? tokenHash : 1;"],
    ["ParenthesizedExpression", "const r = (tokenHash);"],
    ["AsExpression", "const r = tokenHash as string;"],
    ["SatisfiesExpression", "const r = tokenHash satisfies string;"],
    ["NonNullExpression", "const r = tokenHash!;"],
    ["TypeAssertionExpression", "const r = <string>tokenHash;"],
    ["AwaitExpression", "const r = await tokenHash;"],
    ["TypeOfExpression", "const r = typeof tokenHash;"],
    ["VoidExpression", "void tokenHash;"],
    ["DeleteExpression", "delete tokenHash;"],
    ["SpreadElement", "const r = [...tokenHash];"],
    ["SpreadAssignment", "const r = { ...tokenHash };"],
    ["ArrayLiteralExpression", "const r = [tokenHash];"],
    ["ElementAccessExpression", "const r = row[tokenHash];"],
    ["TaggedTemplateExpression", "tokenHash`x`;"],
    ["TemplateSpan", "const r = `${tokenHash}`;"],
    ["ArrowFunction", "const r = () => tokenHash;"],
    ["ComputedPropertyName", "const r = { [tokenHash]: 1 };"],
    ["ReturnStatement", "return tokenHash;"],
    ["ThrowStatement", "throw tokenHash;"],
    ["ExpressionStatement", "tokenHash;"],
    ["IfStatement", "if (tokenHash) { void 0; }"],
    ["WhileStatement", "while (tokenHash) { break; }"],
    ["DoStatement", "do { break; } while (tokenHash);"],
    ["ForStatement", "for (; tokenHash; ) { break; }"],
    ["ForInStatement", "for (const k in tokenHash) { void k; }"],
    ["ForOfStatement", "for (const k of tokenHash) { void k; }"],
    ["SwitchStatement", "switch (tokenHash) { default: break; }"],
    ["CaseClause", "switch (t) { case tokenHash: break; }"],
    ["Decorator", "const dec = tokenHash;\n  @tokenHash\n  class C {}\n  void C;"],
  ];
  it.each(VALUE_POSITIONS)("passes on a binding read in a %s", async (_kind, code) => {
    await expectPass(inLookup(BOUND + code));
  });
  it("passes on a binding read in a YieldExpression", async () => {
    await expectPass({ files: { [OTHER]: `export function* lookup() {\n  const tokenHash = 1;\n  yield tokenHash;\n}\n` } });
  });
  it("passes on a binding read in an ExportAssignment", async () => {
    await expectPass({ files: { [OTHER]: `const tokenHash = 1;\nexport default tokenHash;\n` } });
  });
  it("passes on a binding read in a JsxExpression and a JsxSpreadAttribute", async () => {
    await expectPass({ files: { "src/lib/other.tsx": `export function lookup() {\n  const tokenHash = {};\n  return <div {...tokenHash}>{tokenHash}</div>;\n}\n` } });
  });

  const DECLARED = [
    ["FunctionExpression", "const f = function tokenHash() { return 1; };\n  return f;"],
    ["ClassDeclaration", "class tokenHash {}\n  return 1;"],
    ["ClassExpression", "const C = class tokenHash {};\n  return C;"],
    ["EnumDeclaration", "enum tokenHash { A }\n  return 1;"],
  ];
  it.each(DECLARED)("passes on a %s named as a digest key (a binding)", async (_kind, code) => {
    await expectPass(inLookup(code));
  });
  const MODULE_LEVEL = [
    ["ModuleDeclaration", "namespace tokenHash {\n  export const x = 1;\n}\nexport const y = 1;\n"],
    ["ImportClause", 'import tokenHash from "./h";\nexport const x = 1;\n'],
    ["NamespaceImport", 'import * as tokenHash from "./h";\nexport const x = 1;\n'],
    ["ImportEqualsDeclaration", 'import tokenHash = require("./h");\nexport const x = 1;\n'],
    ["InterfaceDeclaration", "interface tokenHash {\n  a: string;\n}\nexport const x = 1;\n"],
    ["TypeAliasDeclaration", "type tokenHash = string;\nexport const x = 1;\n"],
  ];
  it.each(MODULE_LEVEL)("passes on a %s named as a digest key", async (_kind, contents) => {
    await expectPass({ files: { [OTHER]: contents } });
  });
  it("passes on a TypeParameter named as a digest key", async () => {
    await expectPass({ files: { [OTHER]: "export function lookup<tokenHash>(a: tokenHash) {\n  return a;\n}\n" } });
  });
});

describe.concurrent("digest-key spelling census — every argument wrapper of a builder string", { timeout: 60_000 }, () => {
  const BUILDER = `${OTHER}#build`;
  const CALLER = `${OTHER}#lookup`;
  const WRAPPERS = [
    ["ParenthesizedExpression", 'Reflect.set(w, ("tokenHash"), h);'],
    ["AsExpression", 'Reflect.set(w, "tokenHash" as string, h);'],
    ["SatisfiesExpression", 'Reflect.set(w, "tokenHash" satisfies string, h);'],
    ["NonNullExpression", 'Reflect.set(w, "tokenHash"!, h);'],
    ["ArrayLiteralExpression", 'Object.fromEntries([["tokenHash", h]]);'],
  ];
  const file = (call) => `function build(h: string) {\n  const w: Record<string, unknown> = {};\n  ${call}\n  return w;\n}\nexport function lookup(t: string) {\n  return x.findFirst({ where: build(t) });\n}\n`;
  it.each(WRAPPERS)("treats a string in a %s as a builder's argument", async (_kind, call) => {
    await expectViolations({ files: { [OTHER]: file(call) } }, [unlisted(BUILDER, { floating: [[3, "string"]] }), unlisted(CALLER, { builderCalls: [[7, "build"]] })]);
  });
  it.each(WRAPPERS)("passes when the same %s wraps a string that is no digest key", async (_kind, call) => {
    await expectPass({ files: { [OTHER]: file(call.replace("tokenHash", "id")) } });
  });
});


// ─── Code review round 1 ─────────────────────────────────────────────────────────────────────

describe.concurrent("raw SQL: W5 reads a string's body, with its delimiters stripped (S18)", { timeout: 60_000 }, () => {
  const DENY = [
    ["a dollar-quoted body ending at the name", "SELECT 1 FROM notes WHERE x = $$ from api_keys$$"],
    ["a dollar-quoted body that is only the name", "SELECT 1 FROM notes WHERE x = $$api_keys$$"],
    ["a tagged dollar-quoted body that is only the name", "SELECT 1 FROM notes WHERE x = $q$api_keys$q$"],
    ["a name followed by a dollar sign", "SELECT 1 FROM notes WHERE x = 'api_keys$1'"],
  ];
  it.each(DENY)("FAILS on %s", async (_label, sql) => {
    await expectViolations(viaUnsafe(sql), [ruleAt("W5", W.string("api_keys"))]);
  });
  it("passes on a dollar-quote tag spelled like the table (the delimiters are not the body)", async () => {
    await expectPass(viaUnsafe("SELECT 1 FROM notes WHERE x = $api_keys$ x $api_keys$"));
  });
  it("FAILS on the same tag around a body that does name the table", async () => {
    await expectViolations(viaUnsafe("SELECT 1 FROM notes WHERE x = $api_keys$ api_keys $api_keys$"), [ruleAt("W5", W.string("api_keys"))]);
  });
  const ALLOW = [
    ["a longer word after the name in a dollar-quoted body", "SELECT 1 FROM notes WHERE x = $$api_keys_old$$"],
    ["a longer word before the name in a dollar-quoted body", "SELECT 1 FROM notes WHERE x = $$old_api_keys$$"],
    ["a longer word in a tagged dollar-quoted body", "SELECT 1 FROM notes WHERE x = $q$xapi_keysx$q$"],
  ];
  it.each(ALLOW)("passes on %s", async (_label, sql) => {
    await expectPass(viaUnsafe(sql));
  });
});

describe.concurrent("raw SQL: a comment marker in a trustedSql template (F1, S21, static side)", { timeout: 60_000 }, () => {
  const MARKER = "a comment marker (-- or /*) in a trustedSql template: the run-time mint refuses it";
  it("FAILS on a line comment that hides a substitution and the keyword after it", async () => {
    await expectViolations(viaTrusted("SELECT to_jsonb( -- ${x} FROM\n ${tbl}) FROM y"), [ruleAt("W6", MARKER)]);
  });
  it("FAILS on a block comment that hides both substitutions (one violation, the first marker)", async () => {
    await expectViolations(viaTrusted("SELECT to_jsonb( /* ${x} FROM\n ${tbl}) */ FROM y"), [ruleAt("W6", MARKER)]);
  });
  it("FAILS on a comment that hides no substitution", async () => {
    await expectViolations(viaTrusted("SELECT 1 -- note\n FROM ${tbl}"), [ruleAt("W6", MARKER)]);
  });
  it("FAILS on a block comment after which the keyword is real", async () => {
    await expectViolations(viaTrusted("SELECT 1 /* note */ FROM ${tbl}"), [ruleAt("W6", MARKER)]);
  });
  it("FAILS on a marker inside a string (the mint cannot tell strings apart, so neither does the gate)", async () => {
    await expectViolations(viaTrusted("SELECT '--' FROM notes"), [ruleAt("W6", MARKER)]);
  });
  it("FAILS on a marker inside a quoted identifier", async () => {
    await expectViolations(viaTrusted('SELECT "a/*b" FROM notes'), [ruleAt("W6", MARKER)]);
  });
  it("reports only the first of two markers in different parts", async () => {
    await expectViolations(viaTrusted("SELECT 1 FROM ${tbl} -- a\n WHERE ${parent} -- b"), [ruleAt("W6", MARKER)]);
  });
  it("reports the line of a marker that follows a newline in an earlier part", async () => {
    await expectViolations(viaTrusted("SELECT 1\n FROM ${tbl} -- x"), [ruleAt("W6", MARKER, 4)]);
  });
  it("reports the line of a marker that follows a multi-line substitution", async () => {
    await expectViolations(viaTrusted("SELECT ${(\n tbl\n )}\n FROM notes -- x"), [ruleAt("W6", MARKER, 6)]);
  });
  it("reports the line of the first marker", async () => {
    await expectViolations(viaTrusted("SELECT 1\n  FROM notes -- x"), [ruleAt("W6", MARKER, 4)]);
  });
  it("FAILS on a comment fragment that would hide the keyword of the next template (S21)", async () => {
    await expectViolations(sqlBody("const c = trustedSql`-- `;\n  return trustedSql`SELECT to_jsonb(${c} from\n ${tbl})`;"), [ruleAt("W6", MARKER)]);
  });
  const ADJACENT_DENY = [
    ["a dash directly before a substitution", "SELECT 4 -${parent} FROM notes"],
    ["a dash directly after a substitution", "SELECT ${parent}- 4 FROM notes"],
    ["a slash directly before a substitution", "SELECT 4 /${parent} FROM notes"],
    ["a slash directly after a substitution", "SELECT ${parent}/ 4 FROM notes"],
  ];
  it.each(ADJACENT_DENY)("FAILS on %s (it could complete a comment marker)", async (_label, sql) => {
    await expectViolations(viaTrusted(sql), [ruleAt("W6", W.adjacent)]);
  });
  it("passes on the same operators spaced from the substitution", async () => {
    await expectPass(viaTrusted("SELECT 4 - ${parent} - 1, ${parent} / 2 FROM notes"));
  });
  it("passes on a single dash and a division (no marker)", async () => {
    await expectPass(viaTrusted("SELECT 1 - 2, 4 / 2 FROM notes"));
  });
  it("passes on the same comments in a $queryRaw template (only trustedSql refuses them)", async () => {
    await expectPass(viaTag("SELECT 1 -- note\n FROM notes /* more */"));
  });
  it("passes on substitutions inside a quoted identifier and a string (no marker anywhere)", async () => {
    await expectPass(viaTrusted('SELECT "${tbl}".id FROM ${tbl} WHERE x = \'${parent}\''));
  });
});

describe.concurrent("database objects in SQL files: DO blocks and the rest of the review's shapes", { timeout: 60_000 }, () => {
  const MIG = "prisma/migrations/20240201000000_extra/migration.sql";
  const withSql = (sql) => ({ files: { [MIG]: sql } });
  const unlistedLine = (whys) => `SQL_OBJECT_UNLISTED: ${MIG} — ${whys.map(([line, why]) => `line ${line}: ${why}`).join("; ")}. List it in "sqlObjects" in ${MANIFEST} with a reason.`;
  const PLAIN = (first) => `statement naming a digest column that is not a plain definition, index, drop or seed (${first})`;
  const DO_EXECUTES = "DO block executing a CREATE or ALTER of a database object";

  it("FAILS on a DO block that EXECUTEs a CREATE of an object naming nothing (S19)", async () => {
    await expectViolations(withSql("DO $$ BEGIN EXECUTE 'CREATE VIEW v AS SELECT 1'; END $$;"), [unlistedLine([[1, DO_EXECUTES]])]);
  });
  it("FAILS on a DO block that EXECUTEs an ALTER of an object", async () => {
    await expectViolations(withSql("DO $$ BEGIN EXECUTE 'ALTER FUNCTION f() OWNER TO x'; END $$;"), [unlistedLine([[1, DO_EXECUTES]])]);
  });
  it("FAILS on a DO block that EXECUTEs a CREATE of an object naming a token table (both reasons, a pair)", async () => {
    await expectViolations(withSql("DO $$ BEGIN EXECUTE 'CREATE VIEW v AS SELECT id FROM api_keys'; END $$;"), [
      unlistedLine([[1, "DO block creating a database object and naming a token table or a digest column"], [1, DO_EXECUTES]]),
    ]);
  });
  it("passes on a DO block that EXECUTEs a CREATE of something that is no object kind", async () => {
    await expectPass(withSql("DO $$ BEGIN EXECUTE 'CREATE TABLE x (a int)'; END $$;"));
  });
  it("passes on a DO block that creates a table and only names a token table", async () => {
    await expectPass(withSql("DO $$ BEGIN CREATE TABLE x (a int); PERFORM 1 FROM api_keys; END $$;"));
  });

  it("FAILS on ALTER PUBLICATION ... ADD TABLE with a column list naming a digest column", async () => {
    await expectViolations(withSql("ALTER PUBLICATION p ADD TABLE notes (token_hash);"), [unlistedLine([[1, PLAIN("ALTER")]])]);
  });
  it("passes on ALTER PUBLICATION naming no digest column", async () => {
    await expectPass(withSql("ALTER PUBLICATION p ADD TABLE notes;"));
  });
  it("FAILS on a schema-qualified REFERENCES to a digest column", async () => {
    await expectViolations(withSql("CREATE TABLE t2 (a text REFERENCES public.api_keys (token_hash));"), [unlistedLine([[1, PLAIN("CREATE")]])]);
  });
  it("passes on a schema-qualified REFERENCES to another column", async () => {
    await expectPass(withSql("CREATE TABLE t2 (a text REFERENCES public.api_keys (id));"));
  });
  it("FAILS on a CREATE PROCEDURE whose body holds EXECUTE", async () => {
    await expectViolations(withSql("CREATE PROCEDURE p() LANGUAGE plpgsql AS $$ BEGIN EXECUTE 'select 1'; END $$;"), [unlistedLine([[1, "CREATE PROCEDURE whose body holds EXECUTE"]])]);
  });
  it("passes on a CREATE PROCEDURE with no EXECUTE", async () => {
    await expectPass(withSql("CREATE PROCEDURE p() LANGUAGE plpgsql AS $$ BEGIN PERFORM 1; END $$;"));
  });
  it("FAILS on a final statement with no terminating semicolon", async () => {
    await expectViolations(withSql("SELECT 1;\nUPDATE notes SET token_hash = 'x'"), [unlistedLine([[2, PLAIN("UPDATE")]])]);
  });
  it("passes on the same final statement naming no digest column", async () => {
    await expectPass(withSql("SELECT 1;\nUPDATE notes SET id = 'x'"));
  });
  it("passes on a comma inside parentheses in an ALTER ... ADD COLUMN", async () => {
    await expectPass(withSql("ALTER TABLE notes ADD COLUMN token_hash numeric(10,2);"));
  });
  it("passes on a semicolon inside parentheses (it does not end a statement)", async () => {
    await expectPass(withSql("CREATE INDEX i ON notes (a; token_hash);"));
  });
  it("FAILS on a generated column reading a digest column at the end of its expression", async () => {
    await expectViolations(withSql("ALTER TABLE notes ADD COLUMN h text GENERATED ALWAYS AS (1 + token_hash) STORED;"), [unlistedLine([[1, PLAIN("ALTER")]])]);
  });
  it("FAILS on a generated column reading a digest column at the start of its expression", async () => {
    await expectViolations(withSql("ALTER TABLE notes ADD COLUMN h text GENERATED ALWAYS AS (token_hash + 1) STORED;"), [unlistedLine([[1, PLAIN("ALTER")]])]);
  });
  it("FAILS on a function whose E-string body holds an escaped quote before a token table", async () => {
    await expectViolations(withSql("CREATE FUNCTION f() RETURNS int LANGUAGE sql AS E'SELECT \\'a\\' FROM api_keys';"), [unlistedLine([[1, "CREATE FUNCTION naming a token table or a digest column"]])]);
  });
  it("FAILS on a function whose E-string body spells the table with a backslash escape", async () => {
    await expectViolations(withSql("CREATE FUNCTION f() RETURNS int LANGUAGE sql AS E'SELECT 1 FROM api\\_keys';"), [unlistedLine([[1, "CREATE FUNCTION naming a token table or a digest column"]])]);
  });
  it("passes on the same E-string body naming no token table", async () => {
    await expectPass(withSql("CREATE FUNCTION f() RETURNS int LANGUAGE sql AS E'SELECT \\'a\\' FROM notes';"));
  });
});

describe.concurrent("raw SQL: the literal collection and the violation lines (review cells)", { timeout: 60_000 }, () => {
  const bare = (stmt) => ({ files: { [SQL_FILE]: `export async function q(tx: any) {\n  ${stmt}\n}\n` } });
  const at2 = (rule, message) => `${SQL_FILE}:2  ${rule}: ${message}`;
  it("FAILS on a ; before a DO (a DO is statement-initial after a semicolon)", async () => {
    await expectViolations(viaUnsafe("SELECT 1; DO NOTHING"), [ruleAt("W4", "a DO block runs SQL the lexer cannot read")]);
  });
  it("passes on a DO that is no statement start", async () => {
    await expectPass(viaUnsafe("SELECT 1 DO NOTHING"));
  });
  it("reads a $executeRaw template in a file with no trustedSql text (W1)", async () => {
    await expectViolations(bare("await tx.$executeRaw`SELECT * FROM api_keys`;"), [at2("W1", W.star)]);
  });
  it("reads a $queryRaw template in a file with no trustedSql text (W1)", async () => {
    await expectViolations(bare("await tx.$queryRaw`SELECT * FROM api_keys`;"), [at2("W1", W.star)]);
  });
  it("passes on the same two templates naming count(*)", async () => {
    await expectPass(bare("await tx.$executeRaw`SELECT count(*) FROM api_keys`;\n  await tx.$queryRaw`SELECT count(*) FROM api_keys`;"));
  });
  it("counts two identical violations on one line once", async () => {
    await expectViolations(viaTag("SELECT *, * FROM api_keys"), [ruleAt("W1", W.star)]);
  });
  it("FAILS on $queryRawUnsafe used as a tag", async () => {
    await expectViolations(sqlBody("await tx.$queryRawUnsafe`select 1`;"), [`${SQL_FILE}:3  $queryRawUnsafe is used other than as a template tag / a call with a literal SQL argument: its text cannot be read`]);
  });
  it("passes on $queryRaw used as a tag", async () => {
    await expectPass(sqlBody("await tx.$queryRaw`select 1`;"));
  });
  const RENDER_IMPORT = 'import { renderSql, trustedSql } from "@/lib/prisma/raw-sql";';
  const renderBody = (call) => ({ files: { [SQL_FILE]: `${RENDER_IMPORT}\nexport async function q(tx: any) {\n  ${call}\n}\n` } });
  it("FAILS on renderSql with a second argument", async () => {
    await expectViolations(renderBody("await tx.$queryRawUnsafe(renderSql(trustedSql`select 1`, 2));"), [
      `${SQL_FILE}:3  $queryRawUnsafe's SQL argument is not a literal (nor renderSql(trustedSql\`...\`)): its text cannot be read`,
    ]);
  });
  it("passes on renderSql with one argument", async () => {
    await expectPass(renderBody("await tx.$queryRawUnsafe(renderSql(trustedSql`select 1`));"));
  });
  it("FAILS on count(* followed by something other than a parenthesis", async () => {
    await expectViolations(viaTag("SELECT count(* x) FROM api_keys"), [ruleAt("W1", W.star)]);
  });
  it("reads the SQL of a parenthesised .query callee", async () => {
    await expectViolations({ files: { [SQL_FILE]: 'export function run(pool: any) {\n  return (pool.query)("SELECT * FROM api_keys");\n}\n' } }, [`${SQL_FILE}:2  W1: ${W.star}`]);
  });
  it("passes on the parenthesised callee naming count(*)", async () => {
    await expectPass({ files: { [SQL_FILE]: 'export function run(pool: any) {\n  return (pool.query)("SELECT count(*) FROM api_keys");\n}\n' } });
  });
  const PG = "src/lib/pg.ts";
  const referenceMessage = "C5: a reference to `query` other than a direct call with a literal SQL argument (a value, .call / .apply / .bind, a destructuring): the pool's SQL cannot be read";
  const importer = (stmt) => ({ files: { [PG]: `import { createPool } from "@/lib/db/pool-factory";\nexport function run(pool: any) {\n  ${stmt}\n}\n` }, pgPools: { [PG]: { reason: REASON } } });
  it("FAILS on pool.query passed as an argument in an importer", async () => {
    await expectViolations(importer("return promisify(pool.query);"), [`${PG}:3  ${referenceMessage}`]);
  });
  it("passes on another member passed as an argument", async () => {
    await expectPass(importer("return promisify(pool.ping);"));
  });
});

describe.concurrent("lookups and census: the review's remaining shapes", { timeout: 60_000 }, () => {
  it("FAILS on a spread under NOT in a token-model where (opaque)", async () => {
    await expectViolations(inLookup("return tx.apiKey.findFirst({ where: { NOT: { ...t } } });"), [unlisted(LOOKUP_KEY, { lines: [2], opaque: ["line 2: ApiKey where: spread"] })]);
  });
  it("passes on NOT with a readable object", async () => {
    await expectPass(inLookup("return tx.apiKey.findFirst({ where: { NOT: { id: t } } });"));
  });
  it("FAILS on a spread element in an array where on a token model (opaque)", async () => {
    await expectViolations(inLookup("return tx.apiKey.findMany({ where: [...t] });"), [unlisted(LOOKUP_KEY, { lines: [2], opaque: ["line 2: ApiKey where: spread"] })]);
  });
  it("passes on an array where of readable objects", async () => {
    await expectPass(inLookup("return tx.apiKey.findMany({ where: [{ id: t }] });"));
  });
  it("FAILS on a bare .length of an unresolved tokenHash", async () => {
    await expectViolations(inLookup("return tokenHash.length;"), [unlisted(LOOKUP_KEY, { floating: [[2, "unresolved reference"]] })]);
  });
  it("passes on a nested updateMany whose data holds a spread (scalar columns only)", async () => {
    await expectPass(inLookup("return tx.user.update({ where: { id: t }, data: { apiKeys: { updateMany: { where: { id: t }, data: { ...t } } } } });"));
  });
  it("FAILS on a nested update whose data holds a spread into a token model", async () => {
    await expectViolations(inLookup("return tx.user.update({ where: { id: t }, data: { apiKeys: { update: { where: { id: t }, data: { ...t } } } } });"), [
      unlisted(LOOKUP_KEY, { lines: [2], opaque: ["line 2: ApiKey apiKeys.update.data: spread"] }),
    ]);
  });
  const WITH_KEY = swap(SCHEMA, '  userId String @map("user_id")\n  user   User   @relation(fields: [userId], references: [id])\n\n  @@map("profiles")', '  userId String @map("user_id")\n  user   User   @relation(fields: [userId], references: [id])\n  keyId  String? @map("key_id")\n  key    ApiKey? @relation(fields: [keyId], references: [id])\n\n  @@map("profiles")');
  it("FAILS on a digest key in a direct to-one filter into a token model", async () => {
    await expectViolations({ files: { "prisma/schema.prisma": WITH_KEY, [OTHER]: NOTE_FN("  return tx.profile.findFirst({ where: { key: { tokenHash: t } } });") } }, [unlisted(LOOKUP_KEY, { lines: [2], lookups: 1 })]);
  });
  it("passes on the same to-one filter by id", async () => {
    await expectPass({ files: { "prisma/schema.prisma": WITH_KEY, [OTHER]: NOTE_FN("  return tx.profile.findFirst({ where: { key: { id: t } } });") } });
  });
  it("FAILS on an opaque to-one filter into a token model", async () => {
    await expectViolations({ files: { "prisma/schema.prisma": WITH_KEY, [OTHER]: NOTE_FN("  return tx.profile.findFirst({ where: { key: { ...t } } });") } }, [
      unlisted(LOOKUP_KEY, { lines: [2], opaque: ["line 2: ApiKey relation filter: spread"] }),
    ]);
  });
  it("FAILS on a logical spread inside a direct to-one filter into a token model", async () => {
    await expectViolations({ files: { "prisma/schema.prisma": WITH_KEY, [OTHER]: NOTE_FN("  return tx.profile.findFirst({ where: { key: { OR: [...t] } } });") } }, [
      unlisted(LOOKUP_KEY, { lines: [2], opaque: ["line 2: ApiKey where: OR spread"] }),
    ]);
  });
});

describe.concurrent("builders: the review's remaining arms", { timeout: 60_000 }, () => {
  const BUILD = "function build(h: string) {\n  return { tokenHash: h };\n}\n";
  const BUILDER_KEY = `${OTHER}#build`;
  it("FAILS on the caller of a parenthesised builder call", async () => {
    await expectViolations({ files: { [OTHER]: `${BUILD}export function lookup(t: string) {\n  return x.findFirst({ where: (build)(t) });\n}\n` } }, [
      unlisted(BUILDER_KEY, { floating: [[2, "property"]] }),
      unlisted(LOOKUP_KEY, { builderCalls: [[5, "build"]] }),
    ]);
  });
  it("passes on a same-named parameter that shadows the builder", async () => {
    await expectPass({ files: { [OTHER]: `${BUILD}export function lookup(build: any, t: string) {\n  return x.findFirst({ where: build(t) });\n}\n` }, manifest: { [BUILDER_KEY]: exempt(1) } });
  });
  it("FAILS on a call of a builder at module scope (cannot be attributed)", async () => {
    await expectViolations(
      { files: { "src/lib/builder.ts": "export function build(h: string) {\n  return { tokenHash: h };\n}\n", [OTHER]: 'import { build } from "./builder";\nconst w = build("a");\nexport const x = w;\n' }, manifest: { "src/lib/builder.ts#build": exempt(1) } },
      [`${OTHER}:2  call of build, which builds a digest-keyed object (src/lib/builder.ts), cannot be attributed to a named function, method or exported const`],
    );
  });
  it("passes on a builder that calls itself (the recursion is no consumer)", async () => {
    await expectPass({ files: { [OTHER]: "function build(h: string): unknown {\n  if (!h) return build(\"x\");\n  return { tokenHash: h };\n}\n" }, manifest: { [BUILDER_KEY]: exempt(1) } });
  });
  it("FAILS on another function calling that builder (a consumer)", async () => {
    await expectViolations({ files: { [OTHER]: `${BUILD}export function lookup(t: string) {\n  return x.findFirst({ where: build(t) });\n}\n` } }, [
      unlisted(BUILDER_KEY, { floating: [[2, "property"]] }),
      unlisted(LOOKUP_KEY, { builderCalls: [[5, "build"]] }),
    ]);
  });
});

describe.concurrent("schema source: the forms a line scan misses (F2, F3)", { timeout: 60_000 }, () => {
  const SCHEMA_PREFIX = "prisma/schema.prisma:";
  const addToNote = (line) => ({ files: { "prisma/schema.prisma": swap(SCHEMA, 'model Note {\n  id    String @id\n  title String\n', `model Note {\n  id    String @id\n  title String\n  ${line}\n`) } });
  const UNIQUE_HASH = "is a unique String ending in hash/digest but is not a digest key (tokenHash/codeHash/replacedByHash): name it one, or list";
  const listing = (key) => `${SCHEMA_PREFIX} ${key} ${UNIQUE_HASH} "${key}" in the manifest's "nonBearerHashFields" with a reason.`;
  const UNIQUE_FORMS = [
    ["a @@unique(fields: [...], name: ...)", "secretHash String\n  @@unique(fields: [secretHash], name: \"n\")", "slug String\n  @@unique(fields: [slug], name: \"n\")"],
    ["a multi-line @@unique([...])", "secretHash String\n  @@unique([\n    secretHash\n  ])", "slug String\n  @@unique([\n    slug\n  ])"],
    ["a @unique on a continuation line", "secretHash String\n    @unique", "slug String\n    @unique"],
    ["a @unique at column 0 on a continuation line", "secretHash String\n@unique", "slug String\n@unique"],
  ];
  it.each(UNIQUE_FORMS)("is fatal on %s over a hash field", async (_label, deny) => {
    await expectFatal(addToNote(deny), listing("Note.secretHash"));
  });
  it.each(UNIQUE_FORMS)("passes on %s over a field that does not end in hash", async (_label, _deny, allow) => {
    await expectPass(addToNote(allow));
  });
  it("is fatal on a multi-line @@unique after a line with stray closing parentheses", async () => {
    await expectFatal(addToNote('label String @map("l")))\n  secretHash String\n  @@unique([\n    secretHash\n  ])'), listing("Note.secretHash"));
  });
  it("is fatal on a multi-line @relation that references a digest key", async () => {
    await expectFatal(addToNote("link ApiKey @relation(\n    fields: [title],\n    references: [tokenHash]\n  )"), `${SCHEMA_PREFIX} Note.link references tokenHash: a foreign key gives another column the digest's values.`);
  });
  it("passes on a multi-line @relation that references an id", async () => {
    await expectPass(addToNote("link ApiKey @relation(\n    fields: [title],\n    references: [id]\n  )"));
  });
  it("is fatal on a model whose brace is on the next line (the schema reader cannot see it)", async () => {
    await expectFatal({ files: { "prisma/schema.prisma": `${SCHEMA}\nmodel Z\n{\n  id String @id\n}\n` } }, `${SCHEMA_PREFIX} Z opens its block on a later line: the schema reader cannot see it.`);
  });
  const STALE = (key) => `STALE_NON_BEARER_HASH: "${key}" is in "nonBearerHashFields" but names no unique non-digest String field ending in hash or digest.`;
  it("FAILS on an entry naming a field that is not hash-like (Note.title)", async () => {
    await expectViolations({ nonBearerHashFields: { "Note.title": { reason: REASON } } }, [STALE("Note.title")]);
  });
  it("FAILS on an entry naming a hash-like field that is not unique", async () => {
    await expectViolations({ ...addToNote("contentHash String"), nonBearerHashFields: { "Note.contentHash": { reason: REASON } } }, [STALE("Note.contentHash")]);
  });
  it("FAILS on an entry naming a unique field that does not end in hash", async () => {
    await expectViolations({ ...addToNote("slug String @unique"), nonBearerHashFields: { "Note.slug": { reason: REASON } } }, [STALE("Note.slug")]);
  });
  it("FAILS on an entry naming a digest key", async () => {
    await expectViolations({ nonBearerHashFields: { "ApiKey.tokenHash": { reason: REASON } } }, [STALE("ApiKey.tokenHash")]);
  });
  it("passes on an entry naming a unique hash field", async () => {
    await expectPass({ ...addToNote("contentHash String @unique"), nonBearerHashFields: { "Note.contentHash": { reason: REASON } } });
  });
});


describe.concurrent("site counting: two keys that share one span (F5)", { timeout: 60_000 }, () => {
  const DENY = [
    ["a value spelling the same key", 'return { tokenHash: "tokenHash" };', [[2, "property"], [2, "string"]]],
    ["a computed name and a value", 'return { ["tokenHash"]: "tokenHash" };', [[2, "computed property"], [2, "string"]]],
    ["a string-literal name and a value that is another digest key", 'return { "tokenHash": "codeHash" };', [[2, "property"], [2, "string"]]],
  ];
  it.each(DENY)("FAILS on %s (two floating keys, neither covers the other)", async (_label, code, floating) => {
    await expectViolations(inLookup(code), [unlisted(LOOKUP_KEY, { floating })]);
  });
  it.each(DENY)("passes on %s once both are counted", async (_label, code) => {
    await expectPass(listed(inLookup(code), 2));
  });
  it("passes on the same property over a bound local (one floating key)", async () => {
    await expectPass(listed(inLookup("const v = t;\n  return { tokenHash: v };")));
  });
});

describe.concurrent("schema source: strings, unbalanced brackets and the remaining forms (S20, F6, T25)", { timeout: 60_000 }, () => {
  const SCHEMA_PREFIX = "prisma/schema.prisma:";
  const UNIQUE_HASH = "is a unique String ending in hash/digest but is not a digest key (tokenHash/codeHash/replacedByHash): name it one, or list";
  const listing = (key) => `${SCHEMA_PREFIX} ${key} ${UNIQUE_HASH} "${key}" in the manifest's "nonBearerHashFields" with a reason.`;
  const withModels = (early, later) => ({ files: { "prisma/schema.prisma": `${SCHEMA}\nmodel Early {\n  id String @id ${early}\n}\n\nmodel Later {\n  id String @id\n  ${later}\n}\n` } });
  const TRICKY = [
    ["a // inside a string", '@default("a//b")'],
    ["an opening parenthesis inside a string", '@default("(")'],
    ["an opening bracket inside a string", '@map("a[b")'],
    ["an escaped quote and a // inside a string", '@default("a\\"b//c(")'],
  ];
  it.each(TRICKY)("still sees a unique hash field in a later model after %s", async (_label, attribute) => {
    await expectFatal(withModels(attribute, "secretHash String @unique"), listing("Later.secretHash"));
  });
  it.each(TRICKY)("passes after %s when the later unique field is no hash", async (_label, attribute) => {
    await expectPass(withModels(attribute, "slug String @unique"));
  });
  it("is fatal on a parenthesis still open when the next block starts", async () => {
    const text = `${SCHEMA}\nmodel Y {\n  id String @id @default(1\n}\n`;
    const line = text.split("\n").findLastIndex((l) => l === "}") + 1;
    await expectFatal({ files: { "prisma/schema.prisma": text } }, `${SCHEMA_PREFIX} a parenthesis or bracket is still open at line ${line}: the schema cannot be read reliably.`);
  });
  const HEADERS = ["}", "model Q {", "view V {", "enum E {", "type T {", "datasource db {", "generator g {"];
  it.each(HEADERS)("is fatal on a parenthesis still open when %s starts at column 0", async (header) => {
    const text = `${SCHEMA}\nmodel Y {\n  id String @id @default(1\n${header}\n}\n`;
    const line = text.split("\n").findIndex((l, i, all) => l === header && all[i - 1] === "  id String @id @default(1") + 1;
    await expectFatal({ files: { "prisma/schema.prisma": text } }, `${SCHEMA_PREFIX} a parenthesis or bracket is still open at line ${line}: the schema cannot be read reliably.`);
  });
  it("passes on a parenthesis inside a trailing // comment (comments are read outside strings only)", async () => {
    await expectPass({ files: { "prisma/schema.prisma": `${SCHEMA}\nmodel Y {\n  id String @id // see (note\n}\n` } });
  });
  const addToNote = (line) => ({ files: { "prisma/schema.prisma": swap(SCHEMA, 'model Note {\n  id    String @id\n  title String\n', `model Note {\n  id    String @id\n  title String\n  ${line}\n`) } });
  const ATTRIBUTE_WITH_PAREN = [
    ["a ) inside a string", '@relation(\n    name: "a)",\n    fields: [title],\n    references: [tokenHash]\n  )'],
    ["a ] inside a string", '@relation(\n    name: "a]",\n    fields: [title],\n    references: [tokenHash]\n  )'],
  ];
  it.each(ATTRIBUTE_WITH_PAREN)("still sees a relation that references a digest key after %s", async (_label, attribute) => {
    await expectFatal(addToNote(`link ApiKey ${attribute}`), `${SCHEMA_PREFIX} Note.link references tokenHash: a foreign key gives another column the digest's values.`);
  });
  it("still sees a relation that references a digest key after an escaped quote and a ) inside a string", async () => {
    await expectFatal(addToNote('link ApiKey @relation(\n    name: "a\\")",\n    fields: [title],\n    references: [tokenHash]\n  )'), `${SCHEMA_PREFIX} Note.link references tokenHash: a foreign key gives another column the digest's values.`);
  });
  it("does not let an unterminated string swallow the rest of the file (the open bracket is reported where the next block starts)", async () => {
    const text = `${SCHEMA}\nmodel Early {\n  id String @id @default("abc\n}\n\nmodel Later {\n  id String @id\n}\n`;
    const line = text.split("\n").findIndex((l, i, all) => l === "}" && all[i - 1] === '  id String @id @default("abc') + 1;
    await expectFatal({ files: { "prisma/schema.prisma": text } }, `${SCHEMA_PREFIX} a parenthesis or bracket is still open at line ${line}: the schema cannot be read reliably.`);
  });
  it("passes on the same relation naming id", async () => {
    await expectPass(addToNote('link ApiKey @relation(\n    name: "a)",\n    fields: [title],\n    references: [id]\n  )'));
  });
  const INDENTED_BLOCKS = [
    ["an indented view", "  view V {\n  id String @id\n}\n", "V"],
    ["an indented model with a unique hash field", "  model Foo {\n  id String @id\n  secretHash String @unique\n}\n", "Foo"],
    ["an indented digest model", '  model Tok {\n  id String @id\n  tokenHash String @unique @map("token_hash")\n}\n', "Tok"],
    ["an indented enum", "  enum E {\n  A\n}\n", "E"],
    ["an indented type", "  type T {\n  a String\n}\n", "T"],
    ["an indented datasource", "  datasource db {\n  provider = \"postgresql\"\n}\n", "db"],
    ["an indented generator", "  generator g {\n  provider = \"x\"\n}\n", "g"],
  ];
  it.each(INDENTED_BLOCKS)("is fatal on %s (the schema reader sees column-0 blocks only)", async (_label, block, name) => {
    await expectFatal({ files: { "prisma/schema.prisma": `${SCHEMA}\n${block}` } }, `${SCHEMA_PREFIX} ${name} opens an indented block: the schema reader sees blocks that start at column 0 only (run prisma format).`);
  });
  it("is fatal on a closing brace that is not at column 0", async () => {
    await expectFatal({ files: { "prisma/schema.prisma": `${SCHEMA}\nmodel Y {\n  id String @id\n  }\n` } }, `${SCHEMA_PREFIX} a closing brace is not at column 0: the schema reader would not end its block there (run prisma format).`);
  });
  const READABLE = [
    ["a string holding a closing brace", 'model Y {\n  id String @id @default(\n    "}"\n  )\n}\n'],
    ["a column-0 string line holding a closing brace", 'model Y {\n  id String @id @default(\n"}"\n)\n}\n'],
    ["a string holding a block header", 'model Y {\n  id String @id @default(\n    "model Q {"\n  )\n}\n'],
    ["fields named type and model inside a multi-line attribute", "model Y {\n  id String @id\n  type String\n  model String\n  @@index([\n    type,\n    model\n  ])\n}\n"],
  ];
  it.each(READABLE)("passes on %s", async (_label, block) => {
    await expectPass({ files: { "prisma/schema.prisma": `${SCHEMA}\n${block}` } });
  });
  it("is fatal on a bracket still open at the end of the file", async () => {
    await expectFatal({ files: { "prisma/schema.prisma": `${SCHEMA}\nmodel Y {\n  id String @id @default([1` } }, `${SCHEMA_PREFIX} a parenthesis or bracket is still open at the end of the file: the schema cannot be read reliably.`);
  });
  it("is fatal on a model whose brace is indented on the next line", async () => {
    await expectFatal({ files: { "prisma/schema.prisma": `${SCHEMA}\nmodel Z\n  {\n  id String @id\n}\n` } }, `${SCHEMA_PREFIX} Z opens its block on a later line: the schema reader cannot see it.`);
  });
  it("passes on a non-unique hash field followed by a composite @@unique that does not name it", async () => {
    await expectPass({ files: { "prisma/schema.prisma": swap(SCHEMA, 'model Note {\n  id    String @id\n  title String\n', 'model Note {\n  id    String @id\n  title String\n  slug String\n  contentHash String\n  @@unique([slug, title])\n') } });
  });

  const MIG = "prisma/migrations/20240201000000_extra/migration.sql";
  it("passes on a non-DO statement that merely holds an EXECUTE of a CREATE inside a string", async () => {
    await expectPass({ files: { [MIG]: "SELECT 1 FROM notes WHERE x = $$ EXECUTE 'CREATE VIEW v AS SELECT 1' $$;" } });
  });
  it("FAILS on a table name after a dollar sign inside a string (W5)", async () => {
    await expectViolations(viaUnsafe("SELECT 1 FROM notes WHERE x = '$api_keys'"), [ruleAt("W5", W.string("api_keys"))]);
  });
  it("passes on a table name that ends a longer word inside a string", async () => {
    await expectPass(viaUnsafe("SELECT 1 FROM notes WHERE x = 'x1api_keys'"));
  });
});

describe("stale fixture roots", () => {
  it("removes a root older than an hour and keeps a fresh one", () => {
    const stale = mkdtempSync(join(tmpdir(), ROOT_PREFIX));
    const fresh = mkdtempSync(join(tmpdir(), ROOT_PREFIX));
    const other = mkdtempSync(join(tmpdir(), "unrelated-"));
    try {
      const old = new Date(Date.now() - 2 * STALE_ROOT_MS);
      utimesSync(stale, old, old);
      utimesSync(other, old, old);
      sweepStaleRoots();
      expect(readdirSync(tmpdir())).not.toContain(stale.split("/").pop());
      expect(readdirSync(tmpdir())).toContain(fresh.split("/").pop());
      expect(readdirSync(tmpdir())).toContain(other.split("/").pop());
    } finally {
      for (const dir of [stale, fresh, other]) rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.concurrent("real repository", { timeout: 60_000 }, () => {
  it("passes against the real repo", async () => {
    const { exitCode, out } = await spawnGuard({ BEARER_PASSKEY_GATE_ROOT: "" });
    expect(exitCode, out).toBe(0);
    expect(out).toMatch(/analysed=[1-9]\d* /);
    expect(out).toMatch(/digest-keys=\d+ placed=\d+ floating=\d+/);
  });
});
