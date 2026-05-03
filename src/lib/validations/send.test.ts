import { describe, expect, it } from "vitest";
import {
  createSendTextSchema,
  createSendFileMetaSchema,
  isValidSendFilename,
  SEND_MAX_TEXT_LENGTH,
} from "@/lib/validations/send";
import {
  SEND_NAME_MAX_LENGTH,
  MAX_VIEWS_MIN,
  MAX_VIEWS_MAX,
  EXPIRY_PERIODS,
} from "@/lib/validations/common";

// ─── isValidSendFilename ────────────────────────────────────

describe("isValidSendFilename", () => {
  it("accepts a simple ASCII filename", () => {
    expect(isValidSendFilename("report.pdf")).toBe(true);
  });

  it("accepts a Japanese filename", () => {
    expect(isValidSendFilename("レポート.pdf")).toBe(true);
  });

  it("accepts a filename with parentheses and apostrophes", () => {
    expect(isValidSendFilename("alice's-file (1).txt")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isValidSendFilename("")).toBe(false);
  });

  it("rejects filename with leading whitespace", () => {
    expect(isValidSendFilename(" file.txt")).toBe(false);
  });

  it("rejects filename with trailing whitespace", () => {
    expect(isValidSendFilename("file.txt ")).toBe(false);
  });

  it("rejects filename starting with a dot", () => {
    expect(isValidSendFilename(".hidden")).toBe(false);
  });

  it("rejects filename ending with a dot", () => {
    expect(isValidSendFilename("file.")).toBe(false);
  });

  it("rejects filename containing forward slash", () => {
    expect(isValidSendFilename("path/to/file")).toBe(false);
  });

  it("rejects filename containing backslash", () => {
    expect(isValidSendFilename("path\\to\\file")).toBe(false);
  });

  it("rejects filename containing CR or LF", () => {
    expect(isValidSendFilename("file\nname")).toBe(false);
    expect(isValidSendFilename("file\rname")).toBe(false);
  });

  it("rejects filename containing a null byte", () => {
    expect(isValidSendFilename("file\0name")).toBe(false);
  });

  it("rejects Windows reserved names", () => {
    expect(isValidSendFilename("CON")).toBe(false);
    expect(isValidSendFilename("PRN.txt")).toBe(false);
    expect(isValidSendFilename("com1")).toBe(false);
    expect(isValidSendFilename("LPT9")).toBe(false);
  });

  it("rejects filename with disallowed punctuation", () => {
    expect(isValidSendFilename("file&name")).toBe(false);
    expect(isValidSendFilename("file<name>")).toBe(false);
    expect(isValidSendFilename("file|pipe")).toBe(false);
  });

  it("rejects filename longer than 255 UTF-8 bytes", () => {
    expect(isValidSendFilename("a".repeat(256))).toBe(false);
  });

  it("accepts filename at exactly 255 bytes", () => {
    expect(isValidSendFilename("a".repeat(255))).toBe(true);
  });

  it("rejects emoji-containing filename", () => {
    expect(isValidSendFilename("file🚀.txt")).toBe(false);
  });
});

// ─── createSendTextSchema ───────────────────────────────────

