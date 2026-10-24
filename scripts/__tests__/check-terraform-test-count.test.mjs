/**
 * Self-test for scripts/checks/check-terraform-test-count.mjs — the count check
 * behind the terraform CI job's `terraform test -json` step. Fixtures are
 * shaped as Terraform 1.15 prints them (one JSON record per line); the vector
 * file is a fixture too, so the expected count comes from it, as in CI.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHECK = resolve(__dirname, "..", "checks", "check-terraform-test-count.mjs");

let dir;
let vectorsPath;
let outputPath;

/** Three entries with a Terraform verdict, one without. */
const VECTORS = {
  vectors: [
    { value: null, terraform: "n/a", zod: "allow" },
    { value: "", terraform: "deny", zod: "allow" },
    { value: "a", terraform: "allow", zod: "allow" },
    { value: "*", terraform: "deny", zod: "deny" },
  ],
};

function summary(fields) {
  return JSON.stringify({
    "@level": "info",
    "@message": "Success!",
    "@module": "terraform.ui",
    test_summary: { status: "pass", passed: 3, failed: 0, errored: 0, skipped: 0, ...fields },
    type: "test_summary",
  });
}

const RUN_LINE = JSON.stringify({ "@level": "info", "@message": "  \"allow_a\"... pass", type: "test_run", test_run: { path: "tests/prefix.tftest.hcl", run: "allow_a", progress: "complete", status: "pass" } });

function check(lines) {
  writeFileSync(outputPath, lines.join("\n") + "\n", "utf8");
  return spawnSync(process.execPath, [CHECK, outputPath, vectorsPath], { encoding: "utf8" });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tf-test-count-"));
  vectorsPath = join(dir, "prefix-vectors.json");
  outputPath = join(dir, "test.json");
  writeFileSync(vectorsPath, JSON.stringify(VECTORS), "utf8");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("check-terraform-test-count.mjs", () => {
  it("passes when one summary reports every vector run passed", () => {
    const r = check([RUN_LINE, summary({})]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("3/3 runs passed");
  });

  it("fails when there is no summary record", () => {
    const r = check([RUN_LINE]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("expected exactly one test_summary record, found 0");
  });

  it("fails on the output of a directory with no test file", () => {
    // What `terraform test` prints from the root: exit 0, nothing ran.
    const r = check([summary({ passed: 0 })]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("passed=0");
  });

  it("fails when one run fewer than the vectors passed", () => {
    const r = check([summary({ passed: 2 })]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("passed=2, but");
  });

  it("fails on a failed or errored run even when the count matches", () => {
    expect(check([summary({ status: "fail", failed: 1 })]).status).toBe(1);
    expect(check([summary({ errored: 1 })]).status).toBe(1);
  });

  it("fails on a non-numeric count", () => {
    const r = check([summary({ passed: "3" })]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("test_summary.passed is not an integer");
  });

  it("fails on two summary records", () => {
    const r = check([summary({}), summary({})]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("found 2");
  });

  it("fails when the output file is missing", () => {
    const r = spawnSync(process.execPath, [CHECK, join(dir, "absent.json"), vectorsPath], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("cannot read");
  });
});
