import { describe, it, expect } from "vitest";
import { sanitizeSyncError } from "./sanitize";

describe("sanitizeSyncError", () => {
  it("extracts Error.message", () => {
    expect(sanitizeSyncError(new Error("fail"))).toBe("fail");
  });

  it("handles string input", () => {
    expect(sanitizeSyncError("raw error")).toBe("raw error");
  });

  it("stringifies objects", () => {
    expect(sanitizeSyncError({ code: 500 })).toBe('{"code":500}');
  });

  it("handles null", () => {
    expect(sanitizeSyncError(null)).toBe("null");
  });

  it("handles undefined", () => {
    expect(sanitizeSyncError(undefined)).toBe("undefined");
  });

  it("redacts Bearer tokens", () => {
    const result = sanitizeSyncError("Authorization: Bearer eyJhbGciOi...");
    expect(result).toContain("Bearer [REDACTED]");
    expect(result).not.toContain("eyJhbGciOi");
  });

  it("redacts SSWS tokens", () => {
    const result = sanitizeSyncError("SSWS 00abc123def456");
    expect(result).toBe("SSWS [REDACTED]");
  });

  it("redacts client_secret= values", () => {
    const result = sanitizeSyncError("client_secret=super_secret&grant_type=client_credentials");
    expect(result).toContain("client_secret=[REDACTED]");
    expect(result).not.toContain("super_secret");
  });

  it("redacts token= values", () => {
    const result = sanitizeSyncError("token=abc123&scope=read");
    expect(result).toContain("token=[REDACTED]");
    expect(result).not.toContain("abc123");
  });

  it("strips URL query parameters", () => {
    const msg = "Failed: https://graph.microsoft.com/v1.0/users?$filter=x&token=abc";
    const result = sanitizeSyncError(msg);
    expect(result).not.toContain("token=abc");
    expect(result).toContain("https://graph.microsoft.com/v1.0/users");
  });

  it("truncates to 1000 characters", () => {
    const long = "a".repeat(2000);
    const result = sanitizeSyncError(long);
    expect(result.length).toBeLessThanOrEqual(1000);
    expect(result).toMatch(/\.\.\.$/);
  });
});
