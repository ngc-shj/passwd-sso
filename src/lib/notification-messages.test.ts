import { describe, it, expect } from "vitest";
import { notificationTitle, notificationBody } from "./notification-messages";

const KEYS = [
  "NEW_DEVICE_LOGIN",
  "ADMIN_VAULT_RESET",
  "ADMIN_VAULT_RESET_REVOKED",
  "WATCHTOWER_ALERT",
] as const;

const LOCALES = ["en", "ja"] as const;

describe("notificationTitle", () => {
  for (const key of KEYS) {
    for (const locale of LOCALES) {
      it(`returns a non-empty string for ${key} (${locale})`, () => {
        const result = notificationTitle(key, locale);
        expect(typeof result).toBe("string");
        expect(result.length).toBeGreaterThan(0);
      });
    }
  }
});

describe("notificationBody", () => {
  it("returns a non-empty string for ADMIN_VAULT_RESET (en)", () => {
    const result = notificationBody("ADMIN_VAULT_RESET", "en");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns a non-empty string for ADMIN_VAULT_RESET (ja)", () => {
    const result = notificationBody("ADMIN_VAULT_RESET", "ja");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns a non-empty string for ADMIN_VAULT_RESET_REVOKED (en)", () => {
    const result = notificationBody("ADMIN_VAULT_RESET_REVOKED", "en");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns a non-empty string for ADMIN_VAULT_RESET_REVOKED (ja)", () => {
    const result = notificationBody("ADMIN_VAULT_RESET_REVOKED", "ja");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns a non-empty string for NEW_DEVICE_LOGIN (en)", () => {
    const result = notificationBody("NEW_DEVICE_LOGIN", "en", "Chrome", "macOS");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns a non-empty string for NEW_DEVICE_LOGIN (ja)", () => {
    const result = notificationBody("NEW_DEVICE_LOGIN", "ja", "Chrome", "macOS");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns a non-empty string for WATCHTOWER_ALERT (en)", () => {
    const result = notificationBody("WATCHTOWER_ALERT", "en", "5");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns a non-empty string for WATCHTOWER_ALERT (ja)", () => {
    const result = notificationBody("WATCHTOWER_ALERT", "ja", "5");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  describe("WATCHTOWER_ALERT body includes count argument", () => {
    it("includes the count in English body", () => {
      const result = notificationBody("WATCHTOWER_ALERT", "en", "42");
      expect(result).toContain("42");
    });

    it("includes the count in Japanese body", () => {
      const result = notificationBody("WATCHTOWER_ALERT", "ja", "42");
      expect(result).toContain("42");
    });
  });

  describe("NEW_DEVICE_LOGIN body includes browser and OS arguments", () => {
    it("includes browser and OS in English body", () => {
      const result = notificationBody("NEW_DEVICE_LOGIN", "en", "Firefox", "Windows");
      expect(result).toContain("Firefox");
      expect(result).toContain("Windows");
    });

    it("includes browser and OS in Japanese body", () => {
      const result = notificationBody("NEW_DEVICE_LOGIN", "ja", "Firefox", "Windows");
      expect(result).toContain("Firefox");
      expect(result).toContain("Windows");
    });
  });
});

describe("locale fallback", () => {
  it("falls back to English for unknown locale in notificationTitle", () => {
    const result = notificationTitle("ADMIN_VAULT_RESET", "fr");
    const enResult = notificationTitle("ADMIN_VAULT_RESET", "en");
    expect(result).toBe(enResult);
  });

  it("falls back to English for unknown locale in notificationBody", () => {
    const result = notificationBody("ADMIN_VAULT_RESET", "fr");
    const enResult = notificationBody("ADMIN_VAULT_RESET", "en");
    expect(result).toBe(enResult);
  });
});
