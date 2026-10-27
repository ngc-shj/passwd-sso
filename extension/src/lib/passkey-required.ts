/**
 * The server refuses every bearer call from a member who has no passkey once
 * the tenant's passkey requirement is past its grace period: 403 with
 * `{"error":"PASSKEY_REQUIRED"}`. No retry or refresh can change that answer
 * until the user registers a passkey in the web app.
 */

import { readApiErrorBody } from "./api-error-body";

const PASSKEY_REQUIRED_ERROR = "PASSKEY_REQUIRED";

/** Web-app page where the user registers a passkey (locale resolved by the app). */
export const PASSKEY_SETTINGS_PATH = "/dashboard/settings/auth/passkey";

/**
 * True when `res` is the passkey-requirement refusal. Reads the body from a
 * clone so the caller can still consume the original, and never throws: a body
 * that is missing, already read or not JSON simply does not match.
 */
export async function isPasskeyRequiredResponse(res: Response): Promise<boolean> {
  if (res.status !== 403) return false;
  try {
    const body = await readApiErrorBody(res.clone());
    return body?.error === PASSKEY_REQUIRED_ERROR;
  } catch {
    return false;
  }
}
