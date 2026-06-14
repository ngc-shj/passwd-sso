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
 * A stashed handoff also self-expires after `PRF_HANDOFF_TTL_MS`: if the
 * dashboard never reaches auto-unlock while the SPA stays alive (e.g. an
 * in-page navigation away before unlock), the buffer is wiped instead of
 * lingering. A full page reload drops the module (and this timer) via GC, so
 * the TTL only bounds the in-SPA-without-unlock case — the one residency window
 * that is observable from JS.
 *
 * Client-only: imported solely by "use client" components.
 */

import { MS_PER_SECOND } from "@/lib/constants/time";

/** Grace window before an unconsumed handoff self-wipes. */
export const PRF_HANDOFF_TTL_MS = 30 * MS_PER_SECOND;

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
let ttlTimer: ReturnType<typeof setTimeout> | null = null;

/** Cancel any pending self-expiry timer (on consume, overwrite, or clear). */
function cancelTtl(): void {
  if (ttlTimer !== null) {
    clearTimeout(ttlTimer);
    ttlTimer = null;
  }
}

/** Stash PRF material for the upcoming vault auto-unlock. Overwrites any prior. */
export function stashPrf(handoff: PrfHandoff): void {
  pending?.prfOutput.fill(0);
  cancelTtl();
  pending = handoff;
  // Self-expire if never consumed; cancelled by takePrf/clearPrf/overwrite.
  ttlTimer = setTimeout(clearPrf, PRF_HANDOFF_TTL_MS);
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
  cancelTtl();
  const value = pending;
  pending = null;
  return value;
}

/** Drop any stashed material without consuming it (e.g. on sign-in failure). */
export function clearPrf(): void {
  cancelTtl();
  pending?.prfOutput.fill(0);
  pending = null;
}
