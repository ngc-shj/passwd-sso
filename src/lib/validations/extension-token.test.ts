import { describe, expect, it } from "vitest";
import {
  TokenIssueResponseSchema,
  TokenRevokeResponseSchema,
} from "@/lib/validations/extension-token";

// ─── TokenIssueResponseSchema ─────────────────────────────────

describe("TokenIssueResponseSchema", () => {
  const validPayload = {
    token: "eyJhbGciOiJIUzI1NiJ9.payload.signature",
    expiresAt: "2026-03-18T12:00:00.000Z",
    scope: ["vault:read", "vault:write"],
  };

  // Happy path
  it("accepts a valid token issue response", () => {
    const result = TokenIssueResponseSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
  });

  it("returns parsed data matching input on success", () => {
    const result = TokenIssueResponseSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.token).toBe(validPayload.token);
      expect(result.data.expiresAt).toBe(validPayload.expiresAt);
      expect(result.data.scope).toEqual(validPayload.scope);
    }
  });

  // Boundary: minimum valid token (single character)
  it("accepts a token with exactly 1 character", () => {
    const result = TokenIssueResponseSchema.safeParse({
      ...validPayload,
      token: "x",
    });
    expect(result.success).toBe(true);
  });

  // Boundary: scope with exactly 1 element
  it("accepts a scope array with exactly 1 element", () => {
    const result = TokenIssueResponseSchema.safeParse({
      ...validPayload,
      scope: ["vault:read"],
    });
    expect(result.success).toBe(true);
  });

  // Boundary: scope with many elements
  it("accepts a scope array with multiple elements", () => {
    const result = TokenIssueResponseSchema.safeParse({
      ...validPayload,
      scope: ["vault:read", "vault:write", "admin:read"],
    });
    expect(result.success).toBe(true);
  });

  // Schema strictness: extra fields are stripped by default
  it("strips extra fields (Zod default strip behavior)", () => {
    const result = TokenIssueResponseSchema.safeParse({
      ...validPayload,
      extraField: "should-be-stripped",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("extraField");
    }
  });

  // Error paths: missing fields
  it("rejects when token field is missing", () => {
    const { token: _token, ...rest } = validPayload;
    const result = TokenIssueResponseSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects when expiresAt field is missing", () => {
    const { expiresAt: _expiresAt, ...rest } = validPayload;
    const result = TokenIssueResponseSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects when scope field is missing", () => {
    const { scope: _scope, ...rest } = validPayload;
    const result = TokenIssueResponseSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  // Error paths: empty string token (violates min(1))
  it("rejects an empty string token", () => {
    const result = TokenIssueResponseSchema.safeParse({
      ...validPayload,
      token: "",
    });
    expect(result.success).toBe(false);
  });

  // Error paths: empty scope array (violates min(1))
  it("rejects an empty scope array", () => {
    const result = TokenIssueResponseSchema.safeParse({
      ...validPayload,
      scope: [],
    });
    expect(result.success).toBe(false);
  });

  // Error paths: wrong types
  it("rejects when token is a number", () => {
    const result = TokenIssueResponseSchema.safeParse({
      ...validPayload,
      token: 12345,
    });
    expect(result.success).toBe(false);
  });

  it("rejects when expiresAt is a number (Unix timestamp)", () => {
    const result = TokenIssueResponseSchema.safeParse({
      ...validPayload,
      expiresAt: 1710763200,
    });
    expect(result.success).toBe(false);
  });

  it("rejects when scope is a string instead of an array", () => {
    const result = TokenIssueResponseSchema.safeParse({
      ...validPayload,
      scope: "vault:read",
    });
    expect(result.success).toBe(false);
  });

  it("rejects when scope contains non-string elements", () => {
    const result = TokenIssueResponseSchema.safeParse({
      ...validPayload,
      scope: [1, 2, 3],
    });
    expect(result.success).toBe(false);
  });

  // Error paths: invalid datetime format
  it("rejects a date-only string (missing time component)", () => {
    const result = TokenIssueResponseSchema.safeParse({
      ...validPayload,
      expiresAt: "2026-03-18",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a human-readable datetime string (not ISO 8601)", () => {
    const result = TokenIssueResponseSchema.safeParse({
      ...validPayload,
      expiresAt: "March 18, 2026 12:00:00",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an arbitrary non-datetime string in expiresAt", () => {
    const result = TokenIssueResponseSchema.safeParse({
      ...validPayload,
      expiresAt: "not-a-date",
    });
    expect(result.success).toBe(false);
  });

  // Error paths: null / undefined input
  it("rejects null", () => {
    const result = TokenIssueResponseSchema.safeParse(null);
    expect(result.success).toBe(false);
  });

  it("rejects undefined", () => {
    const result = TokenIssueResponseSchema.safeParse(undefined);
    expect(result.success).toBe(false);
  });
});

// ─── TokenRevokeResponseSchema ────────────────────────────────

describe("TokenRevokeResponseSchema", () => {
  // Happy path
  it("accepts { ok: true }", () => {
    const result = TokenRevokeResponseSchema.safeParse({ ok: true });
    expect(result.success).toBe(true);
  });

  it("returns data with ok: true on success", () => {
    const result = TokenRevokeResponseSchema.safeParse({ ok: true });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ok).toBe(true);
    }
  });

  // Schema strictness: extra fields are stripped
  it("strips extra fields (Zod default strip behavior)", () => {
    const result = TokenRevokeResponseSchema.safeParse({
      ok: true,
      message: "token revoked",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("message");
    }
  });

  // Error paths: ok: false (literal rejects false)
  it("rejects { ok: false }", () => {
    const result = TokenRevokeResponseSchema.safeParse({ ok: false });
    expect(result.success).toBe(false);
  });

  // Error paths: wrong types for ok
  it("rejects when ok is a string 'true'", () => {
    const result = TokenRevokeResponseSchema.safeParse({ ok: "true" });
    expect(result.success).toBe(false);
  });

  it("rejects when ok is 1 (number)", () => {
    const result = TokenRevokeResponseSchema.safeParse({ ok: 1 });
    expect(result.success).toBe(false);
  });

  // Error paths: missing field
  it("rejects when ok field is missing", () => {
    const result = TokenRevokeResponseSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  // Error paths: null / undefined input
  it("rejects null", () => {
    const result = TokenRevokeResponseSchema.safeParse(null);
    expect(result.success).toBe(false);
  });

  it("rejects undefined", () => {
    const result = TokenRevokeResponseSchema.safeParse(undefined);
    expect(result.success).toBe(false);
  });
});
