import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Self-test for scripts/checks/check-console-sinks.mjs.
 *
 * The gate guards the two files exempted from `no-console` — the one place a
 * secret could reach a console with nothing to stop it. A gate that only ever
 * runs green proves nothing, so each case here mutates a real source file into
 * the shape the gate exists to reject, asserts red, and restores. Originals are
 * captured in beforeEach and rewritten in afterEach so a failing assertion
 * cannot leave a mutated tree behind.
 */

const REPO = resolve(import.meta.dirname, "../..");
const GATE = "scripts/checks/check-console-sinks.mjs";

const TOUCHED = [
  "src/lib/logger/client.ts",
  "src/lib/boot-stderr.ts",
  "eslint.config.mjs",
];

function runGate() {
  try {
    execFileSync("node", [GATE], { cwd: REPO, stdio: "pipe" });
    return { code: 0, output: "" };
  } catch (err) {
    return { code: err.status ?? 1, output: `${err.stdout}${err.stderr}` };
  }
}

function patch(file, from, to) {
  const path = resolve(REPO, file);
  const src = readFileSync(path, "utf8");
  expect(src).toContain(from);
  writeFileSync(path, src.replace(from, to), "utf8");
}

describe("check-console-sinks", () => {
  let originals;

  beforeEach(() => {
    originals = new Map(
      TOUCHED.map((f) => [f, readFileSync(resolve(REPO, f), "utf8")]),
    );
  });

  afterEach(() => {
    for (const [file, content] of originals) {
      writeFileSync(resolve(REPO, file), content, "utf8");
    }
  });

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
    expect(output).toMatch(/not a redact\(\.\.\.\) call/);
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
