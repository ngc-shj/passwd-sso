import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Self-test for scripts/checks/check-boot-stderr-callers.mjs.
 *
 * The gate exists because `check-console-sinks` proves the SINK is shaped
 * `console.error(message)` while saying nothing about how `message` was built —
 * a leak at the caller passed both that gate and eslint with exit 0. So the
 * cases below are written from the attacker's side: each mutates a caller into
 * a shape that would put an unbounded value on raw stderr, and asserts red.
 *
 * Driven against fixtures via BOOT_STDERR_CALLERS_ROOT rather than patching the
 * real tree — `pre-pr.sh` runs gates concurrently, so an in-place mutation
 * window is observable by other checks (the lesson recorded in the
 * check-console-sinks self-test).
 */

const REPO = resolve(import.meta.dirname, "../..");
const GATE = resolve(REPO, "scripts/checks/check-boot-stderr-callers.mjs");
const MANIFEST = resolve(REPO, "scripts/checks/boot-stderr-callers-manifest.json");

// The gate walks src/, so the fixture needs the callers plus the type files it
// resolves one hop for closed-union detection.
const TREE_FILES = [
  "src/lib/boot-stderr.ts",
  "src/lib/env.ts",
  "src/lib/security/csp-builder.ts",
  "src/lib/key-provider/base-cloud-provider.ts",
  "src/lib/key-provider/types.ts",
];

