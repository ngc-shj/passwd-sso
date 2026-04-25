/**
 * Tests for scripts/check-env-docs.ts (Step 10 §E).
 *
 * Each case uses a fixture directory under scripts/__tests__/fixtures/env-drift/.
 * The drift-checker accepts --root <path> to resolve all files relative to the fixture.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const SCRIPT = resolve(REPO_ROOT, "scripts", "check-env-docs.ts");
const FIXTURES = resolve(__dirname, "fixtures", "env-drift");

// ── env snapshot / restore ────────────────────────────────────────────────────

let origEnv;
beforeEach(() => { origEnv = { ...process.env }; });
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in origEnv)) delete process.env[k];
  for (const [k, v] of Object.entries(origEnv)) process.env[k] = v;
});

// ── helpers ───────────────────────────────────────────────────────────────────

function runChecker(rootDir) {
  return spawnSync(
    "npx",
    ["tsx", SCRIPT, "--root", rootDir],
    {
      env: { PATH: process.env.PATH },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("check-env-docs.ts", () => {
  it("returns exit 0 when .env.example is in sync with schema and allowlist", () => {
    const result = runChecker(resolve(FIXTURES, "positive"));
    if (result.status !== 0) {
      // Emit stderr to aid debugging.
      console.error("check-env-docs stderr:", result.stderr);
    }
    expect(result.status).toBe(0);
  });

  it("reports extra key and exits 1 when .env.example has a key absent from schema", () => {
    const result = runChecker(resolve(FIXTURES, "extra-key"));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/example-vs-zod/);
    expect(result.stderr).toMatch(/EXTRA_UNDOCUMENTED_KEY/);
  });

  it("reports missing key and exits 1 when schema declares a key absent from .env.example", () => {
    const result = runChecker(resolve(FIXTURES, "missing-key"));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/zod-vs-example/);
    expect(result.stderr).toMatch(/MISSING_FROM_EXAMPLE/);
  });

  it("reports undocumented key and exits 1 when docker-compose requires a var with no allowlist or schema entry", () => {
    const result = runChecker(resolve(FIXTURES, "compose-missing"));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/compose-vs-zod/);
    expect(result.stderr).toMatch(/UNDOCUMENTED_COMPOSE_VAR/);
  });

  it("reports ambiguous-bucket and exits 1 when an allowlist entry is also declared in Zod", () => {
    const result = runChecker(resolve(FIXTURES, "ambiguous-bucket"));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/allowlist-dead/);
    expect(result.stderr).toMatch(/DATABASE_URL/);
  });

  it("reports stale-entry and exits 1 when an allowlist key is not referenced by compose or consumers[]", () => {
    const result = runChecker(resolve(FIXTURES, "stale-allowlist"));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/stale/i);
    expect(result.stderr).toMatch(/STALE_UNUSED_VAR/);
  });

  it("reports missing-sidecar and exits 1 when Zod declares a key absent from sidecar", () => {
    const result = runChecker(resolve(FIXTURES, "missing-sidecar"));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/sidecar-zod-sync/);
    expect(result.stderr).toMatch(/MISSING_SIDECAR_KEY/);
  });

  it("reports duplicate and exits 1 when .env.example has two DATABASE_URL= lines", () => {
    const result = runChecker(resolve(FIXTURES, "duplicate-key"));
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/duplicates/);
    expect(result.stderr).toMatch(/DATABASE_URL/);
  });
});
