/**
 * A script decides whether it runs as a CLI by comparing its own URL with
 * `process.argv[1]`. Every such decision must use the one form that survives a
 * symlinked path and a path needing URL encoding:
 *
 *   if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) { main(); }
 *
 * Any other spelling (`file://${process.argv[1]}`, `pathToFileURL(argv[1])`
 * without realpath, `import.meta.filename === argv[1]`, …) makes the script a
 * silent exit-0 no-op on such a path — a gate that checks nothing.
 *
 * Recognising wrong spellings cannot be complete, so this test REFUSES instead:
 * every read of `process.argv` in a non-test script must take one of a closed
 * set of shapes (`.slice`, `.includes`, `[2]`, passed to a parser, …), and
 * `process.argv[1]` may appear only inside the canonical guard (or in the three
 * CJS-bundled scripts that match `argv[1].endsWith(...)`, where
 * `import.meta.url` is undefined after bundling). `import.meta.filename`,
 * `.main` and `.dirname`, aliasing or destructuring `argv`, and `.at()` are
 * refused outright. A new legitimate shape is added here deliberately.
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

// The scripts that carry the canonical guard today. Pinned rather than counted,
// so removing one guard is caught even after another script gains one.
const GUARDED = [
  "scripts/audit-db-grants.mjs",
  "scripts/bootstrap-rds-roles.mjs",
  "scripts/check-blame-ignore-revs.mjs",
  "scripts/check-codeowners-drift.mjs",
  "scripts/checks/check-compose-log-caps.mjs",
  "scripts/checks/check-crypto-auth-deps-classified.mjs",
  "scripts/checks/check-destructive-migration.mjs",
  "scripts/checks/check-migration-rls-dml.mjs",
  "scripts/checks/check-migration-transaction.mjs",
  "scripts/checks/check-override-floor-staleness.mjs",
  "scripts/checks/check-override-key-disjointness.mjs",
  "scripts/checks/check-required-aggregate.mjs",
  "scripts/checks/check-workflow-supply-chain.mjs",
  "scripts/checks/verify-npm-provenance-source.mjs",
  "scripts/generate-security-matrices.ts",
  "scripts/init-env.ts",
  "scripts/lib/hex-leak-scan.mjs",
  "scripts/lib/scram-verifier.mjs",
  "scripts/migrate-account-tokens-to-encrypted.ts",
  "scripts/tenant-domain.ts",
];

// CJS-bundled entry points: `import.meta.url` is undefined in the bundle, so
// they match `process.argv[1].endsWith(<own name>)` instead.
const ENDS_WITH_FILES = new Set([
  "scripts/audit-chain-verify-worker.ts",
  "scripts/check-env-docs.ts",
  "scripts/migrate-webhook-secrets-v1-to-v2.ts",
]);

const ARGV_METHODS = new Set(["slice", "includes", "find", "indexOf", "length"]);

const files = spawnSync(
  "git",
  ["ls-files", "scripts/*.mjs", "scripts/*.ts", "scripts/*.mts", "scripts/*.js", "scripts/*.cjs"],
  { encoding: "utf8" },
)
  .stdout.split("\n")
  .filter((f) => f && !f.includes("/__tests__/"));

const norm = (node) => node.getText().replace(/\s+/g, " ");

/** The outermost expression containing `node`, within its own statement. */
function outerExpression(node) {
  let outer = node;
  for (const a of node.getAncestors()) {
    if (!Node.isExpression(a)) break;
    outer = a;
  }
  return outer;
}

/** Problems with a canonical guard's surroundings, or [] when it is sound. */
function guardShapeProblems(sf, guard) {
  const out = [];
  const stmt = guard.getParent();
  if (!Node.isIfStatement(stmt) || stmt.getExpression() !== guard) {
    out.push("the guard must be the whole condition of an `if`");
  } else {
    if (stmt.getElseStatement()) out.push("the guarded `if` must have no `else`");
    if (stmt.getThenStatement().getDescendantsOfKind(SyntaxKind.CallExpression).length === 0) {
      out.push("the guarded `if` must call the entry point");
    }
  }
  const usesNamespace = norm(guard).includes("fs.realpathSync");
  const imports = sf.getImportDeclarations();
  const named = (mod, name) =>
    imports.some((d) => d.getModuleSpecifierValue() === mod && d.getNamedImports().some((n) => n.getName() === name && !n.getAliasNode()));
  if (usesNamespace) {
    if (!imports.some((d) => d.getModuleSpecifierValue() === "node:fs" && d.getNamespaceImport()?.getText() === "fs")) {
      out.push("`fs` must be `import * as fs from \"node:fs\"`");
    }
  } else if (!named("node:fs", "realpathSync")) {
    out.push("`realpathSync` must be imported from node:fs");
  }
  if (!named("node:url", "pathToFileURL")) out.push("`pathToFileURL` must be imported from node:url");
  for (const decl of [
    ...sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration),
    ...sf.getDescendantsOfKind(SyntaxKind.FunctionDeclaration),
    ...sf.getDescendantsOfKind(SyntaxKind.Parameter),
  ]) {
    const n = decl.getNameNode?.()?.getText();
    if (n === "realpathSync" || n === "pathToFileURL" || n === "fs") out.push(`\`${n}\` is shadowed locally`);
  }
  return out;
}

