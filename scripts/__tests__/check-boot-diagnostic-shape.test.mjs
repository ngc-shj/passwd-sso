import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Self-test for scripts/checks/check-boot-diagnostic-shape.mjs.
 *
 * The gate guards one invariant: the boot sink's input type stays closed. Its
 * predecessor inspected call sites and was escaped nine times across three
 * review rounds; the guarantee now lives in the type, and the only way to lose
 * it silently is to WIDEN that type while every call site still compiles. Each
 * case below performs exactly that widening and asserts red.
 *
 * Driven against fixtures via BOOT_DIAGNOSTIC_ROOT rather than patching the real
 * tree — pre-pr.sh runs gates concurrently, so an in-place mutation window is
 * observable by other checks.
 */

const REPO = resolve(import.meta.dirname, "../..");
const GATE = resolve(REPO, "scripts/checks/check-boot-diagnostic-shape.mjs");

const TREE_FILES = [
  "src/lib/boot-events.ts",
  "src/lib/boot-stderr.ts",
  "src/lib/key-provider/types.ts",
];

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

  it("rejects a bare string field on a diagnostic member", () => {
    // The regression the whole design exists to prevent: one `string` field and
    // every call site still compiles while arbitrary text reaches raw stderr.
    patch("src/lib/boot-events.ts", "elapsedSec: number;", "elapsedSec: number;\n      detail: string;");
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toMatch(/property `detail` is typed `string`/);
  });

  it("rejects widening a branded field to string", () => {
    patch(
      "src/lib/boot-events.ts",
      "variables: readonly EnvVarName[];",
      "variables: readonly string[];",
    );
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toMatch(/property `variables`/);
  });

  it("rejects widening a closed union field to string", () => {
    patch("src/lib/boot-events.ts", "provider: ProviderName;", "provider: string;");
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toMatch(/property `provider` is typed `string`/);
  });

  it("rejects an imported type that is no longer a closed union", () => {
    // Loosening ProviderName in its declaring file must not read as closed here
    // — the gate resolves the import rather than trusting the name.
    patch(
      "src/lib/key-provider/types.ts",
      'export type ProviderName = "env" | "aws-sm" | "gcp-sm" | "azure-kv";',
      "export type ProviderName = string;",
    );
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toMatch(/property `provider`/);
  });

  it("rejects the sink parameter being widened back to string", () => {
    patch(
      "src/lib/boot-stderr.ts",
      "export function bootStderr(diagnostic: BootDiagnostic): void {",
      "export function bootStderr(diagnostic: string): void {",
    );
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toMatch(/expected `BootDiagnostic`/);
  });

  it("rejects a second sink parameter", () => {
    patch(
      "src/lib/boot-stderr.ts",
      "export function bootStderr(diagnostic: BootDiagnostic): void {",
      "export function bootStderr(diagnostic: BootDiagnostic, extra: string): void {",
    );
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toMatch(/takes 2 parameters/);
  });

  it("rejects envVarName asserting the brand without validating", () => {
    // The `opaque()` failure mode recorded elsewhere in this repo: a brand
    // applied without a check means envVarName(secret) compiles and passes.
    patch(
      "src/lib/boot-events.ts",
      "return ENV_VAR_NAME_RE.test(raw) ? (raw as EnvVarName) : NOT_A_VAR_NAME;",
      "return raw as EnvVarName;",
    );
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toMatch(/does not validate its input/);
  });

  it("rejects EnvVarName losing its brand", () => {
    patch(
      "src/lib/boot-events.ts",
      "export type EnvVarName = string & { readonly [envVarNameBrand]: true };",
      "export type EnvVarName = string;",
    );
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toMatch(/must stay branded/);
  });

  it("fails loudly when the sink file moves rather than reporting OK", () => {
    // A gate that finds nothing must not read as green.
    rmSync(join(root, "src/lib/boot-stderr.ts"));
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toMatch(/did the boot sink move/);
  });

  it("fails when BootDiagnostic is deleted entirely", () => {
    const path = join(root, "src/lib/boot-events.ts");
    const src = readFileSync(path, "utf8");
    writeFileSync(path, src.replace(/export type BootDiagnostic =[\s\S]*$/, ""), "utf8");
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toMatch(/BootDiagnostic` is gone/);
  });
});
