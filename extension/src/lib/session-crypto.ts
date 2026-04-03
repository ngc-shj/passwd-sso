/**
 * Ephemeral wrapping key for encrypting sensitive session fields
 * (token, vaultSecretKey) before persisting to chrome.storage.session.
 *
 * The CryptoKey is held in-memory only (non-extractable). When the service
 * worker is terminated, the key is lost — encrypted blobs become unreadable
 * and the user must re-authenticate.
 */

const IV_LENGTH = 12;

export interface EncryptedField {
  ciphertext: string; // hex
  iv: string;         // hex
  authTag: string;    // hex
}

let ephemeralKeyPromise: Promise<CryptoKey> | null = null;

/** Generate or return the ephemeral wrapping key. */
async function getOrCreateKey(): Promise<CryptoKey> {
  if (!ephemeralKeyPromise) {
    ephemeralKeyPromise = crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  }
  return ephemeralKeyPromise;
}

function hexEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexDecode(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
    throw new RangeError("invalid hex string");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Encrypt a plaintext string using the ephemeral key.
 * Returns null if encryption fails.
 */
export async function encryptField(plaintext: string): Promise<EncryptedField | null> {
  try {
    const key = await getOrCreateKey();
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const encoded = new TextEncoder().encode(plaintext);
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      encoded,
    );
    const encBytes = new Uint8Array(encrypted);
    const ciphertext = encBytes.slice(0, encBytes.length - 16);
    const authTag = encBytes.slice(encBytes.length - 16);
    return {
      ciphertext: hexEncode(ciphertext),
      iv: hexEncode(iv),
      authTag: hexEncode(authTag),
    };
  } catch {
    return null;
  }
}

/**
 * Decrypt an encrypted field using the ephemeral key.
 * Returns null if the key was lost (SW restart) or decryption fails.
 */
export async function decryptField(blob: EncryptedField): Promise<string | null> {
  try {
    if (!ephemeralKeyPromise) return null;
    const key = await ephemeralKeyPromise;
    const ciphertext = hexDecode(blob.ciphertext);
    const iv = hexDecode(blob.iv);
    const authTag = hexDecode(blob.authTag);
    const combined = new Uint8Array(ciphertext.length + authTag.length);
    combined.set(ciphertext);
    combined.set(authTag, ciphertext.length);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      combined,
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    return null;
  }
}

/** Check if the ephemeral key is available (for testing). */
export function hasEphemeralKey(): boolean {
  return ephemeralKeyPromise !== null;
}

/** Clear the ephemeral key (for testing). */
export function clearEphemeralKey(): void {
  ephemeralKeyPromise = null;
}
