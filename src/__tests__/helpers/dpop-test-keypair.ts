/**
 * Shared DPoP test-keypair helpers.
 *
 * extractable: true — production keys use extractable:false, but tests must
 * export the JWK to compute the thumbprint. Documented test-fixture exception.
 */

import { jwkThumbprint } from "@/lib/auth/dpop/verify";
import { textEncode } from "@/lib/crypto/crypto-utils";

export interface TestKeypair {
  privateKey: CryptoKey;
  publicJwk: { kty: "EC"; crv: "P-256"; x: string; y: string };
  jkt: string;
}

export async function generateKeypair(): Promise<TestKeypair> {
  const kp = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true, // extractable: true for test fixture; production uses false
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const exported = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as {
    kty: string;
    crv: string;
    x: string;
    y: string;
  };
  const publicJwk = {
    kty: "EC" as const,
    crv: "P-256" as const,
    x: exported.x,
    y: exported.y,
  };
  return { privateKey: kp.privateKey, publicJwk, jkt: jwkThumbprint(publicJwk) };
}

export async function makeProof(
  kp: TestKeypair,
  claims: {
    jti: string;
    htm: string;
    htu: string;
    iat: number;
    ath?: string;
  },
): Promise<string> {
  const header = { typ: "dpop+jwt", alg: "ES256", jwk: kp.publicJwk };
  const h64 = Buffer.from(JSON.stringify(header)).toString("base64url");
  const p64 = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signingInput = `${h64}.${p64}`;
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    kp.privateKey,
    textEncode(signingInput),
  );
  return `${signingInput}.${Buffer.from(sig).toString("base64url")}`;
}
