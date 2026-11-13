/**
 * RT7 self-test for check-required-aggregate.mjs — the guard must be provably
 * able to fail. Each red cell plants ONE defect in a minimal valid workflow and
 * asserts a violation naming the job and clause; the allow cells prove the
 * closed `if` grammar still admits every canonical form. The aggregate and
 * `size` steps of both real workflows are also executed, since the gate does
 * not read what their `run` text does.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dump, load } from "js-yaml";
import picomatch from "picomatch";
import { afterEach, describe, expect, it } from "vitest";
import {
  SPECS,
  checkRepository,
  findAggregateStepDivergence,
  findRequiredNameCollisions,
  findWorkflowViolations,
} from "../checks/check-required-aggregate.mjs";

const WORKFLOWS_DIR = ".github/workflows";
const realText = (file) => readFileSync(join(WORKFLOWS_DIR, file), "utf8");
const realDoc = (file) => load(realText(file));

const FC = (...filters) =>
  `always() && (needs.changes.result != 'success' || ${filters
    .map((f) => `needs.changes.outputs.${f} == 'true'`)
    .join(" || ")})`;
const FC_AFTER = `always() && (needs.changes.result != 'success' || needs.changes.outputs.app == 'true') && needs.app-ci.result != 'failure' && needs.app-test.result != 'failure' && needs.app-coverage.result != 'failure' && needs.app-build.result != 'failure'`;

const AGG_STEP = realDoc("ci.yml").jobs["ci-result"].steps[0];
const SIZE_STEP = realDoc("ci.yml").jobs.changes.steps.find((s) => s.id === "size");

/** A minimal workflow that satisfies every rule of the `ci.yml` spec. */
function baseDoc() {
  const gated = { needs: "changes", if: FC("app"), "runs-on": "ubuntu-latest", steps: [{ run: "true" }] };
  const jobs = {
    changes: {
      name: "Detect",
      "runs-on": "ubuntu-latest",
      outputs: {
        app: "${{ steps.filter.outputs.app || 'true' }}",
        ci: "${{ steps.filter.outputs.ci || 'true' }}",
      },
      steps: [
        structuredClone(SIZE_STEP),
        { id: "filter", if: "steps.size.outputs.small == 'true'", uses: "x/y@0" },
      ],
    },
    "app-ci": structuredClone(gated),
    "app-test": structuredClone(gated),
    "app-coverage": {
      needs: ["changes", "app-test"],
      if: "always() && needs.app-test.result == 'success'",
      "runs-on": "ubuntu-latest",
      steps: [{ run: "true" }],
    },
    "app-build": structuredClone(gated),
    e2e: {
      needs: ["changes", "app-ci", "app-test", "app-coverage", "app-build"],
      if: FC_AFTER,
      "runs-on": "ubuntu-latest",
      steps: [{ run: "true" }, { if: "failure()", run: "true" }],
    },
  };
  jobs["ci-result"] = {
    name: "CI result",
    if: "always()",
    permissions: {},
    needs: Object.keys(jobs),
    "runs-on": "ubuntu-latest",
    steps: [structuredClone(AGG_STEP)],
  };
  return {
    name: "ci",
    on: { pull_request: { branches: ["main"] } },
    permissions: { contents: "read" },
    jobs,
  };
}

const CI_SPEC = SPECS["ci.yml"];
const GATED_SPEC = { aggregateId: "ci-result", aggregateName: "CI result", everyJobGated: true };

/** Applies `mutate` to a fresh base and returns the YAML text. */
function build(mutate) {
  const doc = baseDoc();
  mutate?.(doc);
  return dump(doc, { lineWidth: -1 });
}
const violationsOf = (mutate, spec = CI_SPEC) => findWorkflowViolations(build(mutate), "wf.yml", spec);

