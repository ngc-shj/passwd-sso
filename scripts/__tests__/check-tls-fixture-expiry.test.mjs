/**
 * Regression tests for check-tls-fixture-expiry.sh.
 *
 * The guard reads iOS TLS test-fixture leaves (tlsLeaf*.p12), extracts ONLY the
 * leaf cert (via `openssl pkcs12 -clcerts`), and fails when a leaf is expiring
 * within the window — OR when a fixture cannot be read (which must NOT be
 * mistaken for "healthy"). These tests pin all three outcomes so the guard is
 * provably able to FAIL, not merely to pass.
 *
 * Isolation: each case builds a throwaway leaf .p12 into a fresh mkdtemp root
 * and points the guard there via TLS_FIXTURE_CHECK_ROOT — never the repo
 * fixtures (mirrors the CTC_CHECK_ROOT idiom of check-count-then-create-lock).
 *
 * The expired case pins explicit past `-not_before`/`-not_after` dates (both in
 * the past, correctly ordered), so the red case is deterministic without
 * freezing the clock. (`-days -1` can't be used: it puts notAfter before
 * notBefore, which openssl rejects outright.)
 *
 * Filesystem + openssl only; Linux-runnable, no macOS/Xcode dependency.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CHECKER = fileURLToPath(
  new URL("../checks/check-tls-fixture-expiry.sh", import.meta.url),
);
const PASS = "passwd-sso-test";

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tls-expiry-check-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function sh(cmd) {
  execFileSync("bash", ["-c", cmd], { stdio: ["ignore", "ignore", "ignore"] });
}

// Build a CA + one leaf p12 (`tlsLeaf<label>.p12`) into `dir`.
//   validity: "valid"   → leaf valid for 400 days (past the guard's 30d window)
//             "expired" → leaf with past, correctly-ordered not_before/not_after
function makeLeafFixture(label, validity) {
  const p12 = join(dir, `tlsLeaf${label}.p12`);
  const signSpec =
    validity === "expired"
      ? `-not_before 20200101000000Z -not_after 20200201000000Z`
      : `-days 400`;
  sh(
    [
      `cd "${dir}"`,
      `openssl ecparam -name prime256v1 -genkey -noout -out ca.key`,
      `openssl req -x509 -new -key ca.key -sha256 -days 3650 -subj "/CN=Test CA" -out ca.crt`,
      `openssl ecparam -name prime256v1 -genkey -noout -out leaf.key`,
      `openssl req -new -key leaf.key -subj "/CN=localhost" -out leaf.csr`,
      `openssl x509 -req -in leaf.csr -CA ca.crt -CAkey ca.key -CAcreateserial ` +
        `${signSpec} -sha256 -out leaf.crt`,
      `openssl pkcs12 -export -inkey leaf.key -in leaf.crt -certfile ca.crt ` +
        `-name "leaf${label}" -passout pass:${PASS} -legacy -out "${p12}"`,
      `rm -f "${dir}/ca.key" "${dir}/ca.crt" "${dir}/leaf.key" "${dir}/leaf.csr" ` +
        `"${dir}/leaf.crt" "${dir}"/*.srl`,
    ].join(" && "),
  );
}

function run(extraEnv = {}) {
  try {
    const stdout = execFileSync("bash", [CHECKER], {
      env: { ...process.env, TLS_FIXTURE_CHECK_ROOT: dir, ...extraEnv },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return {
      code: e.status,
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? "",
    };
  }
}

describe("check-tls-fixture-expiry", () => {
  it("passes when the leaf is valid past the window", () => {
    makeLeafFixture("A", "valid");

    const { code, stdout } = run();

    expect(code).toBe(0);
    expect(stdout).toContain("TLS_FIXTURE_OK");
  });

  it("fails with TLS_FIXTURE_EXPIRING when the leaf is expired", () => {
    makeLeafFixture("A", "expired");

    const { code, stderr } = run();

    expect(code).toBe(1);
    expect(stderr).toContain("TLS_FIXTURE_EXPIRING");
  });

  it("fails with TLS_FIXTURE_UNREADABLE on a wrong passphrase", () => {
    makeLeafFixture("A", "valid");

    const { code, stderr } = run({ TLS_FIXTURE_PASS: "wrong-passphrase" });

    expect(code).toBe(1);
    expect(stderr).toContain("TLS_FIXTURE_UNREADABLE");
  });

  it("fails when no leaf fixtures are present", () => {
    const { code, stderr } = run();

    expect(code).toBe(1);
    expect(stderr).toContain("TLS_FIXTURE_NONE");
  });

  // A partial extraction (openssl pkcs12 emits some PEM bytes but exits
  // non-zero) must be treated as UNREADABLE, not OK — checking only for empty
  // output would let this pass as healthy. A stub openssl reproduces it.
  it("fails with TLS_FIXTURE_UNREADABLE when pkcs12 emits PEM but exits non-zero", () => {
    makeLeafFixture("A", "valid");
    // Extract the real leaf PEM the stub will echo back.
    const leafPem = execFileSync(
      "bash",
      [
        "-c",
        `openssl pkcs12 -in "${join(dir, "tlsLeafA.p12")}" -nokeys -clcerts ` +
          `-passin pass:${PASS} -legacy 2>/dev/null`,
      ],
      { encoding: "utf8" },
    );
    const stubDir = join(dir, "stub");
    mkdirSync(stubDir, { recursive: true });
    const pemFile = join(dir, "leaf.pem");
    writeFileSync(pemFile, leafPem, "utf8");
    // Stub `openssl`: for pkcs12, print valid PEM then exit 1; else defer to real.
    writeFileSync(
      join(stubDir, "openssl"),
      `#!/usr/bin/env bash
if [ "$1" = "pkcs12" ]; then cat "${pemFile}"; exit 1; fi
exec /usr/bin/openssl "$@"
`,
      { mode: 0o755 },
    );

    const { code, stderr } = run({ PATH: `${stubDir}:${process.env.PATH}` });

    expect(code).toBe(1);
    expect(stderr).toContain("TLS_FIXTURE_UNREADABLE");
  });
});
