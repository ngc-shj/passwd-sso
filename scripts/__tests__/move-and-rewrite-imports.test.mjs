/**
 * Fixture-based tests for move-and-rewrite-imports.mjs codemod.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createFixture(tmpDir, files) {
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = join(tmpDir, relPath);
    mkdirSync(resolve(absPath, ".."), { recursive: true });
    writeFileSync(absPath, content, "utf-8");
  }
}

function initGitRepo(dir) {
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
}

function writeConfig(tmpDir, config) {
  const configPath = join(tmpDir, "phase-config.json");
  writeFileSync(configPath, JSON.stringify(config), "utf-8");
  return configPath;
}

function runCodemod(tmpDir, configPath, dryRun = false) {
  const scriptPath = resolve(import.meta.dirname, "../move-and-rewrite-imports.mjs");
  const args = ["--config", configPath];
  if (dryRun) args.push("--dry-run");
  const result = spawnSync(
    process.execPath,
    [scriptPath, ...args],
    { cwd: tmpDir, encoding: "utf-8", timeout: 30000 }
  );
  return result;
}

function readFile(tmpDir, relPath) {
  return readFileSync(join(tmpDir, relPath), "utf-8");
}

// ---------------------------------------------------------------------------
// Minimal tsconfig for the fixture (ts-morph needs it)
// ---------------------------------------------------------------------------

const FIXTURE_TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2020",
    module: "esnext",
    moduleResolution: "bundler",
    allowJs: true,
    strict: true,
    paths: { "@/*": ["./src/*"] },
  },
  include: ["src/**/*", "scripts/**/*"],
});

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "codemod-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("alias import rewrite", () => {
  it("rewrites @/lib/foo to @/lib/auth/foo in an importer file", () => {
    createFixture(tmpDir, {
      "tsconfig.json": FIXTURE_TSCONFIG,
      "src/lib/foo.ts": `export const foo = 1;\n`,
      "src/app/page.tsx": `import { foo } from "@/lib/foo";\nexport default function Page() { return foo; }\n`,
    });
    mkdirSync(join(tmpDir, "src/lib/auth"), { recursive: true });
    initGitRepo(tmpDir);

    const configPath = writeConfig(tmpDir, {
      phaseName: "test-alias",
      moves: [{ from: "src/lib/foo.ts", to: "src/lib/auth/foo.ts" }],
    });

    const result = runCodemod(tmpDir, configPath);
    expect(result.status, result.stderr).toBe(0);

    const content = readFile(tmpDir, "src/app/page.tsx");
    expect(content).toContain('@/lib/auth/foo');
    expect(content).not.toContain('@/lib/foo"');
  });
});

describe("relative import inside moved file", () => {
  it("rewrites relative import to a sibling that also moves", () => {
    createFixture(tmpDir, {
      "tsconfig.json": FIXTURE_TSCONFIG,
      "src/lib/foo.ts": `export const foo = 1;\n`,
      "src/lib/bar.ts": `import { foo } from "./foo";\nexport const bar = foo + 1;\n`,
    });
    mkdirSync(join(tmpDir, "src/lib/auth"), { recursive: true });
    initGitRepo(tmpDir);

    const configPath = writeConfig(tmpDir, {
      phaseName: "test-relative-both-move",
      moves: [
        { from: "src/lib/foo.ts", to: "src/lib/auth/foo.ts" },
        { from: "src/lib/bar.ts", to: "src/lib/auth/bar.ts" },
      ],
    });

    const result = runCodemod(tmpDir, configPath);
    expect(result.status, result.stderr).toBe(0);

    // bar.ts moved to src/lib/auth/bar.ts, imports foo which also moved to src/lib/auth/foo.ts
    // relative path should be ./foo (same directory)
    const content = readFile(tmpDir, "src/lib/auth/bar.ts");
    expect(content).toContain('./foo');
  });

  it("rewrites relative import to a sibling that stays put", () => {
    createFixture(tmpDir, {
      "tsconfig.json": FIXTURE_TSCONFIG,
      "src/lib/utils.ts": `export const util = "util";\n`,
      "src/lib/bar.ts": `import { util } from "./utils";\nexport const bar = util;\n`,
    });
    mkdirSync(join(tmpDir, "src/lib/auth"), { recursive: true });
    initGitRepo(tmpDir);

    const configPath = writeConfig(tmpDir, {
      phaseName: "test-relative-stays",
      moves: [{ from: "src/lib/bar.ts", to: "src/lib/auth/bar.ts" }],
    });

    const result = runCodemod(tmpDir, configPath);
    expect(result.status, result.stderr).toBe(0);

    // bar.ts moved to src/lib/auth/bar.ts; utils.ts stays at src/lib/utils.ts
    // new relative import should be ../utils
    const content = readFile(tmpDir, "src/lib/auth/bar.ts");
    expect(content).toContain('../utils');
  });
});

