import { describe, expect, it } from "vitest";
import {
  reconcileSelectedIds,
  toggleSelectAllIds,
  toggleSelectOneId,
} from "@/lib/bulk-selection-helpers";

describe("password-list selection helpers", () => {
  it("reconcileSelectedIds drops removed entries", () => {
    const prev = new Set(["a", "b", "c"]);
    const next = reconcileSelectedIds(prev, ["a", "c", "d"]);
    expect(Array.from(next).sort()).toEqual(["a", "c"]);
  });

  it("toggleSelectAllIds selects and clears all", () => {
    const all = toggleSelectAllIds(["a", "b"], true);
    expect(Array.from(all).sort()).toEqual(["a", "b"]);
    const cleared = toggleSelectAllIds(["a", "b"], false);
    expect(cleared.size).toBe(0);
  });

  it("toggleSelectOneId adds/removes correctly", () => {
    const start = new Set<string>();
    const added = toggleSelectOneId(start, "x", true);
    expect(Array.from(added)).toEqual(["x"]);
    const removed = toggleSelectOneId(added, "x", false);
    expect(removed.size).toBe(0);
  });
});
