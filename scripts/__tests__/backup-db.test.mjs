/**
 * Tests for scripts/backup-db.sh.
 *
 * Group A stubs `docker`, `pg_dump`, `pg_dumpall` and `pg_restore` on PATH so the
 * script runs end-to-end with no database. Each stub appends its argv and a few
 * environment values to a log the assertions read back.
 *
 * Group B does NOT stub the reader. C5's whole premise is that an archive is
 * validated by the implementation that will restore it, so a fixture a stub
 * accepts proves nothing. Group B runs a real `pg_restore` over the committed
 * fixtures (host binary, else the compose `db` service) and fails — never skips —
 * when neither is reachable: a skipped test for the invariant the script exists
 * to deliver reads as coverage.
 *
 * Every failure assertion checks the BACKUP_ERR:<CODE> identifier, not just the
 * exit status. The script exits 1 for every failure, so a status-only assertion
 * passes against a script that implements none of the guards.
 *
 * The spawn environment is an explicit allowlist including HOME. BACKUP_DIR
 * defaults to $HOME/passwd-sso-backups and the script prunes there, so an
 * inherited HOME would let a test of default behaviour delete the developer's
 * real backups.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync, spawn } from "node:child_process";
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, readFileSync,
  existsSync, readdirSync, statSync, lstatSync, symlinkSync, utimesSync, realpathSync,
  openSync, closeSync, writeSync, renameSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir, hostname, homedir } from "node:os";



const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
// Read only by the test — the script never looks at it. It exists so a mutation
// sweep can drive a modified COPY through this harness (`BACKUP_DB_SCRIPT=<copy>
// npx vitest run …`) instead of editing the tracked file. Without it every sweep
// first rebuilds a mirror of the whole repository, which is why the sweep keeps
// being re-derived rather than re-run, and why guards stay unpinned between
// rounds. Round-2 finding N-09.
const SCRIPT = process.env.BACKUP_DB_SCRIPT ?? resolve(REPO_ROOT, "scripts", "backup-db.sh");
const FIXTURES = resolve(__dirname, "fixtures", "backup-db");

const SENTINEL_PASSWORD = "S3NT1NEL-p@ss";

/**
 * A pid that cannot be running while the fixture runs.
 *
 * The lock fixtures used a literal `999999`, which is not a dead pid — it is a
 * perfectly allocatable one. Measured on this host: `/proc/sys/kernel/pid_max`
 * is 4194304, and under `scripts/pre-pr.sh`'s parallel steps 999999 was
 * genuinely live. The script then reported `(pid 999999, alive)` and correctly
 * refused, so the two "holder is gone" cases failed — standalone green, red only
 * under process churn. That is an in-band sentinel colliding with a legitimate
 * value of its own domain, and the collision made a working guard look broken.
 *
 * Linux gives a value that is unallocatable BY CONSTRUCTION: anything above
 * `pid_max`. Where that file is unreadable (macOS — the platform #772 repaired
 * other gates for), probe downward from the signed-32-bit ceiling and take the
 * first pid that reports ESRCH. Refuse rather than return a value that might be
 * live: a fixture that seeds a live pid exercises the opposite branch and says
 * nothing about the one it names.
 *
 * The two paths give guarantees of different strength, and the throw below is
 * reachable only from the second. Linux: unallocatable given the `pid_max` read
 * at module load — `pid_max` is root-writable at runtime (`sysctl
 * kernel.pid_max`) and GONE_PID is computed once, so the guarantee is scoped to
 * that read, not to the kernel for the run's duration. macOS: shown absent by
 * probe, which is a tripwire rather than a boundary — a pid absent at probe time
 * could in principle be allocated before the fixture is read, bounded only by
 * the probe starting at the signed-32-bit ceiling, far from where the allocator
 * hands out pids.
 *
 * TODO(audit-sentinel-verification-gaps): the probe path is unexercised. It runs
 * only where /proc is absent — every macOS run of this suite, no Linux run and
 * no CI run — and it cannot be forced from a test: this function is
 * module-private and evaluates at import, in a file that reads the filesystem
 * for real ~50 times, so faking the /proc read means mocking `node:fs` for a
 * suite whose subject IS filesystem behaviour. Covering it needs the function
 * extracted behind an injected reader.
 */
function unallocatablePid() {
  try {
    const max = Number(readFileSync("/proc/sys/kernel/pid_max", "utf8").trim());
    if (Number.isInteger(max) && max > 0) return max + 1;
  } catch {
    // No /proc. Fall through to probing.
  }
  for (let candidate = 0x7ffffffe; candidate > 0x7ffff000; candidate--) {
    try {
      process.kill(candidate, 0);
    } catch (e) {
      if (e.code === "ESRCH") return candidate;
    }
  }
  throw new Error(
    "backup-db.test: no pid could be shown to be absent — refusing to seed a " +
      "lock fixture with a pid that may be alive",
  );
}

const GONE_PID = unallocatablePid();

/**
 * One row of the cluster enumeration as the script reads it: the connect flag
 * followed by the HEX-encoded datname. Hex is the transport because a quoted
 * identifier may contain any byte but NUL, and a newline in one used to split a
 * single database into two rows.
 */
const dbRow = (name, conn = "y") => conn + Buffer.from(name, "utf8").toString("hex");

// Absolute, so a case can hand the script a curated PATH that deliberately
// omits a client without also making the interpreter unresolvable.
const BASH = spawnSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim() || "/bin/bash";

let tmpDir, binDir, homeDir, backupDir, logFile;
// The RESOLVED spellings. The script resolves its destination with `cd … && pwd -P`
// (INV-C4a), and on macOS /var is a symlink to /private/var — so a stub comparing
// against the mkdtemp path never matched the path the script actually passes to
// `stat` or `ls`. Measured on Darwin 25.5.0: mkdtemp gives /var/folders/…, `pwd -P`
// gives /private/var/folders/…, and eight destination-guard cases silently
// exercised nothing on the platform the portability floor exists for.
let realBackupDir, realParentDir;
// Set by mountStub; run() passes it so the Linux reader sees the fixture.
let mountinfoPath;

function stub(name, body) {
  const p = join(binDir, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`, "utf8");
  chmodSync(p, 0o755);
}

function readLog() {
  return existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
}

/**
 * A docker stub that speaks just enough compose. `pg_dump` writes a marker
 * archive to stdout, `pg_restore --list` prints a TOC with comment lines plus
 * `PG_TOC_ENTRIES` real entries, so a script counting raw lines instead of
 * non-comment lines would read a non-zero count from an empty TOC.
 */
function dockerStub({ psStatus = 0, psOutput = "container123", dumpFails = "", restoreFails = "",
                     clusterStatus = 0, clusterStderr = "",
                     // The HEALTHY shape by default: a real psql answers the
                     // enumeration with at least the database it connected to,
                     // so an empty answer as the shared default made the
                     // recon-failed branch the suite's normal state and every
                     // compose case carried its warning. The empty answer is
                     // now an explicit deviation, stated where it is meant.
                     clusterRows = `${dbRow("passwd_sso")}\n${dbRow("jackson")}\n` } = {}) {
  stub("docker", `
echo "docker $*" >> "${logFile}"
sub="\${2:-}"
case "$sub" in
  config) exit 0 ;;
  ps)
    printf '%s\\n' "${psOutput}"
    exit ${psStatus} ;;
  exec)
    for a in "$@"; do
      case "$a" in
        pg_dump)
          [ "\${PG_DUMP_FAILS:-}" = "$5" ] && exit 1
          [ -n "${dumpFails}" ] && case " $* " in *" ${dumpFails} "*) exit 1 ;; esac
          printf 'PGDMP-STUB-ARCHIVE'
          exit 0 ;;
        pg_dumpall)
          printf 'CREATE ROLE stub_role;\\n--\\n-- PostgreSQL database cluster dump complete\\n--\\n'
          exit 0 ;;
        psql)
          # The cluster enumeration and its diagnostic re-run. Silent success
          # is the default because that is what every earlier case saw, and it
          # is itself a fixture: an enumeration that answers nothing has not
          # run, whatever its exit status.
          [ -n "${clusterStderr}" ] && printf '%s\\n' "${clusterStderr}" >&2
          [ -n "${clusterRows}" ] && printf '%s' "${clusterRows}"
          exit ${clusterStatus} ;;
        pg_restore)
          [ -n "${restoreFails}" ] && exit 1
          cat > /dev/null
          printf '; Archive created at 2026-01-01\\n; dbname: x\\n; Selected TOC Entries:\\n'
          i=0
          while [ "$i" -lt "\${PG_TOC_ENTRIES:-3}" ]; do
            printf '%d; 1259 %d TABLE public t%d owner\\n' "$i" "$i" "$i"
            i=$((i + 1))
          done
          exit 0 ;;
      esac
    done
    exit 0 ;;
esac
exit 0`);
}

/** Run the script with an explicit environment allowlist. */
function run(env = {}, { tocEntries } = {}) {
  return spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    timeout: 8000,
    cwd: REPO_ROOT,
    env: {
      PATH: `${binDir}:${process.env.PATH}`,
      HOME: homeDir,
      LANG: "C",
      BACKUP_DIR: backupDir,
      // `!== undefined`, not truthiness: SET-BUT-EMPTY is the seam's way of
      // saying "no structured table, use the text reader", which is how a Linux
      // host — where /proc/self/mountinfo exists — drives the macOS path. An
      // unreadable path is a different answer entirely and now refuses.
      ...(mountinfoPath !== undefined ? { BACKUP_MOUNTINFO_PATH: mountinfoPath } : {}),
      ...(tocEntries === undefined ? {} : { PG_TOC_ENTRIES: String(tocEntries) }),
      ...env,
    },
  });
}

/**
 * Start `scriptPath` with its output captured in `outPath`, replace `rootPath`
 * underneath the still-running script, then wait for it and record its exit
 * status in the captured output.
 *
 * Shell-free on purpose. Backgrounding, sleeping and waiting were the only
 * reasons a shell was here, and node does all three directly.
 *
 * The positional-argument form this replaced was safe at runtime — only the
 * string after `-c` is parsed as shell code, and the expansion of "$1" is not
 * re-parsed — but CodeQL treats environment-derived values handed to a shell
 * interpreter as command-line injection whichever slot they occupy
 * (js/shell-command-injection-from-environment,
 * js/indirect-command-line-injection), and all three paths here derive from the
 * environment (BACKUP_DB_SCRIPT, TMPDIR). Dropping the interpreter removes the
 * analyzer's ambiguity and the boundary itself. The hostile-path case below
 * drives this same function, so interpolating a path back into shell text fails
 * there.
 */
async function runRootSwap(scriptPath, outPath, rootPath, env) {
  // Opened once, in append mode. The child writes through a duplicate of this
  // descriptor and the exit line goes through the same one, so the path is
  // resolved exactly once — re-opening it by path to append would be a
  // file-system race (CodeQL js/file-system-race). O_APPEND is what lets both
  // writers share it without depending on a shared file offset.
  const out = openSync(outPath, "a");
  try {
    const child = spawn(BASH, [scriptPath], { env, stdio: ["ignore", out, out] });
    const kill = setTimeout(() => child.kill("SIGKILL"), 20000);
    kill.unref();
    const exited = new Promise((resolve) => {
      child.once("error", (error) => resolve({ error }));
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });

    // The swap has to land while the script is between its dumps.
    spawnSync("sleep", ["1"]);
    renameSync(rootPath, `${rootPath}.moved`);
    mkdirSync(rootPath, { mode: 0o700 });
    chmodSync(rootPath, 0o700);

    const result = await exited;
    clearTimeout(kill);
    // The shell used to write this line itself, and the assertions read the
    // script's status out of the captured output, so it still has to land there.
    const status = result.error ? "spawn-error" : result.code ?? `signal:${result.signal}`;
    writeSync(out, `EXIT=${status}\n`);
    return result;
  } finally {
    closeSync(out);
  }
}

function err(r) {
  const m = (r.stdout + r.stderr).match(/BACKUP_ERR:([A-Z_]+)/);
  return m ? m[1] : null;
}

function generations() {
  if (!existsSync(backupDir)) return [];
  // Same predicate the pruner uses: a directory, not a symlink, stamped name.
  // Counting a regular file or a symlink named like a generation would measure
  // a different set than the script does.
  return readdirSync(backupDir)
    .filter((n) => /^\d{8}T\d{6}Z$/.test(n))
    .filter((n) => {
      const st = lstatSync(join(backupDir, n));
      return st.isDirectory() && !st.isSymbolicLink();
    })
    .sort();
}

function mkGeneration(name, dir = backupDir) {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "passwd_sso.dump"), "x", "utf8");
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "backup-db-test-"));
  binDir = join(tmpDir, "bin");
  homeDir = join(tmpDir, "home");
  backupDir = join(tmpDir, "bkp");
  logFile = join(tmpDir, "calls.log");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  // Derived from tmpDir, which exists; backupDir may not yet.
  const realTmpDir = realpathSync(tmpDir);
  realBackupDir = join(realTmpDir, "bkp");
  realParentDir = realTmpDir;
  // Explicit, not umask-derived: a real $HOME is 0755 and passes the ancestor
  // check, but this process's umask is 002, which would make the fixture 0775
  // and refuse the default BACKUP_DIR for a reason no operator would hit.
  chmodSync(homeDir, 0o700);
  mountinfoPath = undefined;
  dockerStub();
});

afterEach(() => {
  // Removed on the success path AND the failure path: the tree holds archives
  // and a lock directory, and a leaked lock would make a later run report
  // LOCKED for the wrong reason.
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── C1: environment validation and error identity ──────────

describe("C1 environment validation", () => {
  it("rejects BACKUP_RETAIN=0 rather than treating it as unlimited", () => {
    const r = run({ BACKUP_RETAIN: "0" });
    expect(r.status).toBe(1);
    expect(err(r)).toBe("BAD_ENV");
    expect(existsSync(backupDir)).toBe(false);
  });

  it("accepts a positive BACKUP_RETAIN and reaches the dump (paired allow case)", () => {
    const r = run({ BACKUP_RETAIN: "3" });
    expect(r.status).toBe(0);
    expect(err(r)).toBeNull();
  });

  it("rejects a relative BACKUP_DIR", () => {
    expect(err(run({ BACKUP_DIR: "relative/path" }))).toBe("BAD_ENV");
  });

  it("rejects an option-shaped COMPOSE_DB_SERVICE before any docker call", () => {
    const r = run({ COMPOSE_DB_SERVICE: "-e" });
    expect(err(r)).toBe("BAD_ENV");
    expect(readLog()).toBe("");
  });

  it("rejects BACKUP_TLS_MODE=require — encryption without verification is not a floor", () => {
    expect(err(run({ BACKUP_TLS_MODE: "require" }))).toBe("BAD_ENV");
  });

  it("accepts verify-ca and verify-full (paired allow case)", () => {
    for (const mode of ["verify-ca", "verify-full"]) {
      expect(run({ BACKUP_TLS_MODE: mode }).status).toBe(0);
      rmSync(backupDir, { recursive: true, force: true });
    }
  });

  it("rejects a database name that is not an identifier", () => {
    expect(err(run({ BACKUP_DATABASES: "a;b" }))).toBe("BAD_ENV");
  });

  it("rejects a non-boolean BACKUP_DRY_RUN", () => {
    expect(err(run({ BACKUP_DRY_RUN: "yes" }))).toBe("BAD_ENV");
  });

  it("declares every error code it emits", () => {
    const src = readFileSync(SCRIPT, "utf8");
    const declared = new Set(
      (src.match(/^ERR_CODES="([\s\S]*?)"/m)?.[1] ?? "").split(/\s+/).filter(Boolean),
    );
    const emitted = new Set([...src.matchAll(/\bfail ([A-Z_]+)/g)].map((m) => m[1]));
    for (const code of emitted) expect(declared, `fail ${code} is not in ERR_CODES`).toContain(code);
    // The mirror direction, which is the one that catches a guard nobody can
    // reach: a code declared and never emitted is either a dead branch or a
    // failure path that exits without an identifier.
    const alsoEmitted = new Set([
      ...emitted,
      ...[...src.matchAll(/BACKUP_ERR:([A-Z_]+)/g)].map((m) => m[1]),
    ]);
    for (const code of declared) {
      expect(alsoEmitted, `${code} is declared in ERR_CODES but never emitted`).toContain(code);
    }
    expect(declared.size).toBeGreaterThan(0);
  });
});

// ─── C2: connection mode ────────────────────────────────────

describe("C2 connection mode", () => {
  it("reports a missing compose configuration by naming the working directory", () => {
    stub("docker", `echo "docker $*" >> "${logFile}"
[ "\${2:-}" = "config" ] && { echo "no configuration file provided: not found" >&2; exit 1; }
exit 0`);
    const r = run();
    expect(err(r)).toBe("NO_COMPOSE_FILE");
    expect(r.stderr).toContain(REPO_ROOT);
  });

  it("distinguishes an unknown service from a stopped one", () => {
    dockerStub({ psStatus: 1, psOutput: "" });
    expect(err(run())).toBe("UNKNOWN_SERVICE");
  });

  it("treats empty ps output as not-running even though the exit status is 0", () => {
    // `docker compose ps --status running` exits 0 for a stopped service, so a
    // status-only adjudicator would proceed here and produce an empty archive.
    dockerStub({ psStatus: 0, psOutput: "" });
    expect(err(run())).toBe("DB_NOT_RUNNING");
  });

  it("proceeds when ps reports a container id (paired allow case)", () => {
    dockerStub({ psStatus: 0, psOutput: "abc123" });
    expect(run().status).toBe(0);
  });

  it("fails with NO_DOCKER when docker is absent", () => {
    // Removing the stub is not enough: the real docker is still on the
    // inherited PATH. Point PATH at a curated directory holding only the
    // utilities the script itself needs.
    const sysbin = join(tmpDir, "sysbin");
    mkdirSync(sysbin, { recursive: true });
    for (const tool of ["bash", "date", "uname", "stat", "ls", "mkdir", "rm", "mv",
                        "cat", "id", "dirname", "wc", "tr", "grep", "tail", "sort",
                        "df", "mount", "git", "env", "head"]) {
      const w = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" });
      if (w.status === 0) symlinkSync(w.stdout.trim(), join(sysbin, tool));
    }
    const r = spawnSync("bash", [SCRIPT], {
      encoding: "utf8", timeout: 8000, cwd: REPO_ROOT,
      env: { PATH: sysbin, HOME: homeDir, LANG: "C", BACKUP_DIR: backupDir },
    });
    expect(err(r)).toBe("NO_DOCKER");
  });
});

// ─── C3 / C4: dump set, layout, publication ─────────────────

describe("C3/C4 dump set and atomic publication", () => {
  it("publishes exactly the target set plus globals and MANIFEST", () => {
    expect(run().status).toBe(0);
    const [gen] = generations();
    expect(gen).toBeDefined();
    expect(readdirSync(join(backupDir, gen)).sort()).toEqual(
      ["MANIFEST", "globals.sql", "jackson.dump", "passwd_sso.dump"],
    );
  });

  it("records hostname, mode and per-member entry counts in MANIFEST", () => {
    run({}, { tocEntries: 5 });
    const [gen] = generations();
    const manifest = readFileSync(join(backupDir, gen, "MANIFEST"), "utf8");
    expect(manifest).toMatch(/^hostname: .+$/m);
    expect(manifest).toMatch(/^mode: compose$/m);
    expect(manifest).toMatch(/member: passwd_sso\.dump size=\d+ entries=5/);
    expect(manifest).toMatch(/member: globals\.sql size=\d+ roles=\d+ structural_check_only=true/);
  });

  it("creates the run directory 0700 and each archive 0600", () => {
    run();
    const [gen] = generations();
    expect((statSync(backupDir).mode & 0o777).toString(8)).toBe("700");
    expect((statSync(join(backupDir, gen)).mode & 0o777).toString(8)).toBe("700");
    expect((statSync(join(backupDir, gen, "passwd_sso.dump")).mode & 0o777).toString(8)).toBe("600");
  });

  it("refuses a destination whose mode grants group or other access", () => {
    mkdirSync(backupDir, { recursive: true });
    chmodSync(backupDir, 0o755);
    const r = run();
    expect(err(r)).toBe("DEST_UNSAFE");
    expect(generations()).toEqual([]);
  });

  it("accepts a pre-existing 0700 destination (paired allow case)", () => {
    mkdirSync(backupDir, { recursive: true });
    chmodSync(backupDir, 0o700);
    expect(run().status).toBe(0);
  });

  it("refuses a symlinked destination", () => {
    const real = join(tmpDir, "real");
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, backupDir);
    expect(err(run())).toBe("DEST_UNSAFE");
  });

  it("refuses a destination inside a git worktree", () => {
    // A throwaway worktree, not this repository: if the guard ever regresses,
    // the archives land inside the temp tree afterEach removes rather than in
    // the working copy, where nothing would reclaim them.
    const fakeRepo = join(tmpDir, "somerepo");
    mkdirSync(fakeRepo, { recursive: true, mode: 0o700 });
    chmodSync(fakeRepo, 0o700);
    mkdirSync(join(fakeRepo, ".git"), { recursive: true });
    writeFileSync(join(fakeRepo, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
    writeFileSync(join(fakeRepo, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n", "utf8");
    mkdirSync(join(fakeRepo, ".git", "objects"), { recursive: true });
    mkdirSync(join(fakeRepo, ".git", "refs"), { recursive: true });
    expect(err(run({ BACKUP_DIR: join(fakeRepo, "bkp") }))).toBe("DEST_IN_REPO");
    expect(existsSync(join(fakeRepo, "bkp"))).toBe(false);
  });

  it("permits an in-repo destination when the operator opts in (paired allow case)", () => {
    // The deny side is tested above. A guard whose override is never exercised
    // is a guard whose false-deny cost nobody has measured — and this override
    // is the documented remedy the refusal message points operators at.
    const fakeRepo = join(tmpDir, "optin");
    mkdirSync(fakeRepo, { recursive: true, mode: 0o700 });
    chmodSync(fakeRepo, 0o700);
    mkdirSync(join(fakeRepo, ".git", "objects"), { recursive: true });
    mkdirSync(join(fakeRepo, ".git", "refs"), { recursive: true });
    writeFileSync(join(fakeRepo, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
    writeFileSync(join(fakeRepo, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n", "utf8");
    const dest = join(fakeRepo, "bkp");
    const r = run({ BACKUP_DIR: dest, BACKUP_ALLOW_IN_REPO: "true" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr, "the override must announce what it permits").toMatch(/BACKUP_ALLOW_IN_REPO/);
    expect(readdirSync(dest).filter((n) => /^\d{8}T\d{6}Z$/.test(n))).toHaveLength(1);
  });

  it("leaves nothing published when a dump fails, and no .FAILED for a dump failure", () => {
    dockerStub({ dumpFails: "jackson" });
    const r = run();
    expect(err(r)).toBe("DUMP_FAILED");
    expect(generations()).toEqual([]);
    expect(readdirSync(backupDir).filter((n) => n.endsWith(".FAILED"))).toEqual([]);
  });

  it("fails when pg_dump exits 0 but writes an empty archive", () => {
    // Disjoint from the exit-status guard: a redirect that fails silently, or a
    // dump truncated to nothing, leaves a zero-byte file behind a zero status.
    // The ordinary failure stub trips both at once, so neither is provable alone.
    stub("docker", `
[ "\${2:-}" = "config" ] && exit 0
[ "\${2:-}" = "ps" ] && { echo c1; exit 0; }
for a in "$@"; do
  case "$a" in
    pg_dump)    exit 0 ;;
    pg_dumpall) printf 'CREATE ROLE r;\\n-- PostgreSQL database cluster dump complete\\n'; exit 0 ;;
    pg_restore) printf '; hdr\\n1; 1259 1 TABLE t o\\n'; exit 0 ;;
  esac
