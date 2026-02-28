import { describe, expect, it } from "vitest";
import { buildFolderPath } from "./folder-path";
import type { FolderItem } from "@/components/folders/folder-tree";

function mkFolder(
  id: string,
  name: string,
  parentId: string | null = null,
): FolderItem {
  return { id, name, parentId, sortOrder: 0, entryCount: 0 };
}

describe("buildFolderPath", () => {
  it("returns the name for a root folder", () => {
    const folders = [mkFolder("f1", "Work")];
    expect(buildFolderPath("f1", folders)).toBe("Work");
  });

  it("returns 'Parent / Child' for a 2-level hierarchy", () => {
    const folders = [
      mkFolder("f1", "Work"),
      mkFolder("f2", "Projects", "f1"),
    ];
    expect(buildFolderPath("f2", folders)).toBe("Work / Projects");
  });

  it("returns full path for 3+ level hierarchy", () => {
    const folders = [
      mkFolder("f1", "Root"),
      mkFolder("f2", "Mid", "f1"),
      mkFolder("f3", "Leaf", "f2"),
    ];
    expect(buildFolderPath("f3", folders)).toBe("Root / Mid / Leaf");
  });

  it("returns null when folderId is not found", () => {
    const folders = [mkFolder("f1", "Work")];
    expect(buildFolderPath("unknown", folders)).toBeNull();
  });

  it("returns partial path when parent is missing (data inconsistency)", () => {
    const folders = [mkFolder("f2", "Child", "f-missing")];
    expect(buildFolderPath("f2", folders)).toBe("Child");
  });

  it("does not loop infinitely on circular references", () => {
    const folders = [
      mkFolder("f1", "A", "f2"),
      mkFolder("f2", "B", "f1"),
    ];
    // f1 start: parts=['A'] -> unshift f2 -> ['B','A'] -> f1 is visited -> break
    expect(buildFolderPath("f1", folders)).toBe("B / A");
  });

  it("returns full path for exactly MAX_FOLDER_DEPTH levels (5)", () => {
    const folders = [
      mkFolder("f1", "L1"),
      mkFolder("f2", "L2", "f1"),
      mkFolder("f3", "L3", "f2"),
      mkFolder("f4", "L4", "f3"),
      mkFolder("f5", "L5", "f4"),
    ];
    expect(buildFolderPath("f5", folders)).toBe("L1 / L2 / L3 / L4 / L5");
  });

  it("truncates at MAX_FOLDER_DEPTH when hierarchy is deeper", () => {
    const folders = [
      mkFolder("f1", "L1"),
      mkFolder("f2", "L2", "f1"),
      mkFolder("f3", "L3", "f2"),
      mkFolder("f4", "L4", "f3"),
      mkFolder("f5", "L5", "f4"),
      mkFolder("f6", "L6", "f5"),
    ];
    // 6 levels from f6: parts start with ['L6'], can add 4 ancestors -> L2..L5
    expect(buildFolderPath("f6", folders)).toBe("L2 / L3 / L4 / L5 / L6");
  });
});
