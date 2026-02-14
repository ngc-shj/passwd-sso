import { describe, expect, it, vi } from "vitest";
import { formatDate, formatDateTime } from "@/lib/format-datetime";

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
