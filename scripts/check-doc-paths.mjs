#!/usr/bin/env node
/**
 * CI guard: validate every src/(lib|hooks|components/passwords)/... reference
 * in docs resolves to an existing file.
 *
 * Usage:
 *   node scripts/check-doc-paths.mjs
 *
 * Scans: docs/**\/*.md, CLAUDE.md, README.md
 * Skips: docs/archive/review/** (contains pre-move path references by design)
 *
 * Exit 0 = OK, Exit 1 = broken reference(s) found.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Allowlisted directories — pre-move or historical references are expected here.
// IMPORTANT: walkDocs passes rel WITHOUT the leading "docs/" prefix, so these
// patterns must match against the path relative to the docs/ directory.
//
// Excluded:
//   docs/archive/**      — historical plans/reviews; pre-move paths by design
//   docs/architecture/** — long-lived design docs may reference deleted files
//   docs/security/**     — security design docs may reference deleted files
//   docs/plans/**        — feature plans may reference files not yet created
//   docs/operations/**   — operational docs with stable external references
const SKIP_GLOBS = [
  /^archive[/\\]/,
  /^architecture[/\\]/,
  /^security[/\\]/,
  /^plans[/\\]/,
  /^operations[/\\]/,
];

// Pattern: src/(lib|hooks|components/passwords)/path/to/file.ts(x)
// NOTE: tsx must come before ts in the alternation to avoid matching the ts
// prefix of a .tsx extension (regex alternation is ordered).
const SRC_REF_RE =
  /src\/(?:lib|hooks|components\/passwords)\/[a-z0-9_/.-]+\.(?:tsx|ts)/g;

// Also match markdown links: [text](src/lib/...)
const MD_LINK_RE =
  /\[([^\]]*)\]\((src\/(?:lib|hooks|components\/passwords)\/[^)]+)\)/g;

function shouldSkip(relPath) {
  return SKIP_GLOBS.some((re) => re.test(relPath));
}

// ---------------------------------------------------------------------------
// Collect all doc files to scan
// ---------------------------------------------------------------------------
function collectDocFiles() {
  const files = [];

  // Root-level docs
  for (const name of ["CLAUDE.md", "README.md"]) {
    const p = resolve(ROOT, name);
    if (existsSync(p)) files.push({ path: p, rel: name });
  }

  // docs/**/*.md
  function walkDocs(dir, rel) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walkDocs(join(dir, entry.name), entryRel);
      } else if (entry.name.endsWith(".md")) {
        if (!shouldSkip(entryRel)) {
          files.push({ path: join(dir, entry.name), rel: `docs/${entryRel}` });
        }
      }
    }
  }

  const docsDir = resolve(ROOT, "docs");
  if (existsSync(docsDir)) walkDocs(docsDir, "");

  return files;
}

// ---------------------------------------------------------------------------
// Resolve a src/ reference allowing extension and directory fallbacks.
// A .ts reference is also satisfied by the same-stem .tsx file, or by a
// same-stem directory (e.g. src/lib/validations/ for src/lib/validations.ts).
// ---------------------------------------------------------------------------
function srcPathExists(srcPath) {
  if (existsSync(resolve(ROOT, srcPath))) return true;
  // Strip fragment anchors like #L16 that appear in some docs
  const withoutFragment = srcPath.replace(/#.*$/, "");
  if (withoutFragment !== srcPath && existsSync(resolve(ROOT, withoutFragment))) return true;
  // .ts -> .tsx fallback
  if (srcPath.endsWith(".ts")) {
    if (existsSync(resolve(ROOT, srcPath + "x"))) return true;
    // .ts -> directory fallback (e.g. validations.ts -> validations/)
    const dirPath = srcPath.replace(/\.ts$/, "");
    if (existsSync(resolve(ROOT, dirPath))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Check references in a single file
// Only check references found in non-code-block context (lines not inside
// fenced code blocks) — plan docs use backtick-quoted paths as examples.
// ---------------------------------------------------------------------------
function checkFile(filePath, relPath) {
  let content;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }

  const broken = [];
  const lines = content.split("\n");
  let inCodeBlock = false;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const lineNum = lineIdx + 1;

    // Toggle code block state on ``` fences
    if (/^```/.test(line.trim())) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    // Skip lines inside fenced code blocks
    if (inCodeBlock) continue;

    // Reset regex state
    SRC_REF_RE.lastIndex = 0;
    MD_LINK_RE.lastIndex = 0;

    // Find bare src/... references (outside code fences)
    let m;
    while ((m = SRC_REF_RE.exec(line)) !== null) {
      const srcPath = m[0];
      if (!srcPathExists(srcPath)) {
        broken.push({ relPath, lineNum, srcPath });
      }
    }

    // Find markdown link references (may overlap — deduplicate by srcPath+line)
    const seen = new Set(broken.filter((b) => b.lineNum === lineNum).map((b) => b.srcPath));
    while ((m = MD_LINK_RE.exec(line)) !== null) {
      // Strip fragment from link target
      const rawSrcPath = m[2].replace(/#.*$/, "");
      if (!seen.has(rawSrcPath) && !srcPathExists(rawSrcPath)) {
        broken.push({ relPath, lineNum, srcPath: rawSrcPath });
        seen.add(rawSrcPath);
      }
    }
  }

  return broken;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const docFiles = collectDocFiles();
const allBroken = [];

for (const { path, rel } of docFiles) {
  const broken = checkFile(path, rel);
  allBroken.push(...broken);
}

if (allBroken.length > 0) {
  for (const { relPath, lineNum, srcPath } of allBroken) {
    console.error(`${relPath}:${lineNum}: broken ref -> ${srcPath}`);
  }
  process.exit(1);
}

// Count unique docs that had at least one reference
const docsWithRefs = new Set();
// Re-scan to count (lightweight)
let totalRefs = 0;
for (const { path, rel } of docFiles) {
  let content = "";
  try {
    content = readFileSync(path, "utf8");
  } catch {
    continue;
  }
  const matches = [...content.matchAll(SRC_REF_RE)];
  if (matches.length > 0) {
    docsWithRefs.add(rel);
    totalRefs += matches.length;
  }
}

console.log(
  `check-doc-paths OK: ${totalRefs} references in ${docsWithRefs.size} docs resolved.`
);
