/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import en from "../../messages/en.json";
import ja from "../../messages/ja.json";
import { t } from "../../lib/i18n";

function flattenKeys(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }

  return Object.entries(value).flatMap(([key, nested]) => {
    const current = prefix ? `${prefix}.${key}` : key;
    return flattenKeys(nested, current);
  });
}

describe("extension i18n", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(window.navigator, "language", {
      value: "en-US",
      configurable: true,
    });
  });

  it("falls back to en for unsupported UI language", () => {
    vi.stubGlobal("chrome", {
      i18n: { getUILanguage: () => "fr-FR" },
    });

    expect(t("popup.title")).toBe(en.popup.title);
  });

  it("uses locale prefix match", () => {
    vi.stubGlobal("chrome", {
      i18n: { getUILanguage: () => "ja-JP" },
    });

    expect(t("popup.title")).toBe(ja.popup.title);
  });

  it("returns key path when message key does not exist", () => {
    vi.stubGlobal("chrome", {
      i18n: { getUILanguage: () => "ja-JP" },
    });

    expect(t("unknown.path")).toBe("unknown.path");
  });

  it("keeps key sets aligned between locales", () => {
    const enKeys = flattenKeys(en).sort();
    const jaKeys = flattenKeys(ja).sort();
    expect(jaKeys).toEqual(enKeys);
  });

  it("has locale json files on disk", () => {
    const dir = path.resolve(process.cwd(), "src/messages");
    expect(fs.existsSync(path.join(dir, "en.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "ja.json"))).toBe(true);
  });
});
