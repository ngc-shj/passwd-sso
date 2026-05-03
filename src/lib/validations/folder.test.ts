import { describe, expect, it } from "vitest";
import {
  createFolderSchema,
  updateFolderSchema,
} from "@/lib/validations/folder";
import { NAME_MAX_LENGTH } from "@/lib/validations/common";

const VALID_UUID = "00000000-0000-4000-a000-000000000001";

// ─── createFolderSchema ─────────────────────────────────────

describe("createFolderSchema", () => {
  const valid = { name: "Work" };

  it("accepts valid minimal input", () => {
    expect(createFolderSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts optional parentId and sortOrder", () => {
    const result = createFolderSchema.safeParse({
      ...valid,
      parentId: VALID_UUID,
      sortOrder: 5,
    });
    expect(result.success).toBe(true);
  });

  it("accepts parentId=null", () => {
    expect(
      createFolderSchema.safeParse({ ...valid, parentId: null }).success,
    ).toBe(true);
  });

  it("trims whitespace from name", () => {
    const result = createFolderSchema.safeParse({ name: "  Work  " });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("Work");
    }
  });

  it("rejects when name is missing", () => {
    const result = createFolderSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "name")).toBe(true);
    }
  });

  it("rejects empty name", () => {
    const result = createFolderSchema.safeParse({ name: "" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "name");
      expect(issue?.code).toBe("too_small");
    }
  });

  it(`accepts name at max length (${NAME_MAX_LENGTH})`, () => {
    expect(
      createFolderSchema.safeParse({ name: "n".repeat(NAME_MAX_LENGTH) })
        .success,
    ).toBe(true);
  });

  it(`rejects name at max+1 length (${NAME_MAX_LENGTH + 1})`, () => {
    const result = createFolderSchema.safeParse({
      name: "n".repeat(NAME_MAX_LENGTH + 1),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "name");
      expect(issue?.code).toBe("too_big");
    }
  });

  it("rejects non-UUID parentId", () => {
    const result = createFolderSchema.safeParse({
      ...valid,
      parentId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative sortOrder", () => {
    const result = createFolderSchema.safeParse({ ...valid, sortOrder: -1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "sortOrder");
      expect(issue?.code).toBe("too_small");
    }
  });

  it("rejects non-integer sortOrder", () => {
    const result = createFolderSchema.safeParse({ ...valid, sortOrder: 1.5 });
    expect(result.success).toBe(false);
  });

  it("rejects when name is a number", () => {
    const result = createFolderSchema.safeParse({ name: 42 });
    expect(result.success).toBe(false);
  });
});

// ─── updateFolderSchema ─────────────────────────────────────

describe("updateFolderSchema", () => {
  it("accepts an empty object (all fields optional)", () => {
    expect(updateFolderSchema.safeParse({}).success).toBe(true);
  });

  it("accepts partial update with only name", () => {
    const result = updateFolderSchema.safeParse({ name: "New" });
    expect(result.success).toBe(true);
  });

  it("accepts parentId=null (move to root)", () => {
    expect(updateFolderSchema.safeParse({ parentId: null }).success).toBe(true);
  });

  it("rejects empty string name (min length 1 still applies when present)", () => {
    const result = updateFolderSchema.safeParse({ name: "" });
    expect(result.success).toBe(false);
  });

  it(`rejects name at max+1 length (${NAME_MAX_LENGTH + 1})`, () => {
    const result = updateFolderSchema.safeParse({
      name: "n".repeat(NAME_MAX_LENGTH + 1),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "name");
      expect(issue?.code).toBe("too_big");
    }
  });

  it("trims whitespace from name when present", () => {
    const result = updateFolderSchema.safeParse({ name: "  Folder  " });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("Folder");
    }
  });

  it("rejects non-UUID parentId", () => {
    expect(
      updateFolderSchema.safeParse({ parentId: "abc" }).success,
    ).toBe(false);
  });

  it("rejects negative sortOrder", () => {
    expect(updateFolderSchema.safeParse({ sortOrder: -1 }).success).toBe(false);
  });
});
