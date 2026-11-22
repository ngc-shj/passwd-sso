/**
 * Self-test for check-vitest-coverage-include.mjs. Each fixture row runs the
 * real CLI against an isolated tree (mkdtemp + VITEST_COVERAGE_INCLUDE_ROOT)
 * holding a vitest.config.ts and the files it names; one row runs it against
 * the real repository.
 *
 * Allow: the real config and a minimal fixture config. Deny: every shape the
 * parser cannot read (it used to read those as "nothing to check" and pass),
 * and include/threshold entries that name no file.
 */
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CHECKER = fileURLToPath(new URL("../checks/check-vitest-coverage-include.mjs", import.meta.url));

const dirs = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop(), { recursive: true, force: true });
});

function exec(env) {
  try {
    const stdout = execFileSync("node", [CHECKER], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" };
  }
}

function run(config, extraEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), "vitest-coverage-include-"));
  dirs.push(root);
  const files = { "vitest.config.ts": config, "src/lib/a.ts": "export const a = 1;\n", "proxy.ts": "export {};\n" };
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content, "utf8");
  }
  return exec({
    ...process.env,
    VITEST_COVERAGE_INCLUDE_ROOT: root,
    VITEST_COVERAGE_INCLUDE_FIXTURE_MODE: "1",
    ...extraEnv,
  });
}

const INCLUDE = '["src/**/*.{ts,tsx}", "proxy.ts"]';
const THRESHOLDS = '{ lines: 75, perFile: { lines: 60 }, "src/lib/**": { lines: 90 }, "src/lib/a.ts": { lines: 95 } }';

/** A config shaped like the real one, with `coverage` replaced by `body`. */
const config = (body) =>
  'import { defineConfig } from "vitest/config";\n' +
  "const isCoverageShard = process.env.VITEST_COVERAGE_SHARD === \"1\";\n" +
  'export default defineConfig({ test: { include: ["src/**/*.test.ts"], ' +
  `coverage: { provider: "v8", ${body} } } });\n`;

describe("check-vitest-coverage-include", () => {
  it("passes the real vitest.config.ts", () => {
    const env = { ...process.env };
    delete env.VITEST_COVERAGE_INCLUDE_ROOT;
    const r = exec(env);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^vitest\.config\.ts OK: [1-9]\d* includes resolved, [1-9]\d* thresholds keyed\.$/m);
  });

  it("passes a fixture whose include and thresholds name existing files", () => {
    const r = run(config(`include: ${INCLUDE}, thresholds: isCoverageShard ? undefined : ${THRESHOLDS}`));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("vitest.config.ts OK: 2 includes resolved, 4 thresholds keyed.");
  });

  it.each([
    ["no coverage block", 'import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: {} });\n', "VITEST_COVERAGE_BLOCK_MISSING"],
    ["two coverage blocks", config(`include: ${INCLUDE}, thresholds: ${THRESHOLDS}`) + `export const other = { coverage: { include: ${INCLUDE} } };\n`, "VITEST_COVERAGE_BLOCK_AMBIGUOUS: 2"],
    ["no include", config(`thresholds: ${THRESHOLDS}`), "VITEST_COVERAGE_INCLUDE_MISSING"],
    ["an empty include", config(`include: [], thresholds: ${THRESHOLDS}`), "VITEST_COVERAGE_INCLUDE_EMPTY"],
    ["an include that is not an array literal", config(`include: INCLUDE, thresholds: ${THRESHOLDS}`), "VITEST_COVERAGE_INCLUDE_UNPARSEABLE"],
    ["a non-literal include entry", config(`include: [...INCLUDE], thresholds: ${THRESHOLDS}`), "VITEST_COVERAGE_INCLUDE_UNPARSEABLE: entry `...INCLUDE`"],
    ["no thresholds", config(`include: ${INCLUDE}`), "VITEST_COVERAGE_THRESHOLDS_MISSING"],
    ["thresholds that are not an object literal", config(`include: ${INCLUDE}, thresholds: THRESHOLDS`), "VITEST_COVERAGE_THRESHOLDS_UNPARSEABLE"],
    ["a conditional with no object-literal arm", config(`include: ${INCLUDE}, thresholds: isCoverageShard ? undefined : THRESHOLDS`), "VITEST_COVERAGE_THRESHOLDS_UNPARSEABLE"],
    ["a spread threshold entry", config(`include: ${INCLUDE}, thresholds: { lines: 75, ...FLOORS }`), "VITEST_COVERAGE_THRESHOLDS_UNPARSEABLE: entry `...FLOORS`"],
    ["empty thresholds", config(`include: ${INCLUDE}, thresholds: {}`), "VITEST_COVERAGE_THRESHOLDS_EMPTY"],
  ])("refuses a config with %s", (_label, source, token) => {
    const r = run(source);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(token);
  });

  it("fails a threshold glob key that matches no file", () => {
    const r = run(config(`include: ${INCLUDE}, thresholds: { lines: 75, "src/no-such-dir/**": { lines: 90 } }`));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('coverage.thresholds glob "src/no-such-dir/**" matches no files');
  });

  it("fails a threshold path key naming a file that does not exist", () => {
    const r = run(config(`include: ${INCLUDE}, thresholds: { lines: 75, "src/lib/gone.ts": { lines: 90 } }`));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('coverage.thresholds key "src/lib/gone.ts" is a file path that does not exist');
  });

  it("fails an include glob that matches no file", () => {
    const r = run(config(`include: ["src/**/*.vue", "proxy.ts"], thresholds: ${THRESHOLDS}`));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('coverage.include glob "src/**/*.vue" matches no files');
  });

  it("refuses a root override under CI without the fixture-mode flag", () => {
    const r = run(config(`include: ${INCLUDE}, thresholds: ${THRESHOLDS}`), {
      CI: "true",
      VITEST_COVERAGE_INCLUDE_FIXTURE_MODE: "",
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("VITEST_COVERAGE_INCLUDE_ROOT must not be set in CI");
  });
});
