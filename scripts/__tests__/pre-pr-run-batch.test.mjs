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
let prePrSource;

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

  // The splice covers the scheduler's DEFINITIONS. Its CALL SITES live far
  // below SCHED_END, so nothing above notices if they disappear — and that is
  // the worst regression available here: with both `run_batch` invocations
  // removed, every test below still passes while pre-pr.sh silently drops from
  // 51 executed checks to 13. Assert the wiring against the full source.
  // Deliberately NOT an exact count: the number of batches is a scheduling
  // decision that changes whenever steps are regrouped, and pinning it makes
  // this assertion fire on every legitimate restructure while adding nothing —
  // the positional check below is what actually catches an unrun queue.
  const runBatchCalls = src.match(/^\s*run_batch\s*$/gm) ?? [];
  expect(
    runBatchCalls.length,
    "pre-pr.sh must invoke run_batch — without it every queued step is a silently skipped gate",
  ).toBeGreaterThan(0);
  const queueCalls = src.match(/^\s*queue_step "/gm) ?? [];
  expect(
    queueCalls.length,
    "expected the static-check blocks to still be queued",
  ).toBeGreaterThan(30);

  // Counting alone is not enough: a queue_step appended AFTER the final
  // run_batch keeps both counts valid while that gate never executes. Check
  // position, not just quantity — every queue_step must be followed by some
  // later run_batch.
  const lines = src.split("\n");
  const lastRunBatch = lines.reduce(
    (acc, line, idx) => (/^\s*run_batch\s*$/.test(line) ? idx : acc),
    -1,
  );
  const orphans = lines
    .map((line, idx) => ({ line, idx }))
    .filter(({ line, idx }) => /^\s*queue_step "/.test(line) && idx > lastRunBatch)
    .map(({ line, idx }) => `${idx + 1}: ${line.trim()}`);
  expect(
    orphans,
    "queue_step after the final run_batch — these gates are queued but never executed",
  ).toEqual([]);

  // SCHED_START is matched with indexOf, so an earlier occurrence of the same
  // literal would relocate the region while both toContain checks still pass.
  // It appears exactly twice: the declaration, and run_batch's reset.
  const startOccurrences = src.split(SCHED_START).length - 1;
  expect(
    startOccurrences,
    `"${SCHED_START}" must occur exactly twice (declaration + run_batch reset); a third would relocate the splice`,
  ).toBe(2);

  // The join shape is only load-bearing under `set -e`; the harness re-declares
  // it, so pin that pre-pr.sh still sets it rather than letting the two drift.
  expect(src, "pre-pr.sh must keep set -euo pipefail").toMatch(/^set -euo pipefail$/m);

  prePrSource = src;
});

