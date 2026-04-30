import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { generateKeyPairSync, createPrivateKey, sign as nodeSign } from "node:crypto";

const require = createRequire(import.meta.url);

// cli/src/__tests__/integration/ → cli/dist/
const distEntry = resolve(import.meta.dirname, "../../../dist/index.js");
const distExists = existsSync(distEntry);

// --- Helpers (duplicated from unit test; CLI is standalone) ---

const AUDIT_ANCHOR_KID_PREFIX = "audit-anchor-";
const AUDIT_ANCHOR_TYP = "passwd-sso.audit-anchor.v1";
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function jcsCanonical(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map((v) => jcsCanonical(v)).join(",") + "]";
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

function buildMinimalManifest() {
  return {
    $schema: "https://passwd-sso.example/schemas/audit-anchor-manifest-v1.json",
    version: 1 as const,
    issuer: "passwd-sso" as const,
    deploymentId: "deploy-integration-001",
    anchoredAt: new Date().toISOString(),
    previousManifest: null,
    tenants: [],
  };
}

function signManifest(
  manifest: ReturnType<typeof buildMinimalManifest>,
  privateKeySeed: Buffer,
  kid: string,
): string {
  const headerObj = { alg: "EdDSA", kid, typ: AUDIT_ANCHOR_TYP };
  const canonicalBytes = Buffer.from(jcsCanonical(manifest), "utf-8");
  const headerB64 = b64urlEncode(Buffer.from(JSON.stringify(headerObj), "utf-8"));
  const payloadB64 = b64urlEncode(canonicalBytes);
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, "utf-8");

  const keyObject = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, privateKeySeed]),
    format: "der",
    type: "pkcs8",
  });
  const sig = nodeSign(null, signingInput, keyObject);
  return `${headerB64}.${payloadB64}.${b64urlEncode(sig)}`;
}

// --- Integration tests ---

describe("CLI audit-verify subcommand (integration)", () => {
  it.skipIf(!distExists)(
    "exits 0 and prints PASS for a valid JWS with matching public key",
    () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "audit-verify-int-"));

      // Generate Ed25519 key pair
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const privateKeySeed = (
        privateKey.export({ type: "pkcs8", format: "der" }) as Buffer
      ).subarray(ED25519_PKCS8_PREFIX.length);
      const pubDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
      const pubHex = pubDer.subarray(ED25519_SPKI_PREFIX.length).toString("hex");

      // Build and sign manifest
      const kid = `${AUDIT_ANCHOR_KID_PREFIX}inttest01`;
      const manifest = buildMinimalManifest();
      const jws = signManifest(manifest, privateKeySeed, kid);

      // Write to temp files
      const jwsPath = join(tmpDir, "manifest.jws");
      const pubPath = join(tmpDir, "key.pub");
      writeFileSync(jwsPath, jws);
      writeFileSync(pubPath, pubHex);

      // Run subprocess
      const stdout = execFileSync("node", [distEntry, "audit-verify", "--manifest", jwsPath, "--public-key", pubPath], {
        encoding: "utf8",
        timeout: 10000,
      });

      expect(stdout.trim()).toContain("PASS");
    },
  );

  it.skipIf(!distExists)(
    "exits non-zero for a JWS with wrong public key",
    () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "audit-verify-int-wrong-"));

      // Generate signing key pair
      const { privateKey } = generateKeyPairSync("ed25519");
      const privateKeySeed = (
        privateKey.export({ type: "pkcs8", format: "der" }) as Buffer
      ).subarray(ED25519_PKCS8_PREFIX.length);

      // Generate a DIFFERENT key pair for the "wrong" public key
      const { publicKey: wrongPublicKey } = generateKeyPairSync("ed25519");
      const wrongPubDer = wrongPublicKey.export({ type: "spki", format: "der" }) as Buffer;
      const wrongPubHex = wrongPubDer.subarray(ED25519_SPKI_PREFIX.length).toString("hex");

      // Build and sign manifest with the real private key
      const kid = `${AUDIT_ANCHOR_KID_PREFIX}wrongkey1`;
      const manifest = buildMinimalManifest();
      const jws = signManifest(manifest, privateKeySeed, kid);

      const jwsPath = join(tmpDir, "manifest.jws");
      const pubPath = join(tmpDir, "wrong.pub");
      writeFileSync(jwsPath, jws);
      writeFileSync(pubPath, wrongPubHex);

      // Run subprocess — expect non-zero exit
      const result = spawnSync("node", [distEntry, "audit-verify", "--manifest", jwsPath, "--public-key", pubPath], {
        encoding: "utf8",
        timeout: 10000,
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("signature");
    },
  );
});
