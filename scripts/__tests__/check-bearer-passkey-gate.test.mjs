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
 */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GUARD = join(REPO_ROOT, "scripts/checks/check-bearer-passkey-gate.mjs");
const MANIFEST = "scripts/checks/bearer-passkey-gate-manifest.json";

const SCHEMA = `
model User {
  id        String     @id
  apiKeys   ApiKey[]
  authCodes AuthCode[]
}

model Profile {
  id     String @id
  userId String
  user   User   @relation(fields: [userId], references: [id])
}

model ApiKey {
  id        String @id
  tokenHash String @unique @map("token_hash")
  userId    String
  user      User   @relation(fields: [userId], references: [id])
}

model ExtensionToken {
  id        String @id
  tokenHash String @unique
}

model AuthCode {
  id       String @id
  codeHash String @unique
  userId   String
  user     User   @relation(fields: [userId], references: [id])
}

model Note {
  id    String @id
  title String
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

const BASE_FILES = {
  "prisma/schema.prisma": SCHEMA,
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
 * `models` merged over the base functions / models (null deletes).
 */
function fixture(root, { files = {}, manifest = {}, models = {}, rawManifest } = {}) {
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
  const body = { functions: merged(BASE_MANIFEST, manifest), models: merged(BASE_MODELS, models) };
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

/** Each cell gets its own fixture root, so cells can run concurrently. */
async function run(options) {
  const root = mkdtempSync(join(tmpdir(), "bearer-passkey-gate-"));
  try {
    fixture(root, options);
    return await spawnGuard({ BEARER_PASSKEY_GATE_ROOT: root });
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

  it("passes on a digest written as data (a write, not a lookup)", async () => {
    await expectPass(other(`await x.create({ data: { tokenHash: t } });\n  return x.update({ where: { id: t }, data: { tokenHash: t } });`));
  });

  it("FAILS on a replacedByHash key in a where (the rotation successor's digest)", async () => {
    await expectFail(other(`return x.findFirst({ where: { replacedByHash: t } });`), LOOKUP_IN_OTHER);
  });

  it("passes on a replacedByHash written as data (the rotation CAS, a write)", async () => {
    await expectPass(other(`return x.updateMany({ where: { id: t, rotatedAt: null }, data: { replacedByHash: t } });`));
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

  it("passes on a computed key bound by let on an unresolved receiver (declared residual: unread)", async () => {
    await expectPass(other(`let k = "tokenHash";\n  return x.findFirst({ where: { [k]: t } });`));
  });

  it("passes on a digest key outside any filter position", async () => {
    await expectPass(other(`return log({ meta: { tokenHash: t }, orderBy: { tokenHash: "asc" } });`));
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

describe.concurrent("real repository", { timeout: 60_000 }, () => {
  it("passes against the real repo", async () => {
    const { exitCode, out } = await spawnGuard({ BEARER_PASSKEY_GATE_ROOT: "" });
    expect(exitCode, out).toBe(0);
    expect(out).toMatch(/analysed=[1-9]\d* /);
  });
});
