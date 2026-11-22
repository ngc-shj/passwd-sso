import { describe, it, expect } from "vitest";
import { parseLines } from "./parse-lines";

describe("parseLines", () => {
  it("returns one value per line", () => {
    expect(parseLines("10.0.0.0/8\n192.168.0.0/16")).toEqual(["10.0.0.0/8", "192.168.0.0/16"]);
  });

  it("strips the carriage return of CRLF line endings", () => {
    expect(parseLines("a\r\nb\r\n")).toEqual(["a", "b"]);
  });

  it("trims surrounding whitespace from each line", () => {
    expect(parseLines("  a \t\n\tb  ")).toEqual(["a", "b"]);
  });

  it("drops blank and whitespace-only lines", () => {
    expect(parseLines("a\n\n   \n\t\nb")).toEqual(["a", "b"]);
  });

  it("ignores a trailing newline", () => {
    expect(parseLines("a\n")).toEqual(["a"]);
  });

  it("returns an empty list for empty input", () => {
    expect(parseLines("")).toEqual([]);
  });

  it("keeps whitespace inside a line", () => {
    expect(parseLines("a b\n")).toEqual(["a b"]);
  });
});
