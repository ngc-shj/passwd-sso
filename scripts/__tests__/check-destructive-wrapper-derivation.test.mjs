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
let stepupExemptFile;

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
      // Point the route pass at the fixture tree's api dir + an isolated
      // stepup-exempt, so it never scans the real src/app/api during a fixture
      // run. Routes live at <scanRoot>/app/api/**/route.ts.
      STEPUP_GUARD_API_DIR: join(scanRoot, "app", "api"),
      STEPUP_GUARD_EXEMPT_FILE: stepupExemptFile,
      // Fixture-mode default so the env-pollution guard does not fire under
      // CI=true; the pollution-guard test overrides it back to "".
      DESTRUCTIVE_WRAPPER_FIXTURE_MODE: "1",
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
  stepupExemptFile = join(root, "stepup-exempt.txt");
  mkdirSync(scanRoot, { recursive: true });
  writeFileSync(exemptFile, "# fixture exempt list\n", "utf8");
  writeFileSync(stepupExemptFile, "# fixture stepup exempt list\n", "utf8");
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

  it("does NOT treat route.ts as a WRAPPER-DEFINITION site (no UNDECLARED for a raw delete in a route)", () => {
    seedWrapperStubs();
    // A raw delete directly in a route is the route classifier's concern, not a
    // wrapper definition — so it must not emit UNDECLARED_DESTRUCTIVE_WRAPPER.
    // (It DOES trip the route pass unless step-up is present; step-up here keeps
    // this test focused on the wrapper-derivation scope.)
    writeSource(
      "src/app/api/passwords/bulk-purge/route.ts",
      [
        "import { requireRecentCurrentAuthMethod } from '@/lib/auth/session/recent-current-auth-method';",
        "export async function POST() {",
        "  await requireRecentCurrentAuthMethod();",
        "  await tx.passwordEntry.deleteMany({ where: { userId } });",
        "}",
        "",
      ].join("\n"),
    );
    const { exitCode, stderr } = runGuard();
    expect(exitCode).toBe(0);
    expect(stderr).not.toContain("UNDECLARED_DESTRUCTIVE_WRAPPER");
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

  it("flags a destructive INSTANCE method as NON_GREP_MATCHABLE (route calls instance.method, not Class.method)", () => {
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
      "NON_GREP_MATCHABLE_DESTRUCTIVE_WRAPPER: src/lib/vault-service-class.ts#VaultService.purgeUserEntries",
    );
  });

  it("false-green guard: registering an INSTANCE method's Class.method key in deleteSignal does NOT satisfy the check", () => {
    seedWrapperStubs();
    // The exact evasion the external review flagged: derive VaultService.purge,
    // add `VaultService\.purge\(` to deleteSignal, but the route calls
    // `svc.purge(` — the grep never matches. The check must still fail
    // NON_GREP_MATCHABLE rather than silently accept the registration.
    writeFileSync(
      patternsFile,
      JSON.stringify({ deleteSignal: `${FIXTURE_DELETE_SIGNAL}|VaultService\\.purge\\(` }),
      "utf8",
    );
    writeSource(
      "src/lib/vault-service-class.ts",
      [
        "export class VaultService {",
        "  async purge(userId) {",
        "    await tx.passwordEntry.deleteMany({ where: { userId } });",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const { exitCode, stderr } = runGuard();
    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      "NON_GREP_MATCHABLE_DESTRUCTIVE_WRAPPER: src/lib/vault-service-class.ts#VaultService.purge",
    );
  });

  it("accepts a STATIC class method registered via deleteSignal (route calls Class.method — grep-matchable)", () => {
    seedWrapperStubs();
    writeFileSync(
      patternsFile,
      JSON.stringify({ deleteSignal: `${FIXTURE_DELETE_SIGNAL}|VaultService\\.purgeAll\\(` }),
      "utf8",
    );
    writeSource(
      "src/lib/vault-service-static.ts",
      [
        "export class VaultService {",
        "  static async purgeAll(userId) {",
        "    await tx.passwordEntry.deleteMany({ where: { userId } });",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    const { exitCode } = runGuard();
    expect(exitCode).toBe(0);
  });

  it("a NON_GREP_MATCHABLE instance method can still be resolved via an explicit exemption", () => {
    seedWrapperStubs();
    writeSource(
      "src/lib/vault-service-class.ts",
      [
        "export class VaultService {",
        "  async purge(userId) {",
        "    await tx.passwordEntry.deleteMany({ where: { userId } });",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      exemptFile,
      "src/lib/vault-service-class.ts#VaultService.purge  # test fixture: not route-reachable in this scenario\n",
      "utf8",
    );
    const { exitCode } = runGuard();
    expect(exitCode).toBe(0);
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

  it("flags an anonymous default export as NON_GREP_MATCHABLE (default import renames freely; deleteSignal cannot match)", () => {
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
      "NON_GREP_MATCHABLE_DESTRUCTIVE_WRAPPER: src/lib/purge-default.ts#default",
    );
  });

  it("flags a NAMED default export as NON_GREP_MATCHABLE (default import renames freely, same as anonymous)", () => {
    seedWrapperStubs();
    writeSource(
      "src/lib/purge-named-default.ts",
      [
        "export default async function purgeEverything(userId) {",
        "  await tx.passwordEntry.deleteMany({ where: { userId } });",
        "}",
        "",
      ].join("\n"),
    );
    const { exitCode, stderr } = runGuard();
    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      "NON_GREP_MATCHABLE_DESTRUCTIVE_WRAPPER: src/lib/purge-named-default.ts#purgeEverything",
    );
  });

  it("false-green guard: registering a NAMED default export's declared name in deleteSignal does NOT satisfy it", () => {
    // The exact bug external review round 3 flagged: `export default async
    // function purgeEverything()` was misclassified grepMatchable=true because
    // the named-function branch ran before the default-export branch, so adding
    // `purgeEverything\(` to deleteSignal false-greened it — but the route does
    // `import wipeVault from ...; wipeVault(`, which the grep never matches.
    seedWrapperStubs();
    writeFileSync(
      patternsFile,
      JSON.stringify({ deleteSignal: `${FIXTURE_DELETE_SIGNAL}|purgeEverything\\(` }),
      "utf8",
    );
    writeSource(
      "src/lib/purge-named-default.ts",
      [
        "export default async function purgeEverything(userId) {",
        "  await tx.passwordEntry.deleteMany({ where: { userId } });",
        "}",
        "",
      ].join("\n"),
    );
    const { exitCode, stderr } = runGuard();
    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      "NON_GREP_MATCHABLE_DESTRUCTIVE_WRAPPER: src/lib/purge-named-default.ts#purgeEverything",
    );
  });

  it("false-green guard: registering `default(` in deleteSignal does NOT satisfy an anonymous default wrapper", () => {
    seedWrapperStubs();
    writeFileSync(
      patternsFile,
      JSON.stringify({ deleteSignal: `${FIXTURE_DELETE_SIGNAL}|default\\(` }),
      "utf8",
    );
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
      "NON_GREP_MATCHABLE_DESTRUCTIVE_WRAPPER: src/lib/purge-default.ts#default",
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

  // ─────────────────────────────────────────────────────────────────────────
  // Route pass (AST alias-close): the flat-text deleteSignal grep in
  // check-permanent-delete-stepup.sh misses an ALIASED import of a destructive
  // wrapper. This pass resolves local imports (incl. aliases) and requires
  // step-up on any route reaching a destructive primitive/wrapper.
  // ─────────────────────────────────────────────────────────────────────────
  it("ROUTE_DESTRUCTIVE_NO_STEPUP: an ALIASED wrapper import without step-up is caught (grep would miss it)", () => {
    seedWrapperStubs();
    writeSource(
      "src/lib/reset-svc.ts",
      "export async function executeVaultResetAlt(userId) {\n  await tx.passwordEntry.deleteMany({ where: { userId } });\n}\n",
    );
    // Register the wrapper so the derivation pass is satisfied; the route
    // aliases it, which the deleteSignal grep cannot follow.
    writeFileSync(
      patternsFile,
      JSON.stringify({ deleteSignal: `${FIXTURE_DELETE_SIGNAL}|executeVaultResetAlt\\(` }),
      "utf8",
    );
    writeSource(
      "src/app/api/danger/route.ts",
      [
        "import { executeVaultResetAlt as reset } from '@/lib/reset-svc';",
        "export async function POST() {",
        "  await reset('u1');",
        "  return new Response('ok');",
        "}",
        "",
      ].join("\n"),
    );
    const { exitCode, stderr } = runGuard();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("ROUTE_DESTRUCTIVE_NO_STEPUP: src/app/api/danger/route.ts");
    expect(stderr).toContain("src/lib/reset-svc.ts#executeVaultResetAlt");
  });

  it("passes when the aliased-wrapper route calls requireRecentCurrentAuthMethod", () => {
    seedWrapperStubs();
    writeSource(
      "src/lib/reset-svc.ts",
      "export async function executeVaultResetAlt(userId) {\n  await tx.passwordEntry.deleteMany({ where: { userId } });\n}\n",
    );
    writeFileSync(
      patternsFile,
      JSON.stringify({ deleteSignal: `${FIXTURE_DELETE_SIGNAL}|executeVaultResetAlt\\(` }),
      "utf8",
    );
    writeSource(
      "src/app/api/danger/route.ts",
      [
        "import { executeVaultResetAlt as reset } from '@/lib/reset-svc';",
        "import { requireRecentCurrentAuthMethod } from '@/lib/auth/session/recent-current-auth-method';",
        "export async function POST() {",
        "  await requireRecentCurrentAuthMethod();",
        "  await reset('u1');",
        "  return new Response('ok');",
        "}",
        "",
      ].join("\n"),
    );
    const { exitCode } = runGuard();
    expect(exitCode).toBe(0);
  });

  it("passes when the aliased-wrapper route is listed in stepup-delete-exempt.txt", () => {
    seedWrapperStubs();
    writeSource(
      "src/lib/reset-svc.ts",
      "export async function executeVaultResetAlt(userId) {\n  await tx.passwordEntry.deleteMany({ where: { userId } });\n}\n",
    );
    writeFileSync(
      patternsFile,
      JSON.stringify({ deleteSignal: `${FIXTURE_DELETE_SIGNAL}|executeVaultResetAlt\\(` }),
      "utf8",
    );
    writeSource(
      "src/app/api/danger/route.ts",
      [
        "import { executeVaultResetAlt as reset } from '@/lib/reset-svc';",
        "export async function POST() {",
        "  await reset('u1');",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      stepupExemptFile,
      "src/app/api/danger/route.ts  # test fixture: stronger ceremony applies\n",
      "utf8",
    );
    const { exitCode } = runGuard();
    expect(exitCode).toBe(0);
  });

  it("ROUTE_DESTRUCTIVE_NO_STEPUP: a raw delete primitive directly in a route without step-up is caught", () => {
    seedWrapperStubs();
    writeSource(
      "src/app/api/wipe/route.ts",
      [
        "export async function POST() {",
        "  await tx.passwordEntry.deleteMany({ where: { userId } });",
        "}",
        "",
      ].join("\n"),
    );
    const { exitCode, stderr } = runGuard();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("ROUTE_DESTRUCTIVE_NO_STEPUP: src/app/api/wipe/route.ts");
  });

  it("a NAMESPACE import (`import * as ns`) reaching a wrapper without step-up is caught (real-repo shape)", () => {
    // The real team-password route uses `import * as teamPasswordService` then
    // `teamPasswordService.deleteTeamPassword(` — resolve it so the pass has no
    // false-negative on the exact shape production uses.
    seedWrapperStubs();
    writeSource(
      "src/lib/svc.ts",
      "export async function wipeIt(userId) {\n  await tx.passwordEntry.deleteMany({ where: { userId } });\n}\n",
    );
    writeFileSync(
      patternsFile,
      JSON.stringify({ deleteSignal: `${FIXTURE_DELETE_SIGNAL}|wipeIt\\(` }),
      "utf8",
    );
    writeSource(
      "src/app/api/ns-danger/route.ts",
      [
        "import * as svc from '@/lib/svc';",
        "export async function POST() {",
        "  await svc.wipeIt('u1');",
        "}",
        "",
      ].join("\n"),
    );
    const { exitCode, stderr } = runGuard();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("ROUTE_DESTRUCTIVE_NO_STEPUP: src/app/api/ns-danger/route.ts");
    expect(stderr).toContain("namespace svc.wipeIt()");
  });

  it("a TWO-LEVEL namespace member call (ns.obj.method) reaching a static/object wrapper without step-up is caught", () => {
    // ns.vaultService.purgeUserEntries() — the outer namespace, the object
    // export, and the method must all resolve. Defense-hardening for a form the
    // one-level namespace pass would otherwise miss.
    seedWrapperStubs();
    writeSource(
      "src/lib/vault-ns.ts",
      [
        "export const vaultService = {",
        "  async purgeUserEntries(userId) {",
        "    await tx.passwordEntry.deleteMany({ where: { userId } });",
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    writeFileSync(
      patternsFile,
      JSON.stringify({ deleteSignal: `${FIXTURE_DELETE_SIGNAL}|vaultService\\.purgeUserEntries\\(` }),
      "utf8",
    );
    writeSource(
      "src/app/api/ns2/route.ts",
      [
        "import * as ns from '@/lib/vault-ns';",
        "export async function POST() {",
        "  await ns.vaultService.purgeUserEntries('u1');",
        "}",
        "",
      ].join("\n"),
    );
    const { exitCode, stderr } = runGuard();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("ROUTE_DESTRUCTIVE_NO_STEPUP: src/app/api/ns2/route.ts");
    expect(stderr).toContain("namespace ns.vaultService.purgeUserEntries()");
  });

  it("an ALIASED object-wrapper method call without step-up is caught", () => {
    seedWrapperStubs();
    writeSource(
      "src/lib/vault-svc.ts",
      [
        "export const vaultService = {",
        "  async purgeUserEntries(userId) {",
        "    await tx.passwordEntry.deleteMany({ where: { userId } });",
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    writeFileSync(
      patternsFile,
      JSON.stringify({ deleteSignal: `${FIXTURE_DELETE_SIGNAL}|vaultService\\.purgeUserEntries\\(` }),
      "utf8",
    );
    writeSource(
      "src/app/api/danger2/route.ts",
      [
        "import { vaultService as vault } from '@/lib/vault-svc';",
        "export async function POST() {",
        "  await vault.purgeUserEntries('u1');",
        "}",
        "",
      ].join("\n"),
    );
    const { exitCode, stderr } = runGuard();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("ROUTE_DESTRUCTIVE_NO_STEPUP: src/app/api/danger2/route.ts");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Re-export pass (C2): the residual limitation this file used to document
  // ("re-export chains evade") is now mechanically rejected. Each red fixture
  // is isolated to REEXPORTED_DESTRUCTIVE_WRAPPER only (no
  // ROUTE_DESTRUCTIVE_NO_STEPUP / UNDECLARED_DESTRUCTIVE_WRAPPER
  // contamination) — seedWrapperStubs() keeps STALE_DELETE_SIGNAL_NAME quiet,
  // and the barrel fixtures below stand alone (no route imports them), so the
  // route pass and the wrapper-derivation loop have nothing to say.
  // ─────────────────────────────────────────────────────────────────────────
  describe("re-export pass (C2)", () => {
    it("FAILS (REEXPORTED_DESTRUCTIVE_WRAPPER) for a named re-export of a destructive wrapper", () => {
      seedWrapperStubs();
      writeSource(
        "src/lib/vault/vault-reset.ts",
        "export async function executeVaultReset(userId) {\n  await tx.passwordEntry.deleteMany({ where: { userId } });\n}\n",
      );
      writeSource(
        "src/lib/vault/reexport-barrel.ts",
        'export { executeVaultReset } from "./vault-reset";\n',
      );
      const { exitCode, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stderr).toContain("REEXPORTED_DESTRUCTIVE_WRAPPER");
      expect(stderr).toContain(
        "src/lib/vault/reexport-barrel.ts re-exports executeVaultReset from ./vault-reset",
      );
      expect(stderr).not.toContain("ROUTE_DESTRUCTIVE_NO_STEPUP");
      expect(stderr).not.toContain("UNDECLARED_DESTRUCTIVE_WRAPPER");
    });

    it("FAILS (REEXPORTED_DESTRUCTIVE_WRAPPER) for an ALIASED named re-export of a destructive wrapper", () => {
      seedWrapperStubs();
      writeSource(
        "src/lib/vault/vault-reset.ts",
        "export async function executeVaultReset(userId) {\n  await tx.passwordEntry.deleteMany({ where: { userId } });\n}\n",
      );
      writeSource(
        "src/lib/vault/reexport-barrel-alias.ts",
        'export { executeVaultReset as resetVault } from "./vault-reset";\n',
      );
      const { exitCode, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stderr).toContain("REEXPORTED_DESTRUCTIVE_WRAPPER");
      expect(stderr).toContain(
        "src/lib/vault/reexport-barrel-alias.ts re-exports executeVaultReset from ./vault-reset",
      );
      expect(stderr).not.toContain("ROUTE_DESTRUCTIVE_NO_STEPUP");
      expect(stderr).not.toContain("UNDECLARED_DESTRUCTIVE_WRAPPER");
    });

    it("FAILS (REEXPORTED_DESTRUCTIVE_WRAPPER) for `export * from` (2-hop)", () => {
      seedWrapperStubs();
      writeSource(
        "src/lib/vault/vault-reset.ts",
        "export async function executeVaultReset(userId) {\n  await tx.passwordEntry.deleteMany({ where: { userId } });\n}\n",
      );
      writeSource("src/lib/vault/barrel-star.ts", 'export * from "./vault-reset";\n');
      const { exitCode, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stderr).toContain("REEXPORTED_DESTRUCTIVE_WRAPPER");
      expect(stderr).toContain(
        "src/lib/vault/barrel-star.ts re-exports executeVaultReset from ./vault-reset",
      );
      expect(stderr).not.toContain("ROUTE_DESTRUCTIVE_NO_STEPUP");
      expect(stderr).not.toContain("UNDECLARED_DESTRUCTIVE_WRAPPER");
    });

    it("FAILS (REEXPORTED_DESTRUCTIVE_WRAPPER) for a 3-hop `export * from` chain A->B->C (transitive closure)", () => {
      seedWrapperStubs();
      writeSource(
        "src/lib/vault/vault-reset-c.ts",
        "export async function executeVaultReset(userId) {\n  await tx.passwordEntry.deleteMany({ where: { userId } });\n}\n",
      );
      writeSource("src/lib/vault/barrel-b.ts", 'export * from "./vault-reset-c";\n');
      writeSource("src/lib/vault/barrel-a.ts", 'export * from "./barrel-b";\n');
      const { exitCode, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stderr).toContain("REEXPORTED_DESTRUCTIVE_WRAPPER");
      // Every hop must be flagged, not just the direct one.
      expect(stderr).toContain(
        "src/lib/vault/barrel-b.ts re-exports executeVaultReset from ./vault-reset-c",
      );
      expect(stderr).toContain(
        "src/lib/vault/barrel-a.ts re-exports executeVaultReset from ./barrel-b",
      );
      expect(stderr).not.toContain("ROUTE_DESTRUCTIVE_NO_STEPUP");
      expect(stderr).not.toContain("UNDECLARED_DESTRUCTIVE_WRAPPER");
    });

    it("FAILS (REEXPORTED_DESTRUCTIVE_WRAPPER) when the barrel sorts BEFORE its target in scan order (ordering-adversarial)", () => {
      seedWrapperStubs();
      // "aaa-barrel.ts" sorts before "vault-reset.ts" alphabetically — the
      // fixpoint loop, not scan order, must still catch this.
      writeSource(
        "src/lib/vault/aaa-barrel.ts",
        'export { executeVaultReset } from "./vault-reset";\n',
      );
      writeSource(
        "src/lib/vault/vault-reset.ts",
        "export async function executeVaultReset(userId) {\n  await tx.passwordEntry.deleteMany({ where: { userId } });\n}\n",
      );
      const { exitCode, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stderr).toContain("REEXPORTED_DESTRUCTIVE_WRAPPER");
      expect(stderr).toContain(
        "src/lib/vault/aaa-barrel.ts re-exports executeVaultReset from ./vault-reset",
      );
      expect(stderr).not.toContain("ROUTE_DESTRUCTIVE_NO_STEPUP");
      expect(stderr).not.toContain("UNDECLARED_DESTRUCTIVE_WRAPPER");
    });

    it("FAILS (REEXPORTED_DESTRUCTIVE_WRAPPER) for `export * as ns from`", () => {
      seedWrapperStubs();
      writeSource(
        "src/lib/vault/vault-reset.ts",
        "export async function executeVaultReset(userId) {\n  await tx.passwordEntry.deleteMany({ where: { userId } });\n}\n",
      );
      writeSource(
        "src/lib/vault/barrel-ns.ts",
        'export * as vaultReset from "./vault-reset";\n',
      );
      const { exitCode, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stderr).toContain("REEXPORTED_DESTRUCTIVE_WRAPPER");
      expect(stderr).toContain(
        "src/lib/vault/barrel-ns.ts re-exports executeVaultReset from ./vault-reset",
      );
      expect(stderr).not.toContain("ROUTE_DESTRUCTIVE_NO_STEPUP");
      expect(stderr).not.toContain("UNDECLARED_DESTRUCTIVE_WRAPPER");
    });

    it("FAILS (REEXPORTED_DESTRUCTIVE_WRAPPER) for a re-export hosted inside a route.ts file", () => {
      seedWrapperStubs();
      writeSource(
        "src/lib/vault/vault-reset.ts",
        "export async function executeVaultReset(userId) {\n  await tx.passwordEntry.deleteMany({ where: { userId } });\n}\n",
      );
      // A route.ts acting as a re-export SOURCE for some other file — invisible
      // to the route pass's import-walk (which only resolves @/-aliased
      // imports into wrapper modules, not a route file as a barrel).
      writeSource(
        "src/app/api/internal/route.ts",
        [
          'export { executeVaultReset } from "@/lib/vault/vault-reset";',
          "export async function GET() {",
          "  return new Response('ok');",
          "}",
          "",
        ].join("\n"),
      );
      const { exitCode, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stderr).toContain("REEXPORTED_DESTRUCTIVE_WRAPPER");
      expect(stderr).toContain(
        "src/app/api/internal/route.ts re-exports executeVaultReset from @/lib/vault/vault-reset",
      );
      expect(stderr).not.toContain("ROUTE_DESTRUCTIVE_NO_STEPUP");
      expect(stderr).not.toContain("UNDECLARED_DESTRUCTIVE_WRAPPER");
    });

    it("FAILS (REEXPORTED_DESTRUCTIVE_WRAPPER) for a 2-hop NAMED chain with a distinct alias at each hop (post-alias name registration)", () => {
      seedWrapperStubs();
      // C defines the wrapper; B re-exports it under alias `x`; A re-exports
      // B's `x` under alias `y`. The fixpoint step must register B -> x (its
      // OWN locally-visible name), not B -> executeVaultReset, so A's lookup
      // of the source-side name `x` against B's registered exports succeeds.
      writeSource(
        "src/lib/vault/vault-reset-chain-c.ts",
        "export async function executeVaultReset(userId) {\n  await tx.passwordEntry.deleteMany({ where: { userId } });\n}\n",
      );
      writeSource(
        "src/lib/vault/chain-b.ts",
        'export { executeVaultReset as x } from "./vault-reset-chain-c";\n',
      );
      writeSource("src/lib/vault/chain-a.ts", 'export { x as y } from "./chain-b";\n');
      const { exitCode, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stderr).toContain("REEXPORTED_DESTRUCTIVE_WRAPPER");
      expect(stderr).toContain(
        "src/lib/vault/chain-b.ts re-exports executeVaultReset from ./vault-reset-chain-c",
      );
      expect(stderr).toContain("src/lib/vault/chain-a.ts re-exports x from ./chain-b");
      expect(stderr).not.toContain("ROUTE_DESTRUCTIVE_NO_STEPUP");
      expect(stderr).not.toContain("UNDECLARED_DESTRUCTIVE_WRAPPER");
    });

    it("passes (no REEXPORTED_DESTRUCTIVE_WRAPPER) for an innocuous non-destructive re-export", () => {
      seedWrapperStubs();
      writeSource(
        "src/lib/vault/helpers.ts",
        "export function formatVaultLabel(name) {\n  return name.trim();\n}\n",
      );
      writeSource(
        "src/lib/vault/reexport-innocuous.ts",
        'export { formatVaultLabel } from "./helpers";\n',
      );
      const { exitCode, stderr } = runGuard();
      expect(exitCode).toBe(0);
      expect(stderr).not.toContain("REEXPORTED_DESTRUCTIVE_WRAPPER");
    });

    it("passes (no REEXPORTED_DESTRUCTIVE_WRAPPER) for a TYPE-ONLY re-export of a destructive wrapper name", () => {
      seedWrapperStubs();
      writeSource(
        "src/lib/vault/vault-reset.ts",
        "export async function executeVaultReset(userId) {\n  await tx.passwordEntry.deleteMany({ where: { userId } });\n}\n",
      );
      writeSource(
        "src/lib/vault/reexport-type-only.ts",
        'export type { executeVaultReset } from "./vault-reset";\n',
      );
      const { exitCode, stderr } = runGuard();
      expect(exitCode).toBe(0);
      expect(stderr).not.toContain("REEXPORTED_DESTRUCTIVE_WRAPPER");
    });

    it("passes (no REEXPORTED_DESTRUCTIVE_WRAPPER) for a same-named but unrelated symbol re-exported from a RESOLVED in-scope module", () => {
      seedWrapperStubs();
      writeSource(
        "src/lib/vault/vault-reset.ts",
        "export async function executeVaultReset(userId) {\n  await tx.passwordEntry.deleteMany({ where: { userId } });\n}\n",
      );
      // Unrelated module whose innocuous export coincidentally shares the
      // destructive wrapper's name — must NOT flag when the specifier
      // resolves cleanly to this in-scope file (its own export set decides).
      writeSource(
        "src/lib/labels/label-formatter.ts",
        "export function executeVaultReset(label) {\n  return label.trim();\n}\n",
      );
      writeSource(
        "src/lib/labels/reexport-collision.ts",
        'export { executeVaultReset } from "./label-formatter";\n',
      );
      const { exitCode, stderr } = runGuard();
      expect(exitCode).toBe(0);
      expect(stderr).not.toContain("REEXPORTED_DESTRUCTIVE_WRAPPER");
    });

    it("FAILS (REEXPORTED_DESTRUCTIVE_WRAPPER) for a destructive-named re-export whose specifier does NOT resolve in-scope (flat-fallback fail-closed)", () => {
      seedWrapperStubs();
      writeSource(
        "src/lib/vault/vault-reset.ts",
        "export async function executeVaultReset(userId) {\n  await tx.passwordEntry.deleteMany({ where: { userId } });\n}\n",
      );
      // Target lives outside the .ts scan scope (e.g. .tsx / generated) so
      // resolution fails — the flat cross-module name set must fail closed.
      writeSource(
        "src/lib/vault/reexport-unresolved.ts",
        'export { executeVaultReset } from "./generated/not-in-scan";\n',
      );
      const { exitCode, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stderr).toContain("REEXPORTED_DESTRUCTIVE_WRAPPER");
      expect(stderr).toContain(
        "src/lib/vault/reexport-unresolved.ts re-exports executeVaultReset from ./generated/not-in-scan",
      );
      expect(stderr).not.toContain("ROUTE_DESTRUCTIVE_NO_STEPUP");
      expect(stderr).not.toContain("UNDECLARED_DESTRUCTIVE_WRAPPER");
    });

    it("FAILS (REEXPORTED_DESTRUCTIVE_WRAPPER) for `export * from` via the @/ path alias", () => {
      seedWrapperStubs();
      writeSource(
        "src/lib/vault/vault-reset.ts",
        "export async function executeVaultReset(userId) {\n  await tx.passwordEntry.deleteMany({ where: { userId } });\n}\n",
      );
      writeSource(
        "src/lib/reexport-alias-star.ts",
        'export * from "@/lib/vault/vault-reset";\n',
      );
      const { exitCode, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stderr).toContain("REEXPORTED_DESTRUCTIVE_WRAPPER");
      expect(stderr).toContain(
        "src/lib/reexport-alias-star.ts re-exports executeVaultReset from @/lib/vault/vault-reset",
      );
      expect(stderr).not.toContain("ROUTE_DESTRUCTIVE_NO_STEPUP");
      expect(stderr).not.toContain("UNDECLARED_DESTRUCTIVE_WRAPPER");
    });

    it("FAILS (REEXPORTED_DESTRUCTIVE_WRAPPER) for `export * as ns from` via the @/ path alias", () => {
      seedWrapperStubs();
      writeSource(
        "src/lib/vault/vault-reset.ts",
        "export async function executeVaultReset(userId) {\n  await tx.passwordEntry.deleteMany({ where: { userId } });\n}\n",
      );
      writeSource(
        "src/lib/reexport-alias-ns.ts",
        'export * as vaultReset from "@/lib/vault/vault-reset";\n',
      );
      const { exitCode, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stderr).toContain("REEXPORTED_DESTRUCTIVE_WRAPPER");
      expect(stderr).toContain(
        "src/lib/reexport-alias-ns.ts re-exports executeVaultReset from @/lib/vault/vault-reset",
      );
      expect(stderr).not.toContain("ROUTE_DESTRUCTIVE_NO_STEPUP");
      expect(stderr).not.toContain("UNDECLARED_DESTRUCTIVE_WRAPPER");
    });

    it("FAILS (REEXPORTED_DESTRUCTIVE_WRAPPER) for a directory-index barrel (`export * from \"./dir\"` resolving dir/index.ts)", () => {
      seedWrapperStubs();
      writeSource(
        "src/lib/vault-reset-dir/index.ts",
        "export async function executeVaultReset(userId) {\n  await tx.passwordEntry.deleteMany({ where: { userId } });\n}\n",
      );
      writeSource(
        "src/lib/reexport-dir-barrel.ts",
        'export * from "./vault-reset-dir";\n',
      );
      const { exitCode, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stderr).toContain("REEXPORTED_DESTRUCTIVE_WRAPPER");
      expect(stderr).toContain(
        "src/lib/reexport-dir-barrel.ts re-exports executeVaultReset from ./vault-reset-dir",
      );
      expect(stderr).not.toContain("ROUTE_DESTRUCTIVE_NO_STEPUP");
      expect(stderr).not.toContain("UNDECLARED_DESTRUCTIVE_WRAPPER");
    });

    it("FAILS (REEXPORTED_DESTRUCTIVE_WRAPPER) for a named re-export of an exported OBJECT binding carrying a destructive member", () => {
      seedWrapperStubs();
      writeFileSync(
        patternsFile,
        JSON.stringify({ deleteSignal: `${FIXTURE_DELETE_SIGNAL}|vaultService\\.purgeUserEntries\\(` }),
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
      writeSource(
        "src/lib/reexport-object-binding.ts",
        'export { vaultService } from "./vault-service";\n',
      );
      const { exitCode, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stderr).toContain("REEXPORTED_DESTRUCTIVE_WRAPPER");
      expect(stderr).toContain(
        "src/lib/reexport-object-binding.ts re-exports vaultService.purgeUserEntries from ./vault-service",
      );
      expect(stderr).not.toContain("ROUTE_DESTRUCTIVE_NO_STEPUP");
      expect(stderr).not.toContain("UNDECLARED_DESTRUCTIVE_WRAPPER");
    });

    it("FAILS (REEXPORTED_DESTRUCTIVE_WRAPPER) for a 2-hop ALIASED object-binding chain, propagating the member under each hop's local name", () => {
      seedWrapperStubs();
      writeFileSync(
        patternsFile,
        JSON.stringify({ deleteSignal: `${FIXTURE_DELETE_SIGNAL}|vaultService\\.purgeUserEntries\\(` }),
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
      writeSource(
        "src/lib/obj-chain-b.ts",
        'export { vaultService as service } from "./vault-service";\n',
      );
      writeSource(
        "src/lib/obj-chain-a.ts",
        'export { service as apiService } from "./obj-chain-b";\n',
      );
      const { exitCode, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stderr).toContain("REEXPORTED_DESTRUCTIVE_WRAPPER");
      expect(stderr).toContain(
        "src/lib/obj-chain-b.ts re-exports vaultService.purgeUserEntries from ./vault-service",
      );
      expect(stderr).toContain(
        "src/lib/obj-chain-a.ts re-exports service.purgeUserEntries from ./obj-chain-b",
      );
      expect(stderr).not.toContain("ROUTE_DESTRUCTIVE_NO_STEPUP");
      expect(stderr).not.toContain("UNDECLARED_DESTRUCTIVE_WRAPPER");
    });

    it("FAILS (REEXPORTED_DESTRUCTIVE_WRAPPER) for a named re-export of a STATIC-class binding carrying a destructive member", () => {
      seedWrapperStubs();
      writeFileSync(
        patternsFile,
        JSON.stringify({ deleteSignal: `${FIXTURE_DELETE_SIGNAL}|VaultService\\.purgeAll\\(` }),
        "utf8",
      );
      writeSource(
        "src/lib/vault-service-static.ts",
        [
          "export class VaultService {",
          "  static async purgeAll(userId) {",
          "    await tx.passwordEntry.deleteMany({ where: { userId } });",
          "  }",
          "}",
          "",
        ].join("\n"),
      );
      writeSource(
        "src/lib/reexport-class-binding.ts",
        'export { VaultService } from "./vault-service-static";\n',
      );
      const { exitCode, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stderr).toContain("REEXPORTED_DESTRUCTIVE_WRAPPER");
      expect(stderr).toContain(
        "src/lib/reexport-class-binding.ts re-exports VaultService.purgeAll from ./vault-service-static",
      );
      expect(stderr).not.toContain("ROUTE_DESTRUCTIVE_NO_STEPUP");
      expect(stderr).not.toContain("UNDECLARED_DESTRUCTIVE_WRAPPER");
    });

    it("FAILS (REEXPORTED_DESTRUCTIVE_WRAPPER) for an ALIASED static-class binding re-export", () => {
      seedWrapperStubs();
      writeFileSync(
        patternsFile,
        JSON.stringify({ deleteSignal: `${FIXTURE_DELETE_SIGNAL}|VaultService\\.purgeAll\\(` }),
        "utf8",
      );
      writeSource(
        "src/lib/vault-service-static.ts",
        [
          "export class VaultService {",
          "  static async purgeAll(userId) {",
          "    await tx.passwordEntry.deleteMany({ where: { userId } });",
          "  }",
          "}",
          "",
        ].join("\n"),
      );
      writeSource(
        "src/lib/reexport-class-alias.ts",
        'export { VaultService as DestructiveService } from "./vault-service-static";\n',
      );
      const { exitCode, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stderr).toContain("REEXPORTED_DESTRUCTIVE_WRAPPER");
      expect(stderr).toContain(
        "src/lib/reexport-class-alias.ts re-exports VaultService.purgeAll from ./vault-service-static",
      );
      expect(stderr).not.toContain("ROUTE_DESTRUCTIVE_NO_STEPUP");
      expect(stderr).not.toContain("UNDECLARED_DESTRUCTIVE_WRAPPER");
    });

    it("passes (no REEXPORTED_DESTRUCTIVE_WRAPPER) for a same-named re-export from a TRUE PACKAGE import (skipped, not flat-matched)", () => {
      seedWrapperStubs();
      writeSource(
        "src/lib/reexport-package.ts",
        'export { executeVaultReset } from "some-npm-package";\n',
      );
      const { exitCode, stderr } = runGuard();
      expect(exitCode).toBe(0);
      expect(stderr).not.toContain("REEXPORTED_DESTRUCTIVE_WRAPPER");
    });

    it("FAILS (REEXPORTED_DESTRUCTIVE_WRAPPER) when `from` is on the NEXT LINE (whitespace-format evasion)", () => {
      seedWrapperStubs();
      writeSource(
        "src/lib/vault/vault-reset.ts",
        "export async function executeVaultReset(userId) {\n  await tx.passwordEntry.deleteMany({ where: { userId } });\n}\n",
      );
      writeSource(
        "src/lib/reexport-newline.ts",
        'export {\n  executeVaultReset,\n}\nfrom "./vault/vault-reset";\n',
      );
      const { exitCode, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stderr).toContain("REEXPORTED_DESTRUCTIVE_WRAPPER");
      expect(stderr).toContain(
        "src/lib/reexport-newline.ts re-exports executeVaultReset from ./vault/vault-reset",
      );
      expect(stderr).not.toContain("ROUTE_DESTRUCTIVE_NO_STEPUP");
      expect(stderr).not.toContain("UNDECLARED_DESTRUCTIVE_WRAPPER");
    });

    it("FAILS (REEXPORTED_DESTRUCTIVE_WRAPPER) for the compact no-whitespace `export*from` form", () => {
      seedWrapperStubs();
      writeSource(
        "src/lib/vault/vault-reset.ts",
        "export async function executeVaultReset(userId) {\n  await tx.passwordEntry.deleteMany({ where: { userId } });\n}\n",
      );
      writeSource(
        "src/lib/reexport-compact.ts",
        'export*from"./vault/vault-reset";\n',
      );
      const { exitCode, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stderr).toContain("REEXPORTED_DESTRUCTIVE_WRAPPER");
      expect(stderr).toContain(
        "src/lib/reexport-compact.ts re-exports executeVaultReset from ./vault/vault-reset",
      );
      expect(stderr).not.toContain("ROUTE_DESTRUCTIVE_NO_STEPUP");
      expect(stderr).not.toContain("UNDECLARED_DESTRUCTIVE_WRAPPER");
    });

    it("FAILS (REEXPORTED_DESTRUCTIVE_WRAPPER) when a comment separates the clause from `from`", () => {
      seedWrapperStubs();
      writeSource(
        "src/lib/vault/vault-reset.ts",
        "export async function executeVaultReset(userId) {\n  await tx.passwordEntry.deleteMany({ where: { userId } });\n}\n",
      );
      writeSource(
        "src/lib/reexport-comment.ts",
        'export {\n  executeVaultReset,\n} /* barrel */\nfrom "./vault/vault-reset";\n',
      );
      const { exitCode, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stderr).toContain("REEXPORTED_DESTRUCTIVE_WRAPPER");
      expect(stderr).toContain(
        "src/lib/reexport-comment.ts re-exports executeVaultReset from ./vault/vault-reset",
      );
      expect(stderr).not.toContain("ROUTE_DESTRUCTIVE_NO_STEPUP");
      expect(stderr).not.toContain("UNDECLARED_DESTRUCTIVE_WRAPPER");
    });

    it("FAILS (REEXPORTED_DESTRUCTIVE_WRAPPER) for IMPORT-THEN-EXPORT laundering of an aliased wrapper binding", () => {
      seedWrapperStubs();
      writeSource(
        "src/lib/vault/vault-reset.ts",
        "export async function executeVaultReset(userId) {\n  await tx.passwordEntry.deleteMany({ where: { userId } });\n}\n",
      );
      writeSource(
        "src/lib/reexport-laundered.ts",
        'import { executeVaultReset as reset } from "./vault/vault-reset";\nexport { reset };\n',
      );
      const { exitCode, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stderr).toContain("REEXPORTED_DESTRUCTIVE_WRAPPER");
      expect(stderr).toContain(
        "src/lib/reexport-laundered.ts re-exports executeVaultReset from ./vault/vault-reset",
      );
      expect(stderr).not.toContain("ROUTE_DESTRUCTIVE_NO_STEPUP");
      expect(stderr).not.toContain("UNDECLARED_DESTRUCTIVE_WRAPPER");
    });

    it("FAILS (REEXPORTED_DESTRUCTIVE_WRAPPER) for import-then-export with a SECOND alias on the export clause", () => {
      seedWrapperStubs();
      writeSource(
        "src/lib/vault/vault-reset.ts",
        "export async function executeVaultReset(userId) {\n  await tx.passwordEntry.deleteMany({ where: { userId } });\n}\n",
      );
      writeSource(
        "src/lib/reexport-laundered-alias.ts",
        'import { executeVaultReset as reset } from "./vault/vault-reset";\nexport { reset as publicReset };\n',
      );
      const { exitCode, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stderr).toContain("REEXPORTED_DESTRUCTIVE_WRAPPER");
      expect(stderr).toContain(
        "src/lib/reexport-laundered-alias.ts re-exports executeVaultReset from ./vault/vault-reset",
      );
      expect(stderr).not.toContain("ROUTE_DESTRUCTIVE_NO_STEPUP");
      expect(stderr).not.toContain("UNDECLARED_DESTRUCTIVE_WRAPPER");
    });

    it("FAILS (REEXPORTED_DESTRUCTIVE_WRAPPER) for NAMESPACE import-then-export (`import * as svc` then `export { svc }`)", () => {
      seedWrapperStubs();
      writeSource(
        "src/lib/vault/vault-reset.ts",
        "export async function executeVaultReset(userId) {\n  await tx.passwordEntry.deleteMany({ where: { userId } });\n}\n",
      );
      writeSource(
        "src/lib/reexport-ns-laundered.ts",
        'import * as svc from "./vault/vault-reset";\nexport { svc };\n',
      );
      const { exitCode, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stderr).toContain("REEXPORTED_DESTRUCTIVE_WRAPPER");
      expect(stderr).toContain(
        "src/lib/reexport-ns-laundered.ts re-exports executeVaultReset from ./vault/vault-reset",
      );
      expect(stderr).not.toContain("ROUTE_DESTRUCTIVE_NO_STEPUP");
      expect(stderr).not.toContain("UNDECLARED_DESTRUCTIVE_WRAPPER");
    });

    it("FAILS (REEXPORTED_DESTRUCTIVE_WRAPPER) for `export default <imported wrapper binding>`", () => {
      seedWrapperStubs();
      writeSource(
        "src/lib/vault/vault-reset.ts",
        "export async function executeVaultReset(userId) {\n  await tx.passwordEntry.deleteMany({ where: { userId } });\n}\n",
      );
      writeSource(
        "src/lib/reexport-default-laundered.ts",
        'import { executeVaultReset as reset } from "./vault/vault-reset";\nexport default reset;\n',
      );
      const { exitCode, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stderr).toContain("REEXPORTED_DESTRUCTIVE_WRAPPER");
      expect(stderr).toContain(
        "src/lib/reexport-default-laundered.ts re-exports executeVaultReset from ./vault/vault-reset",
      );
      expect(stderr).not.toContain("ROUTE_DESTRUCTIVE_NO_STEPUP");
      expect(stderr).not.toContain("UNDECLARED_DESTRUCTIVE_WRAPPER");
    });

    it("FAILS (REEXPORTED_DESTRUCTIVE_WRAPPER) for a .tsx barrel re-exporting a .ts wrapper", () => {
      seedWrapperStubs();
      writeSource(
        "src/lib/vault/vault-reset.ts",
        "export async function executeVaultReset(userId) {\n  await tx.passwordEntry.deleteMany({ where: { userId } });\n}\n",
      );
      writeSource(
        "src/lib/reexport-barrel.tsx",
        'export { executeVaultReset as reset } from "./vault/vault-reset";\n',
      );
      const { exitCode, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stderr).toContain("REEXPORTED_DESTRUCTIVE_WRAPPER");
      expect(stderr).toContain(
        "src/lib/reexport-barrel.tsx re-exports executeVaultReset from ./vault/vault-reset",
      );
      expect(stderr).not.toContain("ROUTE_DESTRUCTIVE_NO_STEPUP");
      expect(stderr).not.toContain("UNDECLARED_DESTRUCTIVE_WRAPPER");
    });

    it("passes (no REEXPORTED_DESTRUCTIVE_WRAPPER) for import-then-export of an INNOCENT binding", () => {
      seedWrapperStubs();
      writeSource(
        "src/lib/vault/helpers.ts",
        "export function formatVaultLabel(name) {\n  return name.trim();\n}\n",
      );
      writeSource(
        "src/lib/reexport-innocent-laundered.ts",
        'import { formatVaultLabel as fmt } from "./vault/helpers";\nexport { fmt };\n',
      );
      const { exitCode, stderr } = runGuard();
      expect(exitCode).toBe(0);
      expect(stderr).not.toContain("REEXPORTED_DESTRUCTIVE_WRAPPER");
    });
  });

  describe("env-pollution guard (sec-F6)", () => {
    it("FAILS when CI=true and an override is set without DESTRUCTIVE_WRAPPER_FIXTURE_MODE=1", () => {
      const { exitCode, stderr } = runGuard({ CI: "true", DESTRUCTIVE_WRAPPER_FIXTURE_MODE: "" });
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
