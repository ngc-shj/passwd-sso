/**
 * Self-test for scripts/checks/check-bearer-passkey-gate.mjs — the C7 gate
 * (plan: docs/archive/review/api-key-passkey-requirement-plan.md) that every
 * tokenHash/codeHash lookup is classified, that `per-use-gated` validators
 * really gate per use, and that only the three pinned call sites pass
 * `passkeyExemption`.
 *
 * Every refusal rule has a fixture the gate must FAIL on, paired with the
 * passing base fixture (or a named good variant) it differs from by that rule
 * alone, so each cell is able to fail for the reason it names. The gate is
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
  id      String   @id
  apiKeys ApiKey[]
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
}

model Note {
  id    String @id
  title String
}
`;

const GATE_IMPORT = `import { passkeyGateBlocks } from "@/lib/auth/policy/passkey-gate";`;

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

/** Write the base fixture into `root`, `files` overriding (null deletes) and `manifest` merged (null deletes). */
function fixture(root, { files = {}, manifest = {}, rawManifest } = {}) {
  const all = { ...BASE_FILES, ...files };
  for (const [rel, contents] of Object.entries(all)) {
    if (contents === null) continue;
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents, "utf8");
  }
  const entries = { ...BASE_MANIFEST, ...manifest };
  for (const [k, v] of Object.entries(entries)) if (v === null) delete entries[k];
  const full = join(root, MANIFEST);
  mkdirSync(dirname(full), { recursive: true });
  if (rawManifest !== null) writeFileSync(full, rawManifest ?? JSON.stringify({ functions: entries }, null, 2), "utf8");
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

describe.concurrent("check-bearer-passkey-gate.mjs — inputs", { timeout: 60_000 }, () => {
  it("passes on the base fixture and prints the analysed count", async () => {
    const { exitCode, out } = await run();
    expect(exitCode, out).toBe(0);
    expect(out).toMatch(/analysed=2 /);
  });

  it("FAILS when the schema declares no tokenHash/codeHash model", async () => {
    await expectFail({ files: { "prisma/schema.prisma": "model Note {\n  id String @id\n}\n" } }, /no model with a tokenHash\/codeHash field/);
  });

  it("FAILS when the manifest is missing", async () => {
    await expectFail({ rawManifest: null }, /manifest not found/);
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
    });
  });

  it("FAILS on a lookup at module scope (cannot be attributed)", async () => {
    await expectFail({ files: { "src/lib/other.ts": `void tx.apiKey.findFirst({ where: { tokenHash: "x" } });\n` } }, /cannot be attributed/);
  });
});

describe.concurrent("raw SQL", { timeout: 60_000 }, () => {
  const rawFile = (stmt) => `export async function q(tx: any, t: string) {\n  ${stmt}\n}\n`;

  it("passes on literal raw SQL that does not name a digest column", async () => {
    await expectPass({
      files: {
        "src/lib/raw.ts": rawFile(
          "await tx.$queryRaw`SELECT id FROM notes WHERE id = ${t}`; await tx.$executeRawUnsafe(\"SELECT 1\"); await tx.$executeRawUnsafe(renderSql(trustedSql`DELETE FROM notes`));",
        ),
      },
    });
  });

  it("FAILS on tagged raw SQL naming token_hash", async () => {
    await expectFail({ files: { "src/lib/raw.ts": rawFile("await tx.$queryRaw`SELECT id FROM api_keys WHERE token_hash = ${t}`;") } }, /names a digest column/);
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

  describe("refresh-bound", () => {
    const refreshFiles = {
      ...files,
      "src/lib/ttl.ts": "export const TOKEN_TTL = 3600;\nconst LOCAL_TTL = 1;\n",
      "src/lib/rotate.ts": "export function rotate(s: unknown) {\n  return withBypassRls(prisma, async () => {\n    if (passkeyEnforcementBlocks(s)) return null;\n  });\n}\nexport function ungated() {\n  return null;\n}\n",
      "src/app/api/token/route.ts": "export const POST = () => null;\n",
    };
    const entry = (over) => ({
      "src/lib/other.ts#lookup": {
        class: "refresh-bound",
        calls: 1,
        reason: REASON,
        refreshRoute: "src/app/api/token/route.ts",
        lifetime: "TOKEN_TTL",
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
      await expectFail({ files: refreshFiles, manifest: entry({ lifetime: "LOCAL_TTL" }) }, /lifetime "LOCAL_TTL" is not an exported const/);
    });

    it("FAILS when the inline gate does not call the passkey gate", async () => {
      await expectFail({ files: refreshFiles, manifest: entry({ inlineGate: "src/lib/rotate.ts#ungated" }) }, /relies on inline gate/);
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
    await expectFail(withBody([LOOKUP, GATE.replace("await ", ""), `  return { ok: true, data: key };`].join("\n")), NOT_GATED);
  });

  it("FAILS when the gate's consequent does not return ok: false", async () => {
    await expectFail(withBody([LOOKUP, `  if (await passkeyGateBlocks({ userId: key.userId })) {}`, `  return { ok: true, data: key };`].join("\n")), NOT_GATED);
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
    await expectPass(withBody(GATED_BODY.replace("passkeyGateBlocks(", "gate("), `import { passkeyGateBlocks as gate } from "../policy/passkey-gate";`));
  });

  it("passes when an ok: true return before the gate sits in a nested function", async () => {
    await expectPass(withBody([`  const fallback = () => ({ ok: true });`, `  void (() => { return { ok: true }; });`, GATED_BODY].join("\n")));
  });

  it("FAILS when the exemption wrapper tests something other than the function's own parameter", async () => {
    const ext = EXT_TOKEN.replace("if (!opts?.passkeyExemption)", "if (!globalOpts.passkeyExemption)");
    await expectFail({ files: { "src/lib/auth/tokens/extension-token.ts": ext } }, /NOT_GATED: src\/lib\/auth\/tokens\/extension-token\.ts#validateExtensionToken/);
  });

  it("FAILS when the exemption wrapper has an else branch", async () => {
    const ext = EXT_TOKEN.replace("  }\n  return { ok: true, data: token };", "  } else {\n    void 0;\n  }\n  return { ok: true, data: token };");
    expect(ext).toContain("} else {");
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
