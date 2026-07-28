import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  cpSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Self-test for scripts/checks/check-public-contract.mjs.
 *
 * Runs entirely inside a temp fixture: the sources are COPIED there, a tsconfig
 * is generated pointing at the copies, and the checker is aimed at both via
 * PUBLIC_CONTRACT_TSCONFIG / PUBLIC_CONTRACT_BASELINE. The tracked tree is never
 * written to.
 *
 * An earlier version mutated `src/lib/boot-events.ts` in place and restored it
 * in afterEach. That is unsafe here for three separate reasons: `pre-pr.sh` runs
 * Test, Lint and the Next build concurrently, so another step can read a
 * half-mutated source; an interrupted run leaves the file broken; and the
 * restore writes back a `pristine` snapshot that would clobber anything the
 * developer edited meanwhile.
 *
 * The fixture copies the module's full import closure, so the compile resolves
 * without reaching outside the temp dir. If boot-events gains an import beyond
 * this list, the first case goes red rather than silently falling back to the
 * real tree.
 */

const REPO = resolve(import.meta.dirname, "../..");
const GATE = resolve(REPO, "scripts/checks/check-public-contract.mjs");

/** The import closure of the three contract files, verified by case 1. */
const FIXTURE_SOURCES = [
  "src/lib/boot-events.ts",
  "src/lib/boot-stderr.ts",
  "src/lib/key-provider/types.ts",
  "src/lib/env-schema.ts",
  "src/lib/validations/common.ts",
  "src/lib/constants/time.ts",
];

const CONTRACT_ENTRIES = [
  "./src/lib/boot-events.ts",
  "./src/lib/boot-stderr.ts",
  "./src/lib/key-provider/types.ts",
];

let fixture;
let tsconfigPath;
let baselinePath;

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), "public-contract-test-"));
  for (const rel of FIXTURE_SOURCES) {
    const dst = join(fixture, rel);
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(join(REPO, rel), dst);
  }

  // Mirrors scripts/checks/tsconfig.public-contract.json, rooted at the fixture.
  tsconfigPath = join(fixture, "tsconfig.json");
  writeFileSync(
    tsconfigPath,
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2020",
          lib: ["dom", "dom.iterable", "esnext"],
          module: "esnext",
          moduleResolution: "bundler",
          strict: true,
          skipLibCheck: true,
          esModuleInterop: true,
          resolveJsonModule: true,
          declaration: true,
          emitDeclarationOnly: true,
          declarationMap: false,
          removeComments: true,
          incremental: false,
          composite: false,
          noEmitOnError: false,
          rootDir: ".",
          baseUrl: ".",
          paths: { "@/*": ["./src/*"] },
        },
        files: CONTRACT_ENTRIES,
      },
      null,
      2,
    ),
    "utf8",
  );

  baselinePath = join(fixture, "baseline.d.txt");
  runGate(["--update"]);
});

afterEach(() => {
  rmSync(fixture, { recursive: true, force: true });
});

function runGate(args = []) {
  try {
    execFileSync("node", [GATE, ...args], {
      cwd: REPO,
      env: {
        ...process.env,
        PUBLIC_CONTRACT_TSCONFIG: tsconfigPath,
        PUBLIC_CONTRACT_BASELINE: baselinePath,
      },
      encoding: "utf8",
      stdio: "pipe",
    });
    return { code: 0, output: "" };
  } catch (err) {
    return { code: err.status ?? 1, output: `${err.stdout}${err.stderr}` };
  }
}

function append(source) {
  const path = join(fixture, "src/lib/boot-events.ts");
  writeFileSync(path, `${readFileSync(path, "utf8")}\n${source}\n`, "utf8");
}

function patchEvents(from, to) {
  const path = join(fixture, "src/lib/boot-events.ts");
  const src = readFileSync(path, "utf8");
  expect(src).toContain(from);
  writeFileSync(path, src.replace(from, to), "utf8");
}

describe("check-public-contract", () => {
  it("passes on an unmodified copy of the sources", () => {
    // Also proves the fixture's import closure is complete: an unresolved import
    // would leave the declarations unemitted and fail here.
    expect(runGate().code).toBe(0);
  });

  it("matches the tracked baseline, so the fixture is faithful", () => {
    const tracked = readFileSync(
      resolve(REPO, "scripts/checks/boot-public-contract.d.txt"),
      "utf8",
    );
    expect(readFileSync(baselinePath, "utf8")).toBe(tracked);
  });

  it("never writes the tracked baseline while verifying", () => {
    const trackedPath = resolve(REPO, "scripts/checks/boot-public-contract.d.txt");
    const before = readFileSync(trackedPath, "utf8");
    append("export const somethingElse = 1;");
    expect(runGate().code).toBe(1);
    expect(readFileSync(trackedPath, "utf8")).toBe(before);
  });

  it("is itself plain text, so a contract diff stays reviewable", () => {
    // A stray NUL in this gate once made git treat it as binary, which defeats
    // the whole point of a reviewable baseline.
    expect(readFileSync(GATE).includes(0)).toBe(false);
  });

  describe("rejects a widened surface, whatever syntax produced it", () => {
    const escapes = [
      {
        name: "old-style assertion helper",
        source: "export function unsafeName(s: string): EnvVarName {\n  return <EnvVarName>s;\n}",
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
        source: "export function variables(s: string): s is EnvVarName {\n  return true;\n}",
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
    patchEvents(
      "export function envVarName(raw: string): EnvVarName {",
      "function envVarName(raw: string): EnvVarName {",
    );
    append('export { getSchemaShape as envVarName } from "@/lib/env-schema";');
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toMatch(/the public contract changed/);
  });

  it("rejects narrowing the surface too, not only widening", () => {
    // A removed export breaks callers as surely as an added one loosens the
    // contract; the baseline is an equality check, not a subset check.
    patchEvents(
      "export function envVarName(raw: string): EnvVarName {",
      "function envVarName(raw: string): EnvVarName {",
    );
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toContain("- export declare function envVarName");
  });

  it("rejects widening a closed union in the depended-on types file", () => {
    // BootDiagnostic's own declaration would not change, which is why that file
    // is part of the contract.
    const path = join(fixture, "src/lib/key-provider/types.ts");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        'export type ProviderName = "env" | "aws-sm" | "gcp-sm" | "azure-kv";',
        "export type ProviderName = string;",
      ),
      "utf8",
    );
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toContain("+ export type ProviderName = string;");
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
    expect(readFileSync(baselinePath, "utf8")).toContain("extraThing");
  });

  it("fails rather than self-approving when the baseline is absent", () => {
    // The failure mode that would make the whole mechanism decorative.
    rmSync(baselinePath, { force: true });
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toMatch(/no baseline at/);
    expect(existsSync(baselinePath)).toBe(false);
  });
});
