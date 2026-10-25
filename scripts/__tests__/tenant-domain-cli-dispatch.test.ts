/**
 * Subcommand dispatch of scripts/tenant-domain.ts, exercised the way an
 * operator runs it: as a process. The integration suite imports the `cmd*`
 * functions directly and never reaches `main()`, so a removed subcommand
 * (`preflight`) quietly coming back would go unnoticed there.
 *
 * No database: MIGRATION_DATABASE_URL is set to the empty string, which
 * load-env does not override, so a dispatched handler stops at its URL check
 * and the default branch never needs one.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const SCRIPT = resolve(ROOT, "scripts/tenant-domain.ts");
const TSX = resolve(ROOT, "node_modules/.bin/tsx");
const MISSING_URL = "MIGRATION_DATABASE_URL is required";
// Above vitest's global 10s testTimeout: each case cold-starts tsx, which a
// contended CI runner can take several seconds over. The child is killed a
// little earlier so a hang reports as a failed spawn, not a vitest timeout.
const CASE_TIMEOUT_MS = 30_000;

function runCli(...args: string[]) {
  return spawnSync(TSX, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { NODE_ENV: "test", PATH: process.env.PATH, HOME: process.env.HOME, MIGRATION_DATABASE_URL: "" },
    encoding: "utf8",
    timeout: CASE_TIMEOUT_MS - 5_000,
  });
}

describe("tenant-domain CLI dispatch", () => {
  it("rejects the removed preflight subcommand with usage, reaching no handler", () => {
    const r = runCli("preflight");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Usage:");
    expect(r.stderr).not.toContain("tenant-domain preflight");
    expect(r.stderr).not.toContain(MISSING_URL);
  }, CASE_TIMEOUT_MS);

  it("dispatches bind --apply <file> to its handler, reading the file name as --apply's value", () => {
    const r = runCli("bind", "--apply", "/nonexistent/bind.tsv", "--by", "ops");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(MISSING_URL);
    expect(r.stderr).not.toContain("Usage:");
  }, CASE_TIMEOUT_MS);

  it("refuses a flag the chosen bind form does not read, before reaching a handler", () => {
    const r = runCli("bind", "--from-members", "--out", "/nonexistent/bind.tsv", "--by", "ops");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("This form of bind does not read --by");
    expect(r.stderr).not.toContain(MISSING_URL);
  }, CASE_TIMEOUT_MS);

  it("refuses a flag the subcommand does not read, before reaching a handler", () => {
    const r = runCli("remove", "--tenant", "t", "--domain", "a.example", "--by", "ops", "--provider", "google");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("remove does not read --provider");
    expect(r.stderr).not.toContain(MISSING_URL);
  }, CASE_TIMEOUT_MS);

  it("refuses a valueless flag the subcommand does not read as stray, not as missing its value", () => {
    const r = runCli("remove", "--tenant", "t", "--domain", "a.example", "--by", "ops", "--provider");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("remove does not read --provider");
    expect(r.stderr).not.toContain("requires a value");
  }, CASE_TIMEOUT_MS);

  it("prints the usage for bind with no form or two forms", () => {
    for (const args of [["bind", "--by", "ops"], ["bind", "--claim", "a.example", "--from-members"]]) {
      const r = runCli(...args);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("Usage:");
    }
  }, CASE_TIMEOUT_MS);

  it("dispatches a real subcommand through the same path to its handler", () => {
    const r = runCli("list");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(MISSING_URL);
    expect(r.stderr).not.toContain("Usage:");
  }, CASE_TIMEOUT_MS);
});
