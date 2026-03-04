import { describe, it, expect } from "vitest";
import { filterMembers } from "./filter-members";

const members = [
  { name: "Alice Admin", email: "alice@example.com" },
  { name: "Bob Builder", email: "bob@example.com" },
  { name: null, email: "charlie@example.com" },
  { name: "田中太郎", email: "tanaka@example.com" },
  { name: "Diana Prince", email: null },
];

describe("filterMembers", () => {
  it("returns all members for empty query", () => {
    expect(filterMembers(members, "")).toEqual(members);
  });

  it("returns all members for whitespace-only query", () => {
    expect(filterMembers(members, "   ")).toEqual(members);
  });

  it("filters by name partial match", () => {
    const result = filterMembers(members, "alice");
    expect(result).toEqual([members[0]]);
  });

  it("filters by email partial match", () => {
    const result = filterMembers(members, "charlie");
    expect(result).toEqual([members[2]]);
  });

  it("is case-insensitive", () => {
    const result = filterMembers(members, "ALICE");
    expect(result).toEqual([members[0]]);
  });

  it("handles members with null name (searches by email)", () => {
    const result = filterMembers(members, "charlie");
    expect(result).toHaveLength(1);
    expect(result[0].email).toBe("charlie@example.com");
  });

  it("handles Japanese name search", () => {
    const result = filterMembers(members, "田中");
    expect(result).toEqual([members[3]]);
  });

  it("returns empty array when no match", () => {
    const result = filterMembers(members, "nonexistent");
    expect(result).toEqual([]);
  });

  it("matches across both name and email", () => {
    const result = filterMembers(members, "example");
    expect(result).toHaveLength(4); // All except Diana who has null email
  });

  it("handles members with null email (searches by name)", () => {
    const result = filterMembers(members, "diana");
    expect(result).toEqual([members[4]]);
  });
});
