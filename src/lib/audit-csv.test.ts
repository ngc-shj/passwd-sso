import { describe, expect, it } from "vitest";
import { escapeCsvValue, formatCsvRow } from "./audit-csv";

describe("escapeCsvValue", () => {
  it("prefixes formula-triggering '=' with a single quote inside quotes", () => {
    expect(escapeCsvValue("=SUM(A1)")).toBe(`"'=SUM(A1)"`);
  });

  it("prefixes formula-triggering '+' with a single quote inside quotes", () => {
    expect(escapeCsvValue("+1")).toBe(`"'+1"`);
  });

  it("prefixes formula-triggering '-' with a single quote inside quotes", () => {
    expect(escapeCsvValue("-1")).toBe(`"'-1"`);
  });

  it("prefixes formula-triggering '@' with a single quote inside quotes", () => {
    expect(escapeCsvValue("@user")).toBe(`"'@user"`);
  });

  it("prefixes formula-triggering tab character with a single quote inside quotes", () => {
    expect(escapeCsvValue("\tcell")).toBe(`"'\tcell"`);
  });

  it("prefixes formula-triggering CR character with a single quote inside quotes", () => {
    expect(escapeCsvValue("\rcell")).toBe(`"'\rcell"`);
  });

  it("wraps normal strings in double quotes without modification", () => {
    expect(escapeCsvValue("hello")).toBe(`"hello"`);
  });

  it("wraps empty string in double quotes", () => {
    expect(escapeCsvValue("")).toBe(`""`);
  });

  it("escapes embedded double quotes by doubling them", () => {
    expect(escapeCsvValue(`say "hi"`)).toBe(`"say ""hi"""`);
  });

  it("escapes embedded double quotes before applying injection prefix", () => {
    expect(escapeCsvValue(`="injected"`)).toBe(`"'=""injected"""`);
  });
});

describe("formatCsvRow", () => {
  it("joins multiple values with commas, each properly escaped", () => {
    expect(formatCsvRow(["hello", "world"])).toBe(`"hello","world"`);
  });

  it("applies injection escaping to each value in the row", () => {
    expect(formatCsvRow(["=EVIL()", "normal", `has"quote`])).toBe(
      `"'=EVIL()","normal","has""quote"`
    );
  });

  it("formats a single-element array correctly", () => {
    expect(formatCsvRow(["only"])).toBe(`"only"`);
  });

  it("formats an empty array as an empty string", () => {
    expect(formatCsvRow([])).toBe("");
  });
});
