import { createHash } from "node:crypto";

/**
 * Minimal JCS (RFC 8785) canonicalization.
 * Recursively sorts object keys and serializes to JSON.
 * Handles: objects, arrays, strings, numbers, booleans, null.
 * Does not handle: BigInt, undefined, symbols, functions (throws).
 */
export function jcsCanonical(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!isFinite(value)) throw new Error("JCS: non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((v) => jcsCanonical(v)).join(",") + "]";
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const entries = keys.map((k) => {
      const v = (value as Record<string, unknown>)[k];
      if (v === undefined) return null;
      return JSON.stringify(k) + ":" + jcsCanonical(v);
    }).filter((e) => e !== null);
    return "{" + entries.join(",") + "}";
  }
  throw new Error(`JCS: unsupported type ${typeof value}`);
}

/**
 * Fields included in the canonical representation for hash chain computation.
 */
export interface ChainInput {
  /** audit_logs row ID (UUID) */
  id: string;
  /** Business-event time from the outbox row (ISO 8601 UTC with Z suffix) */
  createdAt: string;
  /** Chain sequence number (serialized as string for JCS precision) */
  chainSeq: string;
  /** Previous hash in the chain (hex-encoded) */
  prevHash: string;
  /** The audit event payload (already sanitized) */
  payload: Record<string, unknown>;
}

/**
 * Build a ChainInput from audit log fields.
 * Normalizes created_at to UTC ISO 8601 with Z suffix.
 * Serializes chainSeq as a string to avoid IEEE 754 precision loss.
 */
export function buildChainInput(fields: {
  id: string;
  createdAt: Date;
  chainSeq: bigint;
  prevHash: Buffer;
  payload: Record<string, unknown>;
}): ChainInput {
  return {
    id: fields.id,
    createdAt: fields.createdAt.toISOString(),
    chainSeq: fields.chainSeq.toString(),
    prevHash: fields.prevHash.toString("hex"),
    payload: fields.payload,
  };
}

/**
 * Compute the canonical byte representation of a ChainInput using JCS (RFC 8785).
 */
export function computeCanonicalBytes(input: ChainInput): Buffer {
  const canonical = jcsCanonical(input);
  return Buffer.from(canonical, "utf-8");
}

/**
 * Compute the event hash: SHA-256(prevHash || canonicalBytes).
 * @param prevHash - The previous hash in the chain (raw bytes, 1 byte for genesis \x00, 32 bytes otherwise)
 * @param canonicalBytes - The JCS-canonical representation of the event
 * @returns 32-byte SHA-256 hash as Buffer
 */
export function computeEventHash(
  prevHash: Buffer,
  canonicalBytes: Buffer,
): Buffer {
  const hash = createHash("sha256");
  hash.update(prevHash);
  hash.update(canonicalBytes);
  return hash.digest();
}
