export type EntrySortOption = "updatedAt" | "createdAt" | "title";

interface SortableBase {
  title: string;
}

interface SortableWithFavorite extends SortableBase {
  isFavorite: boolean;
  createdAt: string;
  updatedAt: string;
}

interface SortableWithDeletedAt extends SortableBase {
  deletedAt: string;
}

export function compareEntriesWithFavorite(
  a: SortableWithFavorite,
  b: SortableWithFavorite,
  sortBy: EntrySortOption
): number {
  if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;

  switch (sortBy) {
    case "title":
      return a.title.localeCompare(b.title);
    case "createdAt":
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    case "updatedAt":
    default:
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  }
}

export function compareEntriesByDeletedAt(
  a: SortableWithDeletedAt,
  b: SortableWithDeletedAt,
  sortBy: EntrySortOption
): number {
  if (sortBy === "title") return a.title.localeCompare(b.title);
  return new Date(b.deletedAt).getTime() - new Date(a.deletedAt).getTime();
}

