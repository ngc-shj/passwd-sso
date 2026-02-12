// Minimal client-side crypto utilities for the extension.

const PBKDF2_ITERATIONS = 600_000;
const AES_KEY_LENGTH = 256;
const IV_LENGTH = 12; // 96 bits, recommended for GCM
const HKDF_ENC_INFO = "passwd-sso-enc-v1";
const VERIFICATION_PLAINTEXT = "passwd-sso-vault-verification-v1";

export interface EncryptedData {
  ciphertext: string; // hex
  iv: string; // hex
  authTag: string; // hex
}

// ─── Utility ────────────────────────────────────────────────

export function hexEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function hexDecode(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function toArrayBuffer(arr: Uint8Array): ArrayBuffer {
  return arr.buffer.slice(
    arr.byteOffset,
    arr.byteOffset + arr.byteLength
  ) as ArrayBuffer;
}

function textEncode(text: string): ArrayBuffer {
  return toArrayBuffer(new TextEncoder().encode(text));
}

function textDecode(buf: ArrayBuffer): string {
  return new TextDecoder().decode(buf);
}

// ─── Key Derivation ─────────────────────────────────────────

export async function deriveWrappingKey(
  passphrase: string,
  accountSalt: Uint8Array
): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    textEncode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: toArrayBuffer(accountSalt),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: AES_KEY_LENGTH },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function deriveEncryptionKey(
  secretKey: Uint8Array
): Promise<CryptoKey> {
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(secretKey),
    "HKDF",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new ArrayBuffer(32),
      info: textEncode(HKDF_ENC_INFO),
    },
    hkdfKey,
    { name: "AES-GCM", length: AES_KEY_LENGTH },
    false,
    ["encrypt", "decrypt"]
  );
}

// ─── Secret Key ─────────────────────────────────────────────

export async function unwrapSecretKey(
  encrypted: EncryptedData,
  wrappingKey: CryptoKey
): Promise<Uint8Array> {
  const ciphertext = hexDecode(encrypted.ciphertext);
  const iv = hexDecode(encrypted.iv);
  const authTag = hexDecode(encrypted.authTag);

  const combined = new Uint8Array(ciphertext.length + authTag.length);
  combined.set(ciphertext);
  combined.set(authTag, ciphertext.length);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    wrappingKey,
    toArrayBuffer(combined)
  );

  return new Uint8Array(decrypted);
}

// ─── Verification ───────────────────────────────────────────

export async function verifyKey(
  encryptionKey: CryptoKey,
  artifact: EncryptedData
): Promise<boolean> {
  try {
    const plaintext = await decryptData(artifact, encryptionKey);
    return plaintext === VERIFICATION_PLAINTEXT;
  } catch {
    return false;
  }
}

// ─── Decryption ─────────────────────────────────────────────

export async function decryptData(
  encrypted: EncryptedData,
  key: CryptoKey,
  aad?: Uint8Array
): Promise<string> {
  const ciphertext = hexDecode(encrypted.ciphertext);
  const iv = hexDecode(encrypted.iv);
  const authTag = hexDecode(encrypted.authTag);

  const combined = new Uint8Array(ciphertext.length + authTag.length);
  combined.set(ciphertext);
  combined.set(authTag, ciphertext.length);

  const params: AesGcmParams = { name: "AES-GCM", iv: toArrayBuffer(iv) };
  if (aad) params.additionalData = toArrayBuffer(aad);

  const decrypted = await crypto.subtle.decrypt(
    params,
    key,
    toArrayBuffer(combined)
  );
  return textDecode(decrypted);
}

// ─── AAD (Personal Vault) ───────────────────────────────────

const AAD_VERSION = 1;
const SCOPE_PERSONAL = "PV";

function buildAADBytes(
  scope: string,
  expectedFieldCount: number,
  fields: string[]
): Uint8Array {
  if (scope.length !== 2) {
    throw new Error(`AAD scope must be exactly 2 ASCII chars, got "${scope}"`);
  }
  if (fields.length !== expectedFieldCount) {
    throw new Error(
      `AAD scope "${scope}" expects ${expectedFieldCount} fields, got ${fields.length}`
    );
  }

  const encoder = new TextEncoder();
  const encodedFields = fields.map((f) => encoder.encode(f));

  const headerSize = 4;
  const fieldsSize = encodedFields.reduce(
    (sum, ef) => sum + 2 + ef.length,
    0
  );
  const totalSize = headerSize + fieldsSize;

  const buf = new ArrayBuffer(totalSize);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  let offset = 0;
  bytes[offset] = scope.charCodeAt(0);
  bytes[offset + 1] = scope.charCodeAt(1);
  offset += 2;

  view.setUint8(offset, AAD_VERSION);
  offset += 1;

  view.setUint8(offset, fields.length);
  offset += 1;

  for (const encoded of encodedFields) {
    if (encoded.length > 0xffff) {
      throw new Error(`AAD field too long: ${encoded.length} bytes (max 65535)`);
    }
    view.setUint16(offset, encoded.length, false);
    offset += 2;
    bytes.set(encoded, offset);
    offset += encoded.length;
  }

  return bytes;
}

export function buildPersonalEntryAAD(
  userId: string,
  entryId: string
): Uint8Array {
  return buildAADBytes(SCOPE_PERSONAL, 2, [userId, entryId]);
}
