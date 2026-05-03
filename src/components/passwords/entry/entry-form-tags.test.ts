// @vitest-environment node
import { describe, it, expect } from "vitest";
import { toTagPayload, toTagIds } from "./entry-form-tags";

describe("toTagPayload", () => {
  it("strips id and keeps name + color", () => {
    const result = toTagPayload([
      { id: "t1", name: "Work", color: "#ff0000" },
      { id: "t2", name: "Home", color: null },
    ]);

    expect(result).toEqual([
      { name: "Work", color: "#ff0000" },
      { name: "Home", color: null },
    ]);
  });

  it("returns empty array for empty input", () => {
    expect(toTagPayload([])).toEqual([]);
  });
});

describe("toTagIds", () => {
  it("returns ids in order", () => {
    const result = toTagIds([
      { id: "t1", name: "a", color: null },
      { id: "t2", name: "b", color: null },
    ]);

    expect(result).toEqual(["t1", "t2"]);
  });

  it("returns empty array for empty input", () => {
    expect(toTagIds([])).toEqual([]);
  });
});
