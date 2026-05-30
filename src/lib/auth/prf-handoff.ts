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
 * The PRF output is held as a `Uint8Array` (not a hex string) so it can be
 * zeroized after use — JS strings are immutable and cannot be wiped. Ownership
 * transfers along producer → handoff → consumer: the producer stops referencing
 * the buffer after `stashPrf` (it must NOT zeroize the stashed buffer), the
 * consumer zeroizes it after `takePrf` + use. `stashPrf` (on overwrite) and
 * `clearPrf` zeroize the buffer they drop. Zeroization is best-effort
 * heap-residency reduction: a full page reload before consume drops the module
 * via GC with nothing running to wipe, and the source buffer originates from a
 * browser-owned WebAuthn `ArrayBuffer` that is itself un-wipeable.
 *
 * Client-only: imported solely by "use client" components.
 */

export interface PrfHandoff {
  /** PRF output bytes. Owned by the handoff; the consumer zeroizes after use. */
  prfOutput: Uint8Array;
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
  pending?.prfOutput.fill(0);
  pending = handoff;
}

/** Whether PRF material is stashed, without consuming it (gate before takePrf). */
export function hasPrf(): boolean {
  return pending !== null;
}

/**
 * Return the stashed PRF material and clear it (single-use). Does NOT zeroize —
 * ownership transfers to the caller, which zeroizes `prfOutput` after use.
 */
export function takePrf(): PrfHandoff | null {
  const value = pending;
  pending = null;
  return value;
}

/** Drop any stashed material without consuming it (e.g. on sign-in failure). */
export function clearPrf(): void {
  pending?.prfOutput.fill(0);
  pending = null;
}
