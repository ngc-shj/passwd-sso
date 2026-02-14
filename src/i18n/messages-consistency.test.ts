import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import ja from "../../messages/ja.json";
import { routing } from "@/i18n/routing";

function flattenKeys(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }

  return Object.entries(value).flatMap(([key, nested]) => {
    const current = prefix ? `${prefix}.${key}` : key;
    return flattenKeys(nested, current);
  });
}

describe("messages consistency", () => {
  it("has a json file for each configured locale", () => {
    const dir = path.resolve(process.cwd(), "messages");
    for (const locale of routing.locales) {
      const file = path.join(dir, `${locale}.json`);
      expect(fs.existsSync(file)).toBe(true);
    }
  });

  it("keeps key sets aligned between locales", () => {
    const base = flattenKeys(en).sort();
    const other = flattenKeys(ja).sort();
    expect(other).toEqual(base);
  });
});
