// The vault epoch: a counter that moves whenever key state is cleared or the
// connection changes (lock, relock, token change, reconnect, a discarded
// restored session). A background operation captures it before its first
// await and asserts it immediately before each sink — a cache write, a
// response carrying entry data, a page delivery, a clipboard write, a server
// write, a signature — so an operation begun under one vault state never acts
// under another. Leaf module: index.ts, login-save.ts and passkey-provider.ts
// all import it.

let epoch = 0;

/** Thrown when an operation's captured epoch is no longer current. */
export class VaultLockedError extends Error {
  constructor() {
    // The code doubles as the message so normalizeErrorCode passes it through.
    super("VAULT_LOCKED");
    this.name = "VaultLockedError";
  }
}

export function currentVaultEpoch(): number {
  return epoch;
}

export function bumpVaultEpoch(): void {
  epoch += 1;
}

export function isVaultEpochCurrent(captured: number): boolean {
  return captured === epoch;
}

export function assertVaultEpoch(captured: number): void {
  if (captured !== epoch) throw new VaultLockedError();
}
