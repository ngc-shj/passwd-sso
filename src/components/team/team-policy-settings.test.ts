import { describe, it, expect } from "vitest";
import { validatePolicy } from "./team-policy-settings";
import {
  POLICY_MIN_PW_LENGTH_MIN,
  POLICY_MIN_PW_LENGTH_MAX,
  PASSWORD_HISTORY_COUNT_MAX,
} from "@/lib/validations";

const VALID_BASE = {
  minPasswordLength: 8,
  sessionIdleTimeoutMinutes: 60 as number | null,
  sessionAbsoluteTimeoutMinutes: 1440 as number | null,
  passwordHistoryCount: 0,
  teamAllowedCidrs: [] as string[],
};

describe("validatePolicy", () => {
  it("returns no errors for valid policy", () => {
    expect(validatePolicy(VALID_BASE)).toEqual({});
  });

  it("returns no errors for boundary values", () => {
    expect(validatePolicy({ ...VALID_BASE, minPasswordLength: POLICY_MIN_PW_LENGTH_MIN, sessionIdleTimeoutMinutes: 1, sessionAbsoluteTimeoutMinutes: 1 })).toEqual({});
    expect(validatePolicy({ ...VALID_BASE, minPasswordLength: POLICY_MIN_PW_LENGTH_MAX, sessionIdleTimeoutMinutes: 1440, sessionAbsoluteTimeoutMinutes: 43200 })).toEqual({});
  });

  it("returns no errors when both session timeouts are null (inherit tenant)", () => {
    expect(validatePolicy({ ...VALID_BASE, minPasswordLength: 0, sessionIdleTimeoutMinutes: null, sessionAbsoluteTimeoutMinutes: null })).toEqual({});
  });

  it("rejects negative minPasswordLength", () => {
    const errs = validatePolicy({ ...VALID_BASE, minPasswordLength: -1 });
    expect(errs.minPasswordLength).toBe("minPasswordLengthRange");
  });

  it("rejects minPasswordLength over max", () => {
    const errs = validatePolicy({ ...VALID_BASE, minPasswordLength: POLICY_MIN_PW_LENGTH_MAX + 1 });
    expect(errs.minPasswordLength).toBe("minPasswordLengthRange");
  });

  it("rejects sessionIdleTimeoutMinutes below 1", () => {
    const errs = validatePolicy({ ...VALID_BASE, sessionIdleTimeoutMinutes: 0 });
    expect(errs.sessionIdleTimeoutMinutes).toBe("sessionIdleTimeoutRange");
  });

  it("rejects sessionIdleTimeoutMinutes over 1440", () => {
    const errs = validatePolicy({ ...VALID_BASE, sessionIdleTimeoutMinutes: 1441 });
    expect(errs.sessionIdleTimeoutMinutes).toBe("sessionIdleTimeoutRange");
  });

  it("rejects sessionAbsoluteTimeoutMinutes below 1", () => {
    const errs = validatePolicy({ ...VALID_BASE, sessionAbsoluteTimeoutMinutes: 0 });
    expect(errs.sessionAbsoluteTimeoutMinutes).toBe("sessionAbsoluteTimeoutRange");
  });

  it("rejects sessionAbsoluteTimeoutMinutes over 43200", () => {
    const errs = validatePolicy({ ...VALID_BASE, sessionAbsoluteTimeoutMinutes: 43201 });
    expect(errs.sessionAbsoluteTimeoutMinutes).toBe("sessionAbsoluteTimeoutRange");
  });

  it("returns multiple errors at once", () => {
    const errs = validatePolicy({ ...VALID_BASE, minPasswordLength: -1, sessionIdleTimeoutMinutes: 0, sessionAbsoluteTimeoutMinutes: -1 });
    expect(Object.keys(errs).length).toBeGreaterThanOrEqual(3);
  });

  it("rejects NaN minPasswordLength", () => {
    const errs = validatePolicy({ ...VALID_BASE, minPasswordLength: NaN });
    expect(errs.minPasswordLength).toBe("minPasswordLengthRange");
  });

  it("rejects NaN sessionIdleTimeoutMinutes", () => {
    const errs = validatePolicy({ ...VALID_BASE, sessionIdleTimeoutMinutes: NaN as unknown as number });
    expect(errs.sessionIdleTimeoutMinutes).toBe("sessionIdleTimeoutRange");
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
