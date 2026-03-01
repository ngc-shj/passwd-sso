export interface FlatTag {
  id: string;
  name: string;
  color?: string | null;
  parentId?: string | null;
}

export interface TagTreeNode extends FlatTag {
  children: TagTreeNode[];
  depth: number;
}

const MAX_DEPTH = 3;

/**
 * Build a tree from a flat array of tags.
 * Orphan tags (parentId points to a missing tag) are placed at root.
 */
export function buildTagTree(flatTags: FlatTag[]): TagTreeNode[] {
  const byId = new Map<string, TagTreeNode>();
  for (const t of flatTags) {
    byId.set(t.id, { ...t, children: [], depth: 0 });
  }

  const roots: TagTreeNode[] = [];

  for (const node of byId.values()) {
    if (node.parentId && byId.has(node.parentId)) {
      const parent = byId.get(node.parentId)!;
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Assign depths
  function assignDepth(nodes: TagTreeNode[], depth: number) {
    for (const n of nodes) {
      n.depth = depth;
      assignDepth(n.children, depth + 1);
    }
  }
  assignDepth(roots, 0);

  // Sort children by name at each level
  function sortTree(nodes: TagTreeNode[]) {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    for (const n of nodes) sortTree(n.children);
  }
  sortTree(roots);

  return roots;
}

/**
 * Flatten a tree depth-first for dropdown display.
 */
export function flattenTagTree(tree: TagTreeNode[]): TagTreeNode[] {
  const result: TagTreeNode[] = [];
  function walk(nodes: TagTreeNode[]) {
    for (const n of nodes) {
      result.push(n);
      walk(n.children);
    }
  }
  walk(tree);
  return result;
}

/**
 * Collect all descendant IDs for a given tag (including itself).
 */
export function collectDescendantIds(
  tree: TagTreeNode[],
  tagId: string,
): string[] {
  const ids: string[] = [];

  function find(nodes: TagTreeNode[]): TagTreeNode | null {
    for (const n of nodes) {
      if (n.id === tagId) return n;
      const found = find(n.children);
      if (found) return found;
    }
    return null;
  }

  function collect(node: TagTreeNode) {
    ids.push(node.id);
    for (const child of node.children) collect(child);
  }

  const target = find(tree);
  if (target) collect(target);
  return ids;
}

export class TagTreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TagTreeError";
  }
}

/**
 * Validate that setting newParentId for tagId does not create a cycle
 * and does not exceed MAX_DEPTH.
 *
 * @param tagId - The tag being moved (or null for a new tag)
 * @param newParentId - The proposed parent (null = root)
 * @param allTags - All tags in the scope (user or team)
 */
export function validateParentChain(
  tagId: string | null,
  newParentId: string | null,
  allTags: FlatTag[],
): void {
  if (!newParentId) return; // Moving to root is always valid

  const byId = new Map<string, FlatTag>();
  for (const t of allTags) byId.set(t.id, t);

  // Check the parent exists
  if (!byId.has(newParentId)) {
    throw new TagTreeError("Parent tag not found");
  }

  // Cycle detection: walk up from newParentId, ensure we don't hit tagId
  const visited = new Set<string>();
  let current: string | null = newParentId;
  let depth = 1; // The tag itself will be at depth = ancestors + 1

  while (current) {
    if (current === tagId) {
      throw new TagTreeError("Circular reference detected");
    }
    if (visited.has(current)) {
      throw new TagTreeError("Circular reference detected");
    }
    visited.add(current);
    const parent = byId.get(current);
    current = parent?.parentId ?? null;
    depth++;
  }

  // Depth check: depth is the number of ancestors + 1 (the tag itself)
  // We also need to account for the deepest descendant of tagId
  if (tagId) {
    const maxDescendantDepth = getMaxDescendantDepth(tagId, allTags);
    if (depth + maxDescendantDepth - 1 > MAX_DEPTH) {
      throw new TagTreeError(`Maximum nesting depth of ${MAX_DEPTH} exceeded`);
    }
  } else {
    if (depth > MAX_DEPTH) {
      throw new TagTreeError(`Maximum nesting depth of ${MAX_DEPTH} exceeded`);
    }
  }
}

function getMaxDescendantDepth(tagId: string, allTags: FlatTag[]): number {
  const childrenOf = new Map<string, FlatTag[]>();
  for (const t of allTags) {
    if (t.parentId) {
      const arr = childrenOf.get(t.parentId) ?? [];
      arr.push(t);
      childrenOf.set(t.parentId, arr);
    }
  }

  function maxDepth(id: string): number {
    const children = childrenOf.get(id) ?? [];
    if (children.length === 0) return 1;
    return 1 + Math.max(...children.map((c) => maxDepth(c.id)));
  }

  return maxDepth(tagId);
}
