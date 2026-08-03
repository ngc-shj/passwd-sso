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
import { spawnSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, readFileSync,
  existsSync, readdirSync, statSync, lstatSync, symlinkSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

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
    expect(err(run({ BACKUP_DIR: join(REPO_ROOT, "tmp-backup-test") }))).toBe("DEST_IN_REPO");
  });

  it("leaves nothing published when a dump fails, and no .FAILED for a dump failure", () => {
    dockerStub({ dumpFails: "jackson" });
    const r = run();
    expect(err(r)).toBe("DUMP_FAILED");
    expect(generations()).toEqual([]);
    expect(readdirSync(backupDir).filter((n) => n.endsWith(".FAILED"))).toEqual([]);
  });

  it("keeps a .FAILED directory when validation fails, so a bad reader cannot destroy a good archive", () => {
    dockerStub({ restoreFails: "1" });
    const r = run();
    expect(err(r)).toBe("VALIDATE_FAILED");
    expect(generations()).toEqual([]);
    expect(readdirSync(backupDir).filter((n) => n.endsWith(".FAILED"))).toHaveLength(1);
  });

  it("refuses a second concurrent run", () => {
    mkdirSync(join(backupDir, ".lock.d"), { recursive: true, mode: 0o700 });
    chmodSync(backupDir, 0o700);
    expect(err(run())).toBe("LOCKED");
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

  it("prunes .FAILED directories before any dump, not after publication", () => {
    // .FAILED is produced only by runs that did NOT publish, so pruning it after
    // publication never runs in a persistently failing deployment — the exact
    // state in which unvalidated plaintext dumps accumulate.
    setup([]);
    for (const n of ["20200101T000000Z.FAILED", "20200102T000000Z.FAILED", "20200103T000000Z.FAILED"]) {
      mkdirSync(join(backupDir, n), { recursive: true });
    }
    dockerStub({ restoreFails: "1" });
    run();
    const failed = readdirSync(backupDir).filter((n) => n.endsWith(".FAILED"));
    expect(failed.length, "old .FAILED runs are pruned even though this run also failed").toBeLessThanOrEqual(2);
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
echo "${bin} $* PGPASSWORD=[\${PGPASSWORD:-}] PGSSLMODE=[\${PGSSLMODE:-}]" >> "${logFile}"
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
  };

  it("keeps the password out of argv while placing it in the child environment", () => {
    pgStubs();
    const r = run(urlEnv(
      `postgresql://u:${encodeURIComponent(SENTINEL_PASSWORD)}@127.0.0.1:5432/passwd_sso?sslrootcert=/tmp/ca.pem`,
    ));
    expect(r.status).toBe(0);
    const log = readLog();
    expect(log, "the password must not reach argv").not.toContain(SENTINEL_PASSWORD.replace("@", "%40"));
    expect(log.split("\n").filter((l) => l.startsWith("pg_dump ")).join("\n"))
      .not.toContain("u:");
    // Paired allow case: without this the test would pass on a script that
    // simply never connects.
    expect(log).toContain(`PGPASSWORD=[${SENTINEL_PASSWORD}]`);
  });

  it("spawns no docker in URL mode", () => {
    pgStubs();
    run(urlEnv("postgresql://u:p@127.0.0.1:5432/passwd_sso?sslrootcert=/tmp/ca.pem"));
    expect(readLog()).not.toMatch(/^docker /m);
  });

  it("appends the TLS floor last so libpq's last-occurrence-wins settles it", () => {
    pgStubs();
    run(urlEnv("postgresql://u:p@127.0.0.1:5432/passwd_sso?sslmode=disable&sslrootcert=/tmp/ca.pem"));
    const dumpLine = readLog().split("\n").find((l) => l.startsWith("pg_dump "));
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
      expect(s, `${v} is documented but never defaulted`).toMatch(
        new RegExp(`${v}="\\$\\{${v}:-`),
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
    expect(reader.version).toMatch(/pg_restore.*\b(1[6-9]|[2-9]\d)\b/);
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

  it("distinguishes a complete globals dump from a truncated one by its marker", () => {
    const marker = "PostgreSQL database cluster dump complete";
    expect(readFileSync(join(FIXTURES, "globals-valid.sql"), "utf8")).toContain(marker);
    expect(readFileSync(join(FIXTURES, "globals-truncated.sql"), "utf8")).not.toContain(marker);
  });
});
