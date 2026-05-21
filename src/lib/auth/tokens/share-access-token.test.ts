import { describe, it, expect, vi, afterEach } from "vitest";
import { createShareAccessToken, verifyShareAccessToken } from "./share-access-token";
import { MS_PER_MINUTE } from "@/lib/constants/time";

describe("share-access-token", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a token in kv.payload.signature (3-segment) format", () => {
    const token = createShareAccessToken("share-1");
    const parts = token.split(".");
    expect(parts).toHaveLength(3);
    // kv segment is a positive ASCII decimal integer
    expect(parts[0]).toMatch(/^[1-9][0-9]*$/);
    expect(parts[1].length).toBeGreaterThan(0);
    expect(parts[2].length).toBeGreaterThan(0);
  });

  it("rejects legacy 2-segment tokens (no kv prefix)", () => {
    // Manually craft a v1-style token without the kv prefix — should be rejected
    expect(verifyShareAccessToken("payload.signature", "share-1")).toBe(false);
  });

  it("rejects tampered kv (downgrade attempt)", () => {
    const token = createShareAccessToken("share-1");
    const parts = token.split(".");
    // Rewrite kv from e.g. "1" to a different version while keeping payload+sig
    const tampered = `9999.${parts[1]}.${parts[2]}`;
    expect(verifyShareAccessToken(tampered, "share-1")).toBe(false);
  });

  it("rejects non-integer kv (e.g. '1.0')", () => {
    // The leading '1.0' parses with Number() but fails the regex
    expect(verifyShareAccessToken("01.payload.sig", "share-1")).toBe(false);
    expect(verifyShareAccessToken(" 1.payload.sig", "share-1")).toBe(false);
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

  it("rejects a token without dot separators", () => {
    expect(verifyShareAccessToken("nodot", "share-1")).toBe(false);
  });

  it("rejects a token with only one dot (insufficient segments)", () => {
    expect(verifyShareAccessToken("one.dot", "share-1")).toBe(false);
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
    vi.spyOn(Date, "now").mockReturnValue(start + 6 * MS_PER_MINUTE);
    expect(verifyShareAccessToken(token, "share-1")).toBe(false);

    vi.spyOn(Date, "now").mockReturnValue(realNow());
  });

  it("accepts a token within TTL", () => {
    const realNow = Date.now;
    const start = realNow();

    vi.spyOn(Date, "now").mockReturnValue(start);
    const token = createShareAccessToken("share-1");

    // Advance 4 minutes (within 5-min TTL)
    vi.spyOn(Date, "now").mockReturnValue(start + 4 * MS_PER_MINUTE);
    expect(verifyShareAccessToken(token, "share-1")).toBe(true);

    vi.spyOn(Date, "now").mockReturnValue(realNow());
  });

  it("accepts a token at exactly the TTL boundary (> not >=)", () => {
    const realNow = Date.now;
    const start = realNow();
    const TTL_MS = 5 * MS_PER_MINUTE;

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
