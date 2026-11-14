#!/usr/bin/env node
/**
 * CI guard: a `terraform test -json` run executed every run its expected
 * source calls for, and every one passed.
 *
 * Its exit status alone cannot say that. From a directory with no test file
 * `terraform test` prints "0 passed" and exits 0, and a run deleted from the
 * .tftest.hcl simply stops being counted. So this requires exactly one
 * `test_summary` record with status "pass", failed and errored 0, and passed
 * equal to the expected count — taken from a file kept outside the test file,
 * not from a constant that drifts with it. A missing, duplicated or
 * non-numeric summary fails.
 *
 * The expected source's top-level key picks the mode:
 *   - `vectors` (modules/anchor-prefix/prefix-vectors.json): the count of
 *     entries whose `terraform` verdict is not n/a.
 *   - `runs` with `path` (e.g. infra/terraform/tests/blob_sweep.runs.json):
 *     the run names of that test file. The set of passed runs — `test_run`
 *     records with progress "complete" and status "pass", keyed by path and
 *     run (teardown records carry no status) — must equal it, so a renamed or
 *     swapped run fails as well as a missing one.
 *
 * Usage: check-terraform-test-count.mjs <terraform-test-json-output> <expected.json>
 */
import { readFileSync } from "node:fs";

function fail(msg) {
  console.error(`check-terraform-test-count: ${msg}`);
  process.exit(1);
}

const [outputPath, expectedPath] = process.argv.slice(2);
if (!outputPath || !expectedPath) fail("usage: check-terraform-test-count.mjs <test-json-output> <expected.json>");

let source;
try {
  source = JSON.parse(readFileSync(expectedPath, "utf8"));
} catch (err) {
  fail(`cannot read the expected runs from ${expectedPath}: ${err.message}`);
}

/** The expected run keys (`path\0run`), or null in vectors mode. */
let expectedKeys = null;
let expected;
if (source && "vectors" in source && "runs" in source) {
  fail(`${expectedPath} has both "vectors" and "runs"`);
} else if (source && "runs" in source) {
  const { path, runs } = source;
  if (typeof path !== "string" || path === "") fail(`${expectedPath} has no "path" string`);
  if (!Array.isArray(runs) || runs.some((r) => typeof r !== "string" || r === "")) fail(`${expectedPath} "runs" is not an array of run names`);
  if (runs.length === 0) fail(`${expectedPath} lists no runs`);
  if (new Set(runs).size !== runs.length) fail(`${expectedPath} lists a run twice`);
  expectedKeys = new Set(runs.map((r) => `${path}\0${r}`));
  expected = runs.length;
} else {
  const vectors = source?.vectors;
  if (!Array.isArray(vectors)) fail(`${expectedPath} has no "vectors" array`);
  expected = vectors.filter((v) => v.terraform !== "n/a").length;
  if (expected === 0) fail(`${expectedPath} has no entry with a Terraform verdict`);
}

let text;
try {
  text = readFileSync(outputPath, "utf8");
} catch (err) {
  fail(`cannot read ${outputPath}: ${err.message}`);
}

// One JSON object per line; a line that is not JSON is not a record.
const summaries = [];
const passedKeys = [];
for (const line of text.split("\n")) {
  if (!line.trim()) continue;
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    continue;
  }
  if (record?.type === "test_summary") summaries.push(record.test_summary);
  const run = record?.type === "test_run" ? record.test_run : undefined;
  if (run?.progress === "complete" && run.status === "pass") passedKeys.push(`${run.path}\0${run.run}`);
}

if (summaries.length !== 1) fail(`expected exactly one test_summary record, found ${summaries.length}`);
const [summary] = summaries;
for (const field of ["passed", "failed", "errored"]) {
  if (typeof summary?.[field] !== "number" || !Number.isInteger(summary[field])) {
    fail(`test_summary.${field} is not an integer: ${JSON.stringify(summary?.[field])}`);
  }
}
if (summary.status !== "pass") fail(`test_summary.status is ${JSON.stringify(summary.status)}, not "pass"`);
if (summary.failed !== 0 || summary.errored !== 0) fail(`failed=${summary.failed} errored=${summary.errored}`);

if (expectedKeys) {
  const show = (key) => key.replace("\0", " run ");
  const passed = new Set(passedKeys);
  if (passed.size !== passedKeys.length) fail("a run passed twice");
  const missing = [...expectedKeys].filter((k) => !passed.has(k));
  const unexpected = [...passed].filter((k) => !expectedKeys.has(k));
  if (missing.length > 0) fail(`not passed: ${missing.map(show).join(", ")}`);
  if (unexpected.length > 0) fail(`passed but not in ${expectedPath}: ${unexpected.map(show).join(", ")}`);
  if (summary.passed !== expected) fail(`passed=${summary.passed}, but ${expectedPath} lists ${expected} runs`);
} else if (summary.passed !== expected) {
  fail(`passed=${summary.passed}, but ${expectedPath} has ${expected} entries with a Terraform verdict`);
}

console.log(`check-terraform-test-count: ${summary.passed}/${expected} runs passed`);
