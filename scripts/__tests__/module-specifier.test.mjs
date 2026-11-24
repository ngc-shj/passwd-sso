/**
 * Unit tests for scripts/checks/lib/module-specifier.mjs — the "may this
 * specifier load module X" analysis shared by check-crypto-domains (Check E)
 * and check-mutation-response-read. Specifiers are decided by resolution, so
 * each case resolves against a fixture tree (tsconfig with the repo's `@/`
 * mapping, a package under node_modules) written to a temp directory. The
 * split fixtures (a package linked into the repo, a nested package.json whose
 * `types` and `main` or whose `exports` conditions disagree) were checked
 * against esbuild, which loads the `main`/`default` file TypeScript skips.
 * The installed-package fixtures pair an `@types/<pkg>` the compiler resolves
 * with the `<pkg>` a runtime loads, as react and @types/react are.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
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

// Every package.json field outside the inert allowlist that some resolver
// selects an entry by, each alone in a package.json beside `name`.
const ENTRY_FIELDS = [
  ["main", "./a.ts"],
  ["module", "./a.ts"],
  ["browser", "./a.ts"],
  ["types", "./a.ts"],
  ["typesVersions", { "*": { "*": ["./*"] } }],
  ["exports", { ".": "./a.ts" }],
  ["imports", { "#a": "./a.ts" }],
];

// A lockfile entry npm writes for a registry install.
const registry = (name, fields = {}) => ({
  version: "1.0.0",
  resolved: `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-1.0.0.tgz`,
  integrity: "sha512-fixture",
  ...fields,
});

// An installed package the compiler resolves by its own types.
const typed = (name, manifest = {}) => ({
  [`node_modules/${name}/package.json`]: JSON.stringify({ name, types: "index.d.ts", ...manifest }),
  [`node_modules/${name}/index.d.ts`]: "export {};\n",
});

// The repository's lockfile: every installed package the "none" cases load, and
// one per source a lockfile can record.
const LOCK = {
  lockfileVersion: 3,
  packages: {
    "": { name: "repo" },
    "node_modules/@scope/pkg": registry("@scope/pkg"),
    "node_modules/react-like": registry("react-like"),
    "node_modules/@types/react-like": registry("@types/react-like"),
    "node_modules/@scope/typed": registry("@scope/typed"),
    "node_modules/@types/scope__typed": registry("@types/scope__typed"),
    "node_modules/patched-pkg": registry("patched-pkg"),
    "node_modules/uses-patched": registry("uses-patched", { dependencies: { "patched-pkg": "1.0.0" } }),
    "node_modules/uses-uses": registry("uses-uses", { peerDependencies: { "uses-patched": "1.0.0" } }),
    // Its dependency is a nested copy, which patches/ still names.
    "node_modules/nests-patched": registry("nests-patched", { dependencies: { "patched-pkg": "1.0.0" } }),
    "node_modules/nests-patched/node_modules/patched-pkg": registry("patched-pkg"),
    "node_modules/from-file": { version: "1.0.0", resolved: "file:vendor/from-file-1.0.0.tgz", integrity: "sha512-fixture" },
    "node_modules/from-git": { version: "1.0.0", resolved: "git+ssh://git@github.com/o/from-git.git#0123456", integrity: "sha512-fixture" },
    "node_modules/from-url": { version: "1.0.0", resolved: "https://example.com/archive/from-url.tgz", integrity: "sha512-fixture" },
    "node_modules/no-integrity": { version: "1.0.0", resolved: "https://registry.npmjs.org/no-integrity/-/no-integrity-1.0.0.tgz" },
    "node_modules/no-source": { version: "1.0.0" },
    "node_modules/from-link": { resolved: "vendor/from-link", link: true },
    "node_modules/bundler": registry("bundler", { bundleDependencies: ["bundled"] }),
    "node_modules/bundler/node_modules/bundled": { version: "1.0.0", inBundle: true },
    "node_modules/file-bundler": { version: "1.0.0", resolved: "file:vendor/file-bundler-1.0.0.tgz", integrity: "sha512-fixture" },
    "node_modules/file-bundler/node_modules/bundled": { version: "1.0.0", inBundle: true },
  },
};

const types = (name) => ({
  [`node_modules/@types/${name}/package.json`]: JSON.stringify({ name: `@types/${name}`, types: "index.d.ts" }),
  [`node_modules/@types/${name}/index.d.ts`]: "export {};\n",
});

const TREE = {
  "tsconfig.json": JSON.stringify({
    compilerOptions: { module: "esnext", moduleResolution: "bundler", allowJs: true, resolveJsonModule: true, paths: { "@/*": ["./src/*"], "@alt/*": ["./gen/*", "./src/*"] } },
  }),
  "package.json": JSON.stringify({ name: "repo", private: true, scripts: {}, dependencies: {} }),
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
  // TypeScript follows `types`, a bundler loads `main`.
  "src/pkg-split/package.json": JSON.stringify({ name: "pkg-split", types: "./decoy.ts", main: "./runner.js" }),
  "src/pkg-split/decoy.ts": "export const y = 1;\n",
  "src/pkg-split/runner.js": "export * from '../lib/url-helpers';\n",
  "src/pkg-split/sub/a.ts": "export {};\n",
  // Self-reference through `exports`: TypeScript takes `types`, a bundler `default`.
  "src/pkg-exports/package.json": JSON.stringify({ name: "pkg-exports", exports: { ".": { types: "./decoy.ts", default: "./runner.js" } } }),
  "src/pkg-exports/decoy.ts": "export const y = 1;\n",
  "src/pkg-exports/runner.js": "export * from '../lib/url-helpers';\n",
  "src/pkg-exports/sub/a.ts": "export {};\n",
  "src/pkg-imports/package.json": JSON.stringify({ name: "pkg-imports", imports: { "#x": { types: "./decoy.ts", default: "./runner.js" } } }),
  "src/pkg-imports/decoy.ts": "export const y = 1;\n",
  "src/pkg-imports/runner.js": "export * from '../lib/url-helpers';\n",
  "src/pkg-imports/sub/a.ts": "export {};\n",
  "src/pkg-inert/package.json": JSON.stringify({ name: "pkg-inert", private: true, type: "module", scripts: {}, devDependencies: {} }),
  "src/pkg-inert/a.ts": "export {};\n",
  "src/pkg-junk/package.json": "{ not json\n",
  "src/pkg-junk/a.ts": "export {};\n",
  "src/suffix/tsconfig.json": JSON.stringify({ extends: "../../tsconfig.json", compilerOptions: { moduleSuffixes: [".ios", ""] } }),
  "src/suffix/m.ios.ts": "export {};\n",
  "src/suffix/m.ts": "export * from '../lib/url-helpers';\n",
  // An installed package whose `main` goes through a symlink into the repo.
  "node_modules/escape-pkg/package.json": JSON.stringify({ name: "escape-pkg", types: "./index.d.ts", main: "./lib/url-helpers.ts" }),
  "node_modules/escape-pkg/index.d.ts": "export {};\n",
  ...Object.fromEntries(
    ENTRY_FIELDS.flatMap(([field, value]) => [
      [`src/field-${field}/package.json`, JSON.stringify({ name: `field-${field}`, [field]: value })],
      [`src/field-${field}/a.ts`, "export {};\n"],
    ]),
  ),
  // The compiler resolves `@types/<pkg>`; the runtime loads `<pkg>`.
  ...types("types-linked"), // node_modules/types-linked is linked from linked-src/ (beforeAll)
  "linked-src/types-linked/package.json": JSON.stringify({ name: "types-linked", main: "index.js" }),
  "linked-src/types-linked/index.js": "module.exports = require('../../src/lib/url-helpers');\n",
  ...types("types-escape"),
  "node_modules/types-escape/package.json": JSON.stringify({ name: "types-escape", main: "../../linked-src/escape-runner.js" }),
  "linked-src/escape-runner.js": "module.exports = require('../src/lib/url-helpers');\n",
  ...types("types-orphan"),
  ...types("react-like"),
  "node_modules/react-like/package.json": JSON.stringify({ name: "react-like", main: "index.js" }),
  "node_modules/react-like/index.js": "module.exports = {};\n",
  ...types("scope__typed"),
  "node_modules/@scope/typed/package.json": JSON.stringify({ name: "@scope/typed", main: "index.js" }),
  "node_modules/@scope/typed/index.js": "module.exports = {};\n",
  // Packages the repository patches (patch-package), and a patched package
  // whose compiler-side types are unpatched.
  "patches/patched-pkg+1.0.0.patch": "",
  "node_modules/patched-pkg/package.json": JSON.stringify({ name: "patched-pkg", types: "index.d.ts" }),
  "node_modules/patched-pkg/index.d.ts": "export {};\n",
  "patches/@scope+patched+2.0.0+001+fix.patch": "",
  "node_modules/@scope/patched/package.json": JSON.stringify({ name: "@scope/patched", types: "index.d.ts" }),
  "node_modules/@scope/patched/index.d.ts": "export {};\n",
  "patches/patched-js+3.0.0.patch": "",
  ...types("patched-js"),
  "node_modules/patched-js/package.json": JSON.stringify({ name: "patched-js", main: "index.js" }),
  "node_modules/patched-js/index.js": "module.exports = {};\n",
  "package-lock.json": JSON.stringify(LOCK),
  ...typed("uses-patched"),
  ...typed("uses-uses"),
  ...typed("nests-patched"),
  ...typed("from-file"),
  ...typed("from-git"),
  ...typed("from-url"),
  ...typed("no-integrity"),
  ...typed("no-source"),
  ...typed("from-link"),
  ...typed("unlisted"),
  ...typed("bundler"),
  ...typed("bundler/node_modules/bundled"),
  ...typed("file-bundler"),
  ...typed("file-bundler/node_modules/bundled"),
  // A builtin's name, installed as a package a browser build may take instead.
  "node_modules/string_decoder/package.json": JSON.stringify({ name: "string_decoder", browser: "../../src/lib/url-helpers.ts" }),
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
  // A package linked into the repo, as a `file:` dependency or workspace is.
  symlinkSync("../src/lib", join(root, "node_modules/linked"));
  symlinkSync("../../src/lib", join(root, "node_modules/escape-pkg/lib"));
  symlinkSync("../linked-src/types-linked", join(root, "node_modules/types-linked"));
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

  it.each([["react-like"], ["@scope/typed"]])("%s, whose types are in @types and whose runtime package stays in node_modules", (spec) => {
    expect(resolver.resolve(spec, FROM)).toEqual({ kind: "none" });
  });

  it("a builtin's name with no package of that name installed", () => {
    expect(resolver.resolve("fs", FROM)).toEqual({ kind: "none" });
  });

  it("a file under a package.json with only fields no resolver reads is decided", () => {
    expect(resolver.resolve("@/pkg-inert/a", FROM)).toEqual({ kind: "file", rel: "src/pkg-inert/a.ts" });
  });
});

describe("createModuleResolver: where the compiler and the bundler may load different files, nothing is decided", () => {
  it.each([
    ["a package linked into the repo", "linked/url-helpers", FROM],
    ["a nested package.json whose types and main differ", "@/pkg-split", FROM],
    ["the same package reached by a relative directory", "../pkg-split", FROM],
    ["the same package reached from inside it", "..", "src/pkg-split/sub/a.ts"],
    ["a nested package.json whose exports conditions differ", "pkg-exports", "src/pkg-exports/sub/a.ts"],
    ["an unreadable nested package.json", "@/pkg-junk/a", FROM],
    ["an installed package whose main leaves node_modules", "escape-pkg", FROM],
    ["a package imports specifier whose conditions differ", "#x", "src/pkg-imports/sub/a.ts"],
    ["moduleSuffixes", "./m", "src/suffix/from.ts"],
    ["a paths pattern with fallback targets (the first misses, TypeScript takes the second)", "@alt/lib/other", FROM],
  ])("%s: %s", (_label, spec, from) => {
    expect(resolver.resolve(spec, from).kind).toBe("opaque");
    expect(resolver.mayName(spec, from, [TARGET])).toBe(true);
    expect(resolver.names(spec, from, [TARGET])).toBe(false);
  });

  it("decides a linked package by its real location, not by how it was reached", () => {
    expect(resolver.resolve("linked/url-helpers", FROM)).toEqual({
      kind: "opaque",
      why: "resolves to src/lib/url-helpers.ts through a package linked into the repository",
    });
  });

  it("names the package.json field a runtime may resolve by", () => {
    expect(resolver.resolve("@/pkg-split", FROM).why).toMatch(/src\/pkg-split\/package\.json has "types"/);
  });

  it.each(ENTRY_FIELDS.map(([field]) => [field]))("a package.json holding only name and %s", (field) => {
    const r = resolver.resolve(`@/field-${field}/a`, FROM);
    expect(r.kind).toBe("opaque");
    expect(r.why).toContain(`src/field-${field}/package.json has "${field}"`);
  });
});

describe("createModuleResolver: an installed package is decided by what the runtime loads", () => {
  it.each([
    ["the runtime package is linked from the repo", "types-linked", "node_modules/types-linked is really linked-src/types-linked, outside node_modules"],
    ["the runtime package's main leaves node_modules", "types-escape", 'node_modules/types-escape/package.json names "../../linked-src/escape-runner.js", which leaves node_modules'],
    ["no runtime package is installed", "types-orphan", "no package types-orphan is installed where a runtime looks for it"],
  ])("@types resolves, but %s: %s", (_label, spec, why) => {
    expect(resolver.resolve(spec, FROM)).toEqual({ kind: "opaque", why: `resolves into a package, but ${why}` });
    expect(resolver.mayName(spec, FROM, [TARGET])).toBe(true);
  });

  it.each([
    ["patched-pkg", "patches/patched-pkg+1.0.0.patch"],
    ["@scope/patched", "patches/@scope+patched+2.0.0+001+fix.patch"],
    ["patched-js", "patches/patched-js+3.0.0.patch"],
  ])("a package the repository patches: %s", (spec, file) => {
    const r = resolver.resolve(spec, FROM);
    expect(r.kind).toBe("opaque");
    expect(r.why).toContain(`is patched by ${file}`);
  });

  it.each([
    ["uses-patched", "node_modules/uses-patched depends on patched patched-pkg"],
    ["uses-uses", "node_modules/uses-uses depends on patched patched-pkg"],
    ["nests-patched", "node_modules/nests-patched depends on patched patched-pkg"],
  ])("a package whose installed dependencies reach a patched package: %s", (spec, why) => {
    expect(resolver.resolve(spec, FROM)).toEqual({ kind: "opaque", why: `resolves into a package, but ${why}` });
  });

  it.each([
    ["from-file", "node_modules/from-file is installed from file:vendor/from-file-1.0.0.tgz, not the registry"],
    ["from-git", "node_modules/from-git is installed from git+ssh://git@github.com/o/from-git.git#0123456, not the registry"],
    ["from-url", "node_modules/from-url is installed from https://example.com/archive/from-url.tgz, not the registry"],
    ["no-integrity", "node_modules/no-integrity is installed from https://registry.npmjs.org/no-integrity/-/no-integrity-1.0.0.tgz with no integrity, not the registry"],
    ["no-source", "node_modules/no-source is installed from an unrecorded source with no integrity, not the registry"],
    ["from-link", "node_modules/from-link is installed from a link to vendor/from-link, not the registry"],
    ["unlisted", "node_modules/unlisted is not in package-lock.json"],
  ])("a package the lockfile does not show installed from a registry tarball: %s", (spec, why) => {
    expect(resolver.resolve(spec, FROM)).toEqual({ kind: "opaque", why: `resolves into a package, but ${why}` });
  });

  it("a bundled dependency takes its parent's source", () => {
    expect(resolver.resolve("bundled", "node_modules/bundler/index.js")).toEqual({ kind: "none" });
    expect(resolver.resolve("bundled", "node_modules/file-bundler/index.js")).toEqual({
      kind: "opaque",
      why: "resolves into a package, but node_modules/file-bundler is installed from file:vendor/file-bundler-1.0.0.tgz, not the registry",
    });
  });

  it.each([
    ["an unparseable lockfile", "{ not json\n", /^resolves into a package, but package-lock\.json cannot be read/],
    ["a lockfile with no packages map", JSON.stringify({ lockfileVersion: 1, dependencies: {} }), /package-lock\.json cannot be read \(no lockfileVersion 2\+ packages map\)/],
    ["no lockfile", null, /no package-lock\.json at or above \. within the repository/],
  ])("%s makes every installed package undecided", (_label, lockfile, why) => {
    const bare = mkdtempSync(join(tmpdir(), "module-specifier-lock-"));
    try {
      writeFileSync(join(bare, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "esnext", moduleResolution: "bundler" } }));
      if (lockfile !== null) writeFileSync(join(bare, "package-lock.json"), lockfile);
      mkdirSync(join(bare, "node_modules/plain"), { recursive: true });
      writeFileSync(join(bare, "node_modules/plain/package.json"), JSON.stringify({ name: "plain", types: "index.d.ts" }));
      writeFileSync(join(bare, "node_modules/plain/index.d.ts"), "export {};\n");
      const r = createModuleResolver({ root: bare, isScanned }).resolve("plain", "a.ts");
      expect(r.kind).toBe("opaque");
      expect(r.why).toMatch(why);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("a builtin's name installed as a package whose browser entry leaves node_modules", () => {
    expect(resolver.resolve("string_decoder", FROM)).toEqual({
      kind: "opaque",
      why: 'names a builtin, but node_modules/string_decoder/package.json names "../../src/lib/url-helpers.ts", which leaves node_modules',
    });
    expect(resolver.resolve("node:string_decoder", FROM)).toEqual({ kind: "none" });
  });

  it("a package file reached by path, not by name", () => {
    expect(resolver.resolve("../../node_modules/@scope/pkg/index", FROM)).toEqual({
      kind: "opaque",
      why: "resolves to node_modules/@scope/pkg/index.d.ts by path, not to a package a runtime looks up by name",
    });
  });

  it("a patches directory that cannot be listed makes every package undecided", () => {
    const bare = mkdtempSync(join(tmpdir(), "module-specifier-patches-"));
    try {
      writeFileSync(join(bare, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "esnext", moduleResolution: "bundler" } }));
      writeFileSync(join(bare, "patches"), "not a directory\n");
      mkdirSync(join(bare, "node_modules/plain"), { recursive: true });
      writeFileSync(join(bare, "node_modules/plain/package.json"), JSON.stringify({ name: "plain", types: "index.d.ts" }));
      writeFileSync(join(bare, "node_modules/plain/index.d.ts"), "export {};\n");
      const r = createModuleResolver({ root: bare, isScanned }).resolve("plain", "a.ts");
      expect(r.kind).toBe("opaque");
      expect(r.why).toMatch(/patches\/ cannot be read/);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
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
