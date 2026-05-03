import { describe, expect, it } from "vitest";
import { apiKeyCreateSchema } from "@/lib/validations/api-key";
import {
  API_KEY_SCOPES,
  MAX_API_KEY_EXPIRY_DAYS,
} from "@/lib/constants/auth/api-key";
import { NAME_MAX_LENGTH } from "@/lib/validations/common";

const futureDate = (offsetDays: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString();
};

const validInput = (): {
  name: string;
  scope: readonly string[];
  expiresAt: string;
} => ({
  name: "Backup automation",
  scope: [API_KEY_SCOPES[0]],
  expiresAt: futureDate(30),
});

describe("apiKeyCreateSchema", () => {
  it("accepts valid input", () => {
    const result = apiKeyCreateSchema.safeParse(validInput());
    expect(result.success).toBe(true);
  });

  it("accepts a scope array containing every supported scope", () => {
    const result = apiKeyCreateSchema.safeParse({
      ...validInput(),
      scope: [...API_KEY_SCOPES],
    });
    expect(result.success).toBe(true);
  });

  it("coerces an ISO datetime string into a Date", () => {
    const result = apiKeyCreateSchema.safeParse(validInput());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.expiresAt).toBeInstanceOf(Date);
    }
  });

  // ─── required-field-missing ───
  it("rejects when name is missing", () => {
    const { name: _, ...rest } = validInput();
    const result = apiKeyCreateSchema.safeParse(rest);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.path[0] === "name"),
      ).toBe(true);
    }
  });

  it("rejects when scope is missing", () => {
    const { scope: _, ...rest } = validInput();
    const result = apiKeyCreateSchema.safeParse(rest);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.path[0] === "scope"),
      ).toBe(true);
    }
  });

  it("rejects when expiresAt is missing", () => {
    const { expiresAt: _, ...rest } = validInput();
    const result = apiKeyCreateSchema.safeParse(rest);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.path[0] === "expiresAt"),
      ).toBe(true);
    }
  });

  // ─── name boundary ───
  it("rejects empty name", () => {
    const result = apiKeyCreateSchema.safeParse({
      ...validInput(),
      name: "",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "name");
      expect(issue?.code).toBe("too_small");
    }
  });

  it(`accepts name at max length (${NAME_MAX_LENGTH})`, () => {
    const result = apiKeyCreateSchema.safeParse({
      ...validInput(),
      name: "n".repeat(NAME_MAX_LENGTH),
    });
    expect(result.success).toBe(true);
  });

  it(`rejects name at max+1 length (${NAME_MAX_LENGTH + 1})`, () => {
    const result = apiKeyCreateSchema.safeParse({
      ...validInput(),
      name: "n".repeat(NAME_MAX_LENGTH + 1),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "name");
      expect(issue?.code).toBe("too_big");
    }
  });

  // ─── scope boundary ───
  it("rejects empty scope array", () => {
    const result = apiKeyCreateSchema.safeParse({
      ...validInput(),
      scope: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "scope");
      expect(issue?.code).toBe("too_small");
    }
  });

  it("rejects scope containing an unknown value", () => {
    const result = apiKeyCreateSchema.safeParse({
      ...validInput(),
      scope: ["definitely:not-a-scope"],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "scope");
      expect(issue).toBeDefined();
    }
  });

  // ─── expiry refinement ───
  it("rejects expiresAt in the past", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const result = apiKeyCreateSchema.safeParse({
      ...validInput(),
      expiresAt: past,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "expiresAt");
      expect(issue).toBeDefined();
    }
  });

  it(`rejects expiresAt beyond max+1 days (${MAX_API_KEY_EXPIRY_DAYS + 1})`, () => {
    const result = apiKeyCreateSchema.safeParse({
      ...validInput(),
      expiresAt: futureDate(MAX_API_KEY_EXPIRY_DAYS + 1),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "expiresAt");
      expect(issue).toBeDefined();
    }
  });

  it("rejects expiresAt that fails to coerce to a date", () => {
    const result = apiKeyCreateSchema.safeParse({
      ...validInput(),
      expiresAt: "not-a-date",
    });
    expect(result.success).toBe(false);
  });

  // ─── type-mismatch ───
  it("rejects when name is a number", () => {
    const result = apiKeyCreateSchema.safeParse({
      ...validInput(),
      name: 42,
    });
    expect(result.success).toBe(false);
  });

  it("rejects when scope is a string instead of an array", () => {
    const result = apiKeyCreateSchema.safeParse({
      ...validInput(),
      scope: API_KEY_SCOPES[0],
    });
    expect(result.success).toBe(false);
  });

  it("rejects null and undefined input", () => {
    expect(apiKeyCreateSchema.safeParse(null).success).toBe(false);
    expect(apiKeyCreateSchema.safeParse(undefined).success).toBe(false);
  });
});
