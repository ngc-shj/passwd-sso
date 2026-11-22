import { API_ERROR } from "@/lib/http/api-error-codes";

/**
 * The passkey-reauth refusals no repeat of the ceremony can resolve — the
 * session has expired, has no binding, the bound credential is gone, or a
 * different passkey was presented — mapped to the Auth-namespace message that
 * sends the user to a fresh sign-in. Any other code returns null: the caller may offer a retry.
 *
 * Kept out of passkey-reauth-client so the many tests that replace that module
 * wholesale do not have to re-declare this mapping.
 */
export function passkeyReauthDeadEndKey(
  error: string,
): "reauthSessionExpired" | "reauthUnavailable" | "reauthCredentialMismatch" | null {
  switch (error) {
    case API_ERROR.UNAUTHORIZED:
      return "reauthSessionExpired";
    case API_ERROR.PASSKEY_REAUTH_UNAVAILABLE:
      return "reauthUnavailable";
    case API_ERROR.PASSKEY_REAUTH_CREDENTIAL_MISMATCH:
      return "reauthCredentialMismatch";
    default:
      return null;
  }
}
