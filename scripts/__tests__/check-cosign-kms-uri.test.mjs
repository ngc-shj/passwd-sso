/**
 * Self-test for scripts/checks/check-cosign-kms-uri.sh (RT7).
 *
 * The gate exists because a stub-based unit test CANNOT catch a malformed KMS
 * URI (the stub ignores argv), yet the malformed form aborts every real deploy.
 * So this self-test drives the gate against fixture deploy.sh files and proves
 * both branches against the real cosign binary.
 *
 * T1 — the repo's actual deploy.sh passes
 * T2 — a two-slash `awskms://<arn>` deploy.sh FAILS, naming the endpoint misparse
 * T3 — a deploy.sh with no recognisable URI construction fails loudly rather
 *      than silently passing (the gate must not rot into a no-op if the code moves)
 *
 * Skipped when cosign is not installed — it is a deploy-host tool, and the gate
 * itself skips in that case.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
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

function runGate(deployShPath) {
  return spawnSync("bash", [GATE], {
    env: { ...process.env, COSIGN_URI_CHECK_DEPLOY_SH: deployShPath },
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
    expect(r.stderr).toContain("cannot resolve to a key");
    expect(r.stderr).toContain("Failed to parse uri");
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