describe("findWorkflowViolations — allow cells", () => {
  const allow = {
    "base fixture": () => {},
    "needs in array form": (d) => {
      d.jobs["app-ci"].needs = ["changes"];
    },
    "FC with several filters": (d) => {
      d.jobs["app-ci"].if = FC("app", "ci");
    },
    "multi-line FC (YAML folded whitespace)": (d) => {
      d.jobs["app-ci"].if = "always() &&\n(needs.changes.result != 'success' ||\n needs.changes.outputs.app == 'true')\n";
    },
    "job-level permissions contents: read": (d) => {
      d.jobs["app-ci"].permissions = { contents: "read" };
    },
    "branches on the trigger": (d) => {
      d.on.pull_request = { branches: ["main", "release/*"] };
    },
    "pull_request with null body": (d) => {
      d.on.pull_request = null;
    },
    "step-level always() and !cancelled()": (d) => {
      d.jobs["app-ci"].steps = [{ if: "always()", run: "true" }, { if: "!cancelled()", run: "true" }];
    },
  };
  for (const [label, mutate] of Object.entries(allow)) {
    it(`allows: ${label}`, () => {
      expect(violationsOf(mutate)).toEqual([]);
    });
  }

  it("allows every job to be gated when everyJobGated holds", () => {
    const content = build((d) => {
      // Drop the two dependency-conditioned jobs; every job left is plain FC.
      delete d.jobs["app-coverage"];
      delete d.jobs.e2e;
      d.jobs["ci-result"].needs = ["changes", "app-ci", "app-test", "app-build"];
    });
    expect(findWorkflowViolations(content, "wf.yml", GATED_SPEC)).toEqual([]);
  });
});

