import { describe, expect, it, vi, afterEach } from "vitest";
import { BOOT_EVENT, envVarName, type BootDiagnostic } from "./boot-events";
import { bootStderr } from "./boot-stderr";

const DECLARED = new Set(["DATABASE_URL", "SHARE_MASTER_KEY", "NODE_ENV"]);

describe("envVarName", () => {
  it("admits a name the schema declares", () => {
    expect(envVarName("SHARE_MASTER_KEY", DECLARED)).toBe("SHARE_MASTER_KEY");
  });

  it("rejects a name the schema does not declare", () => {
    expect(envVarName("NOT_A_REAL_VAR", DECLARED)).toBe("<unnamed>");
    expect(envVarName("", DECLARED)).toBe("<unnamed>");
    expect(envVarName("0", DECLARED)).toBe("<unnamed>");
  });

  it("rejects identifier-shaped secret VALUES", () => {
    // The reason this is an allowlist rather than a shape predicate. Each of
    // these satisfies /^[A-Za-z_][A-Za-z0-9_]{0,63}$/ — the check an earlier
    // version used and called "validated" — so shape alone would have printed
    // a master key to unredacted stderr.
    expect(envVarName("a".repeat(64), DECLARED)).toBe("<unnamed>");
    expect(envVarName("AKIAIOSFODNN7EXAMPLE", DECLARED)).toBe("<unnamed>");
    expect(envVarName("api_9f2c7ba4e1d84c0f", DECLARED)).toBe("<unnamed>");
  });

  it("rejects a value even when it happens to look like a declared name", () => {
    // Membership is decided against the caller's set, so an empty set admits
    // nothing at all — the failure direction is closed.
    expect(envVarName("SHARE_MASTER_KEY", new Set())).toBe("<unnamed>");
  });
});

describe("bootStderr rendering", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function capture(diagnostic: BootDiagnostic): string {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    bootStderr(diagnostic);
    expect(spy).toHaveBeenCalledTimes(1);
    return String(spy.mock.calls[0][0]);
  }

  it("renders the env banner from declared variable names", () => {
    const out = capture({
      event: BOOT_EVENT.ENV_VALIDATION_FAILED,
      variables: [envVarName("DATABASE_URL", DECLARED), envVarName("SHARE_MASTER_KEY", DECLARED)],
    });
    expect(out).toContain("ENVIRONMENT VARIABLE VALIDATION FAILED");
    expect(out).toContain("DATABASE_URL");
    expect(out).toContain("SHARE_MASTER_KEY");
  });

  it("renders the CSP notice without echoing any value", () => {
    const out = capture({ event: BOOT_EVENT.CSP_MODE_IGNORED });
    expect(out).toContain("CSP_MODE is set to an unsupported value");
    // The payload has no field to carry the rejected value, which is the point;
    // this pins that the rendered text does not reintroduce one.
    expect(out).not.toMatch(/CSP_MODE="/);
  });

  it("renders the stale-key notice from closed values only", () => {
    const out = capture({
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
      bootStderr("token=hunter2");

      // @ts-expect-error an unknown event id is not in the union
      bootStderr({ event: "boot.made_up" });

      bootStderr({
        event: BOOT_EVENT.CSP_MODE_IGNORED,
        // @ts-expect-error this member declares no fields, so none can be smuggled in
        detail: process.env.AUTH_SECRET,
      });

      bootStderr({
        event: BOOT_EVENT.ENV_VALIDATION_FAILED,
        // @ts-expect-error a plain string array is not EnvVarName[]
        variables: [process.env.AUTH_SECRET ?? ""],
      });

      bootStderr({
        event: BOOT_EVENT.KEY_PROVIDER_STALE_KEY,
        // @ts-expect-error provider is a closed union, not an arbitrary string
        provider: process.env.PROVIDER ?? "",
        keyName: "share-master",
        elapsedSec: 1,
      });

      // @ts-expect-error the allowlist argument is required, so a bare string cannot be branded
      envVarName(process.env.AUTH_SECRET ?? "");
    };
    expect(typeOnly).toBeTypeOf("function");
  });
});
