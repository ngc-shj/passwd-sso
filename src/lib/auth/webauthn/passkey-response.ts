/**
 * Narrow the parsed bodies of a passkey ceremony round trip (options, then
 * verify), for sign-in, registration, reauth and vault unlock alike. Both are
 * read through `parseJsonBodyOnce`, so an unreadable body arrives here as
 * `null`.
 *
 * Client-only: imported solely by "use client" components and the browser-side
 * modules they call (passkey-reauth-client).
 */
import type { PrfHandoff } from "@/lib/auth/prf-handoff";

export interface PasskeyOptions {
  options: Record<string, unknown>;
  challengeId: string;
  /** Hex PRF salt; absent when the server offers no PRF evaluation. */
  prfSalt: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The ceremony options in an options response, or null when they are not there. */
export function readPasskeyOptions(body: unknown): PasskeyOptions | null {
  if (!isRecord(body)) return null;
  const { options, challengeId, prfSalt } = body;
  if (!isRecord(options) || typeof challengeId !== "string" || challengeId === "") return null;
  return {
    options,
    challengeId,
    prfSalt: typeof prfSalt === "string" && prfSalt !== "" ? prfSalt : undefined,
  };
}

/** The PRF-wrapped secret key bundle in a verify response, or null when it is not there. */
export function readPrfData(body: unknown): PrfHandoff["prfData"] | null {
  if (!isRecord(body) || !isRecord(body.prf)) return null;
  const { prfEncryptedSecretKey, prfSecretKeyIv, prfSecretKeyAuthTag } = body.prf;
  if (
    typeof prfEncryptedSecretKey !== "string" ||
    typeof prfSecretKeyIv !== "string" ||
    typeof prfSecretKeyAuthTag !== "string"
  ) {
    return null;
  }
  return { prfEncryptedSecretKey, prfSecretKeyIv, prfSecretKeyAuthTag };
}
