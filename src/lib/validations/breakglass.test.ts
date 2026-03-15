import { describe, expect, it } from "vitest";
import { createBreakglassGrantSchema } from "@/lib/validations/breakglass";

describe("createBreakglassGrantSchema", () => {
  const validInput = {
    targetUserId: "user-123",
    reason: "Security incident investigation required",
    incidentRef: "INC-2026-001",
  };

  it("accepts valid input", () => {
    const result = createBreakglassGrantSchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it("rejects reason shorter than 10 characters", () => {
    const result = createBreakglassGrantSchema.safeParse({
      ...validInput,
      reason: "Too short",
    });
    expect(result.success).toBe(false);
  });

  it("rejects reason longer than 1000 characters", () => {
    const result = createBreakglassGrantSchema.safeParse({
      ...validInput,
      reason: "a".repeat(1001),
    });
    expect(result.success).toBe(false);
  });

  it("trims whitespace from reason", () => {
    const result = createBreakglassGrantSchema.safeParse({
      ...validInput,
      reason: "  Security incident investigation required  ",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reason).toBe("Security incident investigation required");
    }
  });

  it("accepts input without incidentRef (optional field)", () => {
    const { incidentRef: _, ...withoutRef } = validInput;
    const result = createBreakglassGrantSchema.safeParse(withoutRef);
    expect(result.success).toBe(true);
  });

  it("rejects incidentRef longer than 500 characters", () => {
    const result = createBreakglassGrantSchema.safeParse({
      ...validInput,
      incidentRef: "b".repeat(501),
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty targetUserId", () => {
    const result = createBreakglassGrantSchema.safeParse({
      ...validInput,
      targetUserId: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing targetUserId", () => {
    const { targetUserId: _, ...withoutTarget } = validInput;
    const result = createBreakglassGrantSchema.safeParse(withoutTarget);
    expect(result.success).toBe(false);
  });
});
