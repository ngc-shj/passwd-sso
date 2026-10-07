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

// F-R2-1: the gate's NON_LITERAL_IMPORT_ALLOWLIST (scripts/checks/check-raw-
// sql-usage.mjs) now denies if any of its three entries is MISSING from the
// Layer 2 scan — true on the real tree, but every isolated fixture tree
// below is its own mini-tree that normally holds none of these three real
// paths at all. Auto-inject a benign stand-in for each, with the right
// non-literal import() COUNT, into every fixture by default — unless a row
// supplies its own file at that path (to exercise the count-mismatch check)
// or explicitly omits it via `omitNonLiteralImportFiles` (to exercise the
// stale-key check). Keep the paths/counts here in sync with the real
// NON_LITERAL_IMPORT_ALLOWLIST.
const NON_LITERAL_IMPORT_ALLOWLIST_STUBS = {
  "scripts/check-env-docs.ts": 4,
  "src/i18n/messages.ts": 2,
  "src/lib/crypto/crypto-client.ts": 1,
};
function stubWithNonLiteralImportCalls(n) {
  const lines = [];
  for (let i = 0; i < n; i++) {
    lines.push(`export async function fn${i}(mod) {\n  return import(mod);\n}\n`);
  }
  return lines.join("");
}
function withNonLiteralImportStubs(files, omit = []) {
  const merged = { ...files };
  for (const [path, count] of Object.entries(NON_LITERAL_IMPORT_ALLOWLIST_STUBS)) {
    if (path in merged) continue; // row supplies its own content for this path
    if (omit.includes(path)) continue; // row proves the stale-key check
    merged[path] = stubWithNonLiteralImportCalls(count);
  }
  return merged;
}

// Round 4: a canonical raw-sql.ts import is credited only when the on-disk
// resolver lands exactly on src/lib/prisma/raw-sql.ts, so every fixture tree
// holds a stand-in at that path unless the row supplies its own (or opts out
// with `omitRawSqlModule` to prove that a missing target earns no credit).
const RAW_SQL_MODULE_STUB = [
  "export function sqlIdentifier(name) { return name; }",
  'export function trustedSql(strings, ...parts) { return strings.join(""); }',
  "export function joinSql(parts, sep) { return parts.join(sep); }",
  "export function renderSql(fragment) { return fragment; }",
  "",
].join("\n");
function withRawSqlModuleStub(files, omit) {
  if (omit || "src/lib/prisma/raw-sql.ts" in files) return files;
  return { ...files, "src/lib/prisma/raw-sql.ts": RAW_SQL_MODULE_STUB };
}

// Round 6 (S-R6-1): the gate fails closed (RESOLUTION_CONFIG) unless the
// root tsconfig.json maps exactly `@/*` → `./src/*` with no baseUrl and the
// root package.json has no imports/exports/main, so every fixture tree holds
// stand-ins matching the real files unless the row supplies its own (or opts
// out with `omitResolutionConfig`).
const RESOLUTION_CONFIG_STUBS = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, paths: { "@/*": ["./src/*"] } } }),
  "package.json": JSON.stringify({ name: "fixture", private: true }),
};
function withResolutionConfigStubs(files, omit) {
  if (omit) return files;
  return { ...RESOLUTION_CONFIG_STUBS, ...files };
}

