import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  computeTenantTag,
  buildManifest,
  canonicalize,
  sign,
  verify,
  validateTenantIdCanonical,
  InvalidAlgorithmError,
  InvalidTypError,
  InvalidSignatureError,
  InvalidTenantIdFormatError,
  InvalidKidError,
  ManifestSchemaValidationError,
  type AnchorRow,
  type BuildManifestInput,
} from "@/lib/audit/anchor-manifest";
import { AUDIT_ANCHOR_TYP, AUDIT_ANCHOR_KID_PREFIX } from "@/lib/constants/audit/audit";

// Known test fixtures
const KNOWN_UUID = "550e8400-e29b-41d4-a716-446655440000";
// 32 bytes of 0x42
const TAG_SECRET_A = Buffer.alloc(32, 0x42);
// 32 bytes of 0x53
const TAG_SECRET_B = Buffer.alloc(32, 0x53);

// Golden tag hex computed offline:
//   printf 'audit-anchor-tag-v1\x00550e8400-e29b-41d4-a716-446655440000' | \
//   openssl dgst -sha256 -mac HMAC -macopt hexkey:<42*32>
// Result: 6db2cb938b211a0b0824844113d78dd8aaafbeb608b6a2fc3903aa5114c03323
const GOLDEN_TAG_A = "6db2cb938b211a0b0824844113d78dd8aaafbeb608b6a2fc3903aa5114c03323";

// Golden tag hex with TAG_SECRET_B:
// Result: fa44a6be534429d07f571d2399828ad8e65f469519e3ab6aa7465329ffd099dc
const GOLDEN_TAG_B = "fa44a6be534429d07f571d2399828ad8e65f469519e3ab6aa7465329ffd099dc";

const VALID_KID = `${AUDIT_ANCHOR_KID_PREFIX}abcd1234`;

function makeMinimalInput(overrides: Partial<BuildManifestInput> = {}): BuildManifestInput {
  return {
    tenants: [
      {
        tenantId: KNOWN_UUID,
        chainSeq: 5n,
        prevHash: Buffer.alloc(32, 0xab),
        epoch: 1,
      },
    ],
    deploymentId: "deploy-test-1",
    anchoredAt: new Date("2026-05-01T00:05:00.000Z"),
    previousManifest: null,
    tagSecret: TAG_SECRET_A,
    ...overrides,
  };
}

function makeEd25519Keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPublic = publicKey.export({ type: "spki", format: "der" }).slice(12);
  const rawPrivate = privateKey.export({ type: "pkcs8", format: "der" }).slice(16);
  return {
    publicKeyRaw: Buffer.from(rawPublic),
    privateKeyRaw: Buffer.from(rawPrivate),
  };
}

describe("computeTenantTag", () => {
  it("returns golden vector for known UUID and secret", () => {
    const tag = computeTenantTag(KNOWN_UUID, TAG_SECRET_A);
    expect(tag).toBe(GOLDEN_TAG_A);
  });

  it("rejects UPPERCASE UUID — InvalidTenantIdFormatError", () => {
    expect(() =>
      computeTenantTag("550E8400-E29B-41D4-A716-446655440000", TAG_SECRET_A),
    ).toThrow(InvalidTenantIdFormatError);
  });

  it("rejects UUID without hyphens", () => {
    expect(() =>
      computeTenantTag("550e8400e29b41d4a716446655440000", TAG_SECRET_A),
    ).toThrow(InvalidTenantIdFormatError);
  });

  it("rejects short string", () => {
    expect(() => computeTenantTag("abc", TAG_SECRET_A)).toThrow(
      InvalidTenantIdFormatError,
    );
  });

  it("produces different tags for same UUID with different secrets (cross-deployment isolation)", () => {
    const tagA = computeTenantTag(KNOWN_UUID, TAG_SECRET_A);
    const tagB = computeTenantTag(KNOWN_UUID, TAG_SECRET_B);
    expect(tagA).toBe(GOLDEN_TAG_A);
    expect(tagB).toBe(GOLDEN_TAG_B);
    expect(tagA).not.toBe(tagB);
  });

  it("throws when tagSecret is not 32 bytes", () => {
    expect(() =>
      computeTenantTag(KNOWN_UUID, Buffer.alloc(16, 0x42)),
    ).toThrow("tagSecret must be exactly 32 bytes");
  });
});

describe("validateTenantIdCanonical", () => {
  it("accepts valid canonical UUID", () => {
    expect(() => validateTenantIdCanonical(KNOWN_UUID)).not.toThrow();
  });

  it("rejects mixed-case UUID", () => {
    expect(() =>
      validateTenantIdCanonical("550E8400-e29b-41d4-a716-446655440000"),
    ).toThrow(InvalidTenantIdFormatError);
  });

  it("rejects empty string", () => {
    expect(() => validateTenantIdCanonical("")).toThrow(InvalidTenantIdFormatError);
  });
});

