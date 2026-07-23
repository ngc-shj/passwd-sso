/**
 * Self-test for scripts/checks/check-dockerignore-secrets.sh — the CI guard
 * that asserts .dockerignore excludes every env/secret file from the Docker
 * build context so secrets never enter the image (2026-07 review, High:
 * Next.js standalone tracing copied .env into the image).
 *
 * Single fixture root via DOCKERIGNORE_SECRETS_ROOT (mirrors the prisma-pin
 * guard's multi-input discipline). RT7: the guard is proven able to go red.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GUARD = join(REPO_ROOT, "scripts/checks/check-dockerignore-secrets.sh");

let root;

function runGuard(extraEnv = {}) {
  const r = spawnSync("bash", [GUARD], {
    encoding: "utf8",
    env: {
      ...process.env,
      DOCKERIGNORE_SECRETS_ROOT: root,
      DOCKERIGNORE_SECRETS_FIXTURE_MODE: "1",
      ...extraEnv,
    },
  });
  return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
}

function writeDockerignore(contents) {
  writeFileSync(join(root, ".dockerignore"), contents, "utf8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dockerignore-secrets-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-dockerignore-secrets", () => {
  it("passes when .dockerignore excludes .env and .env.* but keeps .env.example", () => {
    writeDockerignore("node_modules\n.env\n.env.*\n!.env.example\n");
    const r = runGuard();
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("OK (static:");
  });

  it("FAILS when .dockerignore does not exclude .env (the original leak)", () => {
    writeDockerignore("node_modules\n.env.local\n.env*.local\n");
    const r = runGuard();
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("does NOT exclude secret env file");
  });

  it("FAILS when .dockerignore over-excludes the committed .env.example", () => {
    // .env.* without the !.env.example re-include drops the placeholder too.
    writeDockerignore("node_modules\n.env\n.env.*\n");
    const r = runGuard();
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("over-excludes committed placeholder");
  });

  it("FAILS when a built .next/standalone tree contains a secret .env (bundle scan)", () => {
    writeDockerignore("node_modules\n.env\n.env.*\n!.env.example\n");
    const bundleDir = join(root, ".next", "standalone", "app");
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(join(bundleDir, ".env"), "DATABASE_URL=secret\n", "utf8");
    const r = runGuard({ DOCKERIGNORE_SECRETS_SCAN_BUNDLE: "1" });
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("present in .next/standalone");
  });

  it("passes the bundle scan when .next/standalone has no secret env file", () => {
    writeDockerignore("node_modules\n.env\n.env.*\n!.env.example\n");
    const bundleDir = join(root, ".next", "standalone", "app");
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(join(bundleDir, ".env.example"), "DATABASE_URL=\n", "utf8");
    const r = runGuard({ DOCKERIGNORE_SECRETS_SCAN_BUNDLE: "1" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("bundle: .next/standalone has no secret env file");
  });

  it("refuses a root override under CI without fixture-mode ack (env-pollution guard)", () => {
    writeDockerignore("node_modules\n.env\n.env.*\n!.env.example\n");
    const r = runGuard({ CI: "true", DOCKERIGNORE_SECRETS_FIXTURE_MODE: "" });
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("ENV_POLLUTION_GUARD");
  });
});
