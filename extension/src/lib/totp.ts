import { TOTP, Secret } from "otpauth";

export interface TOTPParams {
  secret: string; // Base32
  algorithm?: string; // SHA1 | SHA256 | SHA512
  digits?: number; // 6-8
  period?: number; // 15-60
}

const ALLOWED_ALGORITHMS = ["SHA1", "SHA256", "SHA512"];

function validateParams(params: TOTPParams): void {
  const algo = (params.algorithm ?? "SHA1").toUpperCase();
  if (!ALLOWED_ALGORITHMS.includes(algo)) {
    throw new Error("INVALID_TOTP");
  }
  const digits = params.digits ?? 6;
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) {
    throw new Error("INVALID_TOTP");
  }
  const period = params.period ?? 30;
  if (!Number.isInteger(period) || period < 15 || period > 60) {
    throw new Error("INVALID_TOTP");
  }
}

export function generateTOTPCode(params: TOTPParams): string {
  validateParams(params);
  const algorithm = (params.algorithm ?? "SHA1").toUpperCase();
  const otp = new TOTP({
    secret: Secret.fromBase32(params.secret),
    algorithm,
    digits: params.digits ?? 6,
    period: params.period ?? 30,
  });
  return otp.generate();
}
