/**
 * Self-test for scripts/checks/check-destructive-wrapper-derivation.mjs — the
 * CI guard deriving the destructive-wrapper set in
 * route-class-patterns.json#deleteSignal from code instead of hand curation.
 *
 * Driven against fixtures via the DESTRUCTIVE_WRAPPER_* env overrides
 * (SCAN_ROOT / PATH_ROOT / EXEMPT_FILE / PATTERNS_FILE), mirroring
 * check-permanent-delete-stepup.test.mjs's fixture harness. A fixture
 * route-class-patterns.json IS also overridden (DESTRUCTIVE_WRAPPER_PATTERNS_FILE)
 * so isolated fixture trees are not forced to also stub out the real repo's
 * executeVaultReset/deleteTeamPassword wrapper functions just to avoid a
 * spurious STALE_DELETE_SIGNAL_NAME.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GUARD = join(REPO_ROOT, "scripts/checks/check-destructive-wrapper-derivation.mjs");

let root;
let scanRoot;
let exemptFile;
let patternsFile;

// Fixture deleteSignal mirrors production shape (raw primitives + the two
// hand-added wrapper names) so STALE_DELETE_SIGNAL_NAME/UNDECLARED tests are
// isolated from the real repo's route-class-patterns.json content.
const FIXTURE_DELETE_SIGNAL =
  "passwordEntry\\.delete(Many)?\\(|teamPasswordEntry\\.delete(Many)?\\(|executeVaultReset\\(|deleteTeamPassword\\(|[^A-Za-z0-9_]team\\.delete\\(|[^A-Za-z0-9_]user\\.delete\\(";

/** Run the guard against the fixture tree. PATH_ROOT = root, so keys read "src/...". */
function runGuard(extraEnv = {}) {
  const r = spawnSync("node", [GUARD], {
    encoding: "utf8",
    env: {
      ...process.env,
      DESTRUCTIVE_WRAPPER_SCAN_ROOT: scanRoot,
      DESTRUCTIVE_WRAPPER_PATH_ROOT: root,
      DESTRUCTIVE_WRAPPER_EXEMPT_FILE: exemptFile,
      DESTRUCTIVE_WRAPPER_PATTERNS_FILE: patternsFile,
      ...extraEnv,
    },
  });
  return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Write a fixture source file under <root>/<rel>. rel is repo-relative, e.g. "src/lib/x.ts". */
function writeSource(rel, body) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

/**
 * Stub the two deleteSignal wrapper names (executeVaultReset, deleteTeamPassword)
 * as exported no-op functions somewhere in scope, so tests asserting a clean
 * pass are not incidentally tripped by STALE_DELETE_SIGNAL_NAME — that failure
 * mode has its own dedicated test below.
 */
function seedWrapperStubs() {
  writeSource(
    "src/lib/vault/fixture-vault-reset-stub.ts",
    `export async function executeVaultReset(userId: string) {\n  await tx.passwordEntry.deleteMany({ where: { userId } });\n}\n`,
  );
  writeSource(
    "src/lib/services/fixture-team-password-stub.ts",
    `export async function deleteTeamPassword(teamId: string, passwordId: string) {\n  await prisma.teamPasswordEntry.deleteMany({ where: { id: passwordId, teamId } });\n}\n`,
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "destructive-wrapper-"));
  scanRoot = join(root, "src");
  exemptFile = join(root, "exempt.txt");
  patternsFile = join(root, "route-class-patterns.json");
  mkdirSync(scanRoot, { recursive: true });
  writeFileSync(exemptFile, "# fixture exempt list\n", "utf8");
  writeFileSync(patternsFile, JSON.stringify({ deleteSignal: FIXTURE_DELETE_SIGNAL }), "utf8");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-destructive-wrapper-derivation.mjs", () => {
  it("passes on an empty scan root plus wrapper stubs (no new undeclared wrapper)", () => {
    seedWrapperStubs();
    const { exitCode } = runGuard();
    expect(exitCode).toBe(0);
  });

  it("FAILS (UNDECLARED_DESTRUCTIVE_WRAPPER) for a new exported wrapper not in deleteSignal and not exempt", () => {
    seedWrapperStubs();
    // Fixture-authoring note (plan C4): the call must be PREFIXED
    // (tx./prisma./await ...), never at column 0, matching production shape.
    writeSource(
      "src/lib/services/wipe-service.ts",
      `export async function wipeAllEntries(userId: string) {\n  await tx.passwordEntry.deleteMany({ where: { userId } });\n}\n`,
    );
    const { exitCode, stderr } = runGuard();
    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      "UNDECLARED_DESTRUCTIVE_WRAPPER: src/lib/services/wipe-service.ts#wipeAllEntries",
    );
  });

  it("passes when the same new wrapper is listed in destructive-wrapper-exempt.txt with a reason", () => {
    seedWrapperStubs();
    writeSource(
      "src/lib/services/wipe-service.ts",
      `export async function wipeAllEntries(userId: string) {\n  await tx.passwordEntry.deleteMany({ where: { userId } });\n}\n`,
    );
    writeFileSync(
      exemptFile,
      "src/lib/services/wipe-service.ts#wipeAllEntries  # test fixture: intentionally exempted wrapper\n",
      "utf8",
    );
    const { exitCode } = runGuard();
    expect(exitCode).toBe(0);
  });

  it("passes when the wrapper name matches an existing deleteSignal alternative (e.g. deleteTeamPassword)", () => {
    seedWrapperStubs();
    const { exitCode } = runGuard();
    expect(exitCode).toBe(0);
  });

  it("FAILS (STALE_DELETE_SIGNAL_NAME) when a deleteSignal wrapper name resolves to nothing in scope", () => {
    // No stubs seeded: neither executeVaultReset nor deleteTeamPassword
    // resolves to any exported function anywhere in scope.
    const { exitCode, stderr } = runGuard();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("STALE_DELETE_SIGNAL_NAME: executeVaultReset");
    expect(stderr).toContain("STALE_DELETE_SIGNAL_NAME: deleteTeamPassword");
  });

  it("FAILS (STALE_WRAPPER_EXEMPT) when an exempt entry no longer resolves to an exported function", () => {
    seedWrapperStubs();
    writeFileSync(
      exemptFile,
      "src/lib/does/not/exist.ts#ghostFunction  # test fixture: stale exempt entry\n",
      "utf8",
    );
    const { exitCode, stderr } = runGuard();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("STALE_WRAPPER_EXEMPT: src/lib/does/not/exist.ts#ghostFunction");
  });

  it("catches a wrapper defined under src/app/api/**/helpers.ts (widened scan scope, not just src/lib)", () => {
    seedWrapperStubs();
    writeSource(
      "src/app/api/x/helpers.ts",
      `export async function purgeUserEntries(userId: string) {\n  await tx.passwordEntry.deleteMany({ where: { userId } });\n}\n`,
    );
    const { exitCode, stderr } = runGuard();
    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      "UNDECLARED_DESTRUCTIVE_WRAPPER: src/app/api/x/helpers.ts#purgeUserEntries",
    );
  });

  it("does NOT scan route.ts files (governed directly by check-permanent-delete-stepup.sh)", () => {
    seedWrapperStubs();
    writeSource(
      "src/app/api/passwords/bulk-purge/route.ts",
      `export async function POST() {\n  await tx.passwordEntry.deleteMany({ where: { userId } });\n}\n`,
    );
    const { exitCode } = runGuard();
    expect(exitCode).toBe(0);
  });

  it("does NOT scan test files", () => {
    seedWrapperStubs();
    writeSource(
      "src/lib/services/wipe-service.test.ts",
      `export async function wipeAllEntries(userId: string) {\n  await tx.passwordEntry.deleteMany({ where: { userId } });\n}\n`,
    );
    const { exitCode } = runGuard();
    expect(exitCode).toBe(0);
  });

  it("does NOT false-positive on team.delete siblings (teamMember.delete / teamFolder.delete)", () => {
    seedWrapperStubs();
    writeSource(
      "src/lib/services/team-member-service.ts",
      `export async function removeMember(id: string) {\n  await tx.teamMember.delete({ where: { id } });\n}\n\nexport async function removeFolder(id: string) {\n  await tx.teamFolder.delete({ where: { id } });\n}\n`,
    );
    const { exitCode } = runGuard();
    expect(exitCode).toBe(0);
  });

  it("catches user.delete wrapped in a new exported function (sec-F4 cascade class)", () => {
    seedWrapperStubs();
    writeSource(
      "src/lib/services/account-service.ts",
      `export async function purgeAccount(userId: string) {\n  await tx.user.delete({ where: { id: userId } });\n}\n`,
    );
    const { exitCode, stderr } = runGuard();
    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      "UNDECLARED_DESTRUCTIVE_WRAPPER: src/lib/services/account-service.ts#purgeAccount",
    );
  });

  it("resolves a delete call nested inside an object-literal method to the enclosing exported function (auth-adapter shape)", () => {
    seedWrapperStubs();
    writeSource(
      "src/lib/auth/session/fixture-adapter.ts",
      [
        "export function createFixtureAdapter() {",
        "  return {",
        "    async deleteUser(userId) {",
        "      await tx.user.delete({ where: { id: userId } });",
        "    },",
        "  };",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      exemptFile,
      "src/lib/auth/session/fixture-adapter.ts#createFixtureAdapter  # test fixture: mirrors real auth-adapter.ts exemption shape\n",
      "utf8",
    );
    const { exitCode } = runGuard();
    expect(exitCode).toBe(0);
  });

  it("does NOT match a delete call at column 0 (documented boundary limitation, real sites are always prefixed)", () => {
    seedWrapperStubs();
    // No leading `tx.`/`prisma.`/`await ` — a bare receiver at line-start.
    // This is a known limitation shared with the grep-based deleteSignal
    // regex; production sites are always prefixed, so this is not a
    // realistic evasion path, only a documented boundary case.
    writeSource(
      "src/lib/services/edge-case-service.ts",
      `passwordEntry.deleteMany({ where: { userId } });\n`,
    );
    const { exitCode } = runGuard();
    expect(exitCode).toBe(0);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Object/class-method wrappers (external review Major): a destructive
  // primitive reached through a DIRECTLY-EXPORTED object literal or class must
  // be caught under a qualified `Receiver.method` key — not silently skipped as
  // it was when only top-level exported functions/const-arrows were recognized.
  // The auth-adapter shape above (object as a function RETURN value) still
  // resolves to its enclosing exported function, so those two cases don't clash.
  // ─────────────────────────────────────────────────────────────────────────
  it("catches a destructive method on a directly-exported object literal (qualified key)", () => {
    seedWrapperStubs();
    writeSource(
      "src/lib/vault-service.ts",
      [
        "export const vaultService = {",
        "  async purgeUserEntries(userId) {",
        "    await tx.passwordEntry.deleteMany({ where: { userId } });",
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    const { exitCode, stderr } = runGuard();
    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      "UNDECLARED_DESTRUCTIVE_WRAPPER: src/lib/vault-service.ts#vaultService.purgeUserEntries",
    );
  });

  it("catches a destructive method on a directly-exported class (qualified key)", () => {
    seedWrapperStubs();
    writeSource(
      "src/lib/vault-service-class.ts",
      [
        "export class VaultService {",
        "  async purgeUserEntries(userId) {",
        "    await tx.passwordEntry.deleteMany({ where: { userId } });",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const { exitCode, stderr } = runGuard();
    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      "UNDECLARED_DESTRUCTIVE_WRAPPER: src/lib/vault-service-class.ts#VaultService.purgeUserEntries",
    );
  });

  it("catches an exported object property whose value is an arrow function", () => {
    seedWrapperStubs();
    writeSource(
      "src/lib/account-service.ts",
      [
        "export const accountService = {",
        "  deleteAccount: async (userId) => {",
        "    await tx.user.delete({ where: { id: userId } });",
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    const { exitCode, stderr } = runGuard();
    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      "UNDECLARED_DESTRUCTIVE_WRAPPER: src/lib/account-service.ts#accountService.deleteAccount",
    );
  });

  it("catches an anonymous default export via a file-scoped #default sentinel (cannot silently escape)", () => {
    seedWrapperStubs();
    writeSource(
      "src/lib/purge-default.ts",
      [
        "export default async function () {",
        "  await tx.user.delete({ where: {} });",
        "}",
        "",
      ].join("\n"),
    );
    const { exitCode, stderr } = runGuard();
    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      "UNDECLARED_DESTRUCTIVE_WRAPPER: src/lib/purge-default.ts#default",
    );
  });

  it("a qualified deleteSignal alternative (Receiver.method) declares an object-method wrapper", () => {
    seedWrapperStubs();
    // Register the qualified wrapper in the fixture deleteSignal so a route
    // calling `vaultService.purgeUserEntries(` classifies as destructive.
    writeFileSync(
      patternsFile,
      JSON.stringify({
        deleteSignal: `${FIXTURE_DELETE_SIGNAL}|vaultService\\.purgeUserEntries\\(`,
      }),
      "utf8",
    );
    writeSource(
      "src/lib/vault-service.ts",
      [
        "export const vaultService = {",
        "  async purgeUserEntries(userId) {",
        "    await tx.passwordEntry.deleteMany({ where: { userId } });",
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    const { exitCode } = runGuard();
    expect(exitCode).toBe(0);
  });

  it("FAILS (STALE_DELETE_SIGNAL_NAME) when a qualified deleteSignal wrapper resolves to nothing", () => {
    seedWrapperStubs();
    writeFileSync(
      patternsFile,
      JSON.stringify({
        deleteSignal: `${FIXTURE_DELETE_SIGNAL}|goneService\\.wipe\\(`,
      }),
      "utf8",
    );
    const { exitCode, stderr } = runGuard();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("STALE_DELETE_SIGNAL_NAME: goneService.wipe");
  });

  describe("env-pollution guard (sec-F6)", () => {
    it("FAILS when CI=true and an override is set without DESTRUCTIVE_WRAPPER_FIXTURE_MODE=1", () => {
      const { exitCode, stderr } = runGuard({ CI: "true" });
      expect(exitCode).toBe(1);
      expect(stderr).toContain("ENV_POLLUTION_GUARD");
    });

    it("passes under CI=true when DESTRUCTIVE_WRAPPER_FIXTURE_MODE=1 is set and the fixture tree is fully covered", () => {
      seedWrapperStubs();
      const { exitCode } = runGuard({ CI: "true", DESTRUCTIVE_WRAPPER_FIXTURE_MODE: "1" });
      expect(exitCode).toBe(0);
    });
  });

  describe("real repo (no overrides — proves the seeded exempt file is complete)", () => {
    it("passes against the actual repo source tree", () => {
      const r = spawnSync("node", [GUARD], { encoding: "utf8" });
      expect(r.status, r.stdout + r.stderr).toBe(0);
    });
  });
});
