import { describe, it, expect } from "vitest";
import {
  buildTagTree,
  flattenTagTree,
  collectDescendantIds,
  buildTagPath,
  validateParentChain,
  TagTreeError,
  type FlatTag,
} from "./tag-tree";

const tags: FlatTag[] = [
  { id: "a", name: "A", parentId: null },
  { id: "b", name: "B", parentId: "a" },
  { id: "c", name: "C", parentId: "a" },
  { id: "d", name: "D", parentId: "b" },
  { id: "e", name: "E", parentId: null },
];

describe("buildTagTree", () => {
  it("builds tree from flat tags", () => {
    const tree = buildTagTree(tags);
    expect(tree).toHaveLength(2); // A and E at root
    expect(tree[0].name).toBe("A");
    expect(tree[0].children).toHaveLength(2); // B, C
    expect(tree[0].children[0].name).toBe("B");
    expect(tree[0].children[0].children).toHaveLength(1); // D
    expect(tree[1].name).toBe("E");
    expect(tree[1].children).toHaveLength(0);
  });

  it("assigns correct depths", () => {
    const tree = buildTagTree(tags);
    const flat = flattenTagTree(tree);
    expect(flat.find((t) => t.id === "a")!.depth).toBe(0);
    expect(flat.find((t) => t.id === "b")!.depth).toBe(1);
    expect(flat.find((t) => t.id === "d")!.depth).toBe(2);
    expect(flat.find((t) => t.id === "e")!.depth).toBe(0);
  });

  it("treats orphans as root nodes", () => {
    const orphaned: FlatTag[] = [
      { id: "x", name: "X", parentId: "missing" },
      { id: "y", name: "Y", parentId: null },
    ];
    const tree = buildTagTree(orphaned);
    expect(tree).toHaveLength(2);
    expect(tree[0].depth).toBe(0);
    expect(tree[1].depth).toBe(0);
  });

  it("returns empty array for empty input", () => {
    expect(buildTagTree([])).toEqual([]);
  });
});

describe("flattenTagTree", () => {
  it("flattens in depth-first order", () => {
    const tree = buildTagTree(tags);
    const flat = flattenTagTree(tree);
    const names = flat.map((t) => t.name);
    // A -> B -> D -> C -> E (sorted alphabetically at each level)
    expect(names).toEqual(["A", "B", "D", "C", "E"]);
  });
});

describe("collectDescendantIds", () => {
  it("collects all descendants including self", () => {
    const tree = buildTagTree(tags);
    const ids = collectDescendantIds(tree, "a");
    expect(ids.sort()).toEqual(["a", "b", "c", "d"].sort());
  });

  it("returns single id for leaf node", () => {
    const tree = buildTagTree(tags);
    const ids = collectDescendantIds(tree, "d");
    expect(ids).toEqual(["d"]);
  });

  it("returns empty for non-existent id", () => {
    const tree = buildTagTree(tags);
    const ids = collectDescendantIds(tree, "nonexistent");
    expect(ids).toEqual([]);
  });
});

describe("validateParentChain", () => {
  it("accepts null parentId (root)", () => {
    expect(() => validateParentChain("a", null, tags)).not.toThrow();
  });

  it("accepts valid depth 3 chain", () => {
    // A -> B -> D is depth 3, valid
    expect(() => validateParentChain("d", "b", tags)).not.toThrow();
  });

  it("rejects depth 4", () => {
    // Try to add a child to D (which is at depth 2, so child = depth 3 => new tag at depth 4)
    const newTag = "new";
    expect(() => validateParentChain(newTag, "d", tags)).toThrow(TagTreeError);
    expect(() => validateParentChain(newTag, "d", tags)).toThrow(
      /depth/i,
    );
  });

  it("detects cycle when moving parent under its descendant", () => {
    // Try to move A under D (A -> B -> D, moving A under D creates cycle)
    expect(() => validateParentChain("a", "d", tags)).toThrow(TagTreeError);
    expect(() => validateParentChain("a", "d", tags)).toThrow(/circular/i);
  });

  it("detects direct self-reference", () => {
    expect(() => validateParentChain("a", "a", tags)).toThrow(TagTreeError);
    expect(() => validateParentChain("a", "a", tags)).toThrow(/circular/i);
  });

  it("throws when parent not found", () => {
    expect(() => validateParentChain("a", "missing", tags)).toThrow(
      "Parent tag not found",
    );
  });

  it("accepts new tag (null tagId) at valid depth", () => {
    // New tag under A (depth 1) -> valid
    expect(() => validateParentChain(null, "a", tags)).not.toThrow();
  });

  it("accepts new tag under B (depth 2 is within MAX_DEPTH 3)", () => {
    // A -> B -> new = 3 levels, valid
    expect(() => validateParentChain(null, "b", tags)).not.toThrow();
  });

  it("rejects new tag at excessive depth", () => {
    // A -> B -> D -> new = 4 levels, exceeds MAX_DEPTH=3
    expect(() => validateParentChain(null, "d", tags)).toThrow(/depth/i);

    // Create a depth-3 chain and try to add under it
    const deep: FlatTag[] = [
      { id: "l1", name: "L1", parentId: null },
      { id: "l2", name: "L2", parentId: "l1" },
      { id: "l3", name: "L3", parentId: "l2" },
    ];
    expect(() => validateParentChain(null, "l3", deep)).toThrow(/depth/i);
  });
});

describe("buildTagPath", () => {
  it("returns full path for nested tag", () => {
    expect(buildTagPath("d", tags)).toBe("A / B / D");
  });

  it("returns name only for root tag", () => {
    expect(buildTagPath("a", tags)).toBe("A");
    expect(buildTagPath("e", tags)).toBe("E");
  });

  it("returns null for unknown id", () => {
    expect(buildTagPath("missing", tags)).toBeNull();
  });

  it("handles circular reference gracefully", () => {
    const circular: FlatTag[] = [
      { id: "x", name: "X", parentId: "y" },
      { id: "y", name: "Y", parentId: "x" },
    ];
    const result = buildTagPath("x", circular);
    expect(result).toContain("X");
  });
});
