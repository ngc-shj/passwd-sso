/**
 * Self-test for scripts/checks/check-dockerfile-prisma-pin.sh — the CI guard
 * that requires the Dockerfile's PRISMA_VER build arg to exactly match the
 * `prisma` version resolved in package-lock.json (build reproducibility /
 * prisma-CLI vs generated-client version skew).
 *
 * Multi-input gate (test-F10, plan C2): the Dockerfile AND package-lock.json
 * are both read relative to a SINGLE fixture root via
 * DOCKERFILE_PRISMA_PIN_ROOT — never per-file overrides — so a fixture
 * Dockerfile can never be compared against the real repo's lockfile.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GUARD = join(REPO_ROOT, "scripts/checks/check-dockerfile-prisma-pin.sh");

let root;

function runGuard(extraEnv = {}) {
  const r = spawnSync("bash", [GUARD], {
    encoding: "utf8",
    env: {
      ...process.env,
      DOCKERFILE_PRISMA_PIN_ROOT: root,
      ...extraEnv,
    },
  });
  return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
}

function writeLockfile(version) {
  writeFileSync(
    join(root, "package-lock.json"),
    JSON.stringify({
      name: "fixture",
      packages: { "node_modules/prisma": { version } },
    }),
    "utf8",
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dockerfile-prisma-pin-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-dockerfile-prisma-pin.sh", () => {
  it("FAILS when the Dockerfile PRISMA_VER floats/mismatches the lockfile version", () => {
    writeLockfile("7.2.0");
    writeFileSync(join(root, "Dockerfile"), "ARG PRISMA_VER=7.1.0\n", "utf8");
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain(
      "ERROR: Dockerfile PRISMA_VER=7.1.0 does not match package-lock.json prisma 7.2.0",
    );
  });

  it("passes when the Dockerfile PRISMA_VER exactly matches the lockfile version", () => {
    writeLockfile("7.2.0");
    writeFileSync(join(root, "Dockerfile"), "ARG PRISMA_VER=7.2.0\n", "utf8");
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("OK (Dockerfile PRISMA_VER=7.2.0 matches lockfile)");
  });

  it("FAILS when the Dockerfile has no pinned PRISMA_VER at all", () => {
    writeLockfile("7.2.0");
    writeFileSync(join(root, "Dockerfile"), "ARG PRISMA_VER=latest\n", "utf8");
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("prisma must be version-pinned, not floating");
  });

  it("passes when no Dockerfile is present", () => {
    writeLockfile("7.2.0");
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("OK (Dockerfile not present)");
  });

  describe("env-pollution guard (sec-F6)", () => {
    it("FAILS when CI=true and an override is set without DOCKERFILE_PRISMA_PIN_FIXTURE_MODE=1", () => {
      writeLockfile("7.2.0");
      writeFileSync(join(root, "Dockerfile"), "ARG PRISMA_VER=7.2.0\n", "utf8");
      const { exitCode, stdout } = runGuard({ CI: "true" });
      expect(exitCode).toBe(1);
      expect(stdout).toContain("ENV_POLLUTION_GUARD");
    });

    it("passes under CI=true when DOCKERFILE_PRISMA_PIN_FIXTURE_MODE=1 is set and the fixture is clean", () => {
      writeLockfile("7.2.0");
      writeFileSync(join(root, "Dockerfile"), "ARG PRISMA_VER=7.2.0\n", "utf8");
      const { exitCode } = runGuard({ CI: "true", DOCKERFILE_PRISMA_PIN_FIXTURE_MODE: "1" });
      expect(exitCode).toBe(0);
    });
  });

  describe("real repo (no overrides)", () => {
    it("passes against the actual repo Dockerfile + lockfile", () => {
      const r = spawnSync("bash", [GUARD], { encoding: "utf8" });
      expect(r.status, r.stdout + r.stderr).toBe(0);
    });
  });
});
