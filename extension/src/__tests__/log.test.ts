import { describe, it, expect, vi, afterEach } from "vitest";
import { classifyLastError, warnBackground } from "../background/log";

/**
 * classifyLastError is the field-diagnosis path the context-menu work leans on:
 * with no real-browser harness, a duplicate-id collision that survives the fix
 * reports itself only through this classifier. Each clause below pins one of the
 * behaviours that makes that report trustworthy — in particular that a message
 * is inspected but never forwarded, since a create failure's message can quote
 * the item title, which is decrypted vault data.
 */
describe("classifyLastError", () => {
  it("returns null when there is no error", () => {
    expect(classifyLastError(undefined)).toBe(null);
  });

  it("classifies a duplicate-id failure", () => {
    expect(
      classifyLastError({ message: "Cannot create item with duplicate id psso-parent" }),
    ).toBe("duplicate-id");
  });

  it("classifies a missing-parent failure", () => {
    expect(
      classifyLastError({ message: "Cannot find menu item with id psso-parent" }),
    ).toBe("orphan-parent");
  });

  it("prefers duplicate-id when a message matches both shapes", () => {
    // The serialization invariant is the one this contract exists to protect,
    // so it must win rather than be masked by the ordering failure.
    expect(
      classifyLastError({
        message:
          "Cannot find menu item with id psso-parent: Cannot create item with duplicate id psso-cc-sep",
      }),
    ).toBe("duplicate-id");
  });

  it("returns unknown for an unrecognized message", () => {
    expect(classifyLastError({ message: "Some other failure" })).toBe("unknown");
  });

  it("distinguishes an empty message from an absent error", () => {
    // An empty string is a representable value of the field and means "an error
    // occurred, unclassifiable" — not "no error", which is what undefined means.
    expect(classifyLastError({ message: "" })).toBe("unknown");
    expect(classifyLastError({})).toBe("unknown");
    expect(classifyLastError(undefined)).toBe(null);
  });

  it("never returns the message itself", () => {
    const secret = "Cannot create item with duplicate id GitHub (alice@example.com)";
    const code = classifyLastError({ message: secret });
    expect(code).toBe("duplicate-id");
    expect(secret).not.toContain(code as string);
  });
});

describe("warnBackground", () => {
  const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
  afterEach(() => spy.mockClear());

  it("emits the event and code, and nothing else", () => {
    warnBackground("context-menu-create-failed", "duplicate-id");
    expect(spy).toHaveBeenCalledExactlyOnceWith(
      "[passwd-sso] context-menu-create-failed: duplicate-id",
    );
  });
});
