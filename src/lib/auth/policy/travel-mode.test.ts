import { describe, it, expect } from "vitest";
import { filterTravelSafe } from "./travel-mode";

describe("filterTravelSafe", () => {
  const entries = [
    { id: "1", travelSafe: true },
    { id: "2", travelSafe: false },
    { id: "3" },                         // travelSafe undefined → default true
    { id: "4", travelSafe: undefined },
  ];

  it("returns all entries when travel mode is off", () => {
    expect(filterTravelSafe(entries, false)).toHaveLength(4);
  });

  it("filters out travelSafe=false when travel mode is on", () => {
    const result = filterTravelSafe(entries, true);
    expect(result).toHaveLength(3);
    expect(result.map((e) => e.id)).toEqual(["1", "3", "4"]);
  });

  it("returns empty array for all-unsafe entries", () => {
    expect(filterTravelSafe([{ travelSafe: false }], true)).toEqual([]);
  });

  it("returns empty array for empty input", () => {
    expect(filterTravelSafe([], true)).toEqual([]);
  });
});
