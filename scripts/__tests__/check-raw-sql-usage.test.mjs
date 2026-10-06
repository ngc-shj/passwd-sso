/**
 * Table-driven regression tests for check-raw-sql-usage.mjs's Layer 2 AST
 * gate (plan: raw-sql-ident-branded-type, C3). Deny rows and their nearest
 * allow rows sit adjacent, grouped per rule, per the plan's completeness
 * rule: every rule and every clause of a rule has at least one deny row and
 * its nearest allow row. Each row runs the real CLI against an isolated
 * fixture tree (mkdtemp + RAW_SQL_CHECK_ROOT), never the tracked repo files.
 */

import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CHECKER = fileURLToPath(new URL("../checks/check-raw-sql-usage.mjs", import.meta.url));

const dirs = [];
afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop();
    rmSync(d, { recursive: true, force: true });
  }
});

function mkRoot() {
  const dir = mkdtempSync(join(tmpdir(), "raw-sql-check-"));
  dirs.push(dir);
  return dir;
}

// Layer 1 (unchanged, FR5) scans src/**/*.ts(x) and scripts/**/*.ts(x) by
// PLAIN TEXT for `\$(queryRaw|executeRaw)(Unsafe)?\b` and requires an
// allowlist entry. Rows that exercise Layer 2 almost always contain that
// text incidentally — auto-generate the matching Layer 1 entry so Layer 1
// stays quiet and the assertion is about Layer 2 alone, unless a row
// explicitly supplies its own `allowlist`.
const LAYER1_TEXT_RE = /\$(queryRaw|executeRaw)(Unsafe)?\b/;
function autoAllowlist(files) {
  const lines = [];
  for (const [rel, content] of Object.entries(files)) {
    if (!/^(src|scripts)\//.test(rel)) continue;
    if (!/\.tsx?$/.test(rel)) continue;
    if (LAYER1_TEXT_RE.test(content)) {
      lines.push(`${rel} # fixture purpose text intentionally over ten characters`);
    }
  }
  return lines.join("\n");
}

function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
}

