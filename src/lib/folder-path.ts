import type { FolderItem } from "@/components/folders/folder-tree";

/**
 * Build a display path string for a folder by walking up parent chain.
 *
 * @returns A path like "Parent / Child / Grandchild", or `null` if the folder
 *          is not found in the list.
 */
export function buildFolderPath(
  folderId: string,
  folders: FolderItem[],
): string | null {
  const byId = new Map(folders.map((f) => [f.id, f]));
  return buildFolderPathWithMap(folderId, byId);
}

function buildFolderPathWithMap(
  folderId: string,
  byId: Map<string, FolderItem>,
): string | null {
  const folder = byId.get(folderId);
  if (!folder) return null;

  const parts: string[] = [folder.name];
  const visited = new Set<string>([folderId]);
  let currentId = folder.parentId;

  while (currentId) {
    if (visited.has(currentId)) break; // circular reference guard
    visited.add(currentId);

    const parent = byId.get(currentId);
    if (!parent) break; // missing parent (data inconsistency)

    parts.unshift(parent.name);
    currentId = parent.parentId;
  }

  return parts.join(" / ");
}

/**
 * Build a path for every folder in one pass.
 *
 * Callers rendering many folders at once should prefer this over repeated
 * `buildFolderPath` calls, which would be O(N² × D) overall.
 */
export function buildFolderPathMap(folders: FolderItem[]): Map<string, string> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const paths = new Map<string, string>();
  for (const folder of folders) {
    const path = buildFolderPathWithMap(folder.id, byId);
    if (path) paths.set(folder.id, path);
  }
  return paths;
}
