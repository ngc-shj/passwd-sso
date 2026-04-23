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

    // Also blank out the specifier argument of dynamic import(), require(),
    // vi.mock(), vi.doMock(), vi.importActual(), vi.importOriginal() calls,
    // AND typeof import(...) type references. The codemod rewrites these
    // alongside static imports; including their rewritten specifier here
    // would trigger false content-drift failures when a move also rewrites
    // a dynamic specifier.
    const SPEC_REWRITE_CALLEES = new Set([
      "require",
      "vi.mock",
      "vi.doMock",
      "vi.importActual",
      "vi.importOriginal",
      // Codemod gap (handled by manual edit in some PRs; Round 4/T10):
      "vi.unmock",
    ]);
    const specRanges = [];
    // Path-literal heuristic (Round 4 codemod-gap edits):
    // Strip any StringLiteral whose text starts with "src/" or "scripts/"
    // AND contains a "/" — these are path references that move with renames
    // (e.g., readFileSync(join(cwd(), "src/components/..."))). Scoped to
    // test files via call-context: only stripped when nested inside a
    // CallExpression argument (not a free-floating literal).
    const isPathLiteral = (text) =>
      /^(src|scripts|e2e)\/[a-z0-9_/.-]+\.(ts|tsx|mjs|js)$/i.test(text);
    for (const node of sf.getDescendants()) {
      const kn = node.getKindName();
      if (kn === "CallExpression") {
        const expr = node.getExpression();
        const args = node.getArguments();
        // Primary specifier strip: first-arg string literal to tracked callees.
        if (args[0] && args[0].getKindName() === "StringLiteral") {
          if (
            expr.getKindName() === "ImportKeyword" ||
            SPEC_REWRITE_CALLEES.has(expr.getText())
          ) {
            specRanges.push([args[0].getStart(), args[0].getEnd()]);
          }
        }
        // Path-literal heuristic: ANY StringLiteral arg that looks like a
        // repo-relative path to a source file. Catches `join(cwd(), "src/...")`.
        for (const arg of args) {
          if (arg.getKindName() === "StringLiteral") {
            const raw = arg.getText().replace(/^["']|["']$/g, "");
            if (isPathLiteral(raw)) {
              specRanges.push([arg.getStart(), arg.getEnd()]);
            }
          }
        }
      } else if (kn === "ImportType") {
        // typeof import("...") — ImportTypeNode holds a LiteralTypeNode → StringLiteral
        const arg = node.getArgument?.();
        if (arg && arg.getKindName?.() === "LiteralType") {
          const lit = arg.getLiteral?.();
          if (lit && lit.getKindName?.() === "StringLiteral") {
            specRanges.push([lit.getStart(), lit.getEnd()]);
          }
        }
      }
    }

    const allRanges = [...ranges, ...specRanges];
    if (allRanges.length === 0) {
      return normalise(content);
    }

    // Sort ranges and build body by stitching the gaps; for spec ranges we
    // blank them in place (replace with empty string) so the surrounding
    // syntax remains intact.
    allRanges.sort((a, b) => a[0] - b[0]);
    let body = "";
    let cursor = 0;
    for (const [start, end] of allRanges) {
      if (start > cursor) body += content.slice(cursor, start);
      cursor = end;
    }
    body += content.slice(cursor);
    return normalise(body);
  } catch (err) {
    // Fail-closed: the fallback line-regex does NOT handle multi-line imports
    // or dynamic-import specifier blanking (the exact cases the AST strip
    // targets). Accepting it here would silently re-introduce false content-
    // drift errors that the M1 fix eliminated. Abort with a loud error so
    // the operator investigates the parse failure instead of treating it as
    // a best-effort degradation.
    throw new Error(
      `[verify-move-only-diff] ts-morph parse failed on content: ${err.message}. ` +
      `Cannot fall back safely (line-regex does not handle multi-line imports / ` +
      `dynamic-import specifiers). Fix the parse failure and re-run.`
    );
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

// Fallback line-regex stripper was removed per R2 F7 — keeping it would have
// silently degraded the M1 multi-line-import + dynamic-specifier coverage on
// ts-morph parse failures. stripImportExportDeclarations now fails-closed.

// ---------------------------------------------------------------------------
// Get list of renamed files from git
// ---------------------------------------------------------------------------
let nameStatusOut = "";
try {
  // Use `-M main` (not `main...HEAD`) so uncommitted renames in the working
  // tree are visible to the pre-commit gate. Equivalent to `main...HEAD` on
  // CI where there are no uncommitted changes.
  nameStatusOut = execSync("git diff --name-status -M main", { encoding: "utf8" });
} catch {
  nameStatusOut = "";
}

// Parse rename lines: R<similarity>\t<from>\t<to>
// Accept both R (rename) and C (copy-rename under diff.renames=copies).
// Missing C handling was the m2 fix regression flagged by Phase 3 R2 F6.
const renames = [];
for (const line of nameStatusOut.split("\n")) {
  const parts = line.split("\t");
  if (parts.length === 3 && (parts[0].startsWith("R") || parts[0].startsWith("C"))) {
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
