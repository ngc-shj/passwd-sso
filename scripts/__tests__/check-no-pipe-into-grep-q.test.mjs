/**
 * Self-test for scripts/checks/check-no-pipe-into-grep-q.sh — the CI guard that
 * forbids `<writer> | grep -q …` in shell scripts.
 *
 * The first block is not a test of the guard but of the defect the guard exists
 * for: it reproduces the SIGPIPE inversion in a real bash process, so the rest
 * of this file is not defending a rule nobody can show is real.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GUARD = join(REPO_ROOT, "scripts/checks/check-no-pipe-into-grep-q.sh");

let root;

function runGuard(extraEnv = {}) {
  const r = spawnSync("bash", [GUARD], {
    encoding: "utf8",
    env: {
      ...process.env,
      NO_PIPE_GREP_Q_ROOT: root,
      NO_PIPE_GREP_Q_FIXTURE_MODE: "1",
      ...extraEnv,
    },
  });
  return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Writes scripts/<name>.sh under the fixture root. */
function writeScript(name, body) {
  writeFileSync(join(root, "scripts", `${name}.sh`), body, "utf8");
}

/** The guard needs >= MIN_FILES scripts before it will report at all. */
function padScripts(n = 25) {
  for (let i = 0; i < n; i++) {
    writeScript(`pad-${i}`, "#!/usr/bin/env bash\nset -euo pipefail\ntrue\n");
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "no-pipe-grep-q-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  padScripts();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the defect this guard exists for", () => {
  // A needle on the FIRST line and a body far larger than the 64 KiB pipe
  // buffer: grep matches and exits while printf still has data to write, so
  // printf takes SIGPIPE and pipefail reports the successful match as failure.
  // The haystack is built inside bash by string doubling — passing ~3 MB as an
  // argv entry hits E2BIG.
  const NEEDLE = "needle";
  const BUILD = `block=$'filler-line\\n'; for _ in $(seq 1 18); do block="$block$block"; done; big=$'${NEEDLE}\\n'"$block";`;

  function runShape(condition) {
    return spawnSync(
      "bash",
      [
        "-c",
        `set -euo pipefail; ${BUILD} if ${condition}; then echo FOUND; else echo "MISSED(rc=$?)"; fi`,
      ],
      { encoding: "utf8", maxBuffer: 1 << 20 },
    );
  }

  it("reports a SUCCESSFUL match as failure when piped into grep -q", () => {
    const r = runShape(`printf '%s' "$big" | grep -qxF '${NEEDLE}'`);
    // The needle IS on the first line — "MISSED" here is the inversion itself,
    // not a matching failure. If a future bash/coreutils stops reporting it,
    // this assertion is the tripwire that says so.
    expect(r.stdout.trim()).toMatch(/^MISSED\(rc=\d+\)$/);
  });

  it("reports the same match correctly through a herestring", () => {
    const r = runShape(`grep -qxF '${NEEDLE}' <<<"$big"`);
    expect(r.stdout.trim()).toBe("FOUND");
  });
});

describe("check-no-pipe-into-grep-q.sh", () => {
  it("FAILS on a pipeline into grep -q", () => {
    writeScript(
      "offender",
      '#!/usr/bin/env bash\nset -euo pipefail\nif printf "%s" "$LIST" | grep -qxF "$1"; then true; fi\n',
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("offender.sh");
  });

  it("FAILS on the echo spelling too — the writer is not part of the rule", () => {
    writeScript(
      "offender",
      '#!/usr/bin/env bash\nset -euo pipefail\nif echo "$LIST" | grep -q foo; then true; fi\n',
    );
    expect(runGuard().exitCode).toBe(1);
  });

  it("FAILS when the writer is a command rather than printf/echo", () => {
    writeScript(
      "offender",
      '#!/usr/bin/env bash\nset -euo pipefail\nif git diff --name-only | grep -q "^src/"; then true; fi\n',
    );
    expect(runGuard().exitCode).toBe(1);
  });

  // The quiet flag is what makes the reader exit early, so every spelling of it
  // has to match. Matching `grep -q…` by prefix missed four of these five.
  it.each([
    ["-q", 'cat f | grep -q "^x"'],
    ["-qiE (q first)", 'cat f | grep -qiE "^x"'],
    ["-iqE (q in the middle)", 'cat f | grep -iqE "^x"'],
    ["-Eq (q last)", 'cat f | grep -Eq "^x"'],
    ["--quiet", 'cat f | grep --quiet "^x"'],
  ])("FAILS on the %s spelling", (_name, body) => {
    writeScript(
      "offender",
      `#!/usr/bin/env bash\nset -euo pipefail\nif ${body}; then true; fi\n`,
    );
    expect(runGuard().exitCode).toBe(1);
  });

  it("FAILS when the pipe and the grep are split by a line continuation", () => {
    writeScript(
      "offender",
      '#!/usr/bin/env bash\nset -euo pipefail\nif cat f | \\\n  grep -qxF "$1"; then true; fi\n',
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    // Reported against the line the pipeline starts on, not the continuation.
    expect(stdout).toMatch(/offender\.sh:3:/);
  });

  it("FAILS on a three-stage pipeline whose last reader is quiet", () => {
    writeScript(
      "offender",
      '#!/usr/bin/env bash\nset -euo pipefail\nif cat f | grep -v skip | grep -q .; then true; fi\n',
    );
    expect(runGuard().exitCode).toBe(1);
  });

  it("FAILS on a pipeline nested inside bash -c, which no exclusion spares", () => {
    // Safe today only because a fresh `bash -c` has no pipefail — a property of
    // the caller, not the line. The gate rejects the shape regardless.
    writeScript(
      "offender",
      "#!/usr/bin/env bash\nset -euo pipefail\nbash -c 'if cat f | grep -q x; then true; fi'\n",
    );
    expect(runGuard().exitCode).toBe(1);
  });

  it("PASSES the herestring form", () => {
    writeScript(
      "clean",
      '#!/usr/bin/env bash\nset -euo pipefail\nif grep -qxF "$1" <<<"$LIST"; then true; fi\n',
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("no pipeline into grep -q");
  });

  it("PASSES `|| grep -q` — logical OR is not a pipe", () => {
    writeScript(
      "clean",
      '#!/usr/bin/env bash\nset -euo pipefail\n(( ec == 0 )) || grep -qE "x" <<<"$out"\n',
    );
    expect(runGuard().exitCode).toBe(0);
  });

  it("PASSES a pipeline into a reader that drains its input", () => {
    // grep -v / sort read to EOF, so the writer never sees a closed pipe.
    writeScript(
      "clean",
      '#!/usr/bin/env bash\nset -euo pipefail\nhits=$(grep -rn x src/ | grep -v test || true)\n',
    );
    expect(runGuard().exitCode).toBe(0);
  });

  it("does not trip on the prose that documents the rule", () => {
    writeScript(
      "clean",
      "#!/usr/bin/env bash\nset -euo pipefail\n# NOTE: never write `foo | grep -q bar` here.\ntrue\n",
    );
    expect(runGuard().exitCode).toBe(0);
  });

  it("EMPTY_SCAN: fails when the scan finds implausibly few scripts", () => {
    rmSync(join(root, "scripts"), { recursive: true, force: true });
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeScript("only-one", "#!/usr/bin/env bash\ntrue\n");
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("EMPTY_SCAN");
  });

  it("fails when the scan directory is absent rather than passing vacuously", () => {
    rmSync(join(root, "scripts"), { recursive: true, force: true });
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("not found");
  });

  it("ENV_POLLUTION_GUARD: refuses an override under CI without fixture mode", () => {
    const { exitCode, stdout } = runGuard({
      CI: "true",
      NO_PIPE_GREP_Q_FIXTURE_MODE: "",
    });
    expect(exitCode).toBe(1);
    expect(stdout).toContain("ENV_POLLUTION_GUARD");
  });

  it("passes against the real repo", () => {
    const r = spawnSync("bash", [GUARD], { encoding: "utf8", env: process.env });
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });
});
