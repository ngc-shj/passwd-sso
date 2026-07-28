/**
 * Self-test for eslint.extension.config.mjs + scripts/checks/lint-extension.mjs —
 * the gate that keeps autofill payload values and decrypted vault plaintext out of
 * the extension's console (SC5 from #723).
 *
 * Fixtures go through `--stdin --stdin-filename` with a virtual path INSIDE the
 * config's `files` globs. Writing them to an OS temp dir does not work and fails in
 * the direction that hides the problem: ESLint 9 resolves `files` against cwd and
 * reports an out-of-base-path file as a *warning with exit 0*, so every case
 * asserting "clean" would pass without the rules ever running.
 *
 * Assertions are on the rule-id SET, not only the exit status — a run that linted
 * nothing and a run that linted and found nothing are otherwise indistinguishable,
 * which is the exact vacuity this self-test exists to rule out.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONFIG = "eslint.extension.config.mjs";
// Fixture configs live in an OS temp dir, from which a bare "@typescript-eslint/parser"
// specifier does not resolve — import it by absolute path instead.
const PARSER_PATH = join(REPO_ROOT, "node_modules/@typescript-eslint/parser/dist/index.js");

/** Lint `source` as if it lived at `virtualPath`; returns the rule ids reported. */
function lintAs(virtualPath, source) {
  const r = spawnSync(
    "node",
    [
      "node_modules/eslint/bin/eslint.js",
      "--config",
      CONFIG,
      "--stdin",
      "--stdin-filename",
      virtualPath,
      "--format",
      "json",
    ],
    { cwd: REPO_ROOT, input: source, encoding: "utf8" },
  );
  const results = JSON.parse(r.stdout);
  const messages = results.flatMap((f) => f.messages);
  return {
    exitCode: r.status,
    rules: messages.map((m) => m.ruleId ?? "(directive)"),
    messages,
  };
}

const CONTENT = "extension/src/content/probe.ts";

// Every spelling that reaches `console`. Two earlier designs excluded `console` in
// property position so `obj.console` would not be flagged; that same exclusion is
// what blinded them to the `globalThis.console` family, which is why the final rule
// set has no exclusions at all. Each row here is a spelling one of those designs
// let through.
const BYPASS_SPELLINGS = [
  ["direct call", 'declare const x: string; console.log(x);'],
  ["optional chaining", 'declare const x: string; console?.debug?.(x);'],
  ["computed member", 'declare const x: string; console["warn"](x);'],
  ["alias of console", 'declare const x: string; const c = console; c.log(x);'],
  ["destructured method", 'declare const x: string; const { debug } = console; debug(x);'],
  ["captured method", 'declare const x: string; const f = console.debug; f(x);'],
  ["globalThis prefix", 'declare const x: string; globalThis.console.info(x);'],
  ["self prefix", 'declare const x: string; self.console.warn(x);'],
  ["window prefix", 'declare const x: string; window.console.error(x);'],
  ["computed on globalThis", 'declare const x: string; globalThis["console"].log(x);'],
  ["type-asserted global", 'declare const x: string; (globalThis as typeof globalThis).console.log(x);'],
  ["non-null-asserted global", 'declare const x: string; globalThis!.console.log(x);'],
  ["alias of globalThis", 'declare const x: string; const g = globalThis; g.console.log(x);'],
  ["two-hop global", 'declare const x: string; globalThis.self.console.log(x);'],
  ["top frame", 'declare const x: string; top!.console.log(x);'],
  ["parent frame", 'declare const x: string; parent.console.log(x);'],
  ["frames", 'declare const x: string; frames.console.log(x);'],
  ["key-position destructure", 'declare const x: string; const { console: c } = globalThis; c.log(x);'],
  ["string-keyed via variable", 'const k = "console"; export const z = k;'],
  ["Reflect.get", 'export const c = Reflect.get(globalThis, "console");'],
];

