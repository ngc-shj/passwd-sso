export interface TagWithId {
  id: string;
}

export interface TagNameColor {
  name: string;
  color: string | null;
}

export interface CustomFieldLike {
  label: string;
  value: string;
}

export function extractTagIds(tags: TagWithId[]): string[] {
  return tags.map((tag) => tag.id);
}

export function toTagNameColor(tags: TagNameColor[]): TagNameColor[] {
  return tags.map((tag) => ({
    name: tag.name,
    color: tag.color,
  }));
}

export function filterNonEmptyCustomFields<T extends CustomFieldLike>(
  fields: T[]
): T[] {
  return fields.filter((field) => field.label.trim() && field.value.trim());
}

export function parseUrlHost(value: string): string | null {
  if (!value) return null;
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

