import { describe, expect, it } from "vitest";
import { formatUserName } from "./format-user";

describe("formatUserName", () => {
  it("returns name when both name and email are present", () => {
    expect(formatUserName({ name: "Alice Smith", email: "alice@example.com" })).toBe("Alice Smith");
  });

  it("returns email when name is null", () => {
    expect(formatUserName({ name: null, email: "alice@example.com" })).toBe("alice@example.com");
  });

  it("returns email when name is empty string", () => {
    expect(formatUserName({ name: "", email: "alice@example.com" })).toBe("alice@example.com");
  });

  it("returns email when name is whitespace only", () => {
    expect(formatUserName({ name: "   ", email: "alice@example.com" })).toBe("alice@example.com");
  });

  it("returns default fallback when user is null", () => {
    expect(formatUserName(null)).toBe("—");
  });

  it("returns default fallback when user is undefined", () => {
    expect(formatUserName(undefined)).toBe("—");
  });

  it("returns custom fallback when user is null", () => {
    expect(formatUserName(null, "Unknown")).toBe("Unknown");
  });

  it("returns fallback when both name and email are null", () => {
    expect(formatUserName({ name: null, email: null })).toBe("—");
  });

  it("returns custom fallback when both name and email are null", () => {
    expect(formatUserName({ name: null, email: null }, "N/A")).toBe("N/A");
  });

  it("trims the name before returning", () => {
    expect(formatUserName({ name: "  Bob  ", email: "bob@example.com" })).toBe("Bob");
  });

  it("returns name when email is null", () => {
    expect(formatUserName({ name: "Charlie", email: null })).toBe("Charlie");
  });
});
