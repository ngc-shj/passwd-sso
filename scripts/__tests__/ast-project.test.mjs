/**
 * Unit test for scripts/checks/lib/ast-project.mjs — the shared file collector
 * behind the AST CI gates. Covers the exclusion rules and the single-file target
 * that a directory-only walk would silently drop (the near-miss that would have
 * removed src/auth.ts from the null-tenant gate's scan).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { walkSourceFiles, collectSourceFiles } from "../checks/lib/ast-project.mjs";

let root;

function write(rel) {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, "export const x = 1;\n", "utf8");
  return full;
}

function rels(files) {
  return files.map((f) => relative(root, f).split("\\").join("/")).sort();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ast-project-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("walkSourceFiles", () => {
  it("collects .ts/.tsx recursively and excludes test files + __tests__ dirs", () => {
    write("src/a.ts");
    write("src/nested/b.tsx");
    write("src/a.test.ts");
    write("src/c.test.tsx");
    write("src/__tests__/d.ts");
    write("src/e.js");
    expect(rels(walkSourceFiles(join(root, "src")))).toEqual([
      "src/a.ts",
      "src/nested/b.tsx",
    ]);
  });

  it("returns empty for a missing directory (never throws)", () => {
    expect(walkSourceFiles(join(root, "nope"))).toEqual([]);
  });
});

describe("collectSourceFiles", () => {
  it("includes a single-file target alongside directory targets", () => {
    write("src/app/x.ts");
    write("src/lib/y.ts");
    write("src/auth.ts");
    const files = collectSourceFiles(["src/app", "src/lib", "src/auth.ts"], root);
    expect(rels(files)).toEqual(["src/app/x.ts", "src/auth.ts", "src/lib/y.ts"]);
  });

  it("skips a single-file target that is a test file", () => {
    write("src/auth.test.ts");
    expect(collectSourceFiles(["src/auth.test.ts"], root)).toEqual([]);
  });

  it("skips a non-existent target", () => {
    write("src/real.ts");
    const files = collectSourceFiles(["src/real.ts", "src/gone.ts"], root);
    expect(rels(files)).toEqual(["src/real.ts"]);
  });

  it("accepts an ABSOLUTE directory target (sourceFiles passes an absolute srcDir)", () => {
    write("src/a.ts");
    const files = collectSourceFiles([join(root, "src")], root);
    expect(rels(files)).toEqual(["src/a.ts"]);
  });
});
