import { describe, expect, it } from "vitest";
import { buildPersonalPasswordFormInitialValues } from "@/hooks/personal-password-form-initial-values";

describe("buildPersonalPasswordFormInitialValues", () => {
  it("returns defaults when initial data is missing", () => {
    const result = buildPersonalPasswordFormInitialValues();

    expect(result.title).toBe("");
    expect(result.username).toBe("");
    expect(result.password).toBe("");
    expect(result.showTotpInput).toBe(false);
    expect(result.requireReprompt).toBe(false);
    expect(result.folderId).toBeNull();
  });

  it("maps initial data and derived flags", () => {
    const result = buildPersonalPasswordFormInitialValues({
      id: "entry-1",
      title: "title",
      username: "user",
      password: "pass",
      url: "https://example.com",
      notes: "memo",
      tags: [],
      folderId: "folder-1",
      requireReprompt: true,
      totp: { secret: "secret", period: 30, digits: 6 },
    });

    expect(result.title).toBe("title");
    expect(result.username).toBe("user");
    expect(result.notes).toBe("memo");
    expect(result.folderId).toBe("folder-1");
    expect(result.requireReprompt).toBe(true);
    expect(result.showTotpInput).toBe(true);
  });

  it("uses defaultFolderId when initialData is undefined", () => {
    const result = buildPersonalPasswordFormInitialValues(undefined, {
      defaultFolderId: "folder-x",
    });
    expect(result.folderId).toBe("folder-x");
  });

  it("uses defaultTags when initialData is undefined", () => {
    const tag = { id: "t1", name: "work", color: null };
    const result = buildPersonalPasswordFormInitialValues(undefined, {
      defaultTags: [tag],
    });
    expect(result.selectedTags).toEqual([tag]);
  });

  it("initialData.folderId takes priority over defaultFolderId", () => {
    const result = buildPersonalPasswordFormInitialValues(
      {
        id: "entry-1",
        title: "t",
        username: "u",
        password: "p",
        url: "",
        notes: "",
        tags: [],
        folderId: "from-initial",
      },
      { defaultFolderId: "from-defaults" },
    );
    expect(result.folderId).toBe("from-initial");
  });

  it("initialData.tags takes priority over defaultTags", () => {
    const initialTag = { id: "t1", name: "init", color: null };
    const defaultTag = { id: "t2", name: "default", color: "#ff0000" };
    const result = buildPersonalPasswordFormInitialValues(
      {
        id: "entry-1",
        title: "t",
        username: "u",
        password: "p",
        url: "",
        notes: "",
        tags: [initialTag],
      },
      { defaultTags: [defaultTag] },
    );
    expect(result.selectedTags).toEqual([initialTag]);
  });
});
