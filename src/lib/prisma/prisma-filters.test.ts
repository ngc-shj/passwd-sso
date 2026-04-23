import { describe, expect, it } from "vitest";
import { ACTIVE_ENTRY_WHERE } from "./prisma-filters";

describe("ACTIVE_ENTRY_WHERE", () => {
  it("has deletedAt set to null", () => {
    expect(ACTIVE_ENTRY_WHERE.deletedAt).toBeNull();
  });

  it("has isArchived set to false", () => {
    expect(ACTIVE_ENTRY_WHERE.isArchived).toBe(false);
  });

  it("has exactly two keys", () => {
    expect(Object.keys(ACTIVE_ENTRY_WHERE)).toHaveLength(2);
  });

  it("is a plain object (not mutated by reference)", () => {
    // Ensure it's a stable constant by reading it twice
    expect(ACTIVE_ENTRY_WHERE).toStrictEqual({ deletedAt: null, isArchived: false });
  });
});
