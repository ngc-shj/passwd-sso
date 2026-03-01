import { describe, it, expect } from "vitest";
import { generatePassword, generatePassphrase } from "./password-generator";

describe("generatePassword", () => {
  it("generates password of specified length", () => {
    const password = generatePassword({
      length: 20,
      uppercase: true,
      lowercase: true,
      numbers: true,
      symbols: "",
    });
    expect(password).toHaveLength(20);
  });

  it("includes uppercase when enabled", () => {
    const password = generatePassword({
      length: 50,
      uppercase: true,
      lowercase: false,
      numbers: false,
      symbols: "",
    });
    expect(password).toMatch(/[A-Z]/);
  });

  it("includes lowercase when enabled", () => {
    const password = generatePassword({
      length: 50,
      uppercase: false,
      lowercase: true,
      numbers: false,
      symbols: "",
    });
    expect(password).toMatch(/[a-z]/);
  });

  it("includes numbers when enabled", () => {
    const password = generatePassword({
      length: 50,
      uppercase: false,
      lowercase: false,
      numbers: true,
      symbols: "",
    });
    expect(password).toMatch(/[0-9]/);
  });

  it("includes symbols when provided", () => {
    const password = generatePassword({
      length: 50,
      uppercase: false,
      lowercase: false,
      numbers: false,
      symbols: "!@#$",
    });
    expect(password).toMatch(/[!@#$]/);
  });

  it("excludes ambiguous characters when option set", () => {
    // Generate a long password to increase chance of catching ambiguous chars
    const password = generatePassword({
      length: 128,
      uppercase: true,
      lowercase: true,
      numbers: true,
      symbols: "!|",
      excludeAmbiguous: true,
    });
    // Ambiguous chars: 0OoIl1|
    expect(password).not.toMatch(/[0OoIl1|]/);
  });

  it("throws when no character type is selected", () => {
    expect(() =>
      generatePassword({
        length: 16,
        uppercase: false,
        lowercase: false,
        numbers: false,
        symbols: "",
      })
    ).toThrow("At least one character type must be selected");
  });

  it("generates different passwords each time", () => {
    const opts = {
      length: 32,
      uppercase: true,
      lowercase: true,
      numbers: true,
      symbols: "!@#",
    };
    const p1 = generatePassword(opts);
    const p2 = generatePassword(opts);
    // Extremely unlikely to be the same
    expect(p1).not.toBe(p2);
  });

  it("respects minimum length with all character types", () => {
    const password = generatePassword({
      length: 8,
      uppercase: true,
      lowercase: true,
      numbers: true,
      symbols: "!@#$",
    });
    expect(password).toHaveLength(8);
    // Should have at least one of each required type
    expect(password).toMatch(/[A-Z]/);
    expect(password).toMatch(/[a-z]/);
    expect(password).toMatch(/[0-9]/);
    expect(password).toMatch(/[!@#$]/);
  });

  it("includes at least one includeChars character", () => {
    const password = generatePassword({
      length: 20,
      uppercase: true,
      lowercase: true,
      numbers: false,
      symbols: "",
      includeChars: "@#",
    });
    expect(password).toHaveLength(20);
    expect(password).toMatch(/[@#]/);
  });

  it("excludes all excludeChars from generated password", () => {
    const password = generatePassword({
      length: 128,
      uppercase: true,
      lowercase: true,
      numbers: true,
      symbols: "",
      excludeChars: "abc123",
    });
    expect(password).not.toMatch(/[abc123]/);
  });

  it("excludeChars takes priority over includeChars", () => {
    const password = generatePassword({
      length: 128,
      uppercase: true,
      lowercase: true,
      numbers: true,
      symbols: "",
      includeChars: "abc",
      excludeChars: "a",
    });
    expect(password).not.toMatch(/a/);
  });

  it("throws when excludeChars removes all characters", () => {
    expect(() =>
      generatePassword({
        length: 16,
        uppercase: false,
        lowercase: false,
        numbers: false,
        symbols: "",
        includeChars: "abc",
        excludeChars: "abc",
      })
    ).toThrow("At least one character type must be selected");
  });

  it("generates with only includeChars (all types off)", () => {
    const password = generatePassword({
      length: 10,
      uppercase: false,
      lowercase: false,
      numbers: false,
      symbols: "",
      includeChars: "xyz",
    });
    expect(password).toHaveLength(10);
    expect(password).toMatch(/^[xyz]+$/);
  });

  it("includes both uppercase and includeChars when combined", () => {
    const password = generatePassword({
      length: 50,
      uppercase: true,
      lowercase: false,
      numbers: false,
      symbols: "",
      includeChars: "!@",
    });
    expect(password).toMatch(/[A-Z]/);
    expect(password).toMatch(/[!@]/);
  });

  it("handles excludeAmbiguous and excludeChars together", () => {
    const password = generatePassword({
      length: 128,
      uppercase: true,
      lowercase: true,
      numbers: true,
      symbols: "",
      excludeAmbiguous: true,
      excludeChars: "abc",
    });
    // Ambiguous chars: 0OoIl1|
    expect(password).not.toMatch(/[0OoIl1|abc]/);
  });

  it("handles duplicate characters in includeChars", () => {
    const password = generatePassword({
      length: 10,
      uppercase: false,
      lowercase: false,
      numbers: false,
      symbols: "",
      includeChars: "aaabbb",
    });
    expect(password).toHaveLength(10);
    expect(password).toMatch(/^[ab]+$/);
  });
});

describe("generatePassphrase", () => {
  it("generates passphrase with correct word count", () => {
    const passphrase = generatePassphrase({
      wordCount: 4,
      separator: "-",
      capitalize: false,
      includeNumber: false,
    });
    const parts = passphrase.split("-");
    expect(parts).toHaveLength(4);
  });

  it("uses specified separator", () => {
    const passphrase = generatePassphrase({
      wordCount: 3,
      separator: ".",
      capitalize: false,
      includeNumber: false,
    });
    expect(passphrase).toContain(".");
    expect(passphrase.split(".")).toHaveLength(3);
  });

  it("capitalizes words when option set", () => {
    const passphrase = generatePassphrase({
      wordCount: 4,
      separator: "-",
      capitalize: true,
      includeNumber: false,
    });
    const words = passphrase.split("-");
    for (const word of words) {
      expect(word.charAt(0)).toMatch(/[A-Z]/);
    }
  });

  it("does not capitalize when option is false", () => {
    const passphrase = generatePassphrase({
      wordCount: 4,
      separator: "-",
      capitalize: false,
      includeNumber: false,
    });
    const words = passphrase.split("-");
    for (const word of words) {
      expect(word.charAt(0)).toMatch(/[a-z]/);
    }
  });

  it("includes a number segment when includeNumber is true", () => {
    const passphrase = generatePassphrase({
      wordCount: 4,
      separator: "-",
      capitalize: false,
      includeNumber: true,
    });
    const parts = passphrase.split("-");
    // Should have 5 parts (4 words + 1 number)
    expect(parts).toHaveLength(5);
    // At least one part should be a number
    const hasNumber = parts.some((p) => /^\d+$/.test(p));
    expect(hasNumber).toBe(true);
  });

  it("generates different passphrases each time", () => {
    const opts = {
      wordCount: 6,
      separator: "-",
      capitalize: true,
      includeNumber: false,
    };
    const p1 = generatePassphrase(opts);
    const p2 = generatePassphrase(opts);
    expect(p1).not.toBe(p2);
  });
});