/** One red cell per clause: id -> [mutation, regex the violation must match]. */
const RED = {
  "R1-paths": [(d) => { d.on.pull_request.paths = ["src/**"]; }, /R1 .*paths/],
  "R1-paths-ignore": [(d) => { d.on.pull_request["paths-ignore"] = ["docs/**"]; }, /R1 .*paths-ignore/],
  "R1-types": [(d) => { d.on.pull_request.types = ["opened"]; }, /R1 .*types/],
  "R1-missing-pull-request": [(d) => { d.on = { push: null }; }, /R1 .*on\.pull_request.*missing/],
  "R1-pull-request-target": [(d) => { d.on.pull_request_target = null; }, /R1 .*pull_request_target/],
  "R2-aggregate-missing": [(d) => { delete d.jobs["ci-result"]; }, /R2 aggregate job 'ci-result' is missing/],
  "R2-name-wrong": [(d) => { d.jobs["ci-result"].name = "Result"; }, /'ci-result'.*R2 name/],
  "R2-name-expression": [(d) => { d.jobs["ci-result"].name = "CI ${{ matrix.n }}"; }, /'ci-result'.*R2 name/],
  "R3-if-not-always": [(d) => { d.jobs["ci-result"].if = "!cancelled()"; }, /'ci-result'.*R3 'if'/],
  "R3-if-absent": [(d) => { delete d.jobs["ci-result"].if; }, /'ci-result'.*R3 'if'/],
  "R3-permissions-missing": [(d) => { delete d.jobs["ci-result"].permissions; }, /'ci-result'.*R3 'permissions'/],
  "R3-strategy": [(d) => { d.jobs["ci-result"].strategy = { matrix: { n: [1] } }; }, /'ci-result'.*R3 'strategy'/],
  "R3-defaults": [(d) => { d.jobs["ci-result"].defaults = { run: { shell: "sh" } }; }, /'ci-result'.*R3 'defaults'/],
  "R3-job-env": [(d) => { d.jobs["ci-result"].env = { A: "1" }; }, /'ci-result'.*R3 'env'/],
  "R3-step-if": [(d) => { d.jobs["ci-result"].steps[0].if = "success()"; }, /'ci-result'.*R3 step-level 'if'/],
  "R3-step-shell": [(d) => { d.jobs["ci-result"].steps[0].shell = "sh"; }, /'ci-result'.*R3 step-level 'shell'/],
  "R3-workflow-default-shell": [(d) => { d.defaults = { run: { shell: "sh" } }; }, /R3 'defaults\.run\.shell'/],
  "R3-workflow-env": [(d) => { d.env = { A: "1" }; }, /R3 top-level 'env'/],
  "R4-two-steps": [(d) => { d.jobs["ci-result"].steps.push({ run: "true" }); }, /'ci-result'.*R4 must have exactly one step/],
  "R4-env-changed": [(d) => { d.jobs["ci-result"].steps[0].env = { NEEDS: "{}" }; }, /'ci-result'.*R4 step 'env'/],
  "R4-run-expression": [(d) => { d.jobs["ci-result"].steps[0].run = "echo ${{ github.actor }}"; }, /'ci-result'.*R4 step 'run'/],
  "R5-needs-missing": [(d) => { d.jobs["ci-result"].needs = d.jobs["ci-result"].needs.filter((n) => n !== "app-build"); }, /'ci-result'.*R5 .*missing job 'app-build'/],
  "R5-needs-extra": [(d) => { d.jobs["ci-result"].needs.push("ghost"); }, /'ci-result'.*R5 .*'ghost'/],
  "R6-job-continue-on-error": [(d) => { d.jobs["app-build"]["continue-on-error"] = true; }, /'app-build'.*R6/],
  "R6-step-continue-on-error": [(d) => { d.jobs["app-build"].steps[0]["continue-on-error"] = true; }, /'app-build'.*R6 step-level/],
  "R7-unknown-filter": [(d) => { d.jobs["app-ci"].if = FC("intgration"); }, /'app-ci'.*R7 .*'intgration'/],
  "R7-fc-without-always": [(d) => { d.jobs["app-ci"].if = "(needs.changes.result != 'success' || needs.changes.outputs.app == 'true')"; }, /'app-ci'.*R7/],
  "R7-fc-and-false": [(d) => { d.jobs["app-ci"].if = `${FC("app")} && false`; }, /'app-ci'.*R7/],
  "R7-github-context": [(d) => { d.jobs["app-ci"].if = "always() && github.event_name == 'push'"; }, /'app-ci'.*R7/],
  "R7-after-unlisted-pair": [(d) => { d.jobs["app-build"].if = "always() && needs.app-test.result == 'success'"; d.jobs["app-build"].needs = ["changes", "app-test"]; }, /'app-build'.*R7/],
  "R7-fc-after-failure-eq": [(d) => { d.jobs.e2e.if = FC_AFTER.replace("needs.app-build.result != 'failure'", "needs.app-build.result == 'failure'"); }, /'e2e'.*R7/],
  "R7-fc-after-dep-dropped": [(d) => { d.jobs.e2e.if = FC_AFTER.replace(" && needs.app-build.result != 'failure'", ""); }, /'e2e'.*R7/],
  "R7-need-not-listed": [(d) => { d.jobs["app-ci"].needs = []; }, /'app-ci'.*R7 .*needs\.changes/],
  "R8-top-write-all": [(d) => { d.permissions = "write-all"; }, /R8 top-level/],
  "R8-top-missing": [(d) => { delete d.permissions; }, /R8 top-level/],
  "R8-job-pr-write": [(d) => { d.jobs["app-ci"].permissions = { "pull-requests": "write" }; }, /'app-ci'.*R8/],
  "R9-no-changes-need": [(d) => { d.jobs["app-ci"].needs = []; delete d.jobs["app-ci"].if; }, /'app-ci'.*R9 'needs'/, GATED_SPEC],
  "R9-no-if": [(d) => { delete d.jobs["app-ci"].if; }, /'app-ci'.*R9 must carry/, GATED_SPEC],
  "R9-non-fc-if": [(d) => { d.jobs["app-coverage"].if = "always() && needs.app-test.result == 'success'"; }, /'app-coverage'.*R9 must carry/, GATED_SPEC],
  "R10-changes-missing": [(d) => { delete d.jobs.changes; }, /R10 'changes' job is missing/],
  "R10-guard-missing": [(d) => { d.jobs.changes.steps = d.jobs.changes.steps.filter((s) => s.id !== "size"); }, /'changes'.*R10 .*'size'/],
  "R10-guard-env-wrong": [(d) => { d.jobs.changes.steps[0].env = { CHANGED_FILES: "30000" }; }, /'changes'.*R10 'size' step 'env'/],
  "R10-guard-if": [(d) => { d.jobs.changes.steps[0].if = "always()"; }, /'changes'.*R10 'size' step must have no 'if'/],
  "R10-guard-run-expression": [(d) => { d.jobs.changes.steps[0].run = "echo ${{ github.actor }}"; }, /'changes'.*R10 'size' step 'run'/],
  "R10-filter-no-if": [(d) => { delete d.jobs.changes.steps[1].if; }, /'changes'.*R10 'filter' step 'if'/],
  "R10-filter-missing": [(d) => { d.jobs.changes.steps = d.jobs.changes.steps.filter((s) => s.id !== "filter"); }, /'changes'.*R10 .*'filter'/],
  "R10-output-no-fallback": [(d) => { d.jobs.changes.outputs.app = "${{ steps.filter.outputs.app }}"; }, /'changes'.*R10 output 'app'/],
  "R10-output-wrong-key": [(d) => { d.jobs.changes.outputs.app = "${{ steps.filter.outputs.ci || 'true' }}"; }, /'changes'.*R10 output 'app'/],
  "R11-actor-step-if": [(d) => { d.jobs["app-ci"].steps[0].if = "github.actor != 'x'"; }, /'app-ci'.*R11/],
};

