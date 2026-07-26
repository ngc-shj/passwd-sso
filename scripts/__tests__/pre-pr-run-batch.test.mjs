/**
 * Self-test for scripts/pre-pr.sh's bounded-parallel scheduler
 * (queue_step / run_batch / resolve_jobs).
 *
 * Why this file exists: every gate under scripts/checks/ carries a self-test
 * because a gate with a broken parse path can silently green forever. The
 * harness that RUNS all ~40 of those gates had none, and
 * check-gate-selftest-coverage.sh cannot ask for one — its member set is
 * `scripts/checks/*.{sh,mjs}`, and pre-pr.sh is the harness, never a member.
 * The scheduler carries several fail-open shapes (below), so it gets one here.
 *
 * Each case below pins a failure mode that was observed, not imagined:
 *   - counters incremented inside a backgrounded job are discarded, so a run
 *     that failed reports "Passed: 0 / Failed: 0"
 *   - `wait -n`'s status does not identify which job it reaped, so capturing it
 *     per dispatch index mis-attributes verdicts (measured 7 0 0 vs a truth of
 *     0 0 7 — a failing gate reported as passing)
 *   - a bare `wait "$pid"` under pre-pr.sh's `set -e` aborts on the first
 *     failure, leaving later gates unjoined and the Results block unprinted
 *   - exit 127 is a real step status (command not found), never "no such job"
 *
 * The scheduler is spliced out of pre-pr.sh verbatim and driven with fixture
 * steps rather than the real gate list — spawning the real pre-pr.sh from here
 * would recursively invoke vitest (same constraint pre-pr-env-drift.test.mjs
 * documents). Splicing means the code under test IS the production code: a
 * re-implementation here would drift and prove nothing.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const PRE_PR = join(REPO_ROOT, "scripts/pre-pr.sh");

const SCHED_START = "batch_labels=()";
const SCHED_END = '\nprintf "${BOLD}═══ Pre-PR Checks';

let scheduler;

beforeAll(() => {
  const src = readFileSync(PRE_PR, "utf8");
  const start = src.indexOf(SCHED_START);
  const end = src.indexOf(SCHED_END);
  // Fail loudly rather than silently testing an empty string if pre-pr.sh is
  // restructured — a vacuous pass here would be worse than a red test.
  expect(start, "scheduler block not found in pre-pr.sh").toBeGreaterThan(-1);
  expect(end, "scheduler end anchor not found in pre-pr.sh").toBeGreaterThan(start);
  scheduler = src.slice(start, end);
  expect(scheduler).toContain("run_batch()");
  expect(scheduler).toContain("queue_step()");
});

/** Build a harness around the real scheduler with the given fixture steps. */
function harness(body) {
  return [
    "#!/usr/bin/env bash",
    // Same options as pre-pr.sh — `set -e` is what makes the join shape
    // load-bearing, so the harness must not relax it.
    "set -euo pipefail",
    "RED=''; GREEN=''; BOLD=''; RESET=''",
    "passed=0; failed=0; failures=(); tempfiles=()",
    scheduler,
    body,
    'echo "RESULT passed=$passed failed=$failed"',
    'printf \'FAILORDER %s\\n\' "$(for f in "${failures[@]-}"; do printf \'%s;\' "${f%%|*}"; done)"',
  ].join("\n");
}

