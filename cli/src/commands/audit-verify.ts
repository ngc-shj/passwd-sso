/**
 * `passwd-sso audit-verify` — Verify an audit anchor manifest JWS.
 *
 * Validates the EdDSA signature, optionally checks tenant coverage,
 * and optionally checks chain-sequence regression against a prior manifest.
 */

import { readFileSync, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { createHash, createHmac, createPublicKey, verify as nodeVerify } from "node:crypto";
import { z } from "zod";
import {
  AUDIT_ANCHOR_KID_HEX_CHARS,
  AUDIT_ANCHOR_KID_PREFIX,
  AUDIT_ANCHOR_TYP,
} from "../constants/audit-anchor.js";

// --- Constants ---

const AUDIT_ANCHOR_TAG_DOMAIN = "audit-anchor-tag-v1";

// --- Typed errors ---

export class InvalidAlgorithmError extends Error {
  constructor(alg: unknown) {
    super(`Invalid JWS alg: ${JSON.stringify(alg)}; expected EdDSA`);
    this.name = "InvalidAlgorithmError";
  }
}

export class InvalidTypError extends Error {
  constructor(typ: unknown) {
    super(`Invalid JWS typ: ${JSON.stringify(typ)}; expected ${AUDIT_ANCHOR_TYP}`);
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
      `tenantId must be canonical lower-case UUID (RFC 4122 §3); got ${tenantId}`,
    );
    this.name = "InvalidTenantIdFormatError";
  }
}