function run(
  files,
  { allowlist, omitNonLiteralImportFiles, skipAllowlistStubs, omitRawSqlModule, omitResolutionConfig } = {},
) {
  const root = mkRoot();
  const merged = skipAllowlistStubs
    ? files
    : withResolutionConfigStubs(
        withRawSqlModuleStub(withNonLiteralImportStubs(files, omitNonLiteralImportFiles), omitRawSqlModule),
        omitResolutionConfig,
      );
  writeFiles(root, merged);
  const allowlistFile = join(root, "fixture-allowlist.txt");
  writeFileSync(allowlistFile, (allowlist ?? autoAllowlist(merged)) + "\n", "utf8");
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
    // Split in two mechanisms: a `raw-sql.<ext>` SIBLING FILE (checked via
    // RAW_SQL_SHADOW_PATHS, any scanned extension other than `.ts`), and the
    // `src/lib/prisma/raw-sql/` DIRECTORY itself (checked directly against
    // the filesystem by checkRawSqlDirectoryShadow, S-R3-1b — extension-
    // agnostic, since a directory's package.json "main" can point anywhere).
    {
      name: "deny: a shadow src/lib/prisma/raw-sql.js sibling file (innocuous content — isolates the shadow-path check from the name-occurrence check)",
      src: `export const placeholder = 1;\n`,
      path: "src/lib/prisma/raw-sql.js",
      expectCode: 1,
      expectReason: "RAW_SQL_NAMES",
    },
    {
      name: "deny: src/lib/prisma/raw-sql/ exists as a directory (S-R3-1b; innocuous index.ts content)",
      src: `export const placeholder = 1;\n`,
      path: "src/lib/prisma/raw-sql/index.ts",
      expectCode: 1,
      expectReason: "RAW_SQL_NAMES",
    },
    // N2 (SIBLING-FILE set only): must cover every scanned extension other
    // than `.ts` — Next/esbuild resolve `.tsx` before `.ts`.
    {
      name: "deny: a shadow src/lib/prisma/raw-sql.tsx sibling file (N2 — Next/esbuild resolve .tsx before .ts)",
      src: `export const placeholder = 1;\n`,
      path: "src/lib/prisma/raw-sql.tsx",
      expectCode: 1,
      expectReason: "RAW_SQL_NAMES",
    },
    // Round-3 Testing [Minor]: these two used to carry an "(N2)" label, but
    // they are a directory (not a sibling-extension file) — the "(N2)"
    // per-extension claim never applied to them; they are now denied by the
    // extension-agnostic directory check (S-R3-1b), which would fire the
    // same way for ANY content, including a `.ts` index file.
    {
      name: "deny: src/lib/prisma/raw-sql/ exists as a directory, .tsx index content (S-R3-1b — extension-agnostic, not an N2 per-extension case)",
      src: `export const placeholder = 1;\n`,
      path: "src/lib/prisma/raw-sql/index.tsx",
      expectCode: 1,
      expectReason: "RAW_SQL_NAMES",
    },
    {
      name: "deny: src/lib/prisma/raw-sql/ exists as a directory, .js index content (S-R3-1b — extension-agnostic, not an N2 per-extension case)",
      src: `export const placeholder = 1;\n`,
      path: "src/lib/prisma/raw-sql/index.js",
      expectCode: 1,
      expectReason: "RAW_SQL_NAMES",
    },
    {
      name: "allow: a src/lib/prisma/raw-sql.test.ts sibling (excluded from the Layer 2 scan entirely by *.test.* — not a shadow path either)",
      src: `export const placeholder = 1;\n`,
      path: "src/lib/prisma/raw-sql.test.ts",
      expectCode: 0,
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
    // S-R3-1(a): a specifier whose last raw segment is empty or "." forces
    // directory resolution — Node never tries the raw-sql.ts FILE candidate
    // for this shape, so it must never be credited as a canonical import.
    // Red-proof: drop the `specifierEndsAsDirectory` check in
    // resolvesToRawSqlModule — both rows flip to allow.
    {
      name: "deny: import from \"@/lib/prisma/raw-sql/\" (trailing slash forces directory resolution, never credited as canonical) (S-R3-1a)",
      src: `import { renderSql } from "@/lib/prisma/raw-sql/";\nexport function run(tx, f) {\n  return tx.$queryRawUnsafe(renderSql(f));\n}\n`,
      expectCode: 1,
      expectReason: "RAW_SQL_NAMES",
    },
    {
      name: "deny: import from \"./raw-sql/.\" inside src/lib/prisma (trailing dot segment forces directory resolution) (S-R3-1a)",
      src: `import { renderSql } from "./raw-sql/.";\nexport function run(f) {\n  return renderSql(f);\n}\n`,
      path: "src/lib/prisma/fixture.ts",
      expectCode: 1,
      expectReason: "RAW_SQL_NAMES",
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

  // S-R3-1(b): a directory denies on its mere EXISTENCE, regardless of what
  // is (or is not) inside it — a package.json "main" could point at an
  // unscanned file (e.g. a *.test.ts forging renderSql) that never reaches
  // any other check in this gate, since package.json is not in LAYER2_EXTS
  // and the directory holds no scanned index file at all here.
  it("deny: src/lib/prisma/raw-sql/ exists as a directory holding only package.json (no scanned index file) (S-R3-1b)", () => {
    const result = run({
      "src/lib/prisma/raw-sql/package.json": JSON.stringify({
        main: "../../../__tests__/forged-render-sql.test.ts",
      }),
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

  // Testing: allow + count-mismatch deny rows for the other two allowlisted
  // files, mirroring the messages.ts rows above.
  it("allow: the exact allowlisted shape (scripts/check-env-docs.ts, 4 non-literal import() calls)", () => {
    const result = run({
      "scripts/check-env-docs.ts": `export async function a(mod) {\n  return import(mod);\n}\nexport async function b(mod) {\n  return import(mod);\n}\nexport async function c(mod) {\n  return import(mod);\n}\nexport async function d(mod) {\n  return import(mod);\n}\n`,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("check-raw-sql-usage: OK");
  });

  it("deny: a count mismatch in scripts/check-env-docs.ts (measured set drifted)", () => {
    const result = run({
      "scripts/check-env-docs.ts": `export async function a(mod) {\n  return import(mod);\n}\n`,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("NON_LITERAL_IMPORT");
    expect(result.stderr).toContain("measured set drifted");
  });

  it("allow: the exact allowlisted shape (src/lib/crypto/crypto-client.ts, 1 non-literal import() call)", () => {
    const result = run({
      "src/lib/crypto/crypto-client.ts": `export async function a(mod) {\n  return import(mod);\n}\n`,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("check-raw-sql-usage: OK");
  });

  it("deny: a count mismatch in src/lib/crypto/crypto-client.ts (measured set drifted)", () => {
    const result = run({
      "src/lib/crypto/crypto-client.ts": `export const x = 1;\n`,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("NON_LITERAL_IMPORT");
    expect(result.stderr).toContain("measured set drifted");
  });

  // F-R2-1: a deleted/renamed allowlisted file was never detected — the
  // per-file count-mismatch check only runs for files that ARE still
  // scanned. Omit one allowlisted path entirely (the other two stay present
  // via the default stub injection) and expect the stale-key deny, named by
  // path; the adjacent allow row proves normal operation (all three
  // present) stays clean.
  it("deny: a stale NON_LITERAL_IMPORT_ALLOWLIST entry (allowlisted file deleted/renamed)", () => {
    const result = run({}, { omitNonLiteralImportFiles: ["src/i18n/messages.ts"] });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("NON_LITERAL_IMPORT");
    expect(result.stderr).toContain("src/i18n/messages.ts");
    expect(result.stderr).toContain("allowlisted path no longer exists in the Layer 2 scan");
  });

  it("allow: all three NON_LITERAL_IMPORT_ALLOWLIST files present with the right counts", () => {
    const result = run({});
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("check-raw-sql-usage: OK");
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
    // Round-3 Testing [Major]: checkNodeModulesSpecifier is scoped to
    // MODULE-SPECIFIER POSITION literals only (isModuleSpecifierPositionLiteral)
    // — an EXACT "node_modules" path segment outside that position must not
    // deny. (The previous version of this row — `"scanning node_modules/foo
    // for a stale cache"` — had no exact "node_modules" segment at all:
    // hasNodeModulesSegment would return false regardless of the position
    // guard, so the row proved nothing about position-scoping specifically.
    // Red-proof: delete the `isModuleSpecifierPositionLiteral` guard in
    // checkNodeModulesSpecifier — THIS row then flips to deny.)
    {
      name: "allow: an exact \"node_modules\" path segment in a non-specifier-position string literal (position-scoping proof)",
      src: `export const p = "foo/node_modules/bar";\n`,
      expectCode: 0,
    },
    // Decided and pinned: isModuleSpecifierPositionLiteral checks ONLY
    // arguments()[0] of a require()/import() call — a second argument is
    // inert at runtime (real Node.js require() ignores extra arguments), so
    // leaving it unchecked is not a laundering vector and stays allowed.
    {
      name: "allow: require(\"x\", \"node_modules/y\") — second argument is not position-0, and is inert at runtime",
      src: `const pkg = require("x", "node_modules/y");\nexport { pkg };\n`,
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

  // N1: a loader reached under another name still spells its target as an
  // ordinary literal — none of these four call shapes is a direct
  // `require(...)`/`import(...)` call, so only the blanket
  // checkUnscannedLiteralAnywhere scan (not the call-shape-specific checks
  // above) catches them. Each deny sits next to an allow using the SAME
  // loader shape over a benign path.
  it("deny: createRequire(...)(...) loader with a literal *.test specifier", () => {
    const result = run({
      "scripts/fixture.ts": `import { createRequire } from "node:module";\nconst req = createRequire(import.meta.url);\nexport const h = req("./h.test");\n`,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("UNSCANNED_IMPORT");
  });

  it("allow: createRequire(...)(...) loader with a benign specifier", () => {
    const result = run({
      "scripts/fixture.ts": `import { createRequire } from "node:module";\nconst req = createRequire(import.meta.url);\nexport const h = req("./h");\n`,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("check-raw-sql-usage: OK");
  });

  it("deny: module.require(...) with a literal *.test specifier", () => {
    const result = run({
      "scripts/fixture.ts": `export const h = module.require("./h.test");\n`,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("UNSCANNED_IMPORT");
  });

  it("allow: module.require(...) with a benign specifier (near-miss, not *.test.*)", () => {
    const result = run({
      "scripts/fixture.ts": `export const h = module.require("./latest-util");\n`,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("check-raw-sql-usage: OK");
  });

  it("deny: require.call(...) with a literal *.test specifier", () => {
    const result = run({
      "scripts/fixture.ts": `export const h = require.call(null, "./h.test");\n`,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("UNSCANNED_IMPORT");
  });

  it("allow: require.call(...) with a benign specifier (near-miss, not under manual-tests/)", () => {
    const result = run({
      "scripts/fixture.ts": `export const h = require.call(null, "./manual-tests-helper");\n`,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("check-raw-sql-usage: OK");
  });

  it("deny: new Worker(new URL(...)) with a literal *.test.ts specifier", () => {
    const result = run({
      "scripts/fixture.ts": `export const w = new Worker(new URL("./h.test.ts", import.meta.url));\n`,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("UNSCANNED_IMPORT");
  });

  it("allow: new Worker(new URL(...)) with a benign specifier", () => {
    const result = run({
      "scripts/fixture.ts": `export const w = new Worker(new URL("./latest-util.ts", import.meta.url));\n`,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("check-raw-sql-usage: OK");
  });

  // S-R3-2(i) / S-R5-1: loaders disagree on a `?query`/`#fragment` suffix
  // (ESM strips it, tsx/Node CJS keep it in the file name), so a
  // module-specifier holding `?` or `#` is refused for its characters,
  // whatever it reaches.
  it("deny: import specifier with a bundler ?raw query suffix (S-R3-2)", () => {
    const result = run({
      "scripts/fixture.ts": `import helperRaw from "./helper.test?raw";\nexport const h = helperRaw;\n`,
      "scripts/helper.test.ts": `export const helper = 1;\n`,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("UNSCANNED_IMPORT");
    expect(result.stderr).toContain(`import specifier "./helper.test?raw" contains '?'`);
  });

  it("deny: import specifier with a bundler ?raw query suffix over a benign path (S-R5-1: refused by charset, not by target)", () => {
    const result = run({
      "scripts/fixture.ts": `import helperRaw from "./latest-util?raw";\nexport const h = helperRaw;\n`,
      "scripts/latest-util.ts": `export const helper = 1;\n`,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`import specifier "./latest-util?raw" contains '?'`);
  });

  // S-R3-2(i): on a case-insensitive filesystem (the Node/macOS/Windows
  // default), a specifier spelled with different casing than the real
  // excluded file still resolves to the SAME physical file — the match must
  // be case-insensitive or this is a laundering path.
  it("deny: case-variant .TEST specifier resolves to the same file as the real, lowercase *.test.ts (S-R3-2)", () => {
    const result = run({
      "scripts/fixture.ts": `import { helper } from "./h.TEST";\nexport const h = helper;\n`,
      "scripts/h.test.ts": `export const helper = 1;\n`,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("UNSCANNED_IMPORT");
  });

  it("deny: case-variant __TESTS__ directory segment resolves to the same real __tests__/ directory (S-R3-2)", () => {
    const result = run({
      "scripts/fixture.ts": `import { helper } from "./__TESTS__/helper";\nexport const h = helper;\n`,
      "scripts/__tests__/helper.ts": `export const helper = 1;\n`,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("UNSCANNED_IMPORT");
  });

  // Functionality [Minor]: checkUnscannedLiteralAnywhere must not re-report a
  // literal already inspected by checkUnscannedImport's require()/import()
  // call scan — each real violation prints exactly once.
  it("reports require(\"./evil.test\") exactly once (no double-report between checkUnscannedImport and checkUnscannedLiteralAnywhere)", () => {
    const result = run({
      "scripts/fixture.ts": `const helper = require("./evil.test");\nexport { helper };\n`,
      "scripts/evil.test.ts": `export const helper = 1;\n`,
    });
    expect(result.code).toBe(1);
    const matchingLines = result.stderr
      .split("\n")
      .filter((line) => line.includes("scripts/fixture.ts:1") && line.includes("evil.test"));
    expect(matchingLines).toHaveLength(1);
  });

  // N1 measured exemption: scripts/checks/classify-fail-closed-test.mjs
  // names the shared test helper module it classifies OTHER files against —
  // that is DATA, not a load target, so it must stay exempt from the
  // blanket literal scan even though the literal resolves into
  // __tests__/.
  it("allow: scripts/checks/classify-fail-closed-test.mjs naming the fail-closed test helper as data", () => {
    const result = run({
      "scripts/checks/classify-fail-closed-test.mjs": `export const HELPER_MODULE = "@/__tests__/helpers/fail-closed";\n`,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("check-raw-sql-usage: OK");
  });

  // S-R3-3: the exemption is PER LITERAL VALUE, not per file — a second,
  // DIFFERENT test-path literal in the SAME exempt file still denies.
  it("deny: a second, different test-path literal in the exempt file (per-literal, not per-file, exemption) (S-R3-3)", () => {
    const result = run({
      "scripts/checks/classify-fail-closed-test.mjs": [
        'export const HELPER_MODULE = "@/__tests__/helpers/fail-closed";',
        'import { createRequire } from "node:module";',
        "const req = createRequire(import.meta.url);",
        'export const x = req("../__tests__/x.test.mjs");',
        "",
      ].join("\n"),
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("UNSCANNED_IMPORT");
  });

  // S-R3-3: the exempt literal VALUE does not widen to every file under
  // scripts/checks/ — only the one named key is exempt.
  it("deny: the exempt literal value appearing in a different scripts/checks file (no directory widening) (S-R3-3)", () => {
    const result = run({
      "scripts/checks/other.mjs": 'export const HELPER_MODULE = "@/__tests__/helpers/fail-closed";\n',
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("UNSCANNED_IMPORT");
  });

  // S-R3-3: the exemption also pins the COUNT — the same literal appearing
  // MORE times than measured drifts the exempted set and must deny too.
  it("deny: the exempt literal appearing twice in the exempt file (count drift) (S-R3-3)", () => {
    const result = run({
      "scripts/checks/classify-fail-closed-test.mjs": [
        'export const HELPER_MODULE = "@/__tests__/helpers/fail-closed";',
        'export const HELPER_MODULE_2 = "@/__tests__/helpers/fail-closed";',
        "",
      ].join("\n"),
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("UNSCANNED_IMPORT");
    expect(result.stderr).toContain("the measured exemption expects");
  });
});

// Round 4: one on-disk resolver (resolveOnDisk) answers both the GRANT
// question (is this a canonical raw-sql.ts import? — exact, case-sensitive)
// and the UNSCANNED_IMPORT question (does this reach code the gate does not
// parse?). P1-P6 are the round-4 review probes, each of which the previous
// path-math resolver let through while the real loader executed the forgery.
// `details` pins WHICH branch denied, so disabling one branch flips its row
// even where another rule would still deny the same fixture.
describe("check-raw-sql-usage Layer 2 — on-disk specifier resolver (round 4)", () => {
  const FORGE = `export const renderSql = (s) => String(s);\nexport function run(tx, x) { return tx.$queryRawUnsafe(x); }\n`;
  const USE_RUN = (spec) => `import { run } from "${spec}";\nexport const go = (tx, x) => run(tx, x);\n`;
  const USE_RENDER = (spec) =>
    `import { renderSql } from "${spec}";\nexport const go = (tx, x) => tx.$queryRawUnsafe(renderSql(x));\n`;

  const rows = [
    {
      name: "deny: P1 — import of a file under an unscanned root (../../docs/forge), not a test path",
      files: { "docs/forge.ts": FORGE, "src/app/a.ts": USE_RUN("../../docs/forge") },
      reasons: ["UNSCANNED_IMPORT"],
      details: ['resolves to "docs/forge.ts", a file outside the Layer 2 scan'],
    },
    {
      name: "deny: P1b — @/../cli/src/forge leaves src/ through the alias",
      files: { "cli/src/forge.ts": FORGE, "src/app/a.ts": USE_RUN("@/../cli/src/forge") },
      reasons: ["UNSCANNED_IMPORT"],
      details: ['resolves to "cli/src/forge.ts", a file outside the Layer 2 scan'],
    },
    {
      name: "deny: P2 — @/lib/Prisma/raw-sql (case-variant parent; directory with package.json main) is neither credited nor followed",
      files: {
        "src/lib/Prisma/raw-sql/package.json": JSON.stringify({ main: "forge.test.ts" }),
        "src/lib/Prisma/raw-sql/forge.test.ts": FORGE,
        "src/app/a.ts": USE_RENDER("@/lib/Prisma/raw-sql"),
      },
      reasons: ["UNSCANNED_IMPORT", "RAW_SQL_NAMES"],
      details: ['resolves to "src/lib/Prisma/raw-sql/", a directory carrying package.json'],
    },
    {
      name: "deny: P3 — @/lib/prisma/raw-sql.TS (forged sibling) is not credited as raw-sql.ts and is unscanned",
      files: { "src/lib/prisma/raw-sql.TS": FORGE, "src/app/a.ts": USE_RENDER("@/lib/prisma/raw-sql.TS") },
      reasons: ["UNSCANNED_IMPORT", "RAW_SQL_NAMES"],
      details: [
        'resolves to "src/lib/prisma/raw-sql.TS", a file outside the Layer 2 scan',
        '"renderSql" occurs outside an allowed position',
      ],
    },
    {
      name: "deny: P4 — ./h%2Etest.ts (Node ESM percent-decodes; the gate does not)",
      files: { "src/app/h.test.ts": FORGE, "src/app/a.ts": USE_RUN("./h%2Etest.ts") },
      reasons: ["UNSCANNED_IMPORT"],
      details: ["contains '%'"],
    },
    {
      name: "deny: P4 (.mjs, executed by plain node) — ./h%2Etest.mjs",
      files: { "scripts/h.test.mjs": FORGE, "scripts/a.mjs": USE_RUN("./h%2Etest.mjs") },
      reasons: ["UNSCANNED_IMPORT"],
      details: ["contains '%'"],
    },
    {
      name: "deny: P5 — ../../../src/lib/prisma/raw-sql walks above the root (no longer clamped into a credited raw-sql.ts)",
      files: { "src/app/a.ts": USE_RENDER("../../../src/lib/prisma/raw-sql") },
      reasons: ["UNSCANNED_IMPORT", "RAW_SQL_NAMES"],
      details: ["walks above the repository root", '"renderSql" occurs outside an allowed position'],
    },
    {
      name: "deny: P6 — ./h.TS (an unscanned extension tsx loads as CJS JavaScript)",
      files: { "src/app/h.TS": FORGE, "src/app/a.ts": USE_RUN("./h.TS") },
      reasons: ["UNSCANNED_IMPORT"],
      details: ['resolves to "src/app/h.TS", a file outside the Layer 2 scan'],
    },
    {
      name: "deny: a specifier matching an existing file only case-insensitively (./Helper vs helper.ts)",
      files: { "scripts/helper.ts": "export const run = 1;\n", "scripts/a.ts": USE_RUN("./Helper") },
      reasons: ["UNSCANNED_IMPORT"],
      details: ['matches "scripts/helper.ts" only case-insensitively'],
    },
    {
      name: "deny: a directory resolved through its index file outside the scan (../../docs → docs/index.ts)",
      files: { "docs/index.ts": FORGE, "src/app/a.ts": USE_RUN("../../docs") },
      reasons: ["UNSCANNED_IMPORT"],
      details: ['resolves to "docs/index.ts", a file outside the Layer 2 scan'],
    },
    {
      name: "deny: an existing .JSON file (Node's CJS loader picks by exact extension — loads it as JavaScript)",
      files: { "scripts/d.JSON": FORGE, "scripts/a.ts": `export const d = require("./d.JSON");\n` },
      reasons: ["UNSCANNED_IMPORT"],
      details: ['resolves to "scripts/d.JSON", a file outside the Layer 2 scan'],
    },
    {
      name: "deny: the same unscanned target reached by a loader under another name (createRequire)",
      files: {
        "docs/forge.ts": FORGE,
        "src/app/a.ts": `import { createRequire } from "node:module";\nconst req = createRequire(import.meta.url);\nexport const m = req("../../docs/forge");\n`,
      },
      reasons: ["UNSCANNED_IMPORT"],
      details: ['literal "../../docs/forge" resolves to "docs/forge.ts"'],
    },
    {
      name: "deny: a canonical-looking import when raw-sql.ts does not exist on disk earns no credit",
      files: { "scripts/a.ts": USE_RENDER("@/lib/prisma/raw-sql") },
      opts: { omitRawSqlModule: true },
      reasons: ["RAW_SQL_NAMES"],
      details: ['"renderSql" occurs outside an allowed position'],
    },
    // Deny-side raw-sql matching stays case-INsensitive (only the grant is exact).
    {
      name: "deny: a case-variant raw-sql specifier held as a literal (deny-side match is case-insensitive)",
      files: { "scripts/a.ts": `export const spec = "@/lib/Prisma/RAW-SQL";\n` },
      reasons: ["SPECIFIER_LITERAL"],
      details: ['literal "@/lib/Prisma/RAW-SQL" matches a restricted specifier pattern'],
    },
    {
      name: "deny: a namespace import of a case-variant raw-sql specifier",
      files: { "scripts/a.ts": `import * as r from "@/lib/prisma/RAW-SQL";\nexport const x = r;\n` },
      reasons: ["RAW_SQL_NAMES"],
      details: ["namespace or default import of raw-sql.ts"],
    },
    {
      name: "allow: canonical @/lib/prisma/raw-sql",
      files: { "src/app/a.ts": USE_RENDER("@/lib/prisma/raw-sql") },
    },
    {
      name: "allow: ./raw-sql from src/lib/prisma",
      files: { "src/lib/prisma/a.ts": USE_RENDER("./raw-sql") },
    },
    {
      name: "allow: ./raw-sql.js from src/lib/prisma (TS/ESM extension rewrite)",
      files: { "src/lib/prisma/a.ts": USE_RENDER("./raw-sql.js") },
    },
    {
      name: "allow: a .json import",
      files: { "scripts/data.json": "{}\n", "scripts/a.ts": `import data from "./data.json";\nexport const d = data;\n` },
    },
    {
      name: "allow: a sibling scanned module",
      files: { "scripts/sibling.ts": "export const run = 1;\n", "scripts/a.ts": USE_RUN("./sibling") },
    },
    {
      name: "allow: a measured exemption literal (src/app/layout.tsx importing ./globals.css, once)",
      files: { "src/app/globals.css": "body {}\n", "src/app/layout.tsx": `import "./globals.css";\nexport const x = 1;\n` },
    },
    {
      name: "deny: the same exempt literal in a different file",
      files: { "src/app/globals.css": "body {}\n", "src/app/other.tsx": `import "./globals.css";\nexport const x = 1;\n` },
      reasons: ["UNSCANNED_IMPORT"],
      details: ['resolves to "src/app/globals.css", a file outside the Layer 2 scan'],
    },
    {
      name: "deny: the exempt literal past its measured count (count drift)",
      files: {
        "src/app/globals.css": "body {}\n",
        "src/app/layout.tsx": `import "./globals.css";\nexport const again = "./globals.css";\n`,
      },
      reasons: ["UNSCANNED_IMPORT"],
      details: ['"./globals.css" appears 2 time(s) in src/app/layout.tsx; the measured exemption expects 1'],
    },
    {
      name: "allow: an exemption is counted by occurrence, not by what exists on disk (layout.tsx ./globals.css with no globals.css)",
      files: { "src/app/layout.tsx": `import "./globals.css";\nexport const x = 1;\n` },
    },
    // A `.`/`..`-only literal outside a module-specifier position is a
    // directory path (the scripts/ repo-root idiom), judged by what that
    // ancestor directory can load, not by a per-file exemption.
    {
      name: "allow: new URL(\"../..\", import.meta.url) — the repo root, whose package.json has no main/exports",
      files: {
        "package.json": JSON.stringify({ name: "fixture" }),
        "scripts/checks/x.mjs": `export const ROOT = new URL("../..", import.meta.url);\n`,
      },
    },
    {
      name: "allow: a \"../..\" literal walking above the repo root (nothing a PR can place there)",
      files: { "scripts/x.ts": `import { resolve } from "node:path";\nexport const ROOT = resolve(__dirname, "../..");\n` },
    },
    {
      name: "deny: a \"../..\" literal reaching an ancestor package.json that has \"main\"",
      files: {
        "scripts/sub/package.json": JSON.stringify({ name: "fixture", main: "../../docs/forge.js" }),
        "docs/forge.js": FORGE,
        "scripts/sub/a/b/x.mjs": `export const UP = "../..";\n`,
      },
      reasons: ["UNSCANNED_IMPORT"],
      details: ['package.json "main"/"exports" this gate cannot follow'],
    },
    {
      name: "deny: a \"..\" literal whose directory's index matches only case-insensitively",
      files: {
        "scripts/Index.ts": "export const run = 1;\n",
        "scripts/checks/x.mjs": `export const UP = "..";\n`,
      },
      reasons: ["UNSCANNED_IMPORT"],
      details: ['matches "scripts/Index.ts" only case-insensitively'],
    },
    {
      name: "deny: the same \"../..\" in a module-specifier position (require) stays strict",
      files: {
        "package.json": JSON.stringify({ name: "fixture" }),
        "scripts/checks/x.cjs": `module.exports = require("../..");\n`,
      },
      reasons: ["UNSCANNED_IMPORT"],
      details: ["a directory carrying package.json"],
    },
  ];

  for (const r of rows) {
    it(r.name, () => {
      const result = run(r.files, r.opts);
      const reasons = r.reasons ?? [];
      expect(result.code).toBe(reasons.length > 0 ? 1 : 0);
      for (const reason of reasons) expect(result.stderr).toContain(`${reason}:`);
      for (const detail of r.details ?? []) expect(result.stderr).toContain(detail);
      if (reasons.length === 0) expect(result.stdout).toContain("check-raw-sql-usage: OK");
    });
  }
});

// Round 5 (S-R5-1): the loaders disagree on what a specifier's characters
// mean — tsx CJS keeps `#` in the file name, plain Node CJS keeps `?` and
// `#`, `new URL()` drops tab/LF/CR, trims C0 controls and space, and reads
// `\` as `/`. H1-H3 / U2-U4 are the round-5 probes. A module-specifier
// position refuses any character outside [A-Za-z0-9@._/-]; every other
// literal is judged under each loader reading instead (no charset refusal —
// ordinary messages start with `@/` and hold spaces). `details` pins the
// branch that denied.
describe("check-raw-sql-usage Layer 2 — specifier characters and loader readings (round 5)", () => {
  const FORGE = `export const renderSql = (s) => String(s);\nexport function run(tx, x) { return tx.$queryRawUnsafe(x); }\n`;
  const USE_RUN = (spec) => `import { run } from "${spec}";\nexport const go = (tx, x) => run(tx, x);\n`;
  const USE_RENDER = (spec) =>
    `import { renderSql } from "${spec}";\nexport const go = (tx, x) => tx.$queryRawUnsafe(renderSql(x));\n`;
  const VIA_CREATE_REQUIRE = (spec) =>
    `import { createRequire } from "node:module";\nconst req = createRequire(import.meta.url);\nexport const m = req("${spec}");\n`;

  const rows = [
    {
      name: "deny: H1 — ../src/lib/prisma/raw-sql#x is not credited as raw-sql.ts (tsx CJS loads the unscanned raw-sql#x)",
      files: { "src/lib/prisma/raw-sql#x": FORGE, "scripts/p.ts": USE_RENDER("../src/lib/prisma/raw-sql#x") },
      reasons: ["UNSCANNED_IMPORT", "RAW_SQL_NAMES"],
      details: [
        `import specifier "../src/lib/prisma/raw-sql#x" contains '#'`,
        '"renderSql" occurs outside an allowed position',
      ],
    },
    {
      name: "deny: H2 — ../src/app/h#x.test.ts (a # hides a test-file target)",
      files: { "src/app/h#x.test.ts": FORGE, "scripts/q.ts": USE_RUN("../src/app/h#x.test.ts") },
      reasons: ["UNSCANNED_IMPORT"],
      details: [`import specifier "../src/app/h#x.test.ts" contains '#'`],
    },
    {
      name: "deny: H3 — require(\"./h?x.test.js\") (plain Node CJS keeps ? in the file name)",
      files: { "scripts/h?x.test.js": FORGE, "scripts/q.cjs": `const { run } = require("./h?x.test.js");\nmodule.exports = run;\n` },
      reasons: ["UNSCANNED_IMPORT"],
      details: [`require() of "./h?x.test.js" contains '?'`],
    },
    {
      name: "deny: U2 — a tab inside an ESM import specifier (new URL() drops it)",
      files: { "docs/forge.mjs": FORGE, "scripts/q.mjs": USE_RUN("../do\\tcs/forge.mjs") },
      reasons: ["UNSCANNED_IMPORT"],
      details: [`import specifier "../do\\tcs/forge.mjs" contains '\\t'`],
    },
    {
      name: "deny: U3 — a trailing space on an ESM import specifier (new URL() trims it)",
      files: { "docs/forge.mjs": FORGE, "scripts/q.mjs": USE_RUN("../docs/forge.mjs ") },
      reasons: ["UNSCANNED_IMPORT"],
      details: [`import specifier "../docs/forge.mjs " contains ' '`],
    },
    {
      name: "deny: U4 — a backslash in a dynamic import() specifier (read as /)",
      files: {
        "docs/forge.ts": FORGE,
        "scripts/q.ts": `export async function go() {\n  return import("../docs\\\\forge.ts");\n}\n`,
      },
      reasons: ["UNSCANNED_IMPORT"],
      details: [`import() of "../docs\\\\forge.ts" contains '\\\\'`],
    },
    {
      name: "deny: the H1 shape as an other literal (createRequire) — the as-written reading reaches the unscanned raw-sql#x",
      files: { "src/lib/prisma/raw-sql#x": FORGE, "scripts/p.ts": VIA_CREATE_REQUIRE("../src/lib/prisma/raw-sql#x") },
      reasons: ["UNSCANNED_IMPORT", "SPECIFIER_LITERAL"],
      details: [`literal "../src/lib/prisma/raw-sql#x" resolves to "src/lib/prisma/raw-sql#x", a file outside the Layer 2 scan`],
    },
    {
      name: "deny: an other literal whose ?-stripped reading reaches an unscanned test file (ESM / bundlers strip the suffix)",
      files: { "scripts/h.test.ts": FORGE, "scripts/fixture.ts": VIA_CREATE_REQUIRE("./h.test?x") },
      reasons: ["UNSCANNED_IMPORT"],
      details: [`literal "./h.test?x" read as "./h.test", resolves to "scripts/h.test.ts", a file outside the Layer 2 scan`],
    },
    {
      name: "deny: an other literal whose URL-normalized reading (tab removed) reaches an unscanned file",
      files: { "docs/forge.ts": FORGE, "src/app/a.ts": VIA_CREATE_REQUIRE("../../docs/fo\\trge") },
      reasons: ["UNSCANNED_IMPORT"],
      details: [`read as "../../docs/forge", resolves to "docs/forge.ts", a file outside the Layer 2 scan`],
    },
    {
      name: "deny: an other literal that is repo-shaped only once URL-normalized (backslashes read as /)",
      files: { "docs/forge.ts": FORGE, "src/app/a.ts": VIA_CREATE_REQUIRE("..\\\\..\\\\docs\\\\forge") },
      reasons: ["UNSCANNED_IMPORT"],
      details: [`read as "../../docs/forge", resolves to "docs/forge.ts", a file outside the Layer 2 scan`],
    },
    {
      name: "deny: an other literal whose URL-normalized reading (leading/trailing space trimmed) reaches an unscanned file",
      files: { "docs/forge.ts": FORGE, "src/app/a.ts": VIA_CREATE_REQUIRE(" ../../docs/forge ") },
      reasons: ["UNSCANNED_IMPORT"],
      details: [`read as "../../docs/forge", resolves to "docs/forge.ts", a file outside the Layer 2 scan`],
    },
    {
      name: "deny: an other literal holding % (Node ESM percent-decodes)",
      files: { "scripts/fixture.ts": VIA_CREATE_REQUIRE("./h%2Etest.ts") },
      reasons: ["UNSCANNED_IMPORT"],
      details: [`literal "./h%2Etest.ts" contains '%'`],
    },
    {
      name: "allow: an @/ message string holding spaces and a paren (check-operator-echo-escaped style) — no charset refusal outside specifier positions",
      files: {
        "src/lib/security/unsafe-display-chars.ts": "export const x = 1;\n",
        "scripts/checks/echo.mjs":
          'export const hint = (m) =>\n  "Import it from " +\n  "@/lib/security/unsafe-display-chars), or annotate the line with " +\n  m;\n',
      },
    },
    // M1: a `.`/`..` literal reaching an ancestor whose package.json is not a
    // readable JSON object fails closed with a named reason, not a stack.
    {
      name: "deny: a \"..\" literal reaching a directory whose package.json is malformed JSON",
      files: {
        "scripts/sub/package.json": "{ bad json",
        "scripts/sub/deeper/a.mjs": `import { resolve } from "node:path";\nexport const root = resolve(import.meta.dirname, "..");\n`,
      },
      reasons: ["UNSCANNED_IMPORT"],
      details: ['literal ".." resolves to "scripts/sub/", whose scripts/sub/package.json cannot be read as JSON'],
    },
    {
      name: "deny: a \"..\" literal reaching a directory whose package.json is JSON null",
      files: {
        "scripts/sub/package.json": "null\n",
        "scripts/sub/deeper/a.mjs": `import { resolve } from "node:path";\nexport const root = resolve(import.meta.dirname, "..");\n`,
      },
      reasons: ["UNSCANNED_IMPORT"],
      details: ["whose scripts/sub/package.json is not a JSON object"],
    },
    // M2: the unscanned-file message says where the measured exemptions live.
    {
      name: "deny: a new CSS-module import names UNSCANNED_LITERAL_EXEMPTIONS as the next step",
      files: {
        "src/app/x.module.css": ".a {}\n",
        "src/app/x.tsx": `import styles from "./x.module.css";\nexport const c = styles.a;\n`,
      },
      reasons: ["UNSCANNED_IMPORT"],
      details: [
        'resolves to "src/app/x.module.css", a file outside the Layer 2 scan',
        "UNSCANNED_LITERAL_EXEMPTIONS in scripts/checks/check-raw-sql-usage.mjs (`.json` is the only extension accepted as data without one)",
      ],
    },
    // F-R5-1: next-env.d.ts is Next-generated and gitignored; `npm run dev`
    // rewrites it to reference ./.next/dev/types/. It is left out of the scan
    // by name — and, being unscanned, a specifier reaching it still denies.
    {
      name: "allow: a dev-mode next-env.d.ts referencing ./.next/dev/types/routes.d.ts",
      files: {
        "next-env.d.ts": `/// <reference types="next" />\nimport "./.next/dev/types/routes.d.ts";\nimport "./.next/dev/types/root-params.d.ts";\n`,
        ".next/dev/types/routes.d.ts": "export {};\n",
        ".next/dev/types/root-params.d.ts": "export {};\n",
      },
    },
    {
      name: "deny: a scanned file importing ../next-env.d.ts (excluded from the scan, so judged as an unscanned target)",
      files: {
        "next-env.d.ts": `import "./.next/dev/types/routes.d.ts";\n`,
        "scripts/x.ts": `import "../next-env.d.ts";\nexport const x = 1;\n`,
      },
      reasons: ["UNSCANNED_IMPORT"],
      details: ['import specifier "../next-env.d.ts" resolves to "next-env.d.ts", a file outside the Layer 2 scan'],
    },
  ];

  for (const r of rows) {
    it(r.name, () => {
      const result = run(r.files, r.opts);
      const reasons = r.reasons ?? [];
      expect(result.code).toBe(reasons.length > 0 ? 1 : 0);
      for (const reason of reasons) expect(result.stderr).toContain(`${reason}:`);
      for (const detail of r.details ?? []) expect(result.stderr).toContain(detail);
      if (reasons.length === 0) expect(result.stdout).toContain("check-raw-sql-usage: OK");
    });
  }
});

// Round 6. F-R6-1: App Router path characters `[ ] ( )` are admitted in
// module-specifier positions (D1/D2 are the probes). S-R6-1: the resolver's
// `@/` → src/ mapping is checked against the root tsconfig.json /
// package.json (A4/A5/A7 are the probes). S-R6-2: a `./`/`../` other literal
// is also read from the repository root, as `new Worker(path)` / `fork()` do
// (B1/B2 are the probes).
describe("check-raw-sql-usage Layer 2 — specifier charset, resolution config, cwd reading (round 6)", () => {
  const FORGE = `export const renderSql = (s) => String(s);\nexport function run(tx, x) { return tx.$queryRawUnsafe(x); }\n`;
  const FORGE_CJS = `console.log("FORGE-RAN");\nexports.v = 1;\n`;
  const USE_RENDER = (spec) =>
    `import { renderSql } from "${spec}";\nexport const go = (tx, x) => tx.$queryRawUnsafe(renderSql(x));\n`;
  const TSCONFIG = (compilerOptions, extra = {}) => JSON.stringify({ ...extra, compilerOptions });
  const CANONICAL_PATHS = { "@/*": ["./src/*"] };

  const rows = [
    // F-R6-1
    {
      name: "allow: D1 — @/app/api/passwords/[id]/route (dynamic-segment brackets)",
      files: {
        "src/app/api/passwords/[id]/route.ts": "export async function GET() { return 1; }\n",
        "src/lib/x.ts": `import { GET } from "@/app/api/passwords/[id]/route";\nexport const g = GET;\n`,
      },
    },
    {
      name: "allow: D2 — ./layout and ../(shared)/s inside route groups (parentheses)",
      files: {
        "src/app/(auth)/layout.tsx": "export default function L() { return null; }\n",
        "src/app/(shared)/s.ts": "export const s = 1;\n",
        "src/app/(auth)/page.tsx": `import L from "./layout";\nimport { s } from "../(shared)/s";\nexport default function P() { return [L, s]; }\n`,
      },
    },
    {
      name: "deny: a specifier outside the charset names the allowed set and why the rest is refused",
      files: { "scripts/h.ts": "export const run = 1;\n", "scripts/a.ts": `import { run } from "./h?x";\nexport const r = run;\n` },
      reasons: ["UNSCANNED_IMPORT"],
      details: [
        "outside the module-specifier charset A-Z a-z 0-9 @ . _ / - ( ) [ ]",
        "'?', '#', '%', '\\', whitespace and control characters are refused because Node ESM, Node CJS, tsx and new URL() each read them differently",
      ],
    },
    // S-R6-1
    {
      name: "deny: A4 — root package.json \"imports\" (#f → docs/forge.cjs)",
      files: {
        "package.json": JSON.stringify({ name: "fixture", imports: { "#f": "./docs/forge.cjs" } }),
        "docs/forge.cjs": FORGE_CJS,
        "scripts/x.ts": `const m = require("#f");\nexport const v = m.v;\n`,
      },
      reasons: ["RESOLUTION_CONFIG"],
      details: ['package.json has "imports"'],
    },
    {
      name: "deny: A5 — a new tsconfig paths alias (~/* → ./docs/*)",
      files: {
        "tsconfig.json": TSCONFIG({ paths: { ...CANONICAL_PATHS, "~/*": ["./docs/*"] } }),
        "docs/forge.cjs": FORGE_CJS,
        "scripts/x.ts": `import { v } from "~/forge.cjs";\nexport const w = v;\n`,
      },
      reasons: ["RESOLUTION_CONFIG"],
      details: ['tsconfig.json compilerOptions.paths is {"@/*":["./src/*"],"~/*":["./docs/*"]}, not exactly {"@/*":["./src/*"]}'],
    },
    {
      name: "deny: A7 — tsconfig paths retargets @/* to ./docs/*, so the canonical-looking import runs a forged raw-sql",
      files: {
        "tsconfig.json": TSCONFIG({ paths: { "@/*": ["./docs/*"] } }),
        "docs/lib/prisma/raw-sql.ts": FORGE,
        "scripts/x.ts": USE_RENDER("@/lib/prisma/raw-sql"),
      },
      reasons: ["RESOLUTION_CONFIG"],
      details: ['compilerOptions.paths is {"@/*":["./docs/*"]}'],
    },
    {
      name: "deny: tsconfig compilerOptions.baseUrl present (with the canonical paths)",
      files: { "tsconfig.json": TSCONFIG({ baseUrl: ".", paths: CANONICAL_PATHS }) },
      reasons: ["RESOLUTION_CONFIG"],
      details: ['tsconfig.json compilerOptions has "baseUrl"'],
    },
    {
      name: "deny: tsconfig \"extends\" (can carry baseUrl/paths in from another file)",
      files: { "tsconfig.json": TSCONFIG({ paths: CANONICAL_PATHS }, { extends: "./tsconfig.base.json" }) },
      reasons: ["RESOLUTION_CONFIG"],
      details: ['tsconfig.json has "extends"'],
    },
    {
      name: "deny: tsconfig.json holding a comment (read as strict JSON)",
      files: { "tsconfig.json": `// c\n${TSCONFIG({ paths: CANONICAL_PATHS })}` },
      reasons: ["RESOLUTION_CONFIG"],
      details: ["tsconfig.json is not strict JSON"],
    },
    {
      name: "deny: no root tsconfig.json at all",
      files: { "scripts/a.ts": "export const a = 1;\n" },
      opts: { omitResolutionConfig: true },
      reasons: ["RESOLUTION_CONFIG"],
      details: ["tsconfig.json cannot be read"],
    },
    {
      name: "deny: root package.json \"exports\"",
      files: { "package.json": JSON.stringify({ name: "fixture", exports: "./docs/forge.cjs" }) },
      reasons: ["RESOLUTION_CONFIG"],
      details: ['package.json has "exports"'],
    },
    {
      name: "deny: root package.json \"main\"",
      files: { "package.json": JSON.stringify({ name: "fixture", main: "./docs/forge.cjs" }) },
      reasons: ["RESOLUTION_CONFIG"],
      details: ['package.json has "main"'],
    },
    {
      name: "allow: the default config (canonical paths, no baseUrl; package.json without imports/exports/main) with a canonical import",
      files: { "scripts/x.ts": USE_RENDER("@/lib/prisma/raw-sql") },
    },
    {
      name: "allow: no root package.json (only tsconfig.json is required)",
      files: { "tsconfig.json": TSCONFIG({ paths: CANONICAL_PATHS }), "scripts/a.ts": "export const a = 1;\n" },
      opts: { omitResolutionConfig: true },
    },
    // S-R6-2
    {
      name: "deny: B1 — new Worker(\"./docs/forge.cjs\") resolves from process.cwd() (the repo root), not the file",
      files: {
        "docs/forge.cjs": FORGE_CJS,
        "scripts/x.ts": `import { Worker } from "node:worker_threads";\nnew Worker("./docs/forge.cjs");\n`,
      },
      reasons: ["UNSCANNED_IMPORT"],
      details: [
        'literal "./docs/forge.cjs" read from the repository root (process.cwd(), as new Worker / fork / spawn / fs do), resolves to "docs/forge.cjs", a file outside the Layer 2 scan',
      ],
    },
    {
      name: "deny: B2 — fork(\"./docs/forge.cjs\") from scripts/",
      files: {
        "docs/forge.cjs": FORGE_CJS,
        "scripts/x.ts": `import { fork } from "node:child_process";\nfork("./docs/forge.cjs");\n`,
      },
      reasons: ["UNSCANNED_IMPORT"],
      details: ['literal "./docs/forge.cjs" read from the repository root'],
    },
    {
      name: "allow: a cwd-relative literal reaching a scanned file (fork(\"./scripts/worker.ts\"))",
      files: {
        "scripts/worker.ts": "export const w = 1;\n",
        "scripts/x.ts": `import { fork } from "node:child_process";\nfork("./scripts/worker.ts");\n`,
      },
    },
    {
      name: "allow: a ../ literal whose root reading walks above the root (ignored) and whose file reading reaches nothing",
      files: { "scripts/x.ts": `export const label = "../not-a-file";\n` },
    },
  ];

  for (const r of rows) {
    it(r.name, () => {
      const result = run(r.files, r.opts);
      const reasons = r.reasons ?? [];
      expect(result.code).toBe(reasons.length > 0 ? 1 : 0);
      for (const reason of reasons) expect(result.stderr).toContain(`${reason}:`);
      for (const detail of r.details ?? []) expect(result.stderr).toContain(detail);
      if (reasons.length === 0) expect(result.stdout).toContain("check-raw-sql-usage: OK");
    });
  }
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

  // Testing [Minor]: a benign allow row per scanned extension, adjacent to
  // the deny loop above — proves the scan picks these extensions up for a
  // CLEAN file too, not only a violating one.
  for (const ext of ["mts", "cts", "js", "jsx", "mjs", "cjs"]) {
    it(`passes on a clean .${ext} sibling`, () => {
      const result = run({ [`scripts/fixture-clean.${ext}`]: "export const x = 1;\n" });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("check-raw-sql-usage: OK");
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
    // skipAllowlistStubs: a truly empty tree — the default NON_LITERAL_IMPORT
    // allowlist stand-ins would otherwise make this tree non-empty.
    const result = run({}, { skipAllowlistStubs: true });
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
