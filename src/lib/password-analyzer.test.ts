import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  calculateEntropy,
  detectPatterns,
  analyzeStrength,
  checkHIBP,
  delay,
} from "./password-analyzer";

// ─── calculateEntropy ────────────────────────────────────────

describe("calculateEntropy", () => {
  it("returns 0 for empty string", () => {
    expect(calculateEntropy("")).toBe(0);
  });

  it("calculates entropy for lowercase-only password", () => {
    // charset 26, length 8 → log2(26) * 8 ≈ 37.6
    const e = calculateEntropy("abcdefgh");
    expect(e).toBeCloseTo(37.6, 0);
  });

  it("calculates entropy for mixed-case alphanumeric with symbols", () => {
    // charset 26+26+10+33 = 95, length 12 → log2(95) * 12 ≈ 78.8
    const e = calculateEntropy("Abcdef1234!@");
    expect(e).toBeCloseTo(78.8, 0);
  });

  it("calculates entropy for digits only", () => {
    // charset 10, length 4 → log2(10) * 4 ≈ 13.3
    const e = calculateEntropy("1234");
    expect(e).toBeCloseTo(13.3, 0);
  });
});

// ─── detectPatterns ──────────────────────────────────────────

describe("detectPatterns", () => {
  it("returns empty array for strong random password", () => {
    expect(detectPatterns("x9!Qm@2z")).toEqual([]);
  });

  it("detects sequential characters (ascending)", () => {
    expect(detectPatterns("abc")).toContain("sequential");
  });

  it("detects sequential characters (descending)", () => {
    expect(detectPatterns("cba")).toContain("sequential");
  });

  it("detects repeated characters", () => {
    expect(detectPatterns("aaax")).toContain("repeated");
  });

  it("detects keyboard patterns", () => {
    expect(detectPatterns("qwert")).toContain("keyboard");
  });

  it("detects reversed keyboard patterns", () => {
    expect(detectPatterns("poiuy")).toContain("keyboard");
  });

  it("detects common words", () => {
    const patterns = detectPatterns("mypassword123");
    expect(patterns.some((p) => p.startsWith("common:"))).toBe(true);
    expect(patterns).toContain("common:password");
  });

  it("detects multiple patterns simultaneously", () => {
    const patterns = detectPatterns("aaaqwerty");
    expect(patterns).toContain("repeated");
    expect(patterns).toContain("keyboard");
  });
});

// ─── analyzeStrength ─────────────────────────────────────────

describe("analyzeStrength", () => {
  it("gives low score to short password", () => {
    const result = analyzeStrength("abc");
    expect(result.score).toBeLessThanOrEqual(20);
    expect(result.hasLowercase).toBe(true);
    expect(result.hasUppercase).toBe(false);
  });

  it("gives high score to long complex password", () => {
    const result = analyzeStrength("Tr0ub4dor&3xYz!pQ9#mK");
    expect(result.score).toBeGreaterThan(60);
    expect(result.hasUppercase).toBe(true);
    expect(result.hasLowercase).toBe(true);
    expect(result.hasNumbers).toBe(true);
    expect(result.hasSymbols).toBe(true);
  });

  it("penalizes common word passwords", () => {
    const common = analyzeStrength("password123!");
    const random = analyzeStrength("x9Q!m2zW$kLp");
    expect(common.score).toBeLessThan(random.score);
  });

  it("clamps score between 0 and 100", () => {
    const result = analyzeStrength("A".repeat(200) + "1!a");
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  it("returns entropy and patterns in result", () => {
    const result = analyzeStrength("password");
    expect(result.entropy).toBeGreaterThan(0);
    expect(result.patterns).toContain("common:password");
  });
});

// ─── checkHIBP ───────────────────────────────────────────────

describe("checkHIBP", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns breached=true with count when hash suffix matches", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("0018A45C4D1DEF81644B54AB7F969B88D65:42\nABCDEF1234567890ABCDEF1234567890ABC:1"),
    );

    // We don't know the actual hash, so let's test with a known SHA-1
    // "password" → SHA-1 → 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
    // prefix=5BAA6, suffix=1E4C9B93F3F0682250B6CF8331B7EE68FD8
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("1E4C9B93F3F0682250B6CF8331B7EE68FD8:9999999"),
    );

    const result = await checkHIBP("password");
    expect(result.breached).toBe(true);
    expect(result.count).toBe(9999999);
  });

  it("returns breached=false when hash suffix not found", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("0000000000000000000000000000000000000:1"),
    );

    const result = await checkHIBP("some-unique-password-xyz");
    expect(result.breached).toBe(false);
    expect(result.count).toBe(0);
  });

  it("returns breached=false on fetch error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network error"));
    const result = await checkHIBP("test");
    expect(result.breached).toBe(false);
    expect(result.count).toBe(0);
  });

  it("returns breached=false on non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Too Many Requests", { status: 429 }),
    );
    const result = await checkHIBP("test");
    expect(result.breached).toBe(false);
    expect(result.count).toBe(0);
  });
});

// ─── delay ───────────────────────────────────────────────────

describe("delay", () => {
  it("resolves after specified time", async () => {
    vi.useFakeTimers();
    const p = delay(100);
    vi.advanceTimersByTime(100);
    await p;
    vi.useRealTimers();
  });
});
