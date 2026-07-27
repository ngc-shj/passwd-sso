import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { clientLogWarn, clientLogError } from "./client";
import { CLIENT_REDACT_KEYS, REDACTED } from "./redact-keys";

describe("clientLogWarn / clientLogError", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes the message to console.warn exactly once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    clientLogWarn("boom");
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith("boom");
  });

  it("writes the message to console.error exactly once", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    clientLogError("boom");
    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith("boom");
  });

  it("passes non-sensitive fields through untouched", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    clientLogWarn("m", { teamId: "team-1", status: 403, ok: false, extra: null });
    expect(warn).toHaveBeenCalledWith("m", {
      teamId: "team-1",
      status: 403,
      ok: false,
      extra: null,
    });
  });

  it("redacts a secret passed as a bare string — the flat-scalar type alone does not stop this", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    clientLogWarn("m", { token: "super-secret-value" });
    expect(warn).toHaveBeenCalledWith("m", { token: REDACTED });
    // The point of the assertion: the value must not survive anywhere in the call.
    expect(JSON.stringify(warn.mock.calls)).not.toContain("super-secret-value");
  });

  it("redacts every key in the shared denylist, on both levels", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fields = Object.fromEntries(
      CLIENT_REDACT_KEYS.map((k) => [k, `leaked-${k}`]),
    );

    clientLogWarn("m", fields);
    clientLogError("m", fields);

    for (const key of CLIENT_REDACT_KEYS) {
      expect(warn.mock.calls[0][1]).toMatchObject({ [key]: REDACTED });
      expect(error.mock.calls[0][1]).toMatchObject({ [key]: REDACTED });
    }
    expect(JSON.stringify([...warn.mock.calls, ...error.mock.calls])).not.toContain("leaked-");
  });

  it("redacts client-only identity keys the server logger does not cover", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    clientLogWarn("m", { email: "a@example.test", userId: "u-1" });
    expect(warn).toHaveBeenCalledWith("m", { email: REDACTED, userId: REDACTED });
  });
});

/**
 * The bundle guard. pino imports node:async_hooks, so a single transitive edge
 * from this module to `@/lib/logger` (or to pino directly) would break the
 * browser build — the failure mode recorded in
 * project_client_shared_constants_no_node_imports.
 *
 * A test that merely imports the module cannot catch this: under vitest's Node
 * environment `import pino from "pino"` resolves fine and stays green. So the
 * check walks the real import graph instead.
 */
describe("client logger bundle safety", () => {
  const FORBIDDEN = /^node:|^pino$|^@\/lib\/logger$/;
  const SRC_ROOT = resolve(__dirname, "../..");

  function collectTransitiveSpecifiers(entry: string): string[] {
    const seen = new Set<string>();
    const found: string[] = [];

    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(file, "utf8");
      const specifiers = [
        // `import x from "y"` / `export … from "y"`
        ...[...src.matchAll(/^\s*(?:import|export)[^'"]*from\s*["']([^"']+)["']/gm)].map((m) => m[1]),
        // Side-effect imports: `import "node:async_hooks"`. Omitting this form
        // was a real hole — the red-proof caught it, which is why the proof runs.
        ...[...src.matchAll(/^\s*import\s*["']([^"']+)["']/gm)].map((m) => m[1]),
        // `await import("y")` / `require("y")`
        ...[...src.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']/g)].map((m) => m[1]),
      ];

      for (const spec of specifiers) {
        found.push(spec);
        // Follow BOTH relative and `@/`-aliased edges. Following only relative
        // paths was a real hole: this repo imports almost entirely via `@/`, so
        // `client.ts -> @/lib/logger/throttled -> @/lib/logger -> pino ->
        // node:async_hooks` — a one-hop, bundle-breaking edge — read as clean.
        // A bare package specifier stays a leaf; reaching it is the signal.
        const base = spec.startsWith(".")
          ? resolve(dirname(file), spec)
          : spec.startsWith("@/")
            ? resolve(SRC_ROOT, spec.slice(2))
            : null;
        if (base === null) continue;
        const candidate = [".ts", ".tsx", "/index.ts", "/index.tsx"]
          .map((ext) => `${base}${ext}`)
          .find((p) => existsSync(p));
        if (candidate) visit(candidate);
      }
    };

    visit(entry);
    return found;
  }

  it("has no node:* or pino anywhere in its transitive import graph", () => {
    const specifiers = collectTransitiveSpecifiers(
      resolve(__dirname, "client.ts"),
    );
    expect(specifiers.filter((s) => FORBIDDEN.test(s))).toEqual([]);
  });

  it("the graph walker can actually fail (red-proof for the check above)", () => {
    // Guards against the check passing because the walker found nothing at all.
    const specifiers = collectTransitiveSpecifiers(
      resolve(__dirname, "throttled.ts"),
    );
    expect(specifiers).toContain("@/lib/logger");
    expect(specifiers.filter((s) => FORBIDDEN.test(s)).length).toBeGreaterThan(0);
  });

  // The control above exercises ONLY the plain `… from "x"` regex, because that
  // is the single form throttled.ts happens to use. Deleting either of the
  // other two regexes left the suite green — a red-proof that proved one third
  // of what it claimed. These fixtures give each form its own assertion, so a
  // deleted or broken regex dies here.
  it.each([
    ['side-effect', 'import "node:async_hooks";', "node:async_hooks"],
    ['dynamic', 'const l = await import("@/lib/logger");', "@/lib/logger"],
    ['require', 'const p = require("pino");', "pino"],
    ['re-export', 'export * from "pino";', "pino"],
    ['multi-line', 'import {\n  a,\n  b,\n} from "pino";', "pino"],
    ['default+named', 'import pino, { Logger } from "pino";', "pino"],
  ])("detects a forbidden specifier in %s form", (_form, source, expected) => {
    const probe = resolve(SRC_ROOT, "lib/logger/__specifier_probe__.ts");
    writeFileSync(probe, source, "utf8");
    try {
      const specifiers = collectTransitiveSpecifiers(probe);
      expect(specifiers).toContain(expected);
      expect(specifiers.filter((s) => FORBIDDEN.test(s)).length).toBeGreaterThan(0);
    } finally {
      rmSync(probe, { force: true });
    }
  });
});
