import { describe, it, expect, vi, afterEach } from "vitest";
import { createShareAccessToken, verifyShareAccessToken } from "./share-access-token";

describe("share-access-token", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a token in payload.signature format", () => {
    const token = createShareAccessToken("share-1");
    expect(token).toContain(".");
    const parts = token.split(".");
    expect(parts).toHaveLength(2);
    expect(parts[0].length).toBeGreaterThan(0);
    expect(parts[1].length).toBeGreaterThan(0);
  });

  it("verifies a valid token for the correct share ID", () => {
    const token = createShareAccessToken("share-1");
    expect(verifyShareAccessToken(token, "share-1")).toBe(true);
  });

  it("rejects a token for a different share ID", () => {
    const token = createShareAccessToken("share-1");
    expect(verifyShareAccessToken(token, "share-2")).toBe(false);
  });

  it("rejects a tampered token", () => {
    const token = createShareAccessToken("share-1");
    const tampered = token.slice(0, -3) + "xxx";
    expect(verifyShareAccessToken(tampered, "share-1")).toBe(false);
  });

  it("rejects a token without a dot separator", () => {
    expect(verifyShareAccessToken("nodot", "share-1")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(verifyShareAccessToken("", "share-1")).toBe(false);
  });

  it("rejects an expired token", () => {
    // Mock Date.now to create a token, then advance time past TTL
    const realNow = Date.now;
    const start = realNow();

    vi.spyOn(Date, "now").mockReturnValue(start);
    const token = createShareAccessToken("share-1");

    // Advance 6 minutes (past 5-min TTL)
    vi.spyOn(Date, "now").mockReturnValue(start + 6 * 60 * 1000);
    expect(verifyShareAccessToken(token, "share-1")).toBe(false);

    vi.spyOn(Date, "now").mockReturnValue(realNow());
  });

  it("accepts a token within TTL", () => {
    const realNow = Date.now;
    const start = realNow();

    vi.spyOn(Date, "now").mockReturnValue(start);
    const token = createShareAccessToken("share-1");

    // Advance 4 minutes (within 5-min TTL)
    vi.spyOn(Date, "now").mockReturnValue(start + 4 * 60 * 1000);
    expect(verifyShareAccessToken(token, "share-1")).toBe(true);

    vi.spyOn(Date, "now").mockReturnValue(realNow());
  });

  it("accepts a token at exactly the TTL boundary (> not >=)", () => {
    const realNow = Date.now;
    const start = realNow();
    const TTL_MS = 5 * 60 * 1000;

    vi.spyOn(Date, "now").mockReturnValue(start);
    const token = createShareAccessToken("share-1");

    // At exactly TTL: Date.now() === exp, condition is > so still valid
    vi.spyOn(Date, "now").mockReturnValue(start + TTL_MS);
    expect(verifyShareAccessToken(token, "share-1")).toBe(true);

    // 1ms past TTL: Date.now() > exp, rejected
    vi.spyOn(Date, "now").mockReturnValue(start + TTL_MS + 1);
    expect(verifyShareAccessToken(token, "share-1")).toBe(false);

    vi.spyOn(Date, "now").mockReturnValue(realNow());
  });
});