let root;
let manifestPath;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "boot-stderr-callers-"));
  for (const rel of TREE_FILES) {
    const dst = join(root, rel);
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(join(REPO, rel), dst);
  }
  manifestPath = join(root, "manifest.json");
  cpSync(MANIFEST, manifestPath);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function runGate() {
  try {
    execFileSync("node", [GATE], {
      cwd: REPO,
      env: {
        ...process.env,
        BOOT_STDERR_CALLERS_ROOT: root,
        BOOT_STDERR_CALLERS_MANIFEST: manifestPath,
      },
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
  writeFileSync(path, src.replace(from, to), "utf8");
}

function writeManifest(obj) {
  writeFileSync(manifestPath, JSON.stringify(obj), "utf8");
}

describe("check-boot-stderr-callers", () => {
  it("passes on the current tree", () => {
    expect(runGate().code).toBe(0);
  });

  it("rejects a secret interpolated into the message", () => {
    // The exact leak proven to slip past check-console-sinks AND eslint.
    patch(
      "src/lib/security/csp-builder.ts",
      'bootStderr(\n    `[CSP] CSP_MODE is set to an unsupported value',
      'bootStderr(\n    `[CSP] token=${process.env.AUTH_SECRET} ',
    );
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toMatch(/interpolates unproven expression/);
  });

  it("rejects a bare identifier whose construction the gate cannot see", () => {
    patch(
      "src/lib/env.ts",
      "bootStderr(\n      `\\n${\"=\".repeat(60)}",
      "bootStderr(\n      leaked ?? `\\n${\"=\".repeat(60)}",
    );
    const { code, output } = runGate();
    expect(code).toBe(1);
    // A `??` expression is neither a literal nor a template — unprovable.
    expect(output).toMatch(/cannot prove secret-free|bare identifier/);
  });

  it("rejects echoing the raw rejected env value back to stderr", () => {
    // The real gap this gate found: `_rawCspMode` is arbitrary operator input,
    // reaching the log line precisely BECAUSE it is not one of the two modes.
    patch(
      "src/lib/security/csp-builder.ts",
      "is set to an unsupported value and is ignored",
      'is "${_rawCspMode}" and is ignored',
    );
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toMatch(/_rawCspMode/);
  });

  it("rejects widening a closed-union parameter back to string", () => {
    // Directly pins the fix: with `name: string` the interpolation at the
    // bootStderr call is no longer provably bounded.
    patch(
      "src/lib/key-provider/base-cloud-provider.ts",
      "private logStaleWarning(name: KeyName,",
      "private logStaleWarning(name: string,",
    );
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toMatch(/interpolates unproven expression\(s\): name/);
  });

  it("rejects an aliased import used to dodge callee-name matching", () => {
    // client-events.ts records that an ESLint selector on the callee name was
    // bypassed by exactly this. The gate resolves the import binding instead.
    patch(
      "src/lib/security/csp-builder.ts",
      'import { bootStderr } from "@/lib/boot-stderr";',
      'import { bootStderr as emit } from "@/lib/boot-stderr";',
    );
    patch("src/lib/security/csp-builder.ts", "bootStderr(\n    `[CSP]", "emit(\n    `[CSP]");
    patch(
      "src/lib/security/csp-builder.ts",
      "is set to an unsupported value and is ignored",
      'is "${_rawCspMode}" and is ignored',
    );
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toMatch(/_rawCspMode/);
  });

  it("rejects a stale manifest entry", () => {
    writeManifest({ exempt_files: { "src/lib/does-not-call-it.ts": "gone" } });
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toMatch(/Stale manifest entry/);
  });

  it("allows an unsafe call only when the file is on the manifest", () => {
    patch(
      "src/lib/security/csp-builder.ts",
      "is set to an unsupported value and is ignored",
      'is "${_rawCspMode}" and is ignored',
    );
    expect(runGate().code).toBe(1);

    writeManifest({
      exempt_files: { "src/lib/security/csp-builder.ts": "documented for this test" },
    });
    expect(runGate().code).toBe(0);
  });

  it("detects a call made through a namespace import", () => {
    // Reported bypass, reproduced before fixing: with named-import matching
    // only, this file was not even COUNTED as a caller — so no manifest entry
    // could have caught it either. A detection gap beats a classification gap.
    writeFileSync(
      join(root, "src/lib/ns-caller.ts"),
      [
        'import * as stderr from "@/lib/boot-stderr";',
        "export function leak() {",
        "  stderr.bootStderr(`v=${process.env.AUTH_SECRET}`);",
        "}",
      ].join("\n"),
      "utf8",
    );
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toMatch(/ns-caller\.ts/);
  });

  it("detects a call made through a re-exporting barrel", () => {
    writeFileSync(
      join(root, "src/lib/barrel.ts"),
      'export { bootStderr } from "@/lib/boot-stderr";\n',
      "utf8",
    );
    writeFileSync(
      join(root, "src/lib/barrel-caller.ts"),
      [
        'import { bootStderr } from "@/lib/barrel";',
        "export function leak() {",
        "  bootStderr(`v=${process.env.AUTH_SECRET}`);",
        "}",
      ].join("\n"),
      "utf8",
    );
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toMatch(/barrel-caller\.ts/);
  });

  it("rejects a string[]-returning helper that reads process.env", () => {
    // A return-type annotation says what SHAPE comes out, never where it came
    // from. `function values(): string[] { return [process.env.SECRET!] }`
    // satisfies the annotation while returning a credential.
    writeFileSync(
      join(root, "src/lib/leaky-helper.ts"),
      [
        'import { bootStderr } from "@/lib/boot-stderr";',
        "function values(): string[] {",
        "  return [process.env.AUTH_SECRET!];",
        "}",
        "export function leak() {",
        '  bootStderr(`value=${values().join(",")}`);',
        "}",
      ].join("\n"),
      "utf8",
    );
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toMatch(/leaky-helper\.ts/);
  });

  it("rejects a this.<prop> whose declared type is a bare string", () => {
    // `this.name` was accepted by text match while the declaration was
    // `abstract readonly name: string` — a provider deriving its name from
    // config could have put that value on stderr unchecked.
    patch(
      "src/lib/key-provider/base-cloud-provider.ts",
      "abstract readonly name: ProviderName;",
      "abstract readonly name: string;",
    );
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toMatch(/this\.name/);
  });

  it("does not treat an imported type as closed without resolving it", () => {
    // Fail-open guard: if the gate assumed any imported annotation were a
    // closed union, `name: SomethingUnresolvable` would satisfy it.
    patch(
      "src/lib/key-provider/base-cloud-provider.ts",
      "private logStaleWarning(name: KeyName,",
      "private logStaleWarning(name: NotARealClosedType,",
    );
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toMatch(/interpolates unproven expression\(s\): name/);
  });
});
