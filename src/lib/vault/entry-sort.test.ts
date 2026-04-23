import { describe, expect, it } from "vitest";
import {
  compareEntriesByDeletedAt,
  compareEntriesWithFavorite,
  type EntrySortOption,
} from "./entry-sort";

function sortWith<T>(
  items: T[],
  comparator: (a: T, b: T, sortBy: EntrySortOption) => number,
  sortBy: EntrySortOption
): T[] {
  return [...items].sort((a, b) => comparator(a, b, sortBy));
}

describe("compareEntriesWithFavorite", () => {
  const base = [
    { title: "zeta", isFavorite: false, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    { title: "alpha", isFavorite: true, createdAt: "2026-01-03T00:00:00.000Z", updatedAt: "2026-01-03T00:00:00.000Z" },
    { title: "beta", isFavorite: false, createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" },
  ];

  it("keeps favorites first regardless of sort mode", () => {
    const byTitle = sortWith(base, compareEntriesWithFavorite, "title");
    expect(byTitle[0]?.title).toBe("alpha");
  });

  it("sorts by title inside same favorite bucket", () => {
    const byTitle = sortWith(base, compareEntriesWithFavorite, "title");
    expect(byTitle.map((x) => x.title)).toEqual(["alpha", "beta", "zeta"]);
  });

  it("sorts by createdAt desc inside same favorite bucket", () => {
    const byCreated = sortWith(base, compareEntriesWithFavorite, "createdAt");
    expect(byCreated.map((x) => x.title)).toEqual(["alpha", "beta", "zeta"]);
  });
});

describe("compareEntriesByDeletedAt", () => {
  const base = [
    { title: "zeta", deletedAt: "2026-01-01T00:00:00.000Z" },
    { title: "alpha", deletedAt: "2026-01-03T00:00:00.000Z" },
    { title: "beta", deletedAt: "2026-01-02T00:00:00.000Z" },
  ];

  it("sorts by title when requested", () => {
    const byTitle = sortWith(base, compareEntriesByDeletedAt, "title");
    expect(byTitle.map((x) => x.title)).toEqual(["alpha", "beta", "zeta"]);
  });

  it("sorts by deletedAt desc for updatedAt/createdAt modes", () => {
    const byUpdated = sortWith(base, compareEntriesByDeletedAt, "updatedAt");
    const byCreated = sortWith(base, compareEntriesByDeletedAt, "createdAt");
    expect(byUpdated.map((x) => x.title)).toEqual(["alpha", "beta", "zeta"]);
    expect(byCreated.map((x) => x.title)).toEqual(["alpha", "beta", "zeta"]);
  });
});

