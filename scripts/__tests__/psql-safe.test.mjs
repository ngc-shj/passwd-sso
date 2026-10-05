/**
 * Tests for scripts/lib/psql-safe.sh and the scripts that source it (#756
 * SC6/SC7): every psql they start runs with -X, and the URL password never
 * reaches argv — it travels in a mode-0600 passfile that is gone after exit.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const SCRIPTS = resolve(REPO_ROOT, "scripts");
const LIB = resolve(SCRIPTS, "lib", "psql-safe.sh");

const SENTINEL = "s3ntinel-pw";

// Scripts outside the class, each with the reason it is outside:
//   pre-pr.sh    — runs psql through `docker exec` in the db container, where
//                  the operator's ~/.psqlrc does not exist and no URL is used.
//   backup-db.sh — has its own passfile and `psql -X` handling (#755).
const EXEMPT = new Set(["pre-pr.sh", "backup-db.sh"]);

const SOURCES_LIB = /^source "\$SCRIPT_DIR\/lib\/psql-safe\.sh"$/m;
const BARE_PSQL = /(^|[^a-z_])psql /;

/**
 * The member set, derived the way #756 derived it — any script invoking psql —
 * plus any script already routed through the library, which no longer matches
 * that pattern once converted.
 */
const members = readdirSync(SCRIPTS)
  .filter((f) => f.endsWith(".sh") && !EXEMPT.has(f))
  .filter((f) => {
    const src = readFileSync(join(SCRIPTS, f), "utf8");
    return SOURCES_LIB.test(src) || BARE_PSQL.test(src);
  });

/** Lines that can start a process: not comments, not echo/printf text. */
const invocationLines = (src) =>
  src.split("\n").filter((l) => !/^\s*(#|echo |printf )/.test(l));

let work;
let log;
let binDir;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "psql-safe-"));
  log = join(work, "calls.log");
  binDir = join(work, "bin");
  spawnSync("mkdir", [binDir]);
  // Records argv and the passfile it was handed, then succeeds silently.
  const fake = `#!/usr/bin/env bash
{
  printf 'ARGV'; printf ' [%s]' "$@"; printf '\\n'
  printf 'PGPASSWORD=%s\\n' "\${PGPASSWORD-<unset>}"
  if [ -n "\${PGPASSFILE:-}" ]; then
    printf 'MODE=%s\\n' "$(stat -c %a -- "$PGPASSFILE" 2>/dev/null || stat -f %Lp -- "$PGPASSFILE")"
    sed 's/^/PASS=/' "$PGPASSFILE"
  fi
} >> "${log}"
cat >/dev/null
exit 0
`;
  writeFileSync(join(binDir, "psql"), fake);
  chmodSync(join(binDir, "psql"), 0o755);
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

const env = (extra = {}) => ({
  PATH: `${binDir}:${process.env.PATH}`,
  TMPDIR: work,
  ...extra,
});

/** Run a bash snippet with the library sourced. */
const lib = (body, extra = {}) =>
  spawnSync("bash", ["-c", `set -euo pipefail; source "${LIB}"; ${body}`], {
    env: env(extra), encoding: "utf8", timeout: 10_000,
  });

const passfilesLeft = () => readdirSync(work).filter((f) => f.startsWith("psql-safe."));

