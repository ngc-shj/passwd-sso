import { describe, it, expect } from "vitest";
import { getPolicyViolations, checkPasswordReuse } from "./password-policy-validation";

describe("getPolicyViolations", () => {
  const NO_POLICY = {
    minPasswordLength: 0,
    requireUppercase: false,
    requireLowercase: false,
    requireNumbers: false,
    requireSymbols: false,
  };
  const baseSettings = {
    mode: "password",
    length: 16,
    uppercase: true,
    lowercase: true,
    numbers: true,
    hasAnySymbolGroup: true,
  };

  it("returns empty for passphrase mode", () => {
    const settings = { ...baseSettings, mode: "passphrase" };
    const policy = {
      minPasswordLength: 20,
      requireUppercase: true,
      requireLowercase: true,
      requireNumbers: true,
      requireSymbols: true,
    };
    expect(getPolicyViolations(settings, policy)).toEqual([]);
  });

  it("returns empty when no policy active", () => {
    expect(getPolicyViolations(baseSettings, NO_POLICY)).toEqual([]);
  });

  it("detects min length violation", () => {
    const settings = { ...baseSettings, length: 8 };
    const policy = { ...NO_POLICY, minPasswordLength: 12 };
    const violations = getPolicyViolations(settings, policy);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toEqual({ key: "policyMinLength", min: 12 });
  });

  it("does not flag min length when length meets requirement exactly", () => {
    const settings = { ...baseSettings, length: 12 };
    const policy = { ...NO_POLICY, minPasswordLength: 12 };
    const violations = getPolicyViolations(settings, policy);
    expect(violations.find((v) => v.key === "policyMinLength")).toBeUndefined();
  });

  it("detects uppercase violation", () => {
    const settings = { ...baseSettings, uppercase: false };
    const policy = { ...NO_POLICY, requireUppercase: true };
    const violations = getPolicyViolations(settings, policy);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toEqual({ key: "policyUppercase" });
  });

  it("detects lowercase violation", () => {
    const settings = { ...baseSettings, lowercase: false };
    const policy = { ...NO_POLICY, requireLowercase: true };
    const violations = getPolicyViolations(settings, policy);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toEqual({ key: "policyLowercase" });
  });

  it("detects numbers violation", () => {
    const settings = { ...baseSettings, numbers: false };
    const policy = { ...NO_POLICY, requireNumbers: true };
    const violations = getPolicyViolations(settings, policy);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toEqual({ key: "policyNumbers" });
  });

  it("detects symbols violation", () => {
    const settings = { ...baseSettings, hasAnySymbolGroup: false };
    const policy = { ...NO_POLICY, requireSymbols: true };
    const violations = getPolicyViolations(settings, policy);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toEqual({ key: "policySymbols" });
  });

  it("detects all violations simultaneously", () => {
    const settings = {
      mode: "password",
      length: 4,
      uppercase: false,
      lowercase: false,
      numbers: false,
      hasAnySymbolGroup: false,
    };
    const policy = {
      minPasswordLength: 12,
      requireUppercase: true,
      requireLowercase: true,
      requireNumbers: true,
      requireSymbols: true,
    };
    const violations = getPolicyViolations(settings, policy);
    expect(violations).toHaveLength(5);
    expect(violations.map((v) => v.key)).toEqual([
      "policyMinLength",
      "policyUppercase",
      "policyLowercase",
      "policyNumbers",
      "policySymbols",
    ]);
  });
});

describe("checkPasswordReuse", () => {
  it("returns false for empty history", () => {
    expect(checkPasswordReuse("Password1!", [])).toBe(false);
  });

  it("returns false when no match", () => {
    expect(checkPasswordReuse("NewPassword!", ["OldPass1", "OtherPass2"])).toBe(false);
  });

  it("returns true for exact match", () => {
    expect(checkPasswordReuse("Password1!", ["OldPass", "Password1!", "AnotherPass"])).toBe(true);
  });

  it("is case-sensitive", () => {
    expect(checkPasswordReuse("password1!", ["Password1!"])).toBe(false);
    expect(checkPasswordReuse("Password1!", ["password1!"])).toBe(false);
  });
});
