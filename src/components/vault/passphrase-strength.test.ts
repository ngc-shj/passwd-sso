// @vitest-environment node
import { describe, it, expect } from "vitest";
import { getStrength, STRENGTH_COLORS } from "./passphrase-strength";
import { PASSPHRASE_MIN_LENGTH } from "@/lib/validations";

describe("getStrength — 4-bit length+character-class score (§Sec-1)", () => {
  it("returns level 0 + empty labelKey for empty input", () => {
    expect(getStrength("")).toEqual({ level: 0, labelKey: "" });
  });

  it("scores 0 for short lowercase-only string with no digits/symbols (level 1, strengthWeak)", () => {
    // length 8 < PASSPHRASE_MIN_LENGTH=10, lowercase only, no digit/symbol → score 0
    const input = "a".repeat(PASSPHRASE_MIN_LENGTH - 2);
    expect(getStrength(input)).toEqual({ level: 1, labelKey: "strengthWeak" });
  });

  it("scores 1 for short numeric string (digit/symbol bit only) (level 2, strengthFair)", () => {
    // length 8 (< MIN), all digits → +1 for digit-or-symbol
    expect(getStrength("12345678")).toEqual({
      level: 2,
      labelKey: "strengthFair",
    });
  });

  it("scores 1 for length>=MIN lowercase-only string (length bit only)", () => {
    // length 10 (== MIN), lowercase only → +1 for length-bit only
    const input = "a".repeat(PASSPHRASE_MIN_LENGTH);
    expect(getStrength(input)).toEqual({ level: 2, labelKey: "strengthFair" });
  });

  it("scores 2 for length>=MIN with mixed case (level 3, strengthGood)", () => {
    // length 10, mixed case, no digit/symbol → +1 length, +1 mixed case = 2
    const input = "aB" + "a".repeat(PASSPHRASE_MIN_LENGTH - 2);
    expect(getStrength(input)).toEqual({ level: 3, labelKey: "strengthGood" });
  });

  it("scores 4 (capped at index 3) for length>=16 mixed case + digit (level 4, strengthStrong)", () => {
    // length 16, mixed case, digit → +1 length>=MIN, +1 length>=16, +1 mixed case, +1 digit = 4
    // Math.min(4, 3) = 3 → levels[3] = { level: 4, labelKey: "strengthStrong" }
    const input = "aB1" + "a".repeat(13);
    expect(input.length).toBe(16);
    expect(getStrength(input)).toEqual({
      level: 4,
      labelKey: "strengthStrong",
    });
  });

  it("scores 4 for length>=16 with symbol instead of digit (symbol-or-digit branch)", () => {
    // Verifies the OR branch: symbol satisfies digit-or-symbol bit
    const input = "aB!" + "a".repeat(13);
    expect(input.length).toBe(16);
    expect(getStrength(input)).toEqual({
      level: 4,
      labelKey: "strengthStrong",
    });
  });
});

describe("STRENGTH_COLORS", () => {
  it("provides a tailwind class for each level 1..4 and empty for 0", () => {
    expect(STRENGTH_COLORS).toHaveLength(5);
    expect(STRENGTH_COLORS[0]).toBe("");
    // Levels 1-4 have non-empty class hooks (visual cue requirement)
    for (let i = 1; i <= 4; i++) {
      expect(STRENGTH_COLORS[i]).not.toBe("");
    }
  });
});
