import type { ParsedEntry } from "@/components/passwords/password-import-types";

interface ExistingFolder {
  id: string;
  name: string;
  parentId: string | null;
}

type FetchLike = typeof fetch;

const PATH_SEPARATOR = " / ";
const MAX_IMPORT_FOLDERS = 200;

/**
 * Split a folder path string ("Parent / Child / Grandchild") into trimmed segments.
 */
function splitFolderPath(folderPath: string): string[] {
  return folderPath
    .split(PATH_SEPARATOR)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Find a folder by name and parentId in a flat list.
 */
function findFolder(
  folders: ExistingFolder[],
  name: string,
  parentId: string | null,
): ExistingFolder | undefined {
  return folders.find((f) => f.name === name && f.parentId === parentId);
}

/**
 * Resolve folder path strings to folder IDs.
 *
 * - Fetches existing folders from the API
 * - For each unique path, walks segments top-down
 * - Creates missing folders via POST (sequentially, parent before child)
 * - Handles 409 Conflict by re-fetching the existing folder
 */
export async function resolveFolderPathsForImport(
  entries: ParsedEntry[],
  foldersApiPath: string,
  fetcher: FetchLike = fetch,
): Promise<Map<string, string>> {
  const pathToId = new Map<string, string>();

  // Collect unique non-empty folder paths
  const uniquePaths = new Set<string>();
  for (const entry of entries) {
    if (entry.folderPath) {
      uniquePaths.add(entry.folderPath);
    }
  }
  if (uniquePaths.size === 0) return pathToId;
  if (uniquePaths.size > MAX_IMPORT_FOLDERS) return pathToId;

  // Fetch existing folders
  const folders: ExistingFolder[] = [];
  try {
    const res = await fetcher(foldersApiPath);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) {
        for (const f of data) {
          if (f.id && f.name) {
            folders.push({ id: f.id, name: f.name, parentId: f.parentId ?? null });
          }
        }
      }
    }
  } catch {
    // Continue without existing folders — will create all.
  }

  // Resolve each unique path
  for (const fullPath of uniquePaths) {
    const segments = splitFolderPath(fullPath);
    if (segments.length === 0) continue;

    let parentId: string | null = null;
    let resolved = true;

    for (const segmentName of segments) {
      // Check in-memory cache first
      const existing = findFolder(folders, segmentName, parentId);
      if (existing) {
        parentId = existing.id;
        continue;
      }

      // Create missing folder
      try {
        const createRes: Response = await fetcher(foldersApiPath, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: segmentName, parentId }),
        });

        if (createRes.ok) {
          const created = await createRes.json();
          if (created?.id) {
            folders.push({ id: created.id, name: segmentName, parentId });
            parentId = created.id;
            continue;
          }
        }

        // 409 Conflict — folder already exists (race condition)
        if (createRes.status === 409) {
          // Re-fetch and find the existing folder
          try {
            const refetchRes = await fetcher(foldersApiPath);
            if (refetchRes.ok) {
              const refetched = await refetchRes.json();
              if (Array.isArray(refetched)) {
                // Update in-memory cache
                folders.length = 0;
                for (const f of refetched) {
                  if (f.id && f.name) {
                    folders.push({ id: f.id, name: f.name, parentId: f.parentId ?? null });
                  }
                }
                const found = findFolder(folders, segmentName, parentId);
                if (found) {
                  parentId = found.id;
                  continue;
                }
              }
            }
          } catch {
            // Ignore refetch error
          }
        }

        // Failed to create or resolve this segment
        resolved = false;
        break;
      } catch {
        resolved = false;
        break;
      }
    }

    if (resolved && parentId) {
      pathToId.set(fullPath, parentId);
    }
  }

  return pathToId;
}

/**
 * Look up the folderId for a single entry from the resolved map.
 */
export function resolveEntryFolderId(
  entry: ParsedEntry,
  folderMap: Map<string, string>,
): string | null {
  if (!entry.folderPath) return null;
  return folderMap.get(entry.folderPath) ?? null;
}
