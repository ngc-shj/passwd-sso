/**
 * Client-side WebAuthn helpers for passkey registration and authentication
 * with PRF extension support for vault unlock.
 *
 * Uses the raw WebAuthn API (not @simplewebauthn/browser) to maintain full
 * control over the PRF extension data which includes raw ArrayBuffer values
 * that must be preserved for key wrapping/unwrapping.
 */

// ─── Encoding helpers ──────────────────────────────────────

function base64urlEncode(buf: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < buf.length; i++) {
    binary += String.fromCharCode(buf[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64urlDecode(s: string): Uint8Array {
  // Strip any existing padding before recalculating
  const stripped = s.replace(/=+$/, "");
  const base64 = stripped.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (base64.length % 4)) % 4;
  const padded = base64 + "=".repeat(pad);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function hexDecode(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function hexEncode(buf: Uint8Array): string {
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Convert Uint8Array to ArrayBuffer (fixes TS 5.9 BufferSource compatibility) */
function toArrayBuffer(arr: Uint8Array): ArrayBuffer {
  return arr.buffer.slice(
    arr.byteOffset,
    arr.byteOffset + arr.byteLength,
  ) as ArrayBuffer;
}

// ─── Option conversion ─────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */

function toCreationOptions(
  json: any,
): PublicKeyCredentialCreationOptions {
  return {
    rp: json.rp,
    user: {
      id: toArrayBuffer(base64urlDecode(json.user.id)),
      name: json.user.name,
      displayName: json.user.displayName,
    },
    challenge: toArrayBuffer(base64urlDecode(json.challenge)),
    pubKeyCredParams: json.pubKeyCredParams,
    timeout: json.timeout,
    excludeCredentials: json.excludeCredentials?.map((c: any) => ({
      id: toArrayBuffer(base64urlDecode(c.id)),
      type: c.type,
      transports: c.transports,
    })),
    authenticatorSelection: json.authenticatorSelection,
    attestation: json.attestation,
    extensions: json.extensions,
  };
}

function toRequestOptions(
  json: any,
): PublicKeyCredentialRequestOptions {
  return {
    challenge: toArrayBuffer(base64urlDecode(json.challenge)),
    timeout: json.timeout,
    rpId: json.rpId,
    allowCredentials: json.allowCredentials?.map((c: any) => ({
      id: toArrayBuffer(base64urlDecode(c.id)),
      type: c.type,
      transports: c.transports,
    })),
    userVerification: json.userVerification,
    extensions: json.extensions,
  };
}

// ─── Response serialization ────────────────────────────────

function credentialToRegistrationJSON(
  credential: PublicKeyCredential,
): Record<string, unknown> {
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    id: credential.id,
    rawId: base64urlEncode(new Uint8Array(credential.rawId)),
    type: credential.type,
    response: {
      clientDataJSON: base64urlEncode(
        new Uint8Array(response.clientDataJSON),
      ),
      attestationObject: base64urlEncode(
        new Uint8Array(response.attestationObject),
      ),
      transports: response.getTransports?.() ?? [],
    },
    clientExtensionResults: credential.getClientExtensionResults(),
  };
}

function credentialToAuthenticationJSON(
  credential: PublicKeyCredential,
): Record<string, unknown> {
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: base64urlEncode(new Uint8Array(credential.rawId)),
    type: credential.type,
    response: {
      clientDataJSON: base64urlEncode(
        new Uint8Array(response.clientDataJSON),
      ),
      authenticatorData: base64urlEncode(
        new Uint8Array(response.authenticatorData),
      ),
      signature: base64urlEncode(new Uint8Array(response.signature)),
      userHandle: response.userHandle
        ? base64urlEncode(new Uint8Array(response.userHandle))
        : undefined,
    },
    clientExtensionResults: credential.getClientExtensionResults(),
  };
}

/* eslint-enable @typescript-eslint/no-explicit-any */

// ─── PRF Key Wrapping ──────────────────────────────────────

const IV_LENGTH = 12;

/**
 * Derive AES-256-GCM wrapping key from PRF output via HKDF-SHA256.
 * Never use PRF output directly as a key — always domain-separate through HKDF.
 */
async function derivePrfWrappingKey(
  prfOutput: Uint8Array,
): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(prfOutput),
    "HKDF",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode("passwd-sso:prf-wrapping:v1"),
      info: new TextEncoder().encode("vault-secret-key-wrap"),
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export interface PrfWrappedKey {
  ciphertext: string; // hex
  iv: string; // hex
  authTag: string; // hex
}

export async function wrapSecretKeyWithPrf(
  secretKey: Uint8Array,
  prfOutput: Uint8Array,
): Promise<PrfWrappedKey> {
  const key = await derivePrfWrappingKey(prfOutput);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(secretKey),
  );

  const encBytes = new Uint8Array(encrypted);
  const ciphertext = encBytes.slice(0, encBytes.length - 16);
  const authTag = encBytes.slice(encBytes.length - 16);

  return {
    ciphertext: hexEncode(ciphertext),
    iv: hexEncode(iv),
    authTag: hexEncode(authTag),
  };
}

export async function unwrapSecretKeyWithPrf(
  wrapped: PrfWrappedKey,
  prfOutput: Uint8Array,
): Promise<Uint8Array> {
  const key = await derivePrfWrappingKey(prfOutput);
  const ciphertext = hexDecode(wrapped.ciphertext);
  const iv = hexDecode(wrapped.iv);
  const authTag = hexDecode(wrapped.authTag);

  const combined = new Uint8Array(ciphertext.length + authTag.length);
  combined.set(ciphertext);
  combined.set(authTag, ciphertext.length);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(combined),
  );

  return new Uint8Array(decrypted);
}

// ─── Registration ──────────────────────────────────────────

export interface PasskeyRegistrationResult {
  responseJSON: Record<string, unknown>;
  prfOutput: Uint8Array | null;
}

export async function startPasskeyRegistration(
  optionsJSON: Record<string, unknown>,
  prfSalt?: string, // hex
): Promise<PasskeyRegistrationResult> {
  const publicKeyOptions = toCreationOptions(optionsJSON);

  if (prfSalt) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (publicKeyOptions as any).extensions = {
      ...publicKeyOptions.extensions,
      prf: { eval: { first: toArrayBuffer(hexDecode(prfSalt)) } },
    };
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 120_000);

  let credential: PublicKeyCredential | null;
  try {
    credential = (await navigator.credentials.create({
      publicKey: publicKeyOptions,
      signal: abort.signal,
    })) as PublicKeyCredential | null;
  } catch (err) {
    clearTimeout(timer);
    if (
      err instanceof DOMException &&
      (err.name === "AbortError" || err.name === "NotAllowedError")
    ) {
      throw new Error("REGISTRATION_CANCELLED");
    }
    if (err instanceof DOMException && err.name === "OperationError") {
      throw new Error("REGISTRATION_PENDING");
    }
    if (err instanceof DOMException && err.name === "InvalidStateError") {
      throw new Error("CREDENTIAL_ALREADY_REGISTERED");
    }
    throw err;
  }
  clearTimeout(timer);

  if (!credential) throw new Error("REGISTRATION_CANCELLED");

  // Extract PRF output from extension results
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const extResults = credential.getClientExtensionResults() as any;
  const prfResults = extResults?.prf?.results;
  const prfOutput = prfResults?.first
    ? new Uint8Array(prfResults.first as ArrayBuffer)
    : null;

  const responseJSON = credentialToRegistrationJSON(credential);

  return { responseJSON, prfOutput };
}

