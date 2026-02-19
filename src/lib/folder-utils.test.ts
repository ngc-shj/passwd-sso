import { describe, expect, it } from "vitest";
import {
  validateParentFolder,
  validateFolderDepth,
  checkCircularReference,
  type ParentNode,
} from "./folder-utils";

// ─── Helper ──────────────────────────────────────────────────

function buildTree(nodes: Record<string, ParentNode>) {
  return async (id: string) => nodes[id] ?? null;
}

// ─── validateParentFolder ────────────────────────────────────

describe("validateParentFolder", () => {
  it("returns parent when found and owner matches", async () => {
    const getParent = buildTree({
      "folder-1": { parentId: null, ownerId: "user-1" },
    });

    const result = await validateParentFolder("folder-1", "user-1", getParent);
    expect(result).toEqual({ parentId: null, ownerId: "user-1" });
  });

  it("throws PARENT_NOT_FOUND when parent does not exist", async () => {
    const getParent = buildTree({});

    await expect(
      validateParentFolder("nonexistent", "user-1", getParent),
    ).rejects.toThrow("PARENT_NOT_FOUND");
  });

  it("throws PARENT_NOT_FOUND when owner does not match", async () => {
    const getParent = buildTree({
      "folder-1": { parentId: null, ownerId: "user-2" },
    });

    await expect(
      validateParentFolder("folder-1", "user-1", getParent),
    ).rejects.toThrow("PARENT_NOT_FOUND");
  });
});

// ─── validateFolderDepth ─────────────────────────────────────

describe("validateFolderDepth", () => {
  it("returns 1 when parentId is null (root level)", async () => {
    const getParent = buildTree({});
    const depth = await validateFolderDepth(null, "user-1", getParent);
    expect(depth).toBe(1);
  });

  it("returns 2 for direct child of root folder", async () => {
    const getParent = buildTree({
      "root": { parentId: null, ownerId: "user-1" },
    });
    const depth = await validateFolderDepth("root", "user-1", getParent);
    expect(depth).toBe(2);
  });

  it("counts depth through chain correctly", async () => {
    const getParent = buildTree({
      "a": { parentId: null, ownerId: "u" },
      "b": { parentId: "a", ownerId: "u" },
      "c": { parentId: "b", ownerId: "u" },
    });
    const depth = await validateFolderDepth("c", "u", getParent);
    expect(depth).toBe(4); // c→b→a→root = depth 4
  });

  it("throws FOLDER_MAX_DEPTH_EXCEEDED when depth exceeds limit", async () => {
    const nodes: Record<string, ParentNode> = {};
    // Build chain: 0→1→2→3→4→5 (depth 6 child = exceeds default 5)
    for (let i = 0; i < 6; i++) {
      nodes[`f${i}`] = { parentId: i > 0 ? `f${i - 1}` : null, ownerId: "u" };
    }
    const getParent = buildTree(nodes);

    await expect(
      validateFolderDepth("f5", "u", getParent),
    ).rejects.toThrow("FOLDER_MAX_DEPTH_EXCEEDED");
  });

  it("respects custom maxDepth parameter", async () => {
    const getParent = buildTree({
      "a": { parentId: null, ownerId: "u" },
      "b": { parentId: "a", ownerId: "u" },
    });
    // depth would be 3, maxDepth=2 → should throw
    await expect(
      validateFolderDepth("b", "u", getParent, 2),
    ).rejects.toThrow("FOLDER_MAX_DEPTH_EXCEEDED");
  });

  it("stops counting when owner does not match", async () => {
    const getParent = buildTree({
      "a": { parentId: null, ownerId: "other" },
      "b": { parentId: "a", ownerId: "u" },
    });
    // b(depth++=2) → a(depth++=3, owner mismatch → break) → depth 3
    const depth = await validateFolderDepth("b", "u", getParent);
    expect(depth).toBe(3);
  });
});

// ─── checkCircularReference ──────────────────────────────────

describe("checkCircularReference", () => {
  it("returns false when no cycle exists", async () => {
    // c is sibling of b, not ancestor → moving b under c is safe
    const getParent = buildTree({
      "a": { parentId: null, ownerId: "u" },
      "b": { parentId: "a", ownerId: "u" },
      "c": { parentId: "a", ownerId: "u" },
    });
    const result = await checkCircularReference("b", "c", getParent);
    expect(result).toBe(false);
  });

  it("returns true when moving folder under its own descendant", async () => {
    const getParent = buildTree({
      "a": { parentId: null, ownerId: "u" },
      "b": { parentId: "a", ownerId: "u" },
      "c": { parentId: "b", ownerId: "u" },
    });
    // Moving "a" under "c" would create a→c→b→a cycle
    const result = await checkCircularReference("a", "c", getParent);
    expect(result).toBe(true);
  });

  it("detects direct self-reference", async () => {
    const getParent = buildTree({
      "a": { parentId: null, ownerId: "u" },
    });
    const result = await checkCircularReference("a", "a", getParent);
    expect(result).toBe(true);
  });

  it("returns false when newParentId is not found", async () => {
    const getParent = buildTree({});
    const result = await checkCircularReference("a", "nonexistent", getParent);
    expect(result).toBe(false);
  });
});
