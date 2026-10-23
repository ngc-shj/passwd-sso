/**
 * The three scripts/set-*-password.sh (all through scripts/lib/set-role-password.sh):
 * the server receives a SCRAM verifier of exactly the password read from stdin,
 * derived with the server's scram_iterations, after the session's statement
 * logging is turned off — and the password reaches no argv, environment or output.
 *
 * A fake psql (first on PATH) records each call's argv, stdin and environment
 * and answers the iteration query with FAKE_ITERATIONS.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { scramSha256Verifier } from "../lib/scram-verifier.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const SCRIPTS = resolve(REPO_ROOT, "scripts");

const MEMBERS = [
  ["set-outbox-worker-password.sh", "passwd_outbox_worker"],
  ["set-retention-gc-worker-password.sh", "passwd_retention_gc_worker"],
  ["set-audit-anchor-publisher-password.sh", "passwd_anchor_publisher"],
];

const SENTINEL = "Rol3Pw-s3ntinel-77";
const URL = "postgresql://passwd_user:mig-pw@localhost:5432/passwd_sso";
const VERIFIER_RE =
  /^SCRAM-SHA-256\$(\d+):([A-Za-z0-9+/=]+)\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/;

const expectedSql = (role, verifier) =>
  "SELECT rolsuper AS su FROM pg_roles WHERE rolname = current_user \\gset\n" +
  "\\if :su\n" +
  "SET log_statement = 'none';\n" +
  "SET log_min_error_statement = 'panic';\n" +
  "SET pg_stat_statements.track_utility = off;\n" +
  "\\endif\n" +
  `ALTER ROLE ${role} PASSWORD '${verifier}';\n`;

/** The verifier recomputed from `password` with the salt and iterations it carries. */
const recompute = (verifier, password) => {
  const [, iterations, salt] = VERIFIER_RE.exec(verifier);
  return scramSha256Verifier(password, {
    iterations: Number(iterations),
    salt: Buffer.from(salt, "base64"),
  });
};

let work;
let binDir;
let callsDir;
// /usr/bin and /bin without node, for the node-absent case.
let noNodeDir;

beforeAll(() => {
  noNodeDir = mkdtempSync(join(tmpdir(), "no-node-"));
  for (const dir of ["/usr/bin", "/bin"]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (f === "node" || existsSync(join(noNodeDir, f))) continue;
      try {
        symlinkSync(join(dir, f), join(noNodeDir, f));
      } catch {
        // a name present in both directories: the first one wins, as on PATH
      }
    }
  }
});

afterAll(() => {
  rmSync(noNodeDir, { recursive: true, force: true });
});

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "set-role-pw-"));
  binDir = join(work, "bin");
  callsDir = join(work, "calls");
  mkdirSync(binDir);
  mkdirSync(callsDir);
  const fake = `#!/usr/bin/env bash
n=$(ls "${callsDir}" | grep -c argv || true)
d="${callsDir}/$n"
printf '%s\\n' "$@" > "$d.argv"
env > "$d.env"
cat > "$d.stdin"
case " $* " in
  *current_setting*) printf '%s\\n' "\${FAKE_ITERATIONS-4096}" ;;
  *" -f "*) exit "\${FAKE_ALTER_EXIT:-0}" ;;
esac
exit 0
`;
  writeFileSync(join(binDir, "psql"), fake);
  chmodSync(join(binDir, "psql"), 0o755);
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

const run = (script, { input = SENTINEL, env = {}, args = [], bashArgs = [], path } = {}) =>
  spawnSync("bash", [...bashArgs, join(SCRIPTS, script), ...args], {
    env: {
      PATH: path ?? `${binDir}:${process.env.PATH}`,
      TMPDIR: work,
      MIGRATION_DATABASE_URL: URL,
      ...env,
    },
    input,
    encoding: "utf8",
    timeout: 30_000,
    // Not the repo root: the scripts must resolve their helpers from their
    // own location.
    cwd: work,
  });

const calls = () =>
  readdirSync(callsDir)
    .filter((f) => f.endsWith(".argv"))
    .map((f) => f.slice(0, -".argv".length))
    .sort((a, b) => Number(a) - Number(b))
    .map((n) => ({
      argv: readFileSync(join(callsDir, `${n}.argv`), "utf8").split("\n").filter(Boolean),
      stdin: readFileSync(join(callsDir, `${n}.stdin`), "utf8"),
      env: readFileSync(join(callsDir, `${n}.env`), "utf8"),
    }));

const alterCall = () => calls().find((c) => c.argv.includes("-f"));
const verifierOf = (stdin) => /PASSWORD '([^']+)'/.exec(stdin)?.[1];