export class InvalidKidError extends Error {
  constructor(kid: unknown) {
    super(
      `Invalid kid format; expected ${AUDIT_ANCHOR_KID_PREFIX}<${AUDIT_ANCHOR_KID_HEX_CHARS} lower-case hex chars>: got ${kid}`,
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

export class InsecureUrlError extends Error {
  constructor(what: string) {
    super(`${what} must be an https:// URL (http:// is accepted for localhost, 127.0.0.1 and [::1] only)`);
    this.name = "InsecureUrlError";
  }
}

export class PriorPublicKeyRequiredError extends Error {
  constructor(priorKid: string) {
    super(
      `The prior manifest is signed under another key (${priorKid}); pass its public key with --prior-public-key`,
    );
    this.name = "PriorPublicKeyRequiredError";
  }
}

export class ManifestSchemaValidationError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "ManifestSchemaValidationError";
  }
}

export class InsecureTagSecretFileError extends Error {
  constructor(path: string) {
    super(
      `Tag-secret file ${path} must be mode 0600; found group/world-readable permissions`,
    );
    this.name = "InsecureTagSecretFileError";
  }
}

export class TenantNotInManifestError extends Error {
  constructor(tag: string) {
    super(`Your tenant is not in this manifest (tenantTag mismatch): ${tag}`);
    this.name = "TenantNotInManifestError";
  }
}

export class ChainBreakError extends Error {
  constructor(expected: string, got: string) {
    super(
      `Prior manifest reference does not match supplied prior (chain break); expected=${expected}, got=${got}`,
    );
    this.name = "ChainBreakError";
  }
}

export class ChainSeqRegressionError extends Error {
  constructor(tenantTag: string, prior: string, current: string) {
    super(
      `CHAIN_SEQ_REGRESSION at tenantTag=${tenantTag}: prior=${prior}, current=${current}`,
    );
    this.name = "ChainSeqRegressionError";
  }
}

export class TagSecretRequiredError extends Error {
  constructor() {
    super(
      "--my-tenant-id requires a tag secret (use --tag-secret-file, stdin, or --tag-secret)",
    );
    this.name = "TagSecretRequiredError";
  }
}

export class InvalidTagSecretLengthError extends Error {
  readonly actualBytes: number;
  constructor(actualBytes: number) {
    super(`Tag secret must be exactly 32 bytes (64 hex chars); got ${actualBytes} bytes`);
    this.name = "InvalidTagSecretLengthError";
    this.actualBytes = actualBytes;
  }
}

export class PublicKeyArchiveUrlMissingError extends Error {
  constructor() {
    super(
      "AUDIT_ANCHOR_PUBLIC_KEY_ARCHIVE_URL must be set, or pass --public-key",
    );
    this.name = "PublicKeyArchiveUrlMissingError";
  }
}

export class PublicKeyFetchError extends Error {
  readonly status: number;
  constructor(status: number, url: string) {
    super(`Failed to fetch public key: HTTP ${status} from ${url}`);
    this.name = "PublicKeyFetchError";
    this.status = status;
  }
}

export class ManifestFetchError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Failed to fetch manifest: HTTP ${status}`);
    this.name = "ManifestFetchError";
    this.status = status;
  }
}

// --- Manifest type and schema ---

type Manifest = {
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

const manifestSchema = z.object({
  $schema: z.string(),
  version: z.literal(1),
  issuer: z.literal("passwd-sso"),
  deploymentId: z.string(),
  anchoredAt: z.string().refine(isIsoTimestamp),
  previousManifest: z.object({ uri: z.string(), sha256: z.string() }).nullable(),
  tenants: z.array(tenantEntrySchema),
});

// --- SubjectPublicKeyInfo prefix for Ed25519 (RFC 8410) ---

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

// --- Helpers ---

function b64urlDecode(str: string): Buffer {
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function jcsCanonical(value: unknown): string {
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
    const entries = keys
      .map((k) => {
        const v = (value as Record<string, unknown>)[k];
        if (v === undefined) return null;
        return JSON.stringify(k) + ":" + jcsCanonical(v);
      })
      .filter((e) => e !== null);
    return "{" + entries.join(",") + "}";
  }
  throw new Error(`JCS: unsupported type ${typeof value}`);
}

function validateManifest(value: unknown): Manifest {
  const result = manifestSchema.safeParse(value);
  if (!result.success) {
    const detail = JSON.stringify(result.error.issues);
    throw new ManifestSchemaValidationError(detail);
  }
  return result.data as Manifest;
}

function canonicalize(manifest: Manifest): Buffer {
  return Buffer.from(jcsCanonical(manifest), "utf-8");
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

function verifyJws(jws: string, publicKey: Buffer): Manifest {
  const parts = jws.split(".");
  if (parts.length !== 3) throw new InvalidSignatureError();
  const [headerB64, payloadB64, sigB64] = parts;

  const header = decodeHeader(headerB64);

  if (header.alg !== "EdDSA") throw new InvalidAlgorithmError(header.alg);
  if (header.typ !== AUDIT_ANCHOR_TYP) throw new InvalidTypError(header.typ);
  // A signature is accepted only under the key its kid names, and the kid is
  // checked before the signature.
  if (typeof header.kid !== "string" || !KID_PATTERN.test(header.kid)) throw new InvalidKidError(header.kid);
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

  let payloadObj: unknown;
  try {
    payloadObj = JSON.parse(b64urlDecode(payloadB64).toString("utf-8"));
  } catch {
    throw new InvalidSignatureError();
  }

  const manifest = validateManifest(payloadObj);

  // Re-canonicalize and compare to detect payload modifications
  const recanon = canonicalize(manifest);
  const payloadBytes = b64urlDecode(payloadB64);
  if (!recanon.equals(payloadBytes)) {
    throw new InvalidSignatureError();
  }

  return manifest;
}

function validateTenantIdCanonical(tenantId: string): void {
  const canonical = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (!canonical.test(tenantId)) {
    throw new InvalidTenantIdFormatError(tenantId);
  }
}

export function computeTenantTag(tenantId: string, tagSecret: Buffer): string {
  validateTenantIdCanonical(tenantId);
  const input = Buffer.concat([
    Buffer.from(AUDIT_ANCHOR_TAG_DOMAIN, "utf-8"),
    Buffer.from([0x00]),
    Buffer.from(tenantId, "utf-8"),
  ]);
  return createHmac("sha256", tagSecret).update(input).digest("hex");
}

function extractKidFromJws(jws: string): string {
  const dot = jws.indexOf(".");
  if (dot === -1) throw new InvalidSignatureError();
  const headerB64 = jws.slice(0, dot);
  const header = decodeHeader(headerB64);
  return typeof header.kid === "string" ? header.kid : "";
}

// The only shape a public key derives: no path separators, percent-encoding, etc.
const KID_PATTERN = new RegExp(`^${AUDIT_ANCHOR_KID_PREFIX}[0-9a-f]{${AUDIT_ANCHOR_KID_HEX_CHARS}}$`);

function validateKid(kid: string): void {
  if (!KID_PATTERN.test(kid)) {
    throw new InvalidKidError(kid);
  }
}

/** The kid of a raw Ed25519 public key: the prefix plus its first 8 bytes in hex. */
function kidForPublicKey(publicKey: Buffer): string {
  return `${AUDIT_ANCHOR_KID_PREFIX}${publicKey.subarray(0, AUDIT_ANCHOR_KID_HEX_CHARS / 2).toString("hex")}`;
}

/**
 * A raw public key from its text: exactly 64 lower-case hex chars once
 * surrounding whitespace is trimmed. `Buffer.from(text, "hex")` is not used
 * alone: it stops at the first non-hex char and returns what it had.
 */
function parsePublicKeyHex(text: string): Buffer {
  const hex = text.trim();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new InvalidPublicKeyError();
  return Buffer.from(hex, "hex");
}

const HTTP_LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function looksLikeUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

/**
 * `raw` as a URL the verifier may fetch: `https://`, or `http://` to a
 * loopback host. The scheme is matched on the text as given, and the host on
 * the parsed URL — a prefix test alone passes `http://127.0.0.1@example.com/`.
 */
function fetchableUrl(raw: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InsecureUrlError(what);
  }
  if (raw.startsWith("https://")) return url;
  if (raw.startsWith("http://") && HTTP_LOOPBACK_HOSTNAMES.has(url.hostname)) return url;
  throw new InsecureUrlError(what);
}

