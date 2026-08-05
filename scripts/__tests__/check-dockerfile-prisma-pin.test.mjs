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
      // Fixture-mode default so the env-pollution guard does not fire under
      // CI=true; the pollution-guard test overrides it back to "".
      DOCKERFILE_PRISMA_PIN_FIXTURE_MODE: "1",
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

// The gate has a THIRD input now: brace-expansion is pinned both in the app
// tree's overrides and in the Dockerfile's BE_VER, and it asserts the second is
// at least the first. A fixture that omits package.json therefore describes a
// repository the gate cannot exist in, so every fixture writes one.
function writeManifest(overrideFloor = "^5.0.9") {
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "fixture",
      overrides: { "brace-expansion@>=3.0.0 <5.0.9": overrideFloor },
    }),
    "utf8",
  );
}

/** A Dockerfile carrying both pins; `be` omitted writes no BE_VER at all. */
function writeDockerfile(prismaVer, be = "5.0.9") {
  const lines = [`ARG PRISMA_VER=${prismaVer}`];
  if (be !== null) lines.push(`    BE_VER=${be} && \\`);
  writeFileSync(join(root, "Dockerfile"), lines.join("\n") + "\n", "utf8");
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
    writeManifest();
    writeDockerfile("7.1.0");
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain(
      "ERROR: Dockerfile PRISMA_VER=7.1.0 does not match package-lock.json prisma 7.2.0",
    );
  });

  it("passes when the Dockerfile PRISMA_VER exactly matches the lockfile version", () => {
    writeLockfile("7.2.0");
    writeManifest();
    writeDockerfile("7.2.0");
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("OK (Dockerfile PRISMA_VER=7.2.0 matches lockfile)");
  });

  // ─── The second pin: npm's bundled brace-expansion ─────────
  //
  // brace-expansion is pinned twice — the app tree via `overrides`, and npm's
  // own bundled copy via BE_VER, which the runner stage unpacks over npm's.
  // Nothing tied them together, and GHSA-rgw5-rvv9-x895 (4.0.0 – 5.0.8
  // inclusive) found both stale at once: `npm audit` went green while the image
  // still shipped 5.0.8 and Trivy stayed red.

  it("FAILS when BE_VER is below the app tree's override floor", () => {
    writeLockfile("7.2.0");
    writeManifest("^5.0.9");
    writeDockerfile("7.2.0", "5.0.8");
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain(
      "ERROR: Dockerfile BE_VER=5.0.8 is below the package.json brace-expansion override floor 5.0.9",
    );
  });

  it("passes when BE_VER is ABOVE the floor (paired allow case)", () => {
    // Higher is fine — the Dockerfile patches npm's copy UP to BE_VER, so the
    // gate is a floor, not an equality. Without this the fix could be "always
    // deny" and satisfy every other case here.
    writeLockfile("7.2.0");
    writeManifest("^5.0.9");
    writeDockerfile("7.2.0", "5.1.0");
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("OK (Dockerfile BE_VER=5.1.0 >= override floor 5.0.9)");
  });

  it("FAILS when the Dockerfile pins no BE_VER at all", () => {
    writeLockfile("7.2.0");
    writeManifest("^5.0.9");
    writeDockerfile("7.2.0", null);
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("no pinned 'BE_VER=X.Y.Z' found");
  });

  it("FAILS when the app tree carries no brace-expansion override", () => {
    // "Examined nothing" must not be spelled like "found nothing": with the
    // override gone there is no floor to compare against, and the gate refuses
    // rather than passing an unconstrained BE_VER.
    writeLockfile("7.2.0");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture" }), "utf8");
    writeDockerfile("7.2.0", "5.0.9");
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("no 'brace-expansion@>=3...' override found");
  });

  it("FAILS when the Dockerfile has no pinned PRISMA_VER at all", () => {
    writeLockfile("7.2.0");
    writeManifest();
    writeDockerfile("latest");
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
      writeManifest();
      writeDockerfile("7.2.0");
      const { exitCode, stdout } = runGuard({ CI: "true", DOCKERFILE_PRISMA_PIN_FIXTURE_MODE: "" });
      expect(exitCode).toBe(1);
      expect(stdout).toContain("ENV_POLLUTION_GUARD");
    });

    it("passes under CI=true when DOCKERFILE_PRISMA_PIN_FIXTURE_MODE=1 is set and the fixture is clean", () => {
      writeLockfile("7.2.0");
      writeManifest();
      writeDockerfile("7.2.0");
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
