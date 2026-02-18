interface TagLike {
  id: string;
  name: string;
  color: string | null;
}

export function toTagPayload(tags: TagLike[]): Array<{ name: string; color: string | null }> {
  return tags.map((tag) => ({
    name: tag.name,
    color: tag.color,
  }));
}

export function toTagIds(tags: TagLike[]): string[] {
  return tags.map((tag) => tag.id);
}
