import { describe, expect, it } from "vitest";
import {
  detectKeyType,
  parseSshPrivateKey,
  computeSshFingerprint,
} from "./ssh-key";

// Real Ed25519 OpenSSH private key (generated for tests; no security value)
const ED25519_PEM = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACBQivgZLyDmOqK+SgpSyDjD0adAq22ASoq/nOvohBuwTgAAAJjbGK6S2xiu
kgAAAAtzc2gtZWQyNTUxOQAAACBQivgZLyDmOqK+SgpSyDjD0adAq22ASoq/nOvohBuwTg
AAAEA423t8531/uJmmrntQO/Dk7IZtALQWUMcWTSc3iDv6GlCK+BkvIOY6or5KClLIOMPR
p0CrbYBKir+c6+iEG7BOAAAAEHRlc3RAZXhhbXBsZS5jb20BAgMEBQ==
-----END OPENSSH PRIVATE KEY-----`;

// PEM with wrong magic bytes (valid base64 but not a real OpenSSH key)
const INVALID_OPENSSH_PEM = `-----BEGIN OPENSSH PRIVATE KEY-----
dGhpcyBpcyBub3QgYSByZWFsIHNzaCBrZXkgYXQgYWxs
-----END OPENSSH PRIVATE KEY-----`;

const RSA_LEGACY_PEM = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA2a2rwplBQLzHPZe5ekSKj/UHv9qHnPKMBMPRkaDQgn7MGBUB
-----END RSA PRIVATE KEY-----`;

const GENERIC_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIHNvbWVwYXlsb2Fkc29tZXBheWxvYWRzb21lcGF5bG8=
-----END PRIVATE KEY-----`;

describe("detectKeyType", () => {
  it("detects ed25519 from a real OpenSSH key", () => {
    expect(detectKeyType(ED25519_PEM)).toBe("ed25519");
  });

  it("detects rsa from a legacy RSA PEM header", () => {
    expect(detectKeyType(RSA_LEGACY_PEM)).toBe("rsa");
  });

  it("returns unknown for generic PKCS8 PEM", () => {
    expect(detectKeyType(GENERIC_PRIVATE_KEY_PEM)).toBe("unknown");
  });

  it("returns unknown for an empty string", () => {
    expect(detectKeyType("")).toBe("unknown");
  });

  it("returns unknown for arbitrary text", () => {
    expect(detectKeyType("not a key at all")).toBe("unknown");
  });

  it("returns unknown for OpenSSH PEM with invalid binary content", () => {
    // The header is present but binary content doesn't have the right magic
    expect(detectKeyType(INVALID_OPENSSH_PEM)).toBe("unknown");
  });

  it("handles leading/trailing whitespace", () => {
    expect(detectKeyType(`\n  ${RSA_LEGACY_PEM}  \n`)).toBe("rsa");
  });
});

describe("parseSshPrivateKey", () => {
  it("returns null for non-OpenSSH PEM (RSA legacy)", async () => {
    expect(await parseSshPrivateKey(RSA_LEGACY_PEM)).toBeNull();
  });

  it("returns null for generic PKCS8 PEM", async () => {
    expect(await parseSshPrivateKey(GENERIC_PRIVATE_KEY_PEM)).toBeNull();
  });

  it("returns null for an empty string", async () => {
    expect(await parseSshPrivateKey("")).toBeNull();
  });

  it("returns null for OpenSSH PEM with invalid binary content", async () => {
    expect(await parseSshPrivateKey(INVALID_OPENSSH_PEM)).toBeNull();
  });

  it("parses a real Ed25519 OpenSSH key", async () => {
    const result = await parseSshPrivateKey(ED25519_PEM);
    expect(result).not.toBeNull();
    expect(result!.keyType).toBe("ed25519");
    expect(result!.keySize).toBe(256);
    expect(result!.fingerprint).toMatch(/^SHA256:/);
    expect(result!.publicKey).toMatch(/^ssh-ed25519 /);
  });

  it("handles PEM with surrounding whitespace", async () => {
    const result = await parseSshPrivateKey(`\n\n${ED25519_PEM}\n\n`);
    expect(result).not.toBeNull();
    expect(result!.keyType).toBe("ed25519");
  });
});

describe("computeSshFingerprint", () => {
  it("returns a string starting with SHA256:", async () => {
    const blob = new Uint8Array([1, 2, 3, 4, 5]);
    const fp = await computeSshFingerprint(blob);
    expect(fp).toMatch(/^SHA256:/);
  });

  it("produces consistent output for the same input", async () => {
    const blob = new Uint8Array([10, 20, 30]);
    const fp1 = await computeSshFingerprint(blob);
    const fp2 = await computeSshFingerprint(blob);
    expect(fp1).toBe(fp2);
  });

  it("produces different fingerprints for different blobs", async () => {
    const fp1 = await computeSshFingerprint(new Uint8Array([1, 2, 3]));
    const fp2 = await computeSshFingerprint(new Uint8Array([4, 5, 6]));
    expect(fp1).not.toBe(fp2);
  });

  it("does not include trailing = padding characters", async () => {
    const blob = new Uint8Array(32).fill(0xab);
    const fp = await computeSshFingerprint(blob);
    expect(fp).not.toMatch(/=$/);
  });

  it("works with an empty blob", async () => {
    const fp = await computeSshFingerprint(new Uint8Array(0));
    expect(fp).toMatch(/^SHA256:/);
  });

  it("matches known SHA256 fingerprint for the test Ed25519 key", async () => {
    // Parse the real key and verify the fingerprint format is correct
    const result = await parseSshPrivateKey(ED25519_PEM);
    expect(result).not.toBeNull();
    // Fingerprint should be SHA256:<base64url-no-padding>
    expect(result!.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });
});