/**
 * Every refused `process.argv` / `import.meta` shape in one source text, and the
 * number of canonical guards found.
 * @returns {{ problems: string[], guards: number }}
 */
function scan(path, text) {
  const sf = createAstProject().createSourceFile(path, text, { overwrite: true });
  const problems = [];
  const at = (node, msg) => problems.push(`${path}:${node.getStartLineNumber()}: ${msg}: ${norm(node).slice(0, 120)}`);
  const guards = new Set();

  for (const meta of sf.getDescendantsOfKind(SyntaxKind.MetaProperty)) {
    const parent = meta.getParent();
    if (Node.isPropertyAccessExpression(parent) && parent.getName() !== "url") {
      at(parent, "import.meta." + parent.getName() + " is refused (use the canonical guard)");
    }
  }
  for (const el of sf.getDescendantsOfKind(SyntaxKind.BindingElement)) {
    const key = el.getPropertyNameNode()?.getText() ?? el.getNameNode().getText();
    if (key === "argv") at(el, "destructuring `argv` is refused");
  }
  for (const ea of sf.getDescendantsOfKind(SyntaxKind.ElementAccessExpression)) {
    if (/^["'`]argv["'`]$/.test(ea.getArgumentExpression()?.getText() ?? "")) at(ea, "`[\"argv\"]` access is refused");
  }
  for (const pa of sf.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
    if (pa.getName() !== "argv") continue;
    if (pa.getExpression().getText() !== "process") {
      at(pa, "`argv` must be read as `process.argv`");
      continue;
    }
    const parent = pa.getParent();
    if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === pa) {
      if (!ARGV_METHODS.has(parent.getName())) at(parent, `process.argv.${parent.getName()} is refused`);
      continue;
    }
    if (Node.isCallExpression(parent) && parent.getArguments().includes(pa)) continue;
    if (Node.isElementAccessExpression(parent) && parent.getExpression() === pa) {
      if (parent.getArgumentExpression()?.getText() !== "1") continue;
      if (ENDS_WITH_FILES.has(path)) continue;
      const outer = outerExpression(parent);
      if (CANONICAL.has(norm(outer))) {
        if (!guards.has(outer)) {
          guards.add(outer);
          for (const p of guardShapeProblems(sf, outer)) at(outer, p);
        }
        continue;
      }
      at(parent, "process.argv[1] outside the canonical guard is refused");
      continue;
    }
    at(pa, "this use of process.argv is refused");
  }
  return { problems, guards: guards.size };
}

describe("script CLI entry guards", () => {
  const results = files.map((f) => ({ file: f, ...scan(f, readFileSync(f, "utf8")) }));

  it("git ls-files listed scripts", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("the canonical guard is in exactly the pinned scripts, once each", () => {
    const guarded = results.filter((r) => r.guards > 0);
    expect(guarded.map((r) => r.file).sort()).toEqual([...GUARDED].sort());
    expect(guarded.every((r) => r.guards === 1)).toBe(true);
  });

  it("no script reads process.argv or import.meta in a refused shape", () => {
    expect(results.flatMap((r) => r.problems)).toEqual([]);
  });

  const GOOD = [
    'import { realpathSync } from "node:fs";',
    'import { pathToFileURL } from "node:url";',
    "const args = process.argv.slice(2);",
    "if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {",
    "  main();",
    "}",
  ].join("\n");
  const IMPORTS = 'import { realpathSync } from "node:fs";\nimport { pathToFileURL } from "node:url";\n';

  it("accepts the canonical guard and ordinary argument reads", () => {
    expect(scan("good.mjs", GOOD)).toEqual({ problems: [], guards: 1 });
  });

  const REFUSED = {
    "file:// template": "if (import.meta.url === `file://${process.argv[1]}`) main();",
    "pathToFileURL without realpath": "if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();",
    "fileURLToPath comparison": "if (fileURLToPath(import.meta.url) === process.argv[1]) main();",
    "split const": "const e = pathToFileURL(process.argv[1]).href;\nif (import.meta.url === e) main();",
    "import.meta.filename": "if (import.meta.filename === process.argv[1]) main();",
    "import.meta.filename alone": "if (import.meta.filename.endsWith('x.mjs')) main();",
    "import.meta.main": "if (import.meta.main) main();",
    "argv.at(1)": "if (import.meta.url.endsWith(process.argv.at(1))) main();",
    "array destructuring": "const [, script] = process.argv;",
    "object destructuring": "const { argv } = process;\nif (argv[1]) main();",
    "optional chaining": "if (process.argv?.[1]) main();",
    "string-keyed access": "if (process['argv'][1]) main();",
    "globalThis.process": "if (globalThis.process.argv[1]) main();",
    "globalThis.process with an allowed method": "const args = globalThis.process.argv.slice(2);",
    "aliased argv": "const a = process.argv;\nif (a[1]) main();",
    "canonical guard with else": `${IMPORTS}if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {} else { main(); }`,
    "canonical guard with empty body": `${IMPORTS}if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {}`,
    "canonical guard negated": `${IMPORTS}if (!(process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)) main();`,
    "canonical guard without imports": "if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();",
    "shadowed realpathSync": `${IMPORTS}const realpathSync = () => "";\nif (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();`,
  };
  for (const [label, text] of Object.entries(REFUSED)) {
    it(`refuses: ${label}`, () => {
      expect(scan("bad.mjs", text).problems).not.toEqual([]);
    });
  }
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
