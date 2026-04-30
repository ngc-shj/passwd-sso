import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, unlinkSync, chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, createHmac, createPrivateKey, sign as nodeSign } from "node:crypto";

// --- Helpers for building a minimal signed JWS ---

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
    deploymentId: "deploy-test-001",
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

function craftJwsWithKid(kid: string): string {
  // Build a JWS with an arbitrary (possibly invalid) kid without signing correctly
  const headerObj = { alg: "EdDSA", kid, typ: AUDIT_ANCHOR_TYP };
  const payload = Buffer.from(JSON.stringify({ dummy: true }), "utf-8");
  const headerB64 = b64urlEncode(Buffer.from(JSON.stringify(headerObj), "utf-8"));
  const payloadB64 = b64urlEncode(payload);
  const sigB64 = b64urlEncode(Buffer.alloc(64)); // zero signature
  return `${headerB64}.${payloadB64}.${sigB64}`;
}

// --- Import module under test (after mocks) ---

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual };
});

const {
  auditVerifyCommand,
  InsecureTagSecretFileError,
  InvalidKidError,
  InvalidTenantIdFormatError,
} = await import("../../commands/audit-verify.js");

// --- Tests ---

describe("auditVerifyCommand", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "audit-verify-test-"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Cleanup temp files created during tests
  });

  describe("tag-secret-file mode 0644 rejected (closes TF4)", () => {
    it("throws InsecureTagSecretFileError when file has group-readable permissions", async () => {
      const secretPath = join(tmpDir, "secret.hex");
      writeFileSync(secretPath, "a".repeat(64), { mode: 0o600 });
      chmodSync(secretPath, 0o644);

      await expect(
        auditVerifyCommand({
          manifest: "/nonexistent.jws",
          tagSecretFile: secretPath,
        }),
      ).rejects.toThrow(InsecureTagSecretFileError);
    });

    it("throws InsecureTagSecretFileError when file has world-readable permissions (0o604)", async () => {
      const secretPath = join(tmpDir, "secret2.hex");
      writeFileSync(secretPath, "b".repeat(64), { mode: 0o600 });
      chmodSync(secretPath, 0o604);

      await expect(
        auditVerifyCommand({
          manifest: "/nonexistent.jws",
          tagSecretFile: secretPath,
        }),
      ).rejects.toThrow(InsecureTagSecretFileError);
    });
  });

  describe("tag-secret-file mode 0600 succeeds (reads secret)", () => {
    it("does not throw InsecureTagSecretFileError with mode 0600", async () => {
      const secretPath = join(tmpDir, "secret-ok.hex");
      // 32 bytes = 64 hex chars
      const tagHex = Buffer.alloc(32, 0xab).toString("hex");
      writeFileSync(secretPath, tagHex + "\n", { mode: 0o600 });

      // Generate a real key pair and manifest
      const { privateKey } = generateKeyPairSync("ed25519");
      const privateKeySeed = privateKey.export({ type: "pkcs8", format: "der" }).subarray(
        ED25519_PKCS8_PREFIX.length,
      );
      const kid = `${AUDIT_ANCHOR_KID_PREFIX}testkey01`;
      const manifest = buildMinimalManifest();
      const jws = signManifest(manifest, privateKeySeed, kid);

      const jwsPath = join(tmpDir, "manifest.jws");
      writeFileSync(jwsPath, jws);

      const { publicKey } = generateKeyPairSync("ed25519");
      // We need the MATCHING public key — re-derive from signing
      const signingPriv = createPrivateKey({
        key: Buffer.concat([ED25519_PKCS8_PREFIX, privateKeySeed]),
        format: "der",
        type: "pkcs8",
      });
      // Import the real private key and get matching public
      const { createPublicKey } = await import("node:crypto");
      const pubKeyObj = createPublicKey(signingPriv);
      const pubDer = pubKeyObj.export({ type: "spki", format: "der" }) as Buffer;
      const pubHex = pubDer.subarray(ED25519_SPKI_PREFIX.length).toString("hex");

      const pubPath = join(tmpDir, "key.pub");
      writeFileSync(pubPath, pubHex);

      // Should not throw InsecureTagSecretFileError (may throw other errors based on content)
      const promise = auditVerifyCommand({
        manifest: jwsPath,
        publicKey: pubPath,
        tagSecretFile: secretPath,
      });

      // The tagSecret hex is 64 chars but tagSecret must be 32 bytes — the signature IS valid
      // This should resolve successfully (PASS)
      await expect(promise).resolves.toBeUndefined();
    });
  });

  describe("--tag-secret on CLI emits WARN to stderr", () => {
    it("writes WARN message to stderr when --tag-secret is used", async () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      // Generate a valid JWS for this test
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const privateKeySeed = (privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).subarray(
        ED25519_PKCS8_PREFIX.length,
      );
      const pubDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
      const pubHex = pubDer.subarray(ED25519_SPKI_PREFIX.length).toString("hex");

      const kid = `${AUDIT_ANCHOR_KID_PREFIX}warntest1`;
      const manifest = buildMinimalManifest();
      const jws = signManifest(manifest, privateKeySeed, kid);

      const jwsPath = join(tmpDir, "manifest-warn.jws");
      const pubPath = join(tmpDir, "key-warn.pub");
      writeFileSync(jwsPath, jws);
      writeFileSync(pubPath, pubHex);

      const tagHex = Buffer.alloc(32, 0x01).toString("hex");

      await auditVerifyCommand({
        manifest: jwsPath,
        publicKey: pubPath,
        tagSecret: tagHex,
      });

      const allWrites = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(allWrites).toContain("WARN");
      expect(allWrites).toContain("shell history");

      stderrSpy.mockRestore();
    });
  });

  describe("kid path-traversal rejection (closes plan N7)", () => {
    it("rejects kid '../etc/passwd' before any URL fetch", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const jws = craftJwsWithKid("../etc/passwd");
      const jwsPath = join(tmpDir, "traversal.jws");
      writeFileSync(jwsPath, jws);

      await expect(
        auditVerifyCommand({
          manifest: jwsPath,
          publicKey: join(tmpDir, "nonexistent.pub"),
        }),
      ).rejects.toThrow(InvalidKidError);

      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it("rejects kid with percent-encoded path separator", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const jws = craftJwsWithKid(`${AUDIT_ANCHOR_KID_PREFIX}..%2f..`);
      const jwsPath = join(tmpDir, "traversal2.jws");
      writeFileSync(jwsPath, jws);

      await expect(
        auditVerifyCommand({
          manifest: jwsPath,
          publicKey: join(tmpDir, "nonexistent.pub"),
        }),
      ).rejects.toThrow(InvalidKidError);

      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it("rejects kid with slash character", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const jws = craftJwsWithKid(`${AUDIT_ANCHOR_KID_PREFIX}test/key`);
      const jwsPath = join(tmpDir, "traversal3.jws");
      writeFileSync(jwsPath, jws);

      await expect(
        auditVerifyCommand({
          manifest: jwsPath,
          publicKey: join(tmpDir, "nonexistent.pub"),
        }),
      ).rejects.toThrow(InvalidKidError);

      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });
  });

  describe("--my-tenant-id validation (closes RT7)", () => {
    it("throws InvalidTenantIdFormatError for uppercase UUID", async () => {
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const privateKeySeed = (privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).subarray(
        ED25519_PKCS8_PREFIX.length,
      );
      const pubDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
      const pubHex = pubDer.subarray(ED25519_SPKI_PREFIX.length).toString("hex");

      const kid = `${AUDIT_ANCHOR_KID_PREFIX}tnidtest1`;
      const manifest = buildMinimalManifest();
      const jws = signManifest(manifest, privateKeySeed, kid);

      const jwsPath = join(tmpDir, "manifest-tnid.jws");
      const pubPath = join(tmpDir, "key-tnid.pub");
      writeFileSync(jwsPath, jws);
      writeFileSync(pubPath, pubHex);

      const tagHex = Buffer.alloc(32, 0x02).toString("hex");

      await expect(
        auditVerifyCommand({
          manifest: jwsPath,
          publicKey: pubPath,
          myTenantId: "A1B2C3D4-1234-1234-1234-ABCDEF123456",
          tagSecret: tagHex,
        }),
      ).rejects.toThrow(InvalidTenantIdFormatError);
    });

    it("throws InvalidTenantIdFormatError for UUID without hyphens", async () => {
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const privateKeySeed = (privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).subarray(
        ED25519_PKCS8_PREFIX.length,
      );
      const pubDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
      const pubHex = pubDer.subarray(ED25519_SPKI_PREFIX.length).toString("hex");

      const kid = `${AUDIT_ANCHOR_KID_PREFIX}tnidtest2`;
      const manifest = buildMinimalManifest();
      const jws = signManifest(manifest, privateKeySeed, kid);

      const jwsPath = join(tmpDir, "manifest-tnid2.jws");
      const pubPath = join(tmpDir, "key-tnid2.pub");
      writeFileSync(jwsPath, jws);
      writeFileSync(pubPath, pubHex);

      const tagHex = Buffer.alloc(32, 0x03).toString("hex");

      await expect(
        auditVerifyCommand({
          manifest: jwsPath,
          publicKey: pubPath,
          myTenantId: "a1b2c3d41234123412341234abcdef123456",
          tagSecret: tagHex,
        }),
      ).rejects.toThrow(InvalidTenantIdFormatError);
    });
  });

  describe("secret redaction (closes plan T14)", () => {
    it("does not include --tag-secret hex value in any stdout/stderr output", async () => {
      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];

      const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        stdoutLines.push(String(chunk));
        return true;
      });
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        stderrLines.push(String(chunk));
        return true;
      });

      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const privateKeySeed = (privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).subarray(
        ED25519_PKCS8_PREFIX.length,
      );
      const pubDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
      const pubHex = pubDer.subarray(ED25519_SPKI_PREFIX.length).toString("hex");

      const kid = `${AUDIT_ANCHOR_KID_PREFIX}redacttest`;
      const manifest = buildMinimalManifest();
      const jws = signManifest(manifest, privateKeySeed, kid);

      const jwsPath = join(tmpDir, "manifest-redact.jws");
      const pubPath = join(tmpDir, "key-redact.pub");
      writeFileSync(jwsPath, jws);
      writeFileSync(pubPath, pubHex);

      // Use a distinctive hex value that should never appear in output
      const secretHex = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

      try {
        await auditVerifyCommand({
          manifest: jwsPath,
          publicKey: pubPath,
          tagSecret: secretHex,
        });
      } catch {
        // Errors are OK — we just want to check redaction
      }

      const allOutput = [...stdoutLines, ...stderrLines].join("");
      expect(allOutput).not.toContain(secretHex);

      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    });
  });

  describe("option parsing happy path", () => {
    it("accepts --manifest with a valid path and resolves", async () => {
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const privateKeySeed = (privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).subarray(
        ED25519_PKCS8_PREFIX.length,
      );
      const pubDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
      const pubHex = pubDer.subarray(ED25519_SPKI_PREFIX.length).toString("hex");

      const kid = `${AUDIT_ANCHOR_KID_PREFIX}parsepath1`;
      const manifest = buildMinimalManifest();
      const jws = signManifest(manifest, privateKeySeed, kid);

      const jwsPath = join(tmpDir, "happy.jws");
      const pubPath = join(tmpDir, "happy.pub");
      writeFileSync(jwsPath, jws);
      writeFileSync(pubPath, pubHex);

      const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      await auditVerifyCommand({ manifest: jwsPath, publicKey: pubPath });
      const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toContain("PASS");
      stdoutSpy.mockRestore();
    });
  });
});
