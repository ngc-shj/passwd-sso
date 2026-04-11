import { describe, it, expect } from "vitest";
import { validatePolicy } from "./team-policy-settings";
import {
  POLICY_MIN_PW_LENGTH_MIN,
  POLICY_MIN_PW_LENGTH_MAX,
  POLICY_SESSION_DURATION_MIN,
  POLICY_SESSION_DURATION_MAX,
  PASSWORD_HISTORY_COUNT_MAX,
} from "@/lib/validations";

const VALID_BASE = {
  minPasswordLength: 8,
  maxSessionDurationMinutes: 60 as number | null,
  passwordHistoryCount: 0,
  teamAllowedCidrs: [] as string[],
};

describe("validatePolicy", () => {
  it("returns no errors for valid policy", () => {
    expect(validatePolicy(VALID_BASE)).toEqual({});
  });

  it("returns no errors for boundary values", () => {
    expect(validatePolicy({ ...VALID_BASE, minPasswordLength: POLICY_MIN_PW_LENGTH_MIN, maxSessionDurationMinutes: POLICY_SESSION_DURATION_MIN })).toEqual({});
    expect(validatePolicy({ ...VALID_BASE, minPasswordLength: POLICY_MIN_PW_LENGTH_MAX, maxSessionDurationMinutes: POLICY_SESSION_DURATION_MAX })).toEqual({});
  });

  it("returns no errors when maxSessionDurationMinutes is null", () => {
    expect(validatePolicy({ ...VALID_BASE, minPasswordLength: 0, maxSessionDurationMinutes: null })).toEqual({});
  });

  it("rejects negative minPasswordLength", () => {
    const errs = validatePolicy({ ...VALID_BASE, minPasswordLength: -1, maxSessionDurationMinutes: null });
    expect(errs.minPasswordLength).toBe("minPasswordLengthRange");
  });

  it("rejects minPasswordLength over max", () => {
    const errs = validatePolicy({ ...VALID_BASE, minPasswordLength: POLICY_MIN_PW_LENGTH_MAX + 1, maxSessionDurationMinutes: null });
    expect(errs.minPasswordLength).toBe("minPasswordLengthRange");
  });

  it("rejects maxSessionDurationMinutes below min", () => {
    const errs = validatePolicy({ ...VALID_BASE, minPasswordLength: POLICY_MIN_PW_LENGTH_MIN, maxSessionDurationMinutes: POLICY_SESSION_DURATION_MIN - 1 });
    expect(errs.maxSessionDurationMinutes).toBe("maxSessionDurationRange");
  });

  it("rejects maxSessionDurationMinutes over max", () => {
    const errs = validatePolicy({ ...VALID_BASE, minPasswordLength: POLICY_MIN_PW_LENGTH_MIN, maxSessionDurationMinutes: POLICY_SESSION_DURATION_MAX + 1 });
    expect(errs.maxSessionDurationMinutes).toBe("maxSessionDurationRange");
  });

  it("returns multiple errors at once", () => {
    const errs = validatePolicy({ ...VALID_BASE, minPasswordLength: -1, maxSessionDurationMinutes: 1 });
    expect(Object.keys(errs).length).toBeGreaterThanOrEqual(2);
  });

  it("rejects NaN minPasswordLength", () => {
    const errs = validatePolicy({ ...VALID_BASE, minPasswordLength: NaN, maxSessionDurationMinutes: null });
    expect(errs.minPasswordLength).toBe("minPasswordLengthRange");
  });

  it("rejects NaN maxSessionDurationMinutes", () => {
    const errs = validatePolicy({ ...VALID_BASE, minPasswordLength: 0, maxSessionDurationMinutes: NaN as unknown as number });
    expect(errs.maxSessionDurationMinutes).toBe("maxSessionDurationRange");
  });

  it("rejects passwordHistoryCount over max", () => {
    const errs = validatePolicy({ ...VALID_BASE, passwordHistoryCount: PASSWORD_HISTORY_COUNT_MAX + 1 });
    expect(errs.passwordHistoryCount).toBe("passwordHistoryCountRange");
  });

  it("rejects negative passwordHistoryCount", () => {
    const errs = validatePolicy({ ...VALID_BASE, passwordHistoryCount: -1 });
    expect(errs.passwordHistoryCount).toBe("passwordHistoryCountRange");
  });
});
