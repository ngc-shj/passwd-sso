import { describe, it, expect } from "vitest";
import { validatePolicy } from "./team-policy-settings";

describe("validatePolicy", () => {
  it("returns no errors for valid policy", () => {
    expect(validatePolicy({ minPasswordLength: 8, maxSessionDurationMinutes: 60 })).toEqual({});
  });

  it("returns no errors for boundary values", () => {
    expect(validatePolicy({ minPasswordLength: 0, maxSessionDurationMinutes: 5 })).toEqual({});
    expect(validatePolicy({ minPasswordLength: 128, maxSessionDurationMinutes: 43200 })).toEqual({});
  });

  it("returns no errors when maxSessionDurationMinutes is null", () => {
    expect(validatePolicy({ minPasswordLength: 0, maxSessionDurationMinutes: null })).toEqual({});
  });

  it("rejects negative minPasswordLength", () => {
    const errs = validatePolicy({ minPasswordLength: -1, maxSessionDurationMinutes: null });
    expect(errs.minPasswordLength).toBe("minPasswordLengthRange");
  });

  it("rejects minPasswordLength over 128", () => {
    const errs = validatePolicy({ minPasswordLength: 129, maxSessionDurationMinutes: null });
    expect(errs.minPasswordLength).toBe("minPasswordLengthRange");
  });

  it("rejects maxSessionDurationMinutes below 5", () => {
    const errs = validatePolicy({ minPasswordLength: 0, maxSessionDurationMinutes: 4 });
    expect(errs.maxSessionDurationMinutes).toBe("maxSessionDurationRange");
  });

  it("rejects maxSessionDurationMinutes over 43200", () => {
    const errs = validatePolicy({ minPasswordLength: 0, maxSessionDurationMinutes: 43201 });
    expect(errs.maxSessionDurationMinutes).toBe("maxSessionDurationRange");
  });

  it("returns multiple errors at once", () => {
    const errs = validatePolicy({ minPasswordLength: -1, maxSessionDurationMinutes: 1 });
    expect(Object.keys(errs)).toHaveLength(2);
  });

  it("rejects NaN minPasswordLength", () => {
    const errs = validatePolicy({ minPasswordLength: NaN, maxSessionDurationMinutes: null });
    expect(errs.minPasswordLength).toBe("minPasswordLengthRange");
  });

  it("rejects NaN maxSessionDurationMinutes", () => {
    const errs = validatePolicy({ minPasswordLength: 0, maxSessionDurationMinutes: NaN as unknown as number });
    expect(errs.maxSessionDurationMinutes).toBe("maxSessionDurationRange");
  });
});