describe("eslint.extension.config.mjs", () => {
  describe("bans every console spelling", () => {
    for (const [label, source] of BYPASS_SPELLINGS) {
      it(`rejects ${label}`, () => {
        const { exitCode, rules } = lintAs(CONTENT, source);
        expect(exitCode, `${label} was not rejected`).toBe(1);
        expect(rules).toContain("no-restricted-syntax");
      });
    }
  });

  it("rejects a console call under extension/public — the branch that guards the clipboard document", () => {
    const { exitCode, rules } = lintAs(
      "extension/public/probe.js",
      'var text = "x"; console.log(text);',
    );
    expect(exitCode).toBe(1);
    expect(rules).toContain("no-console");
    expect(rules).toContain("no-restricted-syntax");
  });

  it("is not suppressed by an inline eslint-disable directive", () => {
    const { exitCode, rules } = lintAs(
      CONTENT,
      "declare const p: { email: string };\n" +
        "// eslint-disable-next-line no-console, no-restricted-syntax\n" +
        "console.log(p.email);\n",
    );
    expect(exitCode).toBe(1);
    expect(rules).toContain("no-console");
    expect(rules).toContain("no-restricted-syntax");
  });

  it("permits the two sanctioned sinks to reference console", () => {
    const source = 'export function w(m: string): void { console.warn(m); }';
    for (const sink of [
      "extension/src/content/select-diag-lib.ts",
      "extension/src/background/log.ts",
    ]) {
      const { exitCode, rules } = lintAs(sink, source);
      expect(exitCode, `${sink} should be exempt`).toBe(0);
      expect(rules).toEqual([]);
    }
  });

  it("exempts the test tree, and only the test tree", () => {
    const source = 'declare const x: string; console.log(x);';
    expect(lintAs("extension/src/__tests__/probe.test.ts", source).exitCode).toBe(0);
    // Same source one directory up is still rejected — proves the exemption is
    // scoped rather than accidentally global.
    expect(lintAs(CONTENT, source).exitCode).toBe(1);
  });

  it("reports clean source with no findings at all", () => {
    const { exitCode, rules } = lintAs(
      CONTENT,
      'import { logNoSelectMatch } from "./select-diag-lib";\n' +
        "declare const s: { name: string; id: string };\n" +
        "logNoSelectMatch(s);\n",
    );
    expect(exitCode).toBe(0);
    expect(rules).toEqual([]);
  });
});

describe("scripts/checks/lint-extension.mjs", () => {
  function runGate(env = {}) {
    const r = spawnSync("node", ["scripts/checks/lint-extension.mjs"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  it("passes against the real tree and reports how many files it linted", () => {
    const { exitCode, stdout } = runGate();
    expect(exitCode, stdout).toBe(0);
    // The count is the anti-vacuity evidence: "clean" and "scanned nothing" print
    // differently.
    expect(stdout).toMatch(/lint-extension: \d+ files linted/);
    const linted = Number(stdout.match(/lint-extension: (\d+) files/)[1]);
    expect(linted).toBeGreaterThan(50);
  });

  // ESLint exits 0, silently, when a `files` glob stops matching while the CLI path
  // arguments still exist — so the wrapper, not ESLint, has to catch this.
  it("fails with EMPTY_SCAN when the files glob matches nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "lint-ext-"));
    const cfg = join(dir, "empty.config.mjs");
    writeFileSync(
      cfg,
      `import parser from ${JSON.stringify(PARSER_PATH)};\n` +
        'export default [{ files: ["extensionx/src/**/*.ts"], languageOptions: { parser }, rules: { "no-console": "error" } }];\n',
    );
    try {
      const { exitCode, stderr } = runGate({ EXT_LINT_CONFIG: cfg });
      expect(exitCode).toBe(1);
      expect(stderr).toContain("EMPTY_SCAN");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails with MISSING_COVERAGE when extension/public drops out of the config", () => {
    const dir = mkdtempSync(join(tmpdir(), "lint-ext-"));
    const cfg = join(dir, "src-only.config.mjs");
    writeFileSync(
      cfg,
      `import parser from ${JSON.stringify(PARSER_PATH)};\n` +
        'export default [{ files: ["extension/src/**/*.{ts,tsx,js}"], ignores: ["**/__tests__/**"], languageOptions: { parser }, rules: {} }];\n',
    );
    try {
      const { exitCode, stderr } = runGate({ EXT_LINT_CONFIG: cfg });
      expect(exitCode).toBe(1);
      expect(stderr).toContain("MISSING_COVERAGE");
      expect(stderr).toContain("extension/public/offscreen.js");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
