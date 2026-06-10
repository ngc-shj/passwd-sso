/**
 * Tests for scripts/set-audit-anchor-publisher-password.sh
 *
 * Coverage:
 *   T1 — exits 1 with structured error when stdin is empty
 *   T2 — DRY_RUN=1 + --print-args-file: exits 0, argv does NOT contain
 *        new_password=, and the captured stdin SQL contains the plain password
 *   T3 — password with a single quote: SQL file doubles it (SQL-safe quoting)
 *   T4 — password with a literal $: passes through unchanged in the SQL
 *   T5 — password value never appears in bash wrapper's stdout/stderr
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const SCRIPT = resolve(REPO_ROOT, "scripts", "set-audit-anchor-publisher-password.sh");
const FAKE_DB_URL = "postgresql://superuser:superpass@localhost:5432/passwd_sso";

function spawnScript(args = [], opts = {}) {
  return spawnSync("bash", [SCRIPT, ...args], {
    env: {
      PATH: process.env.PATH,
      MIGRATION_DATABASE_URL: FAKE_DB_URL,
      ...opts.env,
    },
    input: opts.input ?? null,
    encoding: "utf8",
    timeout: 10_000,
    cwd: REPO_ROOT,
  });
}

describe("set-audit-anchor-publisher-password.sh", () => {
  it("exits 1 with structured error when stdin is empty", () => {
    const result = spawnScript([], { input: "" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("password expected on stdin");
  });

  it("with DRY_RUN=1 + --print-args-file + stdin 'secret': argv must NOT contain new_password=, SQL file contains the password", () => {
    const tmpDir = mkdtempSync(resolve(tmpdir(), "anchor-test-"));
    const sqlFile = resolve(tmpDir, "sql.txt");

    try {
      const result = spawnScript(
        ["--print-args-file", sqlFile],
        {
          input: "secret",
          env: { DRY_RUN: "1" },
        },
      );

      expect(result.status).toBe(0);

      // argv must NOT expose the password.
      expect(result.stdout).not.toContain("new_password=");
      expect(result.stderr).not.toContain("new_password=secret");

      // The captured stdin SQL must contain the real password value.
      const sql = readFileSync(sqlFile, "utf8");
      expect(sql).toContain("'secret'");
      expect(sql).toContain("passwd_anchor_publisher");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("single-quote in password is doubled in the SQL (SQL-safe quoting)", () => {
    const tmpDir = mkdtempSync(resolve(tmpdir(), "anchor-test-quote-"));
    const sqlFile = resolve(tmpDir, "sql.txt");

    try {
      const result = spawnScript(
        ["--print-args-file", sqlFile],
        {
          input: "it's'a'test",
          env: { DRY_RUN: "1" },
        },
      );

      expect(result.status).toBe(0);

      const sql = readFileSync(sqlFile, "utf8");
      // Each ' in the original must become '' in the SQL string literal.
      expect(sql).toContain("'it''s''a''test'");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("literal $ in password passes through unchanged in the SQL", () => {
    const tmpDir = mkdtempSync(resolve(tmpdir(), "anchor-test-dollar-"));
    const sqlFile = resolve(tmpDir, "sql.txt");

    try {
      const result = spawnScript(
        ["--print-args-file", sqlFile],
        {
          input: "pa$$word",
          env: { DRY_RUN: "1" },
        },
      );

      expect(result.status).toBe(0);

      const sql = readFileSync(sqlFile, "utf8");
      expect(sql).toContain("'pa$$word'");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("password value never appears in the bash wrapper's stdout or stderr", () => {
    const tmpDir = mkdtempSync(resolve(tmpdir(), "anchor-test-leak-"));
    const sqlFile = resolve(tmpDir, "sql.txt");
    const sentinel = "super-secret-cmdline-check-anchor-12345";

    try {
      const result = spawnScript(
        ["--print-args-file", sqlFile],
        {
          input: sentinel,
          env: { DRY_RUN: "1" },
        },
      );

      expect(result.status).toBe(0);

      // The password must not appear in stdout/stderr.
      expect(result.stdout).not.toContain(sentinel);
      expect(result.stderr).not.toContain(sentinel);

      // Confirm the password IS correctly captured in the SQL file.
      const sql = readFileSync(sqlFile, "utf8");
      expect(sql).toContain(`'${sentinel}'`);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