describe("heavy-step wiring", () => {
  /** Line index of the first `queue_step "<label>"`, or -1. */
  const queueLine = (label) =>
    prePrSource
      .split("\n")
      .findIndex((l) => new RegExp(`^\\s*queue_step "${label}"`).test(l));

  /** Line index of the first run_batch strictly after `from`. */
  const batchAfter = (from) =>
    prePrSource
      .split("\n")
      .findIndex((l, i) => i > from && /^\s*run_batch\s*$/.test(l));

  // Each pair is an ordering constraint: `after` must observe `before`'s output.
  it.each([
    ["CLI: Build", "CLI: Test", "cli/dist must exist before its tests run"],
    ["Extension: Test", "Extension: Build", "CI runs Extension test before build"],
    ["Build", "Typecheck", "tsc reads .next/types/**, which next build writes"],
  ])("runs %s in an earlier batch than %s", (before, after, why) => {
    const beforeLine = queueLine(before);
    const afterLine = queueLine(after);
    expect(beforeLine, `queue_step "${before}" not found`).toBeGreaterThan(-1);
    expect(afterLine, `queue_step "${after}" not found`).toBeGreaterThan(-1);

    // A run_batch must separate them, or they dispatch concurrently and the
    // ordering constraint is silently lost.
    const separator = batchAfter(beforeLine);
    expect(separator, `no run_batch between "${before}" and "${after}" — ${why}`)
      .toBeGreaterThan(-1);
    expect(
      afterLine,
      `"${after}" must be queued after the run_batch that follows "${before}" — ${why}`,
    ).toBeGreaterThan(separator);
  });

  it("does not chain two commands in one step with && (a failing first half would skip the second)", () => {
    // `queue_step "X" bash -c 'a && b'` expresses ordering by chaining, which
    // drops b whenever a fails — the truncated-gate-run class. Ordering belongs
    // in the batch staging above.
    //
    // A single leading `cd <dir> && <cmd>` is NOT that: `cd` is directory
    // setup, not a gate whose failure should still let the next gate report.
    // So flag a step only when a SECOND `&&` chains two real commands.
    const chained = prePrSource
      .split("\n")
      .filter((line) => {
        if (!/^\s*queue_step "/.test(line)) return false;
        const body = line.replace(/^\s*queue_step\s+"[^"]*"\s*/, "");
        const withoutCd = body.replace(/\bcd\s+[^&]+&&/, "");
        return withoutCd.includes("&&");
      })
      .map((line) => line.trim());
    expect(
      chained,
      "heavy steps must be staged across batches, not chained with &&",
    ).toEqual([]);
  });
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
  ])("still produces correct counts with PRE_PR_JOBS=%s (%s)", (value) => {
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

  // The cases above assert only that the run survives; they pass even with
  // resolve_jobs' clamp deleted outright, because the throttle's
  // `wait -n || true` absorbs a nonsense job count. Assert the clamp's RETURN
  // VALUE so the untrusted-input handling is actually pinned.
  it("clamps PRE_PR_JOBS to [1, min(nproc,8)] rather than trusting it", () => {
    const cap = Math.min(
      Number(spawnSync("nproc", { encoding: "utf8" }).stdout?.trim() || 4),
      8,
    );
    const probe = (value) => {
      const r = run('resolve_jobs; echo ""', { PRE_PR_JOBS: value });
      return Number(/^(\d+)/m.exec(r.stdout.trim())?.[1] ?? NaN);
    };
    // Nonsense values must not reach the dispatch loop: 0 would make the slot
    // check `active >= 0` block immediately, and a huge value would fork
    // unbounded. Every result must land inside [1, cap].
    //
    // "-1" is deliberately grouped with the malformed inputs rather than
    // clamped to 1: the `-` makes it non-numeric to the `*[!0-9]*` pattern, so
    // it takes the fallback branch. Both outcomes are safe; this pins which one
    // actually happens so the branch cannot change unnoticed.
    expect(probe("0")).toBe(1);
    expect(probe("-1")).toBe(cap);
    expect(probe("abc")).toBe(cap);
    expect(probe("")).toBe(cap);
    expect(probe("99999")).toBe(cap);
    expect(probe("2")).toBe(Math.min(2, cap));
    for (const v of ["0", "-1", "abc", "", "99999", "2", "1"]) {
      const got = probe(v);
      expect(got, `PRE_PR_JOBS=${v} escaped the clamp`).toBeGreaterThanOrEqual(1);
      expect(got, `PRE_PR_JOBS=${v} escaped the clamp`).toBeLessThanOrEqual(cap);
    }
  });

  it("bounds actual concurrency even when PRE_PR_JOBS asks for far more", () => {
    // The clamp is only meaningful if it reaches the dispatcher: prove a huge
    // request does not fork one process per step.
    const dir = mkdtempSync(join(tmpdir(), "pre-pr-cap-"));
    const events = join(dir, "events.txt");
    try {
      run(
        [
          `: > ${events}`,
          "for i in 1 2 3 4 5 6 7 8 9 10 11 12; do",
          `  queue_step "j$i" bash -c 'echo S >> ${events}; sleep 0.2; echo E >> ${events}'`,
          "done",
          "run_batch >/dev/null 2>&1",
        ].join("\n"),
        { PRE_PR_JOBS: "99999" },
      );
      let cur = 0;
      let max = 0;
      for (const line of readFileSync(events, "utf8").trim().split("\n")) {
        if (line === "S") max = Math.max(max, ++cur);
        else cur--;
      }
      expect(max).toBeLessThanOrEqual(8);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips argv containing spaces, quotes and shell metacharacters", () => {
    // queue_step stores argv via printf %q and run_batch replays it through
    // `bash -c`. Without %q an argument with a space would split into two, and
    // a `$` or `;` would be interpreted at replay time.
    const r = run(
      [
        `queue_step "spaced" bash -c 'echo "a b  c"; exit 0'`,
        `queue_step "metachar" bash -c 'echo "lit: \\$HOME ; rm -rf /"; exit 0'`,
        "run_batch",
      ].join("\n"),
    );
    expect(r.passed).toBe(2);
    expect(r.failed).toBe(0);
    expect(r.stdout).toContain("a b  c");
    // The literal must survive un-expanded and un-executed.
    expect(r.stdout).toContain("lit: $HOME ; rm -rf /");
  });

  it("still bounds concurrency on a shell without `wait -n` (bash 3.2)", () => {
    // `wait -n` is bash 4.3+. On macOS's system bash 3.2 it fails immediately,
    // and a swallowed error would free a slot with nothing having finished —
    // turning the throttle into a no-op (measured 6 concurrent against a cap
    // of 2 before the fallback existed, with PRE_PR_JOBS=1 not serializing).
    // Force the fallback branch and prove it still bounds.
    const forced = scheduler.replace(
      "if ((BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 3))); then",
      "if false; then",
    );
    expect(forced, "version-guard anchor missing — fallback no longer reachable").not.toBe(
      scheduler,
    );

    const dir = mkdtempSync(join(tmpdir(), "pre-pr-b32-"));
    const events = join(dir, "events.txt");
    const script = join(dir, "h.sh");
    try {
      writeFileSync(
        script,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          "RED=''; GREEN=''; BOLD=''; RESET=''",
          "passed=0; failed=0; failures=(); tempfiles=()",
          forced,
          `: > ${events}`,
          "for i in 1 2 3 4 5 6 7 8; do",
          `  queue_step "j$i" bash -c 'echo S >> ${events}; sleep 0.25; echo E >> ${events}'`,
          "done",
          "run_batch >/dev/null 2>&1",
          'echo "RESULT passed=$passed failed=$failed"',
        ].join("\n"),
        "utf8",
      );
      const r = spawnSync("bash", [script], {
        encoding: "utf8",
        cwd: REPO_ROOT,
        env: { ...process.env, PRE_PR_JOBS: "2" },
        timeout: 60_000,
      });
      let cur = 0;
      let max = 0;
      for (const line of readFileSync(events, "utf8").trim().split("\n")) {
        if (line === "S") max = Math.max(max, ++cur);
        else cur--;
      }
      expect(max, "fallback throttle did not bound concurrency").toBeLessThanOrEqual(2);
      // and it must still run every step and report correctly
      expect(r.stdout).toContain("RESULT passed=8 failed=0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
