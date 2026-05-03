import { describe, it, expect } from "vitest";
import { ScimOwnerProtectedError } from "./errors";

describe("ScimOwnerProtectedError", () => {
  it("is an instance of Error", () => {
    const err = new ScimOwnerProtectedError();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ScimOwnerProtectedError);
  });

  it("uses the SCIM_OWNER_PROTECTED sentinel as the error message", () => {
    const err = new ScimOwnerProtectedError();
    expect(err.message).toBe("SCIM_OWNER_PROTECTED");
  });

  it("sets the error name to ScimOwnerProtectedError", () => {
    const err = new ScimOwnerProtectedError();
    expect(err.name).toBe("ScimOwnerProtectedError");
  });

  it("can be distinguished from a plain Error via instanceof", () => {
    const err: unknown = new ScimOwnerProtectedError();
    let caught: unknown;
    try {
      throw err;
    } catch (e) {
      caught = e;
    }
    expect(caught instanceof ScimOwnerProtectedError).toBe(true);
    expect(caught instanceof Error).toBe(true);
  });

  it("has a stack trace populated", () => {
    const err = new ScimOwnerProtectedError();
    expect(typeof err.stack).toBe("string");
    expect(err.stack?.length ?? 0).toBeGreaterThan(0);
  });
});
