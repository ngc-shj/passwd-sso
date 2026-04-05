/**
 * Client-side QR code scanning and otpauth:// URI parsing.
 *
 * Uses `jsqr` for QR decoding. All processing happens in the browser —
 * no image data is sent to the server.
 */

import jsQR from "jsqr";
import type { EntryTotp } from "@/lib/entry-form-types";
import { MAX_IMAGE_DIMENSION } from "@/lib/validations/common";

/**
 * Scan an ImageData for a QR code and return the decoded text.
 * Returns null if no QR code is found.
 */
export function scanImageForQR(imageData: ImageData): string | null {
  if (
    imageData.width > MAX_IMAGE_DIMENSION ||
    imageData.height > MAX_IMAGE_DIMENSION
  ) {
    return null;
  }

  const result = jsQR(imageData.data, imageData.width, imageData.height);
  return result?.data ?? null;
}

/**
 * Parse an otpauth:// URI into a TOTP entry.
 * Returns null if the URI is invalid or not a TOTP URI.
 */
export function parseOtpauthUri(input: string): EntryTotp | null {
  try {
    const url = new URL(input);
    if (url.protocol !== "otpauth:") return null;
    if (url.hostname !== "totp") return null;
    const secret = url.searchParams.get("secret");
    if (!secret) return null;

    const VALID_ALGORITHMS = ["SHA1", "SHA256", "SHA512"] as const;
    const rawAlgorithm = url.searchParams.get("algorithm")?.toUpperCase();
    const algorithm = rawAlgorithm && VALID_ALGORITHMS.includes(rawAlgorithm as typeof VALID_ALGORITHMS[number])
      ? (rawAlgorithm as EntryTotp["algorithm"])
      : undefined;

    const rawDigits = parseInt(url.searchParams.get("digits") ?? "", 10);
    const rawPeriod = parseInt(url.searchParams.get("period") ?? "", 10);

    return {
      secret,
      algorithm,
      digits: !Number.isNaN(rawDigits) && rawDigits >= 4 && rawDigits <= 10 ? rawDigits : undefined,
      period: !Number.isNaN(rawPeriod) && rawPeriod > 0 && rawPeriod <= 3600 ? rawPeriod : undefined,
    };
  } catch {
    return null;
  }
}
