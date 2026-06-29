/**
 * Self-test for scripts/checks/check-passkey-mint-gate.sh — the CI guard
 * that requires `passkeyEnforcementBlocks` on every route that mints or
 * re-mints a token (initial issue OR refresh re-mint).
 *
 * The guard is the completeness backstop for the token-issuance choke-point
 * enumeration (plan C7); a regression in its detection (regex, exempt parsing,
 * anti-drift) would silently make it fail-open, so it gets its own test
 * asserting it catches each failure mode.
 *
 * The guard is driven against fixtures via the MINT_GATE_* env overrides
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
const GUARD = join(REPO_ROOT, "scripts/checks/check-passkey-mint-gate.sh");

// A representative MINT primitive (initial issue).
const MINT_LINE = "await prisma.extensionBridgeCode.create({ data });";
// A representative REFRESH primitive (re-mint via rotation).
const REFRESH_LINE = "await exchangeRefreshToken(rt, now);";
// The gate call that satisfies the guard.
const GATE_LINE = "if (passkeyEnforcementBlocks(state)) return forbidden;";

let root;
let apiDir;
let exemptFile;

/** Run the guard against the fixture tree. */
function runGuard() {
  const r = spawnSync("bash", [GUARD], {
    encoding: "utf8",
    env: {
      ...process.env,
      MINT_GATE_API_DIR: apiDir,
      MINT_GATE_PATH_ROOT: root,
      MINT_GATE_EXEMPT_FILE: exemptFile,
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

/** Write a fixture lib file at src/lib/<relPath> inside the fixture root. */
function writeLib(relPath, body) {
  const parts = relPath.split("/");
  const dir = join(root, "src", "lib", ...parts.slice(0, -1));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, "src", "lib", relPath), body, "utf8");
}

const LIB_GATE_BODY = "export function fn() { if (passkeyEnforcementBlocks(state)) return; }\n";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mint-gate-guard-"));
  apiDir = join(root, "api");
  exemptFile = join(root, "exempt.txt");
  mkdirSync(apiDir, { recursive: true });
  writeFileSync(exemptFile, "# fixture exempt list\n", "utf8");
  // Pre-create the lib files the guard now also checks (lib-level gate assertion).
  // All standard fixture tests want these to pass, so write them with the gate.
  writeLib("mcp/oauth-server.ts", LIB_GATE_BODY);
  writeLib("auth/tokens/mobile-token.ts", LIB_GATE_BODY);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-passkey-mint-gate.sh", () => {
  it("passes on an empty API directory (no mint routes)", () => {
    const { exitCode } = runGuard();
    expect(exitCode).toBe(0);
  });

  it("passes when a MINT-route has the gate", () => {
    writeRoute("extension/bridge-code", `${GATE_LINE}\n${MINT_LINE}\n`);
    const { exitCode } = runGuard();
    expect(exitCode).toBe(0);
  });

  it("passes when a REFRESH-route has the gate", () => {
    writeRoute("mcp/token", `${GATE_LINE}\n${REFRESH_LINE}\n`);
    const { exitCode } = runGuard();
    expect(exitCode).toBe(0);
  });

  it("passes when a route contains no mint primitive (unrelated route)", () => {
    writeRoute("passwords/[id]", "await prisma.passwordEntry.findUnique({ where: { id } });\n");
    const { exitCode } = runGuard();
    expect(exitCode).toBe(0);
  });

  it("FAILS (MISSING_PASSKEY_GATE) when a MINT-route lacks the gate", () => {
    // Tampered route: has the mint primitive but no passkeyEnforcementBlocks.
    writeRoute("extension/bridge-code", `${MINT_LINE}\n`);
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("MISSING_PASSKEY_GATE");
    expect(stdout).toContain("api/extension/bridge-code/route.ts");
  });

  it("FAILS (MISSING_PASSKEY_GATE) when a REFRESH-route lacks the gate", () => {
    // Tampered refresh route: exchangeRefreshToken with no gate.
    writeRoute("mcp/token", `${REFRESH_LINE}\n`);
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("MISSING_PASSKEY_GATE");
    expect(stdout).toContain("api/mcp/token/route.ts");
  });

  it("does NOT accept a prefixed/renamed gate identifier", () => {
    writeRoute(
      "extension/bridge-code",
      `const x = DISABLED_passkeyEnforcementBlocks(state);\n${MINT_LINE}\n`,
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("MISSING_PASSKEY_GATE");
  });

  it("does NOT accept a bare import without a call", () => {
    writeRoute(
      "extension/bridge-code",
      `import { passkeyEnforcementBlocks } from "@/lib/auth/policy/passkey-enforcement";\n${MINT_LINE}\n`,
    );
    const { exitCode } = runGuard();
    expect(exitCode).toBe(1);
  });

  it("passes when a tampered MINT-route is on the allowlist with a reason", () => {
    const rel = writeRoute("mobile/autofill-token", `${MINT_LINE}\n`);
    writeFileSync(exemptFile, `${rel}  # transitively gated via host token; direct gate deadlocks first-passkey-save\n`, "utf8");
    const { exitCode } = runGuard();
    expect(exitCode).toBe(0);
  });

  it("passes when a tampered REFRESH-route is on the allowlist with a reason", () => {
    const rel = writeRoute("extension/token/refresh", `${REFRESH_LINE}\n`);
    writeFileSync(exemptFile, `${rel}  # transitively gated via parent token; explicit classification\n`, "utf8");
    const { exitCode } = runGuard();
    expect(exitCode).toBe(0);
  });

  it("FAILS (EXEMPT_NO_REASON) when an exempt entry has no justification", () => {
    const rel = writeRoute("mobile/autofill-token", `${MINT_LINE}\n`);
    writeFileSync(exemptFile, `${rel}\n`, "utf8");
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("EXEMPT_NO_REASON");
  });

  it("FAILS (STALE_EXEMPT) when an exempt entry points to a missing file", () => {
    writeFileSync(
      exemptFile,
      "api/does/not/exist/route.ts  # bogus stale entry for testing\n",
      "utf8",
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("STALE_EXEMPT");
  });

  it("FAILS (STALE_EXEMPT) when an exempt route no longer has a mint primitive", () => {
    const rel = writeRoute(
      "mobile/autofill-token",
      "await prisma.passwordEntry.findMany({ where: { userId } });\n",
    );
    writeFileSync(exemptFile, `${rel}  # used to mint, now only reads data\n`, "utf8");
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("STALE_EXEMPT");
  });

  // ─── Lib-level gate assertions ────────────────────────────────
  // The guard also checks that lib files (oauth-server.ts + mobile-token.ts) that
  // absorbed the passkey gate from their callers still contain passkeyEnforcementBlocks.
  // The lib files are pre-created with the gate in beforeEach — these tests override
  // one or both to simulate the gate being missing.

  it("passes when both lib files contain passkeyEnforcementBlocks", () => {
    // beforeEach already wrote both libs with the gate — just confirm pass.
    const { exitCode } = runGuard();
    expect(exitCode).toBe(0);
  });

  it("FAILS (MISSING_LIB_PASSKEY_GATE) when oauth-server.ts lacks passkeyEnforcementBlocks", () => {
    writeLib(
      "mcp/oauth-server.ts",
      "export function exchangeRefreshToken() { /* gate removed */ }\n",
    );
    writeLib(
      "auth/tokens/mobile-token.ts",
      "export function refreshIosToken() { if (passkeyEnforcementBlocks(state)) return; }\n",
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("MISSING_LIB_PASSKEY_GATE");
    expect(stdout).toContain("oauth-server.ts");
  });

  it("FAILS (MISSING_LIB_PASSKEY_GATE) when mobile-token.ts lacks passkeyEnforcementBlocks", () => {
    writeLib(
      "mcp/oauth-server.ts",
      "export function exchangeRefreshToken() { if (passkeyEnforcementBlocks(state)) return; }\n",
    );
    writeLib(
      "auth/tokens/mobile-token.ts",
      "export function refreshIosToken() { /* gate removed */ }\n",
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("MISSING_LIB_PASSKEY_GATE");
    expect(stdout).toContain("mobile-token.ts");
  });

  it("passes the real codebase tree (exit 0 on the actual repo)", () => {
    // Runs the guard with no env overrides — points at the real src/app/api.
    // All C2/C3/C6/C8 gates are now in place; this is the belt-and-suspenders
    // smoke test confirming no route regressed after the full implementation.
    const r = spawnSync("bash", [GUARD], { encoding: "utf8" });
    expect(r.status).toBe(0, `Real-tree guard failed — missing gates:\n${r.stdout}`);
  });
});
