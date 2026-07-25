/**
 * Self-test for scripts/checks/check-cosign-kms-uri.sh (RT7).
 *
 * The gate exists because a stub-based unit test CANNOT catch a malformed KMS
 * URI (the stub ignores argv), yet the malformed form aborts every real deploy.
 * So this self-test drives the gate against fixture deploy.sh files and proves
 * both branches against the real cosign binary.
 *
 * T0  — CI=true with cosign missing FAILS (a skipped gate reads as a passing one)
 * T1  — the repo's actual deploy.sh passes
 * T2  — a two-slash `awskms://<arn>` FAILS, naming the endpoint misparse
 * T2b — a one-slash `awskms:/<arn>` FAILS (cosign treats it as a file path; the
 *       gate's earlier known-bad-string denylist let this through)
 * T2c — any other unrecognised outcome FAILS (fail closed, not open)
 * T3  — a deploy.sh with no recognisable URI construction fails loudly rather
 *       than silently passing (the gate must not rot into a no-op if code moves)
 *
 * All but T0 are skipped when cosign is not installed locally — it is a
 * deploy-host tool. T0 covers the CI path, where a missing binary must fail.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GATE = resolve(REPO_ROOT, "scripts", "checks", "check-cosign-kms-uri.sh");
const REAL_DEPLOY = resolve(REPO_ROOT, "scripts", "deploy.sh");

// Probe the binary directly — `spawnSync(..., {shell: true})` triggers a Node
// deprecation warning about unescaped args.
const hasCosign = spawnSync("cosign", ["version"], { encoding: "utf8" }).status === 0;

let tmpDir;

function runGate(deployShPath, extraEnv = {}) {
  return spawnSync("bash", [GATE], {
    env: { ...process.env, COSIGN_URI_CHECK_DEPLOY_SH: deployShPath, ...extraEnv },
    encoding: "utf8",
    timeout: 120_000,
    cwd: REPO_ROOT,
  });
}

/** Copy the real deploy.sh, optionally rewriting the URI construction. */
function fixtureDeploy(transform) {
  const src = readFileSync(REAL_DEPLOY, "utf8");
  const out = join(tmpDir, "deploy.sh");
  writeFileSync(out, transform ? transform(src) : src, "utf8");
  return out;
}

beforeEach(() => {
  tmpDir = mkdtempSync(resolve(tmpdir(), "cosign-uri-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("check-cosign-kms-uri gate — cosign absent", () => {
  it("T0: fails when CI=true and cosign is missing (must not silently skip)", () => {
    // A skipped gate is indistinguishable from a passing one. Simulate a missing
    // binary by handing the gate a PATH with no cosign on it.
    // Run the gate under a PATH containing ONLY the coreutils it needs, so the
    // real (brew-installed) cosign is genuinely unreachable. Putting a
    // non-executable placeholder first does not work: `command -v` simply keeps
    // searching and finds the real binary further along PATH.
    const minimalBin = mkdtempSync(resolve(tmpdir(), "no-cosign-"));
    for (const tool of ["bash", "grep", "sed", "timeout", "dirname", "pwd", "head", "cat"]) {
      const found = spawnSync("command", ["-v", tool], {
        encoding: "utf8",
        shell: "/bin/bash",
      }).stdout?.trim();
      if (found) {
        try {
          symlinkSync(found, join(minimalBin, tool));
        } catch {
          /* already linked */
        }
      }
    }
    try {
      const r = spawnSync("bash", [GATE], {
        env: { ...process.env, PATH: minimalBin, CI: "true" },
        encoding: "utf8",
        timeout: 30_000,
        cwd: REPO_ROOT,
      });

      expect(r.status).toBe(1);
      expect(r.stderr).toContain("cosign is not installed, but CI=true");
    } finally {
      rmSync(minimalBin, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!hasCosign)("check-cosign-kms-uri gate", () => {
  it("T1: the repo's deploy.sh builds a resolvable KMS URI", () => {
    const r = runGate(REAL_DEPLOY);

    expect(r.stdout + r.stderr).toContain("OK");
    expect(r.status).toBe(0);
  });

  it("T2: a two-slash awskms:// URI fails, naming the endpoint misparse", () => {
    // The exact regression: cosign reads the ARN as the endpoint host and never
    // reaches KMS, so signature verification — which fails closed — would abort
    // every deploy.
    const path = fixtureDeploy((s) =>
      s.replace('echo "awskms:///${arn}"', 'echo "awskms://${arn}"'),
    );

    const r = runGate(path);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain("did not resolve this KMS URI to a key");
    expect(r.stderr).toContain("Failed to parse uri");
  });

  it("T2b: a one-slash awskms:/ URI fails (gate must not fail OPEN)", () => {
    // Regression: the gate used to reject only two known error strings, so this
    // form — which cosign treats as a FILE PATH — produced neither and the gate
    // reported OK. It now requires positive proof that cosign reached KMS.
    const path = fixtureDeploy((s) =>
      s.replace('echo "awskms:///${arn}"', 'echo "awskms:/${arn}"'),
    );

    const r = runGate(path);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain("did not resolve this KMS URI to a key");
  });

  it("T2c: an unrecognised cosign outcome fails closed", () => {
    // Any outcome that is not "AWS rejected our dummy credentials" must fail:
    // a network error, a timeout, or a future cosign message would otherwise
    // sail through a denylist of known-bad strings. Force one by pointing the
    // URI's ENDPOINT at an unroutable host — the URI parses, but the KMS call
    // never completes, so no AWS rejection is ever observed.
    const path = fixtureDeploy((s) =>
      s.replace('echo "awskms:///${arn}"', 'echo "awskms://127.0.0.1:1/${arn}"'),
    );

    const r = runGate(path);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain("did not resolve this KMS URI to a key");
  });

  it("T3: fails loudly when the URI construction is gone (gate must not rot)", () => {
    const path = fixtureDeploy((s) =>
      s.replace('echo "awskms:///${arn}"', 'echo "some-other-key-scheme://${arn}"'),
    );

    const r = runGate(path);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain("could not find the awskms URI construction");
  });
});
