import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Self-test for scripts/checks/check-public-contract.mjs.
 *
 * The cases below are the five escapes that defeated the previous
 * syntax-scanning gate, one review round each:
 *
 *   `<EnvVarName>x` instead of `as EnvVarName`
 *   a type predicate, which needs no assertion syntax at all
 *   a helper named after a permitted owner
 *   a same-name re-export swapping the implementation
 *   a value/type namespace collision
 *
 * They are kept NOT as per-syntax detectors — the mechanism has no notion of
 * syntax — but as evidence that the baseline rejects each of them for the one
 * reason it knows: the emitted declarations no longer match. The assertions
 * therefore check the diff, not a construct name. A sixth spelling nobody has
 * thought of is covered by the same line.
 *
 * The real source tree is mutated here rather than a fixture copy, because the
 * gate compiles through the project's module graph and a partial copy would not
 * resolve `@/lib/env-schema`. Every case restores the file in `afterEach`, and
 * the baseline is redirected to a temp path so the tracked one is never touched.
 */

const REPO = resolve(import.meta.dirname, "../..");
const GATE = resolve(REPO, "scripts/checks/check-public-contract.mjs");
const TRACKED_BASELINE = resolve(REPO, "scripts/checks/boot-public-contract.d.txt");
const EVENTS = resolve(REPO, "src/lib/boot-events.ts");

let tmpBaseline;
let pristine;

beforeEach(() => {
  pristine = readFileSync(EVENTS, "utf8");
  const dir = mkdtempSync(join(tmpdir(), "public-contract-test-"));
  tmpBaseline = join(dir, "baseline.d.txt");
  writeFileSync(tmpBaseline, readFileSync(TRACKED_BASELINE, "utf8"), "utf8");
});

afterEach(() => {
  writeFileSync(EVENTS, pristine, "utf8");
  rmSync(tmpBaseline, { force: true });
});

function runGate(args = []) {
  try {
    execFileSync("node", [GATE, ...args], {
      cwd: REPO,
      env: { ...process.env, PUBLIC_CONTRACT_BASELINE: tmpBaseline },
      encoding: "utf8",
      stdio: "pipe",
    });
    return { code: 0, output: "" };
  } catch (err) {
    return { code: err.status ?? 1, output: `${err.stdout}${err.stderr}` };
  }
}

function append(source) {
  writeFileSync(EVENTS, `${readFileSync(EVENTS, "utf8")}\n${source}\n`, "utf8");
}

describe("check-public-contract", () => {
  it("passes on the current tree", () => {
    expect(runGate().code).toBe(0);
  });

  it("leaves the tracked baseline alone when verifying", () => {
    const before = readFileSync(TRACKED_BASELINE, "utf8");
    append("export const somethingElse = 1;");
    expect(runGate().code).toBe(1);
    expect(readFileSync(TRACKED_BASELINE, "utf8")).toBe(before);
  });

  describe("rejects a widened surface, whatever syntax produced it", () => {
    const escapes = [
      {
        name: "old-style assertion helper",
        source:
          "export function unsafeName(s: string): EnvVarName {\n  return <EnvVarName>s;\n}",
        surfaces: "export declare function unsafeName(s: string): EnvVarName;",
      },
      {
        name: "type predicate, no assertion syntax at all",
        source:
          "export function unsafeName(s: string): s is ReturnType<typeof envVarName> {\n  return true;\n}",
        surfaces: "s is ReturnType<typeof envVarName>",
      },
      {
        name: "helper named after a permitted owner",
        source:
          "export function variables(s: string): s is EnvVarName {\n  return true;\n}",
        surfaces: "export declare function variables(s: string): s is EnvVarName;",
      },
      {
        name: "value/type namespace collision",
        source:
          "export function BootDiagnostic(s: string): ReturnType<typeof envVarName> {\n  return JSON.parse(JSON.stringify(s));\n}",
        surfaces: "export declare function BootDiagnostic",
      },
      {
        name: "anonymous default export",
        source:
          "export default (s: string): ReturnType<typeof envVarName> =>\n  JSON.parse(JSON.stringify(s));",
        surfaces: "export default",
      },
    ];

    for (const escape of escapes) {
      it(escape.name, () => {
        append(escape.source);
        const { code, output } = runGate();
        expect(code).toBe(1);
        // The mechanism's only reason: the declarations moved. Asserted on the
        // diff rather than on a construct the gate does not model.
        expect(output).toMatch(/the public contract changed/);
        expect(output).toContain(escape.surfaces);
      });
    }
  });

  it("rejects a same-name re-export that swaps the implementation", () => {
    // The declaration output records where the symbol comes from, so a re-export
    // is visible even though the name is unchanged.
    writeFileSync(
      EVENTS,
      pristine.replace(
        "export function envVarName(raw: string): EnvVarName {",
        "function envVarName(raw: string): EnvVarName {",
      ),
      "utf8",
    );
    append('export { envVarName } from "@/lib/env-schema";');
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toMatch(/the public contract changed/);
  });

  it("rejects narrowing the surface too, not only widening", () => {
    // A removed export breaks callers as surely as an added one loosens the
    // contract; the baseline is an equality check, not a subset check.
    writeFileSync(
      EVENTS,
      pristine.replace(
        "export function envVarName(raw: string): EnvVarName {",
        "function envVarName(raw: string): EnvVarName {",
      ),
      "utf8",
    );
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toMatch(/the public contract changed/);
    expect(output).toContain("- export declare function envVarName");
  });

  it("shows a unified diff naming what moved", () => {
    append("export const extraThing: number = 1;");
    const { output } = runGate();
    expect(output).toContain("+ export declare const extraThing: number;");
    expect(output).toMatch(/--update/);
  });

  it("--update rewrites the baseline and then verifies clean", () => {
    append("export const extraThing: number = 1;");
    expect(runGate().code).toBe(1);
    expect(runGate(["--update"]).code).toBe(0);
    expect(runGate().code).toBe(0);
    expect(readFileSync(tmpBaseline, "utf8")).toContain("extraThing");
  });

  it("fails rather than self-approving when the baseline is absent", () => {
    // The failure mode that would make the whole mechanism decorative.
    rmSync(tmpBaseline, { force: true });
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toMatch(/no baseline at/);
    expect(existsSync(tmpBaseline)).toBe(false);
  });
});
