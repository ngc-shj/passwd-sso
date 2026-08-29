/**
 * Self-test for scripts/pre-pr.sh's failure-reporting path
 * (cleanup_tempfiles / show_failure_context).
 *
 * Sibling to pre-pr-run-batch.test.mjs, and it exists for the same structural
 * reason: check-gate-selftest-coverage.sh cannot ask for this file. Its member
 * sets are `scripts/checks/*.{sh,mjs}` and the inline `run_step "Static:…"`
 * gates; pre-pr.sh's own helper functions are in neither, so a change to them
 * carries no coverage obligation and nothing reds when one is reverted.
 *
 * pre-pr-run-batch.test.mjs does not cover them either — it splices from
 * `batch_labels=()` downward, and both functions are defined ABOVE that anchor.
 *
 * Each case pins a failure mode that was observed, not imagined:
 *   - the EXIT trap deleted a FAILED step's log, destroying the only copy of a
 *     shuffled run's seed; "could not reproduce" then reads as "probably fine"
 *   - the seed line sits near the TOP of a vitest log while every context
 *     window is anchored at `Failed Tests`, so no window can reach it
 *   - `first_line=$(head -1 | cut -d: -f1) <<<"$matches"` redirected the
 *     ASSIGNMENT, leaving `head -1` on the script's own stdin: a hang on a
 *     terminal, and an empty value under CI that anchors the window at line 1
 *   - a non-zero `rm` is the last command of an `||` list, so `set -e` fires
 *     and an all-green run exits 1 after printing its success banner
 *
 * The functions are spliced out of pre-pr.sh verbatim rather than
 * re-implemented, so the code under test IS the production code. Every spawn
 * carries a timeout: the here-string defect's symptom is a HANG, and a suite
 * that hangs reports nothing at all.
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

let source;
let cleanupFn;
let contextFn;

/** Splice one `name() { … }` block, refusing rather than returning nothing. */
function splice(name) {
  const start = source.indexOf(`${name}() {`);
  // "Could not find it" must not be spelled like "it was empty". A silent
  // miss here would make every case below pass against no code at all.
  expect(start, `${name}() not found in pre-pr.sh — splice anchor moved`).toBeGreaterThan(-1);
  const end = source.indexOf("\n}\n", start);
  expect(end, `${name}() has no closing brace at column 0`).toBeGreaterThan(start);
  return source.slice(start, end + 3);
}

beforeAll(() => {
  source = readFileSync(PRE_PR, "utf8");
  cleanupFn = splice("cleanup_tempfiles");
  contextFn = splice("show_failure_context");
});

/**
 * Run a body against the spliced functions in a contained TMPDIR.
 *
 * `CI` is cleared unless a case sets it: the harness inherits the environment,
 * and under a CI runner the retention notice is suppressed by design — leaving
 * it inherited would make that assertion pass or fail depending on where the
 * suite ran.
 */
