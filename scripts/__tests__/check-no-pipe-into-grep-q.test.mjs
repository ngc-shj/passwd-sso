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
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GUARD = join(REPO_ROOT, "scripts/checks/check-no-pipe-into-grep-q.sh");

let root;

function runGuard(extraEnv = {}, spawnOpts = {}) {
  const r = spawnSync("bash", [GUARD], {
    encoding: "utf8",
    env: {
      ...process.env,
      NO_PIPE_GREP_Q_ROOT: root,
      NO_PIPE_GREP_Q_FIXTURE_MODE: "1",
      ...extraEnv,
    },
    ...spawnOpts,
  });
  return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Writes scripts/<name>.sh under the fixture root. */
function writeScript(name, body) {
  writeFileSync(join(root, "scripts", `${name}.sh`), body, "utf8");
}

/** Writes <root>/.claude/hooks/<name>.sh under the fixture root. */
function writeClaudeHook(name, body) {
  mkdirSync(join(root, ".claude", "hooks"), { recursive: true });
  writeFileSync(join(root, ".claude", "hooks", `${name}.sh`), body, "utf8");
}

/**
 * Writes <root>/.claude/settings.json wiring each command as its own
 * PreToolUse hook, mirroring the real file's shape (`hooks.*[].hooks[].command`).
 */
function writeSettings(commands) {
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(
    join(root, ".claude", "settings.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: commands.map((command) => ({ type: "command", command })),
          },
        ],
      },
    }),
    "utf8",
  );
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

  // grep's own stdout is discarded: -m1 and -l print their match, which would
  // otherwise land in the FOUND/MISSED capture.
  function runShape(condition) {
    return spawnSync(
      "bash",
      [
        "-c",
        `set -euo pipefail; ${BUILD} if ${condition} >/dev/null 2>&1; then echo FOUND; else echo "MISSED(rc=$?)"; fi`,
      ],
      { encoding: "utf8", maxBuffer: 1 << 20 },
    );
  }

  // 128 + SIGPIPE(13). Pinned exactly rather than as /rc=\d+/: a loose pattern
  // also accepts rc=1 (needle genuinely absent), rc=2 (grep rejected its own
  // arguments) and rc=127 (grep not found) — three ways for this test to pass
  // while measuring something other than the inversion it exists to measure.
  const SIGPIPE = "MISSED(rc=141)";

  // The needle IS on the first line, so "MISSED" here is the inversion itself,
  // not a matching failure. These four invert on BOTH platforms — they stop
  // reading as soon as the verdict is known, so the writer takes SIGPIPE
  // regardless of implementation. `-l` is the platform-dependent one, below.
  it.each([["-q"], ["--quiet"], ["--silent"], ["-m1"]])(
    "reports a SUCCESSFUL match as failure when piped into grep %s (member)",
    (flag) => {
      const r = runShape(`printf '%s' "$big" | grep ${flag} '${NEEDLE}'`);
      expect(r.stdout.trim()).toBe(SIGPIPE);
    },
  );

  // -l is PLATFORM-DEPENDENT, and that is the whole reason it belongs in the
  // gate's member set. BSD grep (macOS) exits on first match and takes SIGPIPE
  // exactly like -q; GNU grep keeps draining stdin and does not invert. The gate
  // must flag it because it runs on both, but this test cannot assert one
  // outcome for both — an earlier revision did, and CI (GNU) reddened on the
  // BSD-measured claim. Assert the behaviour the running grep actually has, and
  // require the pair to be exhaustive so an unexpected third outcome fails.
  it("either inverts for grep -l or does not, depending on the implementation", () => {
    // Deliberately NOT branching on `grep --version`: BSD grep reports itself as
    // "grep (BSD grep, GNU compatible)", so a substring test for "GNU" picks the
    // wrong branch on exactly the platform that inverts. There is no reliable
    // name to key on here — only the behaviour.
    //
    // So assert the pair is EXHAUSTIVE rather than picking a side: -l either
    // drains (FOUND, GNU) or exits early and SIGPIPEs the writer (MISSED, BSD).
    // Any third outcome is a real finding. The gate's member set includes -l
    // because one of these two platforms inverts, and the gate runs on both.
    const r = runShape(`printf '%s' "$big" | grep -l '${NEEDLE}'`);
    const out = r.stdout.trim();
    expect(
      out === "FOUND" || out === SIGPIPE,
      `grep -l produced an unexpected outcome: ${out}`,
    ).toBe(true);
  });

  // The non-members, measured on the same haystack: these consume their input,
  // so the writer never takes SIGPIPE. They bound the widening — without them a
  // later edit could keep adding flags with nothing to say it had gone too far.
  it.each([["-c"], ["-o"], ["-n"]])(
    "does NOT invert for grep %s, which is why the gate leaves it alone",
    (flag) => {
      const r = runShape(`printf '%s' "$big" | grep ${flag} '${NEEDLE}' >/dev/null`);
      expect(r.stdout.trim()).toBe("FOUND");
    },
  );

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
    ["--silent", 'cat f | grep --silent "^x"'],
    ["-m1", 'cat f | grep -m1 "^x"'],
    ["-m 1 (separated)", 'cat f | grep -m 1 "^x"'],
    ["--max-count=1", 'cat f | grep --max-count=1 "^x"'],
  ])("FAILS on the %s spelling", (_name, body) => {
    writeScript(
      "offender",
      `#!/usr/bin/env bash\nset -euo pipefail\nif ${body}; then true; fi\n`,
    );
    expect(runGuard().exitCode).toBe(1);
  });

  it("FAILS when the pipe and the grep are split by a `\\` continuation", () => {
    writeScript(
      "offender",
      '#!/usr/bin/env bash\nset -euo pipefail\nif cat f | \\\n  grep -qxF "$1"; then true; fi\n',
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    // Reported against the line the pipeline starts on, not the continuation.
    expect(stdout).toMatch(/offender\.sh:3:/);
  });

  it.each([["|"], ["|&"]])(
    "FAILS when the line simply ends in `%s` — bash needs no backslash there",
    (op) => {
      writeScript(
        "offender",
        `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s' "$value" ${op}\n  grep -q needle\n`,
      );
      const { exitCode, stdout } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout).toMatch(/offender\.sh:3:/);
    },
  );

  it("FAILS on `grep -l`, which inverts on BSD grep", () => {
    // Pinning the derivation: the member set is "flags that make grep exit
    // before draining stdin". -l does on BSD (macOS) though not on GNU, and the
    // gate runs on both, so it is a member.
    writeScript(
      "offender",
      '#!/usr/bin/env bash\nset -euo pipefail\ncat f | grep -l needle\n',
    );
    expect(runGuard().exitCode).toBe(1);
  });

  it("PASSES `grep -c`, a measured non-member", () => {
    // The over-blocking direction: widening the class must not sweep in flags
    // that were measured as safe, or the gate starts flagging correct code.
    writeScript(
      "clean",
      '#!/usr/bin/env bash\nset -euo pipefail\ncat f | grep -c needle\n',
    );
    expect(runGuard().exitCode).toBe(0);
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

  // A comment-only line is dropped before the continuation test. Joining it
  // first and then discarding the logical line for starting with `#` let a
  // comment ending in an operator swallow the violation underneath it.
  it.each([
    ["|", "# documented pipeline |"],
    ["\\", "# documented continuation \\"],
  ])("FAILS when a comment ending in `%s` precedes the violation", (_op, comment) => {
    writeScript(
      "offender",
      `#!/usr/bin/env bash\nset -euo pipefail\n${comment}\nprintf '%s' "$BODY" | grep -q needle\n`,
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    // Reported against the pipeline, not the comment.
    expect(stdout).toMatch(/offender\.sh:4:/);
  });

  // bash lets a pipeline continue across lines that carry no command text.
  // Ending the logical line on one of them split the pipeline from its grep,
  // which is precisely the shape being looked for.
  it.each([
    ["a comment line", "  # pipeline explanation"],
    ["a blank line", ""],
    ["an indented blank line", "   "],
  ])("FAILS when %s sits between the pipe and the grep", (_name, filler) => {
    writeScript(
      "offender",
      `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s' "$BODY" |\n${filler}\n  grep -q needle\n`,
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode, stdout).toBe(1);
    // Still anchored to the line the pipeline starts on.
    expect(stdout).toMatch(/offender\.sh:3:/);
  });

  // The operator is still the last thing bash sees on the line; only the
  // scanner saw a comment after it and stopped treating the line as continued.
  it.each([
    ["|", `printf '%s' "$BODY" | # pipeline explanation`, "grep -q needle"],
    ["|&", "producer |& # comment", "grep --silent pattern"],
  ])(
    "FAILS when a comment trails the `%s` on the operator's own line",
    (_op, first, second) => {
      writeScript(
        "offender",
        `#!/usr/bin/env bash\nset -euo pipefail\n${first}\n  ${second}\n`,
      );
      const { exitCode, stdout } = runGuard();
      expect(exitCode, stdout).toBe(1);
      expect(stdout).toMatch(/offender\.sh:3:/);
    },
  );

  // A blank is not required before `#`: an unquoted metacharacter ends the
  // word too, so the operator and the comment can touch.
  it.each([
    ["|", "producer |#comment", "grep -q pattern"],
    ["|&", "producer |&#comment", "grep --silent pattern"],
  ])(
    "FAILS when a comment touches the `%s` with no space",
    (_op, first, second) => {
      writeScript(
        "offender",
        `#!/usr/bin/env bash\nset -euo pipefail\n${first}\n  ${second}\n`,
      );
      const { exitCode, stdout } = runGuard();
      expect(exitCode, stdout).toBe(1);
      expect(stdout).toMatch(/offender\.sh:3:/);
    },
  );

  // Each of these puts a non-comment `#` BEFORE the violation on the same line,
  // so truncating there would hide the violation rather than merely mangle the
  // text — the failure mode a passing gate would not show.
  it.each([
    ["a `#` inside a word", 'cat f#1 | grep -q x'],
    ["a `#` inside a quoted pattern", 'cat f | grep -q "#tag"'],
    ["`${f#pre}` (parameter expansion)", 'cat "${f#pre}" | grep -q x'],
    ["`${#f}` (length expansion)", 'n="${#f}"; cat f | grep -q x'],
    ["`$#` (positional count)", 'a="$#"; cat f | grep -q x'],
  ])("still FAILS with %s — that is not a comment", (_name, body) => {
    writeScript(
      "offender",
      `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`,
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode, stdout).toBe(1);
  });

  it("PASSES a safe pipeline whose LATER stage carries -m", () => {
    // `sort -m` merges; it reads to EOF. The flag belongs to sort, not to the
    // grep, so scanning the whole line rather than the grep's own arguments
    // would reject valid code.
    writeScript(
      "clean",
      '#!/usr/bin/env bash\nset -euo pipefail\nprintf "x\\n" | grep x | sort -m\n',
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode, stdout).toBe(0);
  });

  it("still FAILS when the grep pattern itself contains a `|`", () => {
    // The operator scan is quote-aware: the `|` inside the alternation is not
    // a pipe, and must not truncate the arguments before `-q` is seen.
    writeScript(
      "offender",
      '#!/usr/bin/env bash\nset -euo pipefail\nif cat f | grep -E "a|b" -q; then true; fi\n',
    );
    expect(runGuard().exitCode).toBe(1);
  });

  it("PASSES a quoted `| grep -q` inside a string literal", () => {
    writeScript(
      "clean",
      '#!/usr/bin/env bash\nset -euo pipefail\nmsg="never write: foo | grep -q bar"\nprintf "%s" "$msg"\n',
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode, stdout).toBe(0);
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

describe("the credential hook directory is scanned too (audit-tenant-adjudicator round 15, F-R15-2)", () => {
  // The round-14 race in .claude/hooks/block-bare-decrypt.sh was this exact shape,
  // and the gate never looked outside scripts/.
  function writeHook(name, body) {
    mkdirSync(join(root, ".claude", "hooks"), { recursive: true });
    writeFileSync(join(root, ".claude", "hooks", `${name}.sh`), body, "utf8");
  }

  it("fails on a pipeline into grep -q in a hook script", () => {
    writeHook("guard", `#!/usr/bin/env bash\nset -euo pipefail\nif printf '%s' "$COMMAND" | grep -qE "decrypt"; then exit 2; fi\n`);
    const { exitCode, stdout } = runGuard();
    expect(exitCode, stdout).toBe(1);
    expect(stdout).toContain(".claude/hooks/guard.sh:3:");
  });

  it("passes a hook script that reads a here-string", () => {
    writeHook("guard", `#!/usr/bin/env bash\nset -euo pipefail\nif grep -qE "decrypt" <<<"$COMMAND"; then exit 2; fi\n`);
    const { exitCode, stdout } = runGuard();
    expect(exitCode, stdout).toBe(0);
    expect(stdout).toContain("1 hook script(s) scanned");
  });

  it("EMPTY_SCAN: fails when the hook directory holds no shell script", () => {
    mkdirSync(join(root, ".claude", "hooks"), { recursive: true });
    writeFileSync(join(root, ".claude", "hooks", "README.md"), "not a script\n", "utf8");
    const { exitCode, stdout } = runGuard();
    expect(exitCode, stdout).toBe(1);
    expect(stdout).toContain("EMPTY_SCAN: no shell scripts found under .claude/hooks/");
  });
});

// issue-838 follow-ups, C2: the hook member set is WIRED (read from
// .claude/settings.json) UNION PRESENT (found under .claude/hooks/*.sh), and
// the gate fails closed whenever it cannot classify what is wired rather than
// silently skipping it.
describe("C2: hook member set is wired ∪ present, parsed from .claude/settings.json", () => {
  describe("A-C2-1: deny cells", () => {
    it("awk failure on an unreadable file is fatal, naming the file and the awk exit status", () => {
      writeScript("unreadable", "#!/usr/bin/env bash\nset -euo pipefail\ntrue\n");
      chmodSync(join(root, "scripts", "unreadable.sh"), 0o000);
      const { exitCode, stdout } = runGuard();
      expect(exitCode, stdout).toBe(1);
      expect(stdout).toContain("ERROR: scanner failed on");
      expect(stdout).toContain("unreadable.sh");
      expect(stdout).toMatch(/awk exit \d+/);
    });

    it("FAILS when settings wires a hook that does not exist on disk", () => {
      writeSettings(["bash .claude/hooks/missing.sh"]);
      const { exitCode, stdout } = runGuard();
      expect(exitCode, stdout).toBe(1);
      expect(stdout).toContain("wires a hook that does not exist");
      expect(stdout).toContain(".claude/hooks/missing.sh");
    });

    it.each([
      ["several commands joined by &&", "bash a.sh && bash b.sh"],
      [
        "a variable ($CLAUDE_PROJECT_DIR) in the path",
        'bash "$CLAUDE_PROJECT_DIR/.claude/hooks/x.sh"',
      ],
    ])("FAILS when a wired command is unclassifiable: %s", (_name, command) => {
      writeSettings([command]);
      const { exitCode, stdout } = runGuard();
      expect(exitCode, stdout).toBe(1);
      expect(stdout).toContain("unclassifiable");
    });

    it("FAILS when .claude/settings.json is not valid JSON", () => {
      mkdirSync(join(root, ".claude"), { recursive: true });
      writeFileSync(join(root, ".claude", "settings.json"), "{ not valid json", "utf8");
      const { exitCode, stdout } = runGuard();
      expect(exitCode, stdout).toBe(1);
      expect(stdout).toContain("not valid JSON");
    });

    it("run from an unrelated cwd gives the same result as from the repo root", () => {
      // No NO_PIPE_GREP_Q_ROOT override here — this exercises REPO_ROOT
      // resolution itself (item 1: from ${BASH_SOURCE[0]}, never from
      // `git rev-parse` in the caller's cwd) against the real tree.
      const fromRoot = spawnSync("bash", [GUARD], {
        encoding: "utf8",
        env: process.env,
        cwd: REPO_ROOT,
      });
      const fromElsewhere = spawnSync("bash", [GUARD], {
        encoding: "utf8",
        env: process.env,
        cwd: tmpdir(),
      });
      expect(fromElsewhere.status).toBe(fromRoot.status);
      expect(fromElsewhere.stdout).toBe(fromRoot.stdout);
    });
  });

  describe("A-C2-1b: allow cells", () => {
    it("no .claude/settings.json and no .claude/hooks/ reports 0 wired / 0 scanned", () => {
      // The shared beforeEach fixture (padScripts only) is already in this
      // state — every existing test in this file that never calls
      // writeSettings/writeClaudeHook relies on this staying an allow cell.
      const { exitCode, stdout } = runGuard();
      expect(exitCode, stdout).toBe(0);
      expect(stdout).toMatch(/0 hook\(s\) wired \(0 shell, 0 not-shell\)/);
      expect(stdout).toContain("0 hook script(s) scanned");
    });

    it("a `node <path>` hook is reported as not-shell and is not scanned", () => {
      writeSettings(["node .claude/hooks/notify.mjs"]);
      const { exitCode, stdout } = runGuard();
      expect(exitCode, stdout).toBe(0);
      expect(stdout).toMatch(/1 hook\(s\) wired \(0 shell, 1 not-shell\)/);
      expect(stdout).toContain("0 hook script(s) scanned");
    });

    it("wiring BOTH a shell hook and a node hook moves wired/scanned/not-shell independently", () => {
      writeClaudeHook("guard", "#!/usr/bin/env bash\nset -euo pipefail\ntrue\n");
      writeSettings(["bash .claude/hooks/guard.sh", "node .claude/hooks/notify.mjs"]);
      const { exitCode, stdout } = runGuard();
      expect(exitCode, stdout).toBe(0);
      expect(stdout).toMatch(/2 hook\(s\) wired \(1 shell, 1 not-shell\)/);
      expect(stdout).toContain("1 hook script(s) scanned");
    });
  });

  describe("A-C2-2: real-tree cell", () => {
    it("the real tree's scanned hook set equals its wired shell set, and is non-empty", () => {
      const settings = JSON.parse(
        readFileSync(join(REPO_ROOT, ".claude", "settings.json"), "utf8"),
      );
      const commands = [];
      for (const entries of Object.values(settings.hooks ?? {})) {
        for (const entry of entries) {
          for (const hook of entry.hooks ?? []) commands.push(hook.command);
        }
      }
      const wiredShell = commands.filter((c) => /^(?:bash|sh)\s+\S+\.sh$/.test(c));
      expect(wiredShell.length).toBeGreaterThan(0);

      const r = spawnSync("bash", [GUARD], { encoding: "utf8", env: process.env });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      const m = r.stdout.match(
        /(\d+) hook script\(s\) scanned; (\d+) hook\(s\) wired \((\d+) shell, (\d+) not-shell\)/,
      );
      expect(m, r.stdout).not.toBeNull();
      const [, scanned, , wiredShellCount] = m.map(Number);
      expect(wiredShellCount).toBe(wiredShell.length);
      expect(scanned).toBe(wiredShell.length);
      expect(scanned).toBeGreaterThan(0);
    });
  });
});

