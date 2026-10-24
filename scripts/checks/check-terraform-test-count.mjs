#!/usr/bin/env node
/**
 * CI guard: `terraform test -json` in infra/terraform/modules/anchor-prefix ran
 * every run the prefix vectors call for, and every one passed.
 *
 * Its exit status alone cannot say that. From a directory with no test file
 * `terraform test` prints "0 passed" and exits 0, and a run deleted from the
 * .tftest.hcl simply stops being counted. So this requires exactly one
 * `test_summary` record with status "pass", failed and errored 0, and passed
 * equal to the number of vector entries whose `terraform` verdict is not n/a —
 * counted from the vector file now, not from a constant that drifts with it.
 * A missing, duplicated or non-numeric summary fails.
 *
 * Usage: check-terraform-test-count.mjs <terraform-test-json-output> <prefix-vectors.json>
 */
import { readFileSync } from "node:fs";

function fail(msg) {
  console.error(`check-terraform-test-count: ${msg}`);
  process.exit(1);
}

const [outputPath, vectorsPath] = process.argv.slice(2);
if (!outputPath || !vectorsPath) fail("usage: check-terraform-test-count.mjs <test-json-output> <prefix-vectors.json>");

let vectors;
try {
  vectors = JSON.parse(readFileSync(vectorsPath, "utf8")).vectors;
} catch (err) {
  fail(`cannot read vectors from ${vectorsPath}: ${err.message}`);
}
if (!Array.isArray(vectors)) fail(`${vectorsPath} has no "vectors" array`);
const expected = vectors.filter((v) => v.terraform !== "n/a").length;
if (expected === 0) fail(`${vectorsPath} has no entry with a Terraform verdict`);

let text;
try {
  text = readFileSync(outputPath, "utf8");
} catch (err) {
  fail(`cannot read ${outputPath}: ${err.message}`);
}

// One JSON object per line; a line that is not JSON is not a record.
const summaries = [];
for (const line of text.split("\n")) {
  if (!line.trim()) continue;
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    continue;
  }
  if (record?.type === "test_summary") summaries.push(record.test_summary);
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
if (summary.passed !== expected) fail(`passed=${summary.passed}, but ${vectorsPath} has ${expected} entries with a Terraform verdict`);

console.log(`check-terraform-test-count: ${summary.passed}/${expected} runs passed`);
