import { describe, it, expect } from "vitest";
import {
  API_ERROR,
  apiErrorToI18nKey,
  eaErrorToI18nKey,
} from "./api-error-codes";

// ── Mapping completeness ────────────────────────────────────────

describe("apiErrorToI18nKey", () => {
  const allCodes = Object.values(API_ERROR);

  it("maps every API_ERROR code to a non-empty i18n key", () => {
    for (const code of allCodes) {
      const key = apiErrorToI18nKey(code);
      expect(key).toBeTruthy();
      expect(key.length).toBeGreaterThan(0);
    }
  });

  it("never returns unknownError for a known code", () => {
    for (const code of allCodes) {
      const key = apiErrorToI18nKey(code);
      // EA-only codes are allowed to map to unknownError in non-EA context
      if (
        [
          "GRANT_NOT_PENDING",
          "CANNOT_GRANT_SELF",
          "DUPLICATE_GRANT",
          "INVALID_STATUS",
          "NOT_AUTHORIZED_FOR_GRANT",
          "NOT_ACTIVATED",
          "KEY_ESCROW_NOT_COMPLETED",
          "INCOMPATIBLE_KEY_ALGORITHM",
        ].includes(code)
      ) {
        continue;
      }
      expect(key).not.toBe("unknownError");
    }
  });

  it("returns unknownError for unknown codes", () => {
    expect(apiErrorToI18nKey("TOTALLY_UNKNOWN")).toBe("unknownError");
    expect(apiErrorToI18nKey(null)).toBe("unknownError");
    expect(apiErrorToI18nKey(undefined)).toBe("unknownError");
    expect(apiErrorToI18nKey(42)).toBe("unknownError");
  });

  it("applies overrides before default mapping", () => {
    expect(
      apiErrorToI18nKey("NOT_FOUND", { NOT_FOUND: "shareNotFound" }),
    ).toBe("shareNotFound");
  });

  it("falls back to default mapping when override does not match", () => {
    expect(
      apiErrorToI18nKey("UNAUTHORIZED", { NOT_FOUND: "shareNotFound" }),
    ).toBe("unauthorized");
  });

  it("returns unknownError for unknown code even with overrides", () => {
    expect(
      apiErrorToI18nKey("NOPE", { NOT_FOUND: "shareNotFound" }),
    ).toBe("unknownError");
  });
});

describe("eaErrorToI18nKey", () => {
  const eaCodes = [
    "UNAUTHORIZED",
    "RATE_LIMIT_EXCEEDED",
    "INVALID_JSON",
    "VALIDATION_ERROR",
    "NOT_FOUND",
    "GRANT_NOT_PENDING",
    "INVITATION_EXPIRED",
    "INVITATION_ALREADY_USED",
    "INVITATION_WRONG_EMAIL",
    "CANNOT_GRANT_SELF",
    "DUPLICATE_GRANT",
    "INVALID_STATUS",
    "NOT_AUTHORIZED_FOR_GRANT",
    "NOT_ACTIVATED",
    "KEY_ESCROW_NOT_COMPLETED",
    "INCOMPATIBLE_KEY_ALGORITHM",
  ] as const;

  it("maps every EA-relevant code to a non-empty i18n key", () => {
    for (const code of eaCodes) {
      const key = eaErrorToI18nKey(code);
      expect(key).toBeTruthy();
      expect(key.length).toBeGreaterThan(0);
    }
  });

  it("returns actionFailed for unknown codes", () => {
    expect(eaErrorToI18nKey("TOTALLY_UNKNOWN")).toBe("actionFailed");
    expect(eaErrorToI18nKey(null)).toBe("actionFailed");
    expect(eaErrorToI18nKey(undefined)).toBe("actionFailed");
  });
});

// ── Structural invariants ───────────────────────────────────────

describe("API_ERROR structural invariants", () => {
  it("every value equals its key (UPPER_SNAKE_CASE identity)", () => {
    for (const [key, value] of Object.entries(API_ERROR)) {
      expect(value).toBe(key);
    }
  });

  it("has no duplicate values", () => {
    const values = Object.values(API_ERROR);
    expect(new Set(values).size).toBe(values.length);
  });

  it("code count matches expected (update this when adding new codes)", () => {
    // If this fails, you added a new code to API_ERROR.
    // Update this count AND add the code to API_ERROR_I18N + i18n messages.
    expect(Object.keys(API_ERROR).length).toBe(80);
  });
});