function run(body, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pre-pr-batch-"));
  const script = join(dir, "harness.sh");
  writeFileSync(script, harness(body), "utf8");
  try {
    const r = spawnSync("bash", [script], {
      encoding: "utf8",
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      timeout: 60_000,
    });
    const stdout = r.stdout ?? "";
    return {
      stdout,
      exitCode: r.status,
      passed: Number(/RESULT passed=(\d+)/.exec(stdout)?.[1] ?? -1),
      failed: Number(/RESULT passed=\d+ failed=(\d+)/.exec(stdout)?.[1] ?? -1),
      failOrder: (/FAILORDER (.*)/.exec(stdout)?.[1] ?? "")
        .split(";")
        .filter(Boolean),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("pre-pr.sh bounded-parallel scheduler", () => {
  it("counts passes and failures in the parent shell (backgrounded increments are lost)", () => {
    const r = run(
      [
        'queue_step "a" bash -c "exit 0"',
        'queue_step "b" bash -c "exit 1"',
        'queue_step "c" bash -c "exit 0"',
        "run_batch",
      ].join("\n"),
    );
    // The whole point: a scheduler that increments inside the job reports 0/0.
    expect(r.passed).toBe(2);
    expect(r.failed).toBe(1);
  });

  it("attributes each exit status to its own step when completion order differs from declaration order", () => {
    // The shape that breaks `wait -n` status capture: the FAILING step is
    // declared last but finishes FIRST, so a scheduler that assigns the reaped
    // status to the dispatch index blames a passing step instead.
    const r = run(
      [
        'queue_step "slow-ok-1" bash -c "sleep 0.4; exit 0"',
        'queue_step "slow-ok-2" bash -c "sleep 0.4; exit 0"',
        'queue_step "fast-fail" bash -c "exit 7"',
        "run_batch",
      ].join("\n"),
      { PRE_PR_JOBS: "3" },
    );
    expect(r.failed).toBe(1);
    expect(r.failOrder).toEqual(["fast-fail"]);
  });

  it("reports every step and renders results when a step fails mid-run (no set -e truncation)", () => {
    const r = run(
      [
        'queue_step "s0" bash -c "exit 0"',
        'queue_step "s1" bash -c "exit 3"',
        'queue_step "s2" bash -c "exit 0"',
        'queue_step "s3" bash -c "exit 0"',
        "run_batch",
      ].join("\n"),
    );
    // A bare `wait "$pid"` under set -e dies at s1, so s2/s3 never report.
    expect(r.passed).toBe(3);
    expect(r.failed).toBe(1);
    for (const label of ["s0", "s1", "s2", "s3"]) {
      expect(r.stdout).toContain(label);
    }
  });

  it("lists failures in declaration order, not completion order", () => {
    const r = run(
      [
        'queue_step "f-early" bash -c "sleep 0.3; exit 3"',
        'queue_step "ok" bash -c "exit 0"',
        'queue_step "f-late" bash -c "exit 5"',
        "run_batch",
      ].join("\n"),
      { PRE_PR_JOBS: "3" },
    );
    // f-late finishes first; declaration order must still win.
    expect(r.failOrder).toEqual(["f-early", "f-late"]);
  });

  it("reports a step whose command does not exist as failed (127 is a status, not a bookkeeping artifact)", () => {
    const r = run(
      [
        'queue_step "missing" definitely-not-a-real-binary-xyz',
        'queue_step "ok" bash -c "exit 0"',
        "run_batch",
      ].join("\n"),
    );
    expect(r.failed).toBe(1);
    expect(r.failOrder).toEqual(["missing"]);
  });

  it("preserves a failing step's full output including its last line", () => {
    const r = run(
      [
        'queue_step "big" bash -c \'head -c 200000 /dev/zero | tr "\\0" "x"; echo; echo LASTLINE_MARKER; exit 9\'',
        "run_batch",
      ].join("\n"),
    );
    expect(r.failed).toBe(1);
    expect(r.stdout).toContain("LASTLINE_MARKER");
  });

  it("prints passing steps' stdout too (several gates emit CI-auditable config on success)", () => {
    const r = run(
      [
        'queue_step "chatty" bash -c \'echo GREEN_PATH_OUTPUT; exit 0\'',
        "run_batch",
      ].join("\n"),
    );
    expect(r.passed).toBe(1);
    expect(r.stdout).toContain("GREEN_PATH_OUTPUT");
  });

  it("produces identical results serially and in parallel", () => {
    const body = [
      'queue_step "a" bash -c "sleep 0.2; exit 0"',
      'queue_step "b" bash -c "exit 4"',
      'queue_step "c" bash -c "sleep 0.1; exit 0"',
      'queue_step "d" bash -c "exit 6"',
      "run_batch",
    ].join("\n");
    const serial = run(body, { PRE_PR_JOBS: "1" });
    const parallel = run(body, { PRE_PR_JOBS: "4" });
    expect(serial.passed).toBe(parallel.passed);
    expect(serial.failed).toBe(parallel.failed);
    expect(serial.failOrder).toEqual(parallel.failOrder);
  });

  it.each([
    ["0", "zero"],
    ["-1", "negative"],
    ["abc", "non-numeric"],
    ["99999", "above the cap"],
  ])("clamps PRE_PR_JOBS=%s (%s) instead of hanging or forking unbounded", (value) => {
    const r = run(
      [
        'queue_step "a" bash -c "exit 0"',
        'queue_step "b" bash -c "exit 1"',
        "run_batch",
      ].join("\n"),
      { PRE_PR_JOBS: value },
    );
    expect(r.passed).toBe(1);
    expect(r.failed).toBe(1);
  });

  it("actually runs steps concurrently, bounded by PRE_PR_JOBS", () => {
    // RT4 guard: every other assertion here passes whether or not concurrency
    // happened. This one fails if the dispatcher degenerates to serial AND if
    // it oversubscribes past the cap.
    const dir = mkdtempSync(join(tmpdir(), "pre-pr-overlap-"));
    const events = join(dir, "events.txt");
    try {
      const body = [
        `: > ${events}`,
        "for i in 1 2 3 4 5 6; do",
        `  queue_step "j$i" bash -c 'echo S $(date +%s%N) >> ${events}; sleep 0.3; echo E $(date +%s%N) >> ${events}'`,
        "done",
        "run_batch >/dev/null 2>&1",
      ].join("\n");

      const peak = (jobs) => {
        run(body, { PRE_PR_JOBS: String(jobs) });
        const rows = readFileSync(events, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => l.split(/\s+/))
          .sort((a, b) => Number(a[1]) - Number(b[1]));
        let cur = 0;
        let max = 0;
        for (const [kind] of rows) {
          if (kind === "S") max = Math.max(max, ++cur);
          else cur--;
        }
        return max;
      };

      expect(peak(1)).toBe(1);
      const p3 = peak(3);
      expect(p3).toBeGreaterThanOrEqual(2);
      expect(p3).toBeLessThanOrEqual(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
