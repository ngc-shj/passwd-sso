/**
 * Env-contract test for scripts/audit-anchor-publisher.ts --validate-env-only.
 *
 * Each case spawns the publisher with ONLY the env it names (env -i
 * semantics) from an empty temp cwd, so neither the parent env nor a
 * developer's .env / .env.local can supply a value the case means to omit.
 * No database is touched: --validate-env-only exits before connecting.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const WORKER = resolve(REPO_ROOT, "scripts", "audit-anchor-publisher.ts");

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const DEPLOYMENT_ID = "550e8400-e29b-41d4-a716-446655440000";
const PUBLISHER_URL = "postgresql://passwd_anchor_publisher:p@db:5432/passwd_sso";

/** The publisher task's env, as production gives it: no DATABASE_URL, the publisher URL is its own. */
const TASK_ENV = {
  NODE_ENV: "production",
  AUDIT_ANCHOR_PUBLISHER_ENABLED: "true",
  DEPLOYMENT_ID,
  AUDIT_ANCHOR_SIGNING_KEY: HEX_A,
  AUDIT_ANCHOR_TAG_SECRET: HEX_B,
  AUDIT_ANCHOR_PUBLISHER_DATABASE_URL: PUBLISHER_URL,
  AUDIT_ANCHOR_DESTINATION_S3_BUCKET: "anchors",
  AUDIT_ANCHOR_DESTINATION_S3_PREFIX: "audit-anchors",
};

let cwd;
beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), "anchor-publisher-env-"));
});
afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function spawnPublisher(env) {
  return spawnSync(
    resolve(REPO_ROOT, "node_modules/.bin/tsx"),
    ["--tsconfig", resolve(REPO_ROOT, "tsconfig.json"), WORKER, "--validate-env-only"],
    { env: { PATH: process.env.PATH, ...env }, encoding: "utf8", timeout: 30_000, cwd },
  );
}

function jsonLines(text) {
  const out = [];
  for (const line of text.split("\n")) {
    try {
      out.push(JSON.parse(line.trim()));
    } catch {
      // skip non-JSON lines (dotenv banners)
    }
  }
  return out;
}

function errorPaths(result) {
  return jsonLines(result.stderr)
    .filter((l) => l.msg === "env validation failed")
    .map((l) => l.path);
}

describe("audit-anchor-publisher --validate-env-only", () => {
  it("exits 0 with the task env, printing destinations ready then env validation passed", () => {
    const result = spawnPublisher(TASK_ENV);

    expect(result.status).toBe(0);
    const msgs = jsonLines(result.stdout).map((l) => l.msg);
    expect(msgs).toEqual(["destinations ready", "env validation passed"]);
    expect(jsonLines(result.stdout)[0]).toEqual({
      level: "info",
      msg: "destinations ready",
      destinations: ["s3-object-lock"],
    });
  });

  it("exits 1 in production with only DATABASE_URL (no fallback)", () => {
    const { AUDIT_ANCHOR_PUBLISHER_DATABASE_URL: _omit, ...env } = TASK_ENV;
    const result = spawnPublisher({ ...env, DATABASE_URL: "postgresql://passwd_app:p@db:5432/passwd_sso" });

    expect(result.status).toBe(1);
    expect(errorPaths(result)).toEqual(["AUDIT_ANCHOR_PUBLISHER_DATABASE_URL"]);
  });

  it.each(["DEPLOYMENT_ID", "AUDIT_ANCHOR_SIGNING_KEY", "AUDIT_ANCHOR_TAG_SECRET"])(
    "exits 1 naming %s when it is missing",
    (name) => {
      const env = { ...TASK_ENV };
      delete env[name];
      const result = spawnPublisher(env);

      expect(result.status).toBe(1);
      expect(errorPaths(result)).toEqual([name]);
    },
  );

  it("exits 1 on a prefix the segment rule refuses, without echoing it", () => {
    const result = spawnPublisher({ ...TASK_ENV, AUDIT_ANCHOR_DESTINATION_S3_PREFIX: "a//b" });

    expect(result.status).toBe(1);
    expect(errorPaths(result)).toEqual(["AUDIT_ANCHOR_DESTINATION_S3_PREFIX"]);
    expect(result.stderr).not.toContain("a//b");
  });

  it("exits 0 when the flag is the string false, with nothing else set", () => {
    const result = spawnPublisher({ AUDIT_ANCHOR_PUBLISHER_ENABLED: "false" });

    expect(result.status).toBe(0);
    expect(jsonLines(result.stdout).map((l) => l.msg)).toEqual(["env validation passed"]);
  });
});
