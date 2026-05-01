import { createHmac, createPrivateKey, createPublicKey, sign as nodeSign, verify as nodeVerify } from "node:crypto";
import { z } from "zod/v4";
import {
  AUDIT_ANCHOR_TYP,
  AUDIT_ANCHOR_TAG_DOMAIN,
  AUDIT_ANCHOR_KID_PREFIX,
} from "@/lib/constants/audit/audit";
import { jcsCanonical } from "@/lib/audit/audit-chain";

// --- Public types ---

export type Manifest = {
  $schema: string;
  version: 1;
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
};

// --- Typed errors ---

export class InvalidAlgorithmError extends Error {
  constructor(alg: unknown) {
    super(`Invalid JWS alg: ${alg}; expected EdDSA`);
    this.name = "InvalidAlgorithmError";
  }
}

export class InvalidTypError extends Error {
  constructor(typ: unknown) {
    super(`Invalid JWS typ: ${typ}; expected ${AUDIT_ANCHOR_TYP}`);
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
      `Invalid kid format: got ${JSON.stringify(kid)}; expected ${AUDIT_ANCHOR_KID_PREFIX}<8-32 chars [a-zA-Z0-9_-]>`,
    );
    this.name = "InvalidKidError";
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

const manifestSchema = z.object({
  $schema: z.string(),
  version: z.literal(1),
  issuer: z.literal("passwd-sso"),
  deploymentId: z.string(),
  anchoredAt: z.string(),
  previousManifest: z
    .object({ uri: z.string(), sha256: z.string() })
    .nullable(),
  tenants: z.array(tenantEntrySchema),
});

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
 * Build a Manifest object from AnchorRows and metadata.
 * Validates each tenantId and the resulting manifest via Zod.
 */
export function buildManifest(input: BuildManifestInput): Manifest {
  for (const row of input.tenants) {
    validateTenantIdCanonical(row.tenantId);
  }

  const raw = {
    $schema: "https://passwd-sso.example/schemas/audit-anchor-manifest-v1.json",
    version: 1 as const,
    issuer: "passwd-sso" as const,
    deploymentId: input.deploymentId,
    anchoredAt: input.anchoredAt.toISOString(),
    previousManifest: input.previousManifest,
    tenants: input.tenants.map((row) => ({
      tenantTag: computeTenantTag(row.tenantId, input.tagSecret),
      chainSeq: row.chainSeq.toString(),
      prevHash: row.prevHash.toString("hex"),
      epoch: row.epoch,
    })),
  };

  return validateManifest(raw);
}

/**
 * Produce JCS-canonical UTF-8 bytes from a Manifest.
 * Reuses jcsCanonical from audit-chain (single source of truth).
 */
export function canonicalize(manifest: Manifest): Buffer {
  return Buffer.from(jcsCanonical(manifest), "utf-8");
}

/**
 * Sign canonical manifest bytes with an Ed25519 private key seed (32 bytes).
 * Returns JWS compact serialization (RFC 7515).
 */
export function sign(canonicalBytes: Buffer, signingKey: Buffer, kid: string): string {
  const kidPattern = new RegExp(`^${AUDIT_ANCHOR_KID_PREFIX}[a-zA-Z0-9_-]{8,32}$`);
  if (!kidPattern.test(kid)) {
    throw new InvalidKidError(kid);
  }

  // Property order is intentional: alg, kid, typ (do not reorder)
  const headerObj = { alg: "EdDSA", kid, typ: AUDIT_ANCHOR_TYP };
  const headerB64 = b64urlEncode(Buffer.from(JSON.stringify(headerObj), "utf-8"));
  const payloadB64 = b64urlEncode(canonicalBytes);
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, "utf-8");

  const keyObject = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, signingKey]),
    format: "der",
    type: "pkcs8",
  });

  const sig = nodeSign(null, signingInput, keyObject);
  const sigB64 = b64urlEncode(sig);

  return `${headerB64}.${payloadB64}.${sigB64}`;
}

/**
 * Verify a JWS compact serialization and return the decoded Manifest.
 * Throws typed errors on any verification failure.
 */
export function verify(jws: string, publicKey: Buffer): Manifest {
  const parts = jws.split(".");
  if (parts.length !== 3) throw new InvalidSignatureError();
  const [headerB64, payloadB64, sigB64] = parts;

  let header: Record<string, unknown>;
  try {
    header = JSON.parse(b64urlDecode(headerB64).toString("utf-8")) as Record<string, unknown>;
  } catch {
    throw new InvalidSignatureError();
  }

  if (header.alg !== "EdDSA") throw new InvalidAlgorithmError(header.alg);
  if (header.typ !== AUDIT_ANCHOR_TYP) throw new InvalidTypError(header.typ);

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

  let payloadObj: unknown;
  try {
    payloadObj = JSON.parse(b64urlDecode(payloadB64).toString("utf-8"));
  } catch {
    throw new InvalidSignatureError();
  }

  const manifest = validateManifest(payloadObj);

  // Re-canonicalize and compare to detect payload modifications that bypass signer canonicalization
  const recanon = canonicalize(manifest);
  const payloadBytes = b64urlDecode(payloadB64);
  if (!recanon.equals(payloadBytes)) {
    throw new InvalidSignatureError();
  }

  return manifest;
}
