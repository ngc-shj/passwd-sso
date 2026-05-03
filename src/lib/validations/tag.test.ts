import { describe, expect, it } from "vitest";
import { createTagSchema, updateTagSchema } from "@/lib/validations/tag";
import { TAG_NAME_MAX_LENGTH } from "@/lib/validations/common";

const VALID_UUID = "00000000-0000-4000-a000-000000000001";

// ─── createTagSchema ────────────────────────────────────────

describe("createTagSchema", () => {
  it("accepts valid minimal input", () => {
    const result = createTagSchema.safeParse({ name: "important" });
    expect(result.success).toBe(true);
  });

  it("accepts a hex color", () => {
    const result = createTagSchema.safeParse({
      name: "important",
      color: "#aabbcc",
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty-string color (the explicit literal allowed)", () => {
    const result = createTagSchema.safeParse({ name: "x", color: "" });
    expect(result.success).toBe(true);
  });

  it("transforms color=null into undefined", () => {
    const result = createTagSchema.safeParse({ name: "x", color: null });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.color).toBeUndefined();
    }
  });

  it("accepts parentId=null", () => {
    expect(
      createTagSchema.safeParse({ name: "x", parentId: null }).success,
    ).toBe(true);
  });

  it("trims whitespace from name", () => {
    const result = createTagSchema.safeParse({ name: "  tag  " });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("tag");
    }
  });

  it("rejects when name is missing", () => {
    const result = createTagSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "name")).toBe(true);
    }
  });

  it("rejects empty name", () => {
    const result = createTagSchema.safeParse({ name: "" });
    expect(result.success).toBe(false);
  });

  it(`rejects name at max+1 length (${TAG_NAME_MAX_LENGTH + 1})`, () => {
    const result = createTagSchema.safeParse({
      name: "n".repeat(TAG_NAME_MAX_LENGTH + 1),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "name");
      expect(issue?.code).toBe("too_big");
    }
  });

  it("rejects color without leading '#'", () => {
    const result = createTagSchema.safeParse({
      name: "x",
      color: "aabbcc",
    });
    expect(result.success).toBe(false);
  });

  it("rejects 3-digit hex color (only 6-digit allowed)", () => {
    const result = createTagSchema.safeParse({ name: "x", color: "#abc" });
    expect(result.success).toBe(false);
  });

  it("rejects color with invalid characters", () => {
    const result = createTagSchema.safeParse({ name: "x", color: "#zzzzzz" });
    expect(result.success).toBe(false);
  });

  it("rejects non-UUID parentId", () => {
    const result = createTagSchema.safeParse({
      name: "x",
      parentId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid UUID parentId", () => {
    const result = createTagSchema.safeParse({
      name: "x",
      parentId: VALID_UUID,
    });
    expect(result.success).toBe(true);
  });

  it("rejects when name is a number (type mismatch)", () => {
    const result = createTagSchema.safeParse({ name: 42 });
    expect(result.success).toBe(false);
  });
});

// ─── updateTagSchema ────────────────────────────────────────

describe("updateTagSchema", () => {
  it("accepts an empty object (all fields optional)", () => {
    expect(updateTagSchema.safeParse({}).success).toBe(true);
  });

  it("accepts only name update", () => {
    expect(updateTagSchema.safeParse({ name: "new" }).success).toBe(true);
  });

  it("accepts color=null (clear color)", () => {
    expect(updateTagSchema.safeParse({ color: null }).success).toBe(true);
  });

  it("accepts color='' literal", () => {
    expect(updateTagSchema.safeParse({ color: "" }).success).toBe(true);
  });

  it("accepts parentId=null", () => {
    expect(updateTagSchema.safeParse({ parentId: null }).success).toBe(true);
  });

  it("rejects empty name (when present)", () => {
    expect(updateTagSchema.safeParse({ name: "" }).success).toBe(false);
  });

  it(`rejects name at max+1 length (${TAG_NAME_MAX_LENGTH + 1})`, () => {
    const result = updateTagSchema.safeParse({
      name: "n".repeat(TAG_NAME_MAX_LENGTH + 1),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "name");
      expect(issue?.code).toBe("too_big");
    }
  });

  it("rejects malformed color", () => {
    expect(updateTagSchema.safeParse({ color: "#xyz123" }).success).toBe(false);
  });

  it("trims whitespace from name when present", () => {
    const result = updateTagSchema.safeParse({ name: "  tag  " });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("tag");
    }
  });

  it("rejects non-UUID parentId", () => {
    expect(updateTagSchema.safeParse({ parentId: "abc" }).success).toBe(false);
  });
});
