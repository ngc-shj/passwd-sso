import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, "..", "check-licenses.mjs");
const FIXTURES = resolve(__dirname, "fixtures");

function run(args, { expectFail = false } = {}) {
  try {
    const stdout = execFileSync("node", [SCRIPT, ...args], {
      encoding: "utf8",
      timeout: 10_000,
    });
    if (expectFail) throw new Error("Expected non-zero exit but got 0");
    return { stdout, exitCode: 0 };
  } catch (err) {
    if (!expectFail) throw err;
    return { stdout: (err.stdout || "") + (err.stderr || ""), exitCode: err.status };
  }
}

describe("check-licenses.mjs", () => {
  it("passes strict mode with real lockfile and production allowlist", () => {
    const { stdout } = run([
      "--name", "app",
      "--lockfile", "package-lock.json",
      "--strict",
    ]);
    expect(stdout).toContain("[license-audit] PASSED (strict)");
    expect(stdout).toContain("unreviewed=0");
    expect(stdout).toContain("expired=0");
  });

  it("passes non-strict with review-required but no allowlist (backward compat)", () => {
    const { stdout } = run([
      "--name", "test",
      "--lockfile", resolve(FIXTURES, "lockfile-lgpl.json"),
      "--allowlist", resolve(FIXTURES, "allowlist-valid.json"),
    ]);
    expect(stdout).toContain("[license-audit] PASSED");
    expect(stdout).not.toContain("FAILED");
  });

  it("fails strict when unreviewed review-required exists", () => {
    // lockfile-lgpl has lgpl-pkg + missing-pkg, but we use no allowlist
    const nonexistent = resolve(FIXTURES, "allowlist-nonexistent.json");
    const { stdout, exitCode } = run(
      [
        "--name", "test",
        "--lockfile", resolve(FIXTURES, "lockfile-lgpl.json"),
        "--allowlist", nonexistent,
        "--strict",
      ],
      { expectFail: true },
    );
    expect(exitCode).toBe(1);
    expect(stdout).toContain("FAILED (strict)");
    expect(stdout).toContain("unreviewed");
  });

  it("fails when forbidden GPL license is detected", () => {
    const { stdout, exitCode } = run(
      [
        "--name", "test",
        "--lockfile", resolve(FIXTURES, "lockfile-gpl.json"),
      ],
      { expectFail: true },
    );
    expect(exitCode).toBe(1);
    expect(stdout).toContain("FAILED: forbidden licenses detected");
    expect(stdout).toContain("gpl-pkg");
  });

  it("fails strict when allowlist JSON is malformed", () => {
    const { stdout, exitCode } = run(
      [
        "--name", "test",
        "--lockfile", resolve(FIXTURES, "lockfile-clean.json"),
        "--allowlist", resolve(FIXTURES, "allowlist-malformed.json"),
        "--strict",
      ],
      { expectFail: true },
    );
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("Failed to parse allowlist JSON");
  });

  it("warns on allowlist schema issues (missing required fields)", () => {
    const { stdout } = run([
      "--name", "test",
      "--lockfile", resolve(FIXTURES, "lockfile-lgpl.json"),
      "--allowlist", resolve(FIXTURES, "allowlist-missing-fields.json"),
    ]);
    expect(stdout).toContain("Allowlist schema warnings");
    expect(stdout).toContain("missing fields");
    // Non-strict mode still passes
    expect(stdout).toContain("[license-audit] PASSED");
  });

  it("fails strict when allowlist entry is expired", () => {
    const { stdout, exitCode } = run(
      [
        "--name", "test",
        "--lockfile", resolve(FIXTURES, "lockfile-lgpl.json"),
        "--allowlist", resolve(FIXTURES, "allowlist-expired.json"),
        "--strict",
      ],
      { expectFail: true },
    );
    expect(exitCode).toBe(1);
    expect(stdout).toContain("FAILED (strict)");
    expect(stdout).toContain("expired");
  });

  it("warns but passes non-strict when allowlist entry is expired", () => {
    const { stdout } = run([
      "--name", "test",
      "--lockfile", resolve(FIXTURES, "lockfile-lgpl.json"),
      "--allowlist", resolve(FIXTURES, "allowlist-expired.json"),
    ]);
    expect(stdout).toContain("Expired exceptions");
    expect(stdout).toContain("[license-audit] PASSED");
  });

  it("fails strict when installed version differs from approved version", () => {
    const { stdout, exitCode } = run(
      [
        "--name", "test",
        "--lockfile", resolve(FIXTURES, "lockfile-lgpl.json"),
        "--allowlist", resolve(FIXTURES, "allowlist-version-mismatch.json"),
        "--strict",
      ],
      { expectFail: true },
    );
    expect(exitCode).toBe(1);
    expect(stdout).toContain("Version mismatches");
    expect(stdout).toContain("lgpl-pkg: approved=2.0.0, installed=1.0.0");
    expect(stdout).toContain("FAILED (strict)");
    expect(stdout).toContain("version mismatches");
  });
});