describe("buildManifest", () => {
  it("happy path: 2 tenants → valid manifest with correct tenantTag values", () => {
    const secondUUID = "660e8400-e29b-41d4-a716-446655440001";
    const input: BuildManifestInput = {
      tenants: [
        {
          tenantId: KNOWN_UUID,
          chainSeq: 5n,
          prevHash: Buffer.alloc(32, 0xab),
          epoch: 1,
        },
        {
          tenantId: secondUUID,
          chainSeq: 10n,
          prevHash: Buffer.alloc(32, 0xcd),
          epoch: 2,
        },
      ],
      deploymentId: "deploy-test-1",
      anchoredAt: new Date("2026-05-01T00:05:00.000Z"),
      previousManifest: null,
      tagSecret: TAG_SECRET_A,
    };

    const manifest = buildManifest(input);

    expect(manifest.version).toBe(1);
    expect(manifest.issuer).toBe("passwd-sso");
    expect(manifest.deploymentId).toBe("deploy-test-1");
    expect(manifest.anchoredAt).toBe("2026-05-01T00:05:00.000Z");
    expect(manifest.previousManifest).toBeNull();
    expect(manifest.tenants).toHaveLength(2);

    // Verify tenantTag values match direct computeTenantTag calls
    expect(manifest.tenants[0].tenantTag).toBe(
      computeTenantTag(KNOWN_UUID, TAG_SECRET_A),
    );
    expect(manifest.tenants[1].tenantTag).toBe(
      computeTenantTag(secondUUID, TAG_SECRET_A),
    );

    // Verify chainSeq serialized as string
    expect(manifest.tenants[0].chainSeq).toBe("5");
    expect(manifest.tenants[1].chainSeq).toBe("10");
  });

  it("produces anchoredAt with Z suffix", () => {
    const manifest = buildManifest(makeMinimalInput());
    expect(manifest.anchoredAt).toMatch(/Z$/);
  });

  it("rejects uppercase tenantId", () => {
    expect(() =>
      buildManifest(
        makeMinimalInput({
          tenants: [
            {
              tenantId: "550E8400-e29b-41d4-a716-446655440000",
              chainSeq: 1n,
              prevHash: Buffer.from([0x00]),
              epoch: 1,
            },
          ],
        }),
      ),
    ).toThrow(InvalidTenantIdFormatError);
  });

  it("rejects epoch 0 via schema validation", () => {
    expect(() =>
      buildManifest(
        makeMinimalInput({
          tenants: [
            {
              tenantId: KNOWN_UUID,
              chainSeq: 1n,
              prevHash: Buffer.from([0x00]),
              epoch: 0,
            },
          ],
        }),
      ),
    ).toThrow(ManifestSchemaValidationError);
  });
});

