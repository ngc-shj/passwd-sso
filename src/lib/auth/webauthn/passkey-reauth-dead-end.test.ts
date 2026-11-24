import { describe, it, expect } from "vitest";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { passkeyReauthDeadEndKey } from "./passkey-reauth-dead-end";

describe("passkeyReauthDeadEndKey", () => {
  it("names the sign-in-again message for a session that has expired", () => {
    expect(passkeyReauthDeadEndKey(API_ERROR.UNAUTHORIZED)).toBe("reauthSessionExpired");
  });

  it("names the sign-in-again message for a session without a usable binding", () => {
    expect(passkeyReauthDeadEndKey(API_ERROR.PASSKEY_REAUTH_UNAVAILABLE)).toBe("reauthUnavailable");
  });

  it("names the sign-in-again message for a passkey other than the bound one", () => {
    expect(passkeyReauthDeadEndKey(API_ERROR.PASSKEY_REAUTH_CREDENTIAL_MISMATCH)).toBe(
      "reauthCredentialMismatch",
    );
  });

  it.each(["AUTHENTICATION_CANCELLED", "PASSKEY_REAUTH_FAILED", API_ERROR.RATE_LIMIT_EXCEEDED])(
    "leaves %s retryable",
    (error) => {
      expect(passkeyReauthDeadEndKey(error)).toBeNull();
    },
  );
});
