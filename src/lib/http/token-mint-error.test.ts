import { describe, it, expect } from "vitest";
import { tokenMintApiErrorKey } from "./token-mint-error";

describe("tokenMintApiErrorKey", () => {
  it("returns the ApiErrors key for SESSION_STEP_UP_REQUIRED", () => {
    expect(tokenMintApiErrorKey("SESSION_STEP_UP_REQUIRED")).toBe(
      "sessionStepUpRequired",
    );
  });

  it("returns the ApiErrors key for RATE_LIMIT_EXCEEDED", () => {
    expect(tokenMintApiErrorKey("RATE_LIMIT_EXCEEDED")).toBe(
      "rateLimitExceeded",
    );
  });

  it("aliases OPERATOR_TOKEN_STALE_SESSION to the shared step-up message", () => {
    // operator-token's stale-session alias surfaces the same re-auth
    // guidance as SESSION_STEP_UP_REQUIRED, per the C5 unification.
    expect(tokenMintApiErrorKey("OPERATOR_TOKEN_STALE_SESSION")).toBe(
      "sessionStepUpRequired",
    );
  });

  it("returns null for codes outside the allow-list (e.g. SCIM_TOKEN_INVALID)", () => {
    // Even though SCIM_TOKEN_INVALID exists in apiErrorToI18nKey's mapping,
    // it must NOT leak to a token-mint surface that did not opt in.
    expect(tokenMintApiErrorKey("SCIM_TOKEN_INVALID")).toBeNull();
    expect(tokenMintApiErrorKey("INVALID_PASSPHRASE")).toBeNull();
    expect(tokenMintApiErrorKey("TEAM_NOT_FOUND")).toBeNull();
  });

  it("returns null for unknown / non-string inputs", () => {
    expect(tokenMintApiErrorKey("BOGUS_CODE")).toBeNull();
    expect(tokenMintApiErrorKey(undefined)).toBeNull();
    expect(tokenMintApiErrorKey(null)).toBeNull();
    expect(tokenMintApiErrorKey(42)).toBeNull();
    expect(tokenMintApiErrorKey({ error: "RATE_LIMIT_EXCEEDED" })).toBeNull();
  });

  it("returns null for boundary string inputs (empty, whitespace, prefix-shared)", () => {
    // Pin Set.has equality semantics — guards against future refactors that
    // might switch to startsWith/includes and silently broaden the allow-list.
    expect(tokenMintApiErrorKey("")).toBeNull();
    expect(tokenMintApiErrorKey(" RATE_LIMIT_EXCEEDED")).toBeNull();
    expect(tokenMintApiErrorKey("RATE_LIMIT_EXCEEDED ")).toBeNull();
    expect(tokenMintApiErrorKey("RATE_LIMIT_EXCEEDED_FOO")).toBeNull();
    expect(tokenMintApiErrorKey("rate_limit_exceeded")).toBeNull();
  });
});
