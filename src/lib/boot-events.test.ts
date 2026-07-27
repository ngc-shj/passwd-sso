import { describe, expect, it, vi, afterEach } from "vitest";
import { BOOT_EVENT, envVarName, type BootDiagnostic } from "./boot-events";

describe("envVarName", () => {
  it("passes through a well-formed variable name", () => {
    expect(envVarName("SHARE_MASTER_KEY")).toBe("SHARE_MASTER_KEY");
  });

  it("replaces a value that is not shaped like a variable name", () => {
    // The point of validating rather than asserting: elsewhere in this repo an
    // `opaque()` helper brands without checking, so `opaque(secret)` compiles
    // AND passes through. A Zod path can be a number (array index) or a nested
    // key, and none of those should reach a raw console as-is.
    expect(envVarName("postgres://user:pw@host/db")).toBe("<unnamed>");
    expect(envVarName("0")).toBe("<unnamed>");
    expect(envVarName("")).toBe("<unnamed>");
    expect(envVarName("has spaces")).toBe("<unnamed>");
  });

  it("rejects an identifier-shaped value that is too long to be a variable name", () => {
    // Shape alone is not enough: this sink has no downstream that could trim,
    // so an identifier-shaped blob would flood the boot console verbatim.
    expect(envVarName("A".repeat(64))).toBe("A".repeat(64));
    expect(envVarName("A".repeat(65))).toBe("<unnamed>");
    expect(envVarName("A".repeat(4096))).toBe("<unnamed>");
  });
});

describe("bootStderr rendering", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function capture(diagnostic: BootDiagnostic): Promise<string> {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { bootStderr } = await import("./boot-stderr");
    bootStderr(diagnostic);
    expect(spy).toHaveBeenCalledTimes(1);
    return String(spy.mock.calls[0][0]);
  }

  it("renders the env banner from variable names", async () => {
    const out = await capture({
      event: BOOT_EVENT.ENV_VALIDATION_FAILED,
      variables: [envVarName("DATABASE_URL"), envVarName("SHARE_MASTER_KEY")],
    });
    expect(out).toContain("ENVIRONMENT VARIABLE VALIDATION FAILED");
    expect(out).toContain("DATABASE_URL");
    expect(out).toContain("SHARE_MASTER_KEY");
  });

  it("renders the CSP notice without echoing any value", async () => {
    const out = await capture({ event: BOOT_EVENT.CSP_MODE_IGNORED });
    expect(out).toContain("CSP_MODE is set to an unsupported value");
    // The payload has no field to carry the rejected value, which is the point;
    // this pins that the rendered text does not reintroduce one.
    expect(out).not.toMatch(/CSP_MODE="/);
  });

  it("renders the stale-key notice from closed values only", async () => {
    const out = await capture({
      event: BOOT_EVENT.KEY_PROVIDER_STALE_KEY,
      provider: "aws-sm",
      keyName: "share-master",
      elapsedSec: 42,
    });
    expect(out).toBe('[key-provider] aws-sm stale key used for "share-master" (42s old)');
  });

  it("rejects free-form values at compile time", () => {
    // The security control IS the type. These calls are never executed; the
    // directives fail typecheck if any of them stops erroring, which is what
    // catches a future widening of BootDiagnostic.
    const typeOnly = () => {
      // @ts-expect-error a bare string is not a diagnostic — this is the old signature
      bootStderrRef("token=hunter2");

      // @ts-expect-error an unknown event id is not in the union
      bootStderrRef({ event: "boot.made_up" });

      bootStderrRef({
        event: BOOT_EVENT.CSP_MODE_IGNORED,
        // @ts-expect-error this member declares no fields, so none can be smuggled in
        detail: process.env.AUTH_SECRET,
      });

      bootStderrRef({
        event: BOOT_EVENT.ENV_VALIDATION_FAILED,
        // @ts-expect-error a plain string array is not EnvVarName[]
        variables: [process.env.AUTH_SECRET ?? ""],
      });

      bootStderrRef({
        event: BOOT_EVENT.KEY_PROVIDER_STALE_KEY,
        // @ts-expect-error provider is a closed union, not an arbitrary string
        provider: process.env.PROVIDER ?? "",
        keyName: "share-master",
        elapsedSec: 1,
      });
    };
    expect(typeOnly).toBeTypeOf("function");
  });
});

// Imported lazily above for the runtime cases; referenced statically here so the
// type-only block is checked against the real signature.
import { bootStderr as bootStderrRef } from "./boot-stderr";
