import { describe, it, expect } from "vitest";
import { getPasswordPath } from "../../lib/secrets-config";

describe("getPasswordPath", () => {
  it("returns /api/v1/ path when useV1 is true", () => {
    expect(getPasswordPath("entry-1", true)).toBe(
      "/api/v1/passwords/entry-1",
    );
  });

  it("returns /api/ path when useV1 is false", () => {
    expect(getPasswordPath("entry-1", false)).toBe("/api/passwords/entry-1");
  });

  it("encodes special characters in entryId", () => {
    expect(getPasswordPath("entry with spaces", true)).toBe(
      "/api/v1/passwords/entry%20with%20spaces",
    );
  });

  it("rejects entryId with forward slash", () => {
    expect(() => getPasswordPath("../etc/passwd", true)).toThrow(
      "Invalid entry ID",
    );
  });

  it("rejects entryId with backslash", () => {
    expect(() => getPasswordPath("..\\etc\\passwd", true)).toThrow(
      "Invalid entry ID",
    );
  });

  it("allows cuid-style IDs", () => {
    expect(getPasswordPath("cm1abc2def3gh4ijk5l", false)).toBe(
      "/api/passwords/cm1abc2def3gh4ijk5l",
    );
  });
});
