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

import { hexDecode, hexEncode, toArrayBuffer } from "../../crypto/crypto-utils";
import { MS_PER_MINUTE } from "@/lib/constants/time";
export { hexEncode };

// ─── Wire types ────────────────────────────────────────────
//
// These describe JSON that arrived from the server, NOT values the browser
// produced — so they are deliberately not the lib.dom types. The critical
// difference: PRF salts cross this wire as HEX STRINGS, whereas
// `AuthenticationExtensionsPRFValues.first` is a `BufferSource`. The hex →
// ArrayBuffer conversion happens at exactly one place (buildPrfExtension
// below); nothing may straddle both sides.

type PrfValuesWire = { first: string; second?: string };

type PrfInputsWire = {
  eval?: PrfValuesWire;
  evalByCredential?: Record<string, PrfValuesWire>;
};

type ExtensionsWire = { prf?: PrfInputsWire } & Record<string, unknown>;

type CredentialDescriptorWire = {
  id: string;
  type: PublicKeyCredentialType;
  transports?: AuthenticatorTransport[];
};

type CreationOptionsWire = {
  rp: PublicKeyCredentialRpEntity;
  user: { id: string; name: string; displayName: string };
  challenge: string;
  pubKeyCredParams: PublicKeyCredentialParameters[];
  timeout?: number;
  excludeCredentials?: CredentialDescriptorWire[];
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  attestation?: AttestationConveyancePreference;
  extensions?: ExtensionsWire;
};

type RequestOptionsWire = {
  challenge: string;
  timeout?: number;
  rpId?: string;
  allowCredentials?: CredentialDescriptorWire[];
  userVerification?: UserVerificationRequirement;
  extensions?: ExtensionsWire;
};

// Narrowing readers. `challenge` is the only field required on both paths —
// everything else is optional, matching what callers actually send. A missing
// challenge previously produced `undefined.replace` deep inside
// base64urlDecode; failing here names the problem instead.
function asCreationOptionsWire(json: Record<string, unknown>): CreationOptionsWire {
  if (typeof json.challenge !== "string") {
    throw new Error("WEBAUTHN_OPTIONS_MALFORMED: challenge must be a string");
  }
  if (typeof json.user !== "object" || json.user === null) {
    throw new Error("WEBAUTHN_OPTIONS_MALFORMED: user must be an object");
  }
  return json as CreationOptionsWire;
}

function asRequestOptionsWire(json: Record<string, unknown>): RequestOptionsWire {
  if (typeof json.challenge !== "string") {
    throw new Error("WEBAUTHN_OPTIONS_MALFORMED: challenge must be a string");
  }
  return json as RequestOptionsWire;
}

// ─── Option conversion ─────────────────────────────────────

function toCredentialDescriptors(
  list: CredentialDescriptorWire[] | undefined,
): PublicKeyCredentialDescriptor[] | undefined {
  return list?.map((c) => ({
    id: toArrayBuffer(base64urlDecode(c.id)),
    type: c.type,
    transports: c.transports,
  }));
}

function toCreationOptions(
  json: CreationOptionsWire,
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
    excludeCredentials: toCredentialDescriptors(json.excludeCredentials),
    authenticatorSelection: json.authenticatorSelection,
    attestation: json.attestation,
    // Forward every extension EXCEPT prf. Only prf carries hex strings that the
    // DOM type would mis-describe; the rest (credProps, minPinLength,
    // largeBlob) are plain booleans/enums that the server sends on registration
    // and the browser must actually receive. Dropping them compiles and keeps
    // every server-side guard intact, yet silently nulls three columns and
    // starves the tenant requireMinPinLength policy of its input.
    extensions: toDomExtensions(json.extensions),
  };
}

/**
 * Strip `prf` (hex-string wire form) and pass the remaining extensions through
 * as DOM types. Returns undefined when nothing is left, so the property is
 * omitted rather than set to an empty object.
 */
function toDomExtensions(
  wire: ExtensionsWire | undefined,
): AuthenticationExtensionsClientInputs | undefined {
  if (!wire) return undefined;
  const { prf: _prf, ...rest } = wire;
  return Object.keys(rest).length > 0
    ? (rest as AuthenticationExtensionsClientInputs)
    : undefined;
}

function toRequestOptions(
  json: RequestOptionsWire,
): PublicKeyCredentialRequestOptions {
  return {
    challenge: toArrayBuffer(base64urlDecode(json.challenge)),
    timeout: json.timeout,
    rpId: json.rpId,
    allowCredentials: toCredentialDescriptors(json.allowCredentials),
    userVerification: json.userVerification,
    // Same rule as the creation path: forward all non-prf extensions. Today the
    // auth routes only ever send prf, so this keeps the converter structurally
    // safe rather than incidentally safe — a future auth-side extension will
    // not be silently dropped.
    extensions: toDomExtensions(json.extensions),
  };
}

