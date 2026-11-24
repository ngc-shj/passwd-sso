import { describe, it, expect } from "vitest";
import { AdapterUnsupportedError } from "./vault-list-adapter";

describe("AdapterUnsupportedError", () => {
  it("carries a default message naming the unsupported operation", () => {
    const err = new AdapterUnsupportedError();
    expect(err.message).toBe("Operation not supported by this vault adapter");
  });

  it("keeps a caller-supplied message", () => {
    expect(new AdapterUnsupportedError("favorites are personal-only").message).toBe("favorites are personal-only");
  });

  it("is identifiable by name and class for callers that catch it", () => {
    const err = new AdapterUnsupportedError();
    expect(err.name).toBe("AdapterUnsupportedError");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AdapterUnsupportedError);
  });
});
