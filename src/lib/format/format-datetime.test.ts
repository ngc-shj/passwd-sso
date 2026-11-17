import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { formatDate, formatDateTime, formatRelativeTime, parseLocalDate, toISODateString } from "@/lib/format/format-datetime";

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

describe("parseLocalDate", () => {
  it("reads the value as the start of that local day, not UTC midnight", () => {
    vi.stubEnv("TZ", "Asia/Tokyo");
    expect(parseLocalDate("2026-11-17")?.toISOString()).toBe("2026-11-16T15:00:00.000Z");
  });

  it("with endOfDay, returns the local day's last millisecond west of UTC", () => {
    vi.stubEnv("TZ", "America/New_York");
    expect(parseLocalDate("2026-11-17", true)?.toISOString()).toBe("2026-11-18T04:59:59.999Z");
  });

  it("ends a day whose 23:59 falls in a DST gap at the next day's start (America/Nuuk)", () => {
    vi.stubEnv("TZ", "America/Nuuk");
    expect(parseLocalDate("2026-03-28", true)?.toISOString()).toBe("2026-03-29T00:59:59.999Z");
    expect(parseLocalDate("2026-03-29", true)?.toISOString()).toBe("2026-03-30T00:59:59.999Z");
  });

  it("is the inverse of toISODateString", () => {
    const day = parseLocalDate("2026-02-28");
    expect(day && toISODateString(day)).toBe("2026-02-28");
  });

  it("reads years below 100 and above 9999 as written", () => {
    expect(parseLocalDate("0050-03-01")?.getFullYear()).toBe(50);
    expect(parseLocalDate("12345-03-01")?.getFullYear()).toBe(12345);
    // The to-filter path too.
    expect(parseLocalDate("0050-03-01", true)?.getFullYear()).toBe(50);
  });

  it("refuses a year past the Date range", () => {
    expect(parseLocalDate("300000-01-01")).toBeUndefined();
    expect(parseLocalDate("300000-01-01", true)).toBeUndefined();
  });

  it("refuses a malformed value and a day the month does not have", () => {
    expect(parseLocalDate("2026-5-1")).toBeUndefined();
    expect(parseLocalDate("2026-02-30")).toBeUndefined();
    expect(parseLocalDate("")).toBeUndefined();
  });
});
