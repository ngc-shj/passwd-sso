import { describe, expect, it } from "vitest";
import { formatDateTime } from "@/lib/format-datetime";

describe("formatDateTime", () => {
  it("returns locale-formatted date string", () => {
    const out = formatDateTime("2026-01-02T03:04:05.000Z", "en");
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });
});