function run(body, { env = {}, stdin = "ignore" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pre-pr-fctx-"));
  const script = join(dir, "harness.sh");
  writeFileSync(
    script,
    [
      "set -euo pipefail",
      "RED=; GREEN=; BOLD=; RESET=",
      "passed=0; failed=0; failures=(); tempfiles=()",
      cleanupFn,
      contextFn,
      body,
    ].join("\n"),
    "utf8",
  );
  try {
    const r = spawnSync("bash", [script], {
      encoding: "utf8",
      cwd: dir,
      env: { ...process.env, CI: "", ...env, TMPDIR: dir },
      stdio: ["pipe", "pipe", "pipe"],
      input: stdin === "ignore" ? "" : stdin,
      // The here-string defect hangs. Without a bound the suite would hang with
      // it and report nothing — the failure must arrive as a timeout, named.
      timeout: 30_000,
    });
    return {
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      exitCode: r.status,
      timedOut: r.signal === "SIGTERM" || r.error?.code === "ETIMEDOUT",
      dir,
    };
  } finally {
    // Two cases below deliberately make a directory NON-WRITABLE to force `rm`
    // to fail — which then defeats teardown itself, leaving the fixture behind
    // (RT11: cleanup must survive the failure path it created). Restore the
    // write bit across the tree before reclaiming it.
    spawnSync("chmod", ["-R", "u+rwX", dir], { timeout: 10_000 });
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Writes three logs, marks two of them failed, then trips the EXIT trap. */
const RETENTION_BODY = `
trap cleanup_tempfiles EXIT
mk() {
  local f; f=$(mktemp -t "pre-pr.XXXXXX")
  printf '%s\\n' "$2" > "$f"
  tempfiles+=("$f")
  [ "$1" = fail ] && failures+=("$3|$f")
  printf '%s %s\\n' "$1" "$f" >> "$TMPDIR/manifest"
  return 0
}
mk fail 'Running tests with seed "424242"
Failed Tests 1
AssertionError: boom' SERIAL-fail
mk pass 'all good' -
mk fail 'Running tests with seed "999999"
AssertionError: par' PAR-fail
`;

describe("cleanup_tempfiles — retention", () => {
  it("keeps a FAILED step's log and deletes a PASSING step's", () => {
    // Both sides in one case on purpose: a remedy that only retains would
    // satisfy the deny clause by never deleting anything.
    const r = run(
      RETENTION_BODY + `
cleanup_tempfiles
while read -r kind f; do
  if [ -e "$f" ]; then echo "KEPT $kind"; else echo "GONE $kind"; fi
done < "$TMPDIR/manifest"
`,
    );
    expect(r.timedOut).toBe(false);
    const lines = r.stdout.trim().split("\n").filter(Boolean);
    expect(lines).toEqual(["KEPT fail", "GONE pass", "KEPT fail"]);
  });

  it("returns 0 when rm fails, so a green run does not exit 1", () => {
    // `|| rm` ends the OR list, so a non-zero rm IS the last command and set -e
    // fires — the function's `return 0` is never reached and the whole script
    // exits 1 having printed its success banner. Green→red only, but a pre-PR
    // gate that fails for a reason outside the gates is worse than useless.
    const r = run(`
trap cleanup_tempfiles EXIT
d=$(mktemp -d); f="$d/log"; : > "$f"; tempfiles+=("$f")
chmod a-w "$d"
echo "body done"
`);
    expect(r.timedOut).toBe(false);
    expect(r.stdout).toContain("body done");
    expect(r.exitCode).toBe(0);
    // "Could not clean up" must stay distinguishable from "cleaned up".
    expect(r.stderr).toMatch(/could not remove/);
  });

  it("still exits 1 when the body failed, even if rm also failed", () => {
    // The allow side of the clause above: suppressing rm's status must not
    // suppress a real failure.
    const r = run(`
trap cleanup_tempfiles EXIT
d=$(mktemp -d); f="$d/log"; : > "$f"; tempfiles+=("$f")
chmod a-w "$d"
exit 1
`);
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(1);
  });

  // BOTH entry points, because both push to `failures` and a mutation that
  // removes only the first guard would otherwise go unseen — measured: it did.
  it.each(["run_step", "queue_step"])(
    "%s rejects a step label containing the '|' delimiter",
    (fn) => {
      // `failures` entries are `label|logfile` and the match splits on the
      // FIRST `|`, so such a label mis-splits and the failed step's log is
      // DELETED — the one outcome retention exists to prevent.
      const r = run(
        [
          "batch_labels=(); batch_cmds=()",
          splice(fn),
          `${fn} "Static: a|b" true`,
          'echo "ACCEPTED"',
        ].join("\n"),
      );
      expect(r.exitCode).toBe(2);
      expect(r.stdout).not.toContain("ACCEPTED");
      expect(r.stderr).toMatch(/must not contain/);
    },
  );

  it.each(["run_step", "queue_step"])("%s accepts an ordinary label", (fn) => {
    const r = run(
      [
        "batch_labels=(); batch_cmds=()",
        splice(fn),
        `${fn} "Static: normal" true`,
        'echo "ACCEPTED"',
      ].join("\n"),
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("ACCEPTED");
  });
});

describe("show_failure_context — reproduction handles", () => {
  it("prints the shuffle seed for a vitest-shaped failure", () => {
    // extension/vitest.config.ts sets `sequence: { shuffle: true }` and names
    // `--sequence.seed=N` as the replay mechanism.
    //
    // The 200 filler lines are load-bearing, and were added after a mutation
    // run proved the case decorative without them: with the seed adjacent to
    // the markers, the context window ECHOES it, so deleting the dedicated grep
    // left the assertion green. The window is anchored at `Failed Tests` and
    // spans 60 lines, so a seed at line 1 of a 200-line log is reachable ONLY
    // by the dedicated grep — which is the real shape this exists for.
    const r = run(`
f=$(mktemp -t "pre-pr.XXXXXX")
{ echo 'Running tests with seed "424242"'
  for i in $(seq 1 200); do echo "filler-$i"; done
  echo 'Failed Tests 1'; echo 'AssertionError: boom'; } > "$f"
show_failure_context "Extension: Test" "$f"
`);
    expect(r.timedOut).toBe(false);
    expect(r.stdout).toContain('Running tests with seed "424242"');
    expect(r.stdout).toContain("(log retained:");
  });

  it("prints the seed for a marker-only failure too (no 'Failed Tests' line)", () => {
    // The non-vitest branch — lint, build, gate scripts. This is the branch the
    // here-string defect lived in, so it must be exercised separately.
    const r = run(`
f=$(mktemp -t "pre-pr.XXXXXX")
{ echo 'Running tests with seed "999999"'
  for i in $(seq 1 200); do echo "filler-$i"; done
  echo 'AssertionError: par'; } > "$f"
show_failure_context "Static: thing" "$f"
`);
    expect(r.timedOut).toBe(false);
    // Same reason as above: outside the window, so only the dedicated grep
    // can surface it.
    expect(r.stdout).toContain('Running tests with seed "999999"');
  });

  it("does not hang on the marker-only branch when stdin is an open pipe", () => {
    // The exact defect: with the here-string on the assignment, `head -1` read
    // the script's stdin. A live pipe made it block forever. Asserted as
    // not-timed-out rather than as an exit code, because a hang has none.
    const r = run(`
f=$(mktemp -t "pre-pr.XXXXXX")
printf '%s\\n' 'AssertionError: boom' 'Error: second' > "$f"
show_failure_context "Static: thing" "$f" < <(sleep 25)
echo "RETURNED"
`);
    expect(r.timedOut).toBe(false);
    expect(r.stdout).toContain("RETURNED");
  });

  it("anchors the marker-only window at the first marker, not at line 1", () => {
    // The silent half of the same defect: under CI, stdin is /dev/null, so
    // `head -1` returned empty and the arithmetic treated it as 0 — pointing
    // the window at the top of the log instead of at the failure. The filler
    // lines are what make the two anchors distinguishable.
    const r = run(`
f=$(mktemp -t "pre-pr.XXXXXX")
{ for i in $(seq 1 12); do echo "filler-$i"; done; echo 'AssertionError: boom'; } > "$f"
show_failure_context "Static: thing" "$f"
`);
    expect(r.timedOut).toBe(false);
    // Marker is at line 13, so the window starts at 8 — filler-1..7 must be
    // absent. Anchored at line 1 they would all be present.
    expect(r.stdout).toContain("filler-8");
    expect(r.stdout).not.toContain("filler-1\n");
  });

  it("keeps the vitest branch anchored at 'Failed Tests', not at the first marker", () => {
    // The allow side of the anchor clause: the here-string fix must not move
    // the branch that was already correct.
    const r = run(`
f=$(mktemp -t "pre-pr.XXXXXX")
{ echo 'AssertionError: early'; for i in $(seq 1 40); do echo "filler-$i"; done;
  echo 'Failed Tests 1'; echo 'AssertionError: real'; } > "$f"
show_failure_context "Test" "$f"
`);
    expect(r.timedOut).toBe(false);
    // Window starts 3 lines before `Failed Tests` (line 42) → filler-39 in,
    // filler-1 out. Anchoring at the first marker would include filler-1.
    expect(r.stdout).toContain("filler-39");
    expect(r.stdout).not.toContain("filler-1\n");
  });

  it("suppresses the retention notice under CI, where the path does not survive", () => {
    // CI runs PRE_PR_STATIC_ONLY=1 on an ephemeral runner: naming a file that
    // dies with the job is an instruction nobody can follow.
    const r = run(
      `
f=$(mktemp -t "pre-pr.XXXXXX")
printf '%s\\n' 'AssertionError: boom' > "$f"
show_failure_context "Static: thing" "$f"
`,
      { env: { CI: "true" } },
    );
    expect(r.timedOut).toBe(false);
    expect(r.stdout).not.toContain("(log retained:");
    // The seed/marker output itself must still be there — suppressing the
    // notice must not suppress the context.
    expect(r.stdout).toContain("AssertionError: boom");
  });

  it("returns 0 when the log holds no markers at all", () => {
    // Falls to the `tail -20` branch. `|| true` inside the brace group is what
    // keeps a no-match grep from killing the function under set -e + pipefail.
    const r = run(`
f=$(mktemp -t "pre-pr.XXXXXX")
printf 'nothing interesting\\n' > "$f"
show_failure_context "Static: thing" "$f"
echo "RETURNED"
`);
    expect(r.timedOut).toBe(false);
    expect(r.stdout).toContain("nothing interesting");
    expect(r.stdout).toContain("RETURNED");
  });
});

describe("wiring", () => {
  it("is reachable from scripts/pre-pr.sh's own failure path", () => {
    // The functions are only worth testing because the script calls them.
    // Anchored at line start so a commented-out call does not satisfy it.
    expect(source).toMatch(/^\s*show_failure_context "\$\{failure%%\|\*\}"/m);
    expect(source).toMatch(/^trap cleanup_tempfiles EXIT$/m);
  });
});
