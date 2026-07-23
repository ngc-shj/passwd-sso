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

const RECURSIVE_IGNORE =
  "node_modules\n.env\n.env.*\n**/.env\n**/.env.*\n!.env.example\n!**/.env.example\n";

describe("check-dockerignore-secrets", () => {
  it("passes when .dockerignore excludes .env at any depth but keeps .env.example", () => {
    writeDockerignore(RECURSIVE_IGNORE);
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

  it("FAILS when .dockerignore excludes only root .env but not nested (extension/.env miss)", () => {
    // Root-only patterns — the exact pre-fix gap that let extension/.env ship.
    writeDockerignore("node_modules\n.env\n.env.*\n!.env.example\n");
    const r = runGuard();
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("extension/.env");
  });

  it("keeps nested committed placeholders (extension/.env.example) included", () => {
    writeDockerignore(RECURSIVE_IGNORE);
    const r = runGuard();
    expect(r.exitCode).toBe(0);
    expect(r.stdout + r.stderr).not.toContain("over-excludes");
  });

  it("FAILS when .dockerignore over-excludes the committed .env.example", () => {
    // Recursive exclusion WITHOUT the !.env.example re-includes → placeholder dropped.
    writeDockerignore("node_modules\n.env\n.env.*\n**/.env\n**/.env.*\n");
    const r = runGuard();
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("over-excludes committed placeholder");
  });

  it("FAILS when a built tree contains a NESTED secret .env (full-tree bundle scan)", () => {
    writeDockerignore(RECURSIVE_IGNORE);
    // Simulate an extracted image tree with a nested leak (the extension/.env case).
    const nested = join(root, "image", "app", "extension");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, ".env"), "DATABASE_URL=secret\n", "utf8");
    const r = runGuard({
      DOCKERIGNORE_SECRETS_SCAN_BUNDLE: "1",
      DOCKERIGNORE_SECRETS_IMAGE_ROOT: join(root, "image"),
    });
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("extension/.env");
  });

  it("passes the bundle scan when the built tree has no secret env file", () => {
    writeDockerignore(RECURSIVE_IGNORE);
    const appDir = join(root, "image", "app");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, ".env.example"), "DATABASE_URL=\n", "utf8");
    const r = runGuard({
      DOCKERIGNORE_SECRETS_SCAN_BUNDLE: "1",
      DOCKERIGNORE_SECRETS_IMAGE_ROOT: join(root, "image"),
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("has no secret env file at any depth");
  });

  it("ignores node_modules .env fixtures in the bundle scan", () => {
    writeDockerignore(RECURSIVE_IGNORE);
    const nm = join(root, "image", "app", "node_modules", "somepkg");
    mkdirSync(nm, { recursive: true });
    writeFileSync(join(nm, ".env"), "FIXTURE=1\n", "utf8");
    const r = runGuard({
      DOCKERIGNORE_SECRETS_SCAN_BUNDLE: "1",
      DOCKERIGNORE_SECRETS_IMAGE_ROOT: join(root, "image"),
    });
    expect(r.exitCode).toBe(0);
  });

  it("refuses a root override under CI without fixture-mode ack (env-pollution guard)", () => {
    writeDockerignore(RECURSIVE_IGNORE);
    const r = runGuard({ CI: "true", DOCKERIGNORE_SECRETS_FIXTURE_MODE: "" });
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("ENV_POLLUTION_GUARD");
  });
});