describe("findWorkflowViolations — red cells, one per clause", () => {
  for (const [id, [mutate, re, spec]] of Object.entries(RED)) {
    it(`${id}: reports a violation`, () => {
      const found = violationsOf(mutate, spec);
      expect(found.length).toBeGreaterThan(0);
      expect(found.some((v) => re.test(v))).toBe(true);
    });
  }

  it("YAML parse error is a violation", () => {
    const found = findWorkflowViolations("jobs: [unclosed", "wf.yml", CI_SPEC);
    expect(found.join("\n")).toMatch(/YAML parse error/);
  });
});

describe("findAggregateStepDivergence", () => {
  const specs = SPECS;
  const pair = (mutateB) => {
    const a = baseDoc();
    a.jobs["integration-result"] = a.jobs["ci-result"];
    const b = baseDoc();
    mutateB(b);
    return {
      "ci.yml": dump(a),
      "ci-integration.yml": dump({
        ...b,
        jobs: { ...b.jobs, "integration-result": b.jobs["ci-result"] },
      }),
    };
  };

  it("allows identical aggregate and size steps", () => {
    expect(findAggregateStepDivergence(pair(() => {}), specs)).toEqual([]);
  });
  it("DIV-aggregate: flags a differing aggregate step", () => {
    const contents = pair((b) => { b.jobs["ci-result"].steps[0].run += "\n# x\n"; });
    expect(findAggregateStepDivergence(contents, specs).join("\n")).toMatch(/aggregate step differs/);
  });
  it("DIV-size: flags a differing size step", () => {
    const contents = pair((b) => { b.jobs.changes.steps[0].run += "\n# x\n"; });
    expect(findAggregateStepDivergence(contents, specs).join("\n")).toMatch(/'size' guard step differs/);
  });
});

