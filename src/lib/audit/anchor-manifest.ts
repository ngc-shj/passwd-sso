import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  sign as nodeSign,
  verify as nodeVerify,
  type KeyObject,
} from "node:crypto";
import { z } from "zod/v4";
import {
  AUDIT_ANCHOR_TYP,
  AUDIT_ANCHOR_STATEMENT_TYP,
  AUDIT_ANCHOR_TAG_DOMAIN,
  AUDIT_ANCHOR_CHAIN_LOCATION_DOMAIN,
  AUDIT_ANCHOR_MANIFEST_VERSION,
  AUDIT_ANCHOR_KID_PREFIX,
  AUDIT_ANCHOR_KID_HEX_CHARS,
} from "@/lib/constants/audit/audit";
import { jcsCanonical } from "@/lib/audit/audit-chain";
import { isAnchorKid } from "@/lib/audit/anchor-artifact-keys";

// --- Public types ---

type ManifestBody = {
  $schema: string;
  issuer: "passwd-sso";
  deploymentId: string;
  anchoredAt: string;
  previousManifest: { uri: string; sha256: string } | null;
  tenants: Array<{
    tenantTag: string;
    chainSeq: string;
    prevHash: string;
    epoch: number;
  }>;
};

/** Written by earlier releases: bound to no location. Still verified, never written. */
export type ManifestV1 = ManifestBody & { version: 1 };

/** `chainLocation` is `chainLocationFor` of the primary destination it was published to. */
export type ManifestV2 = ManifestBody & { version: 2; chainLocation: string };

export type Manifest = ManifestV1 | ManifestV2;

export type AnchorRow = {
  tenantId: string;
  chainSeq: bigint;
  prevHash: Buffer;
  epoch: number;
};

export type BuildManifestInput = {
  tenants: AnchorRow[];
  deploymentId: string;
  anchoredAt: Date;
  previousManifest: { uri: string; sha256: string } | null;
  tagSecret: Buffer;
  /** The primary destination's `location`. */
  location: string;
};

// --- Typed errors ---

export class InvalidAlgorithmError extends Error {
  constructor(alg: unknown) {
    super(`Invalid JWS alg: ${JSON.stringify(alg)}; expected EdDSA`);
    this.name = "InvalidAlgorithmError";
  }
}

export class InvalidTypError extends Error {
  constructor(typ: unknown, expected: string = AUDIT_ANCHOR_TYP) {
    super(`Invalid JWS typ: ${JSON.stringify(typ)}; expected ${expected}`);
    this.name = "InvalidTypError";
  }
}

export class InvalidSignatureError extends Error {
  constructor() {
    super("JWS signature verification failed");
    this.name = "InvalidSignatureError";
  }
}

export class InvalidTenantIdFormatError extends Error {
  constructor(tenantId: unknown) {
    super(
      `Invalid tenantId format; expected canonical lower-case UUID (RFC 4122 §3): got ${tenantId}`,
    );
    this.name = "InvalidTenantIdFormatError";
  }
}

export class InvalidKidError extends Error {
  constructor(kid: unknown) {
    super(
      `Invalid kid format: got ${JSON.stringify(kid)}; expected ${AUDIT_ANCHOR_KID_PREFIX}<${AUDIT_ANCHOR_KID_HEX_CHARS} lower-case hex chars>`,
    );
    this.name = "InvalidKidError";
  }
}

/** The header names a key other than the one the signature was checked under. */
export class KidMismatchError extends Error {
  constructor(headerKid: string, keyKid: string) {
    super(`JWS kid ${headerKid} does not name the supplied public key (${keyKid})`);
    this.name = "KidMismatchError";
  }
}

export class InvalidPublicKeyError extends Error {
  constructor() {
    super("Invalid Ed25519 public key; expected 64 lower-case hex chars (32 bytes)");
    this.name = "InvalidPublicKeyError";
  }
}

export class ManifestSchemaValidationError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "ManifestSchemaValidationError";
  }
}

