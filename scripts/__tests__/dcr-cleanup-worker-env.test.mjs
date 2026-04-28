/**
 * Tests for the dcr-cleanup worker's --validate-env-only flag.
 *
 * Each test spawns the worker with a minimal env (PATH + explicit overrides) to
 * verify the Zod validation path without touching the database.
 *
 * T25: stdout assertions pin the EXACT JSON payload (via JSON.parse + toEqual),
 * never substring-only. Substring-only assertions are FORBIDDEN per spec.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const WORKER = resolve(REPO_ROOT, "scripts", "dcr-cleanup-worker.ts");

const VALID_DATABASE_URL = "postgresql://app:app@localhost:5432/passwd_sso";
const VALID_DCR_CLEANUP_DATABASE_URL = "postgresql://passwd_dcr_cleanup_worker:pass@localhost:5432/passwd_sso";
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
      // Never inherit parent env — explicit pass only.
      // DATABASE_URL="" is passed explicitly so dotenv's loadEnv() cannot
      // override it from .env or .env.local.
      env: { PATH: process.env.PATH, DATABASE_URL: "", ...envOverrides },
      encoding: "utf8",
      timeout: 15_000,
      cwd: REPO_ROOT,
    },
  );
}

/**
 * Extract the first line from stdout that parses as valid JSON.
 * Skips non-JSON lines defensively (e.g. future dotenv diagnostic banners).
 */
function extractJsonLine(stdout) {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      return JSON.parse(trimmed);
    } catch {
      // skip non-JSON lines
    }
  }
  return null;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("dcr-cleanup-worker --validate-env-only", () => {
  it("exits 0 and stdout equals {level:info,msg:env validation passed} when all required vars are valid", () => {
    const result = spawnWorker({
      DATABASE_URL: VALID_DATABASE_URL,
      DCR_CLEANUP_DATABASE_URL: VALID_DCR_CLEANUP_DATABASE_URL,
    });

    expect(result.status).toBe(0);

    // Exact payload check via JSON.parse + toEqual (not substring-only).
    const payload = extractJsonLine(result.stdout);
    expect(payload).toEqual({ level: "info", msg: "env validation passed" });
  });

  it("exits 1 with stderr JSON {path:DCR_CLEANUP_DATABASE_URL,code} when that var is a malformed URL", () => {
    const result = spawnWorker({
      DATABASE_URL: VALID_DATABASE_URL,
      DCR_CLEANUP_DATABASE_URL: MALFORMED_URL,
    });

    expect(result.status).toBe(1);

    const stderrLines = result.stderr.trim().split("\n").filter(Boolean);
    const errorLine = stderrLines.find((l) => {
      try {
        const obj = JSON.parse(l);
        return obj.level === "error" && obj.path === "DCR_CLEANUP_DATABASE_URL";
      } catch {
        return false;
      }
    });
    expect(errorLine).toBeTruthy();

    const parsed = JSON.parse(errorLine);
    expect(parsed.level).toBe("error");
    expect(parsed.msg).toBe("env validation failed");
    expect(parsed.path).toBe("DCR_CLEANUP_DATABASE_URL");
    expect(typeof parsed.code).toBe("string");
  });

  it("exits 1 when DCR_CLEANUP_DATABASE_URL is missing AND DATABASE_URL is also missing", () => {
    // DCR_CLEANUP_DATABASE_URL is optional in schema (falls back to DATABASE_URL).
    // When both are missing, DATABASE_URL="" triggers nonEmpty rejection.
    const result = spawnWorker({
      DATABASE_URL: "",  // explicitly empty → Zod nonEmpty rejects it
    });

    expect(result.status).toBe(1);

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

  it("exits 1 when DCR_CLEANUP_INTERVAL_MS is below 60_000", () => {
    const result = spawnWorker({
      DATABASE_URL: VALID_DATABASE_URL,
      DCR_CLEANUP_INTERVAL_MS: "30000",
    });

    expect(result.status).toBe(1);

    const stderrLines = result.stderr.trim().split("\n").filter(Boolean);
    const hasIntervalError = stderrLines.some((l) => {
      try {
        const obj = JSON.parse(l);
        return obj.path === "DCR_CLEANUP_INTERVAL_MS";
      } catch {
        return false;
      }
    });
    expect(hasIntervalError).toBe(true);
  });

  it("exits 1 when DCR_CLEANUP_BATCH_SIZE is above 10_000", () => {
    const result = spawnWorker({
      DATABASE_URL: VALID_DATABASE_URL,
      DCR_CLEANUP_BATCH_SIZE: "99999",
    });

    expect(result.status).toBe(1);

    const stderrLines = result.stderr.trim().split("\n").filter(Boolean);
    const hasBatchSizeError = stderrLines.some((l) => {
      try {
        const obj = JSON.parse(l);
        return obj.path === "DCR_CLEANUP_BATCH_SIZE";
      } catch {
        return false;
      }
    });
    expect(hasBatchSizeError).toBe(true);
  });
});