done
exit 0`);
    const r = run();
    expect(err(r)).toBe("DUMP_FAILED");
    expect(generations()).toEqual([]);
  });

  it("keeps a .FAILED directory when validation fails, so a bad reader cannot destroy a good archive", () => {
    dockerStub({ restoreFails: "1" });
    const r = run();
    expect(err(r)).toBe("VALIDATE_FAILED");
    expect(generations()).toEqual([]);
    expect(readdirSync(backupDir).filter((n) => n.endsWith(".FAILED"))).toHaveLength(1);
  });

  it("refuses a run while a live holder owns the lock", () => {
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    chmodSync(backupDir, 0o700);
    const lock = join(backupDir, ".lock.d");
    mkdirSync(lock, { recursive: true, mode: 0o700 });
    // A holder that is genuinely alive, identified the way the script does:
    // pid plus host plus start time, so a reused pid cannot impersonate it.
    const holder = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      const start = existsSync(`/proc/${holder.pid}/stat`)
        ? readFileSync(`/proc/${holder.pid}/stat`, "utf8").split(" ")[21]
        : "";
      writeFileSync(join(lock, "pid"), `${holder.pid}\n`, "utf8");
      writeFileSync(join(lock, "host"), `${hostname()}\n`, "utf8");
      writeFileSync(join(lock, "starttime"), `${start}\n`, "utf8");
      expect(err(run())).toBe("LOCKED");
      expect(generations()).toEqual([]);
    } finally {
      holder.kill("SIGKILL");
    }
  });

  it("does not silently take a lock whose holder is gone", () => {
    // Automatic reclaim was racy in every variant tried: two runs can both judge
    // the same lock stale, and the second renames away the lock the first has
    // just re-created. Fail closed and name the escape instead.
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    chmodSync(backupDir, 0o700);
    const lock = join(backupDir, ".lock.d");
    mkdirSync(lock, { recursive: true, mode: 0o700 });
    writeFileSync(join(lock, "pid"), `${GONE_PID}\n`, "utf8");
    writeFileSync(join(lock, "host"), `${hostname()}\n`, "utf8");
    const r = run();
    expect(err(r)).toBe("LOCKED");
    expect(r.stderr, "the message must name the escape").toMatch(/rm -rf /);
    expect(generations()).toEqual([]);
  });

  it("names the exact removal the operator must perform", () => {
    // A SIGKILL, an OOM or a power loss leaves the lock behind with no live
    // holder. Treating that as contention disables the deployment's only backup
    // path permanently, and the operator finds out when the corpus stops moving.
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    chmodSync(backupDir, 0o700);
    const lock = join(backupDir, ".lock.d");
    mkdirSync(lock, { recursive: true, mode: 0o700 });
    writeFileSync(join(lock, "pid"), `${GONE_PID}\n`, "utf8");
    writeFileSync(join(lock, "host"), `${hostname()}\n`, "utf8");
    const r = run();
    expect(err(r)).toBe("LOCKED");
    // A flag would only have moved the same rm-then-mkdir race behind an opt-in.
    expect(r.stderr, "the message must be actionable without a flag").toMatch(/rm -rf /);
    expect(r.stderr).toContain(join(backupDir, ".lock.d"));
    expect(generations()).toEqual([]);
  });

  it("releases the lock so the next run succeeds", () => {
    expect(run().status).toBe(0);
    expect(existsSync(join(backupDir, ".lock.d"))).toBe(false);
    expect(run().status).toBe(0);
  });
});

// ─── C5: validation routing ─────────────────────────────────

describe("C5 validation routing", () => {
  it("does not fail a run whose archive has zero restorable entries", () => {
    // An empty database is a legitimate state — jackson before its first boot —
    // not a corruption signal.
    const r = run({}, { tocEntries: 0 });
    expect(r.status).toBe(0);
    const [gen] = generations();
    expect(readFileSync(join(backupDir, gen, "MANIFEST"), "utf8")).toMatch(/entries=0/);
    expect(r.stderr).toMatch(/no restorable entries/);
  });

  it("counts non-comment TOC lines only", () => {
    // The stub always emits three ';'-prefixed header lines. A raw line count
    // would report 3 here instead of 0, and the check would collapse into
    // "did pg_restore exit 0".
    run({}, { tocEntries: 0 });
    const [gen] = generations();
    expect(readFileSync(join(backupDir, gen, "MANIFEST"), "utf8")).toMatch(/passwd_sso\.dump size=\d+ entries=0/);
  });
});

// ─── C6: retention pruning ──────────────────────────────────

describe("C6 retention pruning", () => {
  const setup = (names) => {
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    chmodSync(backupDir, 0o700);
    names.forEach((n) => mkGeneration(n));
  };

  it("keeps exactly BACKUP_RETAIN generations including the new one", () => {
    setup(["20200101T000000Z", "20200102T000000Z", "20200103T000000Z",
           "20200104T000000Z", "20200105T000000Z", "20200106T000000Z",
           "20200107T000000Z", "20200108T000000Z", "20200109T000000Z", "20200110T000000Z"]);
    expect(run({ BACKUP_RETAIN: "7" }).status).toBe(0);
    expect(generations()).toHaveLength(7);
    expect(generations()).not.toContain("20200101T000000Z");
    expect(generations()).toContain("20200110T000000Z");
  });

  it("deletes nothing when the count is below or at the retention boundary", () => {
    setup(["20200101T000000Z", "20200102T000000Z"]);
    expect(run({ BACKUP_RETAIN: "5" }).status).toBe(0);
    expect(generations()).toHaveLength(3);
  });

  it("deletes exactly one at RETAIN+1", () => {
    setup(["20200101T000000Z", "20200102T000000Z", "20200103T000000Z"]);
    expect(run({ BACKUP_RETAIN: "3" }).status).toBe(0);
    expect(generations()).toHaveLength(3);
    expect(generations()).not.toContain("20200101T000000Z");
  });

  it("aborts when a generation cannot be removed", () => {
    // The second PRUNE_ABORTED emitter. `rm` is PATH-resolved, so a stub that
    // fails for ONE generation name and delegates everything else drives the
    // branch with no production change — the seam the deviation log named.
    // Replacing the clause with `|| true` keeps every other prune case green:
    // they all assert on what survived, and a removal that silently failed
    // leaves MORE behind, not less.
    setup(["20200101T000000Z", "20200102T000000Z", "20200103T000000Z"]);
    const real = spawnSync("sh", ["-c", "command -v rm"], { encoding: "utf8" }).stdout.trim();
    stub("rm", `
for a in "$@"; do
  case "$a" in 20200101T000000Z) exit 1 ;; esac
done
exec "${real}" "$@"`);
    const r = run({ BACKUP_RETAIN: "1" });
    expect(err(r), "a prune that could not complete is not a successful run")
      .toBe("PRUNE_ABORTED");
    expect(r.stderr).toMatch(/could not remove generation 20200101T000000Z/);
  });

  // ─── The stamp-retry arms ──────────────────────────────────
  //
  // `date` is PATH-resolved and the script calls it at exactly one site, so a
  // stub that hands out a taken stamp once and a free one afterwards makes the
  // collision deterministic. Pre-creating the name for the current second
  // proves nothing on a run that starts a second later.
  const dateStub = () => {
    const real = spawnSync("sh", ["-c", "command -v date"], { encoding: "utf8" }).stdout.trim();
    stub("date", `
case " $* " in
  *"+%Y%m%dT%H%M%SZ"*)
    n=0
    [ -f "${logFile}.datecalls" ] && n="$(cat "${logFile}.datecalls")"
    n=$((n + 1)); echo "$n" > "${logFile}.datecalls"
    if [ "$n" -le 1 ]; then echo 20250101T000000Z; else echo 20250101T000001Z; fi
    exit 0 ;;
esac
exec "${real}" "$@"`);
  };

  const takenName = (suffix) => {
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    chmodSync(backupDir, 0o700);
    const taken = join(backupDir, `20250101T000000Z${suffix}`);
    mkdirSync(taken, { recursive: true, mode: 0o700 });
    writeFileSync(join(taken, "MARKER"), "x", "utf8");
    dateStub();
    return taken;
  };

  it("retries the stamp when <stamp> is already taken", () => {
    const taken = takenName("");
    const r = run({ BACKUP_RETAIN: "5" });
    expect(r.status, r.stderr).toBe(0);
    expect(generations(), "the run lands on the next free stamp")
      .toContain("20250101T000001Z");
    expect(readdirSync(taken).sort(), "and writes nothing into the taken name")
      .toEqual(["MARKER"]);
  });

  it("retries the stamp when a .partial that could not be swept is still there", () => {
    // `prune_orphaned_partials` runs under the lock and removes every .partial
    // BEFORE the stamp is chosen, so on the ordinary path this arm is
    // unreachable — which is why nothing exercised it. What makes it reachable
    // is the sweep not REMOVING it. The clause has no `|| ` guard, so an rm that
    // exits non-zero aborts the run under `set -e`; the reachable shape is an
    // rm that reports success and removes nothing, which is what this stub is.
    // Reusing that name would have this run write into a directory another
    // run's remains are in.
    const taken = takenName(".partial");
    const real = spawnSync("sh", ["-c", "command -v rm"], { encoding: "utf8" }).stdout.trim();
    stub("rm", `
for a in "$@"; do
  case "$a" in 20250101T000000Z.partial) exit 0 ;; esac
done
exec "${real}" "$@"`);
    const r = run({ BACKUP_RETAIN: "5" });
    expect(r.status, r.stderr).toBe(0);
    expect(generations(), "the run lands on the next free stamp")
      .toContain("20250101T000001Z");
    expect(readdirSync(taken).sort(), "and writes nothing into the taken name")
      .toEqual(["MARKER"]);
  });

  it("retries the stamp when <stamp>.FAILED is already taken", () => {
    // The third arm, and the only one a SUCCESSFUL run cannot reach: .FAILED is
    // produced by the rename a failing run does, and `mv a b` with b an
    // existing directory moves a INTO b — so without this arm the previous
    // failure's diagnosis directory acquires the new one inside itself, and
    // both become unreadable as generations.
    const taken = takenName(".FAILED");
    dockerStub({ restoreFails: "1" });
    const r = run();
    expect(err(r)).toBe("VALIDATE_FAILED");
    expect(readdirSync(taken).sort(), "the earlier diagnosis must not be nested into")
      .toEqual(["MARKER"]);
    expect(existsSync(join(backupDir, "20250101T000001Z.FAILED")),
      "this failure gets a name of its own").toBe(true);
  });

  it("never prunes the run it just took, even when a future-dated generation exists", () => {
    // A clock step, a VM snapshot restore, or two hosts sharing one BACKUP_DIR
    // makes the new run the oldest NAME. A name-ordered pruner deletes the
    // backup it has just validated and exits 0.
    setup(["29991231T235959Z"]);
    const r = run({ BACKUP_RETAIN: "1" });
    expect(r.status).toBe(0);
    const gens = generations();
    const fresh = gens.filter((g) => g !== "29991231T235959Z");
    expect(fresh, "the just-taken run must survive").toHaveLength(1);
  });

  it("ignores entries that are not generations, and prunes real ones in the same run", () => {
    setup(["20200101T000000Z", "20200102T000000Z", "20200103T000000Z", "20200104T000000Z"]);
    mkdirSync(join(backupDir, "notes"), { recursive: true });
    writeFileSync(join(backupDir, "20200105T000000Z"), "a file, not a directory", "utf8");
    const outside = join(tmpDir, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "keepme"), "x", "utf8");
    symlinkSync(outside, join(backupDir, "20200106T000000Z"));

    expect(run({ BACKUP_RETAIN: "2" }).status).toBe(0);

    const names = readdirSync(backupDir);
    expect(names, "a non-generation directory is invisible to the pruner").toContain("notes");
    expect(names, "a regular file named like a generation is invisible").toContain("20200105T000000Z");
    expect(names, "a symlink named like a generation is invisible").toContain("20200106T000000Z");
    expect(existsSync(join(outside, "keepme")), "the symlink target must survive").toBe(true);
    expect(generations(), "real generations are still pruned in the same run").toHaveLength(2);
  });

  it("previews the deletion the real run would perform, not one fewer", () => {
    // The real run adds a generation before pruning. Previewing over the current
    // count says "nothing will be deleted" at exactly the boundary where the
    // real run deletes one.
    setup(["20200101T000000Z", "20200102T000000Z", "20200103T000000Z"]);
    const r = run({ BACKUP_RETAIN: "3", BACKUP_DRY_RUN: "true" });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/delete 1 of them/);
    expect(r.stdout).toContain("would delete 20200101T000000Z");
    expect(generations(), "a dry run creates nothing").toHaveLength(3);
    expect(readLog(), "a dry run dumps nothing").not.toMatch(/pg_dump|pg_dumpall/);
  });

  it("deletes no .FAILED archive during a dry run", () => {
    // The .FAILED prune runs before any dump on a real run. Placed before the
    // dry-run exit it would make a preview destroy real archives and then
    // report that it had destroyed nothing.
    setup([]);
    for (const n of ["20200101T000000Z.FAILED", "20200102T000000Z.FAILED", "20200103T000000Z.FAILED"]) {
      mkdirSync(join(backupDir, n), { recursive: true });
    }
    const r = run({ BACKUP_DRY_RUN: "true" });
    expect(r.status).toBe(0);
    expect(readdirSync(backupDir).filter((n) => n.endsWith(".FAILED"))).toHaveLength(3);
  });

  it("prunes .FAILED directories before any dump, not after publication", () => {
    // .FAILED is produced only by runs that did NOT publish, so pruning it after
    // publication never runs in a persistently failing deployment — the exact
    // state in which unvalidated plaintext dumps accumulate.
    setup([]);
    for (const n of ["20200101T000000Z.FAILED", "20200102T000000Z.FAILED", "20200103T000000Z.FAILED"]) {
      mkdirSync(join(backupDir, n), { recursive: true });
    }
    dockerStub({ restoreFails: "1" });
    run({ BACKUP_RETAIN: "2" });
    const failed = readdirSync(backupDir).filter((n) => n.endsWith(".FAILED"));
    // Exact, not an upper bound: `<= 2` also passes if the pruner deleted every
    // .FAILED including this run's, which is the opposite of the contract.
    // Three pre-seeded are pruned to BACKUP_RETAIN=2 before the dump, then this
    // run's own validation failure adds one.
    expect(failed.length, "retention applies to .FAILED, and this run's is kept").toBe(3);
  });
});

// ─── C7: credential and transport handling ──────────────────

describe("C7 credential and transport handling", () => {
  const urlEnv = (url, extra = {}) => ({
    MIGRATION_DATABASE_URL: url,
    ...extra,
  });

  const pgStubs = () => {
    for (const bin of ["pg_dump", "pg_dumpall"]) {
      stub(bin, `
echo "${bin} $* PGPASSWORD=[\${PGPASSWORD:-}] PGPASSFILE=[\${PGPASSFILE:-}] PGSSLMODE=[\${PGSSLMODE:-}]" >> "${logFile}"
[ -n "\${PGPASSFILE:-}" ] && cat -- "\${PGPASSFILE}" >> "${logFile}.pgpass"
out=""
prev=""
for a in "$@"; do [ "$prev" = "-f" ] && out="$a"; prev="$a"; done
if [ "${bin}" = "pg_dumpall" ]; then
  printf 'CREATE ROLE stub_role;\\n--\\n-- PostgreSQL database cluster dump complete\\n--\\n' > "$out"
else
  printf 'PGDMP-STUB' > "$out"
fi
exit 0`);
    }
    stub("pg_restore", `
echo "pg_restore $*" >> "${logFile}"
printf '; Archive created at 2026-01-01\\n1; 1259 1 TABLE public t owner\\n'
exit 0`);
    // URL mode asks the server what transport was actually negotiated rather
    // than trusting what was requested — libpq's gssencmode default would
    // otherwise satisfy a verify-full request over a non-TLS session.
    // Dispatches on the query, like its twin. A stub that answered every
    // invocation with the transport row made the cluster enumeration read that
    // row as a database list: every run through THIS stub recorded
    // `not_backed_up: hex:|TLSv1.3|…`, and no case here asserts on that field,
    // so the drift was invisible — the same defect round 5 fixed in the twin
    // and left standing here.
    stub("psql", `
echo "psql $* PGPASSFILE=[\${PGPASSFILE:-}]" >> "${logFile}"
case " $* " in
  *pg_database*) printf '${dbRow("passwd_sso")}\\n${dbRow("jackson")}\\n' ;;
  *)             printf 't|TLSv1.3|TLS_AES_256_GCM_SHA384\\n' ;;
esac
exit 0`);
  };

  it("keeps the password out of every argv, delivering it through a mode-0600 passfile", () => {
    pgStubs();
    const r = run(urlEnv(
      `postgresql://u:${encodeURIComponent(SENTINEL_PASSWORD)}@127.0.0.1:5432/passwd_sso?sslrootcert=/tmp/ca.pem`,
    ));
    expect(r.status).toBe(0);
    const log = readLog();
    // Not just pg_dump's argv: `env -i PGPASSWORD=<secret> pg_dump …` would put
    // the secret in env(1)'s own argv, which /proc/<pid>/cmdline exposes.
    expect(log, "the password must reach no argv and no environment variable")
      .not.toContain(SENTINEL_PASSWORD);
    expect(log).not.toContain(encodeURIComponent(SENTINEL_PASSWORD));
    expect(log).toMatch(/PGPASSWORD=\[\]/);
    // Paired allow case: the credential really was delivered, so the assertions
    // above are not passing on a script that never connects.
    const delivered = readFileSync(`${logFile}.pgpass`, "utf8");
    expect(delivered).toContain(SENTINEL_PASSWORD);
    const pgpassPath = log.match(/PGPASSFILE=\[([^\]]+)\]/)?.[1];
    expect(pgpassPath, "PGPASSFILE must be set").toBeTruthy();
  });

  it("pins the flags whose absence would silently change what is captured", () => {
    pgStubs();
    run(urlEnv("postgresql://u:p@127.0.0.1:5432/d?sslrootcert=/tmp/ca.pem"));
    const log = readLog();
    // --create carries the database-level ACLs (GRANT/REVOKE CONNECT); without
    // it a restore silently loses them. --no-role-passwords keeps SCRAM role
    // verifiers out of a plaintext backup. Neither is observable in the output,
    // so only an argv assertion can hold them.
    expect(log).toMatch(/pg_dump [^\n]*-Fc[^\n]*--create/);
    expect(log).toMatch(/pg_dumpall [^\n]*--globals-only[^\n]*--no-role-passwords/);
  });

  it("spawns no docker in URL mode", () => {
    pgStubs();
    run(urlEnv("postgresql://u:p@127.0.0.1:5432/passwd_sso?sslrootcert=/tmp/ca.pem"));
    expect(readLog()).not.toMatch(/^docker /m);
  });

  it("appends the TLS floor last so libpq's last-occurrence-wins settles it", () => {
    pgStubs();
    run(urlEnv("postgresql://u:p@127.0.0.1:5432/passwd_sso?sslmode=disable&sslrootcert=/tmp/ca.pem"));
    const dumpLine = readLog().split("\n").find((l) => l.startsWith("pg_dump ") && l.includes("-Fc"));
    // The operator's own parameters must still be THERE before their position
    // means anything. `indexOf` returns -1 for a missing needle and every index
    // beats -1, so the ordering assertion alone was satisfied by the whole query
    // having been discarded — under which sslrootcert= disappears too and the
    // floor cannot be met at all. Measured: a conninfo builder that dropped the
    // operator's query and put the floor FIRST kept the suite green.
    expect(dumpLine, "the operator's own query must survive").toContain("sslmode=disable");
    expect(dumpLine, "including the CA the floor needs").toContain("sslrootcert=/tmp/ca.pem");
    expect(dumpLine).toMatch(/sslmode=verify-full\b/);
    expect(dumpLine.lastIndexOf("sslmode=verify-full")).toBeGreaterThan(dumpLine.indexOf("sslmode=disable"));
  });

  it("disables GSSAPI encryption, which libpq negotiates BEFORE TLS", () => {
    // libpq's default is gssencmode=prefer and the GSS handshake happens first,
    // so a server offering GSSAPI gets an encrypted-but-unverified session that
    // the sslmode floor never governs. The correction was made in round 1 and
    // had no test: removing it entirely left the suite green.
    pgStubs();
    run(urlEnv("postgresql://u:p@127.0.0.1:5432/passwd_sso?sslrootcert=/tmp/ca.pem"));
    const dumpLine = readLog().split("\n").find((l) => l.startsWith("pg_dump ") && l.includes("-Fc"));
    expect(dumpLine, "gssencmode=disable must reach the conninfo").toContain("gssencmode=disable");
  });

  it("selects each target with dbname=, since PGDATABASE loses to the URL path", () => {
    pgStubs();
    run(urlEnv("postgresql://u:p@127.0.0.1:5432/ignored?sslrootcert=/tmp/ca.pem"));
    const log = readLog();
    expect(log).toMatch(/dbname=passwd_sso/);
    expect(log).toMatch(/dbname=jackson/);
  });

  it("does not leak the password into a bash -x trace", () => {
    pgStubs();
    const r = spawnSync("bash", ["-x", SCRIPT], {
      encoding: "utf8", timeout: 8000, cwd: REPO_ROOT,
      env: {
        PATH: `${binDir}:${process.env.PATH}`, HOME: homeDir, LANG: "C",
        BACKUP_DIR: backupDir,
        MIGRATION_DATABASE_URL: `postgresql://u:${SENTINEL_PASSWORD}@127.0.0.1:5432/d?sslrootcert=/tmp/ca.pem`,
      },
    });
    const trace = r.stdout + r.stderr;
    expect(trace).not.toContain(SENTINEL_PASSWORD);
    // Paired case: the trace was actually produced, so the assertion above is
    // not passing on an empty string.
    expect(trace).toMatch(/\+ /);
  });

  it("rejects malformed and over-specified URLs with distinct causes", () => {
    pgStubs();
    expect(err(run(urlEnv("notaurl")))).toBe("BAD_URL");
    expect(err(run(urlEnv("postgresql://u:p@h/d?dbname=x&sslrootcert=/x")))).toBe("BAD_URL");
    expect(err(run(urlEnv("postgresql://u:p@h/d?gssencmode=require&sslrootcert=/x")))).toBe("BAD_URL");
    expect(err(run(urlEnv("postgresql://u:p@h:5432/d")))).toBe("NO_CA");
  });

  it("accepts the URL forms a whole-URI regex would reject", () => {
    pgStubs();
    for (const url of [
      "postgresql://u:p@host/d?sslrootcert=/x",          // no port
      "postgresql://u@host:5432/d?sslrootcert=/x",       // no password
      "postgresql://u:p@[fd7a::1]:5432/d?sslrootcert=/x", // IPv6 literal
      "postgres://u:p@h1:5432,h2:5432/d?sslrootcert=/x",  // multi-host
    ]) {
      const r = run(urlEnv(url));
      expect(r.status, `${url} should be accepted`).toBe(0);
      rmSync(backupDir, { recursive: true, force: true });
    }
  });
});

// ─── Source-level contracts ─────────────────────────────────

