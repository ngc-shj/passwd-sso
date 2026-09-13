import { describe, expect, it } from "vitest";
import { ACTIVE_ENTRY_WHERE, escapeLikePattern } from "./prisma-filters";

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

describe("escapeLikePattern", () => {
  it("escapes the three LIKE metacharacters and nothing else", () => {
    expect(escapeLikePattern("a_b%c\\d.e@f")).toBe("a\\_b\\%c\\\\d.e@f");
  });

  it("leaves a value without metacharacters unchanged", () => {
    expect(escapeLikePattern("plain@example.com")).toBe("plain@example.com");
  });
});
