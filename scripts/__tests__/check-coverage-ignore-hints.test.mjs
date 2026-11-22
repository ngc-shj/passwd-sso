/**
 * Self-test for scripts/checks/check-coverage-ignore-hints.mjs (plan C2c).
 *
 * The provider reads `if|else|next|file` hints from comments and
 * `start|stop` hints from raw lines; each scope has deny cases here, plus the
 * spellings and whitespace the provider's `\s+` accepts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { scanMembers, scanSource } from "../checks/check-coverage-ignore-hints.mjs";
import { listMembers } from "../checks/lib/coverage-members.mjs";

const REPO = resolve(import.meta.dirname, "../..");
const GATE = resolve(REPO, "scripts/checks/check-coverage-ignore-hints.mjs");

let tmp;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe("comment scope (if | else | next | file)", () => {
  it.each([
    ["a single space", "// c8 ignore next\nconst a = 1;\n"],
    ["a double space", "//  v8  ignore  if\nif (a) b();\n"],
    ["a tab", "/*\tistanbul\tignore\telse\t*/\nif (a) b(); else c();\n"],
    ["a newline", "/* c8\n   ignore\n   next */\nconst a = 1;\n"],
    ["node:coverage", "// node:coverage ignore next\nconst a = 1;\n"],
    ["the c8 spelling", "// c8 ignore file\n"],
    ["the istanbul spelling", "/* istanbul ignore next */\nconst a = 1;\n"],
    ["upper case", "// C8 IGNORE NEXT\nconst a = 1;\n"],
    ["a same-line trailing comment", "const a = 1; // c8 ignore next\n"],
  ])("refuses a hint with %s", (_label, source) => {
    expect(scanSource("src/x.ts", source)).toEqual([expect.stringMatching(/^src\/x\.ts:1: COVERAGE_IGNORE_HINT \(comment\)/)]);
  });

  it("refuses a comment hint inside a JSX expression", () => {
    const source = "export const A = () => (\n  <div>\n    {/* c8 ignore next */}\n  </div>\n);\n";
    expect(scanSource("src/x.tsx", source)).toEqual([expect.stringMatching(/^src\/x\.tsx:3: COVERAGE_IGNORE_HINT \(comment\)/)]);
  });

  it("does not treat a comment-scope hint in a string literal as a comment", () => {
    expect(scanSource("src/x.ts", 'const s = "// c8 ignore next";\n')).toEqual([]);
  });

  it("allows a comment that mentions ignoring in prose", () => {
    expect(scanSource("src/x.ts", "// ignore next-tick errors; c8 reports them separately\nconst a = 1;\n")).toEqual([]);
  });
});

describe("raw-line scope (start | stop)", () => {
  it.each([
    ["a comment", "/* c8 ignore start */\nconst a = 1;\n/* c8 ignore stop */\n"],
    ["a string literal", 'const s = "v8 ignore start";\n'],
    ["a template literal", "const s = `istanbul ignore stop`;\n"],
    ["JSX text", "export const A = () => <p>c8 ignore start</p>;\n"],
  ])("refuses ignore start/stop inside %s", (_label, source) => {
    const path = source.includes("<p>") ? "src/x.tsx" : "src/x.ts";
    const hits = scanSource(path, source);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.includes("COVERAGE_IGNORE_HINT (line)"))).toBe(true);
  });
});

describe("member scan", () => {
  it("refuses a hint in root proxy.ts", () => {
    tmp = mkdtempSync(join(tmpdir(), "ignore-hints-"));
    writeFileSync(join(tmp, "proxy.ts"), "// c8 ignore next\nexport const x = 1;\n");
    expect(scanMembers(["proxy.ts"], tmp)).toEqual([expect.stringMatching(/^proxy\.ts:1: COVERAGE_IGNORE_HINT/)]);
    expect(listMembers()).toContain("proxy.ts");
  });

  it("refuses an empty member list", () => {
    expect(() => scanMembers([])).toThrow(/COVERAGE_MEMBERS_EMPTY/);
  });

  it("passes on the real tree", () => {
    const stdout = execFileSync("node", [GATE], { cwd: REPO, encoding: "utf8", stdio: "pipe" });
    expect(stdout).toMatch(/^check-coverage-ignore-hints: OK \(\d{4,} members scanned\)/);
  });
});
