import { createHash, timingSafeEqual } from "node:crypto";
import { textEncode, toArrayBuffer } from "@/lib/crypto/crypto-utils";
import { htuMatches } from "./htu-canonical";
import type { JtiCache } from "./jti-cache";

/**
 * RFC 9449 (DPoP) proof verifier.
 *
 * Pinned requirements (see plan / RFC):
 *  - typ === "dpop+jwt"
 *  - alg === "ES256" (P-256 ECDSA + SHA-256). Other algs are rejected.
 *  - jwk in header is { kty: "EC", crv: "P-256", x, y } — used to verify
 *    the signature AND its RFC 7638 thumbprint becomes `jkt`.
 *  - htm matches the request method (uppercase, exact).
 *  - htu canonical-matches the route's expected URL (htu-canonical.ts).
 *  - |iat - now| ≤ iatSkewSeconds (default 30s, both directions).
 *  - jti is unique within the cache TTL window (jti-cache.ts).
 *  - On protected calls (`expectedAth` set):
 *      * `ath` MUST be present and equal base64url(SHA-256(access token)).
 *      * `cnf.jkt` of the bearer access-token row MUST equal the
 *        thumbprint of the proof's `jwk`. (`expectedCnfJkt` is the
 *        value from the access-token row.)
 *  - When `expectedNonce` is non-null, the proof MUST carry a matching `nonce`.
 *
 * All header / claim string-comparisons that touch security state use
 * `crypto.timingSafeEqual` to avoid leaking partial-match information.
 */

export interface DpopProofClaims {
  jti: string;
  htm: string;
  htu: string;
  iat: number;
  ath?: string;
  nonce?: string;
  /** Populated by the verifier with the thumbprint of the proof's own jwk. */
  cnf?: { jkt: string };
}

/**
 * Verification-error codes returned by {@link verifyDpopProof}.
 * Mirrors the project's `AUDIT_ACTION`-style const-object pattern so
 * call sites and tests reference symbols (e.g. `DPOP_VERIFY_ERROR.SIG_INVALID`)
 * rather than copy-pasting string literals.
 */
export const DPOP_VERIFY_ERROR = {
  HEADER_MISSING: "DPOP_HEADER_MISSING",
  PARSE_ERROR: "DPOP_PARSE_ERROR",
  BAD_TYP: "DPOP_BAD_TYP",
  BAD_ALG: "DPOP_BAD_ALG",
  BAD_JWK: "DPOP_BAD_JWK",
  SIG_INVALID: "DPOP_SIG_INVALID",
  HTM_MISMATCH: "DPOP_HTM_MISMATCH",
  HTU_MISMATCH: "DPOP_HTU_MISMATCH",
  IAT_OUT_OF_WINDOW: "DPOP_IAT_OUT_OF_WINDOW",
  JTI_REPLAY: "DPOP_JTI_REPLAY",
  ATH_REQUIRED: "DPOP_ATH_REQUIRED",
  ATH_MISMATCH: "DPOP_ATH_MISMATCH",
  CNF_JKT_MISMATCH: "DPOP_CNF_JKT_MISMATCH",
  NONCE_REQUIRED: "DPOP_NONCE_REQUIRED",
  NONCE_INVALID: "DPOP_NONCE_INVALID",
} as const;

export type DpopVerifyError =
  (typeof DPOP_VERIFY_ERROR)[keyof typeof DPOP_VERIFY_ERROR];

export interface DpopVerifyOptions {
  /** Expected HTTP method (e.g. "POST"). Compared case-sensitive after upper-case. */
  expectedHtm: string;
  /** Canonical URL via `canonicalHtu`. */
  expectedHtu: string;
  /** Default 30 (RFC 9449 guidance). */
  iatSkewSeconds?: number;
  /** SHA-256(access-token), base64url, no padding. REQUIRED for protected calls. */
  expectedAth?: string;
  /** Thumbprint stored on the access-token row. REQUIRED for protected calls. */
  expectedCnfJkt?: string;
  /** When set, the proof must carry this nonce. `null` disables the check. */
  expectedNonce?: string | null;
  /** Injected; tests pass an in-memory implementation. */
  jtiCache: JtiCache;
  /** Test injection point for fixing "now". */
  now?: () => number;
}

