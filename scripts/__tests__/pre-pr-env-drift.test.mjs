/**
 * Tests for pre-pr.sh / check:env-docs npm script wiring (Step 10 §E, T7/T18).
 *
 * T18: Do NOT spawn full scripts/pre-pr.sh (it would recursively invoke vitest).
 * Instead:
 *   1. Spawn only the npm script with a broken fixture root.
 *   2. Grep-assert that pre-pr.sh contains the check:env-docs wiring.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const FIXTURES = resolve(__dirname, "fixtures", "env-drift");

// ── env snapshot / restore ────────────────────────────────────────────────────

let origEnv;
beforeEach(() => { origEnv = { ...process.env }; });
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in origEnv)) delete process.env[k];
  for (const [k, v] of Object.entries(origEnv)) process.env[k] = v;
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("pre-pr.sh env drift wiring (T18)", () => {
  it("`npm run check:env-docs` exits 1 when sidecar is broken (extra-key fixture)", () => {
    // Spawn the npm script directly with a broken fixture root.
    // Uses the extra-key fixture: .env.example has a key absent from the schema.
    const result = spawnSync(
      "npx",
      ["tsx", resolve(REPO_ROOT, "scripts", "check-env-docs.ts"), "--root", resolve(FIXTURES, "extra-key")],
      {
        env: { PATH: process.env.PATH },
        encoding: "utf8",
        timeout: 30_000,
        cwd: REPO_ROOT,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/example-vs-zod/);
  });

  it("`scripts/pre-pr.sh` contains the check:env-docs wiring", () => {
    const prePrContent = readFileSync(
      resolve(REPO_ROOT, "scripts", "pre-pr.sh"),
      "utf8",
    );

    // Verify the run_step call wires the env drift check.
    expect(prePrContent).toMatch(
      /run_step\s+"Static: env drift check"\s+npm run check:env-docs/,
    );
  });
});
