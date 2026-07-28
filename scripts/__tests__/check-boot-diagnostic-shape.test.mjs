import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Self-test for scripts/checks/check-boot-diagnostic-shape.mjs.
 *
 * That gate now covers only the INTERNAL invariants — the body-level facts a
 * declaration file says nothing about. The public surface moved to
 * check-public-contract.mjs and is exercised by its own self-test.
 *
 * Each case mutates the invariant it names and asserts red, driven against
 * fixtures via BOOT_DIAGNOSTIC_ROOT rather than patching the real tree, since
 * pre-pr.sh runs gates concurrently.
 */

const REPO = resolve(import.meta.dirname, "../..");
const GATE = resolve(REPO, "scripts/checks/check-boot-diagnostic-shape.mjs");

const TREE_FILES = ["src/lib/boot-events.ts", "src/lib/boot-stderr.ts"];

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "boot-diagnostic-"));
  for (const rel of TREE_FILES) {
    const dst = join(root, rel);
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(join(REPO, rel), dst);
  }
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function runGate() {
  try {
    execFileSync("node", [GATE], {
      cwd: REPO,
      env: { ...process.env, BOOT_DIAGNOSTIC_ROOT: root },
      encoding: "utf8",
      stdio: "pipe",
    });
    return { code: 0, output: "" };
  } catch (err) {
    return { code: err.status ?? 1, output: `${err.stdout}${err.stderr}` };
  }
}

function patch(file, from, to) {
  const path = join(root, file);
  const src = readFileSync(path, "utf8");
  expect(src).toContain(from);
  // Anchors must be unique, or a case could silently patch the wrong occurrence.
  expect(src.split(from)).toHaveLength(2);
  writeFileSync(path, src.replace(from, to), "utf8");
}

