/**
 * In-memory hand-off of PRF material from the passkey sign-in ceremony to the
 * dashboard's vault auto-unlock.
 *
 * The PRF output and the PRF-wrapped secret key are NOT placed in sessionStorage
 * (which an XSS payload can enumerate). Instead they live in a module-level
 * variable that survives a client-side `router.push` (same JS context, no full
 * reload) but is gone after a real page reload — in which case auto-unlock
 * degrades gracefully to the manual unlock prompt (the same path a non-PRF
 * passkey takes). `takePrf()` clears on read so the material is held only for
 * the single sign-in→dashboard transition.
 *
 * Client-only: imported solely by "use client" components.
 */

export interface PrfHandoff {
  /** PRF output as hex (consumer hex-decodes, uses, then zeroes the buffer). */
  prfOutputHex: string;
  /** Server-returned PRF-wrapped secret key bundle. */
  prfData: {
    prfEncryptedSecretKey: string;
    prfSecretKeyIv: string;
    prfSecretKeyAuthTag: string;
  };
}

let pending: PrfHandoff | null = null;

/** Stash PRF material for the upcoming vault auto-unlock. Overwrites any prior. */
export function stashPrf(handoff: PrfHandoff): void {
  pending = handoff;
}

/** Return the stashed PRF material and clear it (single-use). */
export function takePrf(): PrfHandoff | null {
  const value = pending;
  pending = null;
  return value;
}

/** Drop any stashed material without consuming it (e.g. on sign-in failure). */
export function clearPrf(): void {
  pending = null;
}
