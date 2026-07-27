import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, existsSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { clientLogWarn, clientLogError } from "./client";
import { CLIENT_REDACT_KEYS, REDACTED } from "./redact-keys";
import { CLIENT_LOG_EVENT } from "./client-events";

describe("clientLogWarn / clientLogError", () => {
  // Any member works; the point is the API takes an enumerated id, not a string.
  const EV = CLIENT_LOG_EVENT.I18N_NAMESPACE_MISSING;
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes the message to console.warn exactly once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    clientLogWarn(EV);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(EV);
  });

  it("writes the message to console.error exactly once", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    clientLogError(EV);
    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(EV);
  });

  it("passes non-sensitive fields through untouched", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    clientLogWarn(EV, { teamId: "team-1", status: 403, ok: false, extra: null });
    expect(warn).toHaveBeenCalledWith(EV, {
      teamId: "team-1",
      status: 403,
      ok: false,
      extra: null,
    });
  });

  it("redacts a secret passed as a bare string — the flat-scalar type alone does not stop this", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    clientLogWarn(EV, { token: "super-secret-value" });
    expect(warn).toHaveBeenCalledWith(EV, { token: REDACTED });
    // The point of the assertion: the value must not survive anywhere in the call.
    expect(JSON.stringify(warn.mock.calls)).not.toContain("super-secret-value");
  });

  it("redacts every key in the shared denylist, on both levels", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fields = Object.fromEntries(
      CLIENT_REDACT_KEYS.map((k) => [k, `leaked-${k}`]),
    );

    clientLogWarn(EV, fields);
    clientLogError(EV, fields);

    for (const key of CLIENT_REDACT_KEYS) {
      expect(warn.mock.calls[0][1]).toMatchObject({ [key]: REDACTED });
      expect(error.mock.calls[0][1]).toMatchObject({ [key]: REDACTED });
    }
    expect(JSON.stringify([...warn.mock.calls, ...error.mock.calls])).not.toContain("leaked-");
  });

  it("redacts client-only identity keys the server logger does not cover", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    clientLogWarn(EV, { email: "a@example.test", userId: "u-1" });
    expect(warn).toHaveBeenCalledWith(EV, { email: REDACTED, userId: REDACTED });
  });
});

/**
 * Guards the two Medium findings from the pre-merge security review.
 *
 * 1. A key-name denylist inspects KEYS, so a secret embedded in a VALUE
 *    ("authentication failed: password=hunter2", "/api?token=…") passes
 *    straight through. The fix is upstream: no caller may put free-form text
 *    into a field, so the tests below pin that every production call site emits
 *    bounded values only.
 * 2. The message channel is closed by the type system rather than by a lint
 *    rule — an ESLint selector on the callee name was bypassable by an aliased
 *    import, a variable, a concatenation, or a wrapper. A type has no such
 *    spellings left over.
 */
describe("client logger value-safety", () => {
  it("only accepts enumerated event ids, never a free-form string", () => {
    // A compile-time property, asserted here so the intent survives a refactor
    // that might otherwise widen the parameter back to `string`.
    const events: string[] = Object.values(CLIENT_LOG_EVENT);
    expect(events.length).toBeGreaterThan(0);
    for (const id of events) {
      // Every id is a dotted, lowercase, punctuation-free token — no room for
      // an interpolated value to hide in one.
      expect(id).toMatch(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/);
    }
  });

  it("classifies errors by shape, never by message or cause", async () => {
    const { toClientErrorCode, CLIENT_ERROR_CODE } = await import("./client-events");
    const secret = "password=hunter2";

    const err = new Error(`authentication failed: ${secret}`);
    err.cause = new Error(`inner ${secret}`);

    const code = toClientErrorCode(err);
    expect(code).toBe(CLIENT_ERROR_CODE.UNKNOWN);
    // The whole point: no part of the message or cause survives into the code.
    expect(code).not.toContain("hunter2");
    expect(Object.values(CLIENT_ERROR_CODE)).toContain(code);
  });

  it("maps recognized DOMException names without reading their messages", async () => {
    const { toClientErrorCode, CLIENT_ERROR_CODE } = await import("./client-events");
    const cases: [string, string][] = [
      ["AbortError", CLIENT_ERROR_CODE.ABORTED],
      ["NotAllowedError", CLIENT_ERROR_CODE.NOT_ALLOWED],
      ["InvalidStateError", CLIENT_ERROR_CODE.INVALID_STATE],
      ["OperationError", CLIENT_ERROR_CODE.DECRYPT],
    ];
    for (const [name, expected] of cases) {
      expect(toClientErrorCode(new DOMException("leaked-secret", name))).toBe(expected);
    }
  });

  it("no production call site passes free-form error text into a field", () => {
    // The defect class, pinned at its source rather than per-call-site: a
    // reviewer adding `error: e.message` to any clientLog* call reds this.
    const SRC = resolve(__dirname, "../..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "__tests__" || entry.name === "node_modules") continue;
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name) || /\.test\./.test(entry.name)) continue;
        const src = readFileSync(full, "utf8");
        for (const call of src.matchAll(/clientLog(?:Warn|Error)\(([\s\S]{0,400}?)\n\s*\}\);/g)) {
          if (/\.message\b|String\(\s*e|describeUnknownError/.test(call[1])) {
            offenders.push(full.replace(`${SRC}/`, ""));
          }
        }
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
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
