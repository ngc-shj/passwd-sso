/**
 * A `decryptData` stand-in that models AES-GCM's AAD check for reader tests
 * whose crypto is mocked: a ciphertext named `noaad-*` (a legacy aadVersion-0
 * ciphertext, sealed without AAD) opens only when no AAD is passed; any other
 * ciphertext opens only when one is. A mismatch fails as Web Crypto does, with
 * an `OperationError`. A strict team entry reader therefore REFUSES a no-AAD
 * ciphertext the server labels aadVersion 0 (D67).
 */
export function aadModelDecrypt(plaintext: string) {
  return async (encrypted: { ciphertext: string }, _key: unknown, aad?: unknown): Promise<string> => {
    const sealedWithoutAad = encrypted.ciphertext.startsWith("noaad-");
    if (sealedWithoutAad ? aad !== undefined : aad === undefined) {
      throw new DOMException("The operation failed for an operation-specific reason", "OperationError");
    }
    return plaintext;
  };
}

/**
 * A stricter stand-in: opens only at exactly the `expected` AAD bytes
 * (undefined = no AAD), so a reader passing the wrong team entry context — the
 * other vaultType, another ItemKey version — fails as it would against real
 * ciphertext (plan team-key-prune-blob-sweep-strict-aad C5 T8).
 */
export function aadGatedDecrypt(expected: Uint8Array | undefined, plaintext: string) {
  return async (_encrypted: unknown, _key: unknown, aad?: unknown): Promise<string> => {
    const same = expected === undefined
      ? aad === undefined
      : aad instanceof Uint8Array && aad.length === expected.length && aad.every((b, i) => b === expected[i]);
    if (!same) throw new DOMException("The operation failed for an operation-specific reason", "OperationError");
    return plaintext;
  };
}
