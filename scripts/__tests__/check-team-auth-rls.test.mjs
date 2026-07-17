/**
 * Self-test for scripts/checks/check-team-auth-rls.mjs — the CI guard that
 * forbids nesting requireTeamPermission/requireTeamMember calls inside a
 * withUserTenantRls/withTeamTenantRls wrapper (double auth-context layering
 * that has bitten this codebase before).
 *
 * The gate is cwd-relative (reads "src/app/api" and "src/lib" off the
 * process cwd, no env override), so it is fixtured by spawning it with
 * `cwd` pointed at a temp tree that mirrors that shape — no code change to
 * the gate itself (plan C2: "fixturable by cwd alone").
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GUARD = join(REPO_ROOT, "scripts/checks/check-team-auth-rls.mjs");

let root;

function runGuard(cwd = root) {
  const r = spawnSync("node", [GUARD], { encoding: "utf8", cwd });
  return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "team-auth-rls-"));
  mkdirSync(join(root, "src/app/api"), { recursive: true });
  mkdirSync(join(root, "src/lib"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-team-auth-rls.mjs", () => {
  it("FAILS when requireTeamPermission is nested inside withUserTenantRls", () => {
    writeFileSync(
      join(root, "src/app/api/teams-fixture.ts"),
      [
        "export async function handler(userId, teamId) {",
        "  return withUserTenantRls(userId, async (tx) => {",
        "    await requireTeamPermission(tx, teamId, userId);",
        "  });",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    const { exitCode, stderr } = runGuard();
    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      "Found forbidden nested team-auth calls under tenant RLS wrappers.",
    );
    expect(stderr).toContain("src/app/api/teams-fixture.ts");
  });

  it("FAILS when requireTeamMember is nested inside withTeamTenantRls", () => {
    writeFileSync(
      join(root, "src/lib/team-fixture.ts"),
      [
        "export async function handler(teamId, userId) {",
        "  return withTeamTenantRls(teamId, async (tx) => {",
        "    await requireTeamMember(tx, teamId, userId);",
        "  });",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    const { exitCode, stderr } = runGuard();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("src/lib/team-fixture.ts");
  });

  it("passes when team-auth calls happen OUTSIDE the tenant RLS wrapper", () => {
    writeFileSync(
      join(root, "src/app/api/teams-fixture.ts"),
      [
        "export async function handler(userId, teamId) {",
        "  await requireTeamPermission(null, teamId, userId);",
        "  return withUserTenantRls(userId, async (tx) => {",
        "    await tx.team.findFirst({ where: { id: teamId } });",
        "  });",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("check-team-auth-rls: OK");
  });

  it("passes when withUserTenantRls has no forbidden calls at all", () => {
    writeFileSync(
      join(root, "src/app/api/teams-fixture.ts"),
      [
        "export async function handler(userId) {",
        "  return withUserTenantRls(userId, async (tx) => {",
        "    await tx.passwordEntry.findMany({ where: { userId } });",
        "  });",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    const { exitCode } = runGuard();
    expect(exitCode).toBe(0);
  });

  describe("real repo (no overrides)", () => {
    it("passes against the actual repo source tree", () => {
      const r = spawnSync("node", [GUARD], { encoding: "utf8" });
      expect(r.status, r.stdout + r.stderr).toBe(0);
    });
  });
});
