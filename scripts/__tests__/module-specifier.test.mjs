/**
 * Unit tests for scripts/checks/lib/module-specifier.mjs — the "may this
 * specifier load module X" analysis shared by check-crypto-domains (Check E)
 * and check-mutation-response-read. Specifiers are decided by resolution, so
 * each case resolves against a fixture tree (tsconfig with the repo's `@/`
 * mapping, a package under node_modules) written to a temp directory.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Project, SyntaxKind } from "ts-morph";
import { bindingIndex } from "../checks/lib/scope-bindings.mjs";
import {
  createModuleResolver,
  loadArgumentMayName,
  loaderArgument,
  loaderNodes,
  moduleLoaderOf,
  templateAllowlist,
} from "../checks/lib/module-specifier.mjs";

const TARGET = "src/lib/url-helpers.ts";
const INDEX = "src/lib/constants/index.ts";
const FROM = "src/components/a.ts";

const TREE = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { module: "esnext", moduleResolution: "bundler", allowJs: true, resolveJsonModule: true, paths: { "@/*": ["./src/*"] } } }),
  [TARGET]: "export const fetchApi = 1;\n",
  "src/lib/url-helpers-x.ts": "export {};\n",
  "src/lib/urls/x.ts": "export {};\n",
  "src/lib/urls/index.ts": "export {};\n",
  "src/lib/other.ts": "export {};\n",
  [INDEX]: "export {};\n",
  "src/lib/shadow.ts": "export {};\n",
  "src/lib/shadow.js": "export * from './url-helpers';\n",
  "src/lib/decl.d.ts": "export {};\n",
  "src/lib/data.json": "{}\n",
  "src/app/api/r/route.ts": "export * from '@/lib/url-helpers';\n",
  "node_modules/@scope/pkg/package.json": JSON.stringify({ name: "@scope/pkg", types: "index.d.ts" }),
  "node_modules/@scope/pkg/index.d.ts": "export {};\n",
};

let base;
let root;
let resolver;
const isScanned = (rel) => rel.startsWith("src/") && !rel.startsWith("src/app/api/");

beforeAll(() => {
  // The repository is a directory of `base`, so a specifier can resolve outside it.
  base = mkdtempSync(join(tmpdir(), "module-specifier-"));
  root = join(base, "repo");
  writeFileSync(join(base, "outside.ts"), "export * from './repo/src/lib/url-helpers';\n");
  for (const [rel, content] of Object.entries(TREE)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  resolver = createModuleResolver({ root, isScanned });
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

const project = new Project({ useInMemoryFileSystem: true });

function loaderNode(code) {
  const sf = project.createSourceFile(`/case-${Math.random().toString(36).slice(2)}.ts`, code);
  const node = [...sf.getDescendantsOfKind(SyntaxKind.CallExpression), ...sf.getDescendantsOfKind(SyntaxKind.ImportEqualsDeclaration)].find((n) => moduleLoaderOf(n));
  return { sf, node };
}

function mayLoad(code, { targets = [TARGET], from = FROM, templates } = {}) {
  const { sf, node } = loaderNode(code);
  return loadArgumentMayName(loaderArgument(node), from, targets, () => bindingIndex(sf), resolver, templates);
}

describe("createModuleResolver: a specifier that resolves to the target names it", () => {
  it.each([
    ["@/lib/url-helpers"],
    ["@/lib/../lib/url-helpers"],
    ["@/lib//url-helpers"],
    ["@/./lib/url-helpers"],
    ["@/lib/./url-helpers"],
    ["@/components/../lib/url-helpers"],
    ["../lib/url-helpers"],
    ["../lib/url-helpers.ts"],
    ["../lib/../lib/url-helpers"],
  ])("%s", (spec) => {
    expect(resolver.names(spec, FROM, [TARGET])).toBe(true);
    expect(resolver.mayName(spec, FROM, [TARGET])).toBe(true);
  });

  it.each([["@/lib/constants/"], ["../lib/constants/"], ["@/lib/constants"], ["@/lib/constants/index"], ["@/lib/./constants/"]])(
    "%s names a directory index target",
    (spec) => {
      expect(resolver.names(spec, FROM, [INDEX])).toBe(true);
    },
  );
});

describe("createModuleResolver: a specifier that resolves elsewhere names nothing", () => {
  it.each([
    ["@/lib/url-helpers-x", "src/lib/url-helpers-x.ts"],
    ["@/lib/urls/x", "src/lib/urls/x.ts"],
    ["@/lib/urls/", "src/lib/urls/index.ts"],
    ["../lib/other", "src/lib/other.ts"],
  ])("%s resolves to the scanned file %s", (spec, rel) => {
    expect(resolver.resolve(spec, FROM)).toEqual({ kind: "file", rel });
    expect(resolver.mayName(spec, FROM, [TARGET])).toBe(false);
  });

  it.each([["@scope/pkg"], ["node:module"], ["fs"], ["@/lib/data.json"]])("%s (a package, builtin or data file)", (spec) => {
    expect(resolver.resolve(spec, FROM)).toEqual({ kind: "none" });
    expect(resolver.mayName(spec, FROM, [TARGET])).toBe(false);
  });
});

describe("createModuleResolver: an undecidable specifier may name any target", () => {
  it.each([
    ["an unresolvable alias path", "@/lib/nope"],
    ["an unresolvable package", "not-installed-anywhere"],
    ["a trailing slash after a file", "@/lib/url-helpers/"],
    ["a query suffix", "../lib/url-helpers?x"],
    ["a declaration file (some other file runs)", "@/lib/decl"],
    ["a file a same-stem .js sibling may shadow", "@/lib/shadow"],
    ["a source file the gate does not scan", "@/app/api/r/route"],
    ["a file outside the repository", "../../../outside"],
  ])("%s: %s", (_label, spec) => {
    expect(resolver.resolve(spec, FROM).kind).toBe("opaque");
    expect(resolver.mayName(spec, FROM, [TARGET])).toBe(true);
    // An exemption needs the target itself, which "may" is not.
    expect(resolver.names(spec, FROM, [TARGET])).toBe(false);
  });

  it("tells a file outside the repository from an unresolvable specifier", () => {
    expect(resolver.resolve("../../../outside", FROM)).toEqual({ kind: "opaque", why: "resolves outside the repository" });
  });

  it("refuses a tree with no tsconfig.json at its root", () => {
    const bare = mkdtempSync(join(tmpdir(), "module-specifier-bare-"));
    try {
      expect(() => createModuleResolver({ root: bare, isScanned })).toThrow(/no tsconfig\.json/);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe("moduleLoaderOf", () => {
  it("recognises import(), require(), import = require() and require.context(), and nothing else", () => {
    const sf = project.createSourceFile(
      "/loaders.ts",
      'import("a");\nrequire("b");\nload("c");\nrequire.context("../lib", true);\nimport X = require("d");\nimport Y = N.M;\n',
    );
    const nodes = [...sf.getDescendantsOfKind(SyntaxKind.CallExpression), ...sf.getDescendantsOfKind(SyntaxKind.ImportEqualsDeclaration)];
    expect(nodes.map(moduleLoaderOf)).toEqual(["import()", "require()", null, "require.context()", "import = require()", null]);
  });
});

describe("loaderNodes", () => {
  it("yields every run-time loader and skips a type-only import = require()", () => {
    const sf = project.createSourceFile(
      "/loader-nodes.ts",
      'import("a");\nload("b");\nimport type T = require("c");\nimport U = require("d");\n',
    );
    expect([...loaderNodes(sf)].map(({ node, loader }) => [loader, loaderArgument(node).getText()])).toEqual([
      ["import()", '"a"'],
      ["import = require()", '"d"'],
    ]);
  });
});

describe("loadArgumentMayName", () => {
  it.each([
    ['import("@/lib/../lib/url-helpers")'],
    ['import("@/lib//url-helpers")'],
    ['require("@/./lib/url-helpers")'],
    ['import U = require("@/lib/./url-helpers");'],
    ['const m = "@/components/../lib/url-helpers";\nimport(m);'],
  ])("resolves the argument of %s to the target", (code) => {
    expect(mayLoad(code)).toBe(true);
  });

  it.each([['import("@/lib/url-helpers-x")'], ['import U = require("@scope/pkg");'], ['const m = "@scope/pkg";\nimport(m);']])(
    "rules the target out for %s",
    (code) => {
      expect(mayLoad(code)).toBe(false);
    },
  );

  it.each([
    ["an alias head", "import(`@/lib/./${p}`)"],
    ["a head with .. in it", "import(`@/lib/../lib/url-${p}`)"],
    ["a relative head with a literal tail", "import(`../../messages/${p}.json`)"],
    ["a bare package head (Node resolves pkg/../.. out of the package)", "import(`lodash/${p}`)"],
  ])("refuses a template with %s", (_label, call) => {
    expect(mayLoad(`declare const p: string;\n${call};\n`)).toBe(true);
  });

  it("accepts an allowlisted template only in its file and by its exact text", () => {
    const templates = templateAllowlist([{ file: "src/i18n/m.ts", template: "`../../messages/${p}.json`", count: 1, reason: "test" }]);
    const code = "declare const p: string;\nimport(`../../messages/${p}.json`);\n";
    expect(mayLoad(code, { from: "src/i18n/m.ts", templates })).toBe(false);
    expect(mayLoad(code, { from: "src/i18n/other.ts", templates })).toBe(true);
    expect(mayLoad("declare const p: string;\nimport(`../../messages/${p}.ts`);\n", { from: "src/i18n/m.ts", templates })).toBe(true);
  });

  it("refuses require.context whatever its directory", () => {
    expect(mayLoad('require.context("./other-dir", true);')).toBe(true);
  });

  it("refuses an identifier bound by let", () => {
    expect(mayLoad('let name = "@scope/pkg";\nimport(name);')).toBe(true);
  });

  it("refuses an identifier destructured from a const string", () => {
    expect(mayLoad('const [s] = "./x";\nimport(s);')).toBe(true);
  });

  it("refuses a load with no argument", () => {
    expect(mayLoad("require();")).toBe(true);
  });

  it("answers may when any one of several targets is named", () => {
    expect(mayLoad('import("@/lib/constants/");', { targets: [TARGET, INDEX] })).toBe(true);
  });
});

describe("templateAllowlist", () => {
  const entry = { file: "src/i18n/m.ts", template: "`a/${p}`", count: 2, reason: "test" };

  it("reports an entry whose file holds its template a different number of times", () => {
    const templates = templateAllowlist([entry]);
    const { sf } = loaderNode("declare const p: string;\nimport(`a/${p}`);\n");
    templates.allows(sf.getFirstDescendantByKind(SyntaxKind.TemplateExpression), "src/i18n/m.ts");
    expect(templates.stale(new Set(["src/i18n/m.ts"]), false)).toEqual([
      "src/i18n/m.ts: template `a/${p}` matched 1 time(s), expected 2 (stale template loader allowlist entry)",
    ]);
  });

  it("reports an entry whose file is gone only for a whole scan", () => {
    const templates = templateAllowlist([entry]);
    expect(templates.stale(new Set(), false)).toEqual([]);
    expect(templates.stale(new Set(), true)).toEqual(["src/i18n/m.ts: template loader allowlist entry names a file that is not scanned (stale)"]);
  });
});
