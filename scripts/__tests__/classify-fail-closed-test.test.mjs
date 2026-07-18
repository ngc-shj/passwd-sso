/**
 * Self-test for scripts/checks/classify-fail-closed-test.mjs — the AST
 * classifier behind check-fail-closed-routes-have-test.sh.
 *
 * The classifier exists precisely because text matching cannot distinguish
 * code from comments/labels; these cases pin that distinction per field
 * (import / calls / mock / redis) so a regression back toward text-shaped
 * detection fails here, independently of the gate's own fixture suite.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const CLASSIFIER = join(REPO_ROOT, "scripts/checks/classify-fail-closed-test.mjs");

function classify(content) {
  const dir = mkdtempSync(join(tmpdir(), "classify-fc-"));
  const file = join(dir, "route.test.ts");
  writeFileSync(file, content, "utf8");
  try {
    const r = spawnSync("node", [CLASSIFIER, file], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const record = r.stdout.trim().split("\t")[1];
    const fields = {};
    for (const part of record.split(" ")) {
      const [k, v] = part.split("=");
      fields[k] = Number(v);
    }
    return fields;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("classify-fail-closed-test.mjs", () => {
  it("recognizes a genuine helper contract test (import + calls, no mock)", () => {
    const f = classify(`import { assertRedisFailClosed } from "@/__tests__/helpers/fail-closed";
await assertRedisFailClosed({ failure: { allowed: false, redisErrored: true } });
await assertRedisFailClosed({ failure: { allowed: false, redisErrored: true } });
`);
    expect(f).toMatchObject({ exists: 1, import: 1, calls: 2, mock: 0, redis: 1 });
  });

  it("ignores import + call inside a block comment (calls=0, import=0)", () => {
    const f = classify(`/*
import { assertRedisFailClosed } from "@/__tests__/helpers/fail-closed";
await assertRedisFailClosed({ failure: { allowed: false, redisErrored: true } });
*/
it("placeholder", () => {});
`);
    expect(f).toMatchObject({ import: 0, calls: 0, redis: 0 });
  });

  it("ignores redisErrored in a describe label / string literal (redis=0)", () => {
    const f = classify(`describe("rate limiting (redisErrored)", () => {
  it("redisErrored", () => { expect(true).toBe(true); });
});
const s = "redisErrored";
`);
    expect(f.redis).toBe(0);
  });

  it("counts redisErrored as code: property assignment, property access, destructuring", () => {
    expect(classify(`const rl = { allowed: false, redisErrored: true };\n`).redis).toBe(1);
    expect(classify(`if (rl.redisErrored) { throw new Error("x"); }\n`).redis).toBe(1);
    expect(classify(`const { redisErrored } = rl;\n`).redis).toBe(1);
  });

  it("flags vi.mock of the rate-limit-audit module (mock=1)", () => {
    const f = classify(`vi.mock("@/lib/security/rate-limit-audit", () => ({ emitRateLimitFailClosed: vi.fn() }));\n`);
    expect(f.mock).toBe(1);
  });

  it("does not flag vi.mock of an unrelated module (mock=0)", () => {
    const f = classify(`vi.mock("@/lib/security/rate-limit", () => ({ createRateLimiter: vi.fn() }));\n`);
    expect(f.mock).toBe(0);
  });

  it("flags a checkRateLimitOrFail property stub and the mockCheckRateLimitOrFail identifier (mock=1)", () => {
    expect(classify(`const m = { checkRateLimitOrFail: vi.fn() };\n`).mock).toBe(1);
    expect(classify(`mockCheckRateLimitOrFail.mockResolvedValueOnce(null);\n`).mock).toBe(1);
  });

  it("does not flag the helper import name mentioned only in comments (mock stays 0, text-shape guard)", () => {
    const f = classify(`// mockCheckRateLimitOrFail was removed here (T1); production mapping runs.\nconst x = 1;\n`);
    expect(f.mock).toBe(0);
  });

  it("reports a missing file as exists=0 with all fields zero", () => {
    const r = spawnSync("node", [CLASSIFIER, "/nonexistent/route.test.ts"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("exists=0 import=0 calls=0 mock=0 redis=0");
  });

  it("exits 1 when invoked without arguments (fail closed, no silent empty output)", () => {
    const r = spawnSync("node", [CLASSIFIER], { encoding: "utf8" });
    expect(r.status).toBe(1);
  });
});
