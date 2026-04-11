// Shared password policy validation for both team and tenant policies

export interface PasswordPolicy {
  minPasswordLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireNumbers: boolean;
  requireSymbols: boolean;
}

export type PolicyViolation =
  | { key: "policyMinLength"; min: number }
  | { key: "policyUppercase" }
  | { key: "policyLowercase" }
  | { key: "policyNumbers" }
  | { key: "policySymbols" }
  | { key: "policyPasswordReuse" };

// For generator settings validation (mode check needed).
// hasAnySymbolGroup is pre-computed by the caller to avoid coupling this module
// to the concrete SymbolGroupFlags type from generator-prefs.
export interface GeneratorSettingsLike {
  mode: string;
  length: number;
  uppercase: boolean;
  lowercase: boolean;
  numbers: boolean;
  /** Whether any symbol group is enabled — pre-computed from symbolGroups by the caller. */
  hasAnySymbolGroup: boolean;
}

export function getPolicyViolations(
  settings: GeneratorSettingsLike,
  policy: PasswordPolicy,
): PolicyViolation[] {
  if (settings.mode === "passphrase") return [];
  const violations: PolicyViolation[] = [];
  if (policy.minPasswordLength > 0 && settings.length < policy.minPasswordLength)
    violations.push({ key: "policyMinLength", min: policy.minPasswordLength });
  if (policy.requireUppercase && !settings.uppercase) violations.push({ key: "policyUppercase" });
  if (policy.requireLowercase && !settings.lowercase) violations.push({ key: "policyLowercase" });
  if (policy.requireNumbers && !settings.numbers) violations.push({ key: "policyNumbers" });
  if (policy.requireSymbols && !settings.hasAnySymbolGroup) violations.push({ key: "policySymbols" });
  return violations;
}

function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  const maxLen = Math.max(ab.length, bb.length);
  let result = ab.length ^ bb.length; // non-zero if lengths differ
  for (let i = 0; i < maxLen; i++) result |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return result === 0;
}

export function checkPasswordReuse(
  password: string,
  decryptedHistory: string[],
): boolean {
  return decryptedHistory.some((prev) => timingSafeEqual(prev, password));
}
