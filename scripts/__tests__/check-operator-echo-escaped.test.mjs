/**
 * Self-test for scripts/checks/check-operator-echo-escaped.mjs — the round-6 F4
 * gate that fails when operator input reaches a message unescaped.
 *
 * RT7: red-proven by the exact regressions that shipped. Each of the four sites
 * round 6 found in `scripts/lib/tenant-domain-flags.ts` and the fifth in
 * `scripts/tenant-domain.ts` is reproduced here as a fixture, so the gate is
 * proven against the code that escaped three hand-enumerations rather than
 * against a shape invented for the test.
 *
 * The fixtures also pin the two properties that make this a MECHANISM rather
 * than a list: propagation through a slice chain (`argv[i] -> tok.slice(2)`),
 * which is how the missed sites were reached, and non-propagation through a free
 * function call, which is why `${tenant.id}` is not a finding.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GUARD = join(REPO_ROOT, "scripts/checks/check-operator-echo-escaped.mjs");

let root;

function runGuard() {
  const r = spawnSync("node", [GUARD], {
    encoding: "utf8",
    env: { ...process.env, OPERATOR_ECHO_CHECK_ROOT: root },
  });
  return { exitCode: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function writeScript(rel, contents) {
  const full = join(root, "scripts", rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents, "utf8");
}

function writeBaseline(lines) {
  const full = join(root, "scripts/checks/operator-echo-baseline.txt");
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `${lines.join("\n")}\n`, "utf8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "operator-echo-"));
  // The gate skips `scripts/checks/`, so the baseline lives outside the scan.
  writeBaseline([]);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-operator-echo-escaped.mjs", () => {
  it("passes when every argv interpolation is escaped", () => {
    writeScript(
      "lib/flags.ts",
      `import { escapeUnsafeDisplayChars } from "@/lib/security/unsafe-display-chars";
export function parseFlags(argv: string[]) {
  const tok = argv[0];
  const name = tok.slice(2);
  return \`Unknown flag --\${escapeUnsafeDisplayChars(name)}.\`;
}
`,
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode, stdout).toBe(0);
  });

  // The round-6 F4 sites, one fixture each. `tok`, `name` and `inlineValue` are
  // all reached from `argv` through a slice chain — the propagation step that
  // makes the gate see sites a per-file reading missed.
  it.each([
    ["the bare-positional refusal (tok)", 'return `Unexpected argument "${tok}".`;'],
    ["the unknown-flag refusal (name)", "return `Unknown flag --${name}.`;"],
    ["the repeated-flag refusal (name)", "return `--${name} was given more than once.`;"],
    ["the boolean-with-value refusal (inlineValue)", 'return `takes no value (got "${inlineValue}").`;'],
  ])("FAILS on %s", (_label, body) => {
    writeScript(
      "lib/flags.ts",
      `export function parseFlags(argv: string[]) {
  const tok = argv[0];
  const body = tok.slice(2);
  const name = body.slice(0, 2);
  const inlineValue = body.slice(3);
  ${body}
}
`,
    );
    const { exitCode, stderr } = runGuard();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("without escapeUnsafeDisplayChars");
  });

  it("FAILS on an unescaped getStringFlag read (the --days regression)", () => {
    writeScript(
      "tenant-domain.ts",
      `async function main() {
  const rawDays = getStringFlag(flags, "days");
  console.error(\`Invalid --days "\${rawDays}".\`);
}
`,
    );
    const { exitCode, stderr } = runGuard();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("rawDays");
  });

  it("FAILS on an unescaped cmd* parameter property (the round-5 sites)", () => {
    writeScript(
      "tenant-domain.ts",
      `export async function cmdAdd(args: { domain: string }) {
  return { message: \`Invalid --domain "\${args.domain}".\` };
}
`,
    );
    const { exitCode, stderr } = runGuard();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("args.domain");
  });

  it("does NOT flag a value returned by a free function call (a database row)", () => {
    // The non-propagation rule. Without it the gate demands an escape on
    // `${tenant.id}`, which is a UUID read out of Postgres — and a gate that
    // reports 14 findings nobody should fix is a gate that gets disabled.
    writeScript(
      "tenant-domain.ts",
      `export async function cmdAdd(args: { tenant: string }) {
  const tenant = await resolveTenantRef(tx, args.tenant);
  console.log(\`  id: \${tenant.id}\`);
}
`,
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode, stdout).toBe(0);
  });

  it("does NOT flag a same-named binding in a different scope", () => {
    // `parseFlags`'s `name` is a slice of argv; `valuelessError`'s `name` is one
    // of five known flag spellings. A per-file taint set keyed on identifier
    // names conflated the two and reported the second.
    writeScript(
      "lib/flags.ts",
      `export function parseFlags(argv: string[]) {
  const name = argv[0].slice(2);
  return name;
}
export function valuelessError(name: "days" | "tenant") {
  return \`--\${name} requires a value.\`;
}
`,
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode, stdout).toBe(0);
  });

  it("does NOT flag process.argv[1] (the script path in a usage banner)", () => {
    writeScript("tool.mjs", "console.error(`Usage: ${process.argv[1]} <arg>`);\n");
    const { exitCode, stdout } = runGuard();
    expect(exitCode, stdout).toBe(0);
  });

  it("honours an exemption marker in a comment above the interpolation", () => {
    writeScript(
      "tenant-domain.ts",
      `export async function cmdUnmapped(args: { days?: number }) {
  const days = args.days ?? 30;
  // operator-echo-exempt: a number, not operator text
  return { message: \`Invalid --days "\${days}".\` };
}
`,
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode, stdout).toBe(0);
  });

  it("accepts a baselined violation, and FAILS when the count grows", () => {
    writeScript(
      "legacy.mjs",
      `function cmdOld(args) {\n  console.log(\`\${args.a}\`);\n}\n`,
    );
    writeBaseline(["# pre-existing", "1 scripts/legacy.mjs"]);
    expect(runGuard().exitCode).toBe(0);

    writeScript(
      "legacy.mjs",
      `function cmdOld(args) {\n  console.log(\`\${args.a}\`);\n  console.log(\`\${args.b}\`);\n}\n`,
    );
    const { exitCode, stderr } = runGuard();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("baseline allows 1");
  });

  it("FAILS when a baselined violation is fixed but the baseline is not lowered", () => {
    // Anti-drift in the other direction: a stale baseline is a budget for a
    // regression nobody notices.
    writeScript("legacy.mjs", "function cmdOld(args) {\n  console.log(`ok`);\n}\n");
    writeBaseline(["1 scripts/legacy.mjs"]);
    const { exitCode, stderr } = runGuard();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("but 0 remain");
  });
});