/** The public key of `kid` from the archive at `archiveBase`. */
async function fetchArchivedPublicKey(archiveBase: string, kid: string): Promise<Buffer> {
  // Three layers of defense for the file-data → outbound-fetch flow:
  //   1. validateKid() restricts kid to ^audit-anchor-[0-9a-f]{16}$
  //      (no ".", "/", "%", or other path-special characters).
  //   2. encodeURIComponent on kid — recognized by CodeQL as a sanitizer for
  //      URL-path-segment construction. At runtime this is a no-op because
  //      validateKid already restricted kid to characters that
  //      encodeURIComponent does not encode, but the call breaks the
  //      taint-flow CodeQL detects (see PR #419 review #4209883677).
  //   3. URL constructor with archiveBaseUrl as base — resolution semantics
  //      pin the host to archiveBase's origin; combined with the explicit
  //      origin equality check below, kid cannot escape the archive origin.
  validateKid(kid);
  const archiveBaseUrl = fetchableUrl(archiveBase, "The public key archive URL");
  const archivePath = archiveBaseUrl.pathname.replace(/\/$/, "");
  const safeKid = encodeURIComponent(kid);
  const pubUrlObj = new URL(`${archivePath}/${safeKid}.pub`, archiveBaseUrl);
  if (pubUrlObj.origin !== archiveBaseUrl.origin) {
    // Defense in depth: should be impossible given validateKid + URL semantics,
    // but explicit reject if URL resolution somehow crosses origins.
    throw new PublicKeyFetchError(0, pubUrlObj.href);
  }
  const resp = await fetch(pubUrlObj.href, { redirect: "manual" });
  if (resp.status !== 200) {
    throw new PublicKeyFetchError(resp.status, pubUrlObj.href);
  }
  return parsePublicKeyHex(await resp.text());
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

// --- Secret redaction ---

function makeRedactedPrint(secret: string | undefined) {
  return function printLine(msg: string, toStderr = false): void {
    const safe = secret && secret.length > 0 ? msg.split(secret).join("[REDACTED]") : msg;
    if (toStderr) {
      process.stderr.write(safe + "\n");
    } else {
      process.stdout.write(safe + "\n");
    }
  };
}

// --- Options ---

export type AuditVerifyArgs = {
  manifest: string;
  publicKey?: string;
  myTenantId?: string;
  tagSecret?: string;
  tagSecretFile?: string;
  priorManifest?: string;
  priorPublicKey?: string;
  archiveUrl?: string;
};

// --- Main command ---

export async function auditVerifyCommand(args: AuditVerifyArgs): Promise<void> {
  // Determine tag secret (closes plan N9 / RT5)
  let tagSecretHex: string | undefined;

  if (args.tagSecretFile) {
    // Open the file ONCE and use fstat + read on the same fd to prevent the
    // TOCTOU race that CodeQL flagged: a separate statSync/readFileSync pair
    // could see different inodes if an attacker swaps the file between calls.
    // Same-fd ensures the mode bits we check belong to the bytes we read.
    const fd = openSync(args.tagSecretFile, "r");
    try {
      const st = fstatSync(fd);
      // Check no group/world bits (& 0o077 must be 0)
      if ((st.mode & 0o077) !== 0) {
        throw new InsecureTagSecretFileError(args.tagSecretFile);
      }
      // 64 hex chars + optional newline + a few bytes of slack — refuse anything
      // larger to bound an attacker's ability to hand us a giant file.
      const MAX_SECRET_BYTES = 128;
      if (st.size > MAX_SECRET_BYTES) {
        throw new InsecureTagSecretFileError(
          `${args.tagSecretFile} (file too large: ${st.size} bytes; expected <= ${MAX_SECRET_BYTES})`,
        );
      }
      const buf = Buffer.alloc(st.size);
      let read = 0;
      while (read < st.size) {
        const n = readSync(fd, buf, read, st.size - read, read);
        if (n === 0) break;
        read += n;
      }
      tagSecretHex = buf.subarray(0, read).toString("utf-8").trim();
    } finally {
      closeSync(fd);
    }
  } else if (process.stdin.isTTY === false) {
    // Read from stdin pipe (up to 64 hex chars + newline)
    tagSecretHex = await readStdin(64);
    tagSecretHex = tagSecretHex.trim();
  } else if (args.tagSecret) {
    process.stderr.write(
      "WARN: --tag-secret on the command line is recorded in shell history; prefer --tag-secret-file or stdin\n",
    );
    tagSecretHex = args.tagSecret;
  }

  const print = makeRedactedPrint(tagSecretHex);

  // Fetch or read manifest JWS
  let jws: string;
  if (looksLikeUrl(args.manifest)) {
    const manifestUrl = fetchableUrl(args.manifest, "The manifest URL");
    const resp = await fetch(manifestUrl.href, { redirect: "manual" });
    if (resp.status !== 200) {
      throw new ManifestFetchError(resp.status);
    }
    jws = (await resp.text()).trim();
  } else {
    jws = readFileSync(args.manifest, "utf-8").trim();
  }

  // Extract and validate kid (closes plan N7 / R3-N7 / RT5) — BEFORE any URL fetch
  const kid = extractKidFromJws(jws);
  validateKid(kid); // throws InvalidKidError if invalid

  // Resolve public key
  const archiveBase = args.archiveUrl ?? process.env["AUDIT_ANCHOR_PUBLIC_KEY_ARCHIVE_URL"];
  let publicKeyBytes: Buffer;
  if (args.publicKey) {
    publicKeyBytes = parsePublicKeyHex(readFileSync(args.publicKey, "utf-8"));
  } else {
    if (!archiveBase) {
      throw new PublicKeyArchiveUrlMissingError();
    }
    publicKeyBytes = await fetchArchivedPublicKey(archiveBase, kid);
  }

  // Verify JWS signature — throws typed errors on failure
  const manifest = verifyJws(jws, publicKeyBytes);

  // Optional tenant-coverage check
  if (args.myTenantId) {
    validateTenantIdCanonical(args.myTenantId); // throws InvalidTenantIdFormatError

    if (!tagSecretHex) {
      throw new TagSecretRequiredError();
    }

    const tagSecretBuf = Buffer.from(tagSecretHex, "hex");
    if (tagSecretBuf.length !== 32) throw new InvalidTagSecretLengthError(tagSecretBuf.length);
    const tag = computeTenantTag(args.myTenantId, tagSecretBuf);
    const entry = manifest.tenants.find((t) => t.tenantTag === tag);

    if (!entry) {
      throw new TenantNotInManifestError(tag);
    }

    print(`PASS — tenantTag=${tag}, chainSeq=${entry.chainSeq}, prevHash=${entry.prevHash}, epoch=${entry.epoch}`);
    return;
  }

  // Optional prior-manifest regression check
  if (args.priorManifest) {
    if (manifest.previousManifest === null) {
      process.stderr.write(
        "WARN: current manifest claims genesis (no previousManifest) but --prior-manifest was supplied; chain link cannot be verified\n",
      );
    }

    const priorJws = readFileSync(args.priorManifest, "utf-8").trim();

    // The prior manifest's key. Across a rotation it is not the current one,
    // and it is taken from the archive only when the current key was too: a
    // key the caller handed over says nothing about what the archive serves.
    const priorKid = extractKidFromJws(priorJws);
    validateKid(priorKid);
    let priorKeyBytes: Buffer;
    if (priorKid === kid) {
      priorKeyBytes = publicKeyBytes;
    } else if (args.priorPublicKey) {
      priorKeyBytes = parsePublicKeyHex(readFileSync(args.priorPublicKey, "utf-8"));
    } else if (!args.publicKey && archiveBase) {
      priorKeyBytes = await fetchArchivedPublicKey(archiveBase, priorKid);
    } else {
      throw new PriorPublicKeyRequiredError(priorKid);
    }

    // Verify prior manifest signature too
    const priorManifest = verifyJws(priorJws, priorKeyBytes);

    // Check prior hash reference
    const priorCanon = canonicalize(priorManifest);
    const priorSha256 = sha256Hex(priorCanon);
    if (manifest.previousManifest && manifest.previousManifest.sha256 !== priorSha256) {
      throw new ChainBreakError(manifest.previousManifest.sha256, priorSha256);
    }

    // Check chainSeq regression per tenant
    for (const priorTenant of priorManifest.tenants) {
      const currentTenant = manifest.tenants.find(
        (t) => t.tenantTag === priorTenant.tenantTag,
      );
      if (!currentTenant) continue;

      const priorSeq = BigInt(priorTenant.chainSeq);
      const currentSeq = BigInt(currentTenant.chainSeq);

      if (priorTenant.epoch === currentTenant.epoch && currentSeq < priorSeq) {
        throw new ChainSeqRegressionError(
          priorTenant.tenantTag,
          priorTenant.chainSeq,
          currentTenant.chainSeq,
        );
      }
    }
  }

  print("PASS");
}

async function readStdin(maxChars: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.length > maxChars + 2) {
        // +2 for possible newline
        buf = buf.slice(0, maxChars + 2);
      }
    });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
  });
}
