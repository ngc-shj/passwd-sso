import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, existsSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { clientLogWarn, clientLogError, opaque, redact } from "./client";
import { CLIENT_REDACT_KEYS, REDACTED } from "./redact-keys";
import { CLIENT_LOG_EVENT, CLIENT_ERROR_CODE } from "./client-events";

describe("clientLogWarn / clientLogError", () => {
  const EV = CLIENT_LOG_EVENT.I18N_NAMESPACE_MISSING;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes the event to console.warn exactly once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    clientLogWarn(EV, { namespace: opaque("Settings") });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(EV, { namespace: "Settings" });
  });

  it("writes the event to console.error exactly once", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    clientLogError(CLIENT_LOG_EVENT.WEBAUTHN_REGISTRATION_FAILED, {
      code: CLIENT_ERROR_CODE.ABORTED,
    });
    expect(error).toHaveBeenCalledOnce();
  });

  it("passes an event's declared fields through untouched", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    clientLogWarn(CLIENT_LOG_EVENT.TEAM_MEMBER_KEY_VERSION_MISMATCH, {
      teamId: opaque("team-1"),
      requestedVersion: 2,
      responseVersion: 3,
    });
    expect(warn).toHaveBeenCalledWith(
      CLIENT_LOG_EVENT.TEAM_MEMBER_KEY_VERSION_MISMATCH,
      { teamId: "team-1", requestedVersion: 2, responseVersion: 3 },
    );
  });
});

/**
 * The sink-side redaction layer, tested directly.
 *
 * It is no longer reachable through the public API with an arbitrary key —
 * per-event payload types see to that — which is exactly why it still earns its
 * place: it covers what the types cannot, such as a cast or a call from untyped
 * JavaScript. Testing it here keeps that layer honest rather than assumed.
 */
describe("redact (defence in depth beneath the payload types)", () => {
  it("censors a secret held under a denylisted key", () => {
    expect(redact({ token: opaque("super-secret-value") })).toEqual({
      token: REDACTED,
    });
  });

  it("censors every key in the shared denylist", () => {
    const fields = Object.fromEntries(
      CLIENT_REDACT_KEYS.map((k) => [k, opaque(`leaked-${k}`)]),
    );
    const out = redact(fields);
    for (const key of CLIENT_REDACT_KEYS) {
      expect(out[key]).toBe(REDACTED);
    }
    expect(JSON.stringify(out)).not.toContain("leaked-");
  });

  it("censors client-only identity keys the server logger does not cover", () => {
    expect(redact({ email: opaque("a@example.test"), userId: opaque("u-1") })).toEqual({
      email: REDACTED,
      userId: REDACTED,
    });
  });

  it("leaves non-sensitive keys alone", () => {
    expect(redact({ status: 403, ok: false, extra: null })).toEqual({
      status: 403,
      ok: false,
      extra: null,
    });
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
  const EV = CLIENT_LOG_EVENT.I18N_NAMESPACE_MISSING;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects free-form events, unlisted keys, and cross-event payloads", () => {
    // These are COMPILE-time assertions. `@ts-expect-error` fails the build when
    // a line stops erroring, so a regression breaks typecheck instead of passing
    // silently — a runtime assertion structurally cannot observe a parameter
    // type. Both prior versions of this test were proven inadequate by mutation:
    // one checked only the shape of the enum VALUES, the next constrained only
    // the FIRST parameter and stayed green when the payload type was reverted.
    //
    // The calls live in a never-invoked function so the directives are checked
    // by tsc while nothing runs — the arguments are deliberately invalid, and
    // executing them would throw for reasons unrelated to what is being pinned.
    const typeOnly = () => {
      // @ts-expect-error arbitrary strings must not be accepted as an event id
      clientLogWarn("arbitrary.event", {});
      // @ts-expect-error the same holds for the error level
      clientLogError("arbitrary.event", {});

      const interpolated = `injected ${"secret"}`;
      // @ts-expect-error a template literal is the exact bypass this type closes
      clientLogWarn(interpolated, {});

      clientLogError(CLIENT_LOG_EVENT.WEBAUTHN_REGISTRATION_FAILED, {
        code: CLIENT_ERROR_CODE.UNKNOWN,
        // @ts-expect-error `otp` is not in this event's payload
        otp: 123456,
      });

      clientLogError(CLIENT_LOG_EVENT.WEBAUTHN_REGISTRATION_FAILED, {
        // @ts-expect-error this payload belongs to a different event
        namespace: opaque("Settings"),
      });

      // @ts-expect-error every payload has a required key, so it cannot be omitted
      clientLogError(CLIENT_LOG_EVENT.WEBAUTHN_REGISTRATION_FAILED);
    };

    expect(typeOnly).toBeTypeOf("function");
  });

  it("emits opaque values as plain strings, not wrapper objects", () => {
    // The brand is a type-level marker only. An earlier version wrapped the
    // value in `{ __opaque }`, which contradicted "flat values only" and
    // changed the field shape every downstream log consumer sees.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    clientLogWarn(EV, { namespace: opaque("Settings") });

    const fields = warn.mock.calls[0][1] as Record<string, unknown>;
    expect(fields.namespace).toBe("Settings");
    expect(typeof fields.namespace).toBe("string");
  });

  it("truncates an opaque value that outgrew its bound", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    clientLogWarn(EV, { namespace: opaque("x".repeat(200)) });

    const fields = warn.mock.calls[0][1] as Record<string, unknown>;
    expect(String(fields.namespace)).toHaveLength(64);
  });

  it("keeps event ids free of anywhere an interpolated value could hide", () => {
    const events: string[] = Object.values(CLIENT_LOG_EVENT);
    expect(events.length).toBeGreaterThan(0);
    for (const id of events) {
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
