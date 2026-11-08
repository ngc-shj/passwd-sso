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
