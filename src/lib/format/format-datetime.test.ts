import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { formatDate, formatDateTime, formatRelativeTime, toISODateString } from "@/lib/format/format-datetime";

describe("formatDateTime", () => {
  it("passes locale to toLocaleString for Date input", () => {
    const date = new Date("2026-01-02T03:04:05.000Z");
    const spy = vi
      .spyOn(Date.prototype, "toLocaleString")
      .mockReturnValue("formatted");

    const out = formatDateTime(date, "en-US");

    expect(out).toBe("formatted");
    expect(spy).toHaveBeenCalledWith("en-US");
    spy.mockRestore();
  });

  it("supports string date input", () => {
    const spy = vi
      .spyOn(Date.prototype, "toLocaleString")
      .mockReturnValue("formatted-from-string");

    const out = formatDateTime("2026-01-02T03:04:05.000Z", "ja-JP");

    expect(out).toBe("formatted-from-string");
    expect(spy).toHaveBeenCalledWith("ja-JP");
    spy.mockRestore();
  });

  it("formats date-only output with locale", () => {
    const spy = vi
      .spyOn(Date.prototype, "toLocaleDateString")
      .mockReturnValue("date-only");

    const out = formatDate("2026-01-02T03:04:05.000Z", "en-US");

    expect(out).toBe("date-only");
    expect(spy).toHaveBeenCalledWith("en-US");
    spy.mockRestore();
  });
});

describe("formatRelativeTime", () => {
  const NOW = new Date("2026-03-01T12:00:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns seconds ago for recent timestamps", () => {
    const thirtySecsAgo = new Date(NOW.getTime() - 30_000);
    const result = formatRelativeTime(thirtySecsAgo, "en");
    expect(result).toContain("30");
  });

  it("returns minutes ago", () => {
    const fiveMinAgo = new Date(NOW.getTime() - 5 * 60_000);
    const result = formatRelativeTime(fiveMinAgo, "en");
    expect(result).toContain("5");
  });

  it("returns hours ago", () => {
    const twoHoursAgo = new Date(NOW.getTime() - 2 * 3600_000);
    const result = formatRelativeTime(twoHoursAgo, "en");
    expect(result).toContain("2");
  });

  it("returns days ago", () => {
    const threeDaysAgo = new Date(NOW.getTime() - 3 * 86400_000);
    const result = formatRelativeTime(threeDaysAgo, "en");
    expect(result).toContain("3");
  });

  it("falls back to locale date for old timestamps (>30 days)", () => {
    const spy = vi
      .spyOn(Date.prototype, "toLocaleDateString")
      .mockReturnValue("2/1/2026");
    const oldDate = new Date(NOW.getTime() - 60 * 86400_000);
    const result = formatRelativeTime(oldDate, "en");
    expect(result).toBe("2/1/2026");
    spy.mockRestore();
  });

  it("accepts string input", () => {
    const thirtySecsAgo = new Date(NOW.getTime() - 30_000).toISOString();
    const result = formatRelativeTime(thirtySecsAgo, "en");
    expect(result).toContain("30");
  });
});

describe("toISODateString", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns YYYY-MM-DD for a known date", () => {
    const date = new Date(2026, 5, 15); // June 15, 2026 (local)
    expect(toISODateString(date)).toBe("2026-06-15");
  });

  it("pads month and day with zeros for Jan 1", () => {
    const date = new Date(2026, 0, 1); // January 1, 2026 (local)
    expect(toISODateString(date)).toBe("2026-01-01");
  });

  it("returns correct value for Dec 31", () => {
    const date = new Date(2026, 11, 31); // December 31, 2026 (local)
    expect(toISODateString(date)).toBe("2026-12-31");
  });

  it("uses local date, not UTC date", () => {
    // Construct a date that is Dec 31 in local time but Jan 1 UTC,
    // by mocking getFullYear/getMonth/getDate via fake timers set to a
    // specific local time. We test by constructing the Date directly in local time.
    const date = new Date(2025, 11, 31, 23, 0, 0); // Dec 31, 2025 at 23:00 local
    const result = toISODateString(date);
    // Should reflect local date (Dec 31), not UTC date (which could be Jan 1)
    expect(result).toBe("2025-12-31");
  });

  it("uses current date when called with no argument", () => {
    vi.useFakeTimers({ now: new Date(2026, 2, 17) }); // March 17, 2026 (local)
    expect(toISODateString()).toBe("2026-03-17");
  });

  it("returns a string in YYYY-MM-DD format", () => {
    const date = new Date(2024, 7, 20); // August 20, 2024 (local)
    expect(toISODateString(date)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
