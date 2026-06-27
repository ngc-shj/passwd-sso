/**
 * Self-test for scripts/checks/check-permanent-delete-stepup.sh — the CI guard
 * that requires step-up (requireRecentCurrentAuthMethod) on every route that
 * irreversibly hard-deletes vault data.
 *
 * The guard is the completeness backstop for an enumeration class; a regression
 * in its detection (regex, exempt parsing, anti-drift) would silently make it
 * fail-open, so it gets its own test asserting it catches each failure mode.
 *
 * The guard is driven against fixtures via the STEPUP_GUARD_* env overrides
 * (API_DIR / PATH_ROOT / EXEMPT_FILE) so the test never mutates tracked files.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GUARD = join(REPO_ROOT, "scripts/checks/check-permanent-delete-stepup.sh");

const DELETE_LINE = "await prisma.passwordEntry.deleteMany({ where: { userId } });";
const STEPUP_LINE =
  "const stepUp = await requireRecentCurrentAuthMethod(req); if (stepUp) return stepUp;";

let root;
let apiDir;
let exemptFile;

/** Run the guard against the fixture tree. */
function runGuard() {
  const r = spawnSync("bash", [GUARD], {
    encoding: "utf8",
    env: {
      ...process.env,
      STEPUP_GUARD_API_DIR: apiDir,
      STEPUP_GUARD_PATH_ROOT: root,
      STEPUP_GUARD_EXEMPT_FILE: exemptFile,
    },
  });
  return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Create a fixture route file at api/<rel>/route.ts with the given body. */
function writeRoute(rel, body) {
  const dir = join(apiDir, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "route.ts"), body, "utf8");
  return `api/${rel}/route.ts`; // PATH_ROOT-relative path the guard prints
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "stepup-guard-"));
  apiDir = join(root, "api");
  exemptFile = join(root, "exempt.txt");
  mkdirSync(apiDir, { recursive: true });
  writeFileSync(exemptFile, "# fixture exempt list\n", "utf8");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-permanent-delete-stepup.sh", () => {
  it("passes when a hard-delete route has step-up", () => {
    writeRoute("passwords/empty-trash", `${STEPUP_LINE}\n${DELETE_LINE}\n`);
    const { exitCode } = runGuard();
    expect(exitCode).toBe(0);
  });

  it("passes when a route only soft-deletes (no hard-delete primitive)", () => {
    writeRoute(
      "passwords/[id]",
      "await prisma.passwordEntry.update({ data: { deletedAt: new Date() } });\n",
    );
    const { exitCode } = runGuard();
    expect(exitCode).toBe(0);
  });

  it("FAILS (MISSING_STEPUP) when a hard-delete route lacks step-up", () => {
    writeRoute("passwords/bulk-purge", `${DELETE_LINE}\n`);
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("MISSING_STEPUP");
    expect(stdout).toContain("api/passwords/bulk-purge/route.ts");
  });

  it("does NOT accept a prefixed/renamed step-up identifier", () => {
    writeRoute(
      "passwords/empty-trash",
      `const x = DISABLED_requireRecentCurrentAuthMethod(req);\n${DELETE_LINE}\n`,
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("MISSING_STEPUP");
  });

  it("does NOT accept a bare import without a call", () => {
    writeRoute(
      "passwords/empty-trash",
      `import { requireRecentCurrentAuthMethod } from "@/lib/auth/session/recent-current-auth-method";\n${DELETE_LINE}\n`,
    );
    const { exitCode } = runGuard();
    expect(exitCode).toBe(1);
  });

  it("catches team deletion (cascade) without step-up", () => {
    writeRoute(
      "teams/[teamId]",
      "await tx.team.delete({ where: { id: teamId } });\n",
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("MISSING_STEPUP");
  });

  it("does NOT false-positive on teamMember.delete / teamFolder.delete", () => {
    writeRoute(
      "teams/[teamId]/members/[memberId]",
      "await tx.teamMember.delete({ where: { id } });\nawait tx.teamFolder.delete({ where: { id } });\n",
    );
    const { exitCode } = runGuard();
    expect(exitCode).toBe(0);
  });

  it("passes when a hard-delete route is exempted WITH a reason", () => {
    const rel = writeRoute("vault/admin-reset", "await executeVaultReset(userId);\n");
    writeFileSync(exemptFile, `${rel}  # token-gated dual-admin ceremony\n`, "utf8");
    const { exitCode } = runGuard();
    expect(exitCode).toBe(0);
  });

  it("FAILS (EXEMPT_NO_REASON) when an exempt entry has no justification", () => {
    const rel = writeRoute("vault/admin-reset", "await executeVaultReset(userId);\n");
    writeFileSync(exemptFile, `${rel}\n`, "utf8");
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("EXEMPT_NO_REASON");
  });

  it("FAILS (STALE_EXEMPT) when an exempt entry points to a missing file", () => {
    writeFileSync(
      exemptFile,
      "api/does/not/exist/route.ts  # bogus stale entry\n",
      "utf8",
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("STALE_EXEMPT");
  });

  it("FAILS (STALE_EXEMPT) when an exempt route no longer hard-deletes", () => {
    const rel = writeRoute(
      "vault/admin-reset",
      "await prisma.passwordEntry.update({ data: { deletedAt: new Date() } });\n",
    );
    writeFileSync(exemptFile, `${rel}  # used to hard-delete, now soft only\n`, "utf8");
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("STALE_EXEMPT");
  });
});