describe("psql_safe_url", () => {
  it("strips the password from the URL it returns", () => {
    const r = lib(`psql_safe_url U "postgresql://admin:${SENTINEL}@db.example:5432/app?sslmode=require"; printf '%s' "$U"`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("postgresql://admin@db.example:5432/app?sslmode=require");
  });

  it("writes a user-scoped passfile entry with .pgpass escaping", () => {
    const r = lib(`psql_safe_url U 'postgres://adm%3Ain:p%3Aa%5Css%40%2F@h/db'; cat "$PGPASSFILE"`);
    expect(r.status, r.stderr).toBe(0);
    // Decoded user `adm:in`, password `p:a\\ss@/`; ':' and '\\' are escaped.
    expect(r.stdout).toBe("*:*:*:adm\\:in:p\\:a\\\\ss@/\n");
  });

  it("keeps one entry per role so two URLs can share the passfile", () => {
    const r = lib(`psql_safe_url A "postgres://one:pw1@h/db"; psql_safe_url B "postgres://two:pw2@h/db"; cat "$PGPASSFILE"`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("*:*:*:one:pw1\n*:*:*:two:pw2\n");
  });

  it("creates no passfile when the URL carries no password", () => {
    const r = lib(`psql_safe_url U "postgres://user@h/db"; printf '%s|%s' "$U" "\${PGPASSFILE-<unset>}"`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("postgres://user@h/db|<unset>");
    expect(passfilesLeft()).toEqual([]);
  });

  it("unsets an ambient PGPASSWORD, which libpq would prefer to the passfile", () => {
    const r = lib(`psql_safe_url U "postgres://u:pw@h/db"; printf '%s' "\${PGPASSWORD-<unset>}"`,
      { PGPASSWORD: "ambient" });
    expect(r.stdout).toBe("<unset>");
  });

  it.each([
    ["a raw '/' in the password", `postgres://u:pa/ss@h/db`, /unencoded '\/', '\?' or '#'/],
    ["a raw '?' in the password", `postgres://u:pa?ss@h/db`, /unencoded '\/', '\?' or '#'/],
    ["a raw '@' in the password", `postgres://u:pa@ss@h/db`, /unencoded '@'/],
    ["password= in the query", `postgres://u@h/db?password=x`, /password= as a query parameter/],
    ["a percent-encoded password= key", `postgres://u@h/db?a=1&%70assword=x`, /password= as a query parameter/],
    ["an encoded newline in the password", `postgres://u:a%0Ab@h/db`, /newline or NUL/],
    ["a keyword/value conninfo", `host=h password=x`, /must start with postgres/],
  ])("refuses %s rather than passing it to argv", (_name, url, msg) => {
    const r = lib(`psql_safe_url U '${url}'; echo reached`);
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain("reached");
    expect(r.stderr).toMatch(msg);
  });

  it("does not trace the password from its own body when the caller runs under set -x", () => {
    const r = lib(`set -x; psql_safe_url U "postgres://u:${SENTINEL}@h/db"; echo after`);
    expect(r.status, r.stderr).toBe(0);
    // The caller's own trace of the call line is the caller's to suppress;
    // nothing the function runs may add another.
    const leaks = r.stderr.split("\n").filter((l) => l.includes(SENTINEL));
    expect(leaks).toEqual([`+ psql_safe_url U postgres://u:${SENTINEL}@h/db`]);
    // Tracing is restored for the caller.
    expect(r.stderr).toContain("echo after");
  });

  it("psql_safe_cleanup removes the passfile", () => {
    const r = lib(`psql_safe_url U "postgres://u:pw@h/db"; psql_safe_cleanup`);
    expect(r.status, r.stderr).toBe(0);
    expect(passfilesLeft()).toEqual([]);
  });
});

describe("scripts that run psql against an operator URL", () => {
  it("are the expected member set", () => {
    // Pinned so a new member is a conscious addition, not a silent one.
    expect(members.sort()).toEqual([
      "migrate-prf-per-credential-salt.sh",
      "rls-cross-tenant-negative-test.sh",
      "set-audit-anchor-publisher-password.sh",
      "set-outbox-worker-password.sh",
      "set-retention-gc-worker-password.sh",
    ]);
  });

  it.each(members)("%s invokes psql only through psql_safe", (f) => {
    const src = readFileSync(join(SCRIPTS, f), "utf8");
    expect(src).toMatch(SOURCES_LIB);
    const bare = invocationLines(src).filter((l) => BARE_PSQL.test(l));
    expect(bare, `${f} has a psql invocation that bypasses -X and the passfile`).toEqual([]);
  });

  const runMember = (f) => {
    const urls = {
      MIGRATION_DATABASE_URL: `postgresql://passwd_user:${SENTINEL}-mig@localhost:5432/passwd_sso`,
      APP_DATABASE_URL: `postgresql://passwd_app:${SENTINEL}-app@localhost:5432/passwd_sso`,
    };
    return spawnSync("bash", [join(SCRIPTS, f)], {
      env: env(urls), input: "new-role-pw", encoding: "utf8", timeout: 30_000, cwd: REPO_ROOT,
    });
  };

  it.each(members)("%s: every psql gets -X and no password in argv", (f) => {
    const r = runMember(f);
    const calls = existsSync(log) ? readFileSync(log, "utf8") : "";
    const argvLines = calls.split("\n").filter((l) => l.startsWith("ARGV"));
    expect(argvLines.length, `${f} never reached psql: ${r.stderr}`).toBeGreaterThan(0);
    for (const l of argvLines) {
      expect(l.startsWith("ARGV [-X]"), `${f}: ${l}`).toBe(true);
      expect(l, `${f} put the password in argv`).not.toContain(SENTINEL);
    }
    // The password reached psql through the passfile instead, owner-only.
    expect(calls).toContain(`PASS=*:*:*:passwd_user:${SENTINEL}-mig`);
    expect(calls).toMatch(/^MODE=600$/m);
    expect(calls).not.toMatch(/^PGPASSWORD=(?!<unset>)/m);
    expect(r.stdout + r.stderr, `${f} echoed the password`).not.toContain(SENTINEL);
  });

  it.each(members)("%s: removes the passfile on exit", (f) => {
    runMember(f);
    expect(passfilesLeft()).toEqual([]);
  });
});