describe.each(MEMBERS)("%s", (script, role) => {
  it("sends the logging SETs and a verifier of the password, with ON_ERROR_STOP", () => {
    const r = run(script);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`OK — password updated for ${role}`);

    const all = calls();
    expect(all).toHaveLength(2);
    expect(all[0].argv.join(" ")).toContain("current_setting('scram_iterations', true)");

    const alter = alterCall();
    expect(alter.argv).toEqual(expect.arrayContaining(["-X", "-v", "ON_ERROR_STOP=1", "-f", "-"]));
    const v = verifierOf(alter.stdin);
    expect(v).toMatch(VERIFIER_RE);
    expect(alter.stdin).toBe(expectedSql(role, v));
    expect(recompute(v, SENTINEL)).toBe(v);
  });

  it.each([
    ["10000", 10000],
    ["", 4096],
    ["1000", 4096],
  ])("derives with the server's scram_iterations %j → %d", (server, expected) => {
    const r = run(script, { env: { FAKE_ITERATIONS: server } });
    expect(r.status, r.stderr).toBe(0);
    expect(verifierOf(alterCall().stdin)).toMatch(new RegExp(`^SCRAM-SHA-256\\$${expected}:`));
  });

  it("puts the password in no argv, environment or output, even under bash -x", () => {
    const r = run(script, { bashArgs: ["-x"] });
    expect(r.status, r.stderr).toBe(0);
    for (const c of calls()) {
      expect(c.argv.join(" ")).not.toContain(SENTINEL);
      expect(c.env).not.toContain(SENTINEL);
    }
    expect(r.stdout).not.toContain(SENTINEL);
    expect(r.stderr).not.toContain(SENTINEL);
    // Positive control: the trace did run, and the verifier is of the sentinel.
    expect(r.stderr).toContain("+ set_role_password");
    const v = verifierOf(alterCall().stdin);
    expect(recompute(v, SENTINEL)).toBe(v);
  });

  it("drops trailing newlines from stdin, as a password typed or generated arrives", () => {
    const r = run(script, { input: `${SENTINEL}\n` });
    expect(r.status, r.stderr).toBe(0);
    const v = verifierOf(alterCall().stdin);
    expect(recompute(v, SENTINEL)).toBe(v);
  });

  it.each([
    ["an interior LF", `${SENTINEL}\nmore`, "line break"],
    ["a CR", `${SENTINEL}\r`, "line break"],
    ["an empty password", "", "password expected on stdin"],
    ["a non-ASCII character", `${SENTINEL}é`, "non-ASCII"],
  ])("refuses %s without sending an ALTER or echoing it", (_name, input, reason) => {
    const r = run(script, { input });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(reason);
    expect(alterCall()).toBeUndefined();
    expect(r.stdout).not.toContain("OK —");
    expect(r.stdout + r.stderr).not.toContain(SENTINEL);
  });

  it.each([
    ["an injection", "x';DROP ROLE y;--"],
    ["nothing", ""],
  ])("refuses a helper that prints %s instead of a verifier", (_name, output) => {
    writeFileSync(join(binDir, "node"), `#!/usr/bin/env bash\ncat >/dev/null\nprintf '%s\\n' "${output}"\n`);
    chmodSync(join(binDir, "node"), 0o755);
    const r = run(script);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("unexpected shape");
    expect(alterCall()).toBeUndefined();
    expect(r.stdout).not.toContain("OK —");
  });

  it("refuses to run without node, naming it", () => {
    const r = run(script, { path: `${binDir}:${noNodeDir}` });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("node is required");
    expect(alterCall()).toBeUndefined();
  });

  it("fails without an OK line when the ALTER fails (e.g. the role is missing)", () => {
    const r = run(script, { env: { FAKE_ALTER_EXIT: "3" } });
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("OK —");
  });

  it("DRY_RUN connects to nothing and prints no verifier; --print-args-file holds one", () => {
    const file = join(work, "args.sql");
    const r = run(script, { env: { DRY_RUN: "1" }, args: ["--print-args-file", file] });
    expect(r.status, r.stderr).toBe(0);
    expect(calls()).toEqual([]);
    expect(r.stderr).toContain("<verifier>");
    expect(r.stdout + r.stderr).not.toMatch(/SCRAM-SHA-256\$/);
    const sql = readFileSync(file, "utf8");
    const v = verifierOf(sql);
    expect(sql).toBe(expectedSql(role, v));
    expect(recompute(v, SENTINEL)).toBe(v);
  });

  it("refuses a --print-args-file path that already exists", () => {
    const file = join(work, "exists.sql");
    writeFileSync(file, "");
    const r = run(script, { env: { DRY_RUN: "1" }, args: ["--print-args-file", file] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("already exists");
    expect(readFileSync(file, "utf8")).toBe("");
  });
});
