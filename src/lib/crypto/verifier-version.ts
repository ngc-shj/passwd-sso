// VERIFIER_VERSION is intentionally server-only — do not add to CRYPTO_CONSTANTS or any client-imported export.
// See docs/archive/review/pepper-rotation-runbook.md and verifier-pepper-dual-version-plan.md for rationale.

export const VERIFIER_VERSION = 1;

/**
 * Test seam: production reads the constant; tests can override via env (NODE_ENV='test' only).
 * The NODE_ENV check prevents accidental production override via misconfigured env.
 */
export function getCurrentVerifierVersion(): number {
  if (process.env.NODE_ENV === "test") {
    const override = process.env.INTERNAL_TEST_VERIFIER_VERSION;
    if (override) {
      const n = parseInt(override, 10);
      if (Number.isInteger(n) && n >= 1) return n;
    }
  }
  return VERIFIER_VERSION;
}
