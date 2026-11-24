import type { ParsedEntry } from "@/components/passwords/import/password-import-types";
import { fetchApi } from "@/lib/url-helpers";
import { parseJsonBodyOnce } from "@/lib/http/read-api-error-body";

interface ExistingTag {
  id: string;
  name: string;
  color: string | null;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export function resolveEntryTagIds(entry: ParsedEntry, tagNameToId: Map<string, string>): string[] {
  return Array.from(
    new Set(
      entry.tags
        .map((tag) => tag.name?.trim())
        .filter((name): name is string => !!name)
        .map((name) => tagNameToId.get(name))
        .filter((id): id is string => !!id)
    )
  );
}

export async function resolveTagNameToIdForImport(
  entries: ParsedEntry[],
  tagsPath: string,
  fetcher: FetchLike = fetchApi
): Promise<Map<string, string>> {
  const tagNameToId = new Map<string, string>();

  const loadExistingTags = async () => {
    try {
      const tagsRes = await fetcher(tagsPath);
      if (tagsRes.ok) {
        const existingTags = (await tagsRes.json()) as ExistingTag[];
        for (const tag of existingTags) {
          const name = tag.name?.trim();
          if (name && tag.id) {
            tagNameToId.set(name, tag.id);
          }
        }
      }
    } catch {
      // Ignore and continue without tag linkage.
    }
  };
  await loadExistingTags();

  const missingTags = new Map<string, string | null>();
  for (const entry of entries) {
    for (const tag of entry.tags) {
      const name = tag.name?.trim();
      if (!name || tagNameToId.has(name) || missingTags.has(name)) continue;
      missingTags.set(name, tag.color ?? null);
    }
  }

  // A tag created with an unreadable response exists; its id is read back
  // from the list once the loop is done.
  let createdUnread = false;
  for (const [name, color] of missingTags) {
    try {
      const createRes = await fetcher(tagsPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, ...(color ? { color } : {}) }),
      });
      if (createRes.ok) {
        const created = await parseJsonBodyOnce(createRes);
        const createdId =
          typeof created === "object" && created !== null && "id" in created ? created.id : null;
        if (typeof createdId === "string" && createdId !== "") {
          tagNameToId.set(name, createdId);
        } else {
          createdUnread = true;
        }
      }
    } catch {
      // Ignore and proceed without this tag.
    }
  }

  if (createdUnread) await loadExistingTags();

  return tagNameToId;
}
