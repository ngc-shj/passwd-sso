#!/usr/bin/env node
/**
 * Test-count invariant gate for the split-overcrowded-feature-dirs refactor.
 *
 * Phase-N move PRs must not silently lose/skip/fail any test. This script
 * runs Vitest with JSON output, extracts 4 metrics, and compares against a
 * baseline. First-run records a baseline; subsequent runs fail on mismatch.
 *
 * Usage:
 *   node scripts/capture-test-counts.mjs --record    # capture new baseline
 *   node scripts/capture-test-counts.mjs --verify    # default, compare to baseline
 *   node scripts/capture-test-counts.mjs             # same as --verify
 *
 * Baseline file: .refactor-test-count-baseline (gitignored; per-developer and
 * per-CI-job state, same pattern as .refactor-phase-verify-baseline).
 *
 * First-run semantics: if baseline absent, capture current counts as baseline
 * and exit 0. Subsequent runs compare.
 *
 * Exit 0 = baseline recorded, or counts match.
 * Exit 1 = counts differ from baseline (test lost, newly skipped, or failing).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

// PR 2: moved from scripts/ to scripts/checks/ — bump one extra level up.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASELINE_FILE = join(ROOT, ".refactor-test-count-baseline");

// Vitest 4 uses numPendingTests (not numSkippedTests) for .skip/.todo tests.
// See the keys of `vitest run --reporter=json --outputFile=<path>` output.
const METRIC_KEYS = ["numTotalTests", "numPassedTests", "numPendingTests", "numFailedTests", "numTodoTests"];

function parseArgs(argv) {
  const args = argv.slice(2);
  let mode = "verify";
  for (const a of args) {
    if (a === "--record") mode = "record";
    else if (a === "--verify") mode = "verify";
  }
  return { mode };
}

/**
 * Run vitest with JSON reporter. Vitest 4 emits a JSON summary file via
 * --outputFile alongside its normal text output. We use a temp file so we
 * do not have to parse stdout.
 */
function runVitest() {
  const tmpOutDir = mkdtempSync(join(tmpdir(), "refactor-test-counts-"));
  const outFile = join(tmpOutDir, "results.json");
  try {
    try {
      execFileSync(
        "npx",
        ["vitest", "run", "--reporter=json", `--outputFile=${outFile}`],
        { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"], encoding: "utf-8" }
      );
    } catch (err) {
      // Vitest exits non-zero on test failures; we still want to read the JSON
      // to capture numFailedTests. Only rethrow if the output file is missing.
      if (!existsSync(outFile)) throw err;
    }
    // Vitest 4 writes a single JSON file to --outputFile. Surface ENOENT
    // directly instead of a misleading "directory" fallback.
    const raw = readFileSync(outFile, "utf-8");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Vitest JSON output was not parseable: ${err.message}`);
    }
    const metrics = {};
    for (const k of METRIC_KEYS) {
      if (typeof parsed[k] !== "number") {
        throw new Error(`Vitest JSON missing metric: ${k}`);
      }
      metrics[k] = parsed[k];
    }
    return metrics;
  } finally {
    rmSync(tmpOutDir, { recursive: true, force: true });
  }
}

function loadBaseline() {
  if (!existsSync(BASELINE_FILE)) return null;
  const raw = readFileSync(BASELINE_FILE, "utf-8").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Baseline file corrupt: ${err.message}`);
  }
}

function saveBaseline(metrics) {
  writeFileSync(BASELINE_FILE, JSON.stringify(metrics) + "\n", "utf-8");
}

function formatMetrics(m) {
  return METRIC_KEYS.map((k) => `${k}=${m[k]}`).join(" ");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const { mode } = parseArgs(process.argv);

if (mode === "record") {
  const metrics = runVitest();
  saveBaseline(metrics);
  console.log(`capture-test-counts recorded baseline: ${formatMetrics(metrics)}`);
  process.exit(0);
}

// verify mode
const baseline = loadBaseline();
if (baseline === null) {
  // First run — record + pass
  const metrics = runVitest();
  saveBaseline(metrics);
  console.log(
    `capture-test-counts: no baseline — recorded first-run counts: ${formatMetrics(metrics)}`
  );
  process.exit(0);
}

const current = runVitest();
const mismatches = METRIC_KEYS.filter((k) => current[k] !== baseline[k]);
if (mismatches.length > 0) {
  console.error("capture-test-counts FAILED: metric mismatch vs baseline.");
  console.error(`  baseline: ${formatMetrics(baseline)}`);
  console.error(`  current:  ${formatMetrics(current)}`);
  console.error(`  diff on:  ${mismatches.join(", ")}`);
  console.error(
    "  A drop in numTotalTests or numPassedTests typically means a test was lost or newly skipped."
  );
  console.error(
    "  To update the baseline after an intentional change: node scripts/capture-test-counts.mjs --record"
  );
  process.exit(1);
}

console.log(`capture-test-counts OK: ${formatMetrics(current)} (matches baseline)`);