describe("findRequiredNameCollisions", () => {
  const wf = (jobs) => dump({ on: { pull_request: null }, jobs });
  const required = ["CI result"];
  const withBase = (extra) => ({
    "ci.yml": wf({ "ci-result": { name: "CI result", steps: [] } }),
    ...extra,
  });

  it("allows a single holder", () => {
    expect(findRequiredNameCollisions(withBase({}), required)).toEqual([]);
  });
  it("allows 'App: Test (${{ matrix.shard }}/3)'", () => {
    const contents = withBase({ "x.yml": wf({ t: { name: "App: Test (${{ matrix.shard }}/3)", steps: [] } }) });
    expect(findRequiredNameCollisions(contents, required)).toEqual([]);
  });
  it("allows 'CI.result ${{ matrix.n }}' (literal parts are regex-escaped)", () => {
    const contents = withBase({ "x.yml": wf({ t: { name: "CI.result ${{ matrix.n }}", steps: [] } }) });
    expect(findRequiredNameCollisions(contents, required)).toEqual([]);
  });
  it("does not throw on an unbalanced '(' before an expression", () => {
    const contents = withBase({ "x.yml": wf({ t: { name: "Run ( ${{ matrix.n }}", steps: [] } }) });
    expect(() => findRequiredNameCollisions(contents, required)).not.toThrow();
  });
  it("COL-third-workflow: flags a third workflow reusing the name", () => {
    const contents = withBase({ "x.yml": wf({ other: { name: "CI result", steps: [] } }) });
    expect(findRequiredNameCollisions(contents, required).join("\n")).toMatch(/'CI result'.*found 2/);
  });
  it("COL-job-id: flags a job whose id equals the name and has no name", () => {
    const contents = withBase({ "x.yml": wf({ "CI result": { steps: [] } }) });
    expect(findRequiredNameCollisions(contents, required).join("\n")).toMatch(/found 2/);
  });
  it("COL-expression: flags a 'name: ${{ matrix.n }}' job", () => {
    const contents = withBase({ "x.yml": wf({ t: { name: "${{ matrix.n }}", steps: [] } }) });
    expect(findRequiredNameCollisions(contents, required).join("\n")).toMatch(/x\.yml job 't'/);
  });
  it("COL-absent: flags a required name no job carries", () => {
    expect(findRequiredNameCollisions({ "x.yml": wf({ t: { steps: [] } }) }, required).join("\n")).toMatch(/found 0/);
  });
});

describe("checkRepository", () => {
  const real = () =>
    checkRepository({ workflowsDir: WORKFLOWS_DIR, specs: SPECS });

  it("passes on the real repository", () => {
    expect(real()).toEqual([]);
  });

  it("FAIL-LOUD-missing-file: a mapped file absent from the listing is a violation", () => {
    const found = checkRepository({
      workflowsDir: "w",
      specs: SPECS,
      listFiles: () => ["ci.yml"],
      readFile: () => realText("ci.yml"),
    });
    expect(found.join("\n")).toMatch(/ci-integration\.yml: mapped workflow is missing/);
  });

  it("FAIL-LOUD-parse-error: an unparsable mapped file is a violation", () => {
    const found = checkRepository({
      workflowsDir: "w",
      specs: { "ci.yml": CI_SPEC },
      listFiles: () => ["ci.yml"],
      readFile: () => "jobs: [unclosed",
    });
    expect(found.join("\n")).toMatch(/YAML parse error/);
  });

  it("scans .yaml files too (collision in a third workflow)", () => {
    const found = checkRepository({
      workflowsDir: "w",
      specs: { "ci.yml": CI_SPEC },
      listFiles: () => ["ci.yml", "x.yaml"],
      readFile: (p) =>
        p.endsWith("x.yaml")
          ? dump({ jobs: { other: { name: "CI result" } } })
          : build(),
    });
    expect(found.join("\n")).toMatch(/'CI result'.*found 2/);
  });
});

// --- Executed steps ----------------------------------------------------------

const tmpDirs = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop(), { recursive: true, force: true });
});
function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "required-aggregate-"));
  tmpDirs.push(dir);
  return dir;
}

