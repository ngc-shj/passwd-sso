/**
 * Self-test for scripts/checks/check-publish-toolchain.sh — the CI guard that
 * enforces the publish-toolchain trust boundary (exact Node pin via env, no
 * registry npm fetch under OIDC, per-role npm pins). The guard is the
 * regression backstop for a security-sensitive release path, so it gets its own
 * test proving it catches each failure mode (RT7 — provably able to fail).
 *
 * Driven against fixture files via PUBLISH_TOOLCHAIN_* path overrides so the
 * test never mutates tracked files.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GUARD = join(REPO_ROOT, "scripts/checks/check-publish-toolchain.sh");

// A minimal release.yml that passes the guard: exact-env node-version, env pins,
// no registry npm install, npm publish present.
const GOOD_RELEASE = `name: Release
env:
  PUBLISH_NODE_VERSION: "24.18.0"
  PUBLISH_NPM_VERSION: "11.16.0"
jobs:
  build-cli:
    permissions:
      contents: read
    steps:
      - uses: actions/setup-node@sha
        with:
          node-version: \${{ env.PUBLISH_NODE_VERSION }}
      - run: npm ci --ignore-scripts
  publish-cli:
    permissions:
      id-token: write
    steps:
      - uses: actions/setup-node@sha
        with:
          node-version: \${{ env.PUBLISH_NODE_VERSION }}
      - run: npm publish ./pkg.tgz
`;
const GOOD_SIGS = `jobs:
  verify:
    steps:
      - run: npm install -g npm@11.16.0 --ignore-scripts
`;
const GOOD_DOCKER = `RUN NPM_VER=11.16.0 && npm install -g "npm@\${NPM_VER}"\n`;

let dir;
let release;
let sigs;
let docker;

function runGuard() {
  return spawnSync("bash", [GUARD], {
    encoding: "utf8",
    env: {
      ...process.env,
      PUBLISH_TOOLCHAIN_RELEASE_WF: release,
      PUBLISH_TOOLCHAIN_SIGS_WF: sigs,
      PUBLISH_TOOLCHAIN_DOCKERFILE: docker,
    },
  });
}

function writeRelease(content) {
  writeFileSync(release, content);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pubtc-"));
  release = join(dir, "release.yml");
  sigs = join(dir, "dependency-signatures.yml");
  docker = join(dir, "Dockerfile");
  writeFileSync(release, GOOD_RELEASE);
  writeFileSync(sigs, GOOD_SIGS);
  writeFileSync(docker, GOOD_DOCKER);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("check-publish-toolchain.sh", () => {
  it("passes on a well-formed release toolchain", () => {
    const r = runGuard();
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });

  it("fails when PUBLISH_NODE_VERSION is a floating major", () => {
    writeRelease(GOOD_RELEASE.replace('"24.18.0"', '"24"'));
    expect(runGuard().status).not.toBe(0);
  });

  it("fails when PUBLISH_NODE_VERSION is a partial version (24.18)", () => {
    writeRelease(GOOD_RELEASE.replace('"24.18.0"', '"24.18"'));
    expect(runGuard().status).not.toBe(0);
  });

  it("fails when a job pins node-version to a literal instead of the env", () => {
    writeRelease(
      GOOD_RELEASE.replace(
        "node-version: ${{ env.PUBLISH_NODE_VERSION }}\n      - run: npm publish ./pkg.tgz",
        'node-version: "24.x"\n      - run: npm publish ./pkg.tgz',
      ),
    );
    expect(runGuard().status).not.toBe(0);
  });

  it("fails on a partial-match node-version (env-ref with a .x suffix)", () => {
    writeRelease(
      GOOD_RELEASE.replaceAll(
        "node-version: ${{ env.PUBLISH_NODE_VERSION }}",
        "node-version: ${{ env.PUBLISH_NODE_VERSION }}.x",
      ),
    );
    expect(runGuard().status).not.toBe(0);
  });

  it("fails when node-version-file is present", () => {
    writeRelease(
      GOOD_RELEASE.replace(
        "node-version: ${{ env.PUBLISH_NODE_VERSION }}\n      - run: npm publish ./pkg.tgz",
        'node-version-file: ".nvmrc"\n      - run: npm publish ./pkg.tgz',
      ),
    );
    expect(runGuard().status).not.toBe(0);
  });

  it("fails when a real 'npm install -g npm@' command is present", () => {
    writeRelease(
      GOOD_RELEASE.replace(
        "      - run: npm publish ./pkg.tgz",
        "      - run: npm install -g npm@11.16.0 --ignore-scripts\n      - run: npm publish ./pkg.tgz",
      ),
    );
    expect(runGuard().status).not.toBe(0);
  });

  it("passes when 'npm install -g npm@' appears only in a comment", () => {
    writeRelease(
      GOOD_RELEASE.replace(
        "  publish-cli:",
        "  # note: do not npm install -g npm@11.16.0 in the publish job\n  publish-cli:",
      ),
    );
    expect(runGuard().status).toBe(0);
  });

  it("fails when PUBLISH_NPM_VERSION is below the Trusted Publishing floor", () => {
    writeRelease(GOOD_RELEASE.replace('"11.16.0"', '"11.4.0"'));
    expect(runGuard().status).not.toBe(0);
  });

  it("fails when the signature verifier npm pin is below the floor", () => {
    writeFileSync(sigs, GOOD_SIGS.replace("11.16.0", "11.4.0"));
    expect(runGuard().status).not.toBe(0);
  });
});