describe("createSendTextSchema", () => {
  const valid = (): {
    name: string;
    text: string;
    expiresIn: (typeof EXPIRY_PERIODS)[number];
  } => ({
    name: "Note",
    text: "Hello",
    expiresIn: "1d",
  });

  it("accepts valid minimal input", () => {
    expect(createSendTextSchema.safeParse(valid()).success).toBe(true);
  });

  it("trims whitespace from name", () => {
    const result = createSendTextSchema.safeParse({
      ...valid(),
      name: "  Note  ",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("Note");
    }
  });

  it("rejects missing name", () => {
    const { name: _, ...rest } = valid();
    expect(createSendTextSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects missing text", () => {
    const { text: _, ...rest } = valid();
    expect(createSendTextSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects missing expiresIn", () => {
    const { expiresIn: _, ...rest } = valid();
    expect(createSendTextSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects empty name", () => {
    const result = createSendTextSchema.safeParse({ ...valid(), name: "" });
    expect(result.success).toBe(false);
  });

  it(`rejects name at max+1 length (${SEND_NAME_MAX_LENGTH + 1})`, () => {
    const result = createSendTextSchema.safeParse({
      ...valid(),
      name: "x".repeat(SEND_NAME_MAX_LENGTH + 1),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "name");
      expect(issue?.code).toBe("too_big");
    }
  });

  it("rejects empty text", () => {
    const result = createSendTextSchema.safeParse({ ...valid(), text: "" });
    expect(result.success).toBe(false);
  });

  it(`rejects text at max+1 length (${SEND_MAX_TEXT_LENGTH + 1})`, () => {
    const result = createSendTextSchema.safeParse({
      ...valid(),
      text: "x".repeat(SEND_MAX_TEXT_LENGTH + 1),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "text");
      expect(issue?.code).toBe("too_big");
    }
  });

  it("rejects unsupported expiresIn value", () => {
    const result = createSendTextSchema.safeParse({
      ...valid(),
      expiresIn: "999d",
    });
    expect(result.success).toBe(false);
  });

  it(`rejects maxViews above max+1 (${MAX_VIEWS_MAX + 1})`, () => {
    const result = createSendTextSchema.safeParse({
      ...valid(),
      maxViews: MAX_VIEWS_MAX + 1,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "maxViews");
      expect(issue?.code).toBe("too_big");
    }
  });

  it(`rejects maxViews below min (${MAX_VIEWS_MIN - 1})`, () => {
    const result = createSendTextSchema.safeParse({
      ...valid(),
      maxViews: MAX_VIEWS_MIN - 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer maxViews", () => {
    const result = createSendTextSchema.safeParse({
      ...valid(),
      maxViews: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects when text is a number (type mismatch)", () => {
    const result = createSendTextSchema.safeParse({ ...valid(), text: 42 });
    expect(result.success).toBe(false);
  });
});

// ─── createSendFileMetaSchema ───────────────────────────────

describe("createSendFileMetaSchema", () => {
  const valid = (): { name: string; expiresIn: (typeof EXPIRY_PERIODS)[number] } => ({
    name: "Doc",
    expiresIn: "7d",
  });

  it("accepts valid minimal input", () => {
    expect(createSendFileMetaSchema.safeParse(valid()).success).toBe(true);
  });

  it("coerces a numeric string maxViews into number", () => {
    const result = createSendFileMetaSchema.safeParse({
      ...valid(),
      maxViews: "5",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxViews).toBe(5);
    }
  });

  it(`rejects maxViews above max+1 (${MAX_VIEWS_MAX + 1})`, () => {
    const result = createSendFileMetaSchema.safeParse({
      ...valid(),
      maxViews: MAX_VIEWS_MAX + 1,
    });
    expect(result.success).toBe(false);
  });

  it("transforms requirePassword='true' string into boolean true", () => {
    const result = createSendFileMetaSchema.safeParse({
      ...valid(),
      requirePassword: "true",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.requirePassword).toBe(true);
    }
  });

  it("transforms requirePassword='false' string into boolean false", () => {
    const result = createSendFileMetaSchema.safeParse({
      ...valid(),
      requirePassword: "false",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.requirePassword).toBe(false);
    }
  });

  it(`rejects name at max+1 length (${SEND_NAME_MAX_LENGTH + 1})`, () => {
    const result = createSendFileMetaSchema.safeParse({
      ...valid(),
      name: "x".repeat(SEND_NAME_MAX_LENGTH + 1),
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing expiresIn", () => {
    const { expiresIn: _, ...rest } = valid();
    expect(createSendFileMetaSchema.safeParse(rest).success).toBe(false);
  });
});
