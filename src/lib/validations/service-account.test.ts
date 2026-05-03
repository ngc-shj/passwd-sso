import { describe, expect, it } from "vitest";
import {
  serviceAccountCreateSchema,
  serviceAccountUpdateSchema,
  saTokenCreateSchema,
} from "@/lib/validations/service-account";
import {
  SA_TOKEN_SCOPES,
  MAX_SA_TOKEN_EXPIRY_DAYS,
} from "@/lib/constants/auth/service-account";
import { NAME_MAX_LENGTH } from "@/lib/validations/common";

const VALID_UUID = "00000000-0000-4000-a000-000000000001";
const DESCRIPTION_MAX = 1000;

const futureDate = (offsetDays: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString();
};

// ─── serviceAccountCreateSchema ─────────────────────────────

describe("serviceAccountCreateSchema", () => {
  const valid = { name: "ci-bot" };

  it("accepts valid minimal input", () => {
    expect(serviceAccountCreateSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts optional description and teamId", () => {
    const result = serviceAccountCreateSchema.safeParse({
      ...valid,
      description: "Continuous integration bot",
      teamId: VALID_UUID,
    });
    expect(result.success).toBe(true);
  });

  it("rejects when name is missing", () => {
    const result = serviceAccountCreateSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "name")).toBe(true);
    }
  });

  it("rejects empty name", () => {
    const result = serviceAccountCreateSchema.safeParse({ name: "" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "name");
      expect(issue?.code).toBe("too_small");
    }
  });

  it(`rejects name at max+1 length (${NAME_MAX_LENGTH + 1})`, () => {
    const result = serviceAccountCreateSchema.safeParse({
      name: "n".repeat(NAME_MAX_LENGTH + 1),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "name");
      expect(issue?.code).toBe("too_big");
    }
  });

  it(`rejects description at max+1 length (${DESCRIPTION_MAX + 1})`, () => {
    const result = serviceAccountCreateSchema.safeParse({
      ...valid,
      description: "d".repeat(DESCRIPTION_MAX + 1),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "description");
      expect(issue?.code).toBe("too_big");
    }
  });

  it("rejects non-UUID teamId", () => {
    const result = serviceAccountCreateSchema.safeParse({
      ...valid,
      teamId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("rejects when name is a number (type mismatch)", () => {
    const result = serviceAccountCreateSchema.safeParse({ name: 42 });
    expect(result.success).toBe(false);
  });
});

// ─── serviceAccountUpdateSchema ─────────────────────────────

describe("serviceAccountUpdateSchema", () => {
  it("accepts an empty object (all fields optional)", () => {
    expect(serviceAccountUpdateSchema.safeParse({}).success).toBe(true);
  });

  it("accepts partial update with isActive=false", () => {
    expect(
      serviceAccountUpdateSchema.safeParse({ isActive: false }).success,
    ).toBe(true);
  });

  it("accepts description=null", () => {
    expect(
      serviceAccountUpdateSchema.safeParse({ description: null }).success,
    ).toBe(true);
  });

  it("rejects empty string name (when present)", () => {
    const result = serviceAccountUpdateSchema.safeParse({ name: "" });
    expect(result.success).toBe(false);
  });

  it(`rejects name at max+1 length (${NAME_MAX_LENGTH + 1})`, () => {
    const result = serviceAccountUpdateSchema.safeParse({
      name: "n".repeat(NAME_MAX_LENGTH + 1),
    });
    expect(result.success).toBe(false);
  });

  it(`rejects description at max+1 length (${DESCRIPTION_MAX + 1})`, () => {
    const result = serviceAccountUpdateSchema.safeParse({
      description: "d".repeat(DESCRIPTION_MAX + 1),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "description");
      expect(issue?.code).toBe("too_big");
    }
  });

  it("rejects non-boolean isActive (type mismatch)", () => {
    const result = serviceAccountUpdateSchema.safeParse({ isActive: "yes" });
    expect(result.success).toBe(false);
  });
});

// ─── saTokenCreateSchema ────────────────────────────────────

describe("saTokenCreateSchema", () => {
  const valid = (): {
    name: string;
    scope: readonly string[];
    expiresAt: string;
  } => ({
    name: "ci-token",
    scope: [SA_TOKEN_SCOPES[0]],
    expiresAt: futureDate(30),
  });

  it("accepts valid input", () => {
    expect(saTokenCreateSchema.safeParse(valid()).success).toBe(true);
  });

  it("accepts every supported scope in one token", () => {
    expect(
      saTokenCreateSchema.safeParse({ ...valid(), scope: [...SA_TOKEN_SCOPES] })
        .success,
    ).toBe(true);
  });

  it("coerces ISO datetime into Date", () => {
    const result = saTokenCreateSchema.safeParse(valid());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.expiresAt).toBeInstanceOf(Date);
    }
  });

  it("rejects when name is missing", () => {
    const { name: _, ...rest } = valid();
    expect(saTokenCreateSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects when scope is missing", () => {
    const { scope: _, ...rest } = valid();
    expect(saTokenCreateSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects when expiresAt is missing", () => {
    const { expiresAt: _, ...rest } = valid();
    expect(saTokenCreateSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects empty name", () => {
    const result = saTokenCreateSchema.safeParse({ ...valid(), name: "" });
    expect(result.success).toBe(false);
  });

  it(`rejects name at max+1 length (${NAME_MAX_LENGTH + 1})`, () => {
    const result = saTokenCreateSchema.safeParse({
      ...valid(),
      name: "n".repeat(NAME_MAX_LENGTH + 1),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "name");
      expect(issue?.code).toBe("too_big");
    }
  });

  it("rejects empty scope array", () => {
    const result = saTokenCreateSchema.safeParse({ ...valid(), scope: [] });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "scope");
      expect(issue?.code).toBe("too_small");
    }
  });

  it("rejects unknown scope", () => {
    const result = saTokenCreateSchema.safeParse({
      ...valid(),
      scope: ["bogus:scope"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects expiresAt in the past", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const result = saTokenCreateSchema.safeParse({
      ...valid(),
      expiresAt: past,
    });
    expect(result.success).toBe(false);
  });

  it(`rejects expiresAt beyond max+1 days (${MAX_SA_TOKEN_EXPIRY_DAYS + 1})`, () => {
    const result = saTokenCreateSchema.safeParse({
      ...valid(),
      expiresAt: futureDate(MAX_SA_TOKEN_EXPIRY_DAYS + 1),
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-coercible expiresAt", () => {
    const result = saTokenCreateSchema.safeParse({
      ...valid(),
      expiresAt: "definitely-not-a-date",
    });
    expect(result.success).toBe(false);
  });

  it("rejects when scope is a string instead of an array", () => {
    const result = saTokenCreateSchema.safeParse({
      ...valid(),
      scope: SA_TOKEN_SCOPES[0],
    });
    expect(result.success).toBe(false);
  });
});
