/**
 * Env-contract and shutdown test for scripts/audit-chain-verify-worker.ts.
 *
 * Each case spawns the worker with ONLY the env it names (env -i semantics)
 * from an empty temp cwd, so neither the parent env nor a developer's .env /
 * .env.local can supply a value the case means to omit. --validate-env-only
 * exits before connecting.
 *
 * The shutdown case runs the real loop against a port nothing listens on: the
 * tick fails fast, logs its heartbeat, and the worker sleeps for the hour-long
 * default tick — the window a SIGTERM must cut short.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const WORKER = resolve(REPO_ROOT, "scripts", "audit-chain-verify-worker.ts");
const TSX = resolve(REPO_ROOT, "node_modules/.bin/tsx");
const TSX_ARGS = ["--tsconfig", resolve(REPO_ROOT, "tsconfig.json"), WORKER];

const VALID_URL = "postgresql://passwd_app:secret-pw@db:5432/passwd_sso";
// Port 1 on loopback: the connection is refused at once.
const REFUSED_URL = "postgresql://passwd_app:p@127.0.0.1:1/passwd_sso";

let cwd;
beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), "chain-verify-env-"));
});
afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function validate(env) {
  return spawnSync(TSX, [...TSX_ARGS, "--validate-env-only"], {
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
    timeout: 30_000,
    cwd,
  });
}

function jsonLines(text) {
  const out = [];
  for (const line of text.split("\n")) {
    try {
      out.push(JSON.parse(line.trim()));
    } catch {
      // skip non-JSON lines (dotenv banners)
    }
  }
  return out;
}

function failures(result) {
  return jsonLines(result.stderr)
    .filter((l) => l.msg === "env validation failed")
    .map((l) => ({ path: l.path, code: l.code }));
}

function expectPassed(result) {
  expect(result.status, result.stderr).toBe(0);
  expect(jsonLines(result.stdout)).toContainEqual({ level: "info", msg: "env validation passed" });
}

describe("audit-chain-verify-worker --validate-env-only: database URL", () => {
  it("passes with AUDIT_CHAIN_VERIFY_DATABASE_URL, the task's only variable", () => {
    expectPassed(validate({ AUDIT_CHAIN_VERIFY_DATABASE_URL: VALID_URL }));
  });

  it("passes with the DATABASE_URL fallback", () => {
    expectPassed(validate({ DATABASE_URL: VALID_URL }));
  });

  it("fails when neither URL is set", () => {
    const r = validate({});
    expect(r.status).toBe(1);
    expect(failures(r)).toEqual([{ path: "AUDIT_CHAIN_VERIFY_DATABASE_URL", code: "missing" }]);
  });

  it("fails on an unparseable URL without echoing it", () => {
    const r = validate({ AUDIT_CHAIN_VERIFY_DATABASE_URL: "not a url secret-pw" });
    expect(r.status).toBe(1);
    expect(failures(r)).toEqual([{ path: "AUDIT_CHAIN_VERIFY_DATABASE_URL", code: "invalid_url" }]);
    expect(r.stdout + r.stderr).not.toContain("secret-pw");
  });

  it("names DATABASE_URL when the fallback is the unparseable one", () => {
    const r = validate({ DATABASE_URL: "::" });
    expect(r.status).toBe(1);
    expect(failures(r)).toEqual([{ path: "DATABASE_URL", code: "invalid_url" }]);
  });
});

const POSITIVE_FINITE = [
  "AUDIT_CHAIN_VERIFY_TICK_INTERVAL_MS",
  "AUDIT_CHAIN_VERIFY_REALERT_MS",
  "AUDIT_CHAIN_VERIFY_TX_TIMEOUT_MS",
];

describe.each(POSITIVE_FINITE)("audit-chain-verify-worker --validate-env-only: %s", (name) => {
  it("passes with a positive value", () => {
    expectPassed(validate({ AUDIT_CHAIN_VERIFY_DATABASE_URL: VALID_URL, [name]: "1500" }));
  });

  it.each(["abc", "0", "-5", "Infinity", ""])("fails on %j", (value) => {
    const r = validate({ AUDIT_CHAIN_VERIFY_DATABASE_URL: VALID_URL, [name]: value });
    expect(r.status).toBe(1);
    expect(failures(r)).toEqual([{ path: name, code: "not_positive_finite" }]);
  });
});

describe("audit-chain-verify-worker --validate-env-only: AUDIT_CHAIN_VERIFY_MAX_ROWS", () => {
  it("passes with a positive integer", () => {
    expectPassed(validate({ AUDIT_CHAIN_VERIFY_DATABASE_URL: VALID_URL, AUDIT_CHAIN_VERIFY_MAX_ROWS: "500" }));
  });

  it.each(["abc", "0", "-5", "1.5", "Infinity"])("fails on %j", (value) => {
    const r = validate({ AUDIT_CHAIN_VERIFY_DATABASE_URL: VALID_URL, AUDIT_CHAIN_VERIFY_MAX_ROWS: value });
    expect(r.status).toBe(1);
    expect(failures(r)).toEqual([{ path: "AUDIT_CHAIN_VERIFY_MAX_ROWS", code: "not_positive_integer" }]);
  });
});

describe("audit-chain-verify-worker shutdown", () => {
  // Every spawned child, killed after its case whatever the case did: a failed
  // assertion before the SIGTERM must not leave the worker sleeping.
  const children = [];
  afterEach(() => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });

  it("exits promptly on SIGTERM during the sleep between ticks", async () => {
    const child = spawn(TSX, TSX_ARGS, {
      env: { PATH: process.env.PATH, AUDIT_CHAIN_VERIFY_DATABASE_URL: REFUSED_URL },
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const exited = new Promise((res) => child.on("exit", (code, signal) => res({ code, signal })));

    // The heartbeat is the last thing a tick does before the sleep.
    await new Promise((res, rej) => {
      const deadline = setTimeout(() => rej(new Error(`no heartbeat within 30s: ${stdout}${stderr}`)), 30_000);
      child.stdout.on("data", (d) => {
        stdout += d;
        if (stdout.includes('"_logType":"audit-chain-verify-heartbeat"')) {
          clearTimeout(deadline);
          res();
        }
      });
    });

    const sentAt = Date.now();
    child.kill("SIGTERM");
    const outcome = await Promise.race([
      exited,
      new Promise((res) => setTimeout(() => res("timeout"), 5_000)),
    ]);
    if (outcome === "timeout") child.kill("SIGKILL");
    expect(outcome, stderr).toEqual({ code: 0, signal: null });
    expect(Date.now() - sentAt).toBeLessThan(5_000);
    expect(stdout).toContain("audit-chain-verify-worker: shutdown clean");
  }, 45_000);
});