// --- Zod schema for Manifest validation ---

const tenantEntrySchema = z.object({
  tenantTag: z.string().regex(/^[0-9a-f]{64}$/),
  chainSeq: z.string().regex(/^(0|[1-9][0-9]*)$/),
  prevHash: z.string().regex(/^([0-9a-f]{64}|[0-9a-f]{2})$/),
  epoch: z.number().int().min(1),
});

/** `value` is exactly what `Date.prototype.toISOString` writes for its instant. */
function isIsoTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

const manifestBodyShape = {
  $schema: z.string(),
  issuer: z.literal("passwd-sso"),
  deploymentId: z.string(),
  anchoredAt: z.string().refine(isIsoTimestamp),
  previousManifest: z
    .object({ uri: z.string(), sha256: z.string() })
    .nullable(),
  tenants: z.array(tenantEntrySchema),
};

// A version 1 payload that carries a chainLocation parses without it, and
// `verify` then refuses it: the payload is not the canonical form of what
// was parsed.
const manifestSchema = z.discriminatedUnion("version", [
  z.object({ ...manifestBodyShape, version: z.literal(1) }),
  z.object({
    ...manifestBodyShape,
    version: z.literal(AUDIT_ANCHOR_MANIFEST_VERSION),
    chainLocation: z.string().regex(/^[0-9a-f]{64}$/),
  }),
]);

function validateManifest(value: unknown): Manifest {
  const result = manifestSchema.safeParse(value);
  if (!result.success) {
    const detail = JSON.stringify(z.treeifyError(result.error));
    throw new ManifestSchemaValidationError(detail);
  }
  return result.data as Manifest;
}

// --- Base64url helpers ---

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function b64urlDecode(str: string): Buffer {
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

// --- PKCS8 / SPKI DER prefixes for Ed25519 ---

// PKCS8 private key prefix for Ed25519 (RFC 8410)
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
// SubjectPublicKeyInfo prefix for Ed25519 (RFC 8410)
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

// --- Public functions ---

/**
 * Derive the public key of an asymmetric private key.
 *
 * `createPublicKey(privateKeyObject)` is a documented Node API, but
 * @types/node 26 dropped the `KeyObject` overload from `createPublicKey`
 * (only KeyInput shapes remain in the typings). Re-narrow the runtime-valid
 * call in one place instead of casting at every call site.
 */
export function derivePublicKey(privateKey: KeyObject): KeyObject {
  const createFromKeyObject = createPublicKey as unknown as (key: KeyObject) => KeyObject;
  return createFromKeyObject(privateKey);
}

/**
 * Validates that tenantId is canonical lower-case UUID (RFC 4122 §3).
 * NO automatic lowercasing — uppercase input MUST throw.
 */
export function validateTenantIdCanonical(tenantId: string): void {
  const canonical = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (!canonical.test(tenantId)) {
    throw new InvalidTenantIdFormatError(tenantId);
  }
}

/**
 * Compute an HMAC-SHA256 tenant tag from tenantId and tagSecret.
 * Domain separated with AUDIT_ANCHOR_TAG_DOMAIN + null byte.
 */
export function computeTenantTag(tenantId: string, tagSecret: Buffer): string {
  validateTenantIdCanonical(tenantId);
  if (Buffer.byteLength(tagSecret) !== 32) {
    throw new Error("tagSecret must be exactly 32 bytes");
  }
  const input = Buffer.concat([
    Buffer.from(AUDIT_ANCHOR_TAG_DOMAIN, "utf-8"),
    Buffer.from([0x00]),
    Buffer.from(tenantId, "utf-8"),
  ]);
  return createHmac("sha256", tagSecret).update(input).digest("hex");
}

/**
 * What a manifest carries as `chainLocation`: the SHA-256 of a destination's
 * `location`, domain separated with AUDIT_ANCHOR_CHAIN_LOCATION_DOMAIN + null
 * byte. A hash, so the manifest names no bucket, repository or path.
 */
export function chainLocationFor(location: string): string {
  return createHash("sha256")
    .update(AUDIT_ANCHOR_CHAIN_LOCATION_DOMAIN, "utf-8")
    .update(Buffer.from([0x00]))
    .update(location, "utf-8")
    .digest("hex");
}

/**
 * Build a Manifest object from AnchorRows and metadata.
 * Validates each tenantId and the resulting manifest via Zod.
 */
export function buildManifest(input: BuildManifestInput): ManifestV2 {
  for (const row of input.tenants) {
    validateTenantIdCanonical(row.tenantId);
  }

  const raw = {
    $schema: `https://passwd-sso.example/schemas/audit-anchor-manifest-v${AUDIT_ANCHOR_MANIFEST_VERSION}.json`,
    version: AUDIT_ANCHOR_MANIFEST_VERSION,
    issuer: "passwd-sso" as const,
    deploymentId: input.deploymentId,
    anchoredAt: input.anchoredAt.toISOString(),
    chainLocation: chainLocationFor(input.location),
    previousManifest: input.previousManifest,
    tenants: input.tenants.map((row) => ({
      tenantTag: computeTenantTag(row.tenantId, input.tagSecret),
      chainSeq: row.chainSeq.toString(),
      prevHash: row.prevHash.toString("hex"),
      epoch: row.epoch,
    })),
  };

  return validateManifest(raw) as ManifestV2;
}

/**
 * Produce JCS-canonical UTF-8 bytes from a Manifest.
 * Reuses jcsCanonical from audit-chain (single source of truth).
 */
export function canonicalize(manifest: Manifest): Buffer {
  return Buffer.from(jcsCanonical(manifest), "utf-8");
}

const ED25519_KEY_BYTES = 32;
const KID_KEY_BYTES = AUDIT_ANCHOR_KID_HEX_CHARS / 2;

function privateKeyObject(signingKey: Buffer): KeyObject {
  if (signingKey.length !== ED25519_KEY_BYTES) {
    throw new Error("signing key must be exactly 32 bytes");
  }
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, signingKey]),
    format: "der",
    type: "pkcs8",
  });
}

