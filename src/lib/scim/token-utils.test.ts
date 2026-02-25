import { describe, it, expect } from "vitest";
import { generateScimToken, SCIM_TOKEN_PREFIX } from "./token-utils";

describe("generateScimToken", () => {
  it("starts with the scim_ prefix", () => {
    const token = generateScimToken();
    expect(token.startsWith(SCIM_TOKEN_PREFIX)).toBe(true);
  });

  it("has correct length (prefix + 64 hex chars = 69 chars)", () => {
    const token = generateScimToken();
    expect(token.length).toBe(SCIM_TOKEN_PREFIX.length + 64);
  });

  it("hex portion contains only valid hex characters", () => {
    const token = generateScimToken();
    const hex = token.slice(SCIM_TOKEN_PREFIX.length);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates unique tokens", () => {
    const tokens = new Set(Array.from({ length: 10 }, () => generateScimToken()));
    expect(tokens.size).toBe(10);
  });
});
