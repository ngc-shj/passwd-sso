/**
 * Unit test for scripts/checks/lib/ast-project.mjs — the shared file collector
 * behind the AST CI gates. Covers the exclusion rules and the single-file target
 * that a directory-only walk would silently drop (the near-miss that would have
 * removed src/auth.ts from the null-tenant gate's scan).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
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

describe("walkSourceFiles — inputs it refuses rather than guesses about", () => {
  /**
   * Every case here was found by review of a version that FOLLOWED symlinks.
   * Following resolved a real blind spot (a symlinked directory's subtree went
   * unscanned in silence) and opened three worse ones, because the two
   * exclusions below key on the entry name and a link's name need not match its
   * target: `ln -s ./__tests__ helpers` and `ln -s ./a.test.ts b.ts` walked
   * straight through both. It also removed the walk's boundary — a link to
   * node_modules took a probe from 0 to 14,019 files, and a gate printed the
   * source of an out-of-repo file into a CI log under an in-repo path.
   */
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ast-walk-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a symlinked directory by name, instead of scanning or skipping it", () => {
    mkdirSync(join(dir, "__tests__"));
    writeFileSync(join(dir, "__tests__", "helper.ts"), "export const t = 1;\n");
    symlinkSync("./__tests__", join(dir, "helpers"));
    expect(() => walkSourceFiles(dir)).toThrow(/refusing to decide about a symlink/);
    expect(() => walkSourceFiles(dir)).toThrow(/helpers/);
  });

  it("refuses a symlink to a test file, which would otherwise re-enter under a clean name", () => {
    writeFileSync(join(dir, "a.test.ts"), "export const t = 1;\n");
    symlinkSync("./a.test.ts", join(dir, "alias.ts"));
    expect(() => walkSourceFiles(dir)).toThrow(/refusing to decide about a symlink/);
  });

  it("refuses a dangling symlink too — 'resolves to nothing' is still a decision", () => {
    symlinkSync("./does-not-exist", join(dir, "gone.ts"));
    expect(() => walkSourceFiles(dir)).toThrow(/refusing to decide about a symlink/);
  });

  it("names the offending path, so the refusal is actionable", () => {
    symlinkSync("/etc", join(dir, "outside"));
    expect(() => walkSourceFiles(dir)).toThrow(new RegExp(join(dir, "outside").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("still walks an ordinary tree, so the refusal has not emptied the scan", () => {
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "keep.ts"), "export const k = 1;\n");
    writeFileSync(join(dir, "sub", "deep.ts"), "export const d = 1;\n");
    writeFileSync(join(dir, "skip.test.ts"), "export const s = 1;\n");
    expect(walkSourceFiles(dir).map((f) => f.replace(`${dir}/`, "")).sort()).toEqual([
      "keep.ts",
      "sub/deep.ts",
    ]);
  });

  it("excludes *.spec.* alongside *.test.*", () => {
    writeFileSync(join(dir, "keep.ts"), "export const k = 1;\n");
    writeFileSync(join(dir, "a.spec.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "b.spec.tsx"), "export const b = 1;\n");
    expect(walkSourceFiles(dir).map((f) => f.replace(`${dir}/`, ""))).toEqual(["keep.ts"]);
  });
});
