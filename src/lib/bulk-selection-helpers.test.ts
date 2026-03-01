import { describe, expect, it } from "vitest";
import {
  reconcileSelectedIds,
  toggleSelectAllIds,
  toggleSelectOneId,
} from "@/lib/bulk-selection-helpers";

describe("reconcileSelectedIds", () => {
  it("returns same reference when prev is empty", () => {
    const prev = new Set<string>();
    const result = reconcileSelectedIds(prev, ["a", "b"]);
    expect(result).toBe(prev);
  });

  it("returns same reference when no IDs are removed", () => {
    const prev = new Set(["a", "b"]);
    const result = reconcileSelectedIds(prev, ["a", "b", "c"]);
    expect(result).toBe(prev);
  });

  it("drops IDs no longer present", () => {
    const prev = new Set(["a", "b", "c"]);
    const result = reconcileSelectedIds(prev, ["a", "c", "d"]);
    expect(Array.from(result).sort()).toEqual(["a", "c"]);
    expect(result).not.toBe(prev);
  });

  it("returns empty set when all IDs removed", () => {
    const prev = new Set(["x", "y"]);
    const result = reconcileSelectedIds(prev, ["a", "b"]);
    expect(result.size).toBe(0);
  });
});

describe("toggleSelectAllIds", () => {
  it("selects all when checked", () => {
    const result = toggleSelectAllIds(["a", "b", "c"], true);
    expect(Array.from(result).sort()).toEqual(["a", "b", "c"]);
  });

  it("clears all when unchecked", () => {
    const result = toggleSelectAllIds(["a", "b"], false);
    expect(result.size).toBe(0);
  });
});

describe("toggleSelectOneId", () => {
  it("adds id when checked", () => {
    const prev = new Set<string>();
    const result = toggleSelectOneId(prev, "x", true);
    expect(Array.from(result)).toEqual(["x"]);
  });

  it("removes id when unchecked", () => {
    const prev = new Set(["x", "y"]);
    const result = toggleSelectOneId(prev, "x", false);
    expect(Array.from(result)).toEqual(["y"]);
  });

  it("does not mutate original set", () => {
    const prev = new Set(["a"]);
    toggleSelectOneId(prev, "b", true);
    expect(prev.size).toBe(1);
  });
});
