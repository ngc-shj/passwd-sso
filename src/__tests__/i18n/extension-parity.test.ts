import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function readExtension(locale: string): Record<string, string> {
  return JSON.parse(
    readFileSync(
      join(process.cwd(), "messages", locale, "Extension.json"),
      "utf8",
    ),
  ) as Record<string, string>;
}

describe("Extension.json en/ja parity", () => {
  it("en and ja have identical key sets", () => {
    const en = readExtension("en");
    const ja = readExtension("ja");
    expect(Object.keys(en).sort()).toEqual(Object.keys(ja).sort());
  });

  it("every value is a non-empty string in both locales", () => {
    const en = readExtension("en");
    const ja = readExtension("ja");
    for (const [k, v] of Object.entries(en)) {
      expect(typeof v).toBe("string");
      expect(v.length).toBeGreaterThan(0);
      expect(typeof ja[k]).toBe("string");
      expect(ja[k].length).toBeGreaterThan(0);
    }
  });
});
