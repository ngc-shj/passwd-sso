import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { routing } from "@/i18n/routing";
import { NAMESPACES } from "@/i18n/messages";

function flattenKeys(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }

  return Object.entries(value).flatMap(([key, nested]) => {
    const current = prefix ? `${prefix}.${key}` : key;
    return flattenKeys(nested, current);
  });
}

function loadLocale(locale: string): Record<string, unknown> {
  const dir = path.resolve(process.cwd(), "messages", locale);
  const result: Record<string, unknown> = {};
  for (const ns of NAMESPACES) {
    const file = path.join(dir, `${ns}.json`);
    result[ns] = JSON.parse(fs.readFileSync(file, "utf-8"));
  }
  return result;
}

describe("messages consistency", () => {
  it("has a directory for each configured locale", () => {
    for (const locale of routing.locales) {
      const dir = path.resolve(process.cwd(), "messages", locale);
      expect(fs.existsSync(dir), `Missing directory: messages/${locale}/`).toBe(
        true,
      );
    }
  });

  it("has a json file for each namespace in each locale", () => {
    for (const locale of routing.locales) {
      const dir = path.resolve(process.cwd(), "messages", locale);
      for (const ns of NAMESPACES) {
        const file = path.join(dir, `${ns}.json`);
        expect(
          fs.existsSync(file),
          `Missing: messages/${locale}/${ns}.json`,
        ).toBe(true);
      }
    }
  });

  it("has no extra files beyond declared namespaces", () => {
    for (const locale of routing.locales) {
      const dir = path.resolve(process.cwd(), "messages", locale);
      const actual = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .sort();
      const expected = [...NAMESPACES].map((ns) => `${ns}.json`).sort();
      expect(actual).toEqual(expected);
    }
  });

  it("keeps key sets aligned between locales", () => {
    const [base, ...rest] = routing.locales.map(loadLocale);
    const baseKeys = flattenKeys(base).sort();
    for (const other of rest) {
      expect(flattenKeys(other).sort()).toEqual(baseKeys);
    }
  });
});