function run(files, { allowlist } = {}) {
  const root = mkRoot();
  writeFiles(root, files);
  const allowlistFile = join(root, "fixture-allowlist.txt");
  writeFileSync(allowlistFile, (allowlist ?? autoAllowlist(files)) + "\n", "utf8");
  try {
    const stdout = execFileSync("node", [CHECKER], {
      env: { ...process.env, RAW_SQL_CHECK_ROOT: root, RAW_SQL_CHECK_ALLOWLIST: allowlistFile },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" };
  }
}

const RAW_SQL_IMPORT = `import { renderSql, trustedSql, sqlIdentifier, joinSql } from "@/lib/prisma/raw-sql";\n`;

describe("check-raw-sql-usage Layer 2 — UNSAFE_ARG", () => {
  const rows = [
    {
      name: "deny: renderSql(f).concat(x)",
      src: `${RAW_SQL_IMPORT}export function run(tx, f, x) {\n  return tx.$executeRawUnsafe(renderSql(f).concat(x));\n}\n`,
      expectCode: 1,
      expectReason: "UNSAFE_ARG",
    },
    {
      name: "deny: renderSql(f) + x",
      src: `${RAW_SQL_IMPORT}export function run(tx, f, x) {\n  return tx.$executeRawUnsafe(renderSql(f) + x);\n}\n`,
      expectCode: 1,
      expectReason: "UNSAFE_ARG",
    },
    {
      name: "deny: template wrapping renderSql(f)",
      src: `${RAW_SQL_IMPORT}export function run(tx, f, x) {\n  return tx.$executeRawUnsafe(\`\${renderSql(f)}\${x}\`);\n}\n`,
      expectCode: 1,
      expectReason: "UNSAFE_ARG",
    },
    {
      name: "deny: ternary first argument",
      src: `${RAW_SQL_IMPORT}export function run(tx, f, cond) {\n  return tx.$executeRawUnsafe(cond ? renderSql(f) : "SELECT 1");\n}\n`,
      expectCode: 1,
      expectReason: "UNSAFE_ARG",
    },
    {
      name: "deny: parenthesized callee (renderSql)(f)",
      src: `${RAW_SQL_IMPORT}export function run(tx, f) {\n  return tx.$executeRawUnsafe((renderSql)(f));\n}\n`,
      expectCode: 1,
      expectReason: "UNSAFE_ARG",
    },
    {
      name: "allow: string literal argument",
      src: `export function run(tx) {\n  return tx.$executeRawUnsafe("SELECT 1");\n}\n`,
      expectCode: 0,
    },
    {
      name: "allow: no-substitution template argument",
      src: "export function run(tx) {\n  return tx.$executeRawUnsafe(`SELECT 1`);\n}\n",
      expectCode: 0,
    },
    {
      name: "allow: direct renderSql(...) call",
      src: `${RAW_SQL_IMPORT}export function run(tx, f) {\n  return tx.$executeRawUnsafe(renderSql(f));\n}\n`,
      expectCode: 0,
    },
  ];

  for (const r of rows) {
    it(r.name, () => {
      const result = run({ "scripts/fixture.ts": r.src });
      expect(result.code).toBe(r.expectCode);
      if (r.expectReason) expect(result.stderr).toContain(r.expectReason);
      if (r.expectCode === 0) expect(result.stdout).toContain("check-raw-sql-usage: OK");
    });
  }
});

describe("check-raw-sql-usage Layer 2 — RAW_SQL_NAMES", () => {
  const rows = [
    {
      name: "allow: canonical alias-specifier import, renderSql as ordinary call",
      src: `${RAW_SQL_IMPORT}export function run(f) {\n  return renderSql(f);\n}\n`,
      expectCode: 0,
    },
    // F4-a: a callee/tag positionally shaped like renderSql(f) / trustedSql`…`
    // is allowed only when THIS file also canonically imports that name from
    // raw-sql.ts — position alone proves nothing about the binding.
    {
      name: "deny: renderSql(f) called without any import of renderSql from raw-sql.ts",
      src: `export function run(f) {\n  return renderSql(f);\n}\n`,
      expectCode: 1,
      expectReason: "RAW_SQL_NAMES",
    },
    {
      name: "deny: trustedSql`…` tagged without any import of trustedSql from raw-sql.ts",
      src: `export function run(a) {\n  return trustedSql\`SELECT \${a}\`;\n}\n`,
      expectCode: 1,
      expectReason: "RAW_SQL_NAMES",
    },
    // F4-b: a literal-keyed global forge never produces an Identifier
    // occurrence the scan above would see.
    {
      name: "deny: globalThis[\"renderSql\"] = fn (literal-keyed global forge)",
      src: `export function forge(fn) {\n  globalThis["renderSql"] = fn;\n}\n`,
      expectCode: 1,
      expectReason: "RAW_SQL_NAMES",
    },
    {
      name: "deny: Object.assign(globalThis, {\"trustedSql\": fn}) (literal-keyed global forge)",
      src: `export function forge(fn) {\n  Object.assign(globalThis, { "trustedSql": fn });\n}\n`,
      expectCode: 1,
      expectReason: "RAW_SQL_NAMES",
    },
    {
      name: "deny: Object.defineProperty(globalThis, 'sqlIdentifier', ...) (literal-keyed global forge)",
      src: `export function forge(fn) {\n  Object.defineProperty(globalThis, "sqlIdentifier", { value: fn });\n}\n`,
      expectCode: 1,
      expectReason: "RAW_SQL_NAMES",
    },
    // F4-c: a scanned file that SHADOWS raw-sql.ts's own module-resolution
    // candidate paths denies unconditionally — Node's real resolver would
    // load the shadow, not the TS source, for any specifier reaching it.
    {
      name: "deny: a shadow src/lib/prisma/raw-sql.js sibling file (innocuous content — isolates the shadow-path check from the name-occurrence check)",
      src: `export const placeholder = 1;\n`,
      path: "src/lib/prisma/raw-sql.js",
      expectCode: 1,
      expectReason: "RAW_SQL_NAMES",
    },
    {
      name: "deny: a shadow src/lib/prisma/raw-sql/index.ts directory module (innocuous content)",
      src: `export const placeholder = 1;\n`,
      path: "src/lib/prisma/raw-sql/index.ts",
      expectCode: 1,
      expectReason: "RAW_SQL_NAMES",
    },
    {
      name: "allow: relative specifier without extension",
      src: `import { renderSql } from "../../src/lib/prisma/raw-sql";\nexport function run(f) {\n  return renderSql(f);\n}\n`,
      path: "scripts/sub/fixture.ts",
      expectCode: 0,
    },
    {
      name: "allow: relative specifier with .js (TS/Node ESM extension-rewrite convention)",
      src: `import { renderSql } from "../lib/prisma/raw-sql.js";\nexport function run(f) {\n  return renderSql(f);\n}\n`,
      path: "src/workers/fixture.ts",
      expectCode: 0,
    },
    {
      name: "allow: relative specifier with .ts",
      src: `import { renderSql } from "../lib/prisma/raw-sql.ts";\nexport function run(f) {\n  return renderSql(f);\n}\n`,
      path: "src/workers/fixture.ts",
      expectCode: 0,
    },
    {
      name: "allow: trustedSql as tagged-template tag",
      src: `${RAW_SQL_IMPORT}export function run(a) {\n  return trustedSql\`SELECT \${a}\`;\n}\n`,
      expectCode: 0,
    },
    {
      name: "allow: sqlIdentifier ordinary call",
      src: `${RAW_SQL_IMPORT}export function run(a) {\n  return sqlIdentifier(a);\n}\n`,
      expectCode: 0,
    },
    {
      name: "allow: joinSql ordinary call",
      src: `${RAW_SQL_IMPORT}export function run(a, b) {\n  return joinSql(a, b);\n}\n`,
      expectCode: 0,
    },
    {
      name: "allow: type position (typeof renderSql)",
      src: `${RAW_SQL_IMPORT}type Fn = typeof renderSql;\nexport function run(f: Fn) {\n  return f;\n}\n`,
      expectCode: 0,
    },
    {
      name: "deny: local variable declaration named renderSql",
      src: `export function run() {\n  const renderSql = 1;\n  return renderSql;\n}\n`,
      expectCode: 1,
      expectReason: "RAW_SQL_NAMES",
    },
    {
      name: "deny: var-in-block declaration named trustedSql",
      src: `export function run() {\n  if (true) {\n    var trustedSql = 1;\n    return trustedSql;\n  }\n}\n`,
      expectCode: 1,
      expectReason: "RAW_SQL_NAMES",
    },
    {
      name: "deny: function declaration named sqlIdentifier",
      src: `export function sqlIdentifier() { return 1; }\n`,
      expectCode: 1,
      expectReason: "RAW_SQL_NAMES",
    },
    {
      name: "deny: class declaration named joinSql",
      src: `export class joinSql {}\n`,
      expectCode: 1,
      expectReason: "RAW_SQL_NAMES",
    },
    {
      name: "deny: function expression named renderSql",
      src: `export const f = function renderSql() { return 1; };\n`,
      expectCode: 1,
      expectReason: "RAW_SQL_NAMES",
    },
    {
      name: "deny: class expression named trustedSql",
      src: `export const C = class trustedSql {};\n`,
      expectCode: 1,
      expectReason: "RAW_SQL_NAMES",
    },
    {
      name: "deny: parameter named sqlIdentifier",
      src: `export function run(sqlIdentifier) {\n  return sqlIdentifier;\n}\n`,
      expectCode: 1,
      expectReason: "RAW_SQL_NAMES",
    },
    {
      name: "deny: catch binding named joinSql",
      src: `export function run() {\n  try {\n    throw new Error("x");\n  } catch (joinSql) {\n    return joinSql;\n  }\n}\n`,
      expectCode: 1,
      expectReason: "RAW_SQL_NAMES",
    },
    {
      name: "deny: namespace declaration named renderSql",
      src: `export namespace renderSql {\n  export const x = 1;\n}\n`,
      expectCode: 1,
      expectReason: "RAW_SQL_NAMES",
    },
    {
      name: "deny: import x = require() binding named trustedSql",
      src: `import trustedSql = require("./y");\nexport function run() { return trustedSql; }\n`,
      expectCode: 1,
      expectReason: "RAW_SQL_NAMES",
    },
    {
      name: "deny: trustedSql called as an ordinary function",
      src: `${RAW_SQL_IMPORT}export function run(a) {\n  return trustedSql(a);\n}\n`,
      expectCode: 1,
      expectReason: "RAW_SQL_NAMES",
    },
    {
      name: "deny: renderSql.call(...)",
      src: `${RAW_SQL_IMPORT}export function run(ctx, f) {\n  return renderSql.call(ctx, f);\n}\n`,
      expectCode: 1,
      expectReason: "RAW_SQL_NAMES",
    },
    {
      name: "deny: passing renderSql as an argument",
      src: `${RAW_SQL_IMPORT}export function run(apply, f) {\n  return apply(renderSql, f);\n}\n`,
      expectCode: 1,
      expectReason: "RAW_SQL_NAMES",
    },
    {
      name: "deny: re-export of renderSql",
      src: `${RAW_SQL_IMPORT}export { renderSql };\n`,
      expectCode: 1,
      expectReason: "RAW_SQL_NAMES",
    },
    {
      name: "deny: namespace import of raw-sql.ts",
      src: `import * as rawSql from "@/lib/prisma/raw-sql";\nexport function run(f) {\n  return rawSql.renderSql(f);\n}\n`,
      expectCode: 1,
      expectReason: "RAW_SQL_NAMES",
    },
    {
      name: "deny: default import of raw-sql.ts",
      src: `import rawSql from "@/lib/prisma/raw-sql";\nexport function run() {\n  return rawSql;\n}\n`,
      expectCode: 1,
      expectReason: "RAW_SQL_NAMES",
    },
    {
      name: "deny: export * from raw-sql.ts",
      src: `export * from "@/lib/prisma/raw-sql";\n`,
      expectCode: 1,
      expectReason: "RAW_SQL_NAMES",
    },
    {
      name: "deny: export * as ns from raw-sql.ts",
      src: `export * as ns from "@/lib/prisma/raw-sql";\n`,
      expectCode: 1,
      expectReason: "RAW_SQL_NAMES",
    },
    {
      name: "deny: require() of raw-sql.ts",
      src: `const rawSql = require("@/lib/prisma/raw-sql");\nexport function run() { return rawSql; }\n`,
      expectCode: 1,
      expectReason: "RAW_SQL_NAMES",
    },
    {
      name: "deny: dynamic import() of raw-sql.ts",
      src: `export async function run() {\n  return import("@/lib/prisma/raw-sql");\n}\n`,
      expectCode: 1,
      expectReason: "RAW_SQL_NAMES",
    },
    {
      name: "deny: import x = require(raw-sql.ts)",
      src: `import rawSql = require("@/lib/prisma/raw-sql");\nexport function run() { return rawSql; }\n`,
      expectCode: 1,
      expectReason: "RAW_SQL_NAMES",
    },
    // D-5 refinement: a non-literal import()/require() argument is no longer
    // a blanket residual — only a measured allowlist of specific files may do
    // this (see the NON_LITERAL_IMPORT describe block below). Outside that
    // allowlist it now denies.
    {
      name: "deny: non-literal import() argument outside the NON_LITERAL_IMPORT allowlist",
      src: `export async function run(moduleName) {\n  return import(moduleName);\n}\n`,
      expectCode: 1,
      expectReason: "NON_LITERAL_IMPORT",
    },
    {
      name: "deny: non-literal require() argument outside the NON_LITERAL_IMPORT allowlist",
      src: `export function run(moduleName) {\n  return require(moduleName);\n}\n`,
      expectCode: 1,
      expectReason: "NON_LITERAL_IMPORT",
    },
    {
      name: "deny: aliased import { renderSql as r }",
      src: `import { renderSql as r } from "@/lib/prisma/raw-sql";\nexport function run(tx, f) {\n  return tx.$queryRawUnsafe(r(f));\n}\n`,
      expectCode: 1,
      expectReason: "RAW_SQL_NAMES",
    },
    {
      name: "deny: string-named import { \"trustedSql\" as t }",
      src: `import { "trustedSql" as t } from "@/lib/prisma/raw-sql";\nexport function run(a) {\n  return t\`SELECT \${a}\`;\n}\n`,
      expectCode: 1,
      expectReason: "RAW_SQL_NAMES",
    },
    {
      name: "deny: string-named export { x as \"trustedSql\" }",
      src: `const x = 1;\nexport { x as "trustedSql" };\n`,
      expectCode: 1,
      expectReason: "RAW_SQL_NAMES",
    },
  ];

  for (const r of rows) {
    it(r.name, () => {
      const result = run({ [r.path ?? "scripts/fixture.ts"]: r.src });
      expect(result.code).toBe(r.expectCode);
      if (r.expectReason) expect(result.stderr).toContain(r.expectReason);
      if (r.expectCode === 0) expect(result.stdout).toContain("check-raw-sql-usage: OK");
    });
  }

  // F4-c (part 2): contrast case for "allow: relative specifier with .js"
  // above — when a REAL `raw-sql.js` sibling exists in the scanned tree, a
  // `.js` specifier must resolve to THAT file, never fall back to the TS/ESM
  // extension-rewrite guess that it's raw-sql.ts.
  it("deny: .js specifier does not resolve to raw-sql.ts when a real .js sibling shadow exists", () => {
    const result = run({
      "src/lib/prisma/raw-sql.js": `export function renderSql() {\n  return "forged";\n}\n`,
      "src/workers/fixture2.ts": `import { renderSql } from "../lib/prisma/raw-sql.js";\nexport function run(f) {\n  return renderSql(f);\n}\n`,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("RAW_SQL_NAMES");
  });
});

describe("check-raw-sql-usage Layer 2 — NON_LITERAL_IMPORT (D-5 refinement)", () => {
  it("allow: the exact allowlisted shape (src/i18n/messages.ts, 2 non-literal import() calls)", () => {
    const result = run({
      "src/i18n/messages.ts": `export async function a(ns) {\n  return import(\`../../messages/en/\${ns}.json\`);\n}\nexport async function b(ns) {\n  return import(\`../../messages/ja/\${ns}.json\`);\n}\n`,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("check-raw-sql-usage: OK");
  });

  it("deny: a count mismatch in an allowlisted file (measured set drifted)", () => {
    const result = run({
      "src/i18n/messages.ts": `export async function a(ns) {\n  return import(\`../../messages/en/\${ns}.json\`);\n}\n`,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("NON_LITERAL_IMPORT");
    expect(result.stderr).toContain("measured set drifted");
  });

  it("deny: a new computed import in a different, non-allowlisted file", () => {
    const result = run({
      "src/lib/other-loader.ts": `export async function run(moduleName) {\n  return import(moduleName);\n}\n`,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("NON_LITERAL_IMPORT");
  });
});

describe("check-raw-sql-usage Layer 2 — SPECIFIER_LITERAL", () => {
  const rows = [
    {
      name: "deny: createRequire(...)(\"@prisma/client\")",
      src: `import { createRequire } from "node:module";\nconst req = createRequire(import.meta.url);\nexport const client = req("@prisma/client");\n`,
      expectCode: 1,
      expectReason: "SPECIFIER_LITERAL",
    },
    {
      name: "deny: a variable holding the raw-sql specifier text",
      src: `export const spec = "@/lib/prisma/raw-sql";\n`,
      expectCode: 1,
      expectReason: "SPECIFIER_LITERAL",
    },
    {
      name: "deny: no-substitution template specifier to createRequire",
      src: "import { createRequire } from \"node:module\";\nconst req = createRequire(import.meta.url);\nexport const client = req(`@prisma/client`);\n",
      expectCode: 1,
      expectReason: "SPECIFIER_LITERAL",
    },
    {
      name: "deny: case-variant specifier text outside an import",
      src: `export const spec = "@PRISMA/client-runtime-utils";\n`,
      expectCode: 1,
      expectReason: "SPECIFIER_LITERAL",
    },
    // F2: segment-based (not start-anchored) matching — a relative path
    // reaching @prisma through node_modules still denies.
    {
      name: "deny: relative path reaching @prisma through node_modules (F2 segment match)",
      src: `import { raw } from "../../node_modules/@prisma/client/runtime/client.js";\nexport const r = raw;\n`,
      expectCode: 1,
      expectReason: "PRISMA_IMPORT",
    },
    {
      name: "deny: node_modules path segment in a require() specifier, no @prisma involved",
      src: `const pkg = require("../../node_modules/some-other-pkg");\nexport { pkg };\n`,
      expectCode: 1,
      expectReason: "SPECIFIER_LITERAL",
    },
    {
      name: "deny: a Prisma path segment nested inside a resolve() argument to import()",
      src: `import { resolve } from "node:path";\nexport async function run(root) {\n  return import(resolve(root, "node_modules/@prisma/client/runtime/client.js"));\n}\n`,
      expectCode: 1,
      expectReason: "SPECIFIER_LITERAL",
    },
    {
      name: "allow: the same literal AS the specifier of a static import",
      src: `import { PrismaClient } from "@prisma/client";\nexport const C = PrismaClient;\n`,
      expectCode: 0,
    },
    {
      name: "allow: \"prisma/config\" (no @, no leading dot — a real, unrelated package)",
      src: `import { defineConfig } from "prisma/config";\nexport const c = defineConfig;\n`,
      expectCode: 0,
    },
  ];

  for (const r of rows) {
    it(r.name, () => {
      const result = run({ "scripts/fixture.ts": r.src });
      expect(result.code).toBe(r.expectCode);
      if (r.expectReason) expect(result.stderr).toContain(r.expectReason);
      if (r.expectCode === 0) expect(result.stdout).toContain("check-raw-sql-usage: OK");
    });
  }
});

describe("check-raw-sql-usage Layer 2 — UNSCANNED_IMPORT", () => {
  it("deny: import of a *.test.ts file", () => {
    const result = run({
      "scripts/fixture.ts": `import { helper } from "./helper.test";\nexport const h = helper;\n`,
      "scripts/helper.test.ts": `export const helper = 1;\n`,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("UNSCANNED_IMPORT");
  });

  it("allow: import of scripts/manual-tests-helper.ts (near-miss, not under manual-tests/)", () => {
    const result = run({
      "scripts/fixture.ts": `import { helper } from "./manual-tests-helper";\nexport const h = helper;\n`,
      "scripts/manual-tests-helper.ts": `export const helper = 1;\n`,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("check-raw-sql-usage: OK");
  });

  it("allow: import of src/lib/latest-util.ts (near-miss, not *.test.*)", () => {
    const result = run({
      "scripts/fixture.ts": `import { helper } from "../src/lib/latest-util";\nexport const h = helper;\n`,
      "src/lib/latest-util.ts": `export const helper = 1;\n`,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("check-raw-sql-usage: OK");
  });

  // F3: the original scan covered only static import/export declarations —
  // require()/import() calls and `import x = require()` are other
  // module-loading forms that can launder a *.test.ts/*__tests__* helper.
  it("deny: require() of ./evil.test", () => {
    const result = run({
      "scripts/fixture.ts": `const helper = require("./evil.test");\nexport { helper };\n`,
      "scripts/evil.test.ts": `export const helper = 1;\n`,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("UNSCANNED_IMPORT");
  });

  it("deny: dynamic import() of ./__tests__/helper", () => {
    const result = run({
      "scripts/fixture.ts": `export async function run() {\n  return import("./__tests__/helper");\n}\n`,
      "scripts/__tests__/helper.ts": `export const helper = 1;\n`,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("UNSCANNED_IMPORT");
  });

  it("deny: import x = require(./evil.test)", () => {
    const result = run({
      "scripts/fixture.ts": `import helper = require("./evil.test");\nexport { helper };\n`,
      "scripts/evil.test.ts": `export const helper = 1;\n`,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("UNSCANNED_IMPORT");
  });

  it("allow: dynamic import(\"./latest-util\") (near-miss, not *.test.*)", () => {
    const result = run({
      "scripts/fixture.ts": `export async function run() {\n  return import("./latest-util");\n}\n`,
      "scripts/latest-util.ts": `export const helper = 1;\n`,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("check-raw-sql-usage: OK");
  });
});

describe("check-raw-sql-usage Layer 2 — RAW_METHOD", () => {
  const rows = [
    {
      name: "deny: computed bracket access tx[\"$queryRaw\"]",
      src: `export function run(tx) {\n  return tx["$queryRaw"]({ sql: "SELECT 1", values: [] });\n}\n`,
      expectCode: 1,
      expectReason: "RAW_METHOD",
    },
    {
      name: "deny: …Internal suffix property access",
      src: `export function run(tx) {\n  return tx.$queryRawInternal;\n}\n`,
      expectCode: 1,
      expectReason: "RAW_METHOD",
    },
    {
      name: "deny: …Typed suffix as callee of a call",
      src: `export function run(tx) {\n  return tx.$queryRawTyped();\n}\n`,
      expectCode: 1,
      expectReason: "RAW_METHOD",
    },
    {
      name: "deny: bare identifier reference to $executeRawUnsafe",
      src: `export function run($executeRawUnsafe) {\n  return $executeRawUnsafe;\n}\n`,
      expectCode: 1,
      expectReason: "RAW_METHOD",
    },
    {
      name: "deny: $queryRaw as callee of an ordinary (non-tagged) call",
      src: `export function run(tx) {\n  return tx.$queryRaw();\n}\n`,
      expectCode: 1,
      expectReason: "RAW_METHOD",
    },
    {
      name: "deny: literal value \"$queryRaw\" outside scripts/checks",
      src: `export const name = "$queryRaw";\n`,
      expectCode: 1,
      expectReason: "RAW_METHOD",
    },
    // T-F3: the literal-VALUE clause scans string AND no-substitution
    // template literals (checkRawMethod already includes both kinds) — this
    // row proves the backtick path specifically, next to the string-literal
    // deny row above.
    {
      name: "deny: backtick literal value `$queryRaw` (no-substitution template, not a tag)",
      src: "export const name = `$queryRaw`;\n",
      expectCode: 1,
      expectReason: "RAW_METHOD",
    },
    {
      name: "deny: escaped literal tx[\"\\x24queryRaw\"]",
      src: `export function run(tx) {\n  return tx["\\x24queryRaw"]\`SELECT 1\`;\n}\n`,
      expectCode: 1,
      expectReason: "RAW_METHOD",
    },
    {
      name: "allow: $queryRaw as the tag of a tagged template",
      src: "export function run(tx) {\n  return tx.$queryRaw`SELECT 1`;\n}\n",
      expectCode: 0,
    },
    {
      name: "allow: $executeRaw as the tag of a tagged template",
      src: "export function run(tx) {\n  return tx.$executeRaw`SELECT 1`;\n}\n",
      expectCode: 0,
    },
    {
      name: "allow: $queryRawUnsafe as the direct callee of a call",
      src: `export function run(tx) {\n  return tx.$queryRawUnsafe("SELECT 1");\n}\n`,
      expectCode: 0,
    },
    {
      name: "allow: $executeRawUnsafe as an optional-chained direct callee",
      src: `export function run(tx) {\n  return tx.$executeRawUnsafe?.("SELECT 1");\n}\n`,
      expectCode: 0,
    },
    {
      name: "allow: raw-method name as a string literal inside scripts/checks/",
      src: `export const name = "$queryRawUnsafe";\n`,
      path: "scripts/checks/fixture-literal.ts",
      expectCode: 0,
    },
    {
      name: "allow: type position Pick<X, \"$executeRaw\">",
      src: `type X = { $executeRaw: () => void };\nexport type Picked = Pick<X, "$executeRaw">;\n`,
      expectCode: 0,
    },
    {
      name: "allow: { $executeRaw: ... } type literal",
      src: `export type TxProbe = { $executeRaw: () => void };\n`,
      expectCode: 0,
    },
    {
      name: "allow: interface method signature named $queryRaw",
      src: `export interface TxProbe {\n  $queryRaw(): void;\n}\n`,
      expectCode: 0,
    },
  ];

  for (const r of rows) {
    it(r.name, () => {
      const result = run({ [r.path ?? "scripts/fixture.ts"]: r.src });
      expect(result.code).toBe(r.expectCode);
      if (r.expectReason) expect(result.stderr).toContain(r.expectReason);
      if (r.expectCode === 0) expect(result.stdout).toContain("check-raw-sql-usage: OK");
    });
  }
});

describe("check-raw-sql-usage Layer 2 — IMPORT_EQUALS_ENTITY (F1)", () => {
  const rows = [
    {
      name: "deny: import r = Prisma.raw",
      src: `import { Prisma } from "@prisma/client";\nimport r = Prisma.raw;\nexport { r };\n`,
      expectCode: 1,
      expectReason: "IMPORT_EQUALS_ENTITY",
    },
    {
      name: "deny: export import r = Prisma.raw inside a namespace",
      src: `import { Prisma } from "@prisma/client";\nexport namespace N {\n  export import r = Prisma.raw;\n}\n`,
      expectCode: 1,
      expectReason: "IMPORT_EQUALS_ENTITY",
    },
    {
      name: "allow: let t: Prisma.TransactionClient (a genuine TYPE position)",
      src: `import type { Prisma } from "@prisma/client";\nexport let t: Prisma.TransactionClient;\n`,
      expectCode: 0,
    },
  ];

  for (const r of rows) {
    it(r.name, () => {
      const result = run({ "scripts/fixture.ts": r.src });
      expect(result.code).toBe(r.expectCode);
      if (r.expectReason) expect(result.stderr).toContain(r.expectReason);
      if (r.expectCode === 0) expect(result.stdout).toContain("check-raw-sql-usage: OK");
    });
  }
});

describe("check-raw-sql-usage Layer 2 — PRISMA_IMPORT", () => {
  const rows = [
    {
      name: "deny: import { raw } from @prisma/client",
      src: `import { raw } from "@prisma/client";\nexport const r = raw;\n`,
      expectCode: 1,
      expectReason: "PRISMA_IMPORT",
    },
    {
      name: "deny: aliased value import { raw as r }",
      src: `import { raw as r } from "@prisma/client";\nexport const x = r;\n`,
      expectCode: 1,
      expectReason: "PRISMA_IMPORT",
    },
    {
      name: "deny: import from @prisma/client-runtime-utils",
      src: `import { raw } from "@prisma/client-runtime-utils";\nexport const r = raw;\n`,
      expectCode: 1,
      expectReason: "PRISMA_IMPORT",
    },
    {
      name: "deny: namespace import of @prisma/client",
      src: `import * as PrismaNS from "@prisma/client";\nexport const C = PrismaNS;\n`,
      expectCode: 1,
      expectReason: "PRISMA_IMPORT",
    },
    {
      name: "deny: default import of @prisma/client",
      src: `import P from "@prisma/client";\nexport const x = P;\n`,
      expectCode: 1,
      expectReason: "PRISMA_IMPORT",
    },
    {
      name: "deny: a new, unauthorized @prisma/adapter-pg importer",
      src: `import { PrismaPg } from "@prisma/adapter-pg";\nexport const a = PrismaPg;\n`,
      expectCode: 1,
      expectReason: "PRISMA_IMPORT",
    },
    {
      name: "deny: Prisma.raw(x)",
      src: `import { Prisma } from "@prisma/client";\nexport function run(x) {\n  return Prisma.raw(x);\n}\n`,
      expectCode: 1,
      expectReason: "PRISMA_IMPORT",
    },
    {
      name: "deny: Prisma.sql",
      src: `import { Prisma } from "@prisma/client";\nexport const s = Prisma.sql;\n`,
      expectCode: 1,
      expectReason: "PRISMA_IMPORT",
    },
    {
      name: "deny: Prisma[\"raw\"] computed access",
      src: `import { Prisma } from "@prisma/client";\nexport const r = Prisma["raw"];\n`,
      expectCode: 1,
      expectReason: "PRISMA_IMPORT",
    },
    {
      name: "deny: const { raw } = Prisma after a legitimate import",
      src: `import { Prisma } from "@prisma/client";\nconst { raw } = Prisma;\nexport const r = raw;\n`,
      expectCode: 1,
      expectReason: "PRISMA_IMPORT",
    },
    {
      name: "deny: const P = Prisma aliasing the whole namespace value",
      src: `import { Prisma } from "@prisma/client";\nconst P = Prisma;\nexport const x = P;\n`,
      expectCode: 1,
      expectReason: "PRISMA_IMPORT",
    },
    {
      name: "deny: Prisma.dmmf",
      src: `import { Prisma } from "@prisma/client";\nexport const models = Prisma.dmmf;\n`,
      expectCode: 1,
      expectReason: "PRISMA_IMPORT",
    },
    {
      name: "deny: Prisma.DbNull",
      src: `import { Prisma } from "@prisma/client";\nexport const n = Prisma.DbNull;\n`,
      expectCode: 1,
      expectReason: "PRISMA_IMPORT",
    },
    {
      name: "deny: Prisma.JsonNull",
      src: `import { Prisma } from "@prisma/client";\nexport const n = Prisma.JsonNull;\n`,
      expectCode: 1,
      expectReason: "PRISMA_IMPORT",
    },
    {
      name: "deny: Prisma.AnyNull",
      src: `import { Prisma } from "@prisma/client";\nexport const n = Prisma.AnyNull;\n`,
      expectCode: 1,
      expectReason: "PRISMA_IMPORT",
    },
    {
      name: "deny: case-variant @PRISMA/client-runtime-utils specifier",
      src: `import { raw } from "@PRISMA/client-runtime-utils";\nexport const r = raw;\n`,
      expectCode: 1,
      expectReason: "PRISMA_IMPORT",
    },
    {
      name: "allow: import type { AuditLog } from @prisma/client",
      src: `import type { AuditLog } from "@prisma/client";\nexport type A = AuditLog;\n`,
      expectCode: 0,
    },
    {
      name: "allow: import { PrismaClient, Prisma } from @prisma/client",
      src: `import { PrismaClient, Prisma } from "@prisma/client";\nexport const C = PrismaClient;\nexport function isKnown(e) {\n  return e instanceof Prisma.PrismaClientKnownRequestError;\n}\n`,
      expectCode: 0,
    },
    {
      name: "allow: Prisma.PrismaClientKnownRequestError",
      src: `import { Prisma } from "@prisma/client";\nexport function isKnown(e) {\n  return e instanceof Prisma.PrismaClientKnownRequestError;\n}\n`,
      expectCode: 0,
    },
    {
      name: "allow: Prisma.PrismaClientInitializationError",
      src: `import { Prisma } from "@prisma/client";\nexport function isInit(e) {\n  return e instanceof Prisma.PrismaClientInitializationError;\n}\n`,
      expectCode: 0,
    },
    {
      name: "allow: @prisma/adapter-pg in an already-authorized file",
      src: `import { PrismaPg } from "@prisma/adapter-pg";\nexport const a = PrismaPg;\n`,
      path: "src/lib/prisma.ts",
      expectCode: 0,
    },
  ];

  for (const r of rows) {
    it(r.name, () => {
      const result = run({ [r.path ?? "scripts/fixture.ts"]: r.src });
      expect(result.code).toBe(r.expectCode);
      if (r.expectReason) expect(result.stderr).toContain(r.expectReason);
      if (r.expectCode === 0) expect(result.stdout).toContain("check-raw-sql-usage: OK");
    });
  }

  it("allow: an enum imported as a value, declared in schema.prisma", () => {
    const result = run({
      "scripts/fixture.ts": `import { EntryType } from "@prisma/client";\nexport const e = EntryType;\n`,
      "prisma/schema.prisma": `enum EntryType {\n  LOGIN\n  NOTE\n}\n`,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("check-raw-sql-usage: OK");
  });

  it("deny (fail closed, unconditional): a schema enum named after a non-enum @prisma/client export", () => {
    const result = run({
      "scripts/fixture.ts": `export const x = 1;\n`,
      "prisma/schema.prisma": `enum raw {\n  A\n  B\n}\n`,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("PRISMA_ENUM_NAME_COLLISION");
  });
});

describe("check-raw-sql-usage Layer 2 — PRISMA_EXTENDS", () => {
  const rows = [
    {
      name: "deny: prisma.$extends(...)",
      src: `export function run(prisma, ext) {\n  return prisma.$extends(ext);\n}\n`,
      expectCode: 1,
      expectReason: "PRISMA_EXTENDS",
    },
    {
      name: "deny: prisma[\"$extends\"]",
      src: `export function run(prisma, ext) {\n  return prisma["$extends"](ext);\n}\n`,
      expectCode: 1,
      expectReason: "PRISMA_EXTENDS",
    },
    {
      name: "deny: bare \"$extends\" literal",
      src: `export const name = "$extends";\n`,
      expectCode: 1,
      expectReason: "PRISMA_EXTENDS",
    },
    {
      name: "allow: a near-miss name ($extend, no s)",
      src: `export function run(prisma) {\n  return prisma.$extend;\n}\n`,
      expectCode: 0,
    },
  ];

  for (const r of rows) {
    it(r.name, () => {
      const result = run({ "scripts/fixture.ts": r.src });
      expect(result.code).toBe(r.expectCode);
      if (r.expectReason) expect(result.stderr).toContain(r.expectReason);
      if (r.expectCode === 0) expect(result.stdout).toContain("check-raw-sql-usage: OK");
    });
  }
});

describe("check-raw-sql-usage Layer 2 — scope (per-extension, root, prisma/)", () => {
  const unsafeArgViolation = `export function run(tx, x) {\n  return tx.$executeRawUnsafe(\`SELECT \${x}\`);\n}\n`;

  for (const ext of ["mts", "cts", "js", "jsx", "mjs", "cjs"]) {
    it(`fails for the same reason (UNSAFE_ARG) on a .${ext} sibling`, () => {
      const result = run({ [`scripts/fixture.${ext}`]: unsafeArgViolation });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("UNSAFE_ARG");
    });
  }

  it("scans a violating file directly at the repository root", () => {
    const result = run({ "fixture-root.ts": unsafeArgViolation });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("UNSAFE_ARG");
  });

  it("scans a violating file under prisma/", () => {
    const result = run({ "prisma/fixture.ts": unsafeArgViolation });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("UNSAFE_ARG");
  });
});

describe("check-raw-sql-usage Layer 2 — fail-closed structural checks", () => {
  it("fails closed on an empty scan root (0 files)", () => {
    const result = run({});
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("ZERO_FILES_SCANNED");
  });

  it("fails closed on an unparsable file", () => {
    const result = run({ "scripts/broken.ts": "export function run( {\n  return\n" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("PARSE_ERROR");
  });

  // F6: a symlink entry under a scan root has Dirent.isFile() === false (its
  // own lstat type is "symlink"), so the original scan silently DROPPED it —
  // it must fail closed with a named reason instead.
  it("fails closed on a symlink under a Layer 2 scan root (SYMLINK_SCAN_TARGET)", () => {
    const root = mkRoot();
    writeFiles(root, { "scripts/real.ts": `export const x = 1;\n` });
    symlinkSync(join(root, "scripts/real.ts"), join(root, "scripts/linked.ts"));
    const allowlistFile = join(root, "fixture-allowlist.txt");
    writeFileSync(allowlistFile, "\n", "utf8");
    let result;
    try {
      const stdout = execFileSync("node", [CHECKER], {
        env: { ...process.env, RAW_SQL_CHECK_ROOT: root, RAW_SQL_CHECK_ALLOWLIST: allowlistFile },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      result = { code: 0, stdout, stderr: "" };
    } catch (e) {
      result = { code: e.status, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" };
    }
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("SYMLINK_SCAN_TARGET");
  });
});

describe("check-raw-sql-usage Layer 1 — unchanged allowlist behaviour (FR5 regression)", () => {
  it("fails MISSING_FROM_ALLOWLIST when a matching file is not listed", () => {
    const result = run(
      { "scripts/fixture.ts": `export function run(tx) {\n  return tx.$executeRawUnsafe("SELECT 1");\n}\n` },
      { allowlist: "" },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("MISSING_FROM_ALLOWLIST");
  });

  it("fails STALE_EXEMPT when a listed file no longer matches", () => {
    const result = run(
      { "scripts/fixture.ts": `export const x = 1;\n` },
      { allowlist: "scripts/fixture.ts # a purpose that is long enough" },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("STALE_EXEMPT");
  });

  it("fails to parse a leftover ident-markers=N suffix (grammar removed)", () => {
    const result = run(
      { "scripts/fixture.ts": `export function run(tx) {\n  return tx.$executeRawUnsafe("SELECT 1");\n}\n` },
      { allowlist: "scripts/fixture.ts # a purpose that is long enough # ident-markers=1" },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("LEFTOVER_SUFFIX");
  });

  it("passes on a clean, fully allowlisted, non-violating file", () => {
    const result = run({
      "scripts/fixture.ts": `export function run(tx) {\n  return tx.$executeRawUnsafe("SELECT 1");\n}\n`,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("check-raw-sql-usage: OK");
  });
});

describe("check-raw-sql-usage Layer 2 — exemption self-tests (T-F1, T-F2)", () => {
  // T-F1: a realistic raw-sql.ts fixture, at the exact exempt path, holding
  // all four declarations — proves the RAW_SQL_NAMES / shadow-file / literal
  // exemption for rel === RAW_SQL_MODULE_REL on content shaped like the real
  // module, not just an empty or unrelated file at that path.
  it("allow: a fixture at src/lib/prisma/raw-sql.ts declaring the four names (exemption proven on realistic content)", () => {
    const result = run({
      "src/lib/prisma/raw-sql.ts": [
        'export function sqlIdentifier(name) { return name; }',
        'export function trustedSql(strings, ...parts) { return strings.join(""); }',
        'export function joinSql(parts, sep) { return parts.join(sep); }',
        "export function renderSql(fragment) { return fragment; }",
        "",
      ].join("\n"),
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("check-raw-sql-usage: OK");
  });

  // T-F2: a fixture AT the gate's own path (within the fixture root — not the
  // real tracked file) holding a bare raw-sql specifier literal — proves the
  // GATE_SELF_REL exemption (checkSpecifierLiteral / checkNodeModulesSpecifier
  // / checkRawSqlNameLiterals) fires on the file's PATH, not on some
  // assumption about its actual content.
  it("allow: a fixture at scripts/checks/check-raw-sql-usage.mjs holding a bare raw-sql path literal", () => {
    const result = run({
      "scripts/checks/check-raw-sql-usage.mjs": 'export const spec = "@/lib/prisma/raw-sql";\n',
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("check-raw-sql-usage: OK");
  });
});
