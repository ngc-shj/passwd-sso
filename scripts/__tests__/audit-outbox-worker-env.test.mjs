/**
 * Tests for the audit-outbox worker's --validate-env-only flag (Step 10 §E, T17/T21/T25).
 *
 * Each test spawns the worker with a minimal env (PATH + explicit overrides) to
 * verify the Zod validation path without touching the database.
 *
 * T25: stdout assertions pin the EXACT JSON payload (via JSON.parse + toEqual),
 * never substring-only. Substring-only assertions are FORBIDDEN per spec.
 *
 * T29: Only smoke cases are covered here (malformed URL, missing DATABASE_URL,
 * non-numeric OUTBOX_BATCH_SIZE). Exhaustive per-field coverage lives in
 * src/lib/env.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const WORKER = resolve(REPO_ROOT, "scripts", "audit-outbox-worker.ts");

const VALID_DATABASE_URL = "postgresql://app:app@localhost:5432/passwd_sso";
const MALFORMED_URL = "not-a-valid-url";

// ── env snapshot / restore ────────────────────────────────────────────────────

let origEnv;
beforeEach(() => { origEnv = { ...process.env }; });
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in origEnv)) delete process.env[k];
  for (const [k, v] of Object.entries(origEnv)) process.env[k] = v;
});

// ── helpers ───────────────────────────────────────────────────────────────────

function spawnWorker(envOverrides = {}) {
  return spawnSync(
    "node_modules/.bin/tsx",
    [WORKER, "--validate-env-only"],
    {
      // Never inherit parent env — explicit pass only (T16/T24).
      // DATABASE_URL="" is passed explicitly so dotenv's loadEnv() cannot
      // override it from .env or .env.local (dotenv does not override
      // already-set vars). Callers that want a valid DATABASE_URL must
      // pass it in envOverrides.
      env: { PATH: process.env.PATH, DATABASE_URL: "", ...envOverrides },
      encoding: "utf8",
      timeout: 15_000,
      cwd: REPO_ROOT,
    },
  );
}

/**
 * Extract the first line from stdout that parses as valid JSON.
 *
 * The dotenv library (v17, silent by default) does not emit preamble lines in
 * the current setup. We still skip non-JSON lines defensively: if a future
 * load-env wrapper adds a diagnostic banner, the test should continue to
 * locate the worker's own JSON output rather than fail on JSON.parse of the
 * banner (CT6). Non-matching lines fall through to JSON.parse, which returns
 * them if valid or skips them via catch if not — no explicit prefix allowlist.
 */
function extractJsonLine(stdout) {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      return JSON.parse(trimmed);
    } catch {
      // skip non-JSON lines (e.g. future dotenv/dotenvx diagnostic banners)
    }
  }
  return null;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("audit-outbox-worker --validate-env-only", () => {
  it("exits 1 with stderr JSON {level:error,msg:env validation failed,path:OUTBOX_WORKER_DATABASE_URL} when that var is a malformed URL", () => {
    const result = spawnWorker({
      DATABASE_URL: VALID_DATABASE_URL,
      OUTBOX_WORKER_DATABASE_URL: MALFORMED_URL,
    });

    expect(result.status).toBe(1);

    // Find the relevant error line in stderr (may have multiple JSON lines).
    const stderrLines = result.stderr.trim().split("\n").filter(Boolean);
    const errorLine = stderrLines.find((l) => {
      try {
        const obj = JSON.parse(l);
        return obj.level === "error" && obj.path === "OUTBOX_WORKER_DATABASE_URL";
      } catch {
        return false;
      }
    });
    expect(errorLine).toBeTruthy();

    const parsed = JSON.parse(errorLine);
    // T25: exact payload check — not substring-only.
    expect(parsed.level).toBe("error");
    expect(parsed.msg).toBe("env validation failed");
    expect(parsed.path).toBe("OUTBOX_WORKER_DATABASE_URL");
    expect(typeof parsed.code).toBe("string");
  });

  it("exits 0 and stdout equals {level:info,msg:env validation passed} when OUTBOX_WORKER_DATABASE_URL is unset and DATABASE_URL is valid (T21 fallback)", () => {
    const result = spawnWorker({
      DATABASE_URL: VALID_DATABASE_URL,
      // OUTBOX_WORKER_DATABASE_URL intentionally omitted → falls back to DATABASE_URL.
    });

    expect(result.status).toBe(0);

    // T25: exact payload check via JSON.parse + toEqual (not substring-only).
    // extractJsonLine skips the dotenvx preamble lines that appear before the JSON.
    const payload = extractJsonLine(result.stdout);
    expect(payload).toEqual({ level: "info", msg: "env validation passed" });
  });

  it("exits 1 with clear error when DATABASE_URL is missing entirely", () => {
    // Pass DATABASE_URL as empty string — dotenv won't override an already-set var,
    // so the Zod nonEmpty check will reject "".
    const result = spawnWorker({
      DATABASE_URL: "",  // explicitly empty → Zod nonEmpty rejects it
    });

    expect(result.status).toBe(1);

    // At least one stderr line must reference DATABASE_URL.
    const stderrLines = result.stderr.trim().split("\n").filter(Boolean);
    const hasDbUrlError = stderrLines.some((l) => {
      try {
        const obj = JSON.parse(l);
        return obj.path === "DATABASE_URL";
      } catch {
        return false;
      }
    });
    expect(hasDbUrlError).toBe(true);
  });

  it("exits 1 with clear error when OUTBOX_BATCH_SIZE is non-numeric", () => {
    const result = spawnWorker({
      DATABASE_URL: VALID_DATABASE_URL,
      OUTBOX_BATCH_SIZE: "not-a-number",
    });

    expect(result.status).toBe(1);

    const stderrLines = result.stderr.trim().split("\n").filter(Boolean);
    const hasBatchSizeError = stderrLines.some((l) => {
      try {
        const obj = JSON.parse(l);
        return obj.path === "OUTBOX_BATCH_SIZE";
      } catch {
        return false;
      }
    });
    expect(hasBatchSizeError).toBe(true);
  });

  it("stderr from failure path does NOT include the rejected value (F30 + S22 regression)", () => {
    const sensitiveValue = "super-secret-malformed-url-that-must-not-leak-12345";
    const result = spawnWorker({
      DATABASE_URL: VALID_DATABASE_URL,
      OUTBOX_WORKER_DATABASE_URL: sensitiveValue,
    });

    expect(result.status).toBe(1);
    // The rejected value must not appear verbatim in stderr (S22 regression).
    expect(result.stderr).not.toContain(sensitiveValue);
    // No JSON success line on the failure path — extractJsonLine returns null
    // because the worker exits 1 before writing the success JSON.
    expect(extractJsonLine(result.stdout)).toBeNull();
  });
});
