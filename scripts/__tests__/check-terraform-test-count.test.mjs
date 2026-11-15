/**
 * Self-test for scripts/checks/check-terraform-test-count.mjs — the count check
 * behind the terraform CI job's `terraform test -json` steps. Fixtures are
 * shaped as Terraform 1.15 prints them (one JSON record per line); the vector
 * and run-manifest files are fixtures too, so the expected runs come from
 * them, as in CI.
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

  it("fails when the vector file has no vectors array", () => {
    writeFileSync(vectorsPath, JSON.stringify({ entries: VECTORS.vectors }), "utf8");
    const r = check([summary({})]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${vectorsPath} has no "vectors" array`);
  });

  it("fails when no vector has a Terraform verdict", () => {
    writeFileSync(vectorsPath, JSON.stringify({ vectors: [{ value: null, terraform: "n/a", zod: "allow" }] }), "utf8");
    const r = check([summary({ passed: 0 })]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${vectorsPath} has no entry with a Terraform verdict`);
  });

  it("fails on a failed run reported under status pass", () => {
    const r = check([summary({ failed: 1 })]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("failed=1 errored=0");
  });

  it("fails when the output file is missing", () => {
    const r = spawnSync(process.execPath, [CHECK, join(dir, "absent.json"), vectorsPath], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("cannot read");
  });
});

describe("check-terraform-test-count.mjs — run manifest mode", () => {
  const PATH = "tests/blob_sweep.tftest.hcl";
  let runsPath;

  function runRecord(run, fields = {}) {
    return JSON.stringify({ "@level": "info", "@message": `  "${run}"... pass`, type: "test_run", test_run: { path: PATH, run, progress: "complete", status: "pass", ...fields } });
  }

  function checkRuns(lines) {
    writeFileSync(outputPath, lines.join("\n") + "\n", "utf8");
    return spawnSync(process.execPath, [CHECK, outputPath, runsPath], { encoding: "utf8" });
  }

  beforeEach(() => {
    runsPath = join(dir, "blob_sweep.runs.json");
    writeFileSync(runsPath, JSON.stringify({ path: PATH, runs: ["defaults", "s3_report"] }), "utf8");
  });

  it("passes when exactly the listed runs passed", () => {
    // A teardown record has no status and is not counted.
    const teardown = JSON.stringify({ type: "test_run", test_run: { path: PATH, run: "s3_report", progress: "teardown", elapsed: 0 } });
    const r = checkRuns([runRecord("defaults"), runRecord("s3_report"), teardown, summary({ passed: 2 })]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("2/2 runs passed");
  });

  it("fails when a listed run is missing from the passed set", () => {
    const r = checkRuns([runRecord("defaults"), summary({ passed: 1 })]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`not passed: ${PATH} run s3_report`);
  });

  it("fails when a run was swapped for one the manifest does not list, at the same count", () => {
    const r = checkRuns([runRecord("defaults"), runRecord("renamed"), summary({ passed: 2 })]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`not passed: ${PATH} run s3_report`);
  });

  it("fails when an extra run passed", () => {
    const r = checkRuns([runRecord("defaults"), runRecord("s3_report"), runRecord("extra"), summary({ passed: 3 })]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`passed but not in ${runsPath}: ${PATH} run extra`);
  });

  it("does not count a run that completed with another status", () => {
    const r = checkRuns([runRecord("defaults"), runRecord("s3_report", { status: "skip" }), summary({ passed: 1, skipped: 1 })]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`not passed: ${PATH} run s3_report`);
  });

  it("keys a run by its file: the same name in another file does not count", () => {
    const other = JSON.stringify({ type: "test_run", test_run: { path: "tests/other.tftest.hcl", run: "s3_report", progress: "complete", status: "pass" } });
    const r = checkRuns([runRecord("defaults"), other, summary({ passed: 2 })]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`not passed: ${PATH} run s3_report`);
  });

  it("fails when the same run of the same file passed twice", () => {
    const r = checkRuns([runRecord("defaults"), runRecord("s3_report"), runRecord("s3_report"), summary({ passed: 3 })]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("a run passed twice");
  });

  it("fails when the summary count disagrees with the passed set", () => {
    const r = checkRuns([runRecord("defaults"), runRecord("s3_report"), summary({ passed: 3 })]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("passed=3, but");
  });

  it("still requires a passing summary", () => {
    const r = checkRuns([runRecord("defaults"), runRecord("s3_report"), summary({ passed: 2, status: "fail", failed: 1 })]);
    expect(r.status).toBe(1);
  });

  it.each([
    ["no path", { runs: ["defaults"] }, 'has no "path" string'],
    ["an empty list", { path: PATH, runs: [] }, "lists no runs"],
    ["a duplicate", { path: PATH, runs: ["defaults", "defaults"] }, "lists a run twice"],
    ["a non-string run", { path: PATH, runs: ["defaults", 1] }, "is not an array of run names"],
    ["both keys", { path: PATH, runs: ["defaults"], vectors: [] }, 'has both "vectors" and "runs"'],
  ])("refuses a manifest with %s", (_name, manifest, message) => {
    writeFileSync(runsPath, JSON.stringify(manifest), "utf8");
    const r = checkRuns([runRecord("defaults"), summary({ passed: 1 })]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(message);
  });
});
