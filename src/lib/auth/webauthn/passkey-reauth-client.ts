import { API_PATH } from "@/lib/constants";
import { fetchApi } from "@/lib/url-helpers";
import { parseJsonBodyOnce, readApiErrorBody } from "@/lib/http/read-api-error-body";
import { startPasskeyAuthentication } from "@/lib/auth/webauthn/webauthn-client";
import { readPasskeyOptions } from "@/lib/auth/webauthn/passkey-response";

/**
 * `verifiedAt` is null when the server accepted the assertion but its response
 * body could not be read: the session's verification timestamp was refreshed
 * all the same, so the reauth still succeeded.
 */
export type PasskeyReauthResult =
  | { ok: true; verifiedAt: string | null }
  | { ok: false; error: string };

/**
 * Run an authenticated passkey reauthentication ceremony for the current
 * browser session and refresh its recent-passkey-verification timestamp.
 */
export async function reauthenticateWithPasskey(): Promise<PasskeyReauthResult> {
  const optionsRes = await fetchApi(API_PATH.AUTH_PASSKEY_REAUTH_OPTIONS, {
    method: "POST",
  });
  if (!optionsRes.ok) {
    return { ok: false, error: await readErrorCode(optionsRes, "PASSKEY_REAUTH_FAILED") };
  }

  // Without the challenge there is no ceremony to run: an unreadable body
  // fails like any other options failure.
  const optionsBody = readPasskeyOptions(await parseJsonBodyOnce(optionsRes));
  if (!optionsBody) {
    return { ok: false, error: "PASSKEY_REAUTH_FAILED" };
  }
  const { challengeId, options } = optionsBody;

  let responseJSON: Record<string, unknown>;
  try {
    ({ responseJSON } = await startPasskeyAuthentication(options));
  } catch (err) {
    if (err instanceof Error && err.message === "AUTHENTICATION_CANCELLED") {
      return { ok: false, error: "AUTHENTICATION_CANCELLED" };
    }
    return { ok: false, error: "PASSKEY_REAUTH_FAILED" };
  }

  const verifyRes = await fetchApi(API_PATH.AUTH_PASSKEY_REAUTH_VERIFY, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      credentialResponse: JSON.stringify(responseJSON),
      challengeId,
    }),
  });
  if (!verifyRes.ok) {
    return { ok: false, error: await readErrorCode(verifyRes, "PASSKEY_REAUTH_FAILED") };
  }

  const body = (await parseJsonBodyOnce(verifyRes)) as { verifiedAt?: unknown } | null;
  return { ok: true, verifiedAt: typeof body?.verifiedAt === "string" ? body.verifiedAt : null };
}

async function readErrorCode(
  response: Response,
  fallback: string,
): Promise<string> {
  const body = await readApiErrorBody(response);
  return body?.error ?? fallback;
}
