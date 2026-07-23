/**
 * Env-contract test for scripts/retention-gc-worker.ts --validate-env-only (C5/T9).
 *
 * Each test spawns the worker with a minimal, isolated env (PATH + explicit overrides)
 * to verify the Zod validation path without touching the database.
 *
 * Assertions use JSON.parse + toEqual (not substring-only) per T25/T9 contract.
 * No snapshots — this project has no snapshot infra.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const WORKER = resolve(REPO_ROOT, "scripts", "retention-gc-worker.ts");

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
      // Never inherit parent env — explicit pass only (mirrors audit-outbox-worker-env.test.mjs).
      // DATABASE_URL="" is passed explicitly so dotenv's loadEnv() cannot override it.
      env: { PATH: process.env.PATH, DATABASE_URL: "", ...envOverrides },
      encoding: "utf8",
      timeout: 15_000,
      cwd: REPO_ROOT,
    },
  );
}

/**
 * Extract the first line from stdout that parses as valid JSON.
 * Skips non-JSON preamble lines (e.g. future dotenv diagnostic banners).
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

describe("retention-gc-worker --validate-env-only", () => {
  it("exits 0 and stdout equals {level:info,msg:'env validation passed'} with valid env (T9)", () => {
    const result = spawnWorker({
      DATABASE_URL: VALID_DATABASE_URL,
      // RETENTION_GC_DATABASE_URL omitted — falls back to DATABASE_URL.
    });

    expect(result.status).toBe(0);

    // T9: exact payload check via JSON.parse + toEqual (NOT substring-only).
    const payload = extractJsonLine(result.stdout);
    expect(payload).toEqual({ level: "info", msg: "env validation passed" });
  });

  it("exits 0 with explicit RETENTION_GC_DATABASE_URL set", () => {
    const result = spawnWorker({
      DATABASE_URL: VALID_DATABASE_URL,
      RETENTION_GC_DATABASE_URL: VALID_DATABASE_URL,
    });

    expect(result.status).toBe(0);

    const payload = extractJsonLine(result.stdout);
    expect(payload).toEqual({ level: "info", msg: "env validation passed" });
  });

  it("exits 1 with stderr JSON {level:error,msg:'env validation failed',path:'RETENTION_GC_DATABASE_URL'} when malformed", () => {
    const result = spawnWorker({
      DATABASE_URL: VALID_DATABASE_URL,
      RETENTION_GC_DATABASE_URL: MALFORMED_URL,
    });

    expect(result.status).toBe(1);

    // Find the relevant error line in stderr.
    const stderrLines = result.stderr.trim().split("\n").filter(Boolean);
    const errorLine = stderrLines.find((l) => {
      try {
        const obj = JSON.parse(l);
        return obj.level === "error" && obj.path === "RETENTION_GC_DATABASE_URL";
      } catch {
        return false;
      }
    });
    expect(errorLine).toBeTruthy();

    const parsed = JSON.parse(errorLine);
    // T9: exact payload check.
    expect(parsed.level).toEqual("error");
    expect(parsed.msg).toEqual("env validation failed");
    expect(parsed.path).toEqual("RETENTION_GC_DATABASE_URL");
    expect(typeof parsed.code).toBe("string");
  });

  it("exits 0 with ONLY RETENTION_GC_DATABASE_URL set and DATABASE_URL unset (least-privilege path)", () => {
    // Production least-privilege deployment: only the scoped worker URL is
    // injected; the broad app DATABASE_URL is absent (spawnWorker passes "",
    // which the worker schema normalizes to unset).
    const result = spawnWorker({
      RETENTION_GC_DATABASE_URL: VALID_DATABASE_URL,
    });

    expect(result.status).toBe(0);

    const payload = extractJsonLine(result.stdout);
    expect(payload).toEqual({ level: "info", msg: "env validation passed" });
  });

  it("exits 1 with DATABASE_URL-pathed error when neither DATABASE_URL nor RETENTION_GC_DATABASE_URL is set", () => {
    // Both URLs explicitly empty so loadEnv()/dotenv cannot populate them from
    // .env (dotenv does not override already-set vars). Empty → normalized to
    // unset → the at-least-one-URL .refine() fails with path pinned to DATABASE_URL.
    const result = spawnWorker({ RETENTION_GC_DATABASE_URL: "" });

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

  it("exits 1 with clear error when RETENTION_GC_BATCH_SIZE is non-numeric", () => {
    const result = spawnWorker({
      DATABASE_URL: VALID_DATABASE_URL,
      RETENTION_GC_BATCH_SIZE: "not-a-number",
    });

    expect(result.status).toBe(1);

    const stderrLines = result.stderr.trim().split("\n").filter(Boolean);
    const hasBatchSizeError = stderrLines.some((l) => {
      try {
        const obj = JSON.parse(l);
        return obj.path === "RETENTION_GC_BATCH_SIZE";
      } catch {
        return false;
      }
    });
    expect(hasBatchSizeError).toBe(true);
  });

  it("stderr does NOT include the rejected value (F30+S22 — no value echo)", () => {
    const sensitiveValue = "super-secret-malformed-url-that-must-not-leak-99887766";
    const result = spawnWorker({
      DATABASE_URL: VALID_DATABASE_URL,
      RETENTION_GC_DATABASE_URL: sensitiveValue,
    });

    expect(result.status).toBe(1);
    // The rejected value must never appear verbatim in stderr.
    expect(result.stderr).not.toContain(sensitiveValue);
    // No success JSON on the failure path.
    expect(extractJsonLine(result.stdout)).toBeNull();
  });
});
