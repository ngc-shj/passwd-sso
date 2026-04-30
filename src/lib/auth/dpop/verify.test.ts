import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { textEncode } from "@/lib/crypto/crypto-utils";
import {
  verifyDpopProof,
  computeAth,
  jwkThumbprint,
  DPOP_VERIFY_ERROR,
  type DpopVerifyOptions,
} from "./verify";
import type { JtiCache } from "./jti-cache";
import { canonicalHtu } from "./htu-canonical";

// ─── Test harness ──────────────────────────────────────────────

interface TestKeypair {
  privateKey: CryptoKey;
  publicJwk: { kty: "EC"; crv: "P-256"; x: string; y: string };
}

async function generateKeypair(): Promise<TestKeypair> {
  const kp = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const exported = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as {
    kty: string; crv: string; x: string; y: string;
  };
  return {
    privateKey: kp.privateKey,
    publicJwk: { kty: "EC", crv: "P-256", x: exported.x, y: exported.y },
  };
}

interface ProofClaims {
  jti?: string;
  htm?: string;
  htu?: string;
  iat?: number;
  ath?: string;
  nonce?: string;
}

async function makeProof(
  kp: TestKeypair,
  claims: ProofClaims,
  overrides?: { typ?: string; alg?: string; jwk?: object | null; tamperSig?: boolean },
): Promise<string> {
  const header = {
    typ: overrides?.typ ?? "dpop+jwt",
    alg: overrides?.alg ?? "ES256",
    jwk: overrides?.jwk === undefined ? kp.publicJwk : overrides.jwk,
  };
  const payload: Record<string, unknown> = {};
  if (claims.jti !== undefined) payload.jti = claims.jti;
  if (claims.htm !== undefined) payload.htm = claims.htm;
  if (claims.htu !== undefined) payload.htu = claims.htu;
  if (claims.iat !== undefined) payload.iat = claims.iat;
  if (claims.ath !== undefined) payload.ath = claims.ath;
  if (claims.nonce !== undefined) payload.nonce = claims.nonce;

  const h64 = Buffer.from(JSON.stringify(header)).toString("base64url");
  const p64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${h64}.${p64}`;
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    kp.privateKey,
    textEncode(signingInput),
  );
  let sigBytes = Buffer.from(sig);
  if (overrides?.tamperSig) {
    sigBytes = Buffer.from(sigBytes); // copy
    sigBytes[0] = sigBytes[0] ^ 0x01; // flip a bit
  }
  return `${signingInput}.${sigBytes.toString("base64url")}`;
}

function memoryJtiCache(): JtiCache & { _seen: Set<string> } {
  const seen = new Set<string>();
  return {
    _seen: seen,
    async hasOrRecord(jkt: string, jti: string): Promise<boolean> {
      const key = `${jkt}:${jti}`;
      if (seen.has(key)) return true;
      seen.add(key);
      return false;
    },
  };
}

// Set APP_URL at import time so canonicalHtu() works in module-level
// constants. (vitest evaluates the file top-to-bottom; beforeAll fires
// after this point, so we must set the env var here.)
process.env.APP_URL = "https://app.example.com";

const HTU = canonicalHtu({ route: "/api/passwords" });
const HTM = "POST";

function baseOptions(jtiCache: JtiCache, overrides?: Partial<DpopVerifyOptions>): DpopVerifyOptions {
  return {
    expectedHtm: HTM,
    expectedHtu: HTU,
    jtiCache,
    expectedNonce: null,
    ...overrides,
  };
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// ─── Happy path ────────────────────────────────────────────────

describe("verifyDpopProof - happy path", () => {
  it("accepts a valid proof and returns claims + jkt", async () => {
    const kp = await generateKeypair();
    const accessToken = "mob_test_token";
    const expectedAth = computeAth(accessToken);
    const expectedJkt = jwkThumbprint(kp.publicJwk);

    const proof = await makeProof(kp, {
      jti: "jti-happy",
      htm: HTM,
      htu: HTU,
      iat: nowSec(),
      ath: expectedAth,
    });

    const result = await verifyDpopProof(
      proof,
      baseOptions(memoryJtiCache(), {
        expectedAth,
        expectedCnfJkt: expectedJkt,
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.jkt).toBe(expectedJkt);
      expect(result.claims.jti).toBe("jti-happy");
      expect(result.claims.htm).toBe(HTM);
      expect(result.claims.cnf?.jkt).toBe(expectedJkt);
    }
  });
});

// ─── Forgery / negative cases ──────────────────────────────────

describe("verifyDpopProof - forgery cases", () => {
  it("(missing header) returns DPOP_HEADER_MISSING", async () => {
    const result = await verifyDpopProof(null, baseOptions(memoryJtiCache()));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(DPOP_VERIFY_ERROR.HEADER_MISSING);
  });

  it("(malformed token) returns DPOP_PARSE_ERROR", async () => {
    const result = await verifyDpopProof("not-a-jws", baseOptions(memoryJtiCache()));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(DPOP_VERIFY_ERROR.PARSE_ERROR);
  });

  it("(wrong typ) returns DPOP_BAD_TYP", async () => {
    const kp = await generateKeypair();
    const proof = await makeProof(
      kp,
      { jti: "x", htm: HTM, htu: HTU, iat: nowSec() },
      { typ: "JWT" },
    );
    const result = await verifyDpopProof(proof, baseOptions(memoryJtiCache()));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(DPOP_VERIFY_ERROR.BAD_TYP);
  });

  it("(wrong alg) returns DPOP_BAD_ALG", async () => {
    const kp = await generateKeypair();
    const proof = await makeProof(
      kp,
      { jti: "x", htm: HTM, htu: HTU, iat: nowSec() },
      { alg: "RS256" },
    );
    const result = await verifyDpopProof(proof, baseOptions(memoryJtiCache()));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(DPOP_VERIFY_ERROR.BAD_ALG);
  });

  it("(missing jwk) returns DPOP_BAD_JWK", async () => {
    const kp = await generateKeypair();
    const proof = await makeProof(
      kp,
      { jti: "x", htm: HTM, htu: HTU, iat: nowSec() },
      { jwk: null },
    );
    const result = await verifyDpopProof(proof, baseOptions(memoryJtiCache()));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(DPOP_VERIFY_ERROR.BAD_JWK);
  });

  it("(a) signed by a different P-256 key returns DPOP_SIG_INVALID", async () => {
    const realKp = await generateKeypair();
    const attackerKp = await generateKeypair();
    // Build the proof with attacker's signing key but advertise real key in header.
    // Manually reproduce makeProof with a swapped jwk header.
    const header = { typ: "dpop+jwt", alg: "ES256", jwk: realKp.publicJwk };
    const payload = { jti: "a", htm: HTM, htu: HTU, iat: nowSec() };
    const h64 = Buffer.from(JSON.stringify(header)).toString("base64url");
    const p64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signingInput = `${h64}.${p64}`;
    const sig = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      attackerKp.privateKey,
      textEncode(signingInput),
    );
    const proof = `${signingInput}.${Buffer.from(sig).toString("base64url")}`;

    const result = await verifyDpopProof(proof, baseOptions(memoryJtiCache()));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(DPOP_VERIFY_ERROR.SIG_INVALID);
  });

  it("(b) tampered signature byte returns DPOP_SIG_INVALID", async () => {
    const kp = await generateKeypair();
    const proof = await makeProof(
      kp,
      { jti: "b", htm: HTM, htu: HTU, iat: nowSec() },
      { tamperSig: true },
    );
    const result = await verifyDpopProof(proof, baseOptions(memoryJtiCache()));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(DPOP_VERIFY_ERROR.SIG_INVALID);
  });

  it("(c) htm mismatch (POST vs GET) returns DPOP_HTM_MISMATCH", async () => {
    const kp = await generateKeypair();
    const proof = await makeProof(kp, {
      jti: "c",
      htm: "GET", // wrong
      htu: HTU,
      iat: nowSec(),
    });
    const result = await verifyDpopProof(proof, baseOptions(memoryJtiCache()));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(DPOP_VERIFY_ERROR.HTM_MISMATCH);
  });

  it("(d) htu mismatch (different path) returns DPOP_HTU_MISMATCH", async () => {
    const kp = await generateKeypair();
    const proof = await makeProof(kp, {
      jti: "d",
      htm: HTM,
      htu: canonicalHtu({ route: "/api/some-other-route" }),
      iat: nowSec(),
    });
    const result = await verifyDpopProof(proof, baseOptions(memoryJtiCache()));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(DPOP_VERIFY_ERROR.HTU_MISMATCH);
  });

  it("(e1) iat > 30s in the past returns DPOP_IAT_OUT_OF_WINDOW", async () => {
    const kp = await generateKeypair();
    const proof = await makeProof(kp, {
      jti: "e1",
      htm: HTM,
      htu: HTU,
      iat: nowSec() - 60,
    });
    const result = await verifyDpopProof(proof, baseOptions(memoryJtiCache()));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(DPOP_VERIFY_ERROR.IAT_OUT_OF_WINDOW);
  });

  it("(e2) iat > 30s in the future returns DPOP_IAT_OUT_OF_WINDOW", async () => {
    const kp = await generateKeypair();
    const proof = await makeProof(kp, {
      jti: "e2",
      htm: HTM,
      htu: HTU,
      iat: nowSec() + 60,
    });
    const result = await verifyDpopProof(proof, baseOptions(memoryJtiCache()));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(DPOP_VERIFY_ERROR.IAT_OUT_OF_WINDOW);
  });

  it("(f) missing ath when expected returns DPOP_ATH_REQUIRED", async () => {
    const kp = await generateKeypair();
    const proof = await makeProof(kp, {
      jti: "f",
      htm: HTM,
      htu: HTU,
      iat: nowSec(),
      // no ath
    });
    const result = await verifyDpopProof(
      proof,
      baseOptions(memoryJtiCache(), { expectedAth: computeAth("any") }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(DPOP_VERIFY_ERROR.ATH_REQUIRED);
  });

  it("(f2) wrong ath returns DPOP_ATH_MISMATCH", async () => {
    const kp = await generateKeypair();
    const proof = await makeProof(kp, {
      jti: "f2",
      htm: HTM,
      htu: HTU,
      iat: nowSec(),
      ath: computeAth("token-a"),
    });
    const result = await verifyDpopProof(
      proof,
      baseOptions(memoryJtiCache(), { expectedAth: computeAth("token-b") }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(DPOP_VERIFY_ERROR.ATH_MISMATCH);
  });

  it("(g) cnf.jkt mismatch with bearer token's stored thumbprint returns DPOP_CNF_JKT_MISMATCH", async () => {
    const kp = await generateKeypair();
    const proof = await makeProof(kp, {
      jti: "g",
      htm: HTM,
      htu: HTU,
      iat: nowSec(),
      ath: computeAth("t"),
    });
    // Pass a totally different fake thumbprint.
    const fakeJkt = createHash("sha256").update("not-this-key").digest("base64url");
    const result = await verifyDpopProof(
      proof,
      baseOptions(memoryJtiCache(), {
        expectedAth: computeAth("t"),
        expectedCnfJkt: fakeJkt,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(DPOP_VERIFY_ERROR.CNF_JKT_MISMATCH);
  });

  it("missing nonce when expected returns DPOP_NONCE_REQUIRED", async () => {
    const kp = await generateKeypair();
    const proof = await makeProof(kp, {
      jti: "nonce-missing",
      htm: HTM,
      htu: HTU,
      iat: nowSec(),
    });
    const result = await verifyDpopProof(
      proof,
      baseOptions(memoryJtiCache(), { expectedNonce: "expected-nonce-value" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(DPOP_VERIFY_ERROR.NONCE_REQUIRED);
  });

  it("wrong nonce returns DPOP_NONCE_INVALID", async () => {
    const kp = await generateKeypair();
    const proof = await makeProof(kp, {
      jti: "nonce-bad",
      htm: HTM,
      htu: HTU,
      iat: nowSec(),
      nonce: "client-sent-this",
    });
    const result = await verifyDpopProof(
      proof,
      baseOptions(memoryJtiCache(), { expectedNonce: "server-expected-this" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(DPOP_VERIFY_ERROR.NONCE_INVALID);
  });

  it("jti replay returns DPOP_JTI_REPLAY", async () => {
    const kp = await generateKeypair();
    const cache = memoryJtiCache();

    const proof1 = await makeProof(kp, {
      jti: "replay-jti",
      htm: HTM,
      htu: HTU,
      iat: nowSec(),
    });
    const r1 = await verifyDpopProof(proof1, baseOptions(cache));
    expect(r1.ok).toBe(true);

    // Second proof — same jti, different request envelope so signature
    // is fresh — must be rejected as replay against the cache.
    const proof2 = await makeProof(kp, {
      jti: "replay-jti",
      htm: HTM,
      htu: HTU,
      iat: nowSec(),
    });
    const r2 = await verifyDpopProof(proof2, baseOptions(cache));
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toBe(DPOP_VERIFY_ERROR.JTI_REPLAY);
  });
});

describe("computeAth", () => {
  it("matches base64url(SHA-256(token)) without padding", () => {
    // RFC 9449 §6 - example access token "Kz~8mXK1EalYznwH-LC-1fBAo.4Ljp~zsPE_NeO.gxU"
    // expected base64url no padding.
    const token = "Kz~8mXK1EalYznwH-LC-1fBAo.4Ljp~zsPE_NeO.gxU";
    expect(computeAth(token)).toBe("fUHyO2r2Z3DZ53EsNrWBb0xWXoaNy59IiKCAqksmQEo");
  });
});

describe("jwkThumbprint", () => {
  it("uses RFC 7638 ordering (crv, kty, x, y)", () => {
    // Vector: known EC P-256 thumbprint. Generate a key, compute thumbprint two ways.
    // Simplest sanity: thumbprint must change when any field changes.
    const a = jwkThumbprint({ kty: "EC", crv: "P-256", x: "AAA", y: "BBB" });
    const b = jwkThumbprint({ kty: "EC", crv: "P-256", x: "AAA", y: "CCC" });
    expect(a).not.toBe(b);
    // And ordering of keys in the input object MUST NOT change the result.
    const c = jwkThumbprint({ y: "BBB", x: "AAA", kty: "EC", crv: "P-256" } as never);
    expect(a).toBe(c);
  });
});
