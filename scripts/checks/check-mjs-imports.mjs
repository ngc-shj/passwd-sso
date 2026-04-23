#!/usr/bin/env node
/**
 * CI guard: validate every import target in every .mjs file resolves to a
 * real file (for relative and @/ alias imports).
 *
 * Usage:
 *   node scripts/check-mjs-imports.mjs
 *
 * Scans: scripts/*.mjs, root *.mjs, load-test/setup/*.mjs
 * Checks:
 *   - Relative imports (./... or ../...): file must exist
 *   - Alias imports (@/...): resolved against src/ directory
 *   - Bare packages (node:..., or no prefix): skipped
 *
 * Exit 0 = OK, Exit 1 = unresolvable import(s) found.
 */

import { readdirSync, existsSync, readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// PR 2: moved from scripts/ to scripts/checks/ — bump one extra level up.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ---------------------------------------------------------------------------
// Collect all .mjs files
// ---------------------------------------------------------------------------
function collectMjsFiles() {
  const files = [];

  // Root-level .mjs files
  for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".mjs")) {
      files.push(resolve(ROOT, entry.name));
    }
  }

  // scripts/*.mjs (and subdirectories)
  function walkDir(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        walkDir(join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith(".mjs") && !entry.name.endsWith(".test.mjs")) {
        const fullPath = join(dir, entry.name);
        if (!files.includes(fullPath)) {
          files.push(fullPath);
        }
      }
    }
  }

  walkDir(resolve(ROOT, "scripts"));

  // load-test/setup/
  const ltSetup = resolve(ROOT, "load-test/setup");
  if (existsSync(ltSetup)) walkDir(ltSetup);

  return files;
}

// ---------------------------------------------------------------------------
// Extract import specifiers from a .mjs file source
// Returns: Array<{ specifier: string, line: number }>
// Skips comment lines and specifiers containing ellipsis (...) placeholder text.
// ---------------------------------------------------------------------------
function extractImports(source) {
  const results = [];
  const lines = source.split("\n");
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Track block comments
    if (inBlockComment) {
      if (line.includes("*/")) inBlockComment = false;
      continue;
    }
    if (line.includes("/*") && !line.includes("*/")) {
      inBlockComment = true;
      continue;
    }

    // Skip line comments
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

    // Static import: import ... from "specifier"
    const staticRe = /\bfrom\s+["']([^"']+)["']/g;
    let m;
    while ((m = staticRe.exec(line)) !== null) {
      if (!m[1].includes("...")) results.push({ specifier: m[1], line: lineNum });
    }

    // Side-effect import: import "specifier"
    const sideRe = /^\s*import\s+["']([^"']+)["']/g;
    while ((m = sideRe.exec(line)) !== null) {
      if (!m[1].includes("...")) results.push({ specifier: m[1], line: lineNum });
    }

    // Dynamic import: import("specifier") or await import("specifier")
    const dynRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
    while ((m = dynRe.exec(line)) !== null) {
      if (!m[1].includes("...")) results.push({ specifier: m[1], line: lineNum });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Try to resolve a specifier relative to a file directory
// Returns true if the file can be found (trying common extensions)
// ---------------------------------------------------------------------------
// .ts/.tsx are intentionally excluded: .mjs files should not import TypeScript
// sources directly. A specifier with an explicit .ts/.tsx suffix is accepted
// via the isExplicitTs check in resolveRelative/resolveAlias below.
const EXTENSIONS = ["", ".mjs", ".js", ".json"];
const TS_EXTENSIONS = [".ts", ".tsx"];

function resolveRelative(specifier, fileDir) {
  const base = resolve(fileDir, specifier);
  // When the specifier already carries an explicit .ts/.tsx suffix, check those too.
  const exts = /\.(ts|tsx)$/.test(specifier)
    ? [...EXTENSIONS, ...TS_EXTENSIONS]
    : EXTENSIONS;
  for (const ext of exts) {
    if (existsSync(base + ext)) return true;
  }
  // Try as directory index
  for (const ext of exts) {
    if (existsSync(join(base, `index${ext}`))) return true;
  }
  return false;
}

function resolveAlias(specifier) {
  // @/ -> src/
  const rel = specifier.slice(2); // remove "@/"
  const base = resolve(ROOT, "src", rel);
  // When the specifier already carries an explicit .ts/.tsx suffix, check those too.
  const exts = /\.(ts|tsx)$/.test(specifier)
    ? [...EXTENSIONS, ...TS_EXTENSIONS]
    : EXTENSIONS;
  for (const ext of exts) {
    if (existsSync(base + ext)) return true;
  }
  for (const ext of exts) {
    if (existsSync(join(base, `index${ext}`))) return true;
  }
  return false;
}

function isPackageImport(specifier) {
  // Bare package: no ./ ../ or @/
  if (specifier.startsWith("node:")) return true;
  if (specifier.startsWith("./") || specifier.startsWith("../")) return false;
  if (specifier.startsWith("@/")) return false;
  // Scoped package or bare package
  return true;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const mjsFiles = collectMjsFiles();
const errors = [];
let totalSpecifiers = 0;

for (const filePath of mjsFiles) {
  let source = "";
  try {
    source = readFileSync(filePath, "utf8");
  } catch {
    continue;
  }

  const imports = extractImports(source);
  const fileDir = dirname(filePath);
  // Relative path for display
  const rel = filePath.startsWith(ROOT) ? filePath.slice(ROOT.length + 1) : filePath;

  for (const { specifier, line } of imports) {
    if (isPackageImport(specifier)) continue;
    totalSpecifiers++;

    let resolved = false;
    if (specifier.startsWith("@/")) {
      resolved = resolveAlias(specifier);
    } else {
      resolved = resolveRelative(specifier, fileDir);
    }

    if (!resolved) {
      errors.push({ rel, line, specifier });
    }
  }
}

if (errors.length > 0) {
  for (const { rel, line, specifier } of errors) {
    console.error(`${rel}:${line}: unresolvable import -> ${specifier}`);
  }
  process.exit(1);
}

console.log(
  `check-mjs-imports OK: ${totalSpecifiers} specifiers in ${mjsFiles.length} .mjs files resolved.`
);
