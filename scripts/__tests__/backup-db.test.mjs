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
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir, hostname } from "node:os";

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
function dockerStub({ psStatus = 0, psOutput = "container123", dumpFails = "", restoreFails = "" } = {}) {
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
      ...(mountinfoPath ? { BACKUP_MOUNTINFO_PATH: mountinfoPath } : {}),
      ...(tocEntries === undefined ? {} : { PG_TOC_ENTRIES: String(tocEntries) }),
      ...env,
    },
  });
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
    writeFileSync(join(lock, "pid"), "999999\n", "utf8");
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
    writeFileSync(join(lock, "pid"), "999999\n", "utf8");
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
    stub("psql", `
echo "psql $* PGPASSFILE=[\${PGPASSFILE:-}]" >> "${logFile}"
printf 't|TLSv1.3|TLS_AES_256_GCM_SHA384\\n'
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
    const s = readFileSync(SCRIPT, "utf8");
    const documented = [...s.matchAll(/^#\s{3}([A-Z][A-Z0-9_]+)\s+\(optional\)/gm)].map((m) => m[1]);
    expect(documented.length).toBeGreaterThan(5);
    for (const v of documented) {
      expect(s, `${v} is documented but never read with a default`).toMatch(
        new RegExp(`\\$\\{${v}:-`),
      );
    }
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
      exec "${realDocker}" "$@" ;;
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
    writeFileSync(join(lock, "pid"), "999999\n", "utf8");        // gone
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
    const mi = lines.map((l, i) => {
      // "<src> on <mp> type <fs> (<opts>)"  |  "<src> on <mp> (<fs>, <opts>)"
      const m = /^(.*?) on (.*?)(?: type (\S+))? \((.*)\)$/.exec(l);
      if (!m) return null;
      const [, src, mp, ltype, opts] = m;
      const fs = ltype || opts.split(",")[0].trim();
      const rest = ltype ? opts : opts.split(",").slice(1).join(",").trim();
      return `${i + 20} 1 0:${i + 20} / ${esc(mp)} rw - ${esc(fs)} ${esc(src)} ${esc(rest || "rw")}`;
    }).filter(Boolean).join("\n");
    const miPath = join(tmpDir, "mountinfo");
    writeFileSync(miPath, mi + "\n", "utf8");
    // The forgery and ambiguity cases are ABOUT mount(8)'s human-readable
    // text; mountinfo's escaping makes those inputs unrepresentable, so those
    // cases drive the fallback reader deliberately.
    mountinfoPath = textPath ? join(tmpDir, "no-such-mountinfo") : miPath;
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
    expect(run().status, "an ext4 destination must not be refused").toBe(0);
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
    mountinfoPath = join(tmpDir, "no-such-mountinfo");
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

  it("is not moved by a '%' in df's DEVICE field", () => {
    // The device is the attacker-spelled field. Cutting at the FIRST `% `
    // instead of the last hands the boundary to it: the mount point read back
    // is then whatever followed the device's own, and the destination's real
    // line matches nothing.
    mountStub("/dev/probe0 on /probe type exfat (rw,relatime)", [], { textPath: true });
    stub("df", `printf 'Filesystem 512-blocks Used Available Capacity Mounted on\\n`
      + `evil%% /decoy 1 1 1 1%%    %s\\n' '${realBackupDir}'`);
    const r = run();
    expect(err(r)).toBe("DEST_UNSAFE");
    expect(r.stderr, "the destination's own exfat line must still be the one that answers")
      .toMatch(/exfat is not known to enforce ownership/);
  });

  it("refuses rather than guesses when a '%' in the MOUNT POINT truncates df's answer", () => {
    mountStub("/dev/probe0 on /probe type ext4 (rw,relatime)", [], { textPath: true });
    stub("df", "printf 'Filesystem 512-blocks Used Available Capacity Mounted on\\n"
      + "/dev/probe0 1 1 1 1%%    /Volumes/50%% off\\n'");
    const r = run();
    expect(err(r), "a truncated answer is not an answer").toBe("DEST_UNSAFE");
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
    mountinfoPath = join(tmpDir, "no-such-mountinfo");
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
    mountStub("gocryptfs@ on /probe type fuse.gocryptfs (rw,nosuid,nodev,user_id=1000,allow_other)");
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
    mountinfoPath = join(tmpDir, "no-such-mountinfo");
    stub("mount", "exit 1");
    const r = run();
    expect(err(r)).toBe("DEST_UNSAFE");
    expect(r.stderr).toMatch(/could not determine whether/);
  });



  it("refuses when no mount(8) entry covers the destination", () => {
    // Not "the device is missing" — the object is the PATH now. An
    // unattributable table has not performed the check, which is not the same
    // as having passed.
    mountinfoPath = join(tmpDir, "no-such-mountinfo");
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
    for (const fs of ["fuse.gocryptfs", "fuse.veracrypt", "fuse.cryfs"]) {
      mountStub(`/dev/probe0 on /probe type ${fs} (rw,nosuid,nodev,user_id=0)`);
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
      { files: { pid: "999999\n", host: "not-this-host\n" }, re: /liveness cannot be tested/ },
      { files: { pid: "999999\n", host: `${hostname()}\n` }, re: /is held by a process that is gone/ },
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
      while (Date.now() < deadline && !existsSync(join(lock, "pid"))) {
        spawnSync("sleep", ["0.05"]);
      }
      expect(existsSync(join(lock, "pid")), "the holder pid must be recorded").toBe(true);
      expect(readFileSync(join(lock, "pid"), "utf8").trim()).toBe(String(child.pid));
      expect(readFileSync(join(lock, "host"), "utf8").trim()).toBe(hostname());
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("never publishes into a root replaced mid-run", () => {
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
    const child = spawnSync("bash", ["-c", `
      ("${SCRIPT}"; echo "EXIT=$?") > "${join(tmpDir, "out")}" 2>&1 &
      sleep 1
      mv "${backupDir}" "${backupDir}.moved"
      mkdir -m 700 "${backupDir}"
      wait
    `], {
      encoding: "utf8", timeout: 20000,
      env: { PATH: `${binDir}:${process.env.PATH}`, HOME: homeDir, LANG: "C",
             BACKUP_DIR: backupDir, BACKUP_RETAIN: "1" },
    });
    const out = readFileSync(join(tmpDir, "out"), "utf8");
    expect(out, "a replaced root must not yield a success").not.toMatch(/EXIT=0/);
    expect(generations(), "and must leave nothing published in the new root").toEqual([]);
    rmSync(`${backupDir}.moved`, { recursive: true, force: true });
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

  it("refuses a mode that opens only the GROUP bits", () => {
    // Every other fixture reports 755, which trips an other-bits-only mask too.
    // A guard narrowed from 077 to 007 was therefore invisible.
    const real = spawnSync("sh", ["-c", "command -v stat"], { encoding: "utf8" }).stdout.trim();
    stub("stat", `
last=""
for a in "$@"; do last="$a"; done
case "$last" in
  *.dump)
    case " $* " in *" %a "*|*"\'%Lp\'"*|*" %Lp "*) echo 640; exit 0 ;; esac ;;
esac
exec "${real}" "$@"`);
    const r = run();
    expect(err(r)).toBe("DEST_UNSAFE");
    expect(r.stderr).toMatch(/mode 640/);
  });

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