describe("check-boot-diagnostic-shape", () => {
  it("passes on the current tree", () => {
    expect(runGate().code).toBe(0);
  });

  describe("DECLARED is the schema's key list", () => {
    it("rejects a hand-written list", () => {
      patch(
        "src/lib/boot-events.ts",
        "const DECLARED = Object.keys(getSchemaShape()) as unknown as readonly EnvVarName[];",
        'const DECLARED = ["DATABASE_URL"] as unknown as readonly EnvVarName[];',
      );
      const { code, output } = runGate();
      expect(code).toBe(1);
      expect(output).toMatch(/DECLARED is/);
    });

    it("rejects the schema call being evaluated and discarded", () => {
      // The counter-example that defeated a presence check: the safe expression
      // is there, satisfies a search, and feeds nothing.
      patch(
        "src/lib/boot-events.ts",
        "const DECLARED = Object.keys(getSchemaShape()) as unknown as readonly EnvVarName[];",
        "const _unused = Object.keys(getSchemaShape());\n" +
          'const DECLARED = ["DATABASE_URL"] as unknown as readonly EnvVarName[];',
      );
      const { code, output } = runGate();
      expect(code).toBe(1);
      expect(output).toMatch(/DECLARED is/);
    });

    it("rejects a list built elsewhere while the schema import is left in place", () => {
      patch(
        "src/lib/boot-events.ts",
        "const DECLARED = Object.keys(getSchemaShape())",
        'const DECLARED = Object.keys({ ANYTHING: 1, [process.env.AUTH_SECRET ?? ""]: 1 })',
      );
      const { code, output } = runGate();
      expect(code).toBe(1);
      expect(output).toMatch(/DECLARED is/);
    });

    it("accepts the schema accessor imported under an alias", () => {
      // Resolution is on the binding, not the spelling.
      patch(
        "src/lib/boot-events.ts",
        'import { getSchemaShape } from "@/lib/env-schema";',
        'import { getSchemaShape as schemaShape } from "@/lib/env-schema";',
      );
      patch(
        "src/lib/boot-events.ts",
        "const DECLARED = Object.keys(getSchemaShape())",
        "const DECLARED = Object.keys(schemaShape())",
      );
      expect(runGate().code).toBe(0);
    });
  });

  describe("the sentinel is fixed and cannot pass for a real name", () => {
    it("rejects a sentinel computed from process state", () => {
      // A live leak: this value is returned on every unmatched lookup.
      patch(
        "src/lib/boot-events.ts",
        'const NOT_A_VAR_NAME = "<unnamed>" as EnvVarName;',
        "const NOT_A_VAR_NAME = process.env.AUTH_SECRET as EnvVarName;",
      );
      const { code, output } = runGate();
      expect(code).toBe(1);
      expect(output).toMatch(/not a string literal/);
    });

    it("rejects a sentinel that looks like a real variable name", () => {
      patch(
        "src/lib/boot-events.ts",
        'const NOT_A_VAR_NAME = "<unnamed>" as EnvVarName;',
        'const NOT_A_VAR_NAME = "DATABASE_URL" as EnvVarName;',
      );
      const { code, output } = runGate();
      expect(code).toBe(1);
      expect(output).toMatch(/shaped like a real environment variable name/);
    });

    it("accepts another non-colliding sentinel", () => {
      // The rule is the property, not the spelling.
      patch(
        "src/lib/boot-events.ts",
        'const NOT_A_VAR_NAME = "<unnamed>" as EnvVarName;',
        'const NOT_A_VAR_NAME = "<none>" as EnvVarName;',
      );
      expect(runGate().code).toBe(0);
    });
  });

  describe("envVarName selects rather than re-brands", () => {
    it("rejects returning the input under a cast", () => {
      patch(
        "src/lib/boot-events.ts",
        "  return DECLARED.find((declared) => declared === raw) ?? NOT_A_VAR_NAME;",
        "  return raw as EnvVarName;",
      );
      const { code, output } = runGate();
      expect(code).toBe(1);
      expect(output).toMatch(/casts to EnvVarName|not return a value selected from/);
    });

    it("rejects selecting from a list other than DECLARED", () => {
      patch(
        "src/lib/boot-events.ts",
        "  return DECLARED.find((declared) => declared === raw) ?? NOT_A_VAR_NAME;",
        "  return [raw].find((declared) => declared === raw) as EnvVarName ?? NOT_A_VAR_NAME;",
      );
      const { code, output } = runGate();
      expect(code).toBe(1);
      expect(output).toMatch(/casts to EnvVarName|not return a value selected from/);
    });

    it("rejects a shape predicate in place of a lookup", () => {
      patch(
        "src/lib/boot-events.ts",
        "  return DECLARED.find((declared) => declared === raw) ?? NOT_A_VAR_NAME;",
        "  return /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(raw) ? (raw as EnvVarName) : NOT_A_VAR_NAME;",
      );
      const { code, output } = runGate();
      expect(code).toBe(1);
      expect(output).toMatch(/casts to EnvVarName|not return a value selected from/);
    });

    it("rejects a caller-supplied allowlist parameter", () => {
      patch(
        "src/lib/boot-events.ts",
        "export function envVarName(raw: string): EnvVarName {\n  return DECLARED.find((declared) => declared === raw) ?? NOT_A_VAR_NAME;",
        "export function envVarName(raw: string, allowed: ReadonlySet<string>): EnvVarName {\n  return allowed.has(raw) ? (raw as EnvVarName) : NOT_A_VAR_NAME;",
      );
      const { code, output } = runGate();
      expect(code).toBe(1);
      expect(output).toMatch(/expected 1/);
    });
  });

  describe("render builds text only from the diagnostic", () => {
    it("rejects render() reaching for process state", () => {
      patch(
        "src/lib/boot-stderr.ts",
        "    case BOOT_EVENT.CSP_MODE_IGNORED:",
        "    case BOOT_EVENT.CSP_MODE_IGNORED:\n      return `${process.env.AUTH_SECRET}`;",
      );
      const { code, output } = runGate();
      expect(code).toBe(1);
      expect(output).toMatch(/render\(\) reads `process`/);
    });

    it("rejects the sink importing anything beyond boot-events", () => {
      patch(
        "src/lib/boot-stderr.ts",
        'import { BOOT_EVENT, type BootDiagnostic } from "@/lib/boot-events";',
        'import { BOOT_EVENT, type BootDiagnostic } from "@/lib/boot-events";\nimport { env } from "@/lib/env";',
      );
      const { code, output } = runGate();
      expect(code).toBe(1);
      expect(output).toMatch(/may import only/);
    });
  });

  it("fails loudly when the sink file moves rather than reporting OK", () => {
    // A gate that finds nothing must not read as green.
    rmSync(join(root, "src/lib/boot-stderr.ts"));
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toMatch(/did the boot sink move/);
  });
});
