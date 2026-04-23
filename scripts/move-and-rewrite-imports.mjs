#!/usr/bin/env node
/**
 * ts-morph AST codemod: moves files via git mv and rewrites all import/export
 * specifiers that reference the moved files.
 *
 * Usage:
 *   node scripts/move-and-rewrite-imports.mjs --config path/to/phase-config.json [--dry-run]
 */

import { execFileSync, execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, relative, dirname, basename } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Project, SyntaxKind } = require("ts-morph");

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

class CodemodConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "CodemodConfigError";
  }
}

class CodemodRewriteError extends Error {
  constructor(message) {
    super(message);
    this.name = "CodemodRewriteError";
  }
}

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  let configPath = null;
  let dryRun = false;
  let checkTestPairs = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" && args[i + 1]) {
      configPath = args[++i];
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    } else if (args[i] === "--check-test-pairs") {
      checkTestPairs = true;
    }
  }
  if (!configPath) {
    throw new CodemodConfigError("--config <path> is required");
  }
  return { configPath, dryRun, checkTestPairs };
}

// ---------------------------------------------------------------------------
// --check-test-pairs (Round 4 T14/T20 fix)
//
// Symmetric pair validation. Exact-extension match only — cross-extension
// pairs (foo.ts + foo.test.tsx) are NOT treated as automatic pairs. If
// intentional, list both in moves[] explicitly.
// ---------------------------------------------------------------------------
import { existsSync } from "node:fs";