export type DpopVerifyResult =
  | { ok: true; claims: DpopProofClaims; jkt: string }
  | { ok: false; error: DpopVerifyError; detail?: string };

interface ParsedJws {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signatureRaw: Buffer;
}

interface DpopJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

const DEFAULT_SKEW_SECONDS = 30;

// ─── Public entry point ───────────────────────────────────────

export async function verifyDpopProof(
  dpopHeader: string | null | undefined,
  options: DpopVerifyOptions,
): Promise<DpopVerifyResult> {
  if (!dpopHeader || typeof dpopHeader !== "string") {
    return fail(DPOP_VERIFY_ERROR.HEADER_MISSING);
  }

  const parsed = parseJws(dpopHeader);
  if (!parsed.ok) return fail(DPOP_VERIFY_ERROR.PARSE_ERROR, parsed.detail);

  const { header, payload, signingInput, signatureRaw } = parsed.value;

  if (header.typ !== "dpop+jwt") return fail(DPOP_VERIFY_ERROR.BAD_TYP);
  if (header.alg !== "ES256") return fail(DPOP_VERIFY_ERROR.BAD_ALG);

  const jwk = extractEcJwk(header.jwk);
  if (!jwk) return fail(DPOP_VERIFY_ERROR.BAD_JWK);

  // ES256 ECDSA-P256 signature uses raw r||s of 64 bytes.
  if (signatureRaw.length !== 64) {
    return fail(
      DPOP_VERIFY_ERROR.SIG_INVALID,
      `signature length ${signatureRaw.length}`,
    );
  }

  const sigOk = await verifyEs256(jwk, signingInput, signatureRaw);
  if (!sigOk) return fail(DPOP_VERIFY_ERROR.SIG_INVALID);

  // Compute thumbprint up-front so it can be used for jti scoping AND cnf.jkt match.
  const jkt = jwkThumbprint(jwk);

  // ─── Claim validation ──────────────────────────────────────

  if (typeof payload.htm !== "string")
    return fail(DPOP_VERIFY_ERROR.HTM_MISMATCH, "htm missing");
  if (payload.htm.toUpperCase() !== options.expectedHtm.toUpperCase()) {
    return fail(DPOP_VERIFY_ERROR.HTM_MISMATCH);
  }

  if (typeof payload.htu !== "string")
    return fail(DPOP_VERIFY_ERROR.HTU_MISMATCH, "htu missing");
  if (!htuMatches(payload.htu, options.expectedHtu))
    return fail(DPOP_VERIFY_ERROR.HTU_MISMATCH);

  if (typeof payload.iat !== "number" || !Number.isFinite(payload.iat)) {
    return fail(DPOP_VERIFY_ERROR.IAT_OUT_OF_WINDOW, "iat missing");
  }
  const skew = options.iatSkewSeconds ?? DEFAULT_SKEW_SECONDS;
  const nowSec = Math.floor((options.now ?? Date.now)() / 1000);
  if (Math.abs(nowSec - payload.iat) > skew) {
    return fail(DPOP_VERIFY_ERROR.IAT_OUT_OF_WINDOW);
  }

  if (typeof payload.jti !== "string" || payload.jti.length === 0) {
    return fail(DPOP_VERIFY_ERROR.PARSE_ERROR, "jti missing");
  }

  // Nonce check: when the route requires a nonce, validate before
  // touching the jti cache so a missing nonce can't pollute the cache.
  if (options.expectedNonce !== null && options.expectedNonce !== undefined) {
    if (typeof payload.nonce !== "string" || payload.nonce.length === 0) {
      return fail(DPOP_VERIFY_ERROR.NONCE_REQUIRED);
    }
    if (!safeStringEqual(payload.nonce, options.expectedNonce)) {
      return fail(DPOP_VERIFY_ERROR.NONCE_INVALID);
    }
  }

  // ath: required iff caller passed expectedAth.
  if (options.expectedAth !== undefined) {
    if (typeof payload.ath !== "string" || payload.ath.length === 0) {
      return fail(DPOP_VERIFY_ERROR.ATH_REQUIRED);
    }
    if (!safeStringEqual(payload.ath, options.expectedAth)) {
      return fail(DPOP_VERIFY_ERROR.ATH_MISMATCH);
    }
  }

  // cnf.jkt: the bearer token row's thumbprint must match this proof's jwk.
  if (options.expectedCnfJkt !== undefined) {
    if (!safeStringEqual(jkt, options.expectedCnfJkt)) {
      return fail(DPOP_VERIFY_ERROR.CNF_JKT_MISMATCH);
    }
  }

  // jti uniqueness — scoped per-jkt to bound cache size and isolate keyspaces.
  const isReplay = await options.jtiCache.hasOrRecord(jkt, payload.jti);
  if (isReplay) return fail(DPOP_VERIFY_ERROR.JTI_REPLAY);

  const claims: DpopProofClaims = {
    jti: payload.jti,
    htm: payload.htm,
    htu: payload.htu,
    iat: payload.iat,
    ...(typeof payload.ath === "string" ? { ath: payload.ath } : {}),
    ...(typeof payload.nonce === "string" ? { nonce: payload.nonce } : {}),
    cnf: { jkt },
  };
  return { ok: true, claims, jkt };
}

