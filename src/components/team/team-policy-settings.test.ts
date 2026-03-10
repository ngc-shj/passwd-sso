import { describe, it, expect } from "vitest";
import { validatePolicy } from "./team-policy-settings";
import {
  POLICY_MIN_PW_LENGTH_MIN,
  POLICY_MIN_PW_LENGTH_MAX,
  POLICY_SESSION_DURATION_MIN,
  POLICY_SESSION_DURATION_MAX,
} from "@/lib/validations";

describe("validatePolicy", () => {
  it("returns no errors for valid policy", () => {
    expect(validatePolicy({ minPasswordLength: 8, maxSessionDurationMinutes: 60 })).toEqual({});
  });

  it("returns no errors for boundary values", () => {
    expect(validatePolicy({ minPasswordLength: POLICY_MIN_PW_LENGTH_MIN, maxSessionDurationMinutes: POLICY_SESSION_DURATION_MIN })).toEqual({});
    expect(validatePolicy({ minPasswordLength: POLICY_MIN_PW_LENGTH_MAX, maxSessionDurationMinutes: POLICY_SESSION_DURATION_MAX })).toEqual({});
  });

  it("returns no errors when maxSessionDurationMinutes is null", () => {
    expect(validatePolicy({ minPasswordLength: 0, maxSessionDurationMinutes: null })).toEqual({});
  });

  it("rejects negative minPasswordLength", () => {
    const errs = validatePolicy({ minPasswordLength: -1, maxSessionDurationMinutes: null });
    expect(errs.minPasswordLength).toBe("minPasswordLengthRange");
  });

  it("rejects minPasswordLength over max", () => {
    const errs = validatePolicy({ minPasswordLength: POLICY_MIN_PW_LENGTH_MAX + 1, maxSessionDurationMinutes: null });
    expect(errs.minPasswordLength).toBe("minPasswordLengthRange");
  });

  it("rejects maxSessionDurationMinutes below min", () => {
    const errs = validatePolicy({ minPasswordLength: POLICY_MIN_PW_LENGTH_MIN, maxSessionDurationMinutes: POLICY_SESSION_DURATION_MIN - 1 });
    expect(errs.maxSessionDurationMinutes).toBe("maxSessionDurationRange");
  });

  it("rejects maxSessionDurationMinutes over max", () => {
    const errs = validatePolicy({ minPasswordLength: POLICY_MIN_PW_LENGTH_MIN, maxSessionDurationMinutes: POLICY_SESSION_DURATION_MAX + 1 });
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
