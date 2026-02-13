import { describe, expect, it } from "vitest";
import { ORG_PERMISSION } from "@/lib/constants";

describe("org permission constants", () => {
  it("has unique permission values", () => {
    const values = Object.values(ORG_PERMISSION);
    expect(new Set(values).size).toBe(values.length);
  });

  it("uses namespace:value format", () => {
    for (const value of Object.values(ORG_PERMISSION)) {
      expect(value).toMatch(/^[a-z]+:[a-zA-Z]+$/);
    }
  });
});