/** Convert a wire PRF input (hex strings) into the browser's BufferSource form. */
function toPrfExtension(wire: PrfInputsWire): AuthenticationExtensionsPRFInputs {
  return {
    ...(wire.eval
      ? { eval: { first: toArrayBuffer(hexDecode(wire.eval.first)) } }
      : {}),
    ...(wire.evalByCredential
      ? {
          evalByCredential: Object.fromEntries(
            Object.entries(wire.evalByCredential).map(([credId, value]) => [
              credId,
              { first: toArrayBuffer(hexDecode(value.first)) },
            ]),
          ),
        }
      : {}),
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

// ─── In-flight ceremony guard ──────────────────────────────
//
// Chrome (and other browsers) service only ONE WebAuthn ceremony — create()
// OR get() — at a time. A second modal request issued while a prior one is
// still pending is silently dropped: no OS prompt appears and the call hangs
// until the stale request resolves or its 120s abort fires. This strands the
// user on a spinner with no dialog. It happens when a ceremony is left pending
// after the user navigates away (SPA route change) or retries before the first
// request settled.
//
// Track the active controller so a new ceremony aborts a stale one, and expose
// `abortInFlightCeremony` for component unmount cleanup.
let inFlightCeremonyAbort: AbortController | null = null;

const CEREMONY_TIMEOUT_MS = 2 * MS_PER_MINUTE;

/**
 * Start a WebAuthn ceremony: abort any prior in-flight request, then register
 * and return a fresh AbortController with an auto-abort safety timer. Always
 * pair with {@link endCeremony} (in both the success and error paths) so the
 * timer is cleared and the registration is released.
 */
function beginCeremony(): { abort: AbortController; timer: ReturnType<typeof setTimeout> } {
  // Cancel a stale ceremony so this one can surface its prompt.
  inFlightCeremonyAbort?.abort();
  const abort = new AbortController();
  inFlightCeremonyAbort = abort;
  const timer = setTimeout(() => abort.abort(), CEREMONY_TIMEOUT_MS);
  return { abort, timer };
}

function endCeremony(abort: AbortController, timer: ReturnType<typeof setTimeout>): void {
  clearTimeout(timer);
  if (inFlightCeremonyAbort === abort) inFlightCeremonyAbort = null;
}

/**
 * Abort any in-flight passkey ceremony. Call from component unmount cleanup so
 * a request left pending after navigation cannot silently block the next
 * modal prompt.
 */
export function abortInFlightCeremony(): void {
  inFlightCeremonyAbort?.abort();
  inFlightCeremonyAbort = null;
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
  const wire = asCreationOptionsWire(optionsJSON);
  const publicKeyOptions = toCreationOptions(wire);

  if (prfSalt) {
    publicKeyOptions.extensions = {
      ...publicKeyOptions.extensions,
      prf: { eval: { first: toArrayBuffer(hexDecode(prfSalt)) } },
    };
  }

  const { abort, timer } = beginCeremony();

  let credential: PublicKeyCredential | null;
  try {
    credential = (await navigator.credentials.create({
      publicKey: publicKeyOptions,
      signal: abort.signal,
    })) as PublicKeyCredential | null;
  } catch (err) {
    endCeremony(abort, timer);
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
  endCeremony(abort, timer);

  if (!credential) throw new Error("REGISTRATION_CANCELLED");

  // Extract PRF output from extension results
  const extResults = credential.getClientExtensionResults();
  const prfResults = extResults.prf?.results;
  // Cast retained deliberately: `first` is typed BufferSource, and the uncast
  // form does not compile (TS2769). Keeping it emits byte-identical JS and
  // avoids introducing an ArrayBuffer/ArrayBufferView branch that no test —
  // and per VC1 no CI test ever could — would exercise.
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
  prfSalt?: string, // hex — top-level eval (legacy or mixed v1 fallback)
  evalByCredential?: Record<string, string>, // credId base64url → salt hex (A02-8)
): Promise<PasskeyAuthenticationResult> {
  const wire = asRequestOptionsWire(optionsJSON);
  const publicKeyOptions = toRequestOptions(wire);

  // A02-8: PRF extension input may arrive via three channels (in priority order):
  //   1. Server-built `optionsJSON.extensions.prf` — pass through verbatim
  //      (preferred). The server already encoded the salts as hex strings.
  //   2. `evalByCredential` parameter — client-side construction for callers
  //      that don't get server-built extensions yet.
  //   3. `prfSalt` parameter — legacy top-level eval (single-credential path
  //      or v1 RP-global fallback).
  // Channel (1) is mutually exclusive with (2)/(3). Channels (2) and (3) can
  // coexist and produce { eval, evalByCredential } simultaneously.
  // Read off the WIRE type (hex strings), not the DOM type. Mis-typing this as
  // AuthenticationExtensionsClientInputs makes the read resolve to undefined,
  // which silently drops control into the client-salt branch below — a
  // downgrade of the server-bound salt that governs the vault wrapping key.
  const serverPrfExt = wire.extensions?.prf;

  const extensions: AuthenticationExtensionsClientInputs = {
    ...publicKeyOptions.extensions,
  };

  if (serverPrfExt) {
    extensions.prf = toPrfExtension(serverPrfExt);
  } else if (prfSalt || evalByCredential) {
    extensions.prf = toPrfExtension({
      ...(prfSalt ? { eval: { first: prfSalt } } : {}),
      ...(evalByCredential
        ? {
            evalByCredential: Object.fromEntries(
              Object.entries(evalByCredential).map(([credId, salt]) => [
                credId,
                { first: salt },
              ]),
            ),
          }
        : {}),
    });
  }

  if (extensions.prf || Object.keys(extensions).length > 0) {
    publicKeyOptions.extensions = extensions;
  }

  const { abort, timer } = beginCeremony();

  let credential: PublicKeyCredential | null;
  try {
    credential = (await navigator.credentials.get({
      publicKey: publicKeyOptions,
      signal: abort.signal,
    })) as PublicKeyCredential | null;
  } catch (err) {
    endCeremony(abort, timer);
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
  endCeremony(abort, timer);

  if (!credential) throw new Error("AUTHENTICATION_CANCELLED");

  const extResults = credential.getClientExtensionResults();
  const prfResults = extResults.prf?.results;
  // Cast retained deliberately: `first` is typed BufferSource, and the uncast
  // form does not compile (TS2769). Keeping it emits byte-identical JS and
  // avoids introducing an ArrayBuffer/ArrayBufferView branch that no test —
  // and per VC1 no CI test ever could — would exercise.
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