export function checkTestPairsForMoves(moves, repoRoot) {
  const violations = [];
  const movesSet = new Set(moves.map((m) => m.from));

  for (const m of moves) {
    const from = m.from;
    // Case 1: test file in moves — impl sibling must also be in moves (if it exists).
    const testMatch = from.match(/^(.+)\.test\.(ts|tsx)$/);
    if (testMatch) {
      const implSibling = `${testMatch[1]}.${testMatch[2]}`;
      if (existsSync(resolve(repoRoot, implSibling)) && !movesSet.has(implSibling)) {
        violations.push(
          `${from} (test) in moves[] but impl sibling ${implSibling} exists on disk and is NOT in moves[]`
        );
      }
      continue;
    }
    // Case 2: impl file in moves — test sibling must also be in moves (if it exists).
    const implMatch = from.match(/^(.+)\.(ts|tsx)$/);
    if (implMatch) {
      const testSibling = `${implMatch[1]}.test.${implMatch[2]}`;
      if (existsSync(resolve(repoRoot, testSibling)) && !movesSet.has(testSibling)) {
        violations.push(
          `${from} (impl) in moves[] but test sibling ${testSibling} exists on disk and is NOT in moves[]`
        );
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

const SAFE_PATH_RE = /^[A-Za-z0-9_\-./]+$/;

function validateMovePath(p, repoRoot) {
  if (!SAFE_PATH_RE.test(p)) {
    throw new CodemodConfigError(
      `Move path contains unsafe characters: "${p}". Only [A-Za-z0-9_\\-./] are allowed.`
    );
  }
  if (p.startsWith("/")) {
    throw new CodemodConfigError(
      `Move path must be repo-relative, not absolute: "${p}".`
    );
  }
  if (/(^|\/)\.\.($|\/)/.test(p) || p === "..") {
    throw new CodemodConfigError(
      `Move path contains ".." segment: "${p}".`
    );
  }
  const abs = resolve(repoRoot, p);
  if (!abs.startsWith(resolve(repoRoot) + "/") && abs !== resolve(repoRoot)) {
    throw new CodemodConfigError(
      `Move path escapes repository root: "${p}" resolves to "${abs}".`
    );
  }
}

function loadConfig(configPath) {
  const abs = resolve(configPath);
  // Read the file directly; handle missing-file (ENOENT) explicitly instead
  // of probing with existsSync first (CodeQL: js/file-system-race).
  let raw;
  try {
    raw = readFileSync(abs, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new CodemodConfigError(`Config file not found: ${abs}`);
    }
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CodemodConfigError(`Invalid JSON in config: ${err.message}`);
  }
  if (!parsed.phaseName || typeof parsed.phaseName !== "string") {
    throw new CodemodConfigError('Config must have a string "phaseName"');
  }
  if (!Array.isArray(parsed.moves)) {
    throw new CodemodConfigError('Config must have a "moves" array');
  }
  // Validate paths at config-load time using process.cwd() as repo root
  const repoRoot = process.cwd();
  for (const move of parsed.moves) {
    if (typeof move.from !== "string" || typeof move.to !== "string") {
      throw new CodemodConfigError('Each move must have "from" and "to" string fields');
    }
    validateMovePath(move.from, repoRoot);
    validateMovePath(move.to, repoRoot);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Git safety check
// ---------------------------------------------------------------------------

function checkGitStatus(repoRoot) {
  const output = execSync("git status --porcelain", {
    cwd: repoRoot,
    encoding: "utf-8",
  });
  // Only fail on tracked modified/staged changes (lines not starting with "??")
  const dirty = output
    .split("\n")
    .filter((line) => line.length >= 2 && line[0] !== "?" && line[1] !== "?")
    .filter((line) => line.trim().length > 0);
  if (dirty.length > 0) {
    throw new CodemodConfigError(
      `Working tree has uncommitted changes. Stash or commit before running the codemod.\n${dirty.join("\n")}`
    );
  }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Convert an absolute path to a repo-relative path (forward slashes). */
function toRepoRelative(absPath, repoRoot) {
  return relative(repoRoot, absPath).replace(/\\/g, "/");
}

/**
 * Build a mapping from old alias specifier → new alias specifier.
 * Only covers @/... alias moves.
 */
function buildAliasMap(moves, repoRoot) {
  const map = new Map();
  for (const move of moves) {
    const fromAbs = resolve(repoRoot, move.from);
    const toAbs = resolve(repoRoot, move.to);
    // Strip src/ prefix to form @/ alias
    const fromRel = toRepoRelative(fromAbs, repoRoot);
    const toRel = toRepoRelative(toAbs, repoRoot);
    if (fromRel.startsWith("src/")) {
      const fromAlias = "@/" + fromRel.slice("src/".length).replace(/\.(ts|tsx)$/, "");
      const toAlias = "@/" + toRel.slice("src/".length).replace(/\.(ts|tsx)$/, "");
      map.set(fromAlias, toAlias);
      // Also map with extension (some imports include it)
      const ext = fromRel.match(/\.(ts|tsx)$/)?.[0] ?? "";
      if (ext) {
        map.set(fromAlias + ext, toAlias + ext);
      }
    }
  }
  return map;
}

/**
 * Build a mapping from old absolute path → new absolute path.
 */
function buildAbsoluteMap(moves, repoRoot) {
  const map = new Map();
  for (const move of moves) {
    const fromAbs = resolve(repoRoot, move.from);
    const toAbs = resolve(repoRoot, move.to);
    map.set(fromAbs, toAbs);
  }
  return map;
}

/** Rewrite an alias specifier via the alias map (returns null if no change). */
function rewriteAlias(specifier, aliasMap) {
  // Try exact match first
  if (aliasMap.has(specifier)) return aliasMap.get(specifier);
  // Try stripping extension
  const noExt = specifier.replace(/\.(ts|tsx)$/, "");
  if (noExt !== specifier && aliasMap.has(noExt)) return aliasMap.get(noExt);
  return null;
}

/**
 * Rewrite a relative specifier in the context of a file that may have moved.
 * fileAbsPath: the current absolute path of the file containing the import.
 * absMap: Map<oldAbsPath, newAbsPath> for moved files.
 * Returns the new specifier, or null if no change needed.
 */
function rewriteRelative(specifier, fileAbsPath, absMap, _repoRoot) {
  if (!specifier.startsWith(".")) return null;
  const fileDir = dirname(fileAbsPath);
  const resolved = resolve(fileDir, specifier);
  // Check if the imported file is being moved
  const extCandidates = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];
  for (const ext of extCandidates) {
    const candidate = resolved + ext;
    if (absMap.has(candidate)) {
      const newTarget = absMap.get(candidate);
      const newDir = dirname(fileAbsPath);
      let rel = relative(newDir, newTarget.replace(/\.(ts|tsx)$/, "")).replace(/\\/g, "/");
      if (!rel.startsWith(".")) rel = "./" + rel;
      return rel;
    }
  }
  // File not moving — compute new relative path from new file location
  // (only relevant if fileAbsPath itself is a moved file's new location)
  return null;
}

/**
 * Given a moved file's new absolute path and its original location, rewrite
 * a relative specifier that pointed to a non-moved file.
 */
function rewriteRelativeFromMoved(specifier, oldFileAbsPath, newFileAbsPath, absMap, _repoRoot) {
  if (!specifier.startsWith(".")) return null;
  const oldDir = dirname(oldFileAbsPath);
  const resolved = resolve(oldDir, specifier);
  // If the target is also being moved, it's handled by rewriteRelative
  for (const ext of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    if (absMap.has(resolved + ext)) return null;
  }
  // Target is not moving — recompute relative path from new file location
  const newDir = dirname(newFileAbsPath);
  // Strip extension from resolved for cleaner import
  let cleanResolved = resolved;
  // Try to keep original extension style
  let rel = relative(newDir, cleanResolved).replace(/\\/g, "/");
  if (!rel.startsWith(".")) rel = "./" + rel;
  if (rel === specifier) return null;
  return rel;
}

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

const counts = {
  moves: 0,
  alias: 0,
  relative: 0,
  viMock: 0,
  dynamicImport: 0,
  typeofImport: 0,
  reExport: 0,
  allowlist: 0,
};

// ---------------------------------------------------------------------------
// git mv
// ---------------------------------------------------------------------------

function executeMoves(moves, repoRoot, dryRun) {
  for (const move of moves) {
    const from = move.from;
    const to = move.to;
    console.log(`[move] ${from} -> ${to}`);
    if (!dryRun) {
      // Ensure target directory exists (no shell interpolation)
      const toAbs = resolve(repoRoot, to);
      const toDir = dirname(toAbs);
      mkdirSync(toDir, { recursive: true });
      execFileSync("git", ["mv", from, to], { cwd: repoRoot, encoding: "utf-8" });
    }
    counts.moves++;
  }
}

// ---------------------------------------------------------------------------
// Template-literal import detection (FAIL case)
// ---------------------------------------------------------------------------

const TEMPLATE_PREFIXES = ["@/lib/", "@/hooks/", "@/components/passwords/"];

function checkTemplateLiteralImports(project, repoRoot) {
  const failList = [];
  for (const sourceFile of project.getSourceFiles()) {
    const calls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
    for (const call of calls) {
      const expr = call.getExpression();
      // Dynamic import: import(templateLiteral)
      if (expr.getKind() === SyntaxKind.ImportKeyword) {
        const args = call.getArguments();
        if (args.length > 0 && args[0].getKind() === SyntaxKind.TemplateExpression) {
          const tmpl = args[0];
          const head = tmpl.getHead?.()?.getLiteralText?.() ?? "";
          if (TEMPLATE_PREFIXES.some((p) => head.startsWith(p))) {
            const filePath = toRepoRelative(sourceFile.getFilePath(), repoRoot);
            const lineNum = sourceFile.getLineAndColumnAtPos(tmpl.getStart()).line;
            failList.push({ file: filePath, line: lineNum, text: tmpl.getText() });
          }
        }
      }
    }
  }
  return failList;
}

// ---------------------------------------------------------------------------
// AST rewrite helpers
// ---------------------------------------------------------------------------

function rewriteStringLiteralNode(node, newValue, tag, filePath, dryRun, repoRoot) {
  const oldValue = node.getLiteralText?.() ?? node.getText().slice(1, -1);
  if (oldValue === newValue) return false;
  console.log(`[${tag}] ${toRepoRelative(filePath, repoRoot)}: "${oldValue}" -> "${newValue}"`);
  if (!dryRun) {
    node.setLiteralValue(newValue);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Rewrite alias imports/exports in a source file
// ---------------------------------------------------------------------------

function rewriteAliasInFile(sourceFile, aliasMap, repoRoot, dryRun) {
  const filePath = sourceFile.getFilePath();
  let changed = false;

  // Import declarations
  for (const decl of sourceFile.getImportDeclarations()) {
    const spec = decl.getModuleSpecifierValue();
    const newSpec = rewriteAlias(spec, aliasMap);
    if (newSpec) {
      console.log(`[alias] ${toRepoRelative(filePath, repoRoot)}: ${spec} -> ${newSpec}`);
      if (!dryRun) decl.setModuleSpecifier(newSpec);
      counts.alias++;
      changed = true;
    }
  }

  // Export declarations
  for (const decl of sourceFile.getExportDeclarations()) {
    const specNode = decl.getModuleSpecifier();
    if (!specNode) continue;
    const spec = decl.getModuleSpecifierValue();
    const newSpec = rewriteAlias(spec, aliasMap);
    if (newSpec) {
      console.log(`[re-export] ${toRepoRelative(filePath, repoRoot)}: ${spec} -> ${newSpec}`);
      if (!dryRun) decl.setModuleSpecifier(newSpec);
      counts.reExport++;
      changed = true;
    }
  }

  // vi.mock / vi.doMock call expressions
  const calls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
  for (const call of calls) {
    const expr = call.getExpression();
    const exprText = expr.getText();

    if (exprText === "vi.mock" || exprText === "vi.doMock") {
      const args = call.getArguments();
      if (args.length > 0 && args[0].getKind() === SyntaxKind.StringLiteral) {
        const arg = args[0];
        const spec = arg.getLiteralText();
        const newSpec = rewriteAlias(spec, aliasMap);
        if (newSpec) {
          if (rewriteStringLiteralNode(arg, newSpec, "vi.mock", filePath, dryRun, repoRoot)) {
            counts.viMock++;
            changed = true;
          }
        }
      }
    }

    if (exprText === "vi.importActual") {
      const args = call.getArguments();
      if (args.length > 0 && args[0].getKind() === SyntaxKind.StringLiteral) {
        const arg = args[0];
        const spec = arg.getLiteralText();
        const newSpec = rewriteAlias(spec, aliasMap);
        if (newSpec) {
          if (rewriteStringLiteralNode(arg, newSpec, "vi.importActual", filePath, dryRun, repoRoot)) {
            counts.dynamicImport++;
            changed = true;
          }
        }
      }
    }

    if (exprText === "vi.importOriginal") {
      // Handles typeof import(...) in type arguments
      const typeArgs = call.getTypeArguments?.() ?? [];
      for (const typeArg of typeArgs) {
        if (typeArg.getKind() === SyntaxKind.ImportType) {
          const litNode = typeArg.getArgument?.();
          if (litNode && litNode.getKind() === SyntaxKind.LiteralType) {
            const strNode = litNode.getLiteral?.();
            if (strNode && strNode.getKind() === SyntaxKind.StringLiteral) {
              const spec = strNode.getLiteralText();
              const newSpec = rewriteAlias(spec, aliasMap);
              if (newSpec) {
                if (rewriteStringLiteralNode(strNode, newSpec, "vi.importOriginal-typeof", filePath, dryRun, repoRoot)) {
                  counts.typeofImport++;
                  changed = true;
                }
              }
            }
          }
        }
      }
    }

    // Static-string dynamic imports: import("@/lib/...")
    if (expr.getKind() === SyntaxKind.ImportKeyword) {
      const args = call.getArguments();
      if (args.length > 0 && args[0].getKind() === SyntaxKind.StringLiteral) {
        const arg = args[0];
        const spec = arg.getLiteralText();
        const newSpec = rewriteAlias(spec, aliasMap);
        if (newSpec) {
          if (rewriteStringLiteralNode(arg, newSpec, "await-import", filePath, dryRun, repoRoot)) {
            counts.dynamicImport++;
            changed = true;
          }
        }
      }
    }
  }

  // typeof import("...") in type positions (ImportTypeNode)
  const importTypes = sourceFile.getDescendantsOfKind(SyntaxKind.ImportType);
  for (const importType of importTypes) {
    const argNode = importType.getArgument?.();
    if (!argNode) continue;
    // The argument to ImportType is a LiteralType
    if (argNode.getKind() === SyntaxKind.LiteralType) {
      const strNode = argNode.getLiteral?.();
      if (strNode && strNode.getKind() === SyntaxKind.StringLiteral) {
        const spec = strNode.getLiteralText();
        const newSpec = rewriteAlias(spec, aliasMap);
        if (newSpec) {
          if (rewriteStringLiteralNode(strNode, newSpec, "typeof-import", filePath, dryRun, repoRoot)) {
            counts.typeofImport++;
            changed = true;
          }
        }
      }
    }
  }

  return changed;
}

// ---------------------------------------------------------------------------
// Rewrite relative imports inside moved files
// ---------------------------------------------------------------------------

function rewriteRelativeInMovedFile(sourceFile, oldAbsPath, newAbsPath, absMap, repoRoot, dryRun) {
  const filePath = sourceFile.getFilePath(); // this is the new path after git mv
  let changed = false;

  const processSpec = (spec, setFn, _tag) => {
    if (!spec.startsWith(".")) return false;
    // First check: target is also moving
    const rel1 = rewriteRelative(spec, oldAbsPath, absMap, repoRoot);
    if (rel1 !== null) {
      // Compute from new file location to new target location
      const oldFileDir = dirname(oldAbsPath);
      const resolvedOld = resolve(oldFileDir, spec);
      let targetNew = null;
      for (const ext of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
        if (absMap.has(resolvedOld + ext)) {
          targetNew = absMap.get(resolvedOld + ext);
          break;
        }
      }
      if (targetNew) {
        const newFileDir = dirname(newAbsPath);
        let newRel = relative(newFileDir, targetNew.replace(/\.(ts|tsx)$/, "")).replace(/\\/g, "/");
        if (!newRel.startsWith(".")) newRel = "./" + newRel;
        if (newRel !== spec) {
          console.log(`[relative] ${toRepoRelative(filePath, repoRoot)}: ${spec} -> ${newRel}`);
          if (!dryRun) setFn(newRel);
          counts.relative++;
          return true;
        }
      }
    }
    // Second check: target is not moving, recompute from new location
    const rel2 = rewriteRelativeFromMoved(spec, oldAbsPath, newAbsPath, absMap, repoRoot);
    if (rel2 !== null) {
      console.log(`[relative] ${toRepoRelative(filePath, repoRoot)}: ${spec} -> ${rel2}`);
      if (!dryRun) setFn(rel2);
      counts.relative++;
      return true;
    }
    return false;
  };

  for (const decl of sourceFile.getImportDeclarations()) {
    const spec = decl.getModuleSpecifierValue();
    if (processSpec(spec, (v) => decl.setModuleSpecifier(v), "relative")) {
      changed = true;
    }
  }

  for (const decl of sourceFile.getExportDeclarations()) {
    if (!decl.getModuleSpecifier()) continue;
    const spec = decl.getModuleSpecifierValue();
    if (processSpec(spec, (v) => decl.setModuleSpecifier(v), "relative")) {
      changed = true;
    }
  }

  return changed;
}

// ---------------------------------------------------------------------------
// YAML / string-based rewrites
// ---------------------------------------------------------------------------

function rewriteYamlFile(filePath, aliasMap, repoRoot, dryRun) {
  // Read the file directly and bail on ENOENT. Avoids the TOCTOU race
  // between existsSync() and readFileSync() (CodeQL: js/file-system-race).
  let content;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }
  let changed = false;

  // Build src/lib/... → src/lib/.../... mapping (plain paths for YAML grep strings)
  for (const [fromAlias, toAlias] of aliasMap) {
    // fromAlias looks like @/lib/foo, toAlias like @/lib/auth/foo
    const fromPath = "src/" + fromAlias.slice(2) + ".ts"; // src/lib/foo.ts
    const toPath = "src/" + toAlias.slice(2) + ".ts";
    if (content.includes(fromPath)) {
      console.log(`[YAML-string] ${toRepoRelative(filePath, repoRoot)}: ${fromPath} -> ${toPath}`);
      content = content.replaceAll(fromPath, toPath);
      changed = true;
      counts.allowlist++;
    }
    // Also without .ts extension
    const fromPathNoExt = "src/" + fromAlias.slice(2);
    const toPathNoExt = "src/" + toAlias.slice(2);
    if (fromPathNoExt !== fromPath && content.includes(fromPathNoExt)) {
      console.log(`[YAML-string] ${toRepoRelative(filePath, repoRoot)}: ${fromPathNoExt} -> ${toPathNoExt}`);
      content = content.replaceAll(fromPathNoExt, toPathNoExt);
      changed = true;
      counts.allowlist++;
    }
  }

  if (changed && !dryRun) {
    writeFileSync(filePath, content, "utf-8");
  }
}

// ---------------------------------------------------------------------------
// Allowlist string rewrites (check-bypass-rls.mjs, check-crypto-domains.mjs, vitest.config.ts)
// ---------------------------------------------------------------------------

/**
 * Delimiter-anchored regex: match `needle` only when followed by a non-path
 * character (quote, whitespace, closing bracket/brace/paren, comma) or
 * end-of-line. This prevents substring matches like src/lib/audit matching
 * into src/lib/audit-outbox.ts.
 */
function buildAnchoredReplaceRegex(needle) {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped + `(?=[\"'\`\\s)},\\]]|$)`, "g");
}

function rewriteAllowlistFile(filePath, aliasMap, _repoRoot, dryRun, _tag) {
  // Read the file directly and bail on ENOENT. Avoids the TOCTOU race
  // between existsSync() and readFileSync() (CodeQL: js/file-system-race).
  let content;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }
  let changed = false;

  for (const [fromAlias, toAlias] of aliasMap) {
    const fromPath = "src/" + fromAlias.slice(2);
    const toPath = "src/" + toAlias.slice(2);
    // Only use extension-explicit variants to avoid substring corruption.
    // E.g. "src/lib/audit.ts" must NOT match "src/lib/audit-outbox.ts".
    const variants = [
      [fromPath + ".ts", toPath + ".ts"],
      [fromPath + ".tsx", toPath + ".tsx"],
    ];
    for (const [from, to] of variants) {
      const re = buildAnchoredReplaceRegex(from);
      if (re.test(content)) {
        console.log(`[allowlist ${basename(filePath)}] ${from} -> ${to}`);
        // Reset lastIndex after test()
        re.lastIndex = 0;
        content = content.replace(re, to);
        changed = true;
        counts.allowlist++;
      }
    }
  }

  if (changed && !dryRun) {
    writeFileSync(filePath, content, "utf-8");
  }
}

// ---------------------------------------------------------------------------
// Rewrite relative imports FROM non-src files TO moved src files
// ---------------------------------------------------------------------------

function rewriteExternalRelativeImports(project, absMap, repoRoot, dryRun) {
  // Build set of old absolute paths for files that are being moved.
  // These files are handled by rewriteRelativeInMovedFile, not here.
  const movingFiles = new Set(absMap.keys());

  // Helper: given a relative specifier in `fileDir`, compute the rewritten
  // relative specifier if the target is in absMap. Preserves any explicit
  // `.ts`/`.tsx` extension the caller carried (required for .mjs files that
  // import TypeScript sources with explicit extensions, e.g.
  // `../../src/lib/foo.ts` in scripts/__tests__/*.test.mjs).
  function computeRewrite(spec, fileDir) {
    if (!spec.startsWith(".")) return null;
    const resolved = resolve(fileDir, spec);
    const originalExtMatch = spec.match(/\.(ts|tsx)$/);
    const preserveExt = originalExtMatch ? originalExtMatch[0] : "";
    for (const ext of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
      const candidate = resolved + ext;
      if (absMap.has(candidate)) {
        const newTarget = absMap.get(candidate);
        // Strip .ts/.tsx from the canonical path, then optionally re-add
        // if the original specifier had an explicit extension.
        const canonical = newTarget.replace(/\.(ts|tsx)$/, "");
        let newRel = relative(fileDir, canonical).replace(/\\/g, "/");
        if (!newRel.startsWith(".")) newRel = "./" + newRel;
        if (preserveExt) newRel += preserveExt;
        return newRel;
      }
    }
    return null;
  }

  for (const sourceFile of project.getSourceFiles()) {
    const filePath = sourceFile.getFilePath();
    // Skip files that are themselves being moved (they have dedicated handling)
    if (movingFiles.has(filePath)) continue;
    const fileDir = dirname(filePath);

    // Static ImportDeclaration
    for (const decl of sourceFile.getImportDeclarations()) {
      const spec = decl.getModuleSpecifierValue();
      const newRel = computeRewrite(spec, fileDir);
      if (newRel && newRel !== spec) {
        console.log(`[relative] ${toRepoRelative(filePath, repoRoot)}: ${spec} -> ${newRel}`);
        if (!dryRun) decl.setModuleSpecifier(newRel);
        counts.relative++;
      }
    }

    // Static ExportDeclaration with `from "..."` (re-exports)
    for (const decl of sourceFile.getExportDeclarations()) {
      const spec = decl.getModuleSpecifierValue?.();
      if (!spec) continue;
      const newRel = computeRewrite(spec, fileDir);
      if (newRel && newRel !== spec) {
        console.log(`[re-export-relative] ${toRepoRelative(filePath, repoRoot)}: ${spec} -> ${newRel}`);
        if (!dryRun) decl.setModuleSpecifier(newRel);
        counts.relative++;
      }
    }

    // Dynamic CallExpression: import("..."), require("..."),
    // vi.mock("..."), vi.doMock("..."), vi.importActual("..."),
    // vi.importOriginal("..."). We only rewrite string-literal args whose
    // value is relative; alias specifiers are handled by rewriteAliasInFile.
    const DYNAMIC_CALLEES = new Set([
      "require",
      "vi.mock",
      "vi.doMock",
      "vi.importActual",
      "vi.importOriginal",
    ]);
    const calls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
    for (const call of calls) {
      const expr = call.getExpression();
      const args = call.getArguments();
      if (args.length === 0 || args[0].getKind() !== SyntaxKind.StringLiteral) continue;
      const arg = args[0];
      const spec = arg.getLiteralText();
      if (!spec.startsWith(".")) continue;
      const isImport = expr.getKind() === SyntaxKind.ImportKeyword;
      const isAllowed = isImport || DYNAMIC_CALLEES.has(expr.getText());
      if (!isAllowed) continue;
      const newRel = computeRewrite(spec, fileDir);
      if (newRel && newRel !== spec) {
        const tag = isImport ? "await-import-relative" : `${expr.getText()}-relative`;
        if (rewriteStringLiteralNode(arg, newRel, tag, filePath, dryRun, repoRoot)) {
          counts.relative++;
        }
      }
    }

    // typeof import("...") with a relative specifier
    const importTypes = sourceFile.getDescendantsOfKind(SyntaxKind.ImportType);
    for (const importType of importTypes) {
      const argNode = importType.getArgument?.();
      if (!argNode || argNode.getKind() !== SyntaxKind.LiteralType) continue;
      const strNode = argNode.getLiteral?.();
      if (!strNode || strNode.getKind() !== SyntaxKind.StringLiteral) continue;
      const spec = strNode.getLiteralText();
      if (!spec.startsWith(".")) continue;
      const newRel = computeRewrite(spec, fileDir);
      if (newRel && newRel !== spec) {
        if (rewriteStringLiteralNode(strNode, newRel, "typeof-import-relative", filePath, dryRun, repoRoot)) {
          counts.relative++;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { configPath, dryRun, checkTestPairs } = parseArgs(process.argv);
  const config = loadConfig(configPath);

  // Use cwd as repo root so tests can run in a fixture directory.
  const repoRoot = process.cwd();

  // --check-test-pairs is a standalone validation mode (Round 4 T14/T20 fix).
  if (checkTestPairs) {
    console.log(`--check-test-pairs on phase: ${config.phaseName} (${config.moves.length} moves)`);
    const violations = checkTestPairsForMoves(config.moves, repoRoot);
    if (violations.length > 0) {
      console.error("--check-test-pairs FAILED:");
      for (const v of violations) console.error(`  ${v}`);
      process.exit(1);
    }
    console.log(`--check-test-pairs OK: ${config.moves.length} moves validated (symmetric impl <-> test pairs).`);
    return;
  }

  console.log(`Phase: ${config.phaseName}`);
  console.log(`Mode: ${dryRun ? "dry-run" : "live"}`);
  console.log(`Moves: ${config.moves.length}`);
  console.log("");

  if (config.moves.length === 0) {
    console.log("No moves configured. Exiting.");
    printSummary();
    return;
  }

  // Safety check
  if (!dryRun) {
    checkGitStatus(repoRoot);
  }

  const aliasMap = buildAliasMap(config.moves, repoRoot);
  const absMap = buildAbsoluteMap(config.moves, repoRoot);

  // Set up ts-morph project
  const project = new Project({
    tsConfigFilePath: resolve(repoRoot, "tsconfig.json"),
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      allowJs: true,
    },
  });

  // Scan patterns
  const scanPatterns = [
    resolve(repoRoot, "src/**/*.{ts,tsx,mjs,js}"),
    resolve(repoRoot, "scripts/**/*.{ts,tsx,mjs,js}"),
    resolve(repoRoot, "e2e/**/*.{ts,tsx,mjs,js}"),
    resolve(repoRoot, "next.config.ts"),
    resolve(repoRoot, "vitest.config.ts"),
    resolve(repoRoot, "vitest.integration.config.ts"),
    resolve(repoRoot, "eslint.config.mjs"),
    resolve(repoRoot, "sentry.server.config.ts"),
    resolve(repoRoot, "sentry.client.config.ts"),
    resolve(repoRoot, "instrumentation-client.ts"),
    resolve(repoRoot, "prisma.config.ts"),
    resolve(repoRoot, "postcss.config.mjs"),
    resolve(repoRoot, "proxy.ts"),
  ];

  project.addSourceFilesAtPaths(scanPatterns);

  // Check for template-literal dynamic imports that can't be auto-rewritten
  const templateFails = checkTemplateLiteralImports(project, repoRoot);
  if (templateFails.length > 0) {
    for (const { file, line, text } of templateFails) {
      console.error(
        `[FAIL template-literal-import] ${file}:${line}: ${text} — refactor to exhaustive switch or explicit module map before running codemod`
      );
    }
    throw new CodemodRewriteError(
      "Template-literal dynamic imports detected that could resolve to moved paths. Refactor required before running the codemod."
    );
  }

  // 1. Rewrite alias imports in all scanned files (before git mv so saveSync writes to old paths)
  for (const sourceFile of project.getSourceFiles()) {
    rewriteAliasInFile(sourceFile, aliasMap, repoRoot, dryRun);
  }

  // 2. Rewrite relative imports in files that will be moved (still at old paths in memory)
  for (const move of config.moves) {
    const oldAbsPath = resolve(repoRoot, move.from);
    const newAbsPath = resolve(repoRoot, move.to);
    const movedFile = project.getSourceFile(oldAbsPath);
    if (movedFile) {
      rewriteRelativeInMovedFile(movedFile, oldAbsPath, newAbsPath, absMap, repoRoot, dryRun);
    }
  }

  // 3. Rewrite relative imports from outside src/ pointing to moved files
  rewriteExternalRelativeImports(project, absMap, repoRoot, dryRun);

  // 4. Save all ts-morph changes to disk (at original paths, before git mv)
  if (!dryRun) {
    project.saveSync();
  }

  // 5. Execute git mv for all moves (files already have updated content)
  executeMoves(config.moves, repoRoot, dryRun);

  // 6. Allowlist string rewrites (these are plain text, run after saveSync)
  rewriteAllowlistFile(resolve(repoRoot, "scripts/check-bypass-rls.mjs"), aliasMap, repoRoot, dryRun, "check-bypass-rls.mjs");
  rewriteAllowlistFile(resolve(repoRoot, "scripts/check-crypto-domains.mjs"), aliasMap, repoRoot, dryRun, "check-crypto-domains.mjs");
  rewriteAllowlistFile(resolve(repoRoot, "vitest.config.ts"), aliasMap, repoRoot, dryRun, "vitest.config.ts");

  // 7. YAML string rewrites (.github/workflows/*.yml)
  const { globSync } = await import("glob");
  const ymlFiles = globSync(resolve(repoRoot, ".github/workflows/*.yml"));
  for (const ymlFile of ymlFiles) {
    rewriteYamlFile(ymlFile, aliasMap, repoRoot, dryRun);
  }

  console.log("");
  printSummary();
}

function printSummary() {
  console.log(
    `Summary: ${counts.moves} moves, ${counts.alias} alias rewrites, ${counts.relative} relative rewrites, ` +
    `${counts.viMock} vi.mock, ${counts.dynamicImport} dynamic imports, ${counts.typeofImport} typeof imports, ` +
    `${counts.reExport} re-exports, ${counts.allowlist} allowlist updates.`
  );
  console.log("Run `npx tsc --noEmit` to verify the tree.");
}

main().catch((err) => {
  console.error(`\nError [${err.name ?? "Error"}]: ${err.message}`);
  process.exit(1);
});
