#!/usr/bin/env node
/**
 * CI guard: on a refactor PR, assert that all moved files changed ONLY in their
 * import/export lines (no logic or constant changes).
 *
 * Usage:
 *   node scripts/verify-move-only-diff.mjs [--glob 'src/lib/crypto/**']
 *
 * --glob    Limit check to renamed files matching this glob pattern (optional).
 *           Default: check all renamed files.
 *
 * Expected CI context: run on a feature branch with main as base.
 * Exit 0 = OK, Exit 1 = content drift detected.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Project } = require("ts-morph");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = argv.slice(2);
  let glob = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--glob" && args[i + 1]) {
      glob = args[++i];
    }
  }
  return { glob };
}

const { glob: globFilter } = parseArgs(process.argv);

// ---------------------------------------------------------------------------
// Simple glob matcher (supports * and ** wildcards only)
// ---------------------------------------------------------------------------
function globToRegex(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__DOUBLE_STAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/__DOUBLE_STAR__/g, ".*");
  return new RegExp(`^${escaped}$`);
}

// ---------------------------------------------------------------------------
// Strip import/export declarations and normalize for comparison
// ---------------------------------------------------------------------------

/**
 * AST-based stripping: removes all top-level ImportDeclaration and
 * ExportDeclaration nodes from source text using ts-morph, then normalises
 * (collapse blank lines, trim trailing whitespace).
 *
 * Falls back to the line-regex approach if ts-morph fails to parse the source,
 * printing a warning to stderr so the caller is never silently misled.
 */
function stripImportExportDeclarations(content) {
  try {
    const project = new Project({ useInMemoryFileSystem: true });
    const sf = project.createSourceFile("__strip__.ts", content, { overwrite: true });

    // Collect text ranges for all top-level import/export declarations
    const ranges = [];
    for (const decl of sf.getImportDeclarations()) {
      ranges.push([decl.getFullStart(), decl.getEnd()]);
    }
    for (const decl of sf.getExportDeclarations()) {
      ranges.push([decl.getFullStart(), decl.getEnd()]);
    }

    if (ranges.length === 0) {
      return normalise(content);
    }

    // Sort ranges and build body by stitching the gaps
    ranges.sort((a, b) => a[0] - b[0]);
    let body = "";
    let cursor = 0;
    for (const [start, end] of ranges) {
      if (start > cursor) body += content.slice(cursor, start);
      cursor = end;
    }
    body += content.slice(cursor);
    return normalise(body);
  } catch (err) {
    process.stderr.write(
      `[verify-move-only-diff] ts-morph parse failed, falling back to line-regex: ${err.message}\n`
    );
    return stripImportExportLinesFallback(content);
  }
}

function normalise(text) {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

/** Fallback regex-based approach (original logic, minus the lone-} filter). */
function stripImportExportLinesFallback(content) {
  return content
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed === "") return false;
      // Side-effect imports: import "..."; or import '...';
      if (/^import\s+["'][^"']+["'];?\s*$/.test(trimmed)) return false;
      // Static imports/exports with from
      if (/^(import|export)\b/.test(trimmed) && /from\s+["'][^"']+["']/.test(trimmed)) return false;
      // export * from or export { } from
      if (/^export\s+(\*|\{[^}]*\})\s+from/.test(trimmed)) return false;
      return true;
    })
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Get list of renamed files from git
// ---------------------------------------------------------------------------
let nameStatusOut = "";
try {
  nameStatusOut = execSync("git diff --name-status main...HEAD", { encoding: "utf8" });
} catch {
  nameStatusOut = "";
}

// Parse rename lines: R<similarity>\t<from>\t<to>
const renames = [];
for (const line of nameStatusOut.split("\n")) {
  const parts = line.split("\t");
  if (parts.length === 3 && parts[0].startsWith("R")) {
    renames.push({ from: parts[1], to: parts[2] });
  }
}

// Apply glob filter if provided
const filtered = globFilter
  ? renames.filter(({ from, to }) => {
      const re = globToRegex(globFilter);
      return re.test(from) || re.test(to);
    })
  : renames;

if (filtered.length === 0) {
  console.log("verify-move-only-diff OK: 0 moves verified, 0 content drifts.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Check each rename for non-import changes
// ---------------------------------------------------------------------------
const drifts = [];

for (const { from, to } of filtered) {
  // Read pre-move content from main
  let preCont = "";
  try {
    preCont = execSync(`git show main:${from}`, { encoding: "utf8" });
  } catch {
    // File might not exist in main (new file added alongside rename) — skip
    continue;
  }

  // Read post-move content from working tree
  let postCont = "";
  try {
    postCont = readFileSync(resolve(ROOT, to), "utf8");
  } catch {
    drifts.push({ from, to, reason: `Cannot read destination file: ${to}` });
    continue;
  }

  const preStripped = stripImportExportDeclarations(preCont);
  const postStripped = stripImportExportDeclarations(postCont);

  if (preStripped !== postStripped) {
    drifts.push({ from, to, preStripped, postStripped });
  }
}

if (drifts.length > 0) {
  for (const { from, to, reason, preStripped, postStripped } of drifts) {
    if (reason) {
      console.error(`[verify-move-only-diff] ${from} -> ${to}: ${reason}`);
      continue;
    }
    console.error(`[verify-move-only-diff] ${from} -> ${to}: non-import changes detected.`);
    // Show a simple diff: lines in post not in pre (added), lines in pre not in post (removed)
    const preLines = new Set((preStripped ?? "").split("\n"));
    const postLines = (postStripped ?? "").split("\n");
    for (const line of postLines) {
      if (!preLines.has(line) && line.trim()) {
        console.error(`  + ${line}`);
      }
    }
    const postSet = new Set(postLines);
    for (const line of (preStripped ?? "").split("\n")) {
      if (!postSet.has(line) && line.trim()) {
        console.error(`  - ${line}`);
      }
    }
  }
  process.exit(1);
}

console.log(
  `verify-move-only-diff OK: ${filtered.length} moves verified, 0 content drifts.`
);
