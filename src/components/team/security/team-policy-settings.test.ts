import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTranslator } from "next-intl";
import { validatePolicy } from "./team-policy-settings";
import {
  POLICY_MIN_PW_LENGTH_MIN,
  POLICY_MIN_PW_LENGTH_MAX,
  PASSWORD_HISTORY_COUNT_MAX,
  SESSION_IDLE_TIMEOUT_MIN,
  SESSION_IDLE_TIMEOUT_MAX,
  SESSION_ABSOLUTE_TIMEOUT_MIN,
  SESSION_ABSOLUTE_TIMEOUT_MAX,
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
    expect(validatePolicy({ ...VALID_BASE, minPasswordLength: POLICY_MIN_PW_LENGTH_MIN, sessionIdleTimeoutMinutes: 5, sessionAbsoluteTimeoutMinutes: 5 })).toEqual({});
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

  it("rejects sessionIdleTimeoutMinutes below 5 (MIN)", () => {
    const errs = validatePolicy({ ...VALID_BASE, sessionIdleTimeoutMinutes: 4 });
    expect(errs.sessionIdleTimeoutMinutes).toBe("sessionIdleTimeoutRange");
  });

  it("rejects sessionIdleTimeoutMinutes over 1440", () => {
    const errs = validatePolicy({ ...VALID_BASE, sessionIdleTimeoutMinutes: 1441 });
    expect(errs.sessionIdleTimeoutMinutes).toBe("sessionIdleTimeoutRange");
  });

  it("rejects sessionAbsoluteTimeoutMinutes below 5 (MIN)", () => {
    const errs = validatePolicy({ ...VALID_BASE, sessionAbsoluteTimeoutMinutes: 4 });
    expect(errs.sessionAbsoluteTimeoutMinutes).toBe("sessionAbsoluteTimeoutRange");
  });

  it("rejects sessionAbsoluteTimeoutMinutes over 43200", () => {
    const errs = validatePolicy({ ...VALID_BASE, sessionAbsoluteTimeoutMinutes: 43201 });
    expect(errs.sessionAbsoluteTimeoutMinutes).toBe("sessionAbsoluteTimeoutRange");
  });

  it("returns multiple errors at once", () => {
    const errs = validatePolicy({ ...VALID_BASE, minPasswordLength: -1, sessionIdleTimeoutMinutes: 4, sessionAbsoluteTimeoutMinutes: -1 });
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

// Guards the validate() i18n wiring: every msgKey validatePolicy can emit must
// resolve to a real number-bearing string. A dropped interpolation arg (the
// F-R4-1 bug) would leave a literal "{min}"/"{max}" in the output.
describe("range error i18n wiring", () => {
  const messages = JSON.parse(
    readFileSync(join(process.cwd(), "messages", "en", "TeamPolicy.json"), "utf8"),
  ) as Record<string, string>;
  const t = createTranslator({ locale: "en", messages });

  // Mirror of ERROR_MESSAGE_ARGS in team-policy-settings.tsx — must cover every
  // Range key validatePolicy emits.
  const ERROR_MESSAGE_ARGS: Record<string, Record<string, number>> = {
    minPasswordLengthRange: { min: POLICY_MIN_PW_LENGTH_MIN, max: POLICY_MIN_PW_LENGTH_MAX },
    passwordHistoryCountRange: { min: 0, max: PASSWORD_HISTORY_COUNT_MAX },
    sessionIdleTimeoutRange: { min: SESSION_IDLE_TIMEOUT_MIN, max: SESSION_IDLE_TIMEOUT_MAX },
    sessionAbsoluteTimeoutRange: { min: SESSION_ABSOLUTE_TIMEOUT_MIN, max: SESSION_ABSOLUTE_TIMEOUT_MAX },
  };

  it("session idle timeout out-of-range error renders real numbers, no placeholder residue", () => {
    const errs = validatePolicy({ ...VALID_BASE, sessionIdleTimeoutMinutes: 1441 });
    const msgKey = errs.sessionIdleTimeoutMinutes;
    const rendered = t(msgKey, ERROR_MESSAGE_ARGS[msgKey]);
    expect(rendered).toContain(String(SESSION_IDLE_TIMEOUT_MAX));
    expect(rendered).not.toContain("{");
    expect(rendered).not.toContain("}");
  });

  it("session absolute timeout out-of-range error renders real numbers, no placeholder residue", () => {
    const errs = validatePolicy({ ...VALID_BASE, sessionAbsoluteTimeoutMinutes: 43201 });
    const msgKey = errs.sessionAbsoluteTimeoutMinutes;
    const rendered = t(msgKey, ERROR_MESSAGE_ARGS[msgKey]);
    expect(rendered).toContain(String(SESSION_ABSOLUTE_TIMEOUT_MAX));
    expect(rendered).not.toContain("{");
    expect(rendered).not.toContain("}");
  });

  it("ERROR_MESSAGE_ARGS covers every Range key validatePolicy can emit", () => {
    const emittableRangeKeys = [
      "minPasswordLengthRange",
      "passwordHistoryCountRange",
      "sessionIdleTimeoutRange",
      "sessionAbsoluteTimeoutRange",
    ];
    for (const key of emittableRangeKeys) {
      expect(ERROR_MESSAGE_ARGS[key]).toBeDefined();
    }
  });
});