describe("canonicalize", () => {
  it("returns deterministic UTF-8 Buffer of JCS canonical form", () => {
    const manifest = buildManifest(makeMinimalInput());
    const bytes = canonicalize(manifest);
    expect(bytes).toBeInstanceOf(Buffer);
    // JCS sorts keys — $schema comes first alphabetically
    expect(bytes.toString("utf-8")).toMatch(/^\{"\$schema":/);
  });

  it("produces identical bytes regardless of runtime object key order", () => {
    const manifest = buildManifest(makeMinimalInput());
    const bytes1 = canonicalize(manifest);
    const bytes2 = canonicalize(manifest);
    expect(bytes1.equals(bytes2)).toBe(true);
  });
});

describe("sign + verify round-trip", () => {
  it("signs and verifies manifest returning equal manifest", () => {
    const { publicKeyRaw, privateKeyRaw } = makeEd25519Keypair();
    const manifest = buildManifest(makeMinimalInput());
    const canonical = canonicalize(manifest);
    const jws = sign(canonical, privateKeyRaw, VALID_KID);
    const verified = verify(jws, publicKeyRaw);

    expect(verified.version).toBe(manifest.version);
    expect(verified.issuer).toBe(manifest.issuer);
    expect(verified.deploymentId).toBe(manifest.deploymentId);
    expect(verified.anchoredAt).toBe(manifest.anchoredAt);
    expect(verified.tenants).toHaveLength(manifest.tenants.length);
    expect(verified.tenants[0].tenantTag).toBe(manifest.tenants[0].tenantTag);
  });

  it("JWS has 3 dot-separated parts", () => {
    const { privateKeyRaw } = makeEd25519Keypair();
    const manifest = buildManifest(makeMinimalInput());
    const jws = sign(canonicalize(manifest), privateKeyRaw, VALID_KID);
    expect(jws.split(".")).toHaveLength(3);
  });
});

describe("sign — invalid kid", () => {
  it("rejects kid without required prefix", () => {
    const { privateKeyRaw } = makeEd25519Keypair();
    const canonical = canonicalize(buildManifest(makeMinimalInput()));
    expect(() => sign(canonical, privateKeyRaw, "bad-kid-xyz")).toThrow(
      InvalidKidError,
    );
  });

  it("rejects kid with suffix shorter than 8 chars", () => {
    const { privateKeyRaw } = makeEd25519Keypair();
    const canonical = canonicalize(buildManifest(makeMinimalInput()));
    expect(() =>
      sign(canonical, privateKeyRaw, `${AUDIT_ANCHOR_KID_PREFIX}abc`),
    ).toThrow(InvalidKidError);
  });
});

describe("verify — algorithm rejection", () => {
  function tamperHeader(jws: string, overrides: Record<string, unknown>): string {
    const [headerB64, payloadB64, sigB64] = jws.split(".");
    const header = JSON.parse(
      Buffer.from(
        headerB64.replace(/-/g, "+").replace(/_/g, "/") +
          "=".repeat((4 - (headerB64.length % 4)) % 4),
        "base64",
      ).toString("utf-8"),
    ) as Record<string, unknown>;
    const tamperedHeader = { ...header, ...overrides };
    const newHeaderB64 = Buffer.from(JSON.stringify(tamperedHeader), "utf-8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
    return `${newHeaderB64}.${payloadB64}.${sigB64}`;
  }

  it('rejects alg: "none"', () => {
    const { publicKeyRaw, privateKeyRaw } = makeEd25519Keypair();
    const jws = sign(
      canonicalize(buildManifest(makeMinimalInput())),
      privateKeyRaw,
      VALID_KID,
    );
    const tampered = tamperHeader(jws, { alg: "none" });
    expect(() => verify(tampered, publicKeyRaw)).toThrow(InvalidAlgorithmError);
  });

  it('rejects alg: "HS256"', () => {
    const { publicKeyRaw, privateKeyRaw } = makeEd25519Keypair();
    const jws = sign(
      canonicalize(buildManifest(makeMinimalInput())),
      privateKeyRaw,
      VALID_KID,
    );
    const tampered = tamperHeader(jws, { alg: "HS256" });
    expect(() => verify(tampered, publicKeyRaw)).toThrow(InvalidAlgorithmError);
  });

  it('rejects alg: "RS256"', () => {
    const { publicKeyRaw, privateKeyRaw } = makeEd25519Keypair();
    const jws = sign(
      canonicalize(buildManifest(makeMinimalInput())),
      privateKeyRaw,
      VALID_KID,
    );
    const tampered = tamperHeader(jws, { alg: "RS256" });
    expect(() => verify(tampered, publicKeyRaw)).toThrow(InvalidAlgorithmError);
  });

  it("rejects alg: undefined", () => {
    const { publicKeyRaw, privateKeyRaw } = makeEd25519Keypair();
    const jws = sign(
      canonicalize(buildManifest(makeMinimalInput())),
      privateKeyRaw,
      VALID_KID,
    );
    // Remove alg field
    const [headerB64, payloadB64, sigB64] = jws.split(".");
    const header = JSON.parse(
      Buffer.from(
        headerB64.replace(/-/g, "+").replace(/_/g, "/") +
          "=".repeat((4 - (headerB64.length % 4)) % 4),
        "base64",
      ).toString("utf-8"),
    ) as Record<string, unknown>;
    const { alg: _alg, ...noAlg } = header;
    const newHeaderB64 = Buffer.from(JSON.stringify(noAlg), "utf-8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
    const tampered = `${newHeaderB64}.${payloadB64}.${sigB64}`;
    expect(() => verify(tampered, publicKeyRaw)).toThrow(InvalidAlgorithmError);
  });

  it("rejects wrong typ", () => {
    const { publicKeyRaw, privateKeyRaw } = makeEd25519Keypair();
    const jws = sign(
      canonicalize(buildManifest(makeMinimalInput())),
      privateKeyRaw,
      VALID_KID,
    );
    const tampered = tamperHeader(jws, { typ: "wrong-typ" });
    expect(() => verify(tampered, publicKeyRaw)).toThrow(InvalidTypError);
  });
});

describe("verify — payload tampering", () => {
  it("rejects tampered payload", () => {
    const { publicKeyRaw, privateKeyRaw } = makeEd25519Keypair();
    const manifest = buildManifest(makeMinimalInput());
    const jws = sign(canonicalize(manifest), privateKeyRaw, VALID_KID);
    const [headerB64, , sigB64] = jws.split(".");

    // Replace payload with a modified manifest
    const altManifest = buildManifest(
      makeMinimalInput({ deploymentId: "evil-deploy" }),
    );
    const altPayloadB64 = Buffer.from(JSON.stringify(altManifest), "utf-8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");

    const tampered = `${headerB64}.${altPayloadB64}.${sigB64}`;
    expect(() => verify(tampered, publicKeyRaw)).toThrow(InvalidSignatureError);
  });

  it("rejects bad signature bytes", () => {
    const { publicKeyRaw, privateKeyRaw } = makeEd25519Keypair();
    const manifest = buildManifest(makeMinimalInput());
    const jws = sign(canonicalize(manifest), privateKeyRaw, VALID_KID);
    const [headerB64, payloadB64] = jws.split(".");

    // Replace signature with 64 zero bytes
    const badSig = Buffer.alloc(64, 0)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");

    const tampered = `${headerB64}.${payloadB64}.${badSig}`;
    expect(() => verify(tampered, publicKeyRaw)).toThrow(InvalidSignatureError);
  });
});
