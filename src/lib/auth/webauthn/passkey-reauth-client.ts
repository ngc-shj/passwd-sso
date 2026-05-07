import { API_PATH } from "@/lib/constants";
import { fetchApi } from "@/lib/url-helpers";
import { startPasskeyAuthentication } from "@/lib/auth/webauthn/webauthn-client";

type ReauthOptionsResponse = {
  challengeId: string;
  publicKey: Record<string, unknown>;
};

export type PasskeyReauthResult =
  | { ok: true; verifiedAt: string }
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

  const { challengeId, publicKey } =
    (await optionsRes.json()) as ReauthOptionsResponse;

  let responseJSON: Record<string, unknown>;
  try {
    ({ responseJSON } = await startPasskeyAuthentication(publicKey));
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

  const body = (await verifyRes.json()) as { verifiedAt: string };
  return { ok: true, verifiedAt: body.verifiedAt };
}

async function readErrorCode(
  response: Response,
  fallback: string,
): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return body.error ?? fallback;
}
