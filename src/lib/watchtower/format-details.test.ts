import { describe, expect, it, vi } from "vitest";
import {
  formatBreachDetails,
  formatWeakDetails,
  formatOldDetails,
  formatUnsecuredDetails,
  formatExpiringDetails,
} from "@/lib/watchtower/format-details";

const mockT = vi.fn(
  (key: string, params: Record<string, string | number>) =>
    `${key}:${JSON.stringify(params)}`,
);

describe("formatBreachDetails", () => {
  it("extracts count and passes to translator", () => {
    const result = formatBreachDetails("count:5", mockT);
    expect(mockT).toHaveBeenCalledWith("breachedCount", { count: "5" });
    expect(result).toBe('breachedCount:{"count":"5"}');
  });
});

describe("formatWeakDetails", () => {
  it("extracts entropy and passes to translator", () => {
    const result = formatWeakDetails("entropy:32.5", mockT);
    expect(mockT).toHaveBeenCalledWith("weakEntropy", { entropy: "32.5" });
    expect(result).toBe('weakEntropy:{"entropy":"32.5"}');
  });
});

describe("formatOldDetails", () => {
  it("extracts days and passes to translator", () => {
    const result = formatOldDetails("days:120", mockT);
    expect(mockT).toHaveBeenCalledWith("oldDays", { days: "120" });
    expect(result).toBe('oldDays:{"days":"120"}');
  });
});

describe("formatUnsecuredDetails", () => {
  it("strips url: prefix and returns the URL", () => {
    expect(formatUnsecuredDetails("url:http://example.com")).toBe(
      "http://example.com",
    );
  });

  it("returns as-is when no url: prefix", () => {
    expect(formatUnsecuredDetails("http://example.com")).toBe(
      "http://example.com",
    );
  });
});

describe("formatExpiringDetails", () => {
  it("formats expired entries with days count", () => {
    const result = formatExpiringDetails("expired:7", "en", mockT);
    expect(mockT).toHaveBeenCalledWith("expiredDays", { days: "7" });
    expect(result).toBe('expiredDays:{"days":"7"}');
  });

  it("formats expiring entries with locale-aware date", () => {
    const result = formatExpiringDetails("expires:2026-06-15", "en", mockT);
    expect(mockT).toHaveBeenCalledWith("expiresOn", {
      date: new Date("2026-06-15").toLocaleDateString("en"),
    });
    expect(result).toContain("expiresOn");
  });

  it("uses locale for date formatting", () => {
    const result = formatExpiringDetails("expires:2026-06-15", "ja", mockT);
    expect(mockT).toHaveBeenCalledWith("expiresOn", {
      date: new Date("2026-06-15").toLocaleDateString("ja"),
    });
    expect(result).toContain("expiresOn");
  });
});