describe("source-level contracts", () => {
  /** Executable lines only: a forbidden pattern must not fire on prose. */
  const src = () =>
    readFileSync(SCRIPT, "utf8")
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");

  const forbidden = [
    { re: /^\s*set -e\s*$/m, why: "must be the full set -euo pipefail",
      control: "set -e" },
    { re: /\|\s*grep -q/, why: "check-no-pipe-into-grep-q forbids the SIGPIPE-inverting shape",
      control: 'docker compose ps | grep -q x' },
    { re: /rm +-rf +"?\$\{?BACKUP_DIR\}?"? *$/m, why: "the backup root is never a removal target",
      control: 'rm -rf "$BACKUP_DIR"' },
    { re: /\beval\b/, why: "eval over a decoded secret is command execution",
      control: 'eval "$x"' },
    { re: /(echo|printf|tee|env|declare -p)[^\n]*MIGRATION_DATABASE_URL/, why: "no credential to any output sink",
      control: 'echo "$MIGRATION_DATABASE_URL"' },
    { re: /pg_dump[^\n]*\$\{?MIGRATION_DATABASE_URL/, why: "only the stripped URL reaches argv",
      control: 'pg_dump -d "$MIGRATION_DATABASE_URL"' },
  ];

  for (const { re, why, control } of forbidden) {
    it(`is free of ${re} — ${why}`, () => {
      expect(src()).not.toMatch(re);
      // Positive control: the pattern is a real matcher, not a typo that can
      // never match anything.
      expect(control, "the pattern must match a plausible violation").toMatch(re);
    });
  }

  it("validates every environment variable its usage header documents", () => {
    // Raw source: the documented member set lives in the usage comment block,
    // which the forbidden-pattern reader deliberately strips.
    //
    // INV-C1a says every variable in the table is VALIDATED before a process is
    // spawned. Asserting only that a default expansion exists does not say
    // that: BACKUP_MOUNTINFO_PATH was documented, read, and reached a
    // line-oriented sink with no validation branch anywhere, and this case
    // passed the whole time. So each documented variable must also reach a
    // GUARD — one of the four shapes this script validates with. Not "must be
    // in the INV-C1a block": PGSSLROOTCERT is legitimately guarded where the
    // TLS floor is decided, and BACKUP_DATABASES is validated per member inside
    // the loop that splits it.
    const s = readFileSync(SCRIPT, "utf8");
    const documented = [...s.matchAll(/^#\s{3}([A-Z][A-Z0-9_]+)\s+\(optional\)/gm)].map((m) => m[1]);
    expect(documented.length).toBeGreaterThan(5);
    // The five shapes: a `case` arm, a `[[ =~ ]]` match, a presence test, an
    // equality test (the boolean flags), and a split-then-validate loop.
    const guarded = (src, v) => new RegExp(
      `(case "\\$\\{?${v}[}"]`
      + `|\\[\\[ "\\$\\{?${v}[}"]`
      + `|\\[ -[nz] "\\$\\{?${v}`
      + `|\\[ "\\$${v}" `
      + `|for [A-Za-z_]+ in \\$\\{?${v}\\b)`,
    ).test(src);
    for (const v of documented) {
      expect(s, `${v} is documented but never read with a default`).toMatch(
        new RegExp(`\\$\\{${v}:?[-+]`),
      );
      expect(guarded(s, v), `${v} is documented but reaches no guard (INV-C1a)`).toBe(true);
    }
    // Positive control: a variable that is only ever read with a default, and
    // never guarded, must NOT satisfy the rule — otherwise this assertion is
    // the one it replaced.
    expect(guarded('X="${BACKUP_NEW_THING:-/tmp/x}"\necho "$BACKUP_NEW_THING"', "BACKUP_NEW_THING"),
      "the guard pattern must not match a bare default expansion").toBe(false);
  });

  it("uses no utility the portability floor excludes", () => {
    // macOS is the primary operator host: /bin/bash is 3.2 and coreutils are BSD.
    // Each pattern carries a positive control, per INV-C9d: without one a typo'd
    // regex (`/\bmapfle\b/`) passes vacuously and the floor stops being enforced
    // with no signal. The block above already does this; this one did not.
    const banned = [
      { re: /\bmapfile\b/, control: "mapfile -t names < list" },
      { re: /\breadarray\b/, control: "readarray names < list" },
      { re: /\breadlink -f\b/, control: 'p="$(readlink -f "$x")"' },
      { re: /\bflock\b/, control: "flock 9" },
    ];
    for (const { re, control } of banned) {
      expect(src()).not.toMatch(re);
      expect(control, `${re} must match a plausible violation`).toMatch(re);
    }
  });
});

// ─── Group B: the real archive reader ───────────────────────

describe("Group B — validation by a real pg_restore", () => {
  /** Host binary first, else the compose db service. Never a stub. */
  const reader = (() => {
    const host = spawnSync("pg_restore", ["--version"], { encoding: "utf8" });
    if (host.status === 0) {
      return { kind: "host", list: (f) => spawnSync("pg_restore", ["--list", f], { encoding: "utf8" }), version: host.stdout.trim() };
    }
    const svc = spawnSync("docker", ["compose", "exec", "-T", "--", "db", "pg_restore", "--version"],
      { encoding: "utf8", cwd: REPO_ROOT, timeout: 20000 });
    if (svc.status === 0) {
      return {
        kind: "compose",
        version: svc.stdout.trim(),
        list: (f) => spawnSync("docker",
          ["compose", "exec", "-T", "--", "db", "pg_restore", "--list"],
          { encoding: "utf8", cwd: REPO_ROOT, timeout: 20000, input: readFileSync(f) }),
      };
    }
    return null;
  })();

  it("has a real archive reader available", () => {
    // Deliberately a failure rather than a skip: a skipped test for the
    // invariant the script exists to deliver reads as coverage.
    expect(
      reader,
      "no pg_restore reachable — install postgresql-client or start the compose db service",
    ).not.toBeNull();
    // Recorded, because WHICH reader was discovered decides how the delegating
    // cases run, and "115 passed" locally and in CI otherwise describe two
    // different suites with no way to tell them apart from the log.
    console.log(`[Group B] reader kind=${reader.kind} version=${JSON.stringify(reader.version)}`);
    // And asserted when CI declares what it expects, so a runner image that
    // drops the client is a red rather than a silent change of shape.
    const expected = process.env.BACKUP_DB_EXPECT_READER;
    if (expected) {
      expect(reader.kind, `CI declared BACKUP_DB_EXPECT_READER=${expected}`).toBe(expected);
    }
    const major = Number(reader.version.match(/\)\s*(\d+)/)?.[1] ?? 0);
    // Anchored on the MAJOR component: a /\b(1[6-9]|[2-9]\d)\b/ over the whole
    // string is satisfied by the minor number, so "13.22" would pass.
    expect(major, `reader too old: ${reader.version}`).toBeGreaterThanOrEqual(16);
  });

  it("reads a real archive and reports non-comment entries", () => {
    const r = reader.list(join(FIXTURES, "valid.pgdump"));
    expect(r.status).toBe(0);
    const entries = r.stdout.split("\n").filter((l) => l && !l.startsWith(";"));
    expect(entries.length).toBeGreaterThan(0);
  });

  it("rejects a truncated archive that a byte-count check would accept", () => {
    const f = join(FIXTURES, "truncated.pgdump");
    expect(statSync(f).size).toBeGreaterThan(0);
    expect(reader.list(f).status).not.toBe(0);
  });

  it("rejects a zero-byte archive", () => {
    expect(reader.list(join(FIXTURES, "empty.pgdump")).status).not.toBe(0);
  });

  /**
   * A docker stub that delegates `pg_restore` to a REAL reader — the host
   * binary when one exists, otherwise real docker. Branching on which reader is
   * available would make the case a no-op in whichever environment has the
   * other one, and CI is the environment with the host binary.
   */
  const delegatingStub = (archive) => {
    const realDocker = spawnSync("sh", ["-c", "command -v docker"], { encoding: "utf8" }).stdout.trim();
    const hostRestore = spawnSync("sh", ["-c", "command -v pg_restore"], { encoding: "utf8" }).stdout.trim();
    // Docker Desktop keeps its `compose` CLI plugin under $HOME/.docker, and
    // run() hands the script a STUBBED HOME so that a case exercising the
    // default BACKUP_DIR cannot prune the developer's real backups. On macOS
    // that combination hid the plugin: `docker compose exec -T …` was parsed as
    // a top-level `-T` and this case — the only one that runs the production
    // reader invocation — failed on the verification host, which is the
    // platform Group B exists to cover. Linux keeps the plugin in a system
    // directory, so it passed there and the gap was invisible. DOCKER_CONFIG is
    // the narrow knob: the real docker finds its plugin, the script's HOME stays
    // stubbed.
    const dockerConfig = process.env.DOCKER_CONFIG || join(homedir(), ".docker");
    stub("docker", `
if [ "\${2:-}" = "config" ]; then exit 0; fi
if [ "\${2:-}" = "ps" ]; then echo container123; exit 0; fi
for a in "$@"; do
  case "$a" in
    pg_dump)     cat -- "${archive}"; exit 0 ;;
    pg_dumpall)  printf 'CREATE ROLE r;\\n-- PostgreSQL database cluster dump complete\\n'; exit 0 ;;
    pg_restore)
      echo "DELEGATED" >> "${logFile}"
      if [ -n "${hostRestore}" ]; then
        # Drop the "compose exec -T -- <svc>" prefix and hand the remaining
        # arguments — including the deliberate absence of a filename — to the
        # host reader, so the production invocation shape is what runs.
        shift_to_pg=0
        args=()
        for x in "$@"; do
          [ "$shift_to_pg" = 1 ] && args+=("$x")
          [ "$x" = "pg_restore" ] && shift_to_pg=1
        done
        exec "${hostRestore}" "\${args[@]}"
      fi
      exec env "DOCKER_CONFIG=${dockerConfig}" "${realDocker}" "$@" ;;
  esac
done
exit 0`);
  };

  it("publishes a VALID archive through the script's own reader invocation", () => {
    // This is the case that reds on a regressed invocation. Naming /dev/stdin
    // as pg_restore's file argument makes it seek a non-seekable descriptor and
    // fail on every valid archive — and a truncated-archive case cannot see
    // that, because it fails either way.
    expect(reader, "a real archive reader is required — the delegating stub needs one").not.toBeNull();
    delegatingStub(join(FIXTURES, "valid.pgdump"));
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(readLog(), "the real reader must have been reached").toContain("DELEGATED");
    expect(generations()).toHaveLength(1);
    const manifest = readFileSync(join(backupDir, generations()[0], "MANIFEST"), "utf8");
    expect(manifest, "the entry count must come from the real archive").toMatch(/entries=[1-9]/);
  });

  it("routes a truncated archive to VALIDATE_FAILED through the script's own reader", () => {
    // The other Group B cases call pg_restore directly, which proves the oracle
    // but not that the script reaches it: reintroducing `--list /dev/stdin`
    // into the script — the footgun that fails on every valid archive — left
    // them all green. This case runs the script with a docker stub that
    // DELEGATES pg_restore to the real docker, so the production invocation is
    // the thing under test.
    // Uses the SHARED delegating stub. It previously carried a hand-copied
    // duplicate plus an early return on `reader.kind !== "compose"`, so on any
    // host with a pg_restore — every CI runner — the body executed zero
    // assertions and reported PASS. The round-3 fix for exactly this shape
    // landed on the sibling case above and not on this twin.
    expect(reader, "a real archive reader is required — the delegating stub needs one").not.toBeNull();
    delegatingStub(join(FIXTURES, "truncated.pgdump"));
    const r = run({}, {});
    expect(err(r)).toBe("VALIDATE_FAILED");
    expect(readLog(), "the real reader must have been reached").toContain("DELEGATED");
    expect(readdirSync(backupDir).filter((n) => n.endsWith(".FAILED"))).toHaveLength(1);
    expect(generations()).toEqual([]);
  });

  it("distinguishes a complete globals dump from a truncated one by its marker", () => {
    const marker = "PostgreSQL database cluster dump complete";
    expect(readFileSync(join(FIXTURES, "globals-valid.sql"), "utf8")).toContain(marker);
    expect(readFileSync(join(FIXTURES, "globals-truncated.sql"), "utf8")).not.toContain(marker);
  });
});

// ─── C8: documentation ──────────────────────────────────────

describe("C8 documentation", () => {
  // No gate enforces these edits on an ordinary PR: check-doc-paths.mjs is
  // invoked only by refactor-phase-verify.mjs, whose workflow triggers on
  // refactor/** and merge_group. Asserting the references here is what moves
  // them from author obligation to a red build.
  const DOCS = [
    "CLAUDE.md",
    "docs/operations/backup-recovery/en.md",
    "docs/operations/backup-recovery/ja.md",
    "docs/operations/dev-host-migration.md",
    "docs/operations/incident-runbook.md",
  ];

  it("is reachable on a PR that changes only these documents", () => {
    // The comment above says asserting the references here turns them into a red
    // build. That holds only if the suite RUNS. `ci.yml`'s `app:` filter and
    // `pre-pr.sh`'s `app_paths` (kept in lockstep, R33) both gate the Web steps,
    // and neither listed `docs/`, so a docs-only PR ran neither gate — the
    // assertions above reported nothing on exactly the change they exist to
    // catch, and SC5's justification for not wiring check-doc-paths.mjs rests on
    // them. Pinned in both files because the lockstep is a comment, not a check.
    const ci = readFileSync(resolve(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
    // Scoped to the `filters:` literal and split on the NEXT key inside it. A
    // whole-file split cuts at the `extension:` in the job's `outputs:` block,
    // which comes first — measured: the slice ended 372 bytes in, before the
    // filter list existed.
    const filters = ci.slice(ci.indexOf("filters: |"));
    const app = filters.slice(filters.indexOf("app:"), filters.indexOf("extension:"));
    expect(app, "ci.yml's app filter must reach the documents this describe asserts")
      .toMatch(/^[ \t]*- "docs\/operations\/\*\*"$/m);
    const prePr = readFileSync(resolve(REPO_ROOT, "scripts/pre-pr.sh"), "utf8");
    const paths = prePr.match(/^\s*local app_paths='(.+)'$/m)?.[1];
    expect(paths, "pre-pr.sh must declare app_paths").toBeDefined();
    // EVERY member of DOCS, not one representative: `CLAUDE.md` could be
    // dropped from both gate files with the suite green, and the case that
    // asserts CLAUDE.md points at the script would then never run.
    for (const rel of DOCS) {
      expect(new RegExp(paths).test(rel), `app_paths must match ${rel}, got ${paths}`).toBe(true);
    }
    expect(app, "ci.yml's app filter must reach CLAUDE.md")
      .toMatch(/^[ \t]*- "CLAUDE\.md"$/m);
    // Positive control: the same regex must NOT match an unrelated path, or a
    // catch-all would satisfy the assertion above without gating anything.
    expect(new RegExp(paths).test("ios/project.yml")).toBe(false);
  });

  for (const rel of DOCS) {
    it(`${rel} points operators at the script`, () => {
      const text = readFileSync(resolve(REPO_ROOT, rel), "utf8");
      // The invocation, not the bare path: a doc that merely names the file in
      // a "do not use this" sentence would satisfy a path-only check.
      expect(text).toMatch(/scripts\/backup-db\.sh/);
    });
  }

  it("keeps the bilingual pair in step, per docs/operations/language-policy.md", () => {
    const en = readFileSync(resolve(REPO_ROOT, "docs/operations/backup-recovery/en.md"), "utf8");
    const ja = readFileSync(resolve(REPO_ROOT, "docs/operations/backup-recovery/ja.md"), "utf8");
    // A content property both files must hold, not a diff property: a test
    // reads file content, and "both changed" is only visible against a base ref.
    for (const invocation of ["scripts/backup-db.sh", "BACKUP_DIR=", "BACKUP_RETAIN=", "BACKUP_DRY_RUN=true"]) {
      expect(en, `en.md must document ${invocation}`).toContain(invocation);
      expect(ja, `ja.md must document ${invocation}`).toContain(invocation);
    }
  });
});


// ─── Guards the mutation sweep found unpinned ───────────────
//
// A mutation sweep put the suite's kill rate at 31%: nearly every guard added
// after the first review round could be deleted with the suite still green. The
// dominant single cause was the sentinel — one password containing none of
// `:` `\` `/` `?` `#` `%` or a newline cannot exercise any guard that exists
// because those bytes are dangerous.

describe("credential-shaped inputs", () => {
  const CA = "sslrootcert=/tmp/ca.pem";
  const url = (userinfo, query = "") =>
    `postgresql://${userinfo}@127.0.0.1:5432/d?${CA}${query}`;

  const pgStubs = () => {
    for (const bin of ["pg_dump", "pg_dumpall"]) {
      stub(bin, `
echo "${bin} $* PGPASSWORD=[\${PGPASSWORD:-}] PGSSLMODE=[\${PGSSLMODE:-}] PGHOST=[\${PGHOST:-}] PGSERVICE=[\${PGSERVICE:-}]" >> "${logFile}"
[ -n "\${PGPASSFILE:-}" ] && cat -- "\${PGPASSFILE}" >> "${logFile}.pgpass"
out=""; prev=""
for a in "$@"; do [ "$prev" = "-f" ] && out="$a"; prev="$a"; done
if [ "${bin}" = "pg_dumpall" ]; then
  printf 'CREATE ROLE r;\\n-- PostgreSQL database cluster dump complete\\n' > "$out"
else
  printf 'PGDMP' > "$out"
fi
exit 0`);
    }
    stub("pg_restore", `printf '; h\\n1; 1 TABLE t o\\n'
exit 0`);
    // Dispatches on the query. A stub that answers every invocation with the
    // transport row made the cluster enumeration read that row as a database:
    // every URL-mode run recorded `not_backed_up: hex:|TLSv1.3|AESGCM`, and
    // because no URL-mode case asserted on that field it was invisible — while
    // leaving the URL-mode enumeration branch with no valid-payload test at all.
    stub("psql", `
echo "psql $*" >> "${logFile}"
case " $* " in
  *pg_database*) printf '${dbRow("passwd_sso")}\\n${dbRow("jackson")}\\n' ;;
  *)             printf 't|TLSv1.3|AESGCM\\n' ;;
esac
exit 0`);
  };

  // Derived from the script's own refusal list, not from memory: every
  // parameter libpq accepts that carries a credential, redirects the peer, or
  // selects a transport the TLS floor cannot govern.
  const REFUSED_PARAMS = [
    "password", "passfile", "service", "oauth_client_secret", "sslpassword",
    "sslkeylogfile", "scram_client_key", "scram_server_key",
    "host", "hostaddr", "gssencmode", "dbname",
    // libpq accepts `port` as a URI parameter and lets it override the
    // authority's, while the passfile is scoped to the port the AUTHORITY
    // names — so `…@host/db?port=6543` connected to 6543 and found no entry.
    "port",
  ];

  it("drives every parameter the SCRIPT refuses, not a list copied beside it", () => {
    // A hand-copied list measures the copy. Derive the arms from the source, so
    // a parameter added to the script with no case here fails this rather than
    // being silently unmeasured.
    const src = readFileSync(SCRIPT, "utf8");
    const block = src.split("for _kv in $raw_query; do")[1]?.split("\n      esac")[0];
    expect(block, "the query refusal block must be locatable in the script").toBeDefined();
    const derived = [...block.matchAll(/^\s+([a-z_]+(?:\|[a-z_]+)*)\)\s*$/gm)]
      .flatMap((m) => m[1].split("|"));
    expect(derived.length, "the script must refuse something").toBeGreaterThan(5);
    expect([...new Set(derived)].sort(), "the suite must drive exactly the script's set")
      .toEqual([...new Set(REFUSED_PARAMS)].sort());
  });

  it("refuses every credential-, peer- and transport-selecting query parameter", () => {
    pgStubs();
    for (const param of REFUSED_PARAMS) {
      expect(err(run({ MIGRATION_DATABASE_URL: url("u:p", `&${param}=x`) })),
        `${param}= must be refused`).toBe("BAD_URL");
      rmSync(backupDir, { recursive: true, force: true });
    }
  });

  it("refuses them percent-encoded too, because libpq decodes the keyword first", () => {
    pgStubs();
    // %70assword, %68ost, %67ssencmode … a raw-string match sees none of these.
    const encoded = { password: "%70assword", host: "%68ost", gssencmode: "%67ssencmode" };
    for (const [name, spelling] of Object.entries(encoded)) {
      expect(err(run({ MIGRATION_DATABASE_URL: url("u:p", `&${spelling}=x`) })),
        `${spelling}= (${name}) must be refused`).toBe("BAD_URL");
      rmSync(backupDir, { recursive: true, force: true });
    }
  });

  it("passes -X to psql on the URL-mode diagnostic re-run, which only a failure reaches", () => {
    // The fifth site. It runs the same query a second time to capture stderr,
    // so a `-X` dropped there re-opens ~/.psqlrc on precisely the path where
    // the operator is reading the output to decide what went wrong.
    pgStubs();
    stub("psql", `
echo "psql $*" >> "${logFile}"
case " $* " in
  *pg_database*) echo "FATAL: connection refused" >&2; exit 1 ;;
  *)             printf 't|TLSv1.3|AESGCM\\n' ;;
esac
exit 0`);
    const r = run({ MIGRATION_DATABASE_URL: url("u:p") });
    expect(r.status, r.stderr).toBe(0);
    const calls = readLog().split("\n")
      .filter((l) => l.startsWith("psql ") && l.includes("pg_database"));
    expect(calls.length, "the enumeration and its diagnostic re-run").toBeGreaterThanOrEqual(2);
    for (const c of calls) {
      expect(c, `psql invoked without -X: ${c}`).toMatch(/(^|\s)-X(\s|$)/);
    }
    expect(r.stderr).toMatch(/FATAL: connection refused/);
  });

  it("refuses only the PARAMETER, not any value that spells one", () => {
    pgStubs();
    // The refusal used to percent-decode the whole query and match substrings,
    // so the boundary was decided by whatever bytes happened to precede a
    // keyword: `re|port=`, `g|host=`, `my|dbname=`. A legal conninfo was denied.
    // The member set is every refused name that is a substring of something a
    // value can legally contain — one spelling per refused name that has one,
    // plus a percent-encoded value, which only the KEY is decoded from now.
    for (const value of ["report=1", "ghost=1", "mydbname=1", "mypassword=1",
                         "%70assword=1"]) {
      const r = run({ MIGRATION_DATABASE_URL: url("u:p", `&application_name=${value}`) });
      expect(r.status, `application_name=${value} is a legal conninfo: ${r.stderr}`).toBe(0);
      rmSync(backupDir, { recursive: true, force: true });
    }
  });

  it("refuses a parameter whose ENCODED key spells a refused one after the split", () => {
    pgStubs();
    // The paired deny case. Splitting on the RAW `&` first is what keeps a
    // `%26` inside a value from forging a parameter boundary, so the key is
    // taken before decoding and decoded after — `%70assword` as a KEY is still
    // `password`, while `%26port=x` inside a value is not a parameter at all.
    expect(err(run({ MIGRATION_DATABASE_URL: url("u:p", "&%70assword=x") })),
      "an encoded key is the parameter libpq will act on").toBe("BAD_URL");
    rmSync(backupDir, { recursive: true, force: true });
    expect(run({ MIGRATION_DATABASE_URL: url("u:p", "&application_name=a%26port=x") }).status,
      "an encoded ampersand is a byte in a value, not a parameter boundary").toBe(0);
  });

  it("refuses a raw delimiter in the userinfo instead of passing the URL through", () => {
    pgStubs();
    // The authority is cut at the first / ? #, so a raw one of these moves the
    // '@' past the cut and the mandatory strip cannot fire. Falling through
    // would hand the whole URL, password included, to pg_dump's argv.
    for (const pw of ["pa/ss", "pa?ss", "pa#ss"]) {
      expect(err(run({ MIGRATION_DATABASE_URL: url(`u:${pw}`) })),
        `${pw} must be refused`).toBe("BAD_URL");
      rmSync(backupDir, { recursive: true, force: true });
    }
  });

  it("refuses an encoded newline or NUL, which .pgpass cannot represent", () => {
    pgStubs();
    for (const pw of ["s%0A", "s%0D", "s%00"]) {
      expect(err(run({ MIGRATION_DATABASE_URL: url(`u:${pw}`) })), `${pw}`).toBe("BAD_URL");
      rmSync(backupDir, { recursive: true, force: true });
    }
  });

  it("escapes .pgpass syntax and narrows the entry to the authority", () => {
    pgStubs();
    // pa:ss\x — the two bytes .pgpass gives syntactic meaning, which the old
    // single sentinel contained neither of.
    const r = run({ MIGRATION_DATABASE_URL: url("u:pa%3Ass%5Cx") });
    expect(r.status, r.stderr).toBe(0);
    const line = readFileSync(`${logFile}.pgpass`, "utf8").split("\n")[0];
    expect(line, "the colon and backslash must be escaped").toBe("127.0.0.1:5432:*:*:pa\\:ss\\\\x");
    expect(line, "a wildcard host would offer the password to any peer").not.toMatch(/^\*:\*:/);
  });

  it("delivers the password only through a mode-0600 file inside the audited root", () => {
    stub("pg_dump", `
echo "pg_dump $* PGPASSWORD=[\${PGPASSWORD:-}]" >> "${logFile}"
case "$(uname -s)" in
  Darwin|*BSD) stat -f '%Lp %N' -- "\${PGPASSFILE}" >> "${logFile}.stat" ;;
  *)           stat -c '%a %n'  -- "\${PGPASSFILE}" >> "${logFile}.stat" ;;
esac
out=""; prev=""; for a in "$@"; do [ "$prev" = "-f" ] && out="$a"; prev="$a"; done
printf 'PGDMP' > "$out"
exit 0`);
    stub("pg_dumpall", `
out=""; prev=""; for a in "$@"; do [ "$prev" = "-f" ] && out="$a"; prev="$a"; done
printf 'CREATE ROLE r;\\n-- PostgreSQL database cluster dump complete\\n' > "$out"
exit 0`);
    stub("pg_restore", `printf '; h\\n1; 1 TABLE t o\\n'
exit 0`);
    stub("psql", `printf 't|TLSv1.3|AESGCM\\n'
exit 0`);
    const r = run({ MIGRATION_DATABASE_URL: url("u:S3cr3t") });
    expect(r.status, r.stderr).toBe(0);
    const statLine = readFileSync(`${logFile}.stat`, "utf8").split("\n")[0];
    expect(statLine, "mode must be 0600 at the time the child reads it").toMatch(/^600 /);
    expect(statLine, "the credential belongs in the one audited directory").toContain(backupDir);
    expect(readdirSync(backupDir).filter((n) => n.startsWith(".pgpass")),
      "and must not outlive the run").toEqual([]);
  });

  it("neutralises an ambient libpq environment rather than passing it through", () => {
    pgStubs();
    // Asserting PGPASSWORD=[] against an unset parent proves nothing: replacing
    // `env -i <allowlist>` with plain `env` would pass too.
    const r = run({
      MIGRATION_DATABASE_URL: url("u:p"),
      PGPASSWORD: "leak-me", PGSSLMODE: "disable", PGHOST: "evil.example",
      PGSERVICE: "svc", PGGSSENCMODE: "require",
    });
    expect(r.status, r.stderr).toBe(0);
    // Each ambient variable was set in the parent above, so an empty value in
    // the child is evidence of the allowlist, not of the parent being unset.
    for (const v of ["PGPASSWORD", "PGSSLMODE", "PGHOST", "PGSERVICE"]) {
      expect(readLog(), `${v} must not reach the child`).toContain(`${v}=[]`);
    }
  });

  it("records the transport the server reports, not the one requested", () => {
    pgStubs();
    run({ MIGRATION_DATABASE_URL: url("u:p") });
    const [gen] = generations();
    expect(readFileSync(join(backupDir, gen, "MANIFEST"), "utf8")).toMatch(/achieved_tls: TLSv1\.3/);
  });

  it("keeps the achieved transport on ONE MANIFEST line, at LF and at CR", () => {
    // ACHIEVED_TLS is whatever psql printed with the leading `t|` removed, so
    // everything after the first row travels with it into a line-oriented
    // record. first_line trims at both bytes; the CR arm is the one a check
    // that only looked for \n leaves open, and a lone CR still ends the line
    // for anything reading the MANIFEST back.
    pgStubs();
    // Dispatches on the query. A stub that answers every invocation with the
    // transport row feeds that row to the cluster enumeration as a database
    // list — the drift this same diff removed from pgStubs, re-created here.
    stub("psql", `
case " $* " in
  *pg_database*) printf '${dbRow("passwd_sso")}\\n${dbRow("jackson")}\\n' ;;
  *)             printf 't|TLSv1.3|AESGCM\\rCARRIAGE\\nSECOND-ROW\\n' ;;
esac
exit 0`);
    const r = run({ MIGRATION_DATABASE_URL: url("u:p") });
    expect(r.status, r.stderr).toBe(0);
    const manifest = readFileSync(join(backupDir, generations()[0], "MANIFEST"), "utf8");
    expect(manifest.split("\n").filter((l) => l.startsWith("achieved_tls:")))
      .toEqual(["achieved_tls: TLSv1.3|AESGCM"]);
    expect(manifest, "nothing past the CR may reach the record").not.toContain("CARRIAGE");
    expect(manifest, "nor anything past the LF").not.toContain("SECOND-ROW");
  });

  it("refuses a port that merely STARTS with digits", () => {
    // `[0-9]*` as a glob is "starts with a digit", which admits 5432evil — and
    // the passfile entry is scoped to the port the authority names, so a port
    // libpq reads differently from this script means the entry never matches.
    pgStubs();
    expect(err(run({ MIGRATION_DATABASE_URL: `postgresql://u:p@127.0.0.1:5432evil/d?${CA}` })),
      "an anchored match is the whole string").toBe("BAD_URL");
  });

  it("checks the passfile's mode while it is still EMPTY", () => {
    // The order is the property: mktemp creates the file empty, so the check
    // that decides whether the mode is private runs before the password is in
    // it. Moving the call after the write keeps every other assertion green —
    // nothing else observes the file's size at check time.
    pgStubs();
    const real = spawnSync("sh", ["-c", "command -v stat"], { encoding: "utf8" }).stdout.trim();
    stub("stat", `
last=""
for a in "$@"; do last="$a"; done
case "$last" in
  *.pgpass.*)
    case " $* " in
      *" %a "*|*"\'%Lp\'"*|*" %Lp "*)
        wc -c < "$last" | tr -d ' ' >> "${logFile}.pgpasssize" ;;
    esac ;;
esac
exec "${real}" "$@"`);
    const r = run({ MIGRATION_DATABASE_URL: url("u:p") });
    expect(r.status, r.stderr).toBe(0);
    const sizes = readFileSync(`${logFile}.pgpasssize`, "utf8").trim().split("\n");
    expect(sizes[0], "the mode is checked before the credential is written").toBe("0");
  });

  it("fails when the server reports an unencrypted session", () => {
    pgStubs();
    stub("psql", `printf 'f||\\n'
exit 0`);
    // Not DUMP_FAILED: nothing was dumped, and the code has to separate "could
    // not connect / not encrypted" from "the dump command failed".
    expect(err(run({ MIGRATION_DATABASE_URL: url("u:p") }))).toBe("CONNECT_FAILED");
    expect(generations()).toEqual([]);
  });

  it("surfaces libpq's diagnostic instead of collapsing every fault into one line", () => {
    // This probe is the first thing that touches the database in URL mode, so a
    // missing CA, a wrong host, a rejected password and a server with TLS off
    // all arrive here — and discarding stderr made them indistinguishable on
    // exactly the path being configured for the first time.
    pgStubs();
    stub("psql", `echo 'psql: error: root certificate file "/x" does not exist' >&2
exit 2`);
    const r = run({ MIGRATION_DATABASE_URL: url("u:p") });
    expect(err(r)).toBe("CONNECT_FAILED");
    expect(r.stderr).toMatch(/root certificate file/);
  });

  it("refuses an authority the passfile cannot be scoped to", () => {
    // The newline refusal and the escaping covered the password field only, so
    // the host slice reached the same line-oriented credential file unchecked:
    // an empty host became the wildcard entry the narrowing exists to prevent,
    // and a newline injected a second .pgpass line.
    pgStubs();
    // The member set is "a COMPUTED host that .pgpass reads as a wildcard", not
    // "an authority spelled with nothing before the slash". `u:p@:5432` and
    // `u:p@*` produce the same wildcard entry as `u:p@`; the first was fixed in
    // round 4 with no test, so reverting the fix to the spelling-based form
    // survived, and the second was never closed at all.
    for (const authority of ["u:p@", "u:p@:5432", "u:p@:", "u:p@*", "u:p@*:5432",
                             "u:p@h\n*", "u:p@a:b:5432"]) {
      expect(err(run({ MIGRATION_DATABASE_URL: `postgresql://${authority}/d?${CA}` })),
        JSON.stringify(authority)).toBe("BAD_URL");
      rmSync(backupDir, { recursive: true, force: true });
    }
  });

  it("scopes the passfile to a bracketed IPv6 literal instead of widening it", () => {
    // libpq strips the brackets before its .pgpass lookup, so this peer IS
    // known and the entry can name it. The wildcard here was one nobody needed:
    // it offered the superuser password to every peer the connection could
    // reach, which is the property the refusal above exists to prevent — and
    // the plan lists this spelling as one that MUST be accepted.
    pgStubs();
    const r = run({ MIGRATION_DATABASE_URL: `postgresql://u:pw@[2001:db8::1]:5432/d?${CA}` });
    expect(r.status, r.stderr).toBe(0);
    const line = readFileSync(`${logFile}.pgpass`, "utf8").split("\n")[0];
    // Every colon of the literal is escaped, or .pgpass reads them as field
    // separators and the entry means something else entirely.
    expect(line).toBe("2001\\:db8\\:\\:1:5432:*:*:pw");
    expect(line, "the wildcard entry must not be written").not.toMatch(/^\*:/);
  });

  it("keeps the wildcard only for the multi-host form, which cannot be scoped", () => {
    // libpq may connect to any member and consults the passfile per attempt, so
    // this is the one accepted form where the wildcard is unavoidable. Recorded
    // in the deviation log; pinned here so it stays the ONLY one.
    pgStubs();
    const r = run({ MIGRATION_DATABASE_URL: `postgresql://u:pw@a.example.com,b.example.com/d?${CA}` });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(`${logFile}.pgpass`, "utf8").split("\n")[0]).toBe("*:*:*:*:pw");
  });

  it("scopes an empty port to the port libpq will actually use", () => {
    // `postgres://u:pw@host:/db` is a legal URI meaning "the default port".
    // `env -i` in run_pg means PGPORT cannot reach libpq, so that port is
    // deterministically 5432 — a wildcard would be wider than the spelling.
    pgStubs();
    const r = run({ MIGRATION_DATABASE_URL: `postgresql://u:pw@dbhost:/d?${CA}` });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(`${logFile}.pgpass`, "utf8").split("\n")[0]).toBe("dbhost:5432:*:*:pw");
  });

  it("reads back the passfile's achieved mode", () => {
    // The member of the mode-checked set with the most to lose — it holds the
    // superuser password — and the one still trusting mktemp's creation-time
    // mode, which is the assumption the helper exists to reject.
    pgStubs();
    const realStat = spawnSync("sh", ["-c", "command -v stat"], { encoding: "utf8" }).stdout.trim();
    stub("stat", `
last=""
for a in "$@"; do last="$a"; done
case "$last" in
  *.pgpass.*)
    case " $* " in *" %a "*|*"'%Lp'"*|*" %Lp "*) echo 644; exit 0 ;; esac ;;
esac
exec "${realStat}" "$@"`);
    const r = run({ MIGRATION_DATABASE_URL: `postgresql://u:pw@dbhost:5432/d?${CA}` });
    expect(err(r)).toBe("DEST_UNSAFE");
    expect(r.stderr).toMatch(/the passfile[^\n]*mode 644/);
  });

  it("treats a malformed enumeration payload as a failed reconciliation", () => {
    // The payload is consumed as a `case` GLOB before anything validates it, so
    // a row of `y*` matched every member of DB_SET_HEX and silently dropped a
    // real database from both the warning and the MANIFEST. Validating only
    // inside display_of is too late — that runs after the membership test.
    pgStubs();
    stub("psql", `
echo "psql $*" >> "${logFile}"
case " $* " in
  *pg_database*) printf 'y*\\n' ;;
  *)             printf 't|TLSv1.3|AESGCM\\n' ;;
esac
exit 0`);
    const r = run({ MIGRATION_DATABASE_URL: `postgresql://u:pw@dbhost:5432/d?${CA}` });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/malformed row; the reconciliation is incomplete/);
    const [gen] = generations();
    const manifest = readFileSync(join(backupDir, gen, "MANIFEST"), "utf8");
    expect(manifest, "an unvalidated payload must not read as a clean reconciliation")
      .toMatch(/not_backed_up: \(unknown/);
  });

  it("rejects an enumeration row whose SHAPE is wrong, not just its alphabet", () => {
    // Validating the payload's charset alone was not enough. `x616263` has a
    // bad connect flag and a payload that decodes cleanly: the flag was
    // discarded and `abc` — a database that does not exist — went into the
    // warning and the MANIFEST. `y0` is an odd-length payload that no encoder
    // can produce. Both are the class the hex transport exists to close,
    // reached from the other end.
    for (const row of ["x616263", "y0", "y616"]) {
      pgStubs();
      stub("psql", `
echo "psql $*" >> "${logFile}"
case " $* " in
  *pg_database*) printf '${"${row}"}\n' ;;
  *)             printf 't|TLSv1.3|AESGCM\n' ;;
esac
exit 0`.replace("${row}", row));
      const r = run({ MIGRATION_DATABASE_URL: `postgresql://u:pw@dbhost:5432/d?${CA}` });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr, `${row} must be reported as malformed`)
        .toMatch(/malformed row; the reconciliation is incomplete/);
      const [gen] = generations();
      const manifest = readFileSync(join(backupDir, gen, "MANIFEST"), "utf8");
      expect(manifest, `${row} must not produce a coverage claim`).toMatch(/not_backed_up: \(unknown/);
      expect(manifest, "and must never name a database it invented").not.toMatch(/\babc\b/);
      rmSync(backupDir, { recursive: true, force: true });
    }
  });

  it("passes -X to psql so ~/.psqlrc cannot answer for the server", () => {
    // HOME is in run_pg's allowlist, so the file-based configuration channel
    // env -i closes is re-opened unless -X is given — and psqlrc output lands in
    // front of the rows that decide the TLS verdict and the cluster
    // enumeration. A `\echo t|…` line satisfies the transport check outright.
    pgStubs();
    run({ MIGRATION_DATABASE_URL: `postgresql://u:pw@dbhost:5432/d?${CA}` });
    const psqlCalls = readLog().split("\n").filter((l) => l.startsWith("psql "));
    expect(psqlCalls.length, "psql must have been invoked").toBeGreaterThan(0);
    for (const call of psqlCalls) {
      expect(call, `psql invoked without -X: ${call}`).toMatch(/(^|\s)-X(\s|$)/);
    }
  });
});

describe("guards the sweep found unpinned", () => {
  it("rejects a whitespace-only BACKUP_DATABASES", () => {
    // A tab published a generation containing no database at all and exited 0,
    // because the guard stripped spaces while the loop split on IFS.
    for (const v of ["\t", "  ", "\n"]) {
      expect(err(run({ BACKUP_DATABASES: v })), JSON.stringify(v)).toBe("BAD_ENV");
      rmSync(backupDir, { recursive: true, force: true });
    }
  });

  // ─── The cluster reconciliation ────────────────────────────
  //
  // The SHARED dockerStub had no `psql` arm, so every case using it ran the
  // reconciliation's failure path. The block itself was not uncovered — five
  // cases further down install their own stub with a `psql)` arm and drive it
  // end to end. What was missing is here: the empty-answer guard, the three
  // row-shape arms, the `break`, and three of the five `-X` sites.

  const manifestOf = () =>
    readFileSync(join(backupDir, generations()[0], "MANIFEST"), "utf8");

  it("treats an enumeration that answers nothing as one that failed", () => {
    // A query that succeeded returns at least the database it connected to.
    // Without the guard the loop runs over an empty result, finds no unlisted
    // database, and the MANIFEST records `(none)` — the all-clear — for a
    // check that never ran.
    dockerStub({ clusterRows: "" });
    expect(run().status).toBe(0);
    expect(manifestOf(), "an empty answer is not the all-clear")
      .toMatch(/not_backed_up: \(unknown/);
  });

  it("reports a database the cluster has and BACKUP_DATABASES does not", () => {
    // The other direction, and the reason the block exists: without it the
    // reconciliation could be broken in any way at all and every case above
    // would still pass, because none of them ever received a row.
    dockerStub({ clusterRows: `${dbRow("passwd_sso")}\n${dbRow("jackson")}\n${dbRow("forgotten")}\n` });
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stderr, "the unlisted database must be named").toMatch(/'forgotten'[^\n]*NOT being backed up/);
    expect(manifestOf()).toMatch(/not_backed_up: forgotten/);
  });

  for (const [label, row] of [
    ["a flag that is neither y nor n", `x${Buffer.from("abc", "utf8").toString("hex")}`],
    ["a payload outside the hex alphabet, at EVEN length", "yzzzz"],
    ["a payload of odd length", "y616"],
  ]) {
    it(`refuses a cluster row with ${label}`, () => {
      // One fixture per arm. The only non-hex fixture used to be odd-length as
      // well, so the length guard refused it first and the charset arm was
      // exercised by nothing — and the flag arm decides whether a row whose
      // `x` was discarded puts a database that does not exist in the MANIFEST.
      dockerStub({ clusterRows: `${row}\n` });
      const r = run();
      expect(r.status).toBe(0);
      expect(r.stderr).toMatch(/malformed row/);
      expect(manifestOf(), "a table read as malformed has not reconciled anything")
        .toMatch(/not_backed_up: \(unknown/);
    });
  }

  it("stops reading rows at the first malformed one", () => {
    // Without the break the loop keeps going, so a table the run has just
    // declared unreadable goes on producing findings — each one a database
    // name taken from the same output.
    dockerStub({ clusterRows: `yzzzz\n${dbRow("keepreading")}\n` });
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stderr, "a malformed table must not go on answering")
      .not.toMatch(/keepreading/);
  });

  it("passes -X to psql in compose mode, and on the diagnostic re-run", () => {
    // The existing case filters log lines starting `psql `, which only URL mode
    // produces. Compose is the DEFAULT path, and the diagnostic re-run is
    // reached only when the enumeration fails, so three of the five sites were
    // unmeasured — including both of the ones a scheduled run takes.
    dockerStub({ clusterStatus: 1, clusterStderr: "FATAL: connection refused" });
    const r = run();
    expect(r.status).toBe(0);
    const calls = readLog().split("\n").filter((l) => /\bpsql\b/.test(l));
    expect(calls.length, "the enumeration and its diagnostic re-run must both appear")
      .toBeGreaterThanOrEqual(2);
    for (const c of calls) {
      expect(c, `psql invoked without -X: ${c}`).toMatch(/(^|\s)-X(\s|$)/);
    }
    expect(r.stderr, "the diagnostic re-run is what makes the failure readable")
      .toMatch(/FATAL: connection refused/);
  });

  it("pins the compose-mode dump flags, which is the default path", () => {
    expect(run().status).toBe(0);
    const log = readLog();
    expect(log, "--create carries the database-level ACLs").toMatch(/pg_dump [^\n]*-Fc[^\n]*--create/);
    expect(log, "--no-role-passwords keeps SCRAM verifiers out of the archive")
      .toMatch(/pg_dumpall [^\n]*--globals-only[^\n]*--no-role-passwords/);
  });

  it("fails when pg_dump exits non-zero even though it wrote bytes", () => {
    // Disjoint from the empty-archive guard: the ordinary failure stub trips
    // both at once, so neither was individually provable.
    stub("docker", `
[ "\${2:-}" = "config" ] && exit 0
[ "\${2:-}" = "ps" ] && { echo c1; exit 0; }
for a in "$@"; do
  case "$a" in
    pg_dump)    printf 'PARTIAL-BYTES'; exit 1 ;;
    pg_dumpall) printf 'CREATE ROLE r;\\n-- PostgreSQL database cluster dump complete\\n'; exit 0 ;;
    pg_restore) printf '; h\\n1; 1 TABLE t o\\n'; exit 0 ;;
  esac
done
exit 0`);
    const r = run();
    expect(err(r)).toBe("DUMP_FAILED");
    expect(r.stderr).toMatch(/pg_dump failed for database/);
    expect(generations()).toEqual([]);
  });

  it("routes a truncated globals dump to VALIDATE_FAILED through the script", () => {
    // The fixture-only assertion this replaces could not fail for any script
    // defect: the script was not on its call path.
    const truncated = readFileSync(join(FIXTURES, "globals-truncated.sql"), "utf8");
    stub("docker", `
[ "\${2:-}" = "config" ] && exit 0
[ "\${2:-}" = "ps" ] && { echo c1; exit 0; }
for a in "$@"; do
  case "$a" in
    pg_dump)    printf 'PGDMP'; exit 0 ;;
    pg_dumpall) cat <<'GLOBALS'
${truncated}
GLOBALS
                exit 0 ;;
    pg_restore) printf '; h\\n1; 1 TABLE t o\\n'; exit 0 ;;
  esac
done
exit 0`);
    expect(err(run())).toBe("VALIDATE_FAILED");
    expect(readdirSync(backupDir).filter((n) => n.endsWith(".FAILED"))).toHaveLength(1);
  });

  it("fails when the globals dump declares no roles", () => {
    stub("docker", `
[ "\${2:-}" = "config" ] && exit 0
[ "\${2:-}" = "ps" ] && { echo c1; exit 0; }
for a in "$@"; do
  case "$a" in
    pg_dump)    printf 'PGDMP'; exit 0 ;;
    pg_dumpall) printf -- '-- PostgreSQL database cluster dump complete\\n'; exit 0 ;;
    pg_restore) printf '; h\\n1; 1 TABLE t o\\n'; exit 0 ;;
  esac
done
exit 0`);
    expect(err(run())).toBe("VALIDATE_FAILED");
  });

  it("sweeps an orphaned .partial from an interrupted run", () => {
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    chmodSync(backupDir, 0o700);
    mkdirSync(join(backupDir, "20200101T000000Z.partial"), { recursive: true });
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(backupDir, "20200101T000000Z.partial"))).toBe(false);
    expect(r.stderr).toMatch(/removed orphaned/);
  });

  it("deletes nothing during a dry run, including residue", () => {
    // The residue sweep once ran ahead of the dry-run exit, so a preview removed
    // orphaned corpora and then reported that it had removed nothing.
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    chmodSync(backupDir, 0o700);
    mkdirSync(join(backupDir, "20200101T000000Z.partial"), { recursive: true });
    writeFileSync(join(backupDir, ".pgpass.aaaaaa"), "x", "utf8");
    const r = run({ BACKUP_DRY_RUN: "true" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/would remove residue/);
    expect(existsSync(join(backupDir, "20200101T000000Z.partial"))).toBe(true);
    expect(existsSync(join(backupDir, ".pgpass.aaaaaa"))).toBe(true);
  });

  it("refuses to publish over an existing generation", { timeout: 30000 }, () => {
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    chmodSync(backupDir, 0o700);
    // Every stamp the retry loop can reach is already taken.
    const now = new Date();
    for (let i = -2; i < 12; i++) {
      const d = new Date(now.getTime() + i * 1000);
      const s = d.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
      mkdirSync(join(backupDir, s), { recursive: true });
    }
    const r = run();
    expect(r.status).toBe(1);
    // A retryable collision is not INTERNAL, which the trap uses for "a status
    // no fail() produced" — an identifier shared with unhandled faults cannot
    // tell an authored condition from a bug.
    expect(err(r)).toBe("STAMP_TAKEN");
    expect(r.stderr).toMatch(/every generation stamp in the last few seconds is taken/);
  });

  it("refuses to publish over a generation that appears during the run", () => {
    // The guard the previous case cannot reach: the collision is created after
    // the stamp is chosen, so the run gets past the retry loop and stops at the
    // publish. `mv a b` with b an existing directory nests and reports success.
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    chmodSync(backupDir, 0o700);
    stub("docker", `
[ "\${2:-}" = "config" ] && exit 0
[ "\${2:-}" = "ps" ] && { echo c1; exit 0; }
for a in "$@"; do
  case "$a" in
    pg_dump)    printf 'PGDMP'; exit 0 ;;
    pg_dumpall)
      # By now the run directory exists; create the published name under it.
      for d in "${backupDir}"/*.partial; do
        [ -e "$d" ] || continue
        base="\$(basename -- "$d" .partial)"
        mkdir -p -- "${backupDir}/\$base"
      done
      printf 'CREATE ROLE r;\\n-- PostgreSQL database cluster dump complete\\n'; exit 0 ;;
    pg_restore) printf '; h\\n1; 1 TABLE t o\\n'; exit 0 ;;
  esac
done
exit 0`);
    const r = run();
    expect(err(r)).toBe("INTERNAL");
    expect(r.stderr).toMatch(/refusing to publish over it/);
  });

  it("reports the signal by name and leaves no credential behind", { timeout: 20000 }, () => {
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    chmodSync(backupDir, 0o700);
    stub("docker", `
[ "\${2:-}" = "config" ] && exit 0
[ "\${2:-}" = "ps" ] && { echo c1; exit 0; }
for a in "$@"; do case "$a" in pg_dump) exec sleep 5 ;; esac; done
exit 0`);
    const child = spawn("bash", [SCRIPT], {
      env: { PATH: `${binDir}:${process.env.PATH}`, HOME: homeDir, LANG: "C", BACKUP_DIR: backupDir },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    const done = new Promise((res) => child.on("exit", res));
    return new Promise((resolve) => setTimeout(resolve, 700))
      .then(() => { child.kill("SIGHUP"); return done; })
      .then(() => {
        expect(stderr, "the handler records which signal, not a derived guess")
          .toMatch(/BACKUP_ERR:INTERRUPTED terminated by SIGHUP/);
        expect(readdirSync(backupDir).filter((n) => n.startsWith(".pgpass"))).toEqual([]);
        expect(readdirSync(backupDir).filter((n) => n.endsWith(".partial"))).toEqual([]);
      });
  });
});

describe("ignore-rule coverage", () => {
  const ignored = (p) =>
    spawnSync("git", ["check-ignore", "-q", "--no-index", p], { cwd: REPO_ROOT }).status === 0;

  it("excludes every member of a run directory under the default name", () => {
    for (const p of [
      "passwd-sso-backups/20260101T000000Z/passwd_sso.dump",
      "passwd-sso-backups/20260101T000000Z/globals.sql",
      "passwd-sso-backups/20260101T000000Z/MANIFEST",
    ]) {
      expect(ignored(p), `${p} must be ignored`).toBe(true);
    }
    expect(ignored("stray.dump"), "a loose archive anywhere").toBe(true);
  });

  it("does not exclude the committed test fixtures", () => {
    // The paired case: an ignore rule broad enough to swallow the fixtures
    // would make CI run the validation group without them.
    expect(ignored("scripts/__tests__/fixtures/backup-db/valid.pgdump")).toBe(false);
  });

  it("covers a run directory under an operator-chosen name too", () => {
    // BACKUP_ALLOW_IN_REPO permits a custom directory name, so excluding by the
    // default name alone left globals.sql (the cluster's role topology) and
    // MANIFEST (host and connection target) committable. The run-directory
    // SHAPE is what is excluded now.
    for (const p of [
      "custom-backups/20260101T000000Z/globals.sql",
      "custom-backups/20260101T000000Z/MANIFEST",
      "deep/nested/20260102T000000Z.FAILED/globals.sql",
      // The shape the cleanup trap actually writes on a stamp collision; it
      // matches neither *.dump nor the plain .FAILED rule.
      "x/20260101T000000Z.4242.FAILED/globals.sql",
      "x/20260101T000000Z.4242.FAILED/MANIFEST",
      "passwd-sso-backups/notes.txt",
      "anywhere/.pgpass.abc123",
    ]) {
      expect(ignored(p), `${p} must be ignored`).toBe(true);
    }
  });
});


describe("concurrency and destination ownership", () => {
  it("lets exactly one of two runs reclaim the same stale lock", { timeout: 30000 }, async () => {
    // Two runs can judge the same lock stale simultaneously. rm-then-mkdir let
    // the later one delete the earlier one's FRESH lock, so both proceeded into
    // one root and each swept the other's residue. The claim is a rename now,
    // which exactly one can win.
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    chmodSync(backupDir, 0o700);
    const lock = join(backupDir, ".lock.d");
    mkdirSync(lock, { recursive: true, mode: 0o700 });
    writeFileSync(join(lock, "pid"), `${GONE_PID}\n`, "utf8");        // gone
    writeFileSync(join(lock, "host"), `${hostname()}\n`, "utf8");

    // Slow the dump so the two runs genuinely overlap.
    stub("docker", `
[ "\${2:-}" = "config" ] && exit 0
[ "\${2:-}" = "ps" ] && { echo c1; exit 0; }
for a in "$@"; do
  case "$a" in
    pg_dump)    sleep 1; printf 'PGDMP'; exit 0 ;;
    pg_dumpall) printf 'CREATE ROLE r;\\n-- PostgreSQL database cluster dump complete\\n'; exit 0 ;;
    pg_restore) printf '; h\\n1; 1 TABLE t o\\n'; exit 0 ;;
  esac
done
exit 0`);

    const env = { PATH: `${binDir}:${process.env.PATH}`, HOME: homeDir, LANG: "C", BACKUP_DIR: backupDir };
    const both = await Promise.all([0, 1].map(() => new Promise((res) => {
      const c = spawn("bash", [SCRIPT], { env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      c.stdout.on("data", (d) => { out += d; });
      c.stderr.on("data", (d) => { out += d; });
      c.on("exit", (code) => res({ code, out }));
    })));

    // Neither may take it: automatic reclaim is what raced. Both fail closed,
    // and the operator decides.
    expect(both.filter((r) => r.code === 0), "no run may take a stale lock on its own").toHaveLength(0);
    for (const r of both) expect(r.out).toMatch(/BACKUP_ERR:LOCKED/);
    expect(generations()).toEqual([]);
  });

  it("lets exactly one of two runs take a FREE lock", { timeout: 30000 }, async () => {
    // The case above pre-creates a stale lock, so both runs take the
    // existing-lock branch and neither ever races for a free one — nothing
    // observed the atomicity `mkdir` is chosen for. Replacing the acquire with
    // a test-then-`mkdir -p` (two runs both see "absent", both proceed into one
    // root) left the suite green.
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    chmodSync(backupDir, 0o700);
    stub("docker", `
[ "\${2:-}" = "config" ] && exit 0
[ "\${2:-}" = "ps" ] && { echo c1; exit 0; }
for a in "$@"; do
  case "$a" in
    pg_dump)    sleep 2; printf 'PGDMP'; exit 0 ;;
    pg_dumpall) printf 'CREATE ROLE r;\\n-- PostgreSQL database cluster dump complete\\n'; exit 0 ;;
    pg_restore) printf '; h\\n1; 1 TABLE t o\\n'; exit 0 ;;
  esac
done
exit 0`);
    const env = { PATH: `${binDir}:${process.env.PATH}`, HOME: homeDir, LANG: "C", BACKUP_DIR: backupDir };
    const both = await Promise.all([0, 1].map(() => new Promise((res) => {
      const c = spawn(BASH, [SCRIPT], { env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      c.stdout.on("data", (d) => { out += d; });
      c.stderr.on("data", (d) => { out += d; });
      c.on("exit", (code) => res({ code, out }));
    })));

    const winners = both.filter((r) => r.code === 0);
    expect(winners, "exactly one run may hold the lock").toHaveLength(1);
    const losers = both.filter((r) => r.code !== 0);
    for (const r of losers) expect(r.out).toMatch(/BACKUP_ERR:LOCKED/);
    // One writer means one generation and no residue from a second one.
    expect(generations()).toHaveLength(1);
    expect(readdirSync(backupDir).filter((n) => n.endsWith(".partial"))).toEqual([]);
  });

  it("aborts the prune when the root is no longer the audited object", () => {
    // The deviation log recorded this as needing "a BACKUP_TEST_HOOK invoked
    // between publish and prune". That was wrong, and the entry is corrected:
    // stat_ident shells out to a PATH-resolved `stat`, which this file already
    // stubs in five other cases. A stub that changes device:inode once a marker
    // appears drives the branch with no production change at all.
    //
    // Deleting the guard's whole body left the suite green before this.
    const realStat = spawnSync("sh", ["-c", "command -v stat"], { encoding: "utf8" }).stdout.trim();
    const marker = join(tmpDir, "swapped");
    stub("stat", `
last=""
for a in "$@"; do last="$a"; done
if [ -e "${marker}" ] && [ "$last" = "${realBackupDir}" ]; then
  case " $* " in
    # The inode half is what must decide: reporting a different DEVICE alone
    # would also pass a comparison that only looks at the device.
    *"%d:%i"*) printf '%s:9999\\n' "$(${realStat} -f '%d' -- "${realBackupDir}" 2>/dev/null || ${realStat} -c '%d' -- "${realBackupDir}")"; exit 0 ;;
  esac
fi
exec "${realStat}" "$@"`);
    // Armed from pg_dumpall, which runs after both pre-dump prunes and before
    // the publish, so the swap lands in front of the generation pruner.
    stub("docker", `
[ "\${2:-}" = "config" ] && exit 0
[ "\${2:-}" = "ps" ] && { echo c1; exit 0; }
for a in "$@"; do
  case "$a" in
    pg_dump)    printf 'PGDMP'; exit 0 ;;
    pg_dumpall) : > "${marker}"; printf 'CREATE ROLE r;\\n-- PostgreSQL database cluster dump complete\\n'; exit 0 ;;
    pg_restore) printf '; h\\n1; 1 TABLE t o\\n'; exit 0 ;;
  esac
done
exit 0`);
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    chmodSync(backupDir, 0o700);
    for (const g of ["20200101T000000Z", "20200102T000000Z"]) mkGeneration(g);

    const r = run({ BACKUP_RETAIN: "1" });
    expect(err(r)).toBe("PRUNE_ABORTED");
    expect(r.stderr).toMatch(/no longer the directory that was audited/);
    // And nothing was removed: aborting must not mean aborting halfway.
    for (const g of ["20200101T000000Z", "20200102T000000Z"]) {
      expect(existsSync(join(backupDir, g)), `${g} must survive an aborted prune`).toBe(true);
    }
  });

  it("lets exactly one of two runs take a FREE lock, under real contention",
    { timeout: 30000 }, async () => {
    // The previous version of this case could not see the race it was written
    // for: two spawn() calls land milliseconds apart while a test-then-create
    // window is microseconds wide, so the second run always found the lock
    // already there and took the ordinary LOCKED branch. `sleep` in the pg_dump
    // stub widens the HOLD, not the ACQUIRE. A test-then-`mkdir -p` acquire
    // survived it three times out of three.
    //
    // `mkdir` is an external binary, so the acquire window itself is stubbable:
    // sleep before creating the lock directory, and any non-atomic acquire loses
    // deterministically.
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    chmodSync(backupDir, 0o700);
    const realMkdir = spawnSync("sh", ["-c", "command -v mkdir"], { encoding: "utf8" }).stdout.trim();
    stub("mkdir", `
for a in "$@"; do
  case "$a" in
    */.lock.d) sleep 0.3 ;;
  esac
done
exec "${realMkdir}" "$@"`);
    const env = { PATH: `${binDir}:${process.env.PATH}`, HOME: homeDir, LANG: "C", BACKUP_DIR: backupDir };
    const both = await Promise.all([0, 1].map(() => new Promise((res) => {
      const c = spawn(BASH, [SCRIPT], { env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      c.stdout.on("data", (d) => { out += d; });
      c.stderr.on("data", (d) => { out += d; });
      c.on("exit", (code) => res({ code, out }));
    })));

    expect(both.filter((r) => r.code === 0), "exactly one run may hold the lock").toHaveLength(1);
    for (const r of both.filter((r) => r.code !== 0)) expect(r.out).toMatch(/BACKUP_ERR:LOCKED/);
    expect(generations()).toHaveLength(1);
    expect(readdirSync(backupDir).filter((n) => n.endsWith(".partial"))).toEqual([]);
  });

  it("removes the lock it just took when it cannot record the holder", () => {
    // The wedge the rollback exists to prevent: a lock no run can attribute, so
    // every later run reports "exists but records no holder". Both the failure
    // propagation and the rollback itself were unpinned.
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    chmodSync(backupDir, 0o700);
    const realMkdir = spawnSync("sh", ["-c", "command -v mkdir"], { encoding: "utf8" }).stdout.trim();
    const lock = join(backupDir, ".lock.d");
    // The lock's own mkdir also creates `pid` as a DIRECTORY, so the script's
    // `printf … > "$LOCK_DIR/pid"` cannot succeed. Deterministic, and it leaves
    // the acquire itself untouched.
    stub("mkdir", `
"${realMkdir}" "$@" || exit $?
for a in "$@"; do
  case "$a" in
    */.lock.d) "${realMkdir}" -p -- "$a/pid" ;;
  esac
done
exit 0`);
    const r = run();
    expect(err(r)).toBe("INTERNAL");
    expect(r.stderr).toMatch(/could not record the lock holder/);
    if (existsSync(lock)) chmodSync(lock, 0o700);
    expect(existsSync(lock), "a lock nobody can attribute must not survive").toBe(false);
  });

  it("refuses an ancestor owned by a third party", () => {
    // stat is PATH-resolved, so the ownership branch is reachable without a
    // second real uid: report a foreign owner for the parent only.
    const parent = realParentDir;
    const realStat = spawnSync("sh", ["-c", "command -v stat"], { encoding: "utf8" }).stdout.trim();
    stub("stat", `
for a in "$@"; do
  if [ "$a" = "${parent}" ]; then
    case " $* " in
      *" %u "*|*"'%u'"*) echo 4242; exit 0 ;;
    esac
  fi
done
exec "${realStat}" "$@"`);
    const r = run();
    expect(err(r)).toBe("DEST_UNSAFE");
    expect(r.stderr).toMatch(/owned by uid 4242, who can rename our entry/);
  });

  it("accepts an ancestor owned by the invoking user at 0755 (paired allow case)", () => {
    // Boundary-adjacent, per RT10. Installing no stub at all made this
    // byte-identical to the plain happy path, so it could not tell the ownership
    // branch from any other reason the run might succeed — and a widening that
    // exempts an owner from the writability check (the exemption D3 records as
    // deliberately rejected) survived. This reports the "admin created it and
    // chowned it to the operator" shape: our uid, mode 0755, no sticky bit.
    const parent = realParentDir;
    const realStat = spawnSync("sh", ["-c", "command -v stat"], { encoding: "utf8" }).stdout.trim();
    const uid = String(process.getuid());
    stub("stat", `
last=""
for a in "$@"; do last="$a"; done
if [ "$last" = "${parent}" ]; then
  case " $* " in
    *" %u "*|*"'%u'"*) echo ${uid}; exit 0 ;;
    *" %a "*|*"'%Lp'"*|*" %Lp "*) echo 755; exit 0 ;;
  esac
fi
exec "${realStat}" "$@"`);
    const r = run();
    expect(r.status, r.stderr).toBe(0);
  });

  it("uses $HOME/passwd-sso-backups when BACKUP_DIR is unset", () => {
    // `run()` always sets BACKUP_DIR, so the documented default was exercised by
    // nothing and a typo in it would ship. Safe to exercise precisely because
    // INV-C9c makes HOME a per-test tmpdir — that allowlist is what this case
    // buys.
    const { BACKUP_DIR: _omitted, ...rest } = {
      PATH: `${binDir}:${process.env.PATH}`, HOME: homeDir, LANG: "C", BACKUP_DIR: backupDir,
    };
    const r = spawnSync(BASH, [SCRIPT], { encoding: "utf8", timeout: 8000, cwd: REPO_ROOT, env: rest });
    expect(r.status, r.stderr).toBe(0);
    const defaultRoot = join(homeDir, "passwd-sso-backups");
    expect(existsSync(defaultRoot), "the documented default must be where the run lands").toBe(true);
    expect(
      readdirSync(defaultRoot).filter((n) => /^\d{8}T\d{6}Z$/.test(n)),
      "a generation must have been published under the default root",
    ).toHaveLength(1);
  });

  it("refuses a password whose literal trailing newline a substitution would eat", () => {
    // Distinct from the %0A case: the raw byte is stripped by the command
    // substitution inside percent_decode, so a decoded-form check sees a clean
    // password and connects as a different secret.
    const r = run({ MIGRATION_DATABASE_URL: "postgresql://u:secret\n@h:5432/d?sslrootcert=/x" });
    expect(err(r)).toBe("BAD_URL");
    expect(r.stderr).toMatch(/literal newline/);
  });


  it("rejects an age bound that would delete every retained failure", () => {
    // `-1` becomes `find -mtime "+-1"`, which matches every candidate; a
    // non-numeric value makes find error into a discarded stream and the bound
    // silently stops existing.
    // An empty value is not in the list: `${VAR:-7}` treats it as unset and
    // substitutes the default, which is the convention every variable here uses.
    for (const v of ["-1", "bogus", "7d", "+3"]) {
      expect(err(run({ BACKUP_FAILED_MAX_AGE_DAYS: v })), JSON.stringify(v)).toBe("BAD_ENV");
      rmSync(backupDir, { recursive: true, force: true });
    }
  });

  it("manages a collision-suffixed failure like any other", () => {
    // <stamp>.<pid>.FAILED keeps the suffix terminal so list_stamped sees it;
    // <stamp>.FAILED.<pid> would be outside both the age and the count bound.
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    chmodSync(backupDir, 0o700);
    const collided = join(backupDir, "20200101T000000Z.4242.FAILED");
    mkdirSync(collided, { recursive: true, mode: 0o700 });
    const longAgo = new Date(Date.now() - 30 * 86400_000);
    utimesSync(collided, longAgo, longAgo);
    const r = run({ BACKUP_RETAIN: "9" });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(collided), "the collision form is bounded too").toBe(false);
  });

  it("bounds .FAILED corpora by age as well as count", () => {
    // "Kept for diagnosis" without a window is just an extra full copy of the
    // database sitting on disk.
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    chmodSync(backupDir, 0o700);
    const old = join(backupDir, "20200101T000000Z.FAILED");
    mkdirSync(old, { recursive: true, mode: 0o700 });
    const longAgo = new Date(Date.now() - 30 * 86400_000);
    utimesSync(old, longAgo, longAgo);
    mkdirSync(join(backupDir, "20200102T000000Z.FAILED"), { recursive: true, mode: 0o700 });

    const r = run({ BACKUP_RETAIN: "9" });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(old), "past the age bound even though the count allows it").toBe(false);
    expect(existsSync(join(backupDir, "20200102T000000Z.FAILED")), "recent one kept").toBe(true);
  });

  it("counts a directory whose name contains a newline exactly once", () => {
    // INV-C6e mandates a NUL-delimited reader. `ls -1` writes such a name as two
    // lines, and when both halves look like generations the candidate count is
    // inflated — so the pruner deletes one MORE validated generation than
    // BACKUP_RETAIN permits, the same outcome the <stamp>.<digits> spelling
    // produced through a different route.
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    chmodSync(backupDir, 0o700);
    for (const g of ["20200101T000000Z", "20200102T000000Z", "20200103T000000Z"]) mkGeneration(g);
    mkdirSync(join(backupDir, "20200101T000000Z\n20200102T000000Z"), { recursive: true });

    // 3 existing + the one this run publishes = exactly BACKUP_RETAIN.
    const r = run({ BACKUP_RETAIN: "4" });
    expect(r.status, r.stderr).toBe(0);
    for (const g of ["20200101T000000Z", "20200102T000000Z", "20200103T000000Z"]) {
      expect(existsSync(join(backupDir, g)), `${g} is inside the retention window`).toBe(true);
    }
    expect(generations()).toHaveLength(4);
  });

  it("prunes oldest-first regardless of the order the directory returns", () => {
    // `| sort` in list_stamped: without it the pruner deletes in readdir order,
    // which on this filesystem happens to match creation order — so the C6
    // expectations held by accident and dropping the sort survived. Created
    // newest-first so the two orders disagree.
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    chmodSync(backupDir, 0o700);
    for (const g of ["20200103T000000Z", "20200101T000000Z", "20200102T000000Z"]) mkGeneration(g);
    // The orders that must disagree are READDIR order and sorted order — not
    // creation order and sorted order. ext4 returns these names already sorted,
    // so creating them newest-first made `| sort` a no-op and its removal
    // survived. `find` is PATH-resolved: reverse its listing so the two orders
    // disagree on every filesystem.
    const realFind = spawnSync("sh", ["-c", "command -v find"], { encoding: "utf8" }).stdout.trim();
    stub("find", `
case " $* " in
  *" -mindepth 1 "*" -print0 "*|*" -mindepth 1 -maxdepth 1 -print0"*)
    "${realFind}" "$@" | tr '\\0' '\\n' | sort -r | tr '\\n' '\\0'
    exit 0 ;;
esac
exec "${realFind}" "$@"`);
    // A stray <stamp>.<digits> must stay invisible to the generation count: the
    // optional .<pid> belongs to .FAILED alone, and admitting it here inflated
    // the candidate set and deleted one MORE validated generation.
    mkdirSync(join(backupDir, "20200101T000000Z.4242"), { recursive: true });

    const r = run({ BACKUP_RETAIN: "3" });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(backupDir, "20200101T000000Z")), "the oldest goes first").toBe(false);
    for (const g of ["20200102T000000Z", "20200103T000000Z"]) {
      expect(existsSync(join(backupDir, g)), `${g} is inside the window`).toBe(true);
    }
    expect(existsSync(join(backupDir, "20200101T000000Z.4242")),
      "a stray <stamp>.<digits> is not a generation and must be left alone").toBe(true);
  });

  it("keeps every MANIFEST value on one line, whatever the command printed", () => {
    // first_line covers three call sites; only tool_version was pinned. A
    // hostname or a transport string spanning two lines becomes a second, bogus
    // MANIFEST record — the class round 3 closed for the authority alone.
    const realUname = spawnSync("sh", ["-c", "command -v uname"], { encoding: "utf8" }).stdout.trim();
    stub("uname", `
[ "\${1:-}" = "-n" ] && { printf 'host-one\\nhost-two\\n'; exit 0; }
exec "${realUname}" "$@"`);
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    const [gen] = generations();
    const manifest = readFileSync(join(backupDir, gen, "MANIFEST"), "utf8");
    for (const line of manifest.split("\n").filter(Boolean)) {
      expect(line, `MANIFEST line is not a record: ${JSON.stringify(line)}`).toMatch(/^[a-z_]+: /);
    }
    expect(manifest).toMatch(/hostname: host-one$/m);
    expect(manifest, "the second line must not survive").not.toMatch(/host-two/);
  });

  it("previews only the residue it would actually remove", () => {
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    chmodSync(backupDir, 0o700);
    mkdirSync(join(backupDir, "20200101T000000Z.partial"), { recursive: true });
    writeFileSync(join(backupDir, "notes.partial"), "not a run", "utf8");
    const r = run({ BACKUP_DRY_RUN: "true" });
    expect(r.stdout).toContain("would remove residue 20200101T000000Z.partial");
    expect(r.stdout, "a regular file is not a candidate and must not be listed")
      .not.toContain("notes.partial");
  });
});

// ─── Destination guards, via PATH stubs ─────────────────────
//
// `ls`, `mount`, `df` and `stat` are all PATH-resolved, so the ACL, mount and
// ownership branches are reachable without root, a real ACL, or a real mount —
// the technique the third-party-ancestor case already uses. Round 3 measured
// these six guards as the only ones with neither a deny nor an allow case.

describe("destination guards", () => {
  /** Delegate everything except one probe to the real binary. */
  const passthrough = (name, override) => {
    const real = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
    stub(name, `${override}
exec "${real}" "$@"`);
  };

  // df is what names WHICH mount point the destination is on, and the text
  // reader accepts only a line claiming exactly that. The real df answers with
  // this host's own mount point — `/` here, /System/Volumes/Data on the macOS
  // verification host — which no fixture can name portably, so the fixtures put
  // the destination on its own mount point and df is told the same.
  const dfStub = (mountPoint) =>
    stub("df", "printf 'Filesystem 512-blocks Used Available Capacity Mounted on\\n"
      + `/dev/probe0 1 1 1 1%%    %s\\n' '${mountPoint}'`);

  // Accepts one line or many. Every mount case used to emit exactly one, so no
  // case exercised line ordering, a second matching entry, or the substring
  // nature of the old mount-point key — which is how an unrelated mount came to
  // decide the verdict.
  const mountStub = (line, before = [], { textPath = false } = {}) => {
    // `/probe` stands for the destination, so a line describes the filesystem
    // the run actually lands on. A root entry is always present, because the
    // real table always has one and the guard now picks the LONGEST covering
    // mount point rather than a string match anywhere in the line.
    //
    // `before` is listed AHEAD of the destination's own entry: no case used to
    // emit more than one line, so nothing exercised ordering, a second matching
    // entry, or the substring nature of the old mount-point key — which is how
    // an unrelated mount came to decide the verdict.
    const lines = ["/dev/root on / type ext4 (rw,relatime)", ...before,
                   ...(Array.isArray(line) ? line : [line])]
      .map((l) => l.split("/probe").join(realBackupDir));
    stub("mount", `cat <<'MOUNTEOF'\n${lines.join("\n")}\nMOUNTEOF\nexit 0`);
    // On Linux the production reader is /proc/self/mountinfo, so the same
    // fixtures are translated into that format and pointed at through the
    // seam. A text-only stub would leave the real reader untested here — the
    // shape the round-4 delegating-reader Critical had.
    const esc = (v) => v.replace(/\\/g, "\\134").replace(/ /g, "\\040")
                        .replace(/\t/g, "\\011").replace(/\n/g, "\\012");
    // Parent ids are computed, not stamped 1: the reader descends the mount
    // TREE, because a later mount over an ancestor hides a child whose mount
    // point is the longer string. A mount's parent is the mount that owned its
    // mount point at the time it was made — the LAST already-listed entry
    // covering it — which is what makes an over-mount a child of what it covers.
    const under = (p, mp) => mp === "/" || p === mp || p.startsWith(`${mp}/`);
    const emitted = [];
    const mi = lines.map((l, i) => {
      // "<src> on <mp> type <fs> (<opts>)"  |  "<src> on <mp> (<fs>, <opts>)"
      const m = /^(.*?) on (.*?)(?: type (\S+))? \((.*)\)$/.exec(l);
      if (!m) return null;
      const [, src, mp, ltype, opts] = m;
      const fs = ltype || opts.split(",")[0].trim();
      // Trim each option: mount(8) writes ", " between them and real mountinfo
      // never has a space inside an option name, so escaping it would emit
      // `\\040nodev` — a token nothing in production would ever unescape.
      const restOpts = (ltype ? opts : opts.split(",").slice(1).join(","))
        .split(",").map((o) => o.trim()).filter(Boolean).join(",");
      const rest = restOpts;
      const id = i + 20;
      let parent = 1;
      for (const e of emitted) if (under(mp, e.mp)) parent = e.id;
      emitted.push({ id, mp });
      return `${id} ${parent} 0:${id} / ${esc(mp)} rw - ${esc(fs)} ${esc(src)} ${esc(rest || "rw")}`;
    }).filter(Boolean).join("\n");
    const miPath = join(tmpDir, "mountinfo");
    writeFileSync(miPath, mi + "\n", "utf8");
    // The forgery and ambiguity cases are ABOUT mount(8)'s human-readable
    // text; mountinfo's escaping makes those inputs unrepresentable, so those
    // cases drive the fallback reader deliberately.
    mountinfoPath = textPath ? "" : miPath;
    if (textPath) dfStub(realBackupDir);
  };

  it("refuses a Linux filesystem that cannot enforce ownership", () => {
    // Linux puts the type OUTSIDE the parentheses: "<dev> on <pt> type exfat (…)".
    // A previous fix read only the parenthesised field and silently stopped
    // detecting exFAT, vfat and NFS on Linux entirely.
    mountStub("/dev/probe0 on /probe type exfat (rw,relatime)");
    const r = run();
    expect(err(r)).toBe("DEST_UNSAFE");
    expect(r.stderr).toMatch(/not known to enforce ownership/);
  });

  it("refuses a macOS volume mounted noowners", () => {
    // macOS puts the type and the options together inside the parentheses, and
    // the FIRST one is read as the type — so an `exfat` fixture was refused by
    // the type before `opts_are_unsafe` ran, and `noowners` was exercised by
    // nothing. It is the one member of UNSAFE_MOUNT_OPTS macOS actually emits,
    // and the reason this check exists on the declared primary host. The type
    // here is allowlisted so the option is the only thing left that can refuse.
    mountStub("/dev/probe0 on /probe (apfs, local, nodev, nosuid, noowners)", [], { textPath: true });
    const r = run();
    expect(err(r)).toBe("DEST_UNSAFE");
    expect(r.stderr, "the OPTION must be what refuses, not the type")
      .toMatch(/ownership advisory/);
  });

  it("accepts a safe filesystem whose MOUNT POINT merely looks unsafe", () => {
    // The paired allow case, and the reason the check must not match the whole
    // line: /mnt/exfat-archive on ext4 is a perfectly good destination.
    mountStub("/dev/probe0 on /probe/exfat-archive type ext4 (rw,relatime)");
    const okExt4 = run();
    expect(okExt4.status, "an ext4 destination must not be refused").toBe(0);
    readTheFixture(okExt4);
  });

  it("refuses a destination carrying an extended ACL", () => {
    // The mode bits do not show a named-user grant. A previous spelling of this
    // check had nine '?' against a ten-character mode field and matched nothing.
    passthrough("ls", `
for a in "$@"; do
  case "$a" in
    "${realBackupDir}")
      printf 'drwx------+ 2 me me 4096 Jan 1 00:00 %s\n' "${realBackupDir}"
      exit 0 ;;
  esac
done`);
    const r = run();
    expect(err(r)).toBe("DEST_UNSAFE");
    expect(r.stderr).toMatch(/extended ACL/);
  });

  it("refuses a destination owned by another uid", () => {
    passthrough("stat", `
last=""
for a in "$@"; do last="$a"; done
if [ "$last" = "${realBackupDir}" ]; then
  case " $* " in *" %u "*|*"'%u'"*) echo 4242; exit 0 ;; esac
fi`);
    const r = run();
    expect(err(r)).toBe("DEST_UNSAFE");
    expect(r.stderr).toMatch(/owned by uid 4242/);
  });

  // ─── "could not determine" is not "safe" ───────────────────
  //
  // Both helpers used to fold a failed or absent tool into the same verdict as
  // a verified-clean destination. macOS keeps mount(8) in /sbin, which cron's
  // default PATH omits, so on the declared primary host the ordinary scheduled
  // run was the one silently losing the check.

  it("is not decided by an unrelated mount that happens to be listed first", () => {
    // A device name is not unique — this host lists five `tmpfs` and four
    // `overlay`. Keying on it and returning on the first match let /run
    // adjudicate every tmpfs destination. The destination's own entry decides.
    mountStub("/dev/probe0 on /probe type exfat (rw,relatime)",
              ["tmpfs on /run type tmpfs (rw,nosuid,nodev,mode=755)"]);
    const r = run();
    expect(err(r), "the destination is exfat, whatever else is mounted").toBe("DEST_UNSAFE");
    expect(r.stderr).toMatch(/exfat is not known to enforce ownership/);
  });

  it("is not decided by a safe filesystem that the destination is mounted OVER", () => {
    // No attacker needed. If a safe tmpfs was mounted at the path before the
    // real exFAT volume, the earlier line used to win — and that is the
    // documented scenario-2 order, where the operator attaches the backup
    // volume at backup time.
    mountStub("/dev/probe0 on /probe type exfat (rw,relatime)",
              ["tmpfs on /probe type tmpfs (rw,nosuid,nodev)"]);
    expect(err(run()), "the topmost mount is the one the path resolves through")
      .toBe("DEST_UNSAFE");
  });

  // BOTH orders. The forged line was previously listed only BEFORE the
  // destination's own entry, so the real line won by "last among equals" and the
  // case passed for a reason that had nothing to do with the guard. Reversed,
  // the forgery won and the run was verified safe — measured.
  for (const evilLast of [false, true]) {
    it(`cannot be forged by a mount whose SOURCE is named like a line (evil ${evilLast ? "last" : "first"})`, () => {
      const evil = "evil on /probe type ext4 (rw) on /elsewhere type fuse.sshfs (rw)";
      const real = "/dev/probe0 on /probe type exfat (rw,relatime)";
      mountStub(evilLast ? [real, evil] : [evil, real], [], { textPath: true });
      const r = run();
      expect(err(r), "a line with non-unique separators must not decide anything")
        .toBe("DEST_UNSAFE");
    });

    it(`cannot be forged by a mount whose TARGET is named like a line (evil ${evilLast ? "last" : "first"})`, () => {
      const evil = "attacker_fs on /home/mallory/m on /probe type ext4 (rw) type fuse.sshfs (rw,user_id=1001)";
      const real = "/dev/probe0 on /probe type exfat (rw,relatime)";
      mountStub(evilLast ? [real, evil] : [evil, real], [], { textPath: true });
      expect(err(run())).toBe("DEST_UNSAFE");
    });
  }

  // One fixture per ambiguity arm, and each is the ONLY line covering the
  // destination — otherwise the destination's own entry refuses anyway and the
  // arm under test is not what decided. Without the fail-closed step the run
  // falls back to the root mount (a safe ext4) and succeeds.
  for (const [label, line] of [
    ["two ' on ', one ' type '", "evil on /probe on /elsewhere type ext4 (rw)"],
    ["two ' type ', one ' on '", "evil type x on /probe type ext4 (rw)"],
  ]) {
    it(`refuses when a line mentioning the destination is ambiguous: ${label}`, () => {
      mountStub(line, [], { textPath: true });
      const r = run();
      expect(err(r)).toBe("DEST_UNSAFE");
      expect(r.stderr, "an unattributable table must not be answered by an ancestor")
        .toMatch(/non-unique separators/);
    });
  }

  // ─── A source field carrying a NEWLINE ─────────────────────
  //
  // `fusermount` is setuid and `-o fsname=` is the mounting user's to spell, so
  // an unprivileged user chooses bytes that mount(8) prints VERBATIM into a
  // line-oriented, unescaped table. The fragments between the newlines are then
  // read as whole mount lines, and every one of them can be made well-formed:
  // the leading fragment is spelled by the attacker, and the trailing one has
  // ` on <their own mount point> (…)` appended by mount(8) itself. So the
  // injected middle line carries exactly one of each separator and is
  // indistinguishable, by any per-line parse, from a real entry — the
  // ambiguity check above cannot see it. /proc/self/mountinfo escapes the
  // newline to \012, which is the whole reason the Linux reader is the
  // structured table rather than the text.
  const newlineInjection = () => {
    const injected = [
      "decoy on /decoy type ext4 (rw)",
      `/dev/fake on ${realBackupDir} type ext4 (rw)`,
      "tail",
    ].join("\n");
    // The real destination entry is exfat — refused on its own merits — and the
    // forged line claims the same mount point AFTER it, so on any reader that
    // splits this text the forgery wins by "last among equals" and the run is
    // reported verified safe.
    const lines = [
      "/dev/root on / type ext4 (rw,relatime)",
      `/dev/probe0 on ${realBackupDir} type exfat (rw,relatime)`,
      `${injected} on /home/mallory/x type fuse.sshfs (rw,user_id=1001)`,
    ];
    stub("mount", `cat <<'MOUNTEOF'\n${lines.join("\n")}\nMOUNTEOF\nexit 0`);
    return injected;
  };

  it("is not decided by a forged line injected through a newline in a SOURCE", () => {
    const injected = newlineInjection();
    // mountinfo's own spelling of the same table: the injected bytes stay
    // inside the source field of the attacker's OWN mount, whose mount point
    // (/home/mallory/x) covers nothing.
    const esc = (v) => v.replace(/\\/g, "\\134").replace(/ /g, "\\040")
                        .replace(/\t/g, "\\011").replace(/\n/g, "\\012");
    const miPath = join(tmpDir, "mountinfo");
    writeFileSync(miPath, [
      "20 1 0:20 / / rw - ext4 /dev/root rw",
      `21 20 0:21 / ${esc(realBackupDir)} rw - exfat /dev/probe0 rw`,
      `22 20 0:22 / /home/mallory/x rw - fuse.sshfs ${esc(injected)} rw`,
    ].join("\n") + "\n", "utf8");
    mountinfoPath = miPath;
    const r = run();
    expect(err(r), "the destination's own entry decides, not a forged one")
      .toBe("DEST_UNSAFE");
    expect(r.stderr, "the escaped source must not be read as a mount line")
      .toMatch(/exfat is not known to enforce ownership/);
  });

  it("is not decided by that forged line when mount(8) is the only reader", () => {
    newlineInjection();
    mountinfoPath = "";
    dfStub(realBackupDir);
    const r = run();
    expect(err(r), "an unprivileged user must not be able to report the destination safe")
      .toBe("DEST_UNSAFE");
    // Forging a line is still possible; deciding with it is not. The forged
    // line has to claim the mount point df named to be considered at all, and
    // the real entry for it is already there — so the table has two claims and
    // answers nothing, rather than the last one winning.
    expect(r.stderr, "two claims on one mount point must be undetermined, not a verdict")
      .toMatch(/2 mount\(8\) lines claim/);
  });

  // ─── The mount member sets, derived from the script ────────
  //
  // Hand-copying a list into the suite measures the copy: 5 of the 20
  // allowlisted types were driven, and a type added to the script arrived with
  // no case at all. These read the lists out of the source, so the suite covers
  // whatever the script currently claims.
  const scriptList = (name) => {
    const m = new RegExp(`^${name}="([^"]*)"`, "m").exec(readFileSync(SCRIPT, "utf8"));
    expect(m, `${name} must be readable from the script`).not.toBeNull();
    return m[1].split(/\s+/).filter(Boolean);
  };

  const mountinfoFixture = (perMountOpts, fstype) => {
    const miPath = join(tmpDir, "mountinfo");
    writeFileSync(miPath, [
      "20 1 0:20 / / rw - ext4 /dev/root rw",
      `21 20 0:21 / ${realBackupDir.replace(/ /g, "\\040")} ${perMountOpts} - ${fstype} /dev/probe0 rw`,
    ].join("\n") + "\n", "utf8");
    mountinfoPath = miPath;
  };

  // A RECEIPT that the fixture is what answered. An allow case asserting only
  // `status === 0` passes on any host whose own root filesystem is allowlisted
  // — measured: with the seam ignored entirely, eight allow cases stayed green,
  // including the one that certifies all 21 allowlisted types. The script emits
  // this line for exactly the runs whose table came from the seam, so it is the
  // positive evidence those cases were missing.
  const readTheFixture = (r) => {
    expect(r.stderr, "the fixture must be the table the verdict came from")
      .toMatch(/reading the mount table from .*mountinfo instead of/);
  };

  it("accepts every filesystem type on the script's own allowlist", () => {
    const types = scriptList("OWNERSHIP_ENFORCING_FS");
    expect(types.length, "the allowlist must be non-trivial").toBeGreaterThan(10);
    // A `fuse.` type is a SELF-DECLARATION — the subtype is `-o subtype=`, which
    // the mounting user spells — so those members are accepted only with the
    // kernel-supplied user_id naming this uid. Everything else is a real type.
    const uid = process.getuid();
    for (const t of types) {
      mountinfoFixture(t.startsWith("fuse.") ? `rw,user_id=${uid}` : "rw", t);
      const r = run();
      expect(r.status, `${t} is on the allowlist but was refused: ${r.stderr}`).toBe(0);
      readTheFixture(r);
      rmSync(backupDir, { recursive: true, force: true });
    }
  });

  it("refuses every FUSE type on the allowlist when another uid made the mount", () => {
    // The paired deny side of the case above, over the same derived member set:
    // the subtype is the attacker's to write, so the allowlist was reading
    // their word for it. `user_id=` is what the kernel supplies, and it names
    // the principal whose daemon answers every ownership, mode and ACL probe
    // this script makes about the destination.
    const fuseTypes = scriptList("OWNERSHIP_ENFORCING_FS").filter((t) => t.startsWith("fuse."));
    expect(fuseTypes.length, "the allowlist must still invite the encrypting backends")
      .toBeGreaterThan(0);
    for (const t of fuseTypes) {
      mountinfoFixture("rw,user_id=9999", t);
      const r = run();
      expect(err(r), `${t} claimed by uid 9999 must not be verified safe`).toBe("DEST_UNSAFE");
      expect(r.stderr, `${t}: the daemon's owner must be the stated reason`)
        .toMatch(/was not made by this uid/);
      rmSync(backupDir, { recursive: true, force: true });
    }
  });

  it("refuses a FUSE mount whose table cannot say who made it", () => {
    // "Examined nothing" must not be spelled like "found nothing": a line with
    // no user_id at all is a table that cannot be asked, not a mount that
    // passed.
    mountinfoFixture("rw", "fuse.gocryptfs");
    const r = run();
    expect(err(r)).toBe("DEST_UNSAFE");
    expect(r.stderr).toMatch(/was not made by this uid/);
  });

  it("refuses every option the script calls unsafe, on an allowlisted type", () => {
    const opts = scriptList("UNSAFE_MOUNT_OPTS");
    expect(opts.length, "the unsafe-option set must be non-trivial").toBeGreaterThan(5);
    for (const o of opts) {
      // ext4 is allowlisted, so the OPTION is the only thing left that can
      // refuse — an unlisted type would refuse first and prove nothing.
      mountinfoFixture(`rw,${o}`, "ext4");
      const r = run();
      expect(err(r), `${o}= must make the destination unsafe`).toBe("DEST_UNSAFE");
      expect(r.stderr, `${o}: the option must be the stated reason`).toMatch(/ownership advisory/);
      rmSync(backupDir, { recursive: true, force: true });
    }
  });

  // ─── A path is not a pattern ───────────────────────────────
  //
  // mountinfo escapes only \040 \011 \012 \134, so every glob metacharacter
  // reaches the reader verbatim. An unquoted expansion does pathname expansion
  // as well as word splitting, so a mount point containing one used to expand
  // to a DIFFERENT string as soon as something beside it matched: the
  // destination's own mount matched nothing, the descent stopped at its parent,
  // and the verdict was inherited from an ancestor. The direction is what makes
  // it matter — a mount the reader cannot see is indistinguishable from one
  // that is not there, and the ancestor is normally the safe root.
  for (const [label, fstype, wantStatus] of [
    ["refuses", "exfat", null],
    ["accepts", "ext4", 0],
  ]) {
    it(`${label} a destination whose NAME contains a glob, with a sibling that matches`, () => {
      const dest = join(realBackupDir, "gen[1]");
      mkdirSync(dest, { recursive: true, mode: 0o700 });
      // The sibling is what makes the pattern match something; without it the
      // expansion is a no-op and the case proves nothing.
      mkdirSync(join(realBackupDir, "gen1"), { recursive: true, mode: 0o700 });
      const esc = (v) => v.replace(/ /g, "\\040");
      const miPath = join(tmpDir, "mountinfo");
      writeFileSync(miPath, [
        "20 1 0:20 / / rw - ext4 /dev/root rw",
        `21 20 0:21 / ${esc(dest)} rw - ${fstype} /dev/probe0 rw`,
      ].join("\n") + "\n", "utf8");
      mountinfoPath = miPath;
      const r = run({ BACKUP_DIR: dest });
      if (wantStatus === 0) {
        expect(r.status, `an ${fstype} destination must not be refused: ${r.stderr}`).toBe(0);
        readTheFixture(r);
      } else {
        expect(err(r), "the destination's own entry must still be found").toBe("DEST_UNSAFE");
        expect(r.stderr).toMatch(/exfat is not known to enforce ownership/);
      }
    });
  }

  it("says in the log when the mount table came from somewhere else", () => {
    // The seam decides the whole destination-safety verdict from a file the
    // operator names. The other escape from the same verdict — the
    // ALLOW_UNVERIFIED flag — warns loudly; this one said nothing, so a log
    // review could not tell the check had been answered by a fixture.
    mountStub("/dev/probe0 on /probe type ext4 (rw,relatime)");
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr, "an overridden mount table must be visible")
      .toMatch(/reading the mount table from .* instead of \/proc\/self\/mountinfo/);
  });

  it("says nothing when the mount table is the real one (paired allow case)", () => {
    // The direction that keeps the warning worth reading: the default must stay
    // silent, or every run gains a line nobody looks at.
    // No status assertion: on a host whose TMPDIR is not on an allowlisted
    // filesystem the run legitimately refuses, and that would red this case for
    // a reason that has nothing to do with the warning it names.
    mountinfoPath = undefined;
    const r = run();
    expect(r.stderr, "the default path must not warn").not.toMatch(/reading the mount table from/);
  });

  it("is not denied by an ambiguous line that could not be claiming the destination", () => {
    // The allow side of the ambiguity gate. Its subject is the mount point df
    // named, which is a short generic string — testing whether a line merely
    // CONTAINS it denied the whole table for a mount nowhere near the
    // destination. A local user owning a directory called `a on b` plus
    // fusermount was enough, and on the fallback where the mount point is `/`
    // every line contains it.
    stub("mount", `cat <<'MOUNTEOF'
/dev/root on / type ext4 (rw,relatime)
evil on ${realBackupDir}/sub/a on b type fuse.sshfs (rw,user_id=1001)
/dev/probe0 on ${realBackupDir} type exfat (rw,relatime)
MOUNTEOF
exit 0`);
    dfStub(realBackupDir);
    mountinfoPath = "";
    const r = run();
    expect(err(r), "the destination's own entry must still decide").toBe("DEST_UNSAFE");
    expect(r.stderr, "an unrelated ambiguous line must not poison the table")
      .toMatch(/exfat is not known to enforce ownership/);
    expect(r.stderr).not.toMatch(/non-unique separators/);
  });

  it("refuses a mount table that is not a regular file", () => {
    // A FIFO is readable and blocks forever with no writer, and the seam accepts
    // any path — so this arrives through the open, before any of the parsing
    // the visited set guards. The run would hold the lock until somebody looked.
    const fifo = join(tmpDir, "mi.fifo");
    spawnSync("mkfifo", [fifo]);
    expect(existsSync(fifo), "mkfifo must be available for this case").toBe(true);
    mountinfoPath = fifo;
    const r = run();
    expect(err(r), "a table that cannot be opened is not a verdict").toBe("DEST_UNSAFE");
    expect(r.stderr).toMatch(/not a readable regular file/);
  });

  it("refuses an override that names nothing", () => {
    // The other half of F2: an override that does not resolve must not silently
    // hand the verdict to the weaker text reader.
    mountinfoPath = join(tmpDir, "no-such-mountinfo");
    const r = run();
    expect(err(r)).toBe("DEST_UNSAFE");
    expect(r.stderr).toMatch(/BACKUP_MOUNTINFO_PATH names .* which is not a readable regular file/);
  });

  it("refuses a BACKUP_MOUNTINFO_PATH carrying a newline", () => {
    // It reaches a line-oriented sink — the warning that tells a log reader
    // where the verdict came from — so INV-C1a's table covers it like every
    // other path this script accepts.
    const r = run({ BACKUP_MOUNTINFO_PATH: "/tmp/x\n[backup-db] mount check: verified safe" });
    expect(err(r)).toBe("BAD_ENV");
    expect(r.stderr).toMatch(/must not contain a newline/);
  });

  it("does not expand BACKUP_DATABASES as a pattern", () => {
    // The same missing option, one loop away: the validator inspected the
    // EXPANSION, so in a working directory whose entries are identifier-shaped
    // the run proceeded with a silently substituted target set.
    const r = run({ BACKUP_DATABASES: "*" });
    expect(err(r), "a pattern is not a database name").toBe("BAD_ENV");
    expect(r.stderr, "and the value reported must be the one the operator set")
      .toMatch(/invalid database name: \*/);
  });

  // ─── Visibility is the mount TREE, not the longest string ──
  //
  // mountinfo's own spec says so: which mount a path resolves through is
  // decided by the mount-id/parent-id relation, because a later mount over an
  // ancestor HIDES a child whose mount point is the longer string.

  it("is not decided by a child mount that a later mount over its ancestor hides", () => {
    // /probe/sub (ext4) was mounted first, so its parent is the root mount.
    // Then exFAT was mounted at /probe, which covers the directory /probe/sub
    // lives in — the child is unreachable and the destination is on exFAT.
    // Picking the longest covering mount point reports the hidden ext4.
    const sub = join(realBackupDir, "sub");
    mkdirSync(sub, { recursive: true, mode: 0o700 });
    const esc = (v) => v.replace(/ /g, "\\040");
    const miPath = join(tmpDir, "mountinfo");
    writeFileSync(miPath, [
      "20 1 0:20 / / rw - ext4 /dev/root rw",
      `21 20 0:21 / ${esc(sub)} rw - ext4 /dev/safe rw`,
      `22 20 0:22 / ${esc(realBackupDir)} rw - exfat /dev/usb rw`,
    ].join("\n") + "\n", "utf8");
    mountinfoPath = miPath;
    const r = run({ BACKUP_DIR: sub });
    expect(err(r), "the destination is on the exFAT that hid the child").toBe("DEST_UNSAFE");
    expect(r.stderr).toMatch(/exfat is not known to enforce ownership/);
  });

  it("reaches the same verdict when the hiding mount is listed FIRST", () => {
    // The same tree, listed the other way round. mountinfo's order is not a
    // promise about visibility, so a rule that takes the last covering entry —
    // or the last among siblings — flips the verdict on this input while the
    // tree it describes is unchanged. Two children of one parent can only be
    // in a prefix relation if the shorter was mounted last, which is the
    // deduction the reader makes instead of reading the order.
    const sub = join(realBackupDir, "sub");
    mkdirSync(sub, { recursive: true, mode: 0o700 });
    const esc = (v) => v.replace(/ /g, "\\040");
    const miPath = join(tmpDir, "mountinfo");
    writeFileSync(miPath, [
      "20 1 0:20 / / rw - ext4 /dev/root rw",
      `22 20 0:22 / ${esc(realBackupDir)} rw - exfat /dev/usb rw`,
      `21 20 0:21 / ${esc(sub)} rw - ext4 /dev/safe rw`,
    ].join("\n") + "\n", "utf8");
    mountinfoPath = miPath;
    const r = run({ BACKUP_DIR: sub });
    expect(err(r), "the hidden child must not answer, whichever line comes first")
      .toBe("DEST_UNSAFE");
    expect(r.stderr).toMatch(/exfat is not known to enforce ownership/);
  });

  it("still descends INTO a child that nothing hides (paired allow case)", () => {
    // The other direction, and the reason the rule is not simply "shortest
    // wins": a child mounted inside its parent is a child in the tree, so the
    // descent reaches it and it is the one that answers. Without this, refusing
    // the hidden case could be done by always taking the ancestor.
    const sub = join(realBackupDir, "sub");
    mkdirSync(sub, { recursive: true, mode: 0o700 });
    const esc = (v) => v.replace(/ /g, "\\040");
    const miPath = join(tmpDir, "mountinfo");
    writeFileSync(miPath, [
      "20 1 0:20 / / rw - ext4 /dev/root rw",
      `21 20 0:21 / ${esc(realBackupDir)} rw - ext4 /dev/outer rw`,
      `22 21 0:22 / ${esc(sub)} rw - exfat /dev/inner rw`,
    ].join("\n") + "\n", "utf8");
    mountinfoPath = miPath;
    const r = run({ BACKUP_DIR: sub });
    expect(err(r), "the visible child is the filesystem the path is on").toBe("DEST_UNSAFE");
    expect(r.stderr).toMatch(/exfat is not known to enforce ownership/);
  });

  // / itself mounted over, spelled the way the kernel spells it: the covering
  // mount is a CHILD of the one it covers, so the descent reaches it from
  // either starting point. Both listing orders assert the same verdict, which
  // is the order-independence claim the design actually makes. The earlier
  // version of this case used two roots naming a parent absent from the table —
  // a shape the kernel cannot emit — and so certified a rule against input that
  // never arrives.
  for (const [label, lines] of [
    ["covering mount listed last", [
      "20 20 0:20 / / rw - ext4 /dev/under rw",
      "21 20 0:21 / / rw - exfat /dev/over rw",
    ]],
    ["covering mount listed first", [
      "21 20 0:21 / / rw - exfat /dev/over rw",
      "20 20 0:20 / / rw - ext4 /dev/under rw",
    ]],
  ]) {
    it(`resolves a / that is mounted over — ${label}`, () => {
      const miPath = join(tmpDir, "mountinfo");
      writeFileSync(miPath, lines.join("\n") + "\n", "utf8");
      mountinfoPath = miPath;
      const r = run();
      expect(err(r), "the topmost mount is the one the path resolves through").toBe("DEST_UNSAFE");
      expect(r.stderr).toMatch(/exfat is not known to enforce ownership/);
    });
  }

  it("refuses when two mounts with one parent claim the same point", () => {
    // Equal-length covering mount points among siblings are the SAME string,
    // which the kernel does not produce — an over-mount is a child of what it
    // covers, and this host's table has no duplicate parent+mount-point pair.
    // The reader used to break that tie by listing order, in the one place its
    // own comment says ordering must never decide. An input it cannot attribute
    // is refused instead.
    const esc = (v) => v.replace(/ /g, "\\040");
    const miPath = join(tmpDir, "mountinfo");
    writeFileSync(miPath, [
      "20 1 0:20 / / rw - ext4 /dev/root rw",
      `21 20 0:21 / ${esc(realBackupDir)} rw - ext4 /dev/safe rw`,
      `22 20 0:22 / ${esc(realBackupDir)} rw - exfat /dev/usb rw`,
    ].join("\n") + "\n", "utf8");
    mountinfoPath = miPath;
    const r = run();
    expect(err(r), "an unattributable tie is not a verdict").toBe("DEST_UNSAFE");
    expect(r.stderr).toMatch(/two mounts with one parent both claim/);
  });

  it("skips a mountinfo line too short to be one, rather than dying on it", () => {
    // The format cannot produce a line with fewer than ten fields, but a
    // truncated read can, and the seam accepts any path. Without the field
    // count the reader indexes $2 of a one-field line, which `set -u` turns
    // into an abort partway through the destination check.
    const esc = (v) => v.replace(/ /g, "\\040");
    const miPath = join(tmpDir, "mountinfo");
    writeFileSync(miPath, [
      "20 1 0:20 / / rw - ext4 /dev/root rw",
      "truncated",
      `21 20 0:21 / ${esc(realBackupDir)} rw - exfat /dev/probe0 rw`,
    ].join("\n") + "\n", "utf8");
    mountinfoPath = miPath;
    const r = run();
    expect(err(r), "the well-formed entry must still decide").toBe("DEST_UNSAFE");
    expect(r.stderr).toMatch(/exfat is not known to enforce ownership/);
  });

  it("resolves the destination when the ROOT names itself as its parent", () => {
    // proc_pid_mountinfo(5): the parent ID is "the ID of the parent mount (or
    // of self for the root of this mount namespace)". A self-parent root is the
    // documented spelling, not a malformed table — and a reader that re-selects
    // it as its own child refuses EVERY run on such a host, which is the whole
    // destination check denied rather than one destination misjudged.
    const esc = (v) => v.replace(/ /g, "\\040");
    const miPath = join(tmpDir, "mountinfo");
    writeFileSync(miPath, [
      "20 20 0:20 / / rw - ext4 /dev/root rw",
      `21 20 0:21 / ${esc(realBackupDir)} rw - exfat /dev/probe0 rw`,
    ].join("\n") + "\n", "utf8");
    mountinfoPath = miPath;
    const r = run();
    expect(err(r), "the destination's own entry must still decide").toBe("DEST_UNSAFE");
    expect(r.stderr, "and for ITS reason, not for a cycle")
      .toMatch(/exfat is not known to enforce ownership/);
  });

  it("accepts a self-parent root whose destination is safe (paired allow case)", () => {
    // The direction that proves the fix is not "always deny": the same shape
    // with an allowlisted type must publish. Without it, refusing the cycle
    // could be done by refusing everything.
    const esc = (v) => v.replace(/ /g, "\\040");
    const miPath = join(tmpDir, "mountinfo");
    writeFileSync(miPath, [
      "20 20 0:20 / / rw - ext4 /dev/root rw",
      `21 20 0:21 / ${esc(realBackupDir)} rw - ext4 /dev/probe0 rw`,
    ].join("\n") + "\n", "utf8");
    mountinfoPath = miPath;
    const okSelf = run();
    expect(okSelf.status, "a self-parent root is a normal table").toBe(0);
    readTheFixture(okSelf);
  });

  it("refuses a mountinfo that describes a real cycle instead of walking it forever", () => {
    // A cycle through TWO ids, which is what the visited set is for now that a
    // mount can no longer be its own child. Nothing in the format forbids it and
    // the reader's path is a seam, so it is reachable input. A backup that HANGS
    // is worse than one that refuses: there is no timeout around a cron run, so
    // it would sit holding the lock until somebody noticed. Found by a mutant
    // that removed the parent check and left a vitest run wedged for 94 minutes.
    // Note the fixture lists id 21 twice — mount ids are unique per mount, so a
    // parent-id cycle over DISTINCT ids cannot be built. Only a corrupt or
    // hand-written table has one, and the reader's path accepts any file.
    const esc = (v) => v.replace(/ /g, "\\040");
    const miPath = join(tmpDir, "mountinfo");
    writeFileSync(miPath, [
      "20 20 0:20 / / rw - ext4 /dev/root rw",
      `21 20 0:21 / ${esc(realBackupDir)} rw - ext4 /dev/a rw`,
      `22 21 0:22 / ${esc(realBackupDir)} rw - ext4 /dev/b rw`,
      `21 22 0:21 / ${esc(realBackupDir)} rw - ext4 /dev/a rw`,
    ].join("\n") + "\n", "utf8");
    mountinfoPath = miPath;
    const r = run();
    expect(err(r), "an unwalkable table is undetermined, not a hang").toBe("DEST_UNSAFE");
    expect(r.stderr).toMatch(/cycle at mount id/);
  });

  it("refuses an ID-mapped mount", () => {
    // The option name this script refuses if the kernel ever prints it in the
    // per-mount field — see the script, which records that it could not observe
    // one. What this case pins is MEMBERSHIP of the list, which the derived-set
    // case cannot: deleting the member deletes it from the derivation too. An
    // id-mapped mount
    // translates owner uid/gid across the mount, so the archive can read back
    // as owned by this uid at 0600 here and be owned by another uid in the view
    // the mapping exists to serve — the same property `uid=` is refused for.
    const esc = (v) => v.replace(/ /g, "\\040");
    const miPath = join(tmpDir, "mountinfo");
    writeFileSync(miPath, [
      "20 1 0:20 / / rw - ext4 /dev/root rw",
      `21 20 0:21 / ${esc(realBackupDir)} rw,idmapped - ext4 /dev/probe0 rw`,
    ].join("\n") + "\n", "utf8");
    mountinfoPath = miPath;
    const r = run();
    expect(err(r)).toBe("DEST_UNSAFE");
    expect(r.stderr).toMatch(/ownership advisory/);
  });

  // ─── df's own row is the same injection surface ────────────
  //
  // Naming the mount point with df moves the question, it does not remove it:
  // when the destination is ON the attacker's FUSE mount, df prints THEIR
  // fsname in its device column. The member set is therefore both readers, not
  // just mount(8) — one row is required, and the field boundary is fixed at the
  // capacity column rather than at whatever bytes the device happens to carry.

  it("refuses when df prints more than one row for the destination", () => {
    mountStub("/dev/probe0 on /probe type ext4 (rw,relatime)", [], { textPath: true });
    // -P is one physical line per filesystem and a PATH selects one filesystem,
    // so a second row is a newline in a field, not a second answer.
    stub("df", `printf 'Filesystem 512-blocks Used Available Capacity Mounted on\\n`
      + `injected 1 1 1 1%%    /elsewhere\\n/dev/probe0 1 1 1 1%%    %s\\n' '${realBackupDir}'`);
    const r = run();
    expect(err(r)).toBe("DEST_UNSAFE");
    expect(r.stderr).toMatch(/df\(1\) could not name/);
  });

  it("refuses when a '%' in df's DEVICE field makes the boundary ambiguous", () => {
    // The device is the attacker-spelled field (a FUSE fsname), and the mount
    // point is a directory name; neither is this script's to control, so when
    // both could hold the capacity boundary there is nothing to prefer between
    // them. Preferring the rightmost is what let a mount point carrying `% `
    // hand the verdict to an unrelated filesystem, so this row is refused
    // rather than adjudicated — one row, one boundary, or no answer.
    mountStub("/dev/probe0 on /probe type exfat (rw,relatime)", [], { textPath: true });
    stub("df", `printf 'Filesystem 512-blocks Used Available Capacity Mounted on\\n`
      + `evil%% /decoy 1 1 1 1%%    %s\\n' '${realBackupDir}'`);
    const r = run();
    expect(err(r), "an ambiguous row is not an answer").toBe("DEST_UNSAFE");
    expect(r.stderr).toMatch(/df\(1\) could not name/);
  });

  it("still answers for an ordinary df row (paired allow case)", () => {
    // The direction the uniqueness rule must not break: every real row has
    // exactly one `% `, and the macOS path depends entirely on this working.
    mountStub("/dev/probe0 on /probe type exfat (rw,relatime)", [], { textPath: true });
    const r = run();
    expect(err(r), "the destination's own line must still decide").toBe("DEST_UNSAFE");
    expect(r.stderr).toMatch(/exfat is not known to enforce ownership/);
  });

  it("refuses rather than guesses when a '%' in the MOUNT POINT truncates df's answer", () => {
    mountStub("/dev/probe0 on /probe type ext4 (rw,relatime)", [], { textPath: true });
    stub("df", "printf 'Filesystem 512-blocks Used Available Capacity Mounted on\\n"
      + "/dev/probe0 1 1 1 1%%    /Volumes/50%% off\\n'");
    const r = run();
    expect(err(r), "a truncated answer is not an answer").toBe("DEST_UNSAFE");
    expect(r.stderr).toMatch(/df\(1\) could not name/);
  });

  it("refuses when the truncation would leave a REAL other mount point", () => {
    // The case the previous comment claimed was already handled: `${row##*% }`
    // leaves everything after the LAST `% `, and when a mount point contains
    // `% /…` the remainder is a well-formed absolute path — so it does not
    // "match no line and refuse", it matches an entirely different filesystem
    // and that filesystem's verdict is returned for this destination. The
    // boundary has to be unique, not merely rightmost.
    stub("mount", `cat <<'MOUNTEOF'
/dev/root on / type ext4 (rw,relatime)
/dev/safe on /mnt/safe type ext4 (rw,relatime)
gocryptfs on /home/att/x% /mnt/safe type exfat (rw,relatime)
MOUNTEOF
exit 0`);
    stub("df", "printf 'Filesystem 512-blocks Used Available Capacity Mounted on\\n"
      + "/dev/fuse0 1 1 1 1%%    /home/att/x%% /mnt/safe\\n'");
    mountinfoPath = "";
    const r = run();
    expect(err(r), "an unrelated ext4 must not answer for an exfat destination")
      .toBe("DEST_UNSAFE");
    expect(r.stderr).toMatch(/df\(1\) could not name/);
  });

  it("accepts a mount point containing a SPACE", () => {
    // Measured on the macOS verification host: `/dev/disk5s1 on /Volumes/Backups
    // of mrx33 (apfs, local, nodev, nosuid, journaled, nobrowse)`, alongside a
    // `map auto_home on …` whose DEVICE has one. The round-5 residual — a mount
    // with a space in both fields is undetermined — was a consequence of keying
    // on df's device column and taking the mount point with `##* `. Neither is
    // done now: df supplies the whole field after the capacity, and the line is
    // matched on its own mount point, so both spaces are ordinary bytes.
    const vol = "/Volumes/Backups of mrx33";
    stub("mount", `cat <<'MOUNTEOF'
/dev/root on / type ext4 (rw,relatime)
map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)
/dev/disk5s1 on ${vol} (apfs, local, nodev, nosuid, journaled, nobrowse)
MOUNTEOF
exit 0`);
    dfStub(vol);
    mountinfoPath = "";
    expect(run().status, "an apfs volume whose name has a space must not be refused").toBe(0);
  });

  it("resolves a mount point containing a SPACE through mountinfo's \\040", () => {
    // The structured table escapes the space, so the destination's own path has
    // to be escaped the same way before it is compared — otherwise the entry
    // for a volume like the one above is never found and Linux falls back to an
    // ancestor.
    const esc = (v) => v.replace(/ /g, "\\040");
    const spaced = join(realBackupDir, "with space");
    mkdirSync(spaced, { recursive: true, mode: 0o700 });
    const miPath = join(tmpDir, "mountinfo");
    writeFileSync(miPath, [
      "20 1 0:20 / / rw - ext4 /dev/root rw",
      `21 20 0:21 / ${esc(spaced)} rw - exfat /dev/probe0 rw`,
    ].join("\n") + "\n", "utf8");
    mountinfoPath = miPath;
    const r = run({ BACKUP_DIR: spaced });
    expect(err(r), "the escaped entry for the destination must be the one that answers")
      .toBe("DEST_UNSAFE");
    expect(r.stderr).toMatch(/exfat is not known to enforce ownership/);
  });

  it("refuses an encrypting FUSE backend opened to other uids", () => {
    // allow_other is the standard way to expose such a mount, and without
    // default_permissions the kernel stops checking entirely. assert_mode_private
    // cannot see it: the archive really is 0600, it is just not enforced.
    // user_id must be THIS uid, or the FUSE ownership check refuses first and
    // `allow_other` — the thing this case is about — is never reached. Hardcoded
    // as 1000 it passed on Linux and refused for the wrong reason on macOS,
    // where the operator's uid is 501.
    mountStub(`gocryptfs@ on /probe type fuse.gocryptfs (rw,nosuid,nodev,user_id=${process.getuid()},allow_other)`);
    const r = run();
    expect(err(r)).toBe("DEST_UNSAFE");
    expect(r.stderr).toMatch(/ownership advisory/);
  });

  it("refuses when mount(8) cannot answer", () => {
    passthrough("df", `
if [ "$2" = "--" ] || [ "$1" = "-P" ]; then
  printf 'Filesystem 1K-blocks Used Avail Use%% Mounted on\n/dev/probe0 1 1 1 1%% /probe\n'
  exit 0
fi`);
    mountinfoPath = "";
    stub("mount", "exit 1");
    const r = run();
    expect(err(r)).toBe("DEST_UNSAFE");
    expect(r.stderr).toMatch(/could not determine whether/);
  });



  it("refuses when no mount(8) entry covers the destination", () => {
    // Not "the device is missing" — the object is the PATH now. An
    // unattributable table has not performed the check, which is not the same
    // as having passed.
    mountinfoPath = "";
    stub("mount", `cat <<'MOUNTEOF'
sysfs /sys sysfs rw 0 0
MOUNTEOF
exit 0`);
    const r = run();
    expect(err(r)).toBe("DEST_UNSAFE");
    expect(r.stderr).toMatch(/could not determine whether/);
  });

  it("refuses when the ACL check cannot answer", () => {
    passthrough("ls", `
case " $* " in
  *" -ld "*|*" -lde "*) exit 1 ;;
esac`);
    const r = run();
    expect(err(r)).toBe("DEST_UNSAFE");
    // Anchored on the ROOT arm. The two call sites share one message stem, so an
    // unanchored match let either arm satisfy the other's deletion.
    expect(r.stderr).toMatch(/could not read the ACL state of (?!ancestor)/);
  });

  it("refuses when the ACL check cannot answer for an ANCESTOR", () => {
    // The second call site, which the root assertion above cannot distinguish.
    const parent = realParentDir;
    passthrough("ls", `
case " $* " in
  *" -ld "*|*" -lde "*)
    for a in "$@"; do [ "$a" = "${parent}" ] && exit 1; done ;;
esac`);
    const r = run();
    expect(err(r)).toBe("DEST_UNSAFE");
    expect(r.stderr).toMatch(/could not read the ACL state of ancestor/);
  });

  it("refuses a destination whose ACL is shown on continuation lines", () => {
    // macOS prints the ACEs below the listing with no `+` on the mode field, so
    // the newline arm is the only thing that sees them — and it is reachable on
    // Linux too, because that case runs after the uname switch.
    passthrough("ls", `
for a in "$@"; do
  case "$a" in
    "${realBackupDir}")
      printf 'drwx------ 2 me me 4096 Jan 1 00:00 %s\n' "${realBackupDir}"
      printf ' 0: user:someone allow read,write\n'
      exit 0 ;;
  esac
done`);
    const r = run();
    expect(err(r)).toBe("DEST_UNSAFE");
    expect(r.stderr).toMatch(/extended ACL/);
  });

  it("refuses a Linux FUSE filesystem whatever the backend is", () => {
    // Linux spells every FUSE backend `fuse.<name>`, so the exact-match list
    // could never see fuse.sshfs, fuse.s3fs or fuse.rclone — the last two write
    // the corpus to a remote store in the clear. `sshfs` was IN the list and
    // unreachable on both platforms.
    mountStub("/dev/probe0 on /probe type fuse.s3fs (rw,nosuid,nodev)");
    const r = run();
    expect(err(r)).toBe("DEST_UNSAFE");
    expect(r.stderr).toMatch(/not known to enforce ownership/);
  });

  it("accepts an encrypting FUSE backend — the medium the docs prescribe", () => {
    // The paired allow case the blanket `fuse.*` refusal had none of. gocryptfs,
    // veracrypt and friends store POSIX uid and mode and default to owner-only,
    // and both operator documents name an encrypted volume as THE remedy for the
    // removable-media scenario this guard exists to catch. A guard that denies
    // its own prescribed remedy has nowhere left to send the operator.
    // user_id names THIS uid: the subtype is the mounter's to spell, so the
    // allowlist entry alone is the mounter's word for it, and the operator's
    // own mount is the case that must keep working.
    for (const fs of ["fuse.gocryptfs", "fuse.veracrypt", "fuse.cryfs"]) {
      mountStub(`/dev/probe0 on /probe type ${fs} (rw,nosuid,nodev,user_id=${process.getuid()})`);
      expect(run().status, `${fs} must be accepted`).toBe(0);
      rmSync(backupDir, { recursive: true, force: true });
    }
  });

  // Mount lines below are copied verbatim from `mount` on the macOS
  // verification host (Darwin 25.5.0, /bin/bash 3.2.57) — the platform the
  // portability floor exists for and the one the plan names as primary. The
  // parser had only ever been exercised against hand-written Linux shapes.
  it("refuses a macFUSE mount, whose generic type names no backend", () => {
    // macOS reports `macfuse` for gocryptfs, s3fs and everything else on that
    // transport, so the allowlist's Linux `fuse.gocryptfs` spelling can never
    // match there — and allowlisting `macfuse` wholesale would admit s3fs on the
    // identical line. Both are refused, and the message names the escape.
    mountStub("gocryptfs@/Users/x/enc on /probe (macfuse, nodev, nosuid, synchronous, mounted by operator)");
    const r = run();
    expect(err(r)).toBe("DEST_UNSAFE");
    expect(r.stderr).toMatch(/generic type macfuse/);
    expect(r.stderr, "the operator needs to be told what to do about it")
      .toMatch(/BACKUP_ALLOW_UNVERIFIED_MOUNT=true/);

    rmSync(backupDir, { recursive: true, force: true });
    mountStub("s3fs on /probe (macfuse, nodev, nosuid, mounted by operator)");
    expect(err(run()), "the same line shape must not become an allow").toBe("DEST_UNSAFE");
  });

  it("accepts a real macOS apfs volume (paired allow case)", () => {
    mountStub("/dev/disk3s1s1 on /probe (apfs, sealed, local, read-only, journaled)");
    expect(run().status, "apfs is the ordinary macOS destination").toBe(0);
  });

  it("refuses a real macOS autofs mount whose DEVICE contains a space", () => {
    // `map auto_home on … (autofs, automounted, nobrowse)` — verbatim from the
    // host. `${line%% *}` truncates the device to `map`, so the device key alone
    // could not find this entry; the mount-point key is what does.
    mountStub("map auto_home on /probe (autofs, automounted, nobrowse)");
    const r = run();
    expect(err(r)).toBe("DEST_UNSAFE");
    expect(r.stderr).toMatch(/autofs is not known to enforce ownership/);
  });

  it("refuses a filesystem type the allowlist has never heard of", () => {
    // The denylist answered "safe" for every type nobody enumerated. Measured
    // survivors included the Parallels and VMware shared folders — the same
    // class as the vboxsf that WAS listed.
    for (const fs of ["prl_fs", "vmhgfs", "ceph", "iso9660"]) {
      mountStub(`/dev/probe0 on /probe type ${fs} (rw)`);
      const r = run();
      expect(err(r), `${fs} must not be accepted`).toBe("DEST_UNSAFE");
      expect(r.stderr).toMatch(/not known to enforce ownership/);
      rmSync(backupDir, { recursive: true, force: true });
    }
  });

  it("refuses an allowlisted filesystem mounted with a fabricated owner", () => {
    // ext4 mounted with uid= is still ext4, so the type alone cannot rule this
    // out. These options are the property the type list exists to detect.
    for (const opt of ["uid=1000", "gid=1000", "umask=0022", "fmask=0111", "mode=0777"]) {
      mountStub(`/dev/probe0 on /probe type ext4 (rw,relatime,${opt})`);
      const r = run();
      expect(err(r), `${opt} must not be accepted`).toBe("DEST_UNSAFE");
      expect(r.stderr).toMatch(/ownership advisory/);
      rmSync(backupDir, { recursive: true, force: true });
    }
  });

  it("proceeds under BACKUP_ALLOW_UNVERIFIED_MOUNT, and says so loudly", () => {
    // Both non-safe verdicts, one escape. Without it an allowlist that has not
    // heard of the operator's filesystem stops the only backup path, which is
    // the failure mode the blanket fuse.* refusal demonstrated.
    mountStub("/dev/probe0 on /probe type prl_fs (rw)");
    const r = run({ BACKUP_ALLOW_UNVERIFIED_MOUNT: "true" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/BACKUP_ALLOW_UNVERIFIED_MOUNT=true — proceeding without a verified filesystem/);

    rmSync(backupDir, { recursive: true, force: true });
    stub("mount", "exit 1");
    const r2 = run({ BACKUP_ALLOW_UNVERIFIED_MOUNT: "true" });
    expect(r2.status, "the undetermined verdict takes the same escape").toBe(0);
  });

  it("rejects a non-boolean BACKUP_ALLOW_UNVERIFIED_MOUNT", () => {
    expect(err(run({ BACKUP_ALLOW_UNVERIFIED_MOUNT: "yes" }))).toBe("BAD_ENV");
  });

  it("refuses a filesystem named only in the macOS option list", () => {
    // macOS prints no `type` field at all, so the options are the ONLY reading
    // that ever runs there. The two lists used to differ by six members, every
    // one of them missing from this one. Also the case that reds when
    // fstype_is_unsafe inherits `IFS=,` from its caller and stops splitting its
    // own member list — bash scopes `local` dynamically.
    mountStub("/dev/probe0 on /probe (afpfs, local, nodev, nosuid)");
    const r = run();
    expect(err(r)).toBe("DEST_UNSAFE");
    expect(r.stderr).toMatch(/not known to enforce ownership/);
  });
});

// ─── Guards round 3 measured as unpinned ────────────────────

describe("guards the round-3 sweep found unpinned", () => {
  it("distinguishes the four lock verdicts by message, not by one shared code", () => {
    // All four branches emit LOCKED, so a code-only assertion lets any branch
    // fall through to the next one with the suite green.
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    chmodSync(backupDir, 0o700);
    const lock = join(backupDir, ".lock.d");
    const cases = [
      { files: {}, re: /records no holder/ },
      { files: { pid: `${GONE_PID}\n`, host: "not-this-host\n" }, re: /liveness cannot be tested/ },
      { files: { pid: `${GONE_PID}\n`, host: `${hostname()}\n` }, re: /is held by a process that is gone/ },
    ];
    for (const c of cases) {
      rmSync(lock, { recursive: true, force: true });
      mkdirSync(lock, { recursive: true, mode: 0o700 });
      for (const [n, v] of Object.entries(c.files)) writeFileSync(join(lock, n), v, "utf8");
      const r = run();
      expect(err(r)).toBe("LOCKED");
      expect(r.stderr, `expected ${c.re}`).toMatch(c.re);
    }
  });

  it("records the holder's identity so a later run can judge it", () => {
    // Nothing observed what the script WRITES into the lock, so a run that held
    // it while recording nothing left every later run unable to tell a live
    // holder from a dead one.
    stub("docker", `
[ "\${2:-}" = "config" ] && exit 0
[ "\${2:-}" = "ps" ] && { echo c1; exit 0; }
for a in "$@"; do case "$a" in pg_dump) exec sleep 5 ;; esac; done
exit 0`);
    const child = spawn("bash", [SCRIPT], {
      env: { PATH: `${binDir}:${process.env.PATH}`, HOME: homeDir, LANG: "C", BACKUP_DIR: backupDir },
      stdio: "ignore",
    });
    try {
      const lock = join(backupDir, ".lock.d");
      const deadline = Date.now() + 5000;
      // Wait for the LAST field the script writes, not the first. `pid` is
      // written, then `host`, then `starttime`, each by its own redirection, so
      // polling on `pid` returns while `host` may not exist yet — this failed
      // under the parallel pre-PR run, which loads the machine enough to widen
      // the gap. The window is real but harmless in production: the reader
      // above resolves a lock with a pid and no host to "held by an unknown
      // host", which is the fail-closed direction.
      const written = () => ["pid", "host", "starttime"].every((f) => existsSync(join(lock, f)));
      while (Date.now() < deadline && !written()) {
        spawnSync("sleep", ["0.05"]);
      }
      expect(existsSync(join(lock, "pid")), "the holder pid must be recorded").toBe(true);
      expect(readFileSync(join(lock, "pid"), "utf8").trim()).toBe(String(child.pid));
      expect(readFileSync(join(lock, "host"), "utf8").trim()).toBe(hostname());
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("never publishes into a root replaced mid-run", async () => {
    // What this pins is the outcome, not the branch: a swap can be caught by
    // the redirect, by the publish, or by assert_root_unchanged depending on
    // when it lands, and racing for one of them makes a flaky test. The
    // property that matters either way is that the run does not succeed and
    // leaves nothing in the substituted directory. The specific PRUNE_ABORTED
    // branch is recorded as unpinned in the deviation log.
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    chmodSync(backupDir, 0o700);
    for (const n of ["20200101T000000Z", "20200102T000000Z", "20200103T000000Z"]) {
      mkdirSync(join(backupDir, n), { recursive: true, mode: 0o700 });
    }
    // The dumps take long enough to swap the root underneath.
    stub("docker", `
[ "\${2:-}" = "config" ] && exit 0
[ "\${2:-}" = "ps" ] && { echo c1; exit 0; }
for a in "$@"; do
  case "$a" in
    pg_dump)    sleep 2; printf 'PGDMP'; exit 0 ;;
    pg_dumpall) printf 'CREATE ROLE r;\\n-- PostgreSQL database cluster dump complete\\n'; exit 0 ;;
    pg_restore) printf '; h\\n1; 1 TABLE t o\\n'; exit 0 ;;
  esac
done
exit 0`);
    // The harness performed the swap, so its own outcome says nothing about the
    // run. What the run did is in the captured output, which carries the
    // script's exit code as a line.
    const swap = await runRootSwap(SCRIPT, join(tmpDir, "out"), backupDir, {
      PATH: `${binDir}:${process.env.PATH}`, HOME: homeDir, LANG: "C",
      BACKUP_DIR: backupDir, BACKUP_RETAIN: "1",
    });
    expect(swap.error, "the swap harness itself must have run").toBeUndefined();
    const out = readFileSync(join(tmpDir, "out"), "utf8");
    expect(out, "a replaced root must not yield a success").not.toMatch(/EXIT=0/);
    expect(generations(), "and must leave nothing published in the new root").toEqual([]);
    rmSync(`${backupDir}.moved`, { recursive: true, force: true });
  });

  it("runs the swap harness over paths carrying shell metacharacters without executing them", async () => {
    // The harness reads BACKUP_DB_SCRIPT and TMPDIR-derived paths, so neither is
    // guaranteed to be a bare word, and `$(…)` substitutes even inside double
    // quotes. The marker is what interpolating one of those paths back into
    // shell text would leave behind: it expands $HOME (which the harness passes)
    // rather than naming a directory, because the literal cannot contain a slash
    // and the run's cwd is not the harness's to assume.
    const marker = (label) => `${homeDir}-pwned-${label}`;
    const hostile = (label) => `${label};$(touch $HOME-pwned-${label})`;
    const scriptPath = join(tmpDir, `${hostile("script")}.sh`);
    writeFileSync(scriptPath, "#!/usr/bin/env bash\nexit 7\n", "utf8");
    chmodSync(scriptPath, 0o700);
    const rootPath = join(tmpDir, hostile("root"));
    mkdirSync(rootPath, { recursive: true, mode: 0o700 });

    const swap = await runRootSwap(scriptPath, join(tmpDir, "hostile-out"), rootPath, {
      PATH: `${binDir}:${process.env.PATH}`, HOME: homeDir, LANG: "C",
    });

    expect(swap.error, "the swap harness itself must have run").toBeUndefined();
    expect(existsSync(marker("script")), "the script path must not be re-parsed as shell text").toBe(false);
    expect(existsSync(marker("root")), "the root path must not be re-parsed as shell text").toBe(false);
    // Not just "nothing executed" — the paths must still have been USED, or a
    // harness that silently addressed nothing would read as a pass.
    expect(readFileSync(join(tmpDir, "hostile-out"), "utf8"), "the script at the hostile path must have run").toMatch(/EXIT=7/);
    expect(existsSync(`${rootPath}.moved`), "the root at the hostile path must have been swapped").toBe(true);
  });

  it("writes no credential into any published artifact", () => {
    // The sinks are enumerated by pattern, but nothing grepped the artifacts the
    // run actually produces — and MANIFEST is copied between hosts.
    const SENT = SENTINEL_PASSWORD;
    for (const bin of ["pg_dump", "pg_dumpall"]) {
      stub(bin, `
out=""; prev=""; for a in "$@"; do [ "$prev" = "-f" ] && out="$a"; prev="$a"; done
if [ "${bin}" = "pg_dumpall" ]; then
  printf 'CREATE ROLE r;\\n-- PostgreSQL database cluster dump complete\\n' > "$out"
else
  printf 'PGDMP' > "$out"
fi
exit 0`);
    }
    stub("pg_restore", `printf '; h\\n1; 1 TABLE t o\\n'
exit 0`);
    stub("psql", `printf 't|TLSv1.3|AESGCM\\n'
exit 0`);
    const r = run({
      MIGRATION_DATABASE_URL:
        `postgresql://u:${encodeURIComponent(SENT)}@127.0.0.1:5432/d?sslrootcert=/tmp/ca.pem`,
    });
    expect(r.status, r.stderr).toBe(0);
    const [gen] = generations();
    for (const f of readdirSync(join(backupDir, gen))) {
      expect(readFileSync(join(backupDir, gen, f), "utf8"),
        `${f} must not carry the credential`).not.toContain(SENT);
    }
  });

  it("removes a credential file left by an interrupted run", () => {
    // Only the dry run's obligation NOT to remove it was asserted; the real
    // run's obligation to remove it was not.
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    chmodSync(backupDir, 0o700);
    const orphan = join(backupDir, ".pgpass.orphan");
    writeFileSync(orphan, "*:*:*:*:leftover\n", "utf8");
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(orphan), "an orphaned credential must not survive a run").toBe(false);
    expect(r.stderr).toMatch(/removed a credential file/);
  });

  it("names a collided failure so the pruners can still see it", () => {
    // <stamp>.FAILED.<pid> would be outside list_stamped ".FAILED", making it an
    // unmanaged full plaintext corpus.
    //
    // The previous version of this case produced no collision at all: it
    // computed a stamp and re-ran, but the stamp loop skips any stamp whose
    // .FAILED already exists, so the second run always picked a fresh one — and
    // the asserted shape made the `.<pid>` group optional, so a plain
    // <stamp>.FAILED satisfied it. Renaming the collision form back to the
    // pre-fix spelling left the suite green.
    //
    // The collision has to appear DURING the run, which is what the stub does:
    // it creates <stamp>.FAILED for the in-flight run and then rejects the
    // archive, so the cleanup trap meets an occupied destination.
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    chmodSync(backupDir, 0o700);
    stub("docker", `
echo "docker $*" >> "${logFile}"
case "\${2:-}" in
  config) exit 0 ;;
  ps) echo container123; exit 0 ;;
esac
for a in "$@"; do
  case "$a" in
    pg_dump)    printf 'PGDMP-STUB-ARCHIVE'; exit 0 ;;
    pg_dumpall) printf 'CREATE ROLE r;\\n-- PostgreSQL database cluster dump complete\\n'; exit 0 ;;
    pg_restore)
      for p in "${backupDir}"/*.partial; do
        [ -e "$p" ] || continue
        mkdir -p -- "\${p%.partial}.FAILED"
      done
      exit 1 ;;
  esac
done
exit 0`);
    const r = run();
    expect(err(r)).toBe("VALIDATE_FAILED");
    const failed = readdirSync(backupDir).filter((n) => n.endsWith(".FAILED"));
    // Mandatory, not optional: the collision form must actually have been taken.
    expect(
      failed.filter((n) => /^\d{8}T\d{6}Z\.\d+\.FAILED$/.test(n)),
      `the collision form must be produced, got ${JSON.stringify(failed)}`,
    ).toHaveLength(1);
    for (const f of failed) {
      expect(f, "every failure name must stay matchable by the pruner")
        .toMatch(/^\d{8}T\d{6}Z(\.\d+)?\.FAILED$/);
    }
    expect(generations()).toEqual([]);
  });

  it("warns about a cluster database that is not in BACKUP_DATABASES", () => {
    // INV-C3a quantifies over a caller-supplied list, so without this the claim
    // "every database is backed up" is checked by nothing.
    stub("docker", `
[ "\${2:-}" = "config" ] && exit 0
[ "\${2:-}" = "ps" ] && { echo c1; exit 0; }
for a in "$@"; do
  case "$a" in
    psql)       printf '${dbRow("passwd_sso")}\\n${dbRow("jackson")}\\n${dbRow("postgres")}\\n${dbRow("forgotten_db")}\\n'; exit 0 ;;
    pg_dump)    printf 'PGDMP'; exit 0 ;;
    pg_dumpall) printf 'CREATE ROLE r;\\n-- PostgreSQL database cluster dump complete\\n'; exit 0 ;;
    pg_restore) printf '; h\\n1; 1 TABLE t o\\n'; exit 0 ;;
  esac
done
exit 0`);
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/forgotten_db.*is NOT being backed up/);
    // `postgres` is reported like any other database now. It usually holds no
    // application data, but "usually" is not a property this script can check,
    // and the operator silences it by naming it in BACKUP_DATABASES.
    expect(r.stderr).toMatch(/'postgres'.*is NOT being backed up/);
    const [gen] = generations();
    const manifest = readFileSync(join(backupDir, gen, "MANIFEST"), "utf8");
    expect(manifest).toMatch(/not_backed_up:.*forgotten_db/);
    expect(manifest).toMatch(/not_backed_up:.*postgres/);
  });

  it("records not_backed_up: unknown when the cluster enumeration fails", () => {
    // `(none)` is a legitimate value of this field's own domain, so writing it
    // after a failed enumeration made "nothing was left out" and "we could not
    // tell" indistinguishable — on the one field whose job is to say what the
    // corpus is missing. Measured: psql exiting 2 produced `(none)` and no
    // warning at all.
    stub("docker", `
[ "\${2:-}" = "config" ] && exit 0
[ "\${2:-}" = "ps" ] && { echo c1; exit 0; }
for a in "$@"; do
  case "$a" in
    psql)       echo 'psql: FATAL: permission denied for database "postgres"' >&2; exit 2 ;;
    pg_dump)    printf 'PGDMP'; exit 0 ;;
    pg_dumpall) printf 'CREATE ROLE r;\\n-- PostgreSQL database cluster dump complete\\n'; exit 0 ;;
    pg_restore) printf '; h\\n1; 1 TABLE t o\\n'; exit 0 ;;
  esac
done
exit 0`);
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr, "the operator must be told the check did not run")
      .toMatch(/could not enumerate the cluster's databases/);
    const [gen] = generations();
    const manifest = readFileSync(join(backupDir, gen, "MANIFEST"), "utf8");
    expect(manifest).toMatch(/not_backed_up: \(unknown/);
    expect(manifest, "the all-clear sentinel must not be written").not.toMatch(/not_backed_up: \(none\)/);
  });

  // ─── Guards proven only by the ERR_CODES source mirror ────
  //
  // The mirror fires only when a code stops being emitted ANYWHERE, so a guard
  // sharing its code with another site is invisible to it. Each of these
  // survived deletion with the suite green.

  it("rejects a BACKUP_DIR containing a newline", () => {
    // The passfile and the MANIFEST are both line-oriented and both derive from
    // this path.
    const r = run({ BACKUP_DIR: `${backupDir}\nevil` });
    expect(err(r)).toBe("BAD_ENV");
    expect(r.stderr).toMatch(/must not contain a newline/);
  });

  it("rejects an option-shaped COMPOSE_DB_SUPERUSER before any docker call", () => {
    const r = run({ COMPOSE_DB_SUPERUSER: "-e" });
    expect(err(r)).toBe("BAD_ENV");
    expect(readLog(), "nothing may be spawned with an unvalidated role name").toBe("");
  });

  it("accepts an ordinary role name (paired allow case)", () => {
    expect(run({ COMPOSE_DB_SUPERUSER: "passwd_user" }).status).toBe(0);
  });

  it("refuses an ancestor that is group/other-writable without the sticky bit", () => {
    const parent = realParentDir;
    const realStat = spawnSync("sh", ["-c", "command -v stat"], { encoding: "utf8" }).stdout.trim();
    stub("stat", `
last=""
for a in "$@"; do last="$a"; done
if [ "$last" = "${parent}" ]; then
  case " $* " in *" %a "*|*"'%Lp'"*|*" %Lp "*) echo 777; exit 0 ;; esac
fi
exec "${realStat}" "$@"`);
    const r = run();
    expect(err(r)).toBe("DEST_UNSAFE");
    expect(r.stderr).toMatch(/writable by others without the sticky bit/);
  });

  it("accepts a group/other-writable ancestor that IS sticky (paired allow case)", () => {
    // /tmp is the archetype, and refusing it would refuse the ordinary
    // destination. 1777 = sticky + 777.
    const parent = realParentDir;
    const realStat = spawnSync("sh", ["-c", "command -v stat"], { encoding: "utf8" }).stdout.trim();
    stub("stat", `
last=""
for a in "$@"; do last="$a"; done
if [ "$last" = "${parent}" ]; then
  case " $* " in *" %a "*|*"'%Lp'"*|*" %Lp "*) echo 1777; exit 0 ;; esac
fi
exec "${realStat}" "$@"`);
    expect(run().status).toBe(0);
  });

  it("declares a bash floor that compares the MAJOR component", () => {
    // Source-level on purpose, and labelled as such: BASH_VERSINFO is read-only
    // and the branch is only reachable under an actual bash 2.x, which no
    // supported platform still ships. What IS checkable is that the comparison
    // reads the major element and is not a constant, and that the branch has its
    // own identifier. Positive control included, per INV-C9d.
    const src = readFileSync(SCRIPT, "utf8");
    const floor = /BASH_VERSINFO\[0\]:-0\}" -lt 3/;
    expect(src).toMatch(floor);
    expect('if [ "${BASH_VERSINFO[0]:-0}" -lt 3 ]; then', "the pattern must match a real floor")
      .toMatch(floor);
    expect(src, "and it must fail with its own identifier").toMatch(/fail OLD_BASH/);
  });

  it("fails when the published run disappears during pruning", () => {
    // RUN_VANISHED has three emitters and the mirror only notices when all
    // three stop existing, so each was individually unpinned. This drives the
    // per-archive one: the pruner's own `rm` removes the file it just validated.
    stub("docker", `
[ "\${2:-}" = "config" ] && exit 0
[ "\${2:-}" = "ps" ] && { echo c1; exit 0; }
for a in "$@"; do
  case "$a" in
    pg_dump)    printf 'PGDMP'; exit 0 ;;
    pg_dumpall)
      # By now both archives exist inside the run directory. Remove one, so the
      # post-prune re-stat meets a published generation missing a member.
      rm -f "${backupDir}"/*.partial/passwd_sso.dump
      printf 'CREATE ROLE r;\\n-- PostgreSQL database cluster dump complete\\n'; exit 0 ;;
    pg_restore) printf '; h\\n1; 1 TABLE t o\\n'; exit 0 ;;
  esac
done
exit 0`);
    const r = run({ BACKUP_DATABASES: "passwd_sso" });
    expect(err(r)).toBe("RUN_VANISHED");
    expect(r.stderr).toMatch(/passwd_sso\.dump is missing/);
  });

  // The authority reaches URL_DISPLAY, and from there both the MANIFEST and the
  // log; the host slice additionally reaches the .pgpass line. All three are
  // line-oriented. Validation used to cover the host slice only, so both slices
  // are pinned here — the check is one `case` over the whole authority, and a
  // single-slice test cannot tell that from a single-slice check.
  for (const [what, url] of [
    ["USERNAME", "postgresql://us\ner:pw@dbhost:5432/d?sslrootcert=/x"],
    ["HOST", "postgresql://u:pw@db\nhost:5432/d?sslrootcert=/x"],
  ]) {
    it(`refuses an authority whose ${what} carries a newline`, () => {
      const r = run({ MIGRATION_DATABASE_URL: url });
      expect(err(r)).toBe("BAD_URL");
      expect(r.stderr).toMatch(/authority contains a newline/);
    });
  }

  it("refuses a host containing a backslash, which .pgpass reads as an escape", () => {
    // Not covered by the authority newline check — its own arm, and until now
    // its own untested one.
    const r = run({ MIGRATION_DATABASE_URL: "postgresql://u:pw@db\\host:5432/d?sslrootcert=/x" });
    expect(err(r)).toBe("BAD_URL");
    expect(r.stderr).toMatch(/backslash, which \.pgpass reads as an escape/);
  });

  it("previews the orphaned credential file it would remove", () => {
    // The dry run must name the same residue the real sweep removes, and must
    // remove nothing.
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    chmodSync(backupDir, 0o700);
    const orphan = join(backupDir, ".pgpass.orphan");
    writeFileSync(orphan, "*:*:*:*:leftover\n", "utf8");
    const r = run({ BACKUP_DRY_RUN: "true" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("would remove residue .pgpass.orphan");
    expect(existsSync(orphan), "a preview must delete nothing").toBe(true);
  });

  it("reports a database that exists but refuses connections", () => {
    // `datallowconn` used to be a WHERE condition, so a database with
    // connections disabled was invisible to the enumeration: absent from
    // BACKUP_DATABASES, absent from the warning, and recorded as `(none)` —
    // the all-clear, for a database nothing was backing up. Disabling
    // connections is the ordinary state of a database under maintenance; the
    // data is still there.
    stub("docker", `
[ "\${2:-}" = "config" ] && exit 0
[ "\${2:-}" = "ps" ] && { echo c1; exit 0; }
for a in "$@"; do
  case "$a" in
    psql)       printf '${dbRow("passwd_sso")}\\n${dbRow("jackson")}\\n${dbRow("quarantined_db", "n")}\\n'; exit 0 ;;
    pg_dump)    printf 'PGDMP'; exit 0 ;;
    pg_dumpall) printf 'CREATE ROLE r;\\n-- PostgreSQL database cluster dump complete\\n'; exit 0 ;;
    pg_restore) printf '; h\\n1; 1 TABLE t o\\n'; exit 0 ;;
  esac
done
exit 0`);
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/'quarantined_db'.*is NOT being backed up/);
    expect(r.stderr, "and the operator is told why it could not be dumped anyway")
      .toMatch(/connections to it are currently disabled/);
    const [gen] = generations();
    expect(readFileSync(join(backupDir, gen, "MANIFEST"), "utf8"))
      .toMatch(/not_backed_up:.*quarantined_db\[no-connect\]/);
  });

  it("keeps a database whose name contains a newline as ONE database", () => {
    // A quoted identifier may hold any byte but NUL. Read line-by-line, such a
    // name split into two rows and the second row's first byte was consumed as
    // the connect flag, so the MANIFEST recorded a database that does not
    // exist — measured: `evil\ninjected: not a database` was reported as `evil`
    // plus `njected: not a database`. It can never be in BACKUP_DATABASES, so
    // its row is always one that must reach the warning.
    const nasty = "evil\ninjected: not a database";
    stub("docker", `
[ "\${2:-}" = "config" ] && exit 0
[ "\${2:-}" = "ps" ] && { echo c1; exit 0; }
for a in "$@"; do
  case "$a" in
    psql)       printf '${dbRow("passwd_sso")}\\n${dbRow("jackson")}\\n${dbRow(nasty)}\\n'; exit 0 ;;
    pg_dump)    printf 'PGDMP'; exit 0 ;;
    pg_dumpall) printf 'CREATE ROLE r;\\n-- PostgreSQL database cluster dump complete\\n'; exit 0 ;;
    pg_restore) printf '; h\\n1; 1 TABLE t o\\n'; exit 0 ;;
  esac
done
exit 0`);
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    const warnings = r.stderr.split("\n").filter((l) => l.includes("is NOT being backed up"));
    expect(warnings, "one database, one warning").toHaveLength(1);
    expect(warnings[0], "the raw name must not reach the log")
      .toContain(`hex:${Buffer.from(nasty, "utf8").toString("hex")}`);
    expect(r.stderr, "no fabricated database may be named")
      .not.toMatch(/'njected: not a database'/);

    const [gen] = generations();
    const manifest = readFileSync(join(backupDir, gen, "MANIFEST"), "utf8");
    const field = manifest.split("\n").filter((l) => l.startsWith("not_backed_up:"));
    expect(field, "not_backed_up must stay one MANIFEST record").toHaveLength(1);
    expect(field[0]).toContain(`hex:${Buffer.from(nasty, "utf8").toString("hex")}`);
    // Every MANIFEST line must remain a `key: value` record.
    for (const line of manifest.split("\n").filter(Boolean)) {
      expect(line, `MANIFEST line is not a record: ${JSON.stringify(line)}`).toMatch(/^[a-z_]+: /);
    }
  });

  it("does not display a name ending in a newline as a different, legal one", () => {
    // The nastiest spelling, because it fails SILENTLY rather than loudly:
    // command substitution strips trailing newlines, so decoding `trailing\n`
    // yields `trailing`, which IS identifier-shaped and is therefore printed as
    // a plain name. The operator reads a database that does not exist, and the
    // one that does is never named.
    const nasty = "trailing\n";
    stub("docker", `
[ "\${2:-}" = "config" ] && exit 0
[ "\${2:-}" = "ps" ] && { echo c1; exit 0; }
for a in "$@"; do
  case "$a" in
    psql)       printf '${dbRow("passwd_sso")}\\n${dbRow("jackson")}\\n${dbRow(nasty)}\\n'; exit 0 ;;
    pg_dump)    printf 'PGDMP'; exit 0 ;;
    pg_dumpall) printf 'CREATE ROLE r;\\n-- PostgreSQL database cluster dump complete\\n'; exit 0 ;;
    pg_restore) printf '; h\\n1; 1 TABLE t o\\n'; exit 0 ;;
  esac
done
exit 0`);
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr, "the stripped form must never be presented as the name")
      .not.toMatch(/'trailing'/);
    expect(r.stderr).toContain(`hex:${Buffer.from(nasty, "utf8").toString("hex")}`);
    const [gen] = generations();
    expect(readFileSync(join(backupDir, gen, "MANIFEST"), "utf8"))
      .toContain(`hex:${Buffer.from(nasty, "utf8").toString("hex")}`);
  });

  it("still prints an ordinary database name in the clear (paired allow case)", () => {
    // The hex transport must not turn every warning into an unreadable one.
    stub("docker", `
[ "\${2:-}" = "config" ] && exit 0
[ "\${2:-}" = "ps" ] && { echo c1; exit 0; }
for a in "$@"; do
  case "$a" in
    psql)       printf '${dbRow("passwd_sso")}\\n${dbRow("jackson")}\\n${dbRow("plain_db")}\\n'; exit 0 ;;
    pg_dump)    printf 'PGDMP'; exit 0 ;;
    pg_dumpall) printf 'CREATE ROLE r;\\n-- PostgreSQL database cluster dump complete\\n'; exit 0 ;;
    pg_restore) printf '; h\\n1; 1 TABLE t o\\n'; exit 0 ;;
  esac
done
exit 0`);
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/'plain_db'.*is NOT being backed up/);
    expect(r.stderr, "a readable name must not be hex-escaped").not.toContain("hex:");
    const [gen] = generations();
    expect(readFileSync(join(backupDir, gen, "MANIFEST"), "utf8"))
      .toMatch(/not_backed_up:.*\bplain_db\b/);
  });

  it("enumerates every non-template database, filtering on nothing else", () => {
    // The condition itself, not only its effect: a future edit that narrows the
    // WHERE clause again removes databases from the operator's only record of
    // what the corpus is missing, and does it silently.
    expect(run().status).toBe(0);
    const query = readLog().split("\n").find((l) => l.includes("pg_database"));
    expect(query, "the enumeration query must reach psql").toBeDefined();
    expect(query).toMatch(/from pg_database where not datistemplate/);
    // And the name must leave the server encoded, or a datname containing a
    // newline splits the line-oriented transport again.
    expect(query, "datname must travel hex-encoded").toMatch(/encode\(convert_to\(datname/);
    const narrowed = "select datname from pg_database where not datistemplate and datallowconn";
    expect(query, "datallowconn must be reported, never filtered on")
      .not.toMatch(/where not datistemplate and/);
    // Positive control: the pattern above does match the spelling it forbids.
    expect(narrowed).toMatch(/where not datistemplate and/);
  });

  it("treats a failed enumeration as failed even when it printed rows", () => {
    // The exit status is the authority, not the emptiness of stdout. A psql that
    // prints a partial result and then dies would otherwise have its output read
    // as the complete cluster list, and the MANIFEST would name the databases it
    // happened to reach as the whole set.
    stub("docker", `
[ "\${2:-}" = "config" ] && exit 0
[ "\${2:-}" = "ps" ] && { echo c1; exit 0; }
for a in "$@"; do
  case "$a" in
    psql)       printf '${dbRow("passwd_sso")}\\n'; echo 'psql: connection lost' >&2; exit 2 ;;
    pg_dump)    printf 'PGDMP'; exit 0 ;;
    pg_dumpall) printf 'CREATE ROLE r;\\n-- PostgreSQL database cluster dump complete\\n'; exit 0 ;;
    pg_restore) printf '; h\\n1; 1 TABLE t o\\n'; exit 0 ;;
  esac
done
exit 0`);
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/could not enumerate the cluster's databases/);
    const [gen] = generations();
    expect(readFileSync(join(backupDir, gen, "MANIFEST"), "utf8")).toMatch(/not_backed_up: \(unknown/);
  });

  it("decides membership with the same split that validated the names", () => {
    // IFS=$' \\t\\n' governs every other consumer, but the reconciliation asked
    // `case " $BACKUP_DATABASES " in *" $db "*`, which splits on spaces only —
    // so a tab-separated list reported both databases it had just dumped as not
    // backed up, in the MANIFEST field the operator reads at restore time.
    stub("docker", `
[ "\${2:-}" = "config" ] && exit 0
[ "\${2:-}" = "ps" ] && { echo c1; exit 0; }
for a in "$@"; do
  case "$a" in
    psql)       printf '${dbRow("passwd_sso")}\\n${dbRow("jackson")}\\n'; exit 0 ;;
    pg_dump)    printf 'PGDMP'; exit 0 ;;
    pg_dumpall) printf 'CREATE ROLE r;\\n-- PostgreSQL database cluster dump complete\\n'; exit 0 ;;
    pg_restore) printf '; h\\n1; 1 TABLE t o\\n'; exit 0 ;;
  esac
done
exit 0`);
    const r = run({ BACKUP_DATABASES: "passwd_sso\tjackson" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr, "a database that WAS dumped must not be reported as missing")
      .not.toMatch(/is NOT being backed up/);
    const [gen] = generations();
    expect(readFileSync(join(backupDir, gen, "MANIFEST"), "utf8")).toMatch(/not_backed_up: \(none\)/);
  });

  // The previous version of this case asserted the two `stat_mode` ASSIGNMENTS
  // in the source text. Deleting the refusals while keeping the assignments left
  // it green, and it carried no positive control either. `stat` is PATH-resolved,
  // so the refusal itself is reachable.
  const modeStub = (target) => {
    const real = spawnSync("sh", ["-c", "command -v stat"], { encoding: "utf8" }).stdout.trim();
    stub("stat", `
last=""
for a in "$@"; do last="$a"; done
case "$last" in
  ${target})
    case " $* " in *" %a "*|*"'%Lp'"*|*" %Lp "*) echo 755; exit 0 ;; esac ;;
esac
exec "${real}" "$@"`);
  };

  it("refuses a run directory whose achieved mode is not private", () => {
    modeStub("*.partial");
    const r = run();
    expect(err(r)).toBe("DEST_UNSAFE");
    expect(r.stderr).toMatch(/run directory[^\n]*mode 755/);
  });

  it("refuses an archive whose achieved mode is not private", () => {
    modeStub("*.dump");
    const r = run();
    expect(err(r)).toBe("DEST_UNSAFE");
    expect(r.stderr).toMatch(/\.dump[^\n]*mode 755/);
  });

  it("refuses globals.sql when its achieved mode is not private", () => {
    // The third member of the set. INV-C4b's read-back covered <db>.dump only,
    // while the commit that added it said "each archive's achieved mode is read
    // back" — globals.sql and MANIFEST were both unchecked.
    modeStub("*globals.sql");
    const r = run();
    expect(err(r)).toBe("DEST_UNSAFE");
    expect(r.stderr).toMatch(/globals\.sql[^\n]*mode 755/);
  });

  it("refuses the MANIFEST when its achieved mode is not private", () => {
    // The fourth call site. `modeStub("*.partial")` does not match
    // <stamp>.partial/MANIFEST, so deleting this one left the suite green.
    modeStub("*MANIFEST");
    const r = run();
    expect(err(r)).toBe("DEST_UNSAFE");
    expect(r.stderr).toMatch(/MANIFEST[^\n]*mode 755/);
  });

  // Both halves of the mask, on both of the sites that spell it. Every other
  // fixture reports 755, which trips a group-only AND an other-only mask, so a
  // guard narrowed from 077 to either half was invisible to all of them.
  for (const [half, mode] of [["GROUP", "640"], ["OTHER", "604"]]) {
    it(`refuses an archive mode that opens only the ${half} bits`, () => {
      const real = spawnSync("sh", ["-c", "command -v stat"], { encoding: "utf8" }).stdout.trim();
      stub("stat", `
last=""
for a in "$@"; do last="$a"; done
case "$last" in
  *.dump)
    case " $* " in *" %a "*|*"\'%Lp\'"*|*" %Lp "*) echo ${mode}; exit 0 ;; esac ;;
esac
exec "${real}" "$@"`);
      const r = run();
      expect(err(r)).toBe("DEST_UNSAFE");
      expect(r.stderr).toMatch(new RegExp(`mode ${mode}`));
    });

    it(`refuses a DESTINATION mode that opens only the ${half} bits`, () => {
      // The second site with the same spelling. It is reached before any dump,
      // so a mask narrowed there is a different line from the one above.
      const real = spawnSync("sh", ["-c", "command -v stat"], { encoding: "utf8" }).stdout.trim();
      stub("stat", `
last=""
for a in "$@"; do last="$a"; done
if [ "$last" = "${realBackupDir}" ]; then
  case " $* " in *" %a "*|*"\'%Lp\'"*|*" %Lp "*) echo ${mode === "640" ? "750" : "705"}; exit 0 ;; esac
fi
exec "${real}" "$@"`);
      const r = run();
      expect(err(r)).toBe("DEST_UNSAFE");
      expect(r.stderr).toMatch(new RegExp(`has mode ${mode === "640" ? "750" : "705"}`));
    });
  }

  it("refuses when the mode itself cannot be read", () => {
    const real = spawnSync("sh", ["-c", "command -v stat"], { encoding: "utf8" }).stdout.trim();
    stub("stat", `
last=""
for a in "$@"; do last="$a"; done
case "$last" in
  *.dump)
    case " $* " in *" %a "*|*"\'%Lp\'"*|*" %Lp "*) exit 1 ;; esac ;;
esac
exec "${real}" "$@"`);
    const r = run();
    expect(err(r)).toBe("DEST_UNSAFE");
    expect(r.stderr).toMatch(/could not read the mode/);
  });

  it("accepts the private modes the run actually creates (paired allow case)", () => {
    // Without this the three refusals above would pass against a check that
    // refuses every mode.
    expect(run().status).toBe(0);
    const [gen] = generations();
    for (const f of ["MANIFEST", "passwd_sso.dump", "globals.sql"]) {
      const mode = statSync(join(backupDir, gen, f)).mode & 0o077;
      expect(mode, `${f} must not be group/other accessible`).toBe(0);
    }
  });

  it("records every documented MANIFEST field", () => {
    expect(run().status).toBe(0);
    const [gen] = generations();
    const manifest = readFileSync(join(backupDir, gen, "MANIFEST"), "utf8");
    for (const field of ["script:", "taken_at:", "hostname:", "mode:", "target:",
                         "pg_dump_version:", "pg_restore_version:", "validated_at:"]) {
      expect(manifest, `${field} is documented and must be present`).toContain(field);
    }
  });

  it("preflights the archive reader in URL mode", () => {
    const sysbin = join(tmpDir, "urlbin");
    mkdirSync(sysbin, { recursive: true });
    for (const tool of ["pg_dump", "pg_dumpall", "psql"]) {
      writeFileSync(join(sysbin, tool), "#!/usr/bin/env bash\nexit 0\n", "utf8");
      chmodSync(join(sysbin, tool), 0o755);
    }
    // PATH is the curated directory ALONE. Filtering "pgsql" out of the
    // inherited PATH left /usr/bin in place, which is exactly where a Debian
    // runner keeps pg_restore — so on CI the binary was found, NO_CLIENT could
    // not fire, and the `if` below silently skipped every assertion. Nothing
    // before require_binary spawns an external command (the version floor, the
    // environment block and the URL parser are all shell builtins), so the
    // absence of pg_restore is constructed here rather than hoped for.
    const r = spawnSync(BASH, [SCRIPT], {
      encoding: "utf8", timeout: 8000, cwd: REPO_ROOT,
      env: {
        PATH: sysbin,
        HOME: homeDir, LANG: "C", BACKUP_DIR: backupDir,
        MIGRATION_DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/d?sslrootcert=/tmp/ca.pem",
      },
    });
    expect(err(r)).toBe("NO_CLIENT");
    expect(r.stderr).toMatch(/pg_restore/);
  });

  it("accepts a URL-mode PATH that does carry every client (paired allow case)", () => {
    // The allow half of the case above: with pg_restore present the preflight
    // passes and the run proceeds past it, so the refusal is not simply
    // refusing everything.
    const sysbin = join(tmpDir, "urlbin-full");
    mkdirSync(sysbin, { recursive: true });
    for (const tool of ["pg_dump", "pg_dumpall", "psql", "pg_restore"]) {
      writeFileSync(join(sysbin, tool), "#!/usr/bin/env bash\nexit 0\n", "utf8");
      chmodSync(join(sysbin, tool), 0o755);
    }
    const r = spawnSync("bash", [SCRIPT], {
      encoding: "utf8", timeout: 8000, cwd: REPO_ROOT,
      env: {
        PATH: `${sysbin}:${process.env.PATH}`,
        HOME: homeDir, LANG: "C", BACKUP_DIR: backupDir,
        MIGRATION_DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/d?sslrootcert=/tmp/ca.pem",
      },
    });
    // Positively, not by negation: `not.toBe("NO_CLIENT")` is satisfied by 19
    // of the 20 declared codes. The run reaches the transport probe and stops
    // there, because the stub clients cannot connect.
    expect(err(r), "the preflight must be passed, and the next gate is the one that fails")
      .toBe("CONNECT_FAILED");
  });
});
