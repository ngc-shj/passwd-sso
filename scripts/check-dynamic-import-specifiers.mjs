#!/usr/bin/env node
/**
 * CI guard: after codemod runs, verify zero stale dynamic-import specifiers remain.
 *
 * Scans vi.mock / vi.doMock / vi.importActual / vi.importOriginal / await import /
 * dynamic import() calls that use @/ alias, resolves each against the filesystem,
 * and fails if any target does not exist.
 *
 * Usage:
 *   node scripts/check-dynamic-import-specifiers.mjs [--old-prefix src/lib]
 *
 * --old-prefix <prefix>  When provided, only flag specifiers whose resolved path
 *                        starts with <prefix>. Default: check all @/ specifiers.
 *
 * Exit 0 = OK, Exit 1 = stale specifier(s) found.
 */

import { existsSync, readdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Project, SyntaxKind } = require("ts-morph");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = argv.slice(2);
  let oldPrefix = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--old-prefix" && args[i + 1]) {
      oldPrefix = args[++i];
    }
  }
  return { oldPrefix };
}

const { oldPrefix } = parseArgs(process.argv);

// ---------------------------------------------------------------------------
// Collect source files to scan
// ---------------------------------------------------------------------------
function collectSourceFiles() {
  const files = [];
  const scanDirs = [
    { dir: "src", exts: [".ts", ".tsx"] },
    { dir: "scripts", exts: [".ts", ".tsx", ".mjs"] },
    { dir: "e2e", exts: [".ts"] },
  ];

  function walk(dir, exts) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), exts);
      } else if (entry.isFile() && exts.some((e) => entry.name.endsWith(e))) {
        files.push(join(dir, entry.name));
      }
    }
  }

  for (const { dir, exts } of scanDirs) {
    const absDir = resolve(ROOT, dir);
    if (existsSync(absDir)) walk(absDir, exts);
  }

  return files;
}

// ---------------------------------------------------------------------------
// Resolve @/ alias to filesystem path
// ---------------------------------------------------------------------------
const EXTENSIONS = ["", ".ts", ".tsx", ".js", ".mjs", ".json"];

function resolveAlias(specifier) {
  if (!specifier.startsWith("@/")) return null;
  const rel = specifier.slice(2);
  const base = resolve(ROOT, "src", rel);
  for (const ext of EXTENSIONS) {
    if (existsSync(base + ext)) return base + ext;
  }
  for (const ext of EXTENSIONS) {
    if (existsSync(join(base, `index${ext}`))) return join(base, `index${ext}`);
  }
  return null;
}

function isAliasSpecifier(specifier) {
  return specifier.startsWith("@/");
}

function matchesOldPrefix(specifier) {
  if (!oldPrefix) return true;
  // @/lib/foo matches --old-prefix src/lib if @/lib starts at the right depth
  const rel = specifier.slice(2); // strip @/
  return rel.startsWith(oldPrefix.replace(/^src\//, ""));
}

// ---------------------------------------------------------------------------
// Collect vi.* and dynamic import specifiers using ts-morph
// Skips .mjs files (ts-morph cannot parse them directly as TS)
// ---------------------------------------------------------------------------
const project = new Project({
  tsConfigFilePath: resolve(ROOT, "tsconfig.json"),
  skipAddingFilesFromTsConfig: true,
  addFilesFromTsConfig: false,
});

const tsFiles = collectSourceFiles().filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
for (const f of tsFiles) {
  project.addSourceFileAtPathIfExists(f);
}

// Name patterns we care about for vi.* calls
const VI_CALL_NAMES = new Set(["mock", "doMock", "importActual", "importOriginal"]);

const errors = [];
let viMockCount = 0;
let awaitImportCount = 0;
let typeofImportCount = 0;
let viImportActualCount = 0;
let viImportOriginalCount = 0;

for (const sf of project.getSourceFiles()) {
  // Check all call expressions
  const calls = sf.getDescendantsOfKind(SyntaxKind.CallExpression);
  for (const call of calls) {
    const expr = call.getExpression();
    let specifier = null;
    let callType = null;

    // vi.mock("@/..."), vi.doMock, vi.importActual, vi.importOriginal
    if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
      const propAccess = expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
      const obj = propAccess.getExpression().getText();
      const prop = propAccess.getName();
      if ((obj === "vi" || obj === "jest") && VI_CALL_NAMES.has(prop)) {
        const firstArg = call.getArguments()[0];
        if (firstArg && firstArg.getKind() === SyntaxKind.StringLiteral) {
          specifier = firstArg.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();
          callType = prop === "importActual" ? "viImportActual" : prop === "importOriginal" ? "viImportOriginal" : "viMock";
        }
      }
    }

    // import("@/...") or await import("@/...")
    if (call.getKind() === SyntaxKind.CallExpression) {
      const exprText = expr.getText();
      if (exprText === "import") {
        const firstArg = call.getArguments()[0];
        if (firstArg && firstArg.getKind() === SyntaxKind.StringLiteral) {
          specifier = firstArg.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();
          callType = "awaitImport";
        }
      }
    }

    if (!specifier || !isAliasSpecifier(specifier)) continue;
    if (!matchesOldPrefix(specifier)) continue;

    const resolved = resolveAlias(specifier);
    const filePath = sf.getFilePath();
    const rel = filePath.startsWith(ROOT) ? filePath.slice(ROOT.length + 1) : filePath;
    const line = sf.getLineAndColumnAtPos(call.getStart()).line;

    if (callType === "viMock") viMockCount++;
    else if (callType === "awaitImport") awaitImportCount++;
    else if (callType === "viImportActual") viImportActualCount++;
    else if (callType === "viImportOriginal") viImportOriginalCount++;

    if (!resolved) {
      errors.push({ rel, line, specifier });
    }
  }

  // ImportType nodes: typeof import("@/...")
  const importTypes = sf.getDescendantsOfKind(SyntaxKind.ImportType);
  for (const node of importTypes) {
    const argNode = node.getArgument();
    if (argNode.getKind() !== SyntaxKind.LiteralType) continue;
    const lit = argNode.asKindOrThrow(SyntaxKind.LiteralType).getLiteral();
    if (lit.getKind() !== SyntaxKind.StringLiteral) continue;
    const specifier = lit.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();

    if (!isAliasSpecifier(specifier)) continue;
    if (!matchesOldPrefix(specifier)) continue;
    typeofImportCount++;

    const resolved = resolveAlias(specifier);
    if (!resolved) {
      const filePath = sf.getFilePath();
      const rel = filePath.startsWith(ROOT) ? filePath.slice(ROOT.length + 1) : filePath;
      const line = sf.getLineAndColumnAtPos(node.getStart()).line;
      errors.push({ rel, line, specifier });
    }
  }
}

if (errors.length > 0) {
  for (const { rel, line, specifier } of errors) {
    console.error(`${rel}:${line}: stale/unresolvable specifier -> ${specifier}`);
  }
  process.exit(1);
}

console.log(
  `check-dynamic-import-specifiers OK: ${viMockCount} vi.mock + ${awaitImportCount} await-import + ${typeofImportCount} typeof-import + ${viImportActualCount} vi.importActual + ${viImportOriginalCount} vi.importOriginal specifiers resolved.`
);