// ─── Authentication ────────────────────────────────────────

export interface PasskeyAuthenticationResult {
  responseJSON: Record<string, unknown>;
  prfOutput: Uint8Array | null;
}

export async function startPasskeyAuthentication(
  optionsJSON: Record<string, unknown>,
  prfSalt?: string, // hex — omit for sign-in without PRF
): Promise<PasskeyAuthenticationResult> {
  const publicKeyOptions = toRequestOptions(optionsJSON);

  if (prfSalt) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (publicKeyOptions as any).extensions = {
      ...publicKeyOptions.extensions,
      prf: { eval: { first: toArrayBuffer(hexDecode(prfSalt)) } },
    };
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 120_000);

  let credential: PublicKeyCredential | null;
  try {
    credential = (await navigator.credentials.get({
      publicKey: publicKeyOptions,
      signal: abort.signal,
    })) as PublicKeyCredential | null;
  } catch (err) {
    clearTimeout(timer);
    if (
      err instanceof DOMException &&
      (err.name === "AbortError" || err.name === "NotAllowedError")
    ) {
      throw new Error("AUTHENTICATION_CANCELLED");
    }
    if (err instanceof DOMException && err.name === "OperationError") {
      throw new Error("AUTHENTICATION_PENDING");
    }
    throw err;
  }
  clearTimeout(timer);

  if (!credential) throw new Error("AUTHENTICATION_CANCELLED");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const extResults = credential.getClientExtensionResults() as any;
  const prfResults = extResults?.prf?.results;
  const prfOutput = prfResults?.first
    ? new Uint8Array(prfResults.first as ArrayBuffer)
    : null;

  const responseJSON = credentialToAuthenticationJSON(credential);

  return { responseJSON, prfOutput };
}

// ─── Feature detection ─────────────────────────────────────

export function isWebAuthnSupported(): boolean {
  return typeof window !== "undefined" && !!window.PublicKeyCredential;
}

// ─── Default nickname generation ────────────────────────────

function detectOS(): string {
  const ua = navigator.userAgent;
  if (ua.includes("iPhone") || ua.includes("iPad")) return "iOS";
  if (ua.includes("Mac OS X") || ua.includes("Macintosh")) return "macOS";
  if (ua.includes("CrOS")) return "ChromeOS";
  if (ua.includes("Android")) return "Android";
  if (ua.includes("Windows")) return "Windows";
  if (ua.includes("Linux")) return "Linux";
  return "Unknown OS";
}

function detectBrowser(): string {
  const ua = navigator.userAgent;
  if (ua.includes("Edg/")) return "Edge";
  if (ua.includes("OPR/") || ua.includes("Opera")) return "Opera";
  if (ua.includes("Firefox/")) return "Firefox";
  if (ua.includes("Chrome/")) return "Chrome";
  if (ua.includes("Safari/")) return "Safari";
  return "Browser";
}

/**
 * Generate a human-readable default nickname from transports + UA.
 *
 *   Platform authenticator → "macOS (Chrome)"
 *   Security key           → "Security Key (USB, NFC)"
 *   Hybrid / external      → "External Device"
 */
export function generateDefaultNickname(transports: string[]): string {
  const isInternal = transports.includes("internal");
  const isUsb = transports.includes("usb");
  const isNfc = transports.includes("nfc");
  const isBle = transports.includes("ble");
  const isHybrid = transports.includes("hybrid");

  if (isInternal) {
    return `${detectOS()} (${detectBrowser()})`;
  }

  if (isUsb || isNfc || isBle) {
    const methods: string[] = [];
    if (isUsb) methods.push("USB");
    if (isNfc) methods.push("NFC");
    if (isBle) methods.push("BLE");
    return `Security Key (${methods.join(", ")})`;
  }

  if (isHybrid) {
    return "External Device";
  }

  return `${detectOS()} (${detectBrowser()})`;
}
