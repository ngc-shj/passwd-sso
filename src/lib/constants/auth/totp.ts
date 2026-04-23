export const TOTP_ALGORITHM = {
  SHA1: "SHA1",
  SHA256: "SHA256",
  SHA512: "SHA512",
} as const;

export type TotpAlgorithm =
  (typeof TOTP_ALGORITHM)[keyof typeof TOTP_ALGORITHM];

export const TOTP_ALGORITHM_VALUES = [
  TOTP_ALGORITHM.SHA1,
  TOTP_ALGORITHM.SHA256,
  TOTP_ALGORITHM.SHA512,
] as const;
