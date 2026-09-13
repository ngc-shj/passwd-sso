import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import ts from "typescript";

/**
 * `scripts/tenant-domain.ts` runs on MIGRATION_DATABASE_URL alone. `src/lib/prisma.ts`
 * builds the application pool when it is imported and throws without DATABASE_URL,
 * so a runtime import that reaches it breaks every command on an operator host —
 * and `realign` (round-7 F-R7-2) is the command that most needed the modules which
 * import it.
 *
 * Round 8 (T8-1 / R8-S3): the first version read import text with regexes and
 * resolved paths by hand. A single-quoted specifier and a `.js` specifier both
 * crashed the CLI on boot while the guard stayed green, unresolved specifiers were
 * skipped without a word, and its control cell was one hop deep, so a walker that
 * never recursed passed it. Specifiers now come from the compiler's own AST and
 * resolve through `ts.resolveModuleName` under the repo tsconfig; anything local
 * that does not resolve, and any `import()` of a non-literal, fails the walk.
 */
const REPO = join(__dirname, "..", "..");

type Walk = { chains: string[]; unresolved: string[] };

function compilerOptions(root: string): ts.CompilerOptions {
  const file = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
  if (!file) throw new Error(`no tsconfig.json under ${root}`);
  const { config, error } = ts.readConfigFile(file, ts.sys.readFile);
  if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, "\n"));
  return ts.parseJsonConfigFileContent(config, ts.sys, dirname(file)).options;
}

function isTypeOnlyImport(decl: ts.ImportDeclaration): boolean {
  const clause = decl.importClause;
  if (!clause) return false; // side-effect import
  if (clause.isTypeOnly) return true;
  const bindings = clause.namedBindings;
  // `import { type A, type B } from` is elided entirely; one value binding keeps it.
  return !clause.name && !!bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every((e) => e.isTypeOnly);
}

function isTypeOnlyExport(decl: ts.ExportDeclaration): boolean {
  if (decl.isTypeOnly) return true;
  const clause = decl.exportClause;
  return !!clause && ts.isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every((e) => e.isTypeOnly);
}

/** Every runtime module specifier in `file`, and every dynamic import this cannot read. */
function runtimeSpecifiers(file: string): { specs: string[]; opaque: string[] } {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const specs: string[] = [];
  const opaque: string[] = [];
  const literal = (node: ts.Node | undefined) =>
    node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && !isTypeOnlyImport(node)) {
      const s = literal(node.moduleSpecifier);
      if (s) specs.push(s);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && !isTypeOnlyExport(node)) {
      const s = literal(node.moduleSpecifier);
      if (s) specs.push(s);
    } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
      const s = literal(node.moduleReference.expression);
      if (s) specs.push(s);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isDynamicImport || isRequire) {
        const s = literal(node.arguments[0]);
        if (s) specs.push(s);
        else opaque.push(`${relative(REPO, file)}: ${node.getText(source).slice(0, 80)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { specs, opaque };
}

/** Every runtime import chain from `entry` to `target`, and every local specifier that did not resolve. */
function walkImports(entry: string, target: string, options: ts.CompilerOptions, root: string): Walk {
  const chains: string[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  const walk = (file: string, chain: string[]) => {
    if (seen.has(file)) return;
    seen.add(file);
    const { specs, opaque } = runtimeSpecifiers(file);
    unresolved.push(...opaque);
    for (const spec of specs) {
      const resolved = ts.resolveModuleName(spec, file, options, ts.sys).resolvedModule;
      const isLocal = spec.startsWith(".") || spec.startsWith("@/");
      if (!resolved) {
        if (isLocal) unresolved.push(`${relative(root, file)}: "${spec}"`);
        continue;
      }
      if (resolved.isExternalLibraryImport) continue;
      const next = resolved.resolvedFileName;
      if (next === target) {
        chains.push([...chain, file, next].map((f) => relative(root, f)).join(" -> "));
        continue;
      }
      walk(next, [...chain, file]);
    }
  };
  walk(entry, []);
  return { chains, unresolved };
}

describe("scripts/tenant-domain.ts import graph", () => {
  it("never reaches the application's Prisma singleton at runtime, and resolves every local import", () => {
    const result = walkImports(
      join(REPO, "scripts", "tenant-domain.ts"),
      join(REPO, "src", "lib", "prisma.ts"),
      compilerOptions(REPO),
      REPO,
    );
    expect(result).toEqual({ chains: [], unresolved: [] });
  });
});

describe("the import walker itself (round 8 T8-1)", () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** A throwaway project whose `@/` maps to `src/`, as the repo's does. */
  function project(files: Record<string, string>) {
    root = mkdtempSync(join(tmpdir(), "import-graph-"));
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] }, module: "esnext", moduleResolution: "bundler", allowJs: true } }),
    );
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), body);
    }
    return walkImports(join(root, "entry.ts"), join(root, "src", "lib", "prisma.ts"), compilerOptions(root), root);
  }
  const SINGLETON = { "src/lib/prisma.ts": "export const prisma = {};\n" };

  it("follows imports past the first file (control: three hops)", () => {
    const { chains } = project({
      ...SINGLETON,
      "entry.ts": 'import { a } from "./src/a";\nexport const x = a;\n',
      "src/a.ts": 'import { b } from "@/b";\nexport const a = b;\n',
      "src/b.ts": 'import { prisma } from "@/lib/prisma";\nexport const b = prisma;\n',
    });
    expect(chains).toEqual(["entry.ts -> src/a.ts -> src/b.ts -> src/lib/prisma.ts"]);
  });

  it.each([
    ["a single-quoted specifier", "import { prisma } from '@/lib/prisma';\n"],
    ["a .js specifier", 'import { prisma } from "./src/lib/prisma.js";\n'],
    ["a re-export of everything", 'export * from "./src/lib/prisma";\n'],
    ["an import-equals require", 'import p = require("./src/lib/prisma");\n'],
    ["a require call", 'const p = require("./src/lib/prisma");\n'],
    ["a template-literal dynamic import", "export const load = () => import(`@/lib/prisma`);\n"],
    ["a second import on one line", 'const a = 1; import { prisma } from "@/lib/prisma";\n'],
    ["a multi-line import with an inline type", 'import {\n  type Unused,\n  prisma,\n} from "@/lib/prisma";\n'],
  ])("sees %s", (_label, entry) => {
    expect(project({ ...SINGLETON, "entry.ts": entry }).chains).toHaveLength(1);
  });

  it("does not count a type-only import, which is erased", () => {
    const { chains, unresolved } = project({
      ...SINGLETON,
      "entry.ts": 'import type { prisma } from "@/lib/prisma";\nimport { type prisma as p2 } from "./src/lib/prisma";\n',
    });
    expect({ chains, unresolved }).toEqual({ chains: [], unresolved: [] });
  });

  it("reports a local specifier it cannot resolve instead of skipping it", () => {
    expect(project({ ...SINGLETON, "entry.ts": 'import { gone } from "./src/missing";\n' }).unresolved).toEqual([
      'entry.ts: "./src/missing"',
    ]);
  });

  it("reports a dynamic import of something it cannot read", () => {
    const { unresolved } = project({ ...SINGLETON, "entry.ts": "export const load = (m: string) => import(m);\n" });
    expect(unresolved).toHaveLength(1);
  });
});
