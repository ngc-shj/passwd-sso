import { describe, it, expect } from "vitest";
import { ACTIVE_ENTRY_WHERE } from "@/lib/prisma/prisma-filters";

describe("ACTIVE_ENTRY_WHERE", () => {
  it("excludes soft-deleted entries", () => {
    expect(ACTIVE_ENTRY_WHERE).toHaveProperty("deletedAt", null);
  });

  it("excludes archived entries", () => {
    expect(ACTIVE_ENTRY_WHERE).toHaveProperty("isArchived", false);
  });

  it("has exactly two filter keys", () => {
    expect(Object.keys(ACTIVE_ENTRY_WHERE)).toHaveLength(2);
  });
});
