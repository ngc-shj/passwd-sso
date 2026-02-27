/**
 * Shared helpers for folder depth validation and circular reference detection.
 * Used by both Personal (Folder) and Team (TeamFolder) APIs via callback injection.
 */

export interface ParentNode {
  parentId: string | null;
  ownerId: string;
}

const MAX_FOLDER_DEPTH = 5;

/**
 * Validate that `parentId` exists and belongs to the expected owner.
 *
 * @returns The parent node if valid.
 * @throws Error with `PARENT_NOT_FOUND` message if the parent does not exist or belongs to another owner.
 */
export async function validateParentFolder(
  parentId: string,
  ownerId: string,
  getParent: (id: string) => Promise<ParentNode | null>,
): Promise<ParentNode> {
  const parent = await getParent(parentId);
  if (!parent || parent.ownerId !== ownerId) {
    throw new Error("PARENT_NOT_FOUND");
  }
  return parent;
}

/**
 * Validate that adding a child under `parentId` would not exceed max depth.
 * Walks from `parentId` to the root, counting ancestors.
 *
 * @returns The depth of the target position (1 = root child, 2 = grandchild, etc.)
 * @throws Error with `FOLDER_MAX_DEPTH_EXCEEDED` message if depth exceeds limit.
 */
export async function validateFolderDepth(
  parentId: string | null,
  ownerId: string,
  getParent: (id: string) => Promise<ParentNode | null>,
  maxDepth = MAX_FOLDER_DEPTH,
): Promise<number> {
  if (!parentId) return 1; // root level

  let depth = 1;
  let currentId: string | null = parentId;

  while (currentId) {
    depth++;
    if (depth > maxDepth) {
      throw new Error("FOLDER_MAX_DEPTH_EXCEEDED");
    }
    const node = await getParent(currentId);
    if (!node || node.ownerId !== ownerId) break;
    currentId = node.parentId;
  }

  return depth;
}

/**
 * Check whether moving `folderId` under `newParentId` would create a cycle.
 * Walks from `newParentId` to the root; if `folderId` is encountered, it's circular.
 *
 * @returns `true` if a circular reference would be created.
 */
export async function checkCircularReference(
  folderId: string,
  newParentId: string,
  getParent: (id: string) => Promise<ParentNode | null>,
): Promise<boolean> {
  let currentId: string | null = newParentId;

  while (currentId) {
    if (currentId === folderId) return true;
    const node = await getParent(currentId);
    if (!node) break;
    currentId = node.parentId;
  }

  return false;
}
