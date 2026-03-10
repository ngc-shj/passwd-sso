import { describe, it, expect } from "vitest";
import { normalizeErrorCode } from "../../lib/error-utils";

describe("normalizeErrorCode", () => {
  it("normalizes Chrome network error", () => {
    expect(normalizeErrorCode(new Error("Failed to fetch"), "FALLBACK")).toBe(
      "NETWORK_ERROR",
    );
  });

  it("normalizes Firefox network error", () => {
    expect(
      normalizeErrorCode(
        new Error("NetworkError when attempting to fetch resource."),
        "FALLBACK",
      ),
    ).toBe("NETWORK_ERROR");
  });

  it("normalizes Safari network error", () => {
    expect(normalizeErrorCode(new Error("Load failed"), "FALLBACK")).toBe(
      "NETWORK_ERROR",
    );
  });

  it("returns raw message for non-network errors", () => {
    expect(normalizeErrorCode(new Error("INVALID_TOKEN"), "FALLBACK")).toBe(
      "INVALID_TOKEN",
    );
  });

  it("returns fallback for non-Error values", () => {
    expect(normalizeErrorCode("string error", "FALLBACK")).toBe("FALLBACK");
    expect(normalizeErrorCode(42, "FALLBACK")).toBe("FALLBACK");
    expect(normalizeErrorCode(null, "FALLBACK")).toBe("FALLBACK");
  });

  it("returns fallback for Error with empty message", () => {
    expect(normalizeErrorCode(new Error(""), "FALLBACK")).toBe("FALLBACK");
  });
});
