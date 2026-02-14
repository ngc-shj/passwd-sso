import { describe, expect, it } from "vitest";
import {
  reconcileTrashSelectedIds,
  toggleTrashSelectAllIds,
  toggleTrashSelectOneId,
} from "@/components/passwords/trash-list-selection";

describe("trash-list selection helpers", () => {
  it("reconcileTrashSelectedIds drops ids no longer present", () => {
    const prev = new Set(["a", "b", "c"]);
    const next = reconcileTrashSelectedIds(prev, ["a", "c", "d"]);
    expect(Array.from(next).sort()).toEqual(["a", "c"]);
  });

  it("toggleTrashSelectAllIds selects and clears all", () => {
    const all = toggleTrashSelectAllIds(["a", "b"], true);
    expect(Array.from(all).sort()).toEqual(["a", "b"]);
    const cleared = toggleTrashSelectAllIds(["a", "b"], false);
    expect(cleared.size).toBe(0);
  });

  it("toggleTrashSelectOneId adds/removes correctly", () => {
    const start = new Set<string>();
    const added = toggleTrashSelectOneId(start, "x", true);
    expect(Array.from(added)).toEqual(["x"]);
    const removed = toggleTrashSelectOneId(added, "x", false);
    expect(removed.size).toBe(0);
  });
});