// ─── Helpers ──────────────────────────────────────────────────

/** SHA-256(value), base64url no padding. Used for `ath` derivation by callers. */
export function computeAth(accessToken: string): string {
  return createHash("sha256").update(accessToken).digest("base64url");
}

/** RFC 7638 §3 thumbprint for a P-256 EC JWK. base64url(SHA-256(JCS(jwk))). */
export function jwkThumbprint(jwk: DpopJwk): string {
  // Required-member ordering for EC keys is exactly: crv, kty, x, y.
  const canonical = JSON.stringify({
    crv: jwk.crv,
    kty: jwk.kty,
    x: jwk.x,
    y: jwk.y,
  });
  return createHash("sha256").update(canonical).digest("base64url");
}

function fail(error: DpopVerifyError, detail?: string): DpopVerifyResult {
  return detail ? { ok: false, error, detail } : { ok: false, error };
}

function safeStringEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

interface ParseOk { ok: true; value: ParsedJws }
interface ParseErr { ok: false; detail: string }

function parseJws(token: string): ParseOk | ParseErr {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, detail: "expected 3 segments" };
  const [h, p, s] = parts;
  if (!h || !p || !s) return { ok: false, detail: "empty segment" };

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    return { ok: false, detail: "header/payload not valid JSON" };
  }
  if (header === null || typeof header !== "object") return { ok: false, detail: "header not object" };
  if (payload === null || typeof payload !== "object") return { ok: false, detail: "payload not object" };

  const signatureRaw = Buffer.from(s, "base64url");
  if (signatureRaw.length === 0) return { ok: false, detail: "empty signature" };

  return {
    ok: true,
    value: {
      header,
      payload,
      signingInput: `${h}.${p}`,
      signatureRaw,
    },
  };
}

function extractEcJwk(value: unknown): DpopJwk | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (obj.kty !== "EC") return null;
  if (obj.crv !== "P-256") return null;
  if (typeof obj.x !== "string" || obj.x.length === 0) return null;
  if (typeof obj.y !== "string" || obj.y.length === 0) return null;
  // Reject any private-key field that should never appear on an inline jwk.
  if ("d" in obj) return null;
  return { kty: "EC", crv: "P-256", x: obj.x, y: obj.y };
}

async function verifyEs256(
  jwk: DpopJwk,
  signingInput: string,
  signatureRaw: Buffer,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      toArrayBuffer(new Uint8Array(signatureRaw)),
      textEncode(signingInput),
    );
  } catch {
    return false;
  }
}
