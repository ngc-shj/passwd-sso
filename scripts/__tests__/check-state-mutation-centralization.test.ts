/**
 * Self-test for scripts/check-state-mutation-centralization.ts.
 *
 * Runs the AST guard against the known-bad and known-good fixtures to verify:
 *   - Bad fixture (inline status mutation)  → exit code 1 + violation line in output
 *   - Good fixture (no status in data)       → exit code 0 + no violation
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const SCRIPT = resolve(ROOT, "scripts/check-state-mutation-centralization.ts");
const FIXTURES = resolve(ROOT, "scripts/__fixtures__");

function run(fixturePath: string): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync(
      "npx",
      ["tsx", SCRIPT, "--fixture", fixturePath],
      { encoding: "utf8", timeout: 60_000, cwd: ROOT },
    );
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      exitCode: e.status ?? 1,
    };
  }
}

describe("check-state-mutation-centralization", () => {
  it("exits 1 and reports violation on the bad fixture", () => {
    const badFixture = resolve(FIXTURES, "state-mutation-bad.ts");
    const { exitCode, stderr } = run(badFixture);

    expect(exitCode).toBe(1);
    // Output should contain the fixture filename and the violation marker
    expect(stderr).toContain("state-mutation-bad.ts");
    expect(stderr).toContain("data:{status:...} mutation outside allowlist");
  });

  it("exits 0 with no violation on the good fixture", () => {
    const goodFixture = resolve(FIXTURES, "state-mutation-good.ts");
    const { exitCode, stdout, stderr } = run(goodFixture);

    expect(exitCode).toBe(0);
    // Must not flag anything
    expect(stderr).not.toContain("data:{status:...}");
    expect(stdout).toContain("OK");
  });
});
