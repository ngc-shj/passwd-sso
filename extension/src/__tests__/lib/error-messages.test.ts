import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { humanizeError } from "../../lib/error-messages";

describe("humanizeError", () => {
  let origDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    // Force English locale so assertions are deterministic regardless of host OS
    origDescriptor = Object.getOwnPropertyDescriptor(navigator, "language");
    Object.defineProperty(navigator, "language", {
      value: "en-US",
      configurable: true,
    });
  });

  afterEach(() => {
    if (origDescriptor) {
      Object.defineProperty(navigator, "language", origDescriptor);
    }
  });

  it("maps known error codes", () => {
    expect(humanizeError("INVALID_PASSPHRASE")).toBe("Passphrase is incorrect.");
    expect(humanizeError("FETCH_FAILED")).toBe("Failed to load entries.");
    expect(humanizeError("NO_PASSWORD")).toBe("No password available for this entry.");
  });

  it("returns code for unknown values", () => {
    expect(humanizeError("SOMETHING_ELSE")).toBe("SOMETHING_ELSE");
  });
});