/**
 * The kid of a raw Ed25519 public key: the prefix plus its first 8 bytes in
 * hex. A 64-bit identifier of the key, not a commitment to it.
 */
export function kidForPublicKey(publicKey: Buffer): string {
  if (publicKey.length !== ED25519_KEY_BYTES) throw new InvalidPublicKeyError();
  return `${AUDIT_ANCHOR_KID_PREFIX}${publicKey.subarray(0, KID_KEY_BYTES).toString("hex")}`;
}

/** The raw 32-byte public key of an Ed25519 private key seed (32 bytes). */
export function publicKeyForSigningKey(seed: Buffer): Buffer {
  const spki = derivePublicKey(privateKeyObject(seed)).export({ format: "der", type: "spki" });
  return Buffer.from(spki.subarray(ED25519_SPKI_PREFIX.length));
}

/**
 * A raw public key from its archived text: exactly 64 lower-case hex chars
 * once surrounding whitespace is trimmed. `Buffer.from(text, "hex")` is not
 * used alone: it stops at the first non-hex char and returns what it had.
 */
export function parsePublicKeyHex(text: string): Buffer {
  const hex = text.trim();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new InvalidPublicKeyError();
  return Buffer.from(hex, "hex");
}

function decodeHeader(headerB64: string): Record<string, unknown> {
  let header: unknown;
  try {
    header = JSON.parse(b64urlDecode(headerB64).toString("utf-8"));
  } catch {
    throw new InvalidSignatureError();
  }
  if (typeof header !== "object" || header === null) throw new InvalidSignatureError();
  return header as Record<string, unknown>;
}

/**
 * The `kid` a JWS header names, unverified. Throws InvalidKidError unless it
 * is the derivable shape, InvalidSignatureError when there is no header to read.
 */
