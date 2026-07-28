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

  it("rejects a member extracted to a named alias carrying a string field", () => {
    // Round 2 found this: walking descendants of the WRITTEN node meant a
    // member that is not an inline literal yielded zero properties and the
    // gate printed OK. Extracting a growing union member to its own alias is
    // the most likely edit here, and it disabled the check wholesale.
    patch(
      "src/lib/boot-events.ts",
      "  | { event: typeof BOOT_EVENT.CSP_MODE_IGNORED }",
      "  | CspModeIgnored",
    );
    const path = join(root, "src/lib/boot-events.ts");
    writeFileSync(
      path,
      `${readFileSync(path, "utf8")}\ntype CspModeIgnored = { event: typeof BOOT_EVENT.CSP_MODE_IGNORED; detail: string };\n`,
      "utf8",
    );
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toMatch(/property `detail` is typed `string`/);
  });

  it("rejects a member carrying an index signature", () => {
    patch(
      "src/lib/boot-events.ts",
      "  | { event: typeof BOOT_EVENT.CSP_MODE_IGNORED }",
      "  | { event: typeof BOOT_EVENT.CSP_MODE_IGNORED; [k: string]: string }",
    );
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toMatch(/IndexSignature/);
  });

  it("rejects a member carrying a method signature", () => {
    patch(
      "src/lib/boot-events.ts",
      "  | { event: typeof BOOT_EVENT.CSP_MODE_IGNORED }",
      "  | { event: typeof BOOT_EVENT.CSP_MODE_IGNORED; detail(): string }",
    );
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toMatch(/MethodSignature/);
  });

  it("rejects render() reaching for process state", () => {
    // Rendering moved into the sink, creating a prose-assembly site no gate
    // read. Proven necessary in round 2: a render body interpolating
    // process.env.AUTH_SECRET passed every gate, in the one file where
    // no-console is off.
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

  it("rejects `typeof process.env.X` smuggled in as a property type", () => {
    // The TypeQuery branch exists for `typeof BOOT_EVENT.X`. It used to return
    // true for ANY `typeof <expr>`, so `detail: typeof process.env.AUTH_SECRET`
    // — which resolves to `string | undefined` — passed the gate, the compiler,
    // render's process check and the console sink gate.
    patch(
      "src/lib/boot-events.ts",
      "  | { event: typeof BOOT_EVENT.CSP_MODE_IGNORED }",
      "  | { event: typeof BOOT_EVENT.CSP_MODE_IGNORED; detail: typeof process.env.AUTH_SECRET }",
    );
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toMatch(/property `detail`/);
  });

  it("rejects a discriminant naming a BOOT_EVENT member that does not exist", () => {
    patch(
      "src/lib/boot-events.ts",
      "  | { event: typeof BOOT_EVENT.CSP_MODE_IGNORED }",
      "  | { event: typeof BOOT_EVENT.NOT_A_REAL_MEMBER }",
    );
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toMatch(/property `event`/);
  });

  it("rejects envVarName taking the allowlist as a parameter", () => {
    // The fail-open that replaced the shape predicate: a membership test is
    // only as trustworthy as the set it tests against, so a caller-supplied set
    // means `envVarName(secret, new Set([secret]))` prints the secret.
    patch(
      "src/lib/boot-events.ts",
      "export function envVarName(raw: string): EnvVarName {\n  return DECLARED.find((declared) => declared === raw) ?? NOT_A_VAR_NAME;",
      "export function envVarName(raw: string, allowed: ReadonlySet<string>): EnvVarName {\n  return allowed.has(raw) ? (raw as EnvVarName) : NOT_A_VAR_NAME;",
    );
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toMatch(/caller-supplied allowlist/);
  });

  it("rejects the declared list no longer coming from the env schema", () => {
    patch(
      "src/lib/boot-events.ts",
      'import { getSchemaShape } from "@/lib/env-schema";',
      "const getSchemaShapeStub = () => ({});",
    );
    patch(
      "src/lib/boot-events.ts",
      "const DECLARED = Object.keys(getSchemaShape())",
      "const DECLARED = Object.keys(getSchemaShapeStub())",
    );
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toMatch(/not derived from `@\/lib\/env-schema`/);
  });

  it("rejects a list built elsewhere while the schema import is left in place", () => {
    // The residual an import-existence check cannot see: keep the import, build
    // the list from something else. Substring and import-presence checks both
    // pass; only tying `Object.keys(...)` to the imported binding catches it.
    patch(
      "src/lib/boot-events.ts",
      "const DECLARED = Object.keys(getSchemaShape())",
      'const DECLARED = Object.keys({ ANYTHING: 1, [process.env.AUTH_SECRET ?? ""]: 1 })',
    );
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toMatch(/DECLARED is not/);
  });

  it("accepts the schema accessor imported under an alias", () => {
    // Resolution is on the binding, not the spelling, so a rename stays green.
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

  it("rejects a hand-written DECLARED list", () => {
    patch(
      "src/lib/boot-events.ts",
      "const DECLARED = Object.keys(getSchemaShape()) as unknown as readonly EnvVarName[];",
      'const DECLARED = ["DATABASE_URL"] as unknown as readonly EnvVarName[];',
    );
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toMatch(/DECLARED is not/);
  });

  it("rejects the schema call being evaluated and discarded", () => {
    // The counter-example that defeated the presence check: the safe expression
    // is there, satisfies a search, and feeds nothing.
    patch(
      "src/lib/boot-events.ts",
      "const DECLARED = Object.keys(getSchemaShape()) as unknown as readonly EnvVarName[];",
      "const _unused = Object.keys(getSchemaShape());\n" +
        'const DECLARED = ["DATABASE_URL"] as unknown as readonly EnvVarName[];',
    );
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toMatch(/DECLARED is not/);
  });

  it("rejects envVarName returning something derived from its input", () => {
    // A type predicate is an assertion TypeScript TRUSTS, not one it verifies,
    // so `{ declared().has(raw); return true; }` type-checked and branded
    // everything. Selecting from DECLARED removes the check from the trusted
    // path: whatever comes back is an element of the list.
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

  it("rejects envVarName validating shape instead of selecting from the list", () => {
    // The defect round 2 caught: /^[A-Za-z_][A-Za-z0-9_]{0,63}$/ matches a
    // 64-char hex master key, an AKIA… id, and an api_… token. A predicate over
    // a value's form cannot answer a question about its origin.
    patch(
      "src/lib/boot-events.ts",
      "  return DECLARED.find((declared) => declared === raw) ?? NOT_A_VAR_NAME;",
      "  return /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(raw) ? (raw as EnvVarName) : NOT_A_VAR_NAME;",
    );
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toMatch(/casts to EnvVarName|not return a value selected from/);
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
