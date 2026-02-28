import type { FolderItem } from "@/components/folders/folder-tree";
import { MAX_FOLDER_DEPTH } from "@/lib/folder-utils";

/**
 * Build a display path string for a folder by walking up parent chain.
 *
 * When the hierarchy exceeds `MAX_FOLDER_DEPTH`, the parent side is
 * truncated with "..." (e.g. "... / Child / Grandchild").
 *
 * @returns A path like "Parent / Child / Grandchild", or `null` if the folder
 *          is not found in the list.
 */
export function buildFolderPath(
  folderId: string,
  folders: FolderItem[],
): string | null {
  const folder = folders.find((f) => f.id === folderId);
  if (!folder) return null;

  const parts: string[] = [folder.name];
  const visited = new Set<string>([folderId]);
  let currentId = folder.parentId;

  while (currentId) {
    if (visited.has(currentId)) break; // circular reference guard
    visited.add(currentId);

    const parent = folders.find((f) => f.id === currentId);
    if (!parent) break; // missing parent (data inconsistency)

    parts.unshift(parent.name);
    currentId = parent.parentId;
  }

  if (parts.length > MAX_FOLDER_DEPTH) {
    return ["...", ...parts.slice(-(MAX_FOLDER_DEPTH - 1))].join(" / ");
  }

  return parts.join(" / ");
}
