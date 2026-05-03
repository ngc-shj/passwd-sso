#!/usr/bin/env node
// coverage-diff.mjs — per-batch coverage delta gate.
//
// Reads two istanbul-shape v8 coverage reports (vitest's
// coverage-final.json) and asserts every targeted file's covered-line and
// covered-branch counts strictly increase from prev to next.
//
// Usage:
//   node scripts/coverage-diff.mjs <prev-json> <next-json> --files <glob1> <glob2> ...
//
// --files accepts file paths relative to the repo root or simple `**`/`*`
// globs. At least one --files entry is required so the gate is restricted to
// the batch's targeted files (avoids passing vacuously when an unrelated test
// in another file improves coverage).
//
// Exits 0 on success, 1 on regression / spec violation.

import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

function loadReport(path) {
  const raw = readFileSync(path, "utf8");
  // Bracket-access only — never Object.assign or spread the parsed object
  // into an existing target (defense against prototype pollution from a
  // crafted coverage JSON).
  return JSON.parse(raw);
}

function countCovered(fileEntry) {
  const branchHits = fileEntry["b"] ?? {};
  const stmtHits = fileEntry["s"] ?? {};
  let coveredLines = 0;
  for (const id of Object.keys(stmtHits)) {
    if (stmtHits[id] > 0) coveredLines += 1;
  }
  let coveredBranches = 0;
  for (const id of Object.keys(branchHits)) {
    const arr = branchHits[id] ?? [];
    for (const hit of arr) {
      if (hit > 0) coveredBranches += 1;
    }
  }
  return { coveredLines, coveredBranches };
}

function globMatches(absolute, glob) {
  // simple glob: ** = any chars incl /, * = any chars excl /
  const pattern = glob
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "::DOUBLESTAR::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DOUBLESTAR::/g, ".*");
  const re = new RegExp(`(^|/)${pattern}$`);
  return re.test(absolute);
}

function main() {
  const argv = process.argv.slice(2);
  const filesIdx = argv.indexOf("--files");
  if (argv.length < 2 || filesIdx < 0 || filesIdx === argv.length - 1) {
    process.stderr.write(
      "usage: coverage-diff.mjs <prev-json> <next-json> --files <glob1> [glob2 ...]\n",
    );
    process.exit(2);
  }
  const prevPath = argv[0];
  const nextPath = argv[1];
  const globs = argv.slice(filesIdx + 1);
  if (globs.length === 0) {
    process.stderr.write("--files requires at least one glob\n");
    process.exit(2);
  }

  const prev = loadReport(prevPath);
  const next = loadReport(nextPath);

  const targetedFiles = new Set();
  for (const filePath of Object.keys(next)) {
    for (const glob of globs) {
      if (globMatches(filePath.split(sep).join("/"), glob)) {
        targetedFiles.add(filePath);
        break;
      }
    }
  }

  if (targetedFiles.size === 0) {
    process.stderr.write(
      `no files matched any of: ${globs.join(", ")}\n` +
        "  (the next coverage report has no entries for the targeted globs;\n" +
        "   either no targeted file was loaded by any test, or the globs are wrong)\n",
    );
    process.exit(1);
  }

  let failures = 0;
  for (const filePath of targetedFiles) {
    const prevEntry = prev[filePath] ?? { s: {}, b: {} };
    const nextEntry = next[filePath];
    const prevCnt = countCovered(prevEntry);
    const nextCnt = countCovered(nextEntry);
    const linesGain = nextCnt.coveredLines - prevCnt.coveredLines;
    const branchGain = nextCnt.coveredBranches - prevCnt.coveredBranches;
    const ok = linesGain > 0 && branchGain > 0;
    process.stdout.write(
      `${ok ? "OK" : "FAIL"} ${filePath}: lines ${prevCnt.coveredLines}→${nextCnt.coveredLines} (+${linesGain}), branches ${prevCnt.coveredBranches}→${nextCnt.coveredBranches} (+${branchGain})\n`,
    );
    if (!ok) failures += 1;
  }

  if (failures > 0) {
    process.stderr.write(
      `\ncoverage-diff: ${failures} of ${targetedFiles.size} targeted file(s) did not strictly gain both lines and branches\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `\ncoverage-diff: all ${targetedFiles.size} targeted file(s) gained both lines and branches\n`,
  );
}

main();
