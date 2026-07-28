import { describe, it, expect, afterEach, vi } from "vitest";
import { classifyError, warnBackground } from "../../background/log";

afterEach(() => {
  vi.restoreAllMocks();
});

// The "cannot leak" property is carried by the types: classifyError's return type is
// a closed union, so returning err.message does not compile, and warnBackground has
// no parameter that can hold caller data. What a compiling mutant CAN still get
// wrong is the mapping and the arity — that is what these assert.
describe("classifyError", () => {
  it("maps a SyntaxError by shape, without echoing its message", () => {
    const secret = "…\"password\":S3cr3t-Passw0rd…";
    expect(classifyError(new SyntaxError(secret))).toBe("syntax-error");
  });

  it("maps a TypeError", () => {
    expect(classifyError(new TypeError("boom"))).toBe("type-error");
  });

  // DOMException also passes `instanceof Error`, so without its own branch every
  // chrome.* API rejection — the failure mode webauthn-interceptor-register-failed
  // exists for — silently collapses into "error".
  it("maps a DOMException, which also satisfies instanceof Error", () => {
    expect(new DOMException("x", "NotAllowedError") instanceof Error).toBe(true);
    expect(classifyError(new DOMException("x", "NotAllowedError"))).toBe(
      "dom-exception",
    );
  });

  it("maps a plain Error", () => {
    expect(classifyError(new Error("boom"))).toBe("error");
  });

  it("maps a non-Error throw to unknown", () => {
    expect(classifyError("boom")).toBe("unknown");
    expect(classifyError(undefined)).toBe("unknown");
  });
});

describe("warnBackground", () => {
  it("emits exactly one single-argument warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    warnBackground("copy-command-failed", "syntax-error");

    expect(warn).toHaveBeenCalledTimes(1);
    // Arity is the property that would notice a future free-form second parameter.
    expect(warn.mock.calls[0]).toHaveLength(1);
    expect(warn.mock.calls[0][0]).toBe(
      "[passwd-sso] copy-command-failed: syntax-error",
    );
  });
});
