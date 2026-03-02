import { describe, it, expect } from "vitest";
import {
  applySharePermissions,
  SHARE_PERMISSION,
  SHARE_PERMISSION_VALUES,
} from "./share-permission";

const FULL_DATA = {
  title: "My Login",
  username: "user@example.com",
  password: "s3cret!",
  url: "https://example.com",
  notes: "Important notes",
  cvv: "123",
  cardNumber: "4111111111111111",
};

describe("applySharePermissions", () => {
  it("returns all data when permissions is empty (VIEW_ALL default)", () => {
    const result = applySharePermissions(FULL_DATA, []);
    expect(result).toEqual(FULL_DATA);
  });

  it("returns all data with explicit VIEW_ALL", () => {
    const result = applySharePermissions(FULL_DATA, [SHARE_PERMISSION.VIEW_ALL]);
    expect(result).toEqual(FULL_DATA);
  });

  it("removes password and cvv with HIDE_PASSWORD", () => {
    const result = applySharePermissions(FULL_DATA, [SHARE_PERMISSION.HIDE_PASSWORD]);
    expect(result).not.toHaveProperty("password");
    expect(result).not.toHaveProperty("cvv");
    expect(result).toHaveProperty("title", "My Login");
    expect(result).toHaveProperty("username", "user@example.com");
    expect(result).toHaveProperty("url", "https://example.com");
    expect(result).toHaveProperty("notes", "Important notes");
    expect(result).toHaveProperty("cardNumber", "4111111111111111");
  });

  it("keeps only title, username, url with OVERVIEW_ONLY", () => {
    const result = applySharePermissions(FULL_DATA, [SHARE_PERMISSION.OVERVIEW_ONLY]);
    expect(Object.keys(result).sort()).toEqual(["title", "url", "username"]);
    expect(result).toEqual({
      title: "My Login",
      username: "user@example.com",
      url: "https://example.com",
    });
  });

  it("OVERVIEW_ONLY omits missing fields gracefully", () => {
    const data = { title: "Note", content: "some text" };
    const result = applySharePermissions(data, [SHARE_PERMISSION.OVERVIEW_ONLY]);
    expect(result).toEqual({ title: "Note" });
  });

  it("OVERVIEW_ONLY takes precedence over HIDE_PASSWORD when both present", () => {
    const result = applySharePermissions(FULL_DATA, [
      SHARE_PERMISSION.HIDE_PASSWORD,
      SHARE_PERMISSION.OVERVIEW_ONLY,
    ]);
    expect(Object.keys(result).sort()).toEqual(["title", "url", "username"]);
  });
});

describe("SHARE_PERMISSION_VALUES", () => {
  it("contains all permission values", () => {
    expect(SHARE_PERMISSION_VALUES).toContain("VIEW_ALL");
    expect(SHARE_PERMISSION_VALUES).toContain("HIDE_PASSWORD");
    expect(SHARE_PERMISSION_VALUES).toContain("OVERVIEW_ONLY");
    expect(SHARE_PERMISSION_VALUES.length).toBe(3);
  });
});
