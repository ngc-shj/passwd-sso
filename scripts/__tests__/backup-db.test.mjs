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
  existsSync, readdirSync, statSync, lstatSync, symlinkSync, utimesSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir, hostname } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const SCRIPT = resolve(REPO_ROOT, "scripts", "backup-db.sh");
const FIXTURES = resolve(__dirname, "fixtures", "backup-db");

const SENTINEL_PASSWORD = "S3NT1NEL-p@ss";

let tmpDir, binDir, homeDir, backupDir, logFile;

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
    expect(dumpLine).toMatch(/sslmode=verify-full\b/);
    expect(dumpLine.lastIndexOf("sslmode=verify-full")).toBeGreaterThan(dumpLine.indexOf("sslmode=disable"));
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
    for (const banned of [/\bmapfile\b/, /\breadarray\b/, /\breadlink -f\b/, /\bflock\b/]) {
      expect(src()).not.toMatch(banned);
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
    if (reader?.kind !== "compose") {
      expect(reader, "this case needs the compose reader").not.toBeNull();
      return;
    }
    const hostRestore = spawnSync("sh", ["-c", "command -v pg_restore"], { encoding: "utf8" }).stdout.trim();
    const realDocker = spawnSync("sh", ["-c", "command -v docker"], { encoding: "utf8" }).stdout.trim();
    const truncated = join(FIXTURES, "truncated.pgdump");
    stub("docker", `
if [ "\${2:-}" = "config" ]; then exit 0; fi
if [ "\${2:-}" = "ps" ]; then echo container123; exit 0; fi
for a in "$@"; do
  case "$a" in
    pg_dump)     cat -- "${truncated}"; exit 0 ;;
    pg_dumpall)  printf 'CREATE ROLE r;\n-- PostgreSQL database cluster dump complete\n'; exit 0 ;;
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
    stub("psql", `printf 't|TLSv1.3|AESGCM\\n'
exit 0`);
  };

  // Derived from the script's own refusal list, not from memory: every
  // parameter libpq accepts that carries a credential, redirects the peer, or
  // selects a transport the TLS floor cannot govern.
  const REFUSED_PARAMS = [
    "password", "passfile", "service", "oauth_client_secret", "sslpassword",
    "sslkeylogfile", "scram_client_key", "scram_server_key",
    "host", "hostaddr", "gssencmode", "dbname",
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
    for (const authority of ["u:p@", "u:p@h\n*", "u:p@a:b:5432"]) {
      expect(err(run({ MIGRATION_DATABASE_URL: `postgresql://${authority}/d?${CA}` })),
        JSON.stringify(authority)).toBe("BAD_URL");
      rmSync(backupDir, { recursive: true, force: true });
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

  it("refuses to publish over an existing generation", () => {
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

  it("refuses an ancestor owned by a third party", () => {
    // stat is PATH-resolved, so the ownership branch is reachable without a
    // second real uid: report a foreign owner for the parent only.
    const parent = dirname(backupDir);
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

  it("accepts an ancestor owned by the invoking user (paired allow case)", () => {
    // Without this, the refusal above would pass against a check that refuses
    // every ancestor.
    expect(run().status).toBe(0);
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

  const mountStub = (line) => {
    passthrough("df", `
if [ "$2" = "--" ] || [ "$1" = "-P" ]; then
  printf 'Filesystem 1K-blocks Used Avail Use%% Mounted on\n/dev/probe0 1 1 1 1%% /probe\n'
  exit 0
fi`);
    stub("mount", `printf '%s\n' ${JSON.stringify(line)}
exit 0`);
  };

  it("refuses a Linux filesystem that cannot enforce ownership", () => {
    // Linux puts the type OUTSIDE the parentheses: "<dev> on <pt> type exfat (…)".
    // A previous fix read only the parenthesised field and silently stopped
    // detecting exFAT, vfat and NFS on Linux entirely.
    mountStub("/dev/probe0 on /probe type exfat (rw,relatime)");
    const r = run();
    expect(err(r)).toBe("DEST_UNSAFE");
    expect(r.stderr).toMatch(/does not enforce ownership/);
  });

  it("refuses a macOS volume mounted noowners", () => {
    // macOS puts the type and the options together inside the parentheses.
    mountStub("/dev/probe0 on /probe (exfat, local, nodev, nosuid, noowners)");
    expect(err(run())).toBe("DEST_UNSAFE");
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
    "${backupDir}")
      printf 'drwx------+ 2 me me 4096 Jan 1 00:00 %s\n' "${backupDir}"
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
if [ "$last" = "${backupDir}" ]; then
  case " $* " in *" %u "*|*"'%u'"*) echo 4242; exit 0 ;; esac
fi`);
    const r = run();
    expect(err(r)).toBe("DEST_UNSAFE");
    expect(r.stderr).toMatch(/owned by uid 4242/);
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
    const SENT = "S3NT1NEL-p@ss";
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
    // unmanaged full plaintext corpus. Only the consuming side was pinned.
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    chmodSync(backupDir, 0o700);
    dockerStub({ restoreFails: "1" });
    const first = run();
    expect(err(first)).toBe("VALIDATE_FAILED");
    const [existing] = readdirSync(backupDir).filter((n) => n.endsWith(".FAILED"));
    expect(existing).toBeDefined();
    // Force the next run onto the same stamp by pre-creating nothing else and
    // re-running within the same second is unreliable; instead plant the
    // collision directly under the name the next failure will choose.
    const stamp = existing.replace(/\.FAILED$/, "");
    const r = run();
    const failed = readdirSync(backupDir).filter((n) => n.endsWith(".FAILED"));
    for (const f of failed) {
      expect(f, "every failure name must stay matchable by the pruner")
        .toMatch(/^\d{8}T\d{6}Z(\.\d+)?\.FAILED$/);
    }
    expect(stamp).toMatch(/^\d{8}T\d{6}Z$/);
    expect(r.status).toBe(1);
  });

  it("warns about a cluster database that is not in BACKUP_DATABASES", () => {
    // INV-C3a quantifies over a caller-supplied list, so without this the claim
    // "every database is backed up" is checked by nothing.
    stub("docker", `
[ "\${2:-}" = "config" ] && exit 0
[ "\${2:-}" = "ps" ] && { echo c1; exit 0; }
for a in "$@"; do
  case "$a" in
    psql)       printf 'passwd_sso\\njackson\\npostgres\\nforgotten_db\\n'; exit 0 ;;
    pg_dump)    printf 'PGDMP'; exit 0 ;;
    pg_dumpall) printf 'CREATE ROLE r;\\n-- PostgreSQL database cluster dump complete\\n'; exit 0 ;;
    pg_restore) printf '; h\\n1; 1 TABLE t o\\n'; exit 0 ;;
  esac
done
exit 0`);
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/forgotten_db.*is NOT being backed up/);
    expect(r.stderr, "the maintenance database is not worth warning about every run")
      .not.toMatch(/'postgres'.*is NOT being backed up/);
    const [gen] = generations();
    expect(readFileSync(join(backupDir, gen, "MANIFEST"), "utf8")).toMatch(/not_backed_up: forgotten_db/);
  });

  it("refuses a run directory or archive whose achieved mode is not private", () => {
    // INV-C4b declares the read-back as app-enforced; only the root had one, so
    // the run directory and the archives relied on umask alone — the reasoning
    // INV-C4a explicitly rejects.
    const src = readFileSync(SCRIPT, "utf8");
    expect(src, "the run directory's achieved mode must be read back")
      .toMatch(/run_mode="\$\(stat_mode "\$RUN_PARTIAL"\)"/);
    expect(src, "and each archive's").toMatch(/archive_mode="\$\(stat_mode "\$archive"\)"/);
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
    const r = spawnSync("bash", [SCRIPT], {
      encoding: "utf8", timeout: 8000, cwd: REPO_ROOT,
      env: {
        PATH: `${sysbin}:${process.env.PATH.split(":").filter((d) => !d.includes("pgsql")).join(":")}`,
        HOME: homeDir, LANG: "C", BACKUP_DIR: backupDir,
        MIGRATION_DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/d?sslrootcert=/tmp/ca.pem",
      },
    });
    // pg_restore is absent from the curated bin; the real one is not on PATH here.
    if (spawnSync("sh", ["-c", "command -v pg_restore"], { encoding: "utf8" }).status !== 0) {
      expect(err(r)).toBe("NO_CLIENT");
      expect(r.stderr).toMatch(/pg_restore/);
    }
  });
});
