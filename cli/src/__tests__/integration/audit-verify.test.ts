import { describe, it, expect, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign as nodeSign } from "node:crypto";
import { AUDIT_ANCHOR_KID_PREFIX, AUDIT_ANCHOR_TYP } from "../../constants/audit-anchor.js";

// cli/src/__tests__/integration/ → cli/dist/
const distEntry = resolve(import.meta.dirname, "../../../dist/index.js");
const distExists = existsSync(distEntry);

// --- Helpers (duplicated from unit test; CLI is standalone) ---

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

/** The kid a seed's public key derives: the only one the verifier accepts for it. */
function kidForSeed(privateKeySeed: Buffer): string {
  const keyObject = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, privateKeySeed]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = (createPublicKey(keyObject).export({ type: "spki", format: "der" }) as Buffer).subarray(
    ED25519_SPKI_PREFIX.length,
  );
  return `${AUDIT_ANCHOR_KID_PREFIX}${publicKey.subarray(0, 8).toString("hex")}`;
}

function signManifest(
  manifest: object,
  privateKeySeed: Buffer,
  kid: string = kidForSeed(privateKeySeed),
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

const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// --- Integration tests ---

describe("CLI audit-verify subcommand (integration)", () => {
  // The cases below skip without a build, which suits a developer's machine.
  // CI builds first, so a missing dist there would let every case skip and
  // the suite read as a pass.
  it("has the built CLI to run when in CI", () => {
    expect(Boolean(process.env.CI) && !distExists).toBe(false);
  });

  it.skipIf(!distExists)(
    "exits 0 and prints PASS for a valid JWS with matching public key",
    () => {
      const tmpDir = makeTmpDir("audit-verify-int-");

      // Generate Ed25519 key pair
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const privateKeySeed = (
        privateKey.export({ type: "pkcs8", format: "der" }) as Buffer
      ).subarray(ED25519_PKCS8_PREFIX.length);
      const pubDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
      const pubHex = pubDer.subarray(ED25519_SPKI_PREFIX.length).toString("hex");

      // Build and sign manifest
      const manifest = buildMinimalManifest();
      const jws = signManifest(manifest, privateKeySeed);

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
    "exits 19 for a JWS checked under a key its kid does not name",
    () => {
      const tmpDir = makeTmpDir("audit-verify-int-wrong-");

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
      const manifest = buildMinimalManifest();
      const jws = signManifest(manifest, privateKeySeed);

      const jwsPath = join(tmpDir, "manifest.jws");
      const pubPath = join(tmpDir, "wrong.pub");
      writeFileSync(jwsPath, jws);
      writeFileSync(pubPath, wrongPubHex);

      const result = spawnSync("node", [distEntry, "audit-verify", "--manifest", jwsPath, "--public-key", pubPath], {
        encoding: "utf8",
        timeout: 10000,
      });

      expect(result.status).toBe(19);
      expect(result.stderr).toContain("does not name the supplied public key");
      expect(result.stdout).not.toContain("PASS");
    },
  );

  it.skipIf(!distExists)(
    "exits 12 for a JWS under its own key with a signature that does not verify",
    () => {
      const tmpDir = makeTmpDir("audit-verify-int-sig-");

      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const privateKeySeed = (
        privateKey.export({ type: "pkcs8", format: "der" }) as Buffer
      ).subarray(ED25519_PKCS8_PREFIX.length);
      const pubDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
      const pubHex = pubDer.subarray(ED25519_SPKI_PREFIX.length).toString("hex");

      const [headerB64, payloadB64] = signManifest(buildMinimalManifest(), privateKeySeed).split(".");
      const jwsPath = join(tmpDir, "manifest.jws");
      const pubPath = join(tmpDir, "key.pub");
      writeFileSync(jwsPath, `${headerB64}.${payloadB64}.${b64urlEncode(Buffer.alloc(64))}`);
      writeFileSync(pubPath, pubHex);

      const result = spawnSync("node", [distEntry, "audit-verify", "--manifest", jwsPath, "--public-key", pubPath], {
        encoding: "utf8",
        timeout: 10000,
      });

      expect(result.status).toBe(12);
      expect(result.stderr).toContain("signature");
    },
  );

  it.skipIf(!distExists)(
    "verifies a prior manifest signed under another key with --prior-public-key",
    () => {
      const tmpDir = makeTmpDir("audit-verify-int-prior-");
      const seedOf = (pair: ReturnType<typeof generateKeyPairSync>) =>
        (pair.privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).subarray(ED25519_PKCS8_PREFIX.length);
      const pubHexOf = (pair: ReturnType<typeof generateKeyPairSync>) =>
        (pair.publicKey.export({ type: "spki", format: "der" }) as Buffer)
          .subarray(ED25519_SPKI_PREFIX.length)
          .toString("hex");
      const current = generateKeyPairSync("ed25519");
      const retired = generateKeyPairSync("ed25519");

      const jwsPath = join(tmpDir, "manifest.jws");
      const priorPath = join(tmpDir, "prior.jws");
      const pubPath = join(tmpDir, "key.pub");
      const priorPubPath = join(tmpDir, "retired.pub");
      writeFileSync(jwsPath, signManifest(buildMinimalManifest(), seedOf(current)));
      writeFileSync(priorPath, signManifest(buildMinimalManifest(), seedOf(retired)));
      writeFileSync(pubPath, pubHexOf(current));
      writeFileSync(priorPubPath, pubHexOf(retired));

      const base = [distEntry, "audit-verify", "--manifest", jwsPath, "--public-key", pubPath, "--prior-manifest", priorPath];
      const withKey = spawnSync("node", [...base, "--prior-public-key", priorPubPath], { encoding: "utf8", timeout: 10000 });
      const without = spawnSync("node", base, { encoding: "utf8", timeout: 10000 });

      expect(withKey.status).toBe(0);
      expect(withKey.stdout).toContain("PASS");
      expect(without.status).toBe(1);
      expect(without.stderr).toContain("--prior-public-key");
    },
  );

  it.skipIf(!distExists)(
    "exits 20 for a prior manifest bound to another chain location, and 0 for one bound to the same",
    () => {
      const tmpDir = makeTmpDir("audit-verify-int-location-");
      const pair = generateKeyPairSync("ed25519");
      const seed = (pair.privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).subarray(ED25519_PKCS8_PREFIX.length);
      const pubHex = (pair.publicKey.export({ type: "spki", format: "der" }) as Buffer)
        .subarray(ED25519_SPKI_PREFIX.length)
        .toString("hex");
      const v2 = (chainLocation: string) => ({
        ...buildMinimalManifest(),
        $schema: "https://passwd-sso.example/schemas/audit-anchor-manifest-v2.json",
        version: 2 as const,
        chainLocation,
      });

      const jwsPath = join(tmpDir, "manifest.jws");
      const samePath = join(tmpDir, "prior-same.jws");
      const otherPath = join(tmpDir, "prior-other.jws");
      const pubPath = join(tmpDir, "key.pub");
      writeFileSync(jwsPath, signManifest(v2("a".repeat(64)), seed));
      writeFileSync(samePath, signManifest(v2("a".repeat(64)), seed));
      writeFileSync(otherPath, signManifest(v2("b".repeat(64)), seed));
      writeFileSync(pubPath, pubHex);

      const base = [distEntry, "audit-verify", "--manifest", jwsPath, "--public-key", pubPath, "--prior-manifest"];
      const same = spawnSync("node", [...base, samePath], { encoding: "utf8", timeout: 10000 });
      const other = spawnSync("node", [...base, otherPath], { encoding: "utf8", timeout: 10000 });

      expect(same.status).toBe(0);
      expect(same.stdout).toContain("PASS");
      expect(other.status).toBe(20);
      expect(other.stderr).toContain("chain location");
      expect(other.stdout).not.toContain("PASS");
    },
  );
});