/** Runs step text the way GitHub runs a step with no `shell` key: bash -e <file>. */
function runStep(run, env) {
  const dir = tmp();
  const file = join(dir, "step.sh");
  writeFileSync(file, run);
  const outputFile = join(dir, "output");
  writeFileSync(outputFile, "");
  const res = spawnSync("bash", ["-e", file], {
    env: { ...process.env, GITHUB_OUTPUT: outputFile, ...env },
    encoding: "utf8",
  });
  return { status: res.status, text: `${res.stdout}${res.stderr}`, output: readFileSync(outputFile, "utf8") };
}

const entry = (result) => ({ result, outputs: {} });
const needsJson = (obj) => JSON.stringify(obj);

const AGG_CASES = [
  ["all success", needsJson({ a: entry("success"), b: entry("success") }), 0, /succeeded or was skipped/],
  ["success and skipped", needsJson({ a: entry("success"), b: entry("skipped") }), 0, /succeeded or was skipped/],
  ["all skipped", needsJson({ a: entry("skipped"), b: entry("skipped") }), 0, /succeeded or was skipped/],
  ["a failure", needsJson({ a: entry("success"), b: entry("failure") }), 1, /a job failed/],
  ["a cancelled", needsJson({ a: entry("success"), b: entry("cancelled") }), 1, /a job failed/],
  ["an unknown result string", needsJson({ a: entry("success"), b: entry("neutral") }), 1, /a job failed/],
  ["an entry without result", needsJson({ a: entry("success"), b: { outputs: {} } }), 1, /a job failed/],
  ["result null", needsJson({ a: entry("success"), b: { result: null, outputs: {} } }), 1, /a job failed/],
  ["empty object", "{}", 1, /empty or not a JSON object/],
  ["non-JSON", "not json", 1, /empty or not a JSON object/],
  ["empty string", "", 1, /empty or not a JSON object/],
  ["a non-object entry value", needsJson({ a: "success" }), 1, /needs could not be read/],
];

describe("aggregate step, executed (both real workflows)", () => {
  it("sentinel: jq is installed (a missing jq must fail, not skip)", () => {
    expect(spawnSync("jq", ["--version"]).status).toBe(0);
  });

  for (const [file, { aggregateId }] of Object.entries(SPECS)) {
    const run = realDoc(file).jobs[aggregateId].steps[0].run;
    for (const [label, needs, status, marker] of AGG_CASES) {
      it(`${file}: ${label} -> exit ${status}`, () => {
        const res = runStep(run, { NEEDS: needs });
        expect(res.status).toBe(status);
        expect(res.text).toMatch(marker);
      });
    }
  }
});

describe("size guard step, executed (both real workflows)", () => {
  const GUARD_CASES = [
    ["0", "true"],
    ["2999", "true"],
    ["3000", "false"],
    ["3001", "false"],
    ["", "false"],
    ["abc", "false"],
    ["9999999999", "false"],
  ];
  for (const file of Object.keys(SPECS)) {
    const run = realDoc(file).jobs.changes.steps.find((s) => s.id === "size").run;
    for (const [changed, small] of GUARD_CASES) {
      it(`${file}: CHANGED_FILES='${changed}' writes small=${small}`, () => {
        const res = runStep(run, { CHANGED_FILES: changed });
        expect(res.status).toBe(0);
        expect(res.output.split("\n")).toContain(`small=${small}`);
      });
    }
  }
});

describe("paths-filter patterns", () => {
  // A typo net only: it does not prove picomatch here matches what
  // dorny/paths-filter's bundled matcher matches, just that no pattern is dead.
  const tracked = spawnSync("git", ["ls-files"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .stdout.split("\n")
    .filter(Boolean);

  for (const file of Object.keys(SPECS)) {
    const filters = load(
      realDoc(file).jobs.changes.steps.find((s) => s.id === "filter").with.filters,
    );
    for (const [key, patterns] of Object.entries(filters)) {
      for (const pattern of patterns) {
        it(`${file}: filter '${key}' pattern ${pattern} matches a tracked file`, () => {
          const isMatch = picomatch(pattern, { dot: true });
          expect(tracked.some((p) => isMatch(p))).toBe(true);
        });
      }
    }
  }
});
