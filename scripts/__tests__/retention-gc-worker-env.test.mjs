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

function spawnWorker(envOverrides = {}, args = ["--validate-env-only"]) {
  return spawnSync(
    "node_modules/.bin/tsx",
    [WORKER, ...args],
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

  it("exits 1 in production when only DATABASE_URL is set (no RETENTION_GC_DATABASE_URL fallback)", () => {
    // Production must NOT fall back to the broad app DATABASE_URL — the scoped
    // worker URL is required. Error path pinned to RETENTION_GC_DATABASE_URL.
    const result = spawnWorker({
      NODE_ENV: "production",
      DATABASE_URL: VALID_DATABASE_URL,
      RETENTION_GC_DATABASE_URL: "",
    });

    expect(result.status).toBe(1);

    const stderrLines = result.stderr.trim().split("\n").filter(Boolean);
    const hasScopedError = stderrLines.some((l) => {
      try {
        return JSON.parse(l).path === "RETENTION_GC_DATABASE_URL";
      } catch {
        return false;
      }
    });
    expect(hasScopedError).toBe(true);
  });

  it("exits 0 in production when RETENTION_GC_DATABASE_URL is set", () => {
    const result = spawnWorker({
      NODE_ENV: "production",
      RETENTION_GC_DATABASE_URL: VALID_DATABASE_URL,
    });

    expect(result.status).toBe(0);
    const payload = extractJsonLine(result.stdout);
    expect(payload).toEqual({ level: "info", msg: "env validation passed" });
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

// ── sweep settings (#1009 / #1010) ──────────────────────────────────────────

/** The paths of the JSON error lines on stderr. */
function errorPaths(stderr) {
  return stderr
    .trim()
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        const obj = JSON.parse(l);
        return obj.level === "error" && typeof obj.path === "string" ? [obj.path] : [];
      } catch {
        return [];
      }
    });
}

const DEPLOYMENT_ID = "550e8400-e29b-41d4-a716-446655440000";

describe("retention-gc-worker --validate-env-only: sweep settings", () => {
  it.each([
    ["RETENTION_GC_TEAM_KEY_PRUNE_ENABLED", "true"],
    ["RETENTION_GC_BLOB_SWEEP_MODE", "off"],
    ["RETENTION_GC_BLOB_ORPHAN_GRACE_MS", "3600000"],
    ["RETENTION_GC_BLOB_ORPHAN_GRACE_MS", "3024000000"],
    ["RETENTION_GC_BLOB_SWEEP_MAX_OBJECTS", "100"],
    ["RETENTION_GC_BLOB_SWEEP_MAX_OBJECTS", "1000000"],
    ["RETENTION_GC_BLOB_SWEEP_MAX_DELETES", "1"],
    ["RETENTION_GC_BLOB_SWEEP_MAX_DELETES", "100000"],
    ["RETENTION_GC_BLOB_SWEEP_MAX_DELETE_RATIO", "1"],
    ["RETENTION_GC_BLOB_SWEEP_MAX_DELETE_RATIO", "0.01"],
    // An empty optional blob variable reads as unset, as the store reads it.
    ["BLOB_BACKEND", ""],
    ["BLOB_BACKEND", "s3"],
  ])("accepts %s=%j", (name, value) => {
    const result = spawnWorker({ DATABASE_URL: VALID_DATABASE_URL, [name]: value });
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    ["RETENTION_GC_TEAM_KEY_PRUNE_ENABLED", "yes"],
    ["RETENTION_GC_BLOB_SWEEP_MODE", "purge"],
    ["RETENTION_GC_BLOB_ORPHAN_GRACE_MS", "3599999"],
    ["RETENTION_GC_BLOB_ORPHAN_GRACE_MS", "3024000001"],
    ["RETENTION_GC_BLOB_SWEEP_MAX_OBJECTS", "99"],
    ["RETENTION_GC_BLOB_SWEEP_MAX_OBJECTS", "1000001"],
    ["RETENTION_GC_BLOB_SWEEP_MAX_DELETES", "0"],
    ["RETENTION_GC_BLOB_SWEEP_MAX_DELETES", "100001"],
    ["RETENTION_GC_BLOB_SWEEP_MAX_DELETE_RATIO", "0"],
    ["RETENTION_GC_BLOB_SWEEP_MAX_DELETE_RATIO", "1.01"],
    ["BLOB_BACKEND", "ftp"],
    ["DEPLOYMENT_ID", "not-a-uuid"],
  ])("refuses %s=%j, naming it", (name, value) => {
    const result = spawnWorker({ DATABASE_URL: VALID_DATABASE_URL, [name]: value });
    expect(result.status).toBe(1);
    expect(errorPaths(result.stderr)).toContain(name);
  });

  it.each(["report", "delete"])("requires DEPLOYMENT_ID when the blob sweep mode is %s", (mode) => {
    const grace = { RETENTION_GC_BLOB_ORPHAN_GRACE_MS: "86400000" };
    const without = spawnWorker({ DATABASE_URL: VALID_DATABASE_URL, RETENTION_GC_BLOB_SWEEP_MODE: mode, DEPLOYMENT_ID: "", ...grace });
    expect(without.status).toBe(1);
    expect(errorPaths(without.stderr)).toEqual(["DEPLOYMENT_ID"]);
    const withId = spawnWorker({ DATABASE_URL: VALID_DATABASE_URL, RETENTION_GC_BLOB_SWEEP_MODE: mode, DEPLOYMENT_ID, ...grace });
    expect(withId.status, withId.stderr).toBe(0);
  });

  it("delete mode refuses a defaulted grace period, naming RETENTION_GC_BLOB_ORPHAN_GRACE_MS", () => {
    const result = spawnWorker({
      DATABASE_URL: VALID_DATABASE_URL,
      RETENTION_GC_BLOB_SWEEP_MODE: "delete",
      DEPLOYMENT_ID,
      RETENTION_GC_BLOB_ORPHAN_GRACE_MS: "",
    });
    expect(result.status).toBe(1);
    expect(errorPaths(result.stderr)).toEqual(["RETENTION_GC_BLOB_ORPHAN_GRACE_MS"]);
  });

  it("delete mode passes with an explicit grace period", () => {
    const result = spawnWorker({
      DATABASE_URL: VALID_DATABASE_URL,
      RETENTION_GC_BLOB_SWEEP_MODE: "delete",
      DEPLOYMENT_ID,
      RETENTION_GC_BLOB_ORPHAN_GRACE_MS: "2592000000",
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it("report mode passes without a grace period (it uses the default)", () => {
    const result = spawnWorker({
      DATABASE_URL: VALID_DATABASE_URL,
      RETENTION_GC_BLOB_SWEEP_MODE: "report",
      DEPLOYMENT_ID,
      RETENTION_GC_BLOB_ORPHAN_GRACE_MS: "",
    });
    expect(result.status, result.stderr).toBe(0);
  });
});

// The store-less refusals: each exits 1 before any blob store is built, so
// none of them can write. The MinIO-backed created/exists cells live in
// src/__tests__/db-integration/retention-gc-blob-orphans.integration.test.ts.
describe("retention-gc-worker --init-blob-marker refusals", () => {
  /** The refusal reason on stderr, or null. */
  function refusal(stderr) {
    for (const l of stderr.trim().split("\n").filter(Boolean)) {
      try {
        const obj = JSON.parse(l);
        if (obj.msg === "init-blob-marker refused") return obj.reason;
      } catch {
        // not JSON
      }
    }
    return null;
  }

  it.each([
    ["the blob sweep mode is off", { RETENTION_GC_BLOB_SWEEP_MODE: "off", DEPLOYMENT_ID, BLOB_BACKEND: "s3" }, "blob_sweep_mode_off"],
    ["BLOB_BACKEND is db", { RETENTION_GC_BLOB_SWEEP_MODE: "report", DEPLOYMENT_ID, BLOB_BACKEND: "db" }, "db_backend"],
    ["BLOB_BACKEND is unset", { RETENTION_GC_BLOB_SWEEP_MODE: "report", DEPLOYMENT_ID, BLOB_BACKEND: "" }, "db_backend"],
  ])("exits 1 when %s", (_label, env, reason) => {
    const result = spawnWorker({ DATABASE_URL: VALID_DATABASE_URL, ...env }, ["--init-blob-marker"]);
    expect(result.status).toBe(1);
    expect(refusal(result.stderr)).toBe(reason);
    expect(result.stdout).not.toContain("init-blob-marker");
  });

  it("exits 1 at env validation when DEPLOYMENT_ID is missing", () => {
    const result = spawnWorker(
      { DATABASE_URL: VALID_DATABASE_URL, RETENTION_GC_BLOB_SWEEP_MODE: "report", DEPLOYMENT_ID: "", BLOB_BACKEND: "s3" },
      ["--init-blob-marker"],
    );
    expect(result.status).toBe(1);
    expect(errorPaths(result.stderr)).toEqual(["DEPLOYMENT_ID"]);
  });
  // Review FF3: --init-blob-marker never connects to the database, so the
  // database-URL rules do not apply to it. Each cell reaches the marker step
  // (refused there, on the db backend, so nothing is written) instead of
  // failing env validation.
  it.each([
    ["no database URL at all", {}],
    ["production without RETENTION_GC_DATABASE_URL", { NODE_ENV: "production", DATABASE_URL: VALID_DATABASE_URL }],
  ])("does not require a database URL: %s", (_label, env) => {
    const result = spawnWorker(
      { RETENTION_GC_BLOB_SWEEP_MODE: "report", DEPLOYMENT_ID, BLOB_BACKEND: "db", ...env },
      ["--init-blob-marker"],
    );
    expect(result.status).toBe(1);
    expect(errorPaths(result.stderr)).toEqual([]);
    expect(refusal(result.stderr)).toBe("db_backend");
  });
});

describe("retention-gc-worker normal boot", () => {
  it("still exits 1 at env validation without a database URL (control for the --init-blob-marker cells)", () => {
    const result = spawnWorker({ RETENTION_GC_BLOB_SWEEP_MODE: "report", DEPLOYMENT_ID, BLOB_BACKEND: "db" }, []);
    expect(result.status).toBe(1);
    expect(errorPaths(result.stderr)).toEqual(["DATABASE_URL"]);
  });

  it("still exits 1 in production without RETENTION_GC_DATABASE_URL", () => {
    const result = spawnWorker({ NODE_ENV: "production", DATABASE_URL: VALID_DATABASE_URL }, []);
    expect(result.status).toBe(1);
    expect(errorPaths(result.stderr)).toEqual(["RETENTION_GC_DATABASE_URL"]);
  });
});
