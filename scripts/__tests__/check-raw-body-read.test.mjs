/**
 * Self-test for scripts/checks/check-raw-body-read.sh — the CI guard that
 * forbids unbounded req.text()/req.arrayBuffer()/req.formData() reads in API
 * route handlers (availability-DoS: unbounded in-memory buffering).
 *
 * Driven against fixtures via the RAW_BODY_READ_* env overrides
 * (API_DIR / ALLOWLIST / PATH_ROOT), mirroring
 * check-permanent-delete-stepup.test.mjs's fixture harness.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GUARD = join(REPO_ROOT, "scripts/checks/check-raw-body-read.sh");

let root;
let apiDir;
let allowlist;

function runGuard(extraEnv = {}) {
  const r = spawnSync("bash", [GUARD], {
    encoding: "utf8",
    env: {
      ...process.env,
      RAW_BODY_READ_API_DIR: apiDir,
      RAW_BODY_READ_ALLOWLIST: allowlist,
      RAW_BODY_READ_PATH_ROOT: root,
      ...extraEnv,
    },
  });
  return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
}

function writeRoute(rel, body) {
  const dir = join(apiDir, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "route.ts"), body, "utf8");
  return `src/app/api/${rel}/route.ts`;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "raw-body-read-"));
  apiDir = join(root, "src/app/api");
  allowlist = join(root, "allowlist.txt");
  mkdirSync(apiDir, { recursive: true });
  writeFileSync(allowlist, "# fixture allowlist\n", "utf8");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-raw-body-read.sh", () => {
  it("FAILS (RAW_BODY_READ) on req.text() with no byte cap", () => {
    const rel = writeRoute(
      "webhooks/inbound",
      "export async function POST(req) {\n  const body = await req.text();\n  return body;\n}\n",
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("RAW_BODY_READ:");
    expect(stdout).toContain(rel);
    expect(stdout).toContain("req.text()/req.arrayBuffer() is forbidden");
  });

  it("passes when the route uses a capped read helper instead", () => {
    writeRoute(
      "webhooks/inbound",
      'import { readBytesWithCap } from "@/lib/http/parse-body";\nexport async function POST(req) {\n  const body = await readBytesWithCap(req);\n  return body;\n}\n',
    );
    const { exitCode } = runGuard();
    expect(exitCode).toBe(0);
  });

  it("FAILS (RAW_BODY_READ) on req.formData() without rejectOversizedMultipart gate", () => {
    const rel = writeRoute(
      "passwords/attachments",
      "export async function POST(req) {\n  const form = await req.formData();\n  return form;\n}\n",
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain(rel);
    expect(stdout).toContain("without rejectOversizedMultipart() gate");
  });

  it("passes when req.formData() is gated by rejectOversizedMultipart in the same file", () => {
    writeRoute(
      "passwords/attachments",
      'import { rejectOversizedMultipart } from "@/lib/http/parse-body";\nexport async function POST(req) {\n  const gate = rejectOversizedMultipart(req);\n  if (gate) return gate;\n  const form = await req.formData();\n  return form;\n}\n',
    );
    const { exitCode } = runGuard();
    expect(exitCode).toBe(0);
  });

  it("passes when an offending route is listed in the allowlist", () => {
    const rel = writeRoute(
      "webhooks/inbound",
      "export async function POST(req) {\n  const body = await req.text();\n  return body;\n}\n",
    );
    writeFileSync(allowlist, `${rel}\n`, "utf8");
    const { exitCode } = runGuard();
    expect(exitCode).toBe(0);
  });

  it("does NOT scan *.test.ts files", () => {
    mkdirSync(join(apiDir, "webhooks/inbound"), { recursive: true });
    writeFileSync(
      join(apiDir, "webhooks/inbound/route.test.ts"),
      "// fixture: exercises req.text() only inside a test file\nawait req.text();\n",
      "utf8",
    );
    const { exitCode } = runGuard();
    expect(exitCode).toBe(0);
  });

  describe("env-pollution guard (sec-F6)", () => {
    it("FAILS when CI=true and an override is set without RAW_BODY_READ_FIXTURE_MODE=1", () => {
      const { exitCode, stdout } = runGuard({ CI: "true" });
      expect(exitCode).toBe(1);
      expect(stdout).toContain("ENV_POLLUTION_GUARD");
    });

    it("passes under CI=true when RAW_BODY_READ_FIXTURE_MODE=1 is set and the fixture tree is clean", () => {
      const { exitCode } = runGuard({ CI: "true", RAW_BODY_READ_FIXTURE_MODE: "1" });
      expect(exitCode).toBe(0);
    });
  });

  describe("real repo (no overrides)", () => {
    it("passes against the actual repo source tree", () => {
      const r = spawnSync("bash", [GUARD], { encoding: "utf8" });
      expect(r.status, r.stdout + r.stderr).toBe(0);
    });
  });
});