describe("vi.mock string rewrite", () => {
  it("rewrites @/lib/foo in vi.mock() to @/lib/auth/foo", () => {
    createFixture(tmpDir, {
      "tsconfig.json": FIXTURE_TSCONFIG,
      "src/lib/foo.ts": `export const foo = 1;\n`,
      "src/__tests__/bar.test.ts": [
        `import { describe, it, vi } from "vitest";`,
        `vi.mock("@/lib/foo", () => ({ foo: 42 }));`,
        `describe("bar", () => { it("works", () => {}); });`,
      ].join("\n") + "\n",
    });
    mkdirSync(join(tmpDir, "src/lib/auth"), { recursive: true });
    initGitRepo(tmpDir);

    const configPath = writeConfig(tmpDir, {
      phaseName: "test-vi-mock",
      moves: [{ from: "src/lib/foo.ts", to: "src/lib/auth/foo.ts" }],
    });

    const result = runCodemod(tmpDir, configPath);
    expect(result.status, result.stderr).toBe(0);

    const content = readFile(tmpDir, "src/__tests__/bar.test.ts");
    expect(content).toContain('@/lib/auth/foo');
    expect(content).not.toContain('vi.mock("@/lib/foo"');
  });
});

describe("await import static-string rewrite", () => {
  it("rewrites static string in await import() to new path", () => {
    createFixture(tmpDir, {
      "tsconfig.json": FIXTURE_TSCONFIG,
      "src/lib/foo.ts": `export const foo = 1;\n`,
      "src/app/lazy.ts": `export async function load() {\n  const m = await import("@/lib/foo");\n  return m.foo;\n}\n`,
    });
    mkdirSync(join(tmpDir, "src/lib/auth"), { recursive: true });
    initGitRepo(tmpDir);

    const configPath = writeConfig(tmpDir, {
      phaseName: "test-dynamic-import",
      moves: [{ from: "src/lib/foo.ts", to: "src/lib/auth/foo.ts" }],
    });

    const result = runCodemod(tmpDir, configPath);
    expect(result.status, result.stderr).toBe(0);

    const content = readFile(tmpDir, "src/app/lazy.ts");
    expect(content).toContain('@/lib/auth/foo');
    expect(content).not.toContain('import("@/lib/foo")');
  });
});

describe("typeof import rewrite", () => {
  it("rewrites typeof import() type reference to new path", () => {
    createFixture(tmpDir, {
      "tsconfig.json": FIXTURE_TSCONFIG,
      "src/lib/foo.ts": `export type FooType = { x: number };\n`,
      "src/app/typed.ts": `type Mod = typeof import("@/lib/foo");\nexport type Foo = Mod["FooType"];\n`,
    });
    mkdirSync(join(tmpDir, "src/lib/auth"), { recursive: true });
    initGitRepo(tmpDir);

    const configPath = writeConfig(tmpDir, {
      phaseName: "test-typeof-import",
      moves: [{ from: "src/lib/foo.ts", to: "src/lib/auth/foo.ts" }],
    });

    const result = runCodemod(tmpDir, configPath);
    expect(result.status, result.stderr).toBe(0);

    const content = readFile(tmpDir, "src/app/typed.ts");
    expect(content).toContain('@/lib/auth/foo');
    expect(content).not.toContain('import("@/lib/foo")');
  });
});

describe("template-literal dynamic import FAIL case", () => {
  it("exits with error when template literal dynamic import matches moved prefix", () => {
    createFixture(tmpDir, {
      "tsconfig.json": FIXTURE_TSCONFIG,
      "src/lib/foo.ts": `export const foo = 1;\n`,
      "src/app/dynamic.ts": [
        "const name = 'foo';",
        "async function loadLib(name: string) {",
        "  return import(`@/lib/${name}`);",
        "}",
        "export { loadLib };",
      ].join("\n") + "\n",
    });
    mkdirSync(join(tmpDir, "src/lib/auth"), { recursive: true });
    initGitRepo(tmpDir);

    const configPath = writeConfig(tmpDir, {
      phaseName: "test-template-fail",
      moves: [{ from: "src/lib/foo.ts", to: "src/lib/auth/foo.ts" }],
    });

    const result = runCodemod(tmpDir, configPath, true /* dry-run */);
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain("FAIL template-literal-import");
  });
});

describe("empty moves config", () => {
  it("exits 0 with no changes when moves array is empty", () => {
    createFixture(tmpDir, {
      "tsconfig.json": FIXTURE_TSCONFIG,
    });
    initGitRepo(tmpDir);

    const configPath = writeConfig(tmpDir, {
      phaseName: "smoke-test",
      moves: [],
    });

    const result = runCodemod(tmpDir, configPath, true /* dry-run */);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("No moves configured");
  });
});

describe("re-export rewrite", () => {
  it("rewrites export * from '@/lib/foo' to new path", () => {
    createFixture(tmpDir, {
      "tsconfig.json": FIXTURE_TSCONFIG,
      "src/lib/foo.ts": `export const foo = 1;\n`,
      "src/lib/index.ts": `export * from "@/lib/foo";\n`,
    });
    mkdirSync(join(tmpDir, "src/lib/auth"), { recursive: true });
    initGitRepo(tmpDir);

    const configPath = writeConfig(tmpDir, {
      phaseName: "test-reexport",
      moves: [{ from: "src/lib/foo.ts", to: "src/lib/auth/foo.ts" }],
    });

    const result = runCodemod(tmpDir, configPath);
    expect(result.status, result.stderr).toBe(0);

    const content = readFile(tmpDir, "src/lib/index.ts");
    expect(content).toContain('@/lib/auth/foo');
    expect(content).not.toContain('@/lib/foo"');
  });
});
