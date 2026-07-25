/**
 * Self-test for scripts/checks/check-session-token-hashed.mjs — the H4 AST gate
 * that flags a Prisma session op keyed on a RAW cookie token (must be a digest).
 *
 * RT7: red-proven by fixtures whose `where.sessionToken` / `{ not: ... }` bind a
 * bare raw identifier — the exact regression (e.g. new-device-detection) the gate
 * catches. Green fixtures cover every SAFE form (hashSessionToken call, a
 * *Digest variable bound to a producer, a DB-selected `.sessionToken`, `true`).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GUARD = join(REPO_ROOT, "scripts/checks/check-session-token-hashed.mjs");

let root;

function runGuard() {
  const r = spawnSync("node", [GUARD], {
    encoding: "utf8",
    env: { ...process.env, SESSION_TOKEN_HASHED_ROOT: root },
  });
  return { exitCode: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function writeSrc(rel, contents) {
  const full = join(root, "src", rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents, "utf8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "session-token-hashed-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-session-token-hashed.mjs", () => {
  it("passes for every SAFE digest form", () => {
    writeSrc(
      "lib/safe.ts",
      [
        "async function a(raw: string) {",
        "  await tx.session.findUnique({ where: { sessionToken: hashSessionToken(raw) } });",
        "}",
        "async function b(req: NextRequest) {",
        "  const digest = getSessionTokenDigest(req);",
        "  await tx.session.delete({ where: { sessionToken: digest } });",
        "}",
        "async function c() {",
        "  const rows = await tx.session.findMany({ select: { sessionToken: true } });",
        "  await tx.session.deleteMany({ where: { sessionToken: { not: rows[0].sessionToken } } });",
        "}",
      ].join("\n"),
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode, stdout).toBe(0);
    expect(stdout).toContain("all session DB ops key on a digest");
  });

  it("FAILS when a where.sessionToken binds a bare raw token", () => {
    writeSrc(
      "lib/raw.ts",
      "async function f(rawCookieToken: string) {\n" +
        "  await tx.session.findUnique({ where: { sessionToken: rawCookieToken } });\n" +
        "}\n",
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout + "").toBeTruthy();
  });

  it("FAILS on `{ not: rawToken }` with a bare raw token (new-device-detection shape)", () => {
    writeSrc(
      "lib/exclude.ts",
      "async function f(currentSessionToken: string) {\n" +
        "  await tx.session.findMany({ where: { sessionToken: { not: currentSessionToken } } });\n" +
        "}\n",
    );
    const { exitCode } = runGuard();
    expect(exitCode).toBe(1);
  });

  it("FAILS when a digest-named var is actually bound to a raw value", () => {
    // Binding resolution, not naming: a var NAMED digest but bound to a raw
    // token must still fail.
    writeSrc(
      "lib/fake.ts",
      "async function f(raw: string) {\n" +
        "  const digest = raw;\n" +
        "  await tx.session.delete({ where: { sessionToken: digest } });\n" +
        "}\n",
    );
    const { exitCode } = runGuard();
    expect(exitCode).toBe(1);
  });

  it("passes against the real repo", () => {
    const r = spawnSync("node", [GUARD], { encoding: "utf8" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });
});
