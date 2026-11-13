/**
 * Every script that compares `import.meta.url` with `process.argv[1]` to decide
 * whether it was run as a CLI must use the one form that survives a symlinked
 * path and a path needing URL encoding:
 *
 *   process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
 *
 * Any other spelling (`file://${process.argv[1]}`, `pathToFileURL(argv[1])`
 * without realpath, `fileURLToPath(import.meta.url) === argv[1]`) makes the
 * script a silent exit-0 no-op on such a path — a gate that checks nothing.
 * The check is AST-based (ts-morph, no Program) so a reformatted guard is
 * still recognised; the CJS-bundled workers that match on `argv[1].endsWith`
 * never touch `import.meta.url` and are outside the class.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Node, SyntaxKind } from "ts-morph";
import { afterEach, describe, expect, it } from "vitest";
import { createAstProject } from "../checks/lib/ast-project.mjs";

const CANONICAL = new Set([
  "process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href",
  "process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href",
]);

const files = spawnSync("git", ["ls-files", "scripts/*.mjs", "scripts/*.ts"], { encoding: "utf8" })
  .stdout.split("\n")
  .filter((f) => f && !f.includes("/__tests__/"));

/**
 * For each `process.argv[1]`, the outermost expression around it within its
 * own statement, kept when that expression also holds `import.meta.url` (one
 * entry per expression, however many `argv[1]` it reads).
 */
function entryComparisons(path) {
  const project = createAstProject();
  const sf = project.createSourceFile(path, readFileSync(path, "utf8"), { overwrite: true });
  const found = new Set();
  for (const access of sf.getDescendantsOfKind(SyntaxKind.ElementAccessExpression)) {
    if (access.getText() !== "process.argv[1]") continue;
    let outer = access;
    for (const a of access.getAncestors()) {
      // A template span (`${process.argv[1]}`) sits between expressions.
      if (!Node.isExpression(a) && !Node.isTemplateSpan(a)) break;
      outer = a;
    }
    if (outer.getText().includes("import.meta.url")) found.add(outer);
  }
  return [...found].map((n) => n.getText().replace(/\s+/g, " "));
}

describe("script CLI entry guards", () => {
  const all = files.flatMap((f) => entryComparisons(f).map((text) => ({ file: f, text })));

  it("git ls-files listed scripts", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("finds the known canonical guards (positive control)", () => {
    expect(all.filter((g) => CANONICAL.has(g.text)).length).toBeGreaterThanOrEqual(20);
  });

  it("every import.meta.url / process.argv[1] comparison uses the canonical form", () => {
    expect(all.filter((g) => !CANONICAL.has(g.text))).toEqual([]);
  });

  it("flags the old forms (the detector can fail)", () => {
    const dir = mkdtempSync(join(tmpdir(), "main-guard-"));
    try {
      const bad = [
        "if (import.meta.url === `file://${process.argv[1]}`) main();",
        "if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();",
        "if (fileURLToPath(import.meta.url) === process.argv[1]) main();",
      ];
      for (const [i, line] of bad.entries()) {
        const path = join(dir, `s${i}.mjs`);
        writeFileSync(path, `${line}\n`);
        const texts = entryComparisons(path);
        expect(texts).toHaveLength(1);
        expect(CANONICAL.has(texts[0])).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Scripts no other test imports: a missing realpathSync / pathToFileURL import
// would otherwise surface only when someone runs them.
describe("unimported CLI scripts still load", () => {
  for (const path of ["scripts/check-blame-ignore-revs.mjs", "scripts/check-codeowners-drift.mjs"]) {
    it(`${path} imports without error`, async () => {
      await expect(import(resolve(path))).resolves.toBeDefined();
    });
  }
});

// The guard is what decides whether these gates check anything when CI or the
// release job runs them; a false guard would exit 0 silently.
describe("security gate CLIs reach main()", () => {
  const dirs = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
  });

  it("verify-npm-provenance-source exits 1 on empty stdin", () => {
    const res = spawnSync(process.execPath, [resolve("scripts/checks/verify-npm-provenance-source.mjs")], {
      input: "",
      encoding: "utf8",
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/audit output is not valid JSON/);
  });

  it("check-workflow-supply-chain exits 1 on a dependabot auto-merge workflow", () => {
    const dir = mkdtempSync(join(tmpdir(), "supply-chain-cli-"));
    dirs.push(dir);
    mkdirSync(join(dir, ".github/workflows"), { recursive: true });
    writeFileSync(
      join(dir, ".github/workflows/automerge.yml"),
      [
        "on: pull_request",
        "jobs:",
        "  automerge:",
        "    if: github.actor == 'dependabot[bot]'",
        "    steps:",
        '      - run: gh pr merge --auto --squash "$PR_URL"',
        "",
      ].join("\n"),
    );
    const res = spawnSync(process.execPath, [resolve("scripts/checks/check-workflow-supply-chain.mjs")], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/Supply-chain workflow guard failed/);
  });
});
