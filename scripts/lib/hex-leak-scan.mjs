#!/usr/bin/env node
/**
 * Node-based gitleaks fallback (SEC-5, S19/S27).
 *
 * Scans the staged diff for 64-char hex sequences that might be secrets.
 * This is a defense-in-depth fallback — not a gitleaks substitute.
 * Full coverage requires the gitleaks binary.
 *
 * Design:
 *   - Reads staged files via "git diff --cached --name-only -z" (NUL-separated,
 *     filename-injection-safe per S27).
 *   - Skips .env.example (contains placeholder hex strings by design).
 *   - For each staged file, runs "git diff --cached -- <file>" as an argv array
 *     (no shell interpolation).
 *   - Per-file state machine tracks block-comment state across lines.
 *   - Exempt lines: dotenv comments (#), JS single-line comments (//), JSDoc (*),
 *     and lines inside a block comment (/ * ... * /).
 *   - Markdown fenced code blocks are NOT exempt (fail-closed, per plan S20).
 *   - On match: prints "path:lineNum:<first8hex>..." to stdout and exits 1.
 *   - On no match: exits 0 silently.
 *
 * Usage: node scripts/lib/hex-leak-scan.mjs
 */

import { execFileSync } from "node:child_process";

// Detects a 64-char hex run, bounded by non-hex chars (replaces \b for portability).
const HEX64_RE = /(?:^|[^a-f0-9])([a-f0-9]{64})(?:$|[^a-f0-9])/i;

// Single-line comment patterns: dotenv (#), JS (//), JSDoc ( *)
// The leading "+" is part of a diff added line — the pattern matches after stripping it.
const SINGLE_LINE_COMMENT_RE = /^\+\s*(?:\/\/|#|\*)/;

// Block comment delimiters.
const BLOCK_START_RE = /\/\*/;
const BLOCK_END_RE = /\*\//;

/**
 * Scan a unified diff text for hex leaks.
 * Returns an array of { line, lineNum, hexPrefix } for each match.
 */
export function scanDiff(diffText, filePath) {
  const lines = diffText.split("\n");
  const matches = [];
  let inBlockComment = false;
  let diffLineNum = 0; // tracks the "+" hunk line numbers

  for (const line of lines) {
    // Track hunk headers to know source line numbers.
    const hunkMatch = line.match(/^@@ [^+]*\+(\d+)/);
    if (hunkMatch) {
      diffLineNum = parseInt(hunkMatch[1], 10) - 1;
      continue;
    }

    // Only process added lines (start with "+" but not "+++").
    if (!line.startsWith("+") || line.startsWith("+++")) {
      if (!line.startsWith("-")) {
        // Context line — advance line counter.
        diffLineNum++;
      }
      continue;
    }

    diffLineNum++;
    const content = line.slice(1); // strip leading "+"

    // Update block-comment state before checking exemptions.
    const hadBlockCommentOpen = inBlockComment;

    // Check for block comment transitions in this line.
    if (!inBlockComment) {
      if (BLOCK_START_RE.test(content)) {
        inBlockComment = true;
        // If the block closes on the same line, exit block-comment state.
        const afterOpen = content.replace(/.*?\/\*/, "");
        if (BLOCK_END_RE.test(afterOpen)) {
          inBlockComment = false;
        }
      }
    } else {
      // Inside a block comment — check for closing.
      if (BLOCK_END_RE.test(content)) {
        inBlockComment = false;
      }
      // Entire line is inside block comment → exempt.
      continue;
    }

    // If we just entered a block comment on this line and the line itself
    // is a comment-open line, exempt it (the content is a comment delimiter).
    if (!hadBlockCommentOpen && inBlockComment) {
      // Line opened a block comment — still check; the code before /* may have a secret.
      // Fall through to the hex check.
    }

    // Exempt single-line comments.
    if (SINGLE_LINE_COMMENT_RE.test(line)) {
      continue;
    }

    // Check for 64-char hex runs.
    const m = HEX64_RE.exec(content);
    if (m) {
      const hexPrefix = m[1].slice(0, 8);
      matches.push({ line: content, lineNum: diffLineNum, hexPrefix, filePath });
    }
  }

  return matches;
}

// CLI entry point.
if (import.meta.url === `file://${process.argv[1]}`) {
  // Get staged file list (NUL-separated for safe filename handling).
  let stagedOutput;
  try {
    stagedOutput = execFileSync("git", ["diff", "--cached", "--name-only", "-z"], {
      encoding: "utf8",
    });
  } catch {
    // Not in a git repo or no staged changes — exit 0.
    process.exit(0);
  }

  const stagedFiles = stagedOutput
    .split("\0")
    .map((f) => f.trim())
    .filter((f) => f.length > 0)
    // Skip .env.example — it intentionally contains placeholder hex strings.
    .filter((f) => f !== ".env.example");

  let found = false;

  for (const file of stagedFiles) {
    let diffText;
    try {
      diffText = execFileSync("git", ["diff", "--cached", "--", file], {
        encoding: "utf8",
        // No shell interpolation — args passed as array.
      });
    } catch {
      continue;
    }

    const matches = scanDiff(diffText, file);
    for (const m of matches) {
      console.log(`${m.filePath}:${m.lineNum}:${m.hexPrefix}...`);
      found = true;
    }
  }

  process.exit(found ? 1 : 0);
}
