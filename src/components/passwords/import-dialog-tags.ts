import type { ParsedEntry } from "@/components/passwords/import-dialog-types";

interface ExistingTag {
  id: string;
  name: string;
  color: string | null;
}

type FetchLike = typeof fetch;

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
  fetcher: FetchLike = fetch
): Promise<Map<string, string>> {
  const tagNameToId = new Map<string, string>();

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

  const missingTags = new Map<string, string | null>();
  for (const entry of entries) {
    for (const tag of entry.tags) {
      const name = tag.name?.trim();
      if (!name || tagNameToId.has(name) || missingTags.has(name)) continue;
      missingTags.set(name, tag.color ?? null);
    }
  }

  for (const [name, color] of missingTags) {
    try {
      const createRes = await fetcher(tagsPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, ...(color ? { color } : {}) }),
      });
      if (createRes.ok) {
        const created = (await createRes.json()) as ExistingTag;
        if (created?.id) {
          tagNameToId.set(name, created.id);
        }
      }
    } catch {
      // Ignore and proceed without this tag.
    }
  }

  return tagNameToId;
}