export function readJwsKid(jws: string): string {
  const parts = jws.split(".");
  if (parts.length !== 3) throw new InvalidSignatureError();
  const { kid } = decodeHeader(parts[0]);
  if (!isAnchorKid(kid)) throw new InvalidKidError(kid);
  return kid;
}

function signCompact(payload: Buffer, signingKey: Buffer, typ: string): string {
  const keyObject = privateKeyObject(signingKey);
  const kid = kidForPublicKey(publicKeyForSigningKey(signingKey));

  // Property order is intentional: alg, kid, typ (do not reorder)
  const headerObj = { alg: "EdDSA", kid, typ };
  const headerB64 = b64urlEncode(Buffer.from(JSON.stringify(headerObj), "utf-8"));
  const payloadB64 = b64urlEncode(payload);
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, "utf-8");

  const sig = nodeSign(null, signingInput, keyObject);
  const sigB64 = b64urlEncode(sig);

  return `${headerB64}.${payloadB64}.${sigB64}`;
}

/**
 * Check a JWS compact serialization under `publicKey` and return its payload
 * bytes. The header's kid must name that key: a signature is accepted only
 * under the key its kid names, and the kid is checked before the signature.
 */
function verifyCompact(jws: string, publicKey: Buffer, typ: string): Buffer {
  const parts = jws.split(".");
  if (parts.length !== 3) throw new InvalidSignatureError();
  const [headerB64, payloadB64, sigB64] = parts;

  const header = decodeHeader(headerB64);

  if (header.alg !== "EdDSA") throw new InvalidAlgorithmError(header.alg);
  if (header.typ !== typ) throw new InvalidTypError(header.typ, typ);
  if (!isAnchorKid(header.kid)) throw new InvalidKidError(header.kid);
  const keyKid = kidForPublicKey(publicKey);
  if (header.kid !== keyKid) throw new KidMismatchError(header.kid, keyKid);

  const keyObject = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey]),
    format: "der",
    type: "spki",
  });

  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, "utf-8");
  const sigBytes = b64urlDecode(sigB64);

  if (!nodeVerify(null, signingInput, keyObject, sigBytes)) {
    throw new InvalidSignatureError();
  }

  return b64urlDecode(payloadB64);
}

/**
 * Sign canonical manifest bytes with an Ed25519 private key seed (32 bytes).
 * Returns JWS compact serialization (RFC 7515); the kid is the signing key's own.
 */
export function sign(canonicalBytes: Buffer, signingKey: Buffer): string {
  return signCompact(canonicalBytes, signingKey, AUDIT_ANCHOR_TYP);
}

/**
 * Sign an operator statement (key rotation, chain restart). Its typ is not a
 * manifest's, so `verify` rejects it with InvalidTypError.
 */
export function signStatement(payload: Buffer, signingKey: Buffer): string {
  return signCompact(payload, signingKey, AUDIT_ANCHOR_STATEMENT_TYP);
}

/** Verify an operator statement and return its payload bytes. */
export function verifyStatement(jws: string, publicKey: Buffer): Buffer {
  return verifyCompact(jws, publicKey, AUDIT_ANCHOR_STATEMENT_TYP);
}

/**
 * Verify a JWS compact serialization and return the decoded Manifest.
 * Throws typed errors on any verification failure; KidMismatchError when the
 * header's kid is not `kidForPublicKey(publicKey)`.
 */
export function verify(jws: string, publicKey: Buffer): Manifest {
  const payloadBytes = verifyCompact(jws, publicKey, AUDIT_ANCHOR_TYP);

  let payloadObj: unknown;
  try {
    payloadObj = JSON.parse(payloadBytes.toString("utf-8"));
  } catch {
    throw new InvalidSignatureError();
  }

  const manifest = validateManifest(payloadObj);

  // Re-canonicalize and compare to detect payload modifications that bypass signer canonicalization
  const recanon = canonicalize(manifest);
  if (!recanon.equals(payloadBytes)) {
    throw new InvalidSignatureError();
  }

  return manifest;
}
