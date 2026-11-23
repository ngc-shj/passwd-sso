/**
 * Unit tests for scripts/checks/lib/module-specifier.mjs — the "may this
 * import()/require() argument load module X" analysis shared by
 * check-crypto-domains (Check E) and check-mutation-response-read.
 */
import { describe, it, expect } from "vitest";
import { Project, SyntaxKind } from "ts-morph";
import { bindingIndex } from "../checks/lib/scope-bindings.mjs";
import { loadArgumentMayName, moduleLoaderOf, specifierMayName } from "../checks/lib/module-specifier.mjs";

const TARGET = "src/lib/url-helpers";
const FROM = "src/components/a.ts";

const project = new Project({ useInMemoryFileSystem: true });

function loadCall(code) {
  const sf = project.createSourceFile(`/case-${Math.random().toString(36).slice(2)}.ts`, code);
  const call = sf.getDescendantsOfKind(SyntaxKind.CallExpression).find((c) => moduleLoaderOf(c));
  return { sf, call };
}

function mayLoad(code, targets = [TARGET]) {
  const { sf, call } = loadCall(code);
  return loadArgumentMayName(call.getArguments()[0], FROM, targets, () => bindingIndex(sf));
}

describe("specifierMayName", () => {
  it("names the target by @/ path, relative path, extension or /index", () => {
    expect(specifierMayName("@/lib/url-helpers", FROM, TARGET)).toBe(true);
    expect(specifierMayName("../lib/url-helpers.ts", FROM, TARGET)).toBe(true);
    expect(specifierMayName("@/lib/constants/index", FROM, "src/lib/constants")).toBe(true);
    expect(specifierMayName("@/lib/url-helpers-extra", FROM, TARGET)).toBe(false);
  });

  it("treats an empty template head as possibly naming any module", () => {
    expect(specifierMayName("", FROM, TARGET, true)).toBe(true);
  });

  it("rules out the target for a bare package template head", () => {
    expect(specifierMayName("lodash/", FROM, TARGET, true)).toBe(false);
  });

  it("treats a template head that stops inside the @/ alias as possibly naming any module", () => {
    // `@${"/lib/url-helpers"}` is the alias, not a scoped package.
    expect(specifierMayName("@", FROM, TARGET, true)).toBe(true);
    expect(specifierMayName("@scope/", FROM, TARGET, true)).toBe(false);
  });
});

describe("moduleLoaderOf", () => {
  it("recognises import() and require(), and nothing else", () => {
    const sf = project.createSourceFile("/loaders.ts", 'import("a");\nrequire("b");\nload("c");\n');
    expect(sf.getDescendantsOfKind(SyntaxKind.CallExpression).map(moduleLoaderOf)).toEqual(["import()", "require()", null]);
  });
});

describe("loadArgumentMayName", () => {
  it("rules the target out by a template head outside it", () => {
    expect(mayLoad("export const m = (p: string) => import(`../../messages/${p}.json`);\n")).toBe(false);
  });

  it("rules the target in by a template head above it", () => {
    expect(mayLoad("export const m = (p: string) => import(`@/lib/${p}`);\n")).toBe(true);
  });

  it("follows an identifier to the const string it is bound to", () => {
    expect(mayLoad('const name = "hash-wasm";\nexport const m = () => import(name);\n')).toBe(false);
    expect(mayLoad('const name = "@/lib/url-helpers" as const;\nexport const m = () => import(name);\n')).toBe(true);
  });

  it("refuses an identifier bound by let", () => {
    expect(mayLoad('let name = "hash-wasm";\nexport const m = () => import(name);\n')).toBe(true);
  });

  it("refuses an identifier destructured from a const string", () => {
    // `s` is "." here, which from src/lib/constants loads src/lib/constants/index.
    const code = 'const [s] = "./x";\nexport const m = () => import(s);\n';
    const { sf, call } = loadCall(code);
    expect(loadArgumentMayName(call.getArguments()[0], "src/lib/constants/a.ts", ["src/lib/constants"], () => bindingIndex(sf))).toBe(true);
  });

  it("refuses a load with no argument", () => {
    expect(mayLoad("export const m = () => require();\n")).toBe(true);
  });

  it("answers may when any one of several targets is named", () => {
    expect(mayLoad('export const m = () => import("@/lib/constants");\n', ["src/lib/constants/vault/vault", "src/lib/constants"])).toBe(true);
  });
});
