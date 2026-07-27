import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Self-test for scripts/checks/check-console-sinks.mjs.
 *
 * The gate guards the two files exempted from `no-console` — the one place a
 * secret could reach a console with nothing to stop it. A gate that only ever
 * runs green proves nothing, so each case mutates the shape the gate exists to
 * reject and asserts red.
 *
 * The guard is driven against fixtures via CONSOLE_SINKS_ROOT, matching the
 * MINT_GATE_* / other *_ROOT conventions in this directory. An earlier version
 * patched the real files and restored them in afterEach, which is safe in
 * isolation and wrong under `pre-pr.sh`: that runner executes steps
 * concurrently, so another gate reading `src/` during the mutation window
 * observed a half-broken tree and failed as an unrelated check. Pointing the
 * guard at a fixture root removes the shared mutable state instead of narrowing
 * the window.
 */

const REPO = resolve(import.meta.dirname, "../..");
const GATE = resolve(REPO, "scripts/checks/check-console-sinks.mjs");

// Only what the gate reads.
const TREE_FILES = [
  "src/lib/logger/client.ts",
  "src/lib/boot-stderr.ts",
  "eslint.config.mjs",
];

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "console-sinks-"));
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
      env: { ...process.env, CONSOLE_SINKS_ROOT: root },
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

describe("check-console-sinks", () => {
  it("passes on the current tree", () => {
    expect(runGate().code).toBe(0);
  });

  it("rejects fields reaching console without redact()", () => {
    patch(
      "src/lib/logger/client.ts",
      "console.warn(event, redact(fields))",
      "console.warn(event, fields)",
    );
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toMatch(/the only permitted form is/);
  });

  it("rejects an unredacted single-argument console call", () => {
    // The regression this gate missed: `console.warn(fields)` is a one-argument
    // call, and the check used to wave those through as "nothing to redact".
    // Now only the exact `(event, redact(fields))` form is accepted.
    patch(
      "src/lib/logger/client.ts",
      "console.warn(event, redact(fields));",
      "console.warn(fields);",
    );
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toMatch(/the only permitted form is/);
  });

  it("rejects an extra argument appended to a sink call", () => {
    patch(
      "src/lib/logger/client.ts",
      "console.error(event, redact(fields));",
      "console.error(event, redact(fields), fields);",
    );
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toMatch(/the only permitted form is/);
  });

  it("rejects the arguments being reordered", () => {
    patch(
      "src/lib/logger/client.ts",
      "console.warn(event, redact(fields));",
      "console.warn(redact(fields), event);",
    );
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toMatch(/the only permitted form is/);
  });

  it("rejects a serialized argument in the boot sink", () => {
    patch(
      "src/lib/boot-stderr.ts",
      "console.error(message)",
      "console.error(JSON.stringify(process.env))",
    );
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toMatch(/must take the bare `message` parameter/);
  });

  it("rejects a third file joining the no-console override list", () => {
    patch(
      "eslint.config.mjs",
      '["src/lib/logger/client.ts", "src/lib/boot-stderr.ts"]',
      '["src/lib/logger/client.ts", "src/lib/boot-stderr.ts", "src/lib/env.ts"]',
    );
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toMatch(/override list is/);
  });

  it("rejects the sink disappearing from client.ts entirely", () => {
    // Guards the inverse failure: a gate that finds nothing must not read as OK.
    // `fields` is required, so each sink has exactly one console call.
    patch(
      "src/lib/logger/client.ts",
      "console.warn(event, redact(fields));",
      "void redact(fields);",
    );
    patch(
      "src/lib/logger/client.ts",
      "console.error(event, redact(fields));",
      "void redact(fields);",
    );
    const { code, output } = runGate();
    expect(code).toBe(1);
    expect(output).toMatch(/expected at least one console call/);
  });
});
