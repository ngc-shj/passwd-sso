/**
 * Fake encrypted data generators for k6 load tests.
 *
 * The server stores encrypted blobs without decrypting them,
 * so these only need to be structurally valid (correct hex lengths).
 */

/** Generate a fake hex string of given byte length. */
function fakeHex(bytes) {
  const chars = "0123456789abcdef";
  let result = "";
  for (let i = 0; i < bytes * 2; i++) {
    result += chars[Math.floor(Math.random() * 16)];
  }
  return result;
}

/** Generate a fake encrypted field (ciphertext + iv + authTag). */
export function fakeEncryptedField(ciphertextBytes = 128) {
  return {
    ciphertext: fakeHex(ciphertextBytes),
    iv: fakeHex(12), // 24 hex chars
    authTag: fakeHex(16), // 32 hex chars
  };
}

/** Generate a fake UUID v4. */
function fakeUuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** Generate a complete password create payload. */
export function fakeCreatePasswordPayload() {
  return {
    id: fakeUuid(),
    encryptedBlob: fakeEncryptedField(256),
    encryptedOverview: fakeEncryptedField(64),
    keyVersion: 1,
    aadVersion: 1,
  };
}
