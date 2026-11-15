import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  computeTenantTag,
  buildManifest,
  canonicalize,
  chainLocationFor,
  kidForPublicKey,
  parsePublicKeyHex,
  publicKeyForSigningKey,
  readJwsKid,
  sign,
  signStatement,
  verify,
  verifyStatement,
  validateTenantIdCanonical,
  InvalidAlgorithmError,
  InvalidTypError,
  InvalidSignatureError,
  InvalidTenantIdFormatError,
  InvalidKidError,
  InvalidPublicKeyError,
  KidMismatchError,
  ManifestSchemaValidationError,
  type BuildManifestInput,
} from "@/lib/audit/anchor-manifest";
import {
  AUDIT_ANCHOR_CHAIN_LOCATION_DOMAIN,
  AUDIT_ANCHOR_KID_PREFIX,
  AUDIT_ANCHOR_MANIFEST_VERSION,
  AUDIT_ANCHOR_STATEMENT_TYP,
  AUDIT_ANCHOR_TYP,
} from "@/lib/constants/audit/audit";

// The vectors the CLI verifier is held to as well
// (cli/src/__tests__/unit/audit-verify-vectors.test.ts reads the same file).
type Vectors = {
  key: { seedHex: string; publicKeyHex: string; kid: string };
  manifest: Record<string, unknown>;
  manifestV2: Record<string, unknown> & { chainLocation: string };
  chainLocations: Array<{ location: string; chainLocation: string }>;
  jws: Array<{ name: string; jws: string; expect: string }>;
  publicKeyTexts: Array<{ name: string; text: string; valid: boolean }>;
};
const VECTORS = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../cli/src/__tests__/fixtures/audit-anchor-vectors.json", import.meta.url)),
    "utf8",
  ),
) as Vectors;

// Known test fixtures
const LOCATION = "s3://example-bucket/audit-anchors";
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
    location: LOCATION,
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
      location: LOCATION,
    };

    const manifest = buildManifest(input);

    expect(manifest.version).toBe(2);
    expect(manifest.version).toBe(AUDIT_ANCHOR_MANIFEST_VERSION);
    expect(manifest.$schema).toBe("https://passwd-sso.example/schemas/audit-anchor-manifest-v2.json");
    expect(manifest.chainLocation).toBe(chainLocationFor(LOCATION));
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

  it("binds the manifest to the location it is given, and to no other", () => {
    const here = buildManifest(makeMinimalInput());
    const elsewhere = buildManifest(makeMinimalInput({ location: "s3://example-bucket/other-prefix" }));

    expect(here.chainLocation).toBe(chainLocationFor(LOCATION));
    expect(elsewhere.chainLocation).toBe(chainLocationFor("s3://example-bucket/other-prefix"));
    expect(elsewhere.chainLocation).not.toBe(here.chainLocation);
    expect(canonicalize(elsewhere).equals(canonicalize(here))).toBe(false);
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

  it("rejects prevHash of invalid length (not 32-byte hash or 1-byte genesis) via schema validation", () => {
    // 15 bytes = 30 hex chars — neither 64-char SHA-256 nor 2-char genesis
    expect(() =>
      buildManifest(
        makeMinimalInput({
          tenants: [
            {
              tenantId: KNOWN_UUID,
              chainSeq: 1n,
              prevHash: Buffer.alloc(15, 0xab),
              epoch: 1,
            },
          ],
        }),
      ),
    ).toThrow(ManifestSchemaValidationError);
  });
});

describe("chainLocationFor", () => {
  it.each(VECTORS.chainLocations)("shared vector: $location", ({ location, chainLocation }) => {
    expect(chainLocationFor(location)).toBe(chainLocation);
  });

  it("is 64 lower-case hex chars that name no part of the location", () => {
    const hash = chainLocationFor(LOCATION);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain("example");
  });

  it("is domain separated: not the bare SHA-256 of the location", async () => {
    const { createHash } = await import("node:crypto");
    expect(chainLocationFor(LOCATION)).not.toBe(createHash("sha256").update(LOCATION).digest("hex"));
    expect(chainLocationFor(LOCATION)).toBe(
      createHash("sha256").update(`${AUDIT_ANCHOR_CHAIN_LOCATION_DOMAIN}\0${LOCATION}`).digest("hex"),
    );
  });

  it("tells a bucket with no prefix from a prefix under it, and one store from another", () => {
    const hashes = VECTORS.chainLocations.map((v) => v.chainLocation);
    expect(VECTORS.chainLocations.length).toBeGreaterThanOrEqual(4);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("the version 2 vector manifest carries the first location's hash", () => {
    expect(VECTORS.manifestV2.chainLocation).toBe(VECTORS.chainLocations[0].chainLocation);
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
    const jws = sign(canonical, privateKeyRaw);
    const verified = verify(jws, publicKeyRaw);

    expect(verified).toEqual(manifest);
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
    const jws = sign(canonicalize(manifest), privateKeyRaw);
    expect(jws.split(".")).toHaveLength(3);
  });
});

function decodeHeader(jws: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jws.split(".")[0], "base64url").toString("utf-8")) as Record<string, unknown>;
}

function withHeader(jws: string, overrides: Record<string, unknown>): string {
  const [, payloadB64, sigB64] = jws.split(".");
  const header = Buffer.from(JSON.stringify({ ...decodeHeader(jws), ...overrides }), "utf-8").toString("base64url");
  return `${header}.${payloadB64}.${sigB64}`;
}

describe("kid derivation", () => {
  const seed = Buffer.from(VECTORS.key.seedHex, "hex");
  const publicKey = Buffer.from(VECTORS.key.publicKeyHex, "hex");

  it("derives the vector's public key from its seed", () => {
    expect(publicKeyForSigningKey(seed).toString("hex")).toBe(VECTORS.key.publicKeyHex);
  });

  it("derives the vector's kid: the prefix and the public key's first 8 bytes in hex", () => {
    expect(kidForPublicKey(publicKey)).toBe(VECTORS.key.kid);
    expect(VECTORS.key.kid).toBe(`${AUDIT_ANCHOR_KID_PREFIX}${VECTORS.key.publicKeyHex.slice(0, 16)}`);
  });

  it("derives the kid from the public key, not the seed", () => {
    expect(kidForPublicKey(publicKey)).not.toBe(`${AUDIT_ANCHOR_KID_PREFIX}${VECTORS.key.seedHex.slice(0, 16)}`);
  });

  it("matches a generated key pair's own public key", () => {
    const { publicKeyRaw, privateKeyRaw } = makeEd25519Keypair();
    expect(publicKeyForSigningKey(privateKeyRaw)).toEqual(publicKeyRaw);
  });

  it.each([31, 33, 0])("refuses a public key of %d bytes", (length) => {
    expect(() => kidForPublicKey(Buffer.alloc(length, 1))).toThrow(InvalidPublicKeyError);
  });

  it.each([31, 33, 64])("refuses a seed of %d bytes", (length) => {
    expect(() => publicKeyForSigningKey(Buffer.alloc(length, 1))).toThrow("signing key must be exactly 32 bytes");
    expect(() => sign(Buffer.from("{}"), Buffer.alloc(length, 1))).toThrow("signing key must be exactly 32 bytes");
  });
});

describe("parsePublicKeyHex — shared vectors", () => {
  it.each(VECTORS.publicKeyTexts.filter((v) => v.valid))("accepts $name", ({ text }) => {
    expect(parsePublicKeyHex(text).toString("hex")).toBe(VECTORS.key.publicKeyHex);
  });

  it.each(VECTORS.publicKeyTexts.filter((v) => !v.valid))("refuses $name", ({ text }) => {
    expect(() => parsePublicKeyHex(text)).toThrow(InvalidPublicKeyError);
  });

  it("covers both outcomes", () => {
    expect(VECTORS.publicKeyTexts.filter((v) => v.valid).length).toBeGreaterThanOrEqual(2);
    expect(VECTORS.publicKeyTexts.filter((v) => !v.valid).length).toBeGreaterThanOrEqual(4);
  });
});

describe("sign — the header", () => {
  it("names the signing key's own kid and the manifest typ, in the order alg, kid, typ", () => {
    const { publicKeyRaw, privateKeyRaw } = makeEd25519Keypair();
    const jws = sign(canonicalize(buildManifest(makeMinimalInput())), privateKeyRaw);

    expect(decodeHeader(jws)).toEqual({ alg: "EdDSA", kid: kidForPublicKey(publicKeyRaw), typ: AUDIT_ANCHOR_TYP });
    expect(Object.keys(decodeHeader(jws))).toEqual(["alg", "kid", "typ"]);
  });

  it("reproduces the vector's JWS from its seed and manifest", () => {
    const jws = sign(
      canonicalize(VECTORS.manifest as ReturnType<typeof buildManifest>),
      Buffer.from(VECTORS.key.seedHex, "hex"),
    );
    expect(jws).toBe(VECTORS.jws.find((v) => v.expect === "ok")?.jws);
  });
});

describe("readJwsKid", () => {
  const { privateKeyRaw, publicKeyRaw } = makeEd25519Keypair();
  const jws = sign(canonicalize(buildManifest(makeMinimalInput())), privateKeyRaw);

  it("returns the header's kid without checking the signature", () => {
    const [headerB64, payloadB64] = jws.split(".");
    expect(readJwsKid(jws)).toBe(kidForPublicKey(publicKeyRaw));
    expect(readJwsKid(`${headerB64}.${payloadB64}.AAAA`)).toBe(kidForPublicKey(publicKeyRaw));
  });

  it.each([
    ["the 8-char form the old pattern admitted", `${AUDIT_ANCHOR_KID_PREFIX}abcd1234`],
    ["upper-case hex", `${AUDIT_ANCHOR_KID_PREFIX}0123456789ABCDEF`],
    ["a path", `${AUDIT_ANCHOR_KID_PREFIX}../../etc/passwd`],
    ["no prefix", "0123456789abcdef"],
    ["a number", 7],
    ["a missing kid", undefined],
  ])("throws InvalidKidError for %s", (_label, kid) => {
    expect(() => readJwsKid(withHeader(jws, { kid }))).toThrow(InvalidKidError);
  });

  it.each([
    ["two parts", "a.b"],
    ["a header that is not base64url JSON", "!!!.e30.AAAA"],
    ["a header that is JSON null", `${Buffer.from("null").toString("base64url")}.e30.AAAA`],
  ])("throws InvalidSignatureError for %s", (_label, malformed) => {
    expect(() => readJwsKid(malformed)).toThrow(InvalidSignatureError);
  });
});

describe("verify — kid binding", () => {
  const publicKey = Buffer.from(VECTORS.key.publicKeyHex, "hex");
  const controlCharsOf = (text: string) => [...text].filter((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
  const outcome = (jws: string): string => {
    try {
      verify(jws, publicKey);
      return "ok";
    } catch (err) {
      return (err as Error).name;
    }
  };

  it.each(VECTORS.jws)("shared vector: $name → $expect", ({ jws, expect: expected }) => {
    expect(outcome(jws)).toBe(expected);
  });

  it.each(VECTORS.jws.filter((v) => v.expect !== "ok"))("shared vector: $name — the error message carries no control character", ({ jws }) => {
    let message: string | null = null;
    try {
      verify(jws, publicKey);
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).not.toBeNull();
    expect(controlCharsOf(message ?? "")).toEqual([]);
  });

  it("the vectors include a kid that carries control characters", () => {
    const kids = VECTORS.jws.map((v) => {
      const header = JSON.parse(Buffer.from(v.jws.split(".")[0] ?? "", "base64url").toString("utf8")) as { kid?: unknown } | null;
      return typeof header?.kid === "string" ? header.kid : "";
    });
    expect(kids.filter((kid) => controlCharsOf(kid).length > 0)).toHaveLength(1);
  });

  it("the vectors cover acceptance, a mismatched kid with and without a valid signature, and a malformed kid", () => {
    const expectations = VECTORS.jws.map((v) => v.expect);
    // One accepted manifest per format version.
    expect(expectations.filter((e) => e === "ok")).toHaveLength(2);
    expect(expectations.filter((e) => e === "KidMismatchError")).toHaveLength(2);
    expect(expectations).toContain("InvalidSignatureError");
    expect(expectations).toContain("InvalidKidError");
  });

  it("accepts both format versions: version 1 without a chainLocation, version 2 with one", () => {
    const seed = Buffer.from(VECTORS.key.seedHex, "hex");
    const v1 = verify(sign(canonicalize(VECTORS.manifest as ReturnType<typeof buildManifest>), seed), publicKey);
    const v2 = verify(sign(canonicalize(VECTORS.manifestV2 as ReturnType<typeof buildManifest>), seed), publicKey);

    expect(v1).toEqual(VECTORS.manifest);
    expect(v1.version).toBe(1);
    expect("chainLocation" in v1).toBe(false);
    expect(v2).toEqual(VECTORS.manifestV2);
    expect(v2.version).toBe(2);
  });

  it("the vectors refuse a version 2 manifest without a chainLocation and a version 1 manifest with one", () => {
    const byName = new Map(VECTORS.jws.map((v) => [v.name, v.expect]));
    expect(byName.get("version 2 without a chainLocation")).toBe("ManifestSchemaValidationError");
    expect(byName.get("version 1 carrying a chainLocation")).toBe("InvalidSignatureError");
    expect(byName.get("a version neither implementation knows")).toBe("ManifestSchemaValidationError");
  });

  it("rejects a manifest checked under another key with KidMismatchError, not a signature error", () => {
    const signer = makeEd25519Keypair();
    const other = makeEd25519Keypair();
    const jws = sign(canonicalize(buildManifest(makeMinimalInput())), signer.privateKeyRaw);

    expect(() => verify(jws, other.publicKeyRaw)).toThrow(KidMismatchError);
    expect(verify(jws, signer.publicKeyRaw).deploymentId).toBe("deploy-test-1");
  });

  it("rejects a header renamed to the verifying key's kid: the signature no longer covers it", () => {
    const signer = makeEd25519Keypair();
    const other = makeEd25519Keypair();
    const jws = sign(canonicalize(buildManifest(makeMinimalInput())), signer.privateKeyRaw);

    expect(() => verify(withHeader(jws, { kid: kidForPublicKey(other.publicKeyRaw) }), other.publicKeyRaw)).toThrow(
      InvalidSignatureError,
    );
  });

  it("refuses a public key that is not 32 bytes", () => {
    const { privateKeyRaw } = makeEd25519Keypair();
    const jws = sign(canonicalize(buildManifest(makeMinimalInput())), privateKeyRaw);

    expect(() => verify(jws, Buffer.alloc(16, 1))).toThrow(InvalidPublicKeyError);
  });
});

describe("verify — anchoredAt", () => {
  const { publicKeyRaw, privateKeyRaw } = makeEd25519Keypair();
  const signed = (anchoredAt: string) =>
    sign(canonicalize({ ...buildManifest(makeMinimalInput()), anchoredAt }), privateKeyRaw);

  it("accepts the form toISOString writes", () => {
    expect(verify(signed("2026-05-01T00:05:00.000Z"), publicKeyRaw).anchoredAt).toBe("2026-05-01T00:05:00.000Z");
  });

  it.each([
    ["no milliseconds", "2026-05-01T00:05:00Z"],
    ["an offset instead of Z", "2026-05-01T00:05:00.000+00:00"],
    ["a date only", "2026-05-01"],
    ["a day that does not exist", "2026-02-30T00:05:00.000Z"],
    ["an hour 24", "2026-05-01T24:00:00.000Z"],
    ["trailing text", "2026-05-01T00:05:00.000Z "],
    ["an expanded year, which toISOString round-trips", "+010000-01-01T00:00:00.000Z"],
    ["not a timestamp", "yesterday"],
  ])("rejects %s", (_label, anchoredAt) => {
    expect(() => verify(signed(anchoredAt), publicKeyRaw)).toThrow(ManifestSchemaValidationError);
  });
});

describe("signStatement / verifyStatement", () => {
  const { publicKeyRaw, privateKeyRaw } = makeEd25519Keypair();
  const payload = Buffer.from(JSON.stringify({ op: "rotation", issuedAt: "2026-05-01T00:00:00.000Z" }), "utf-8");

  it("signs under the statement typ and the signing key's own kid, and verifies to the payload bytes", () => {
    const jws = signStatement(payload, privateKeyRaw);

    expect(decodeHeader(jws)).toEqual({
      alg: "EdDSA",
      kid: kidForPublicKey(publicKeyRaw),
      typ: AUDIT_ANCHOR_STATEMENT_TYP,
    });
    expect(verifyStatement(jws, publicKeyRaw)).toEqual(payload);
  });

  it("a manifest verify rejects a statement, and a statement verify rejects a manifest, with InvalidTypError", () => {
    const manifestJws = sign(canonicalize(buildManifest(makeMinimalInput())), privateKeyRaw);

    expect(() => verify(signStatement(payload, privateKeyRaw), publicKeyRaw)).toThrow(InvalidTypError);
    expect(() => verifyStatement(manifestJws, publicKeyRaw)).toThrow(InvalidTypError);
  });

  it("binds the kid and the signature like a manifest", () => {
    const jws = signStatement(payload, privateKeyRaw);
    const [headerB64, , sigB64] = jws.split(".");
    const tampered = `${headerB64}.${Buffer.from("{}").toString("base64url")}.${sigB64}`;

    expect(() => verifyStatement(jws, makeEd25519Keypair().publicKeyRaw)).toThrow(KidMismatchError);
    expect(() => verifyStatement(tampered, publicKeyRaw)).toThrow(InvalidSignatureError);
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
    );
    const tampered = tamperHeader(jws, { alg: "none" });
    expect(() => verify(tampered, publicKeyRaw)).toThrow(InvalidAlgorithmError);
  });

  it('rejects alg: "HS256"', () => {
    const { publicKeyRaw, privateKeyRaw } = makeEd25519Keypair();
    const jws = sign(
      canonicalize(buildManifest(makeMinimalInput())),
      privateKeyRaw,
    );
    const tampered = tamperHeader(jws, { alg: "HS256" });
    expect(() => verify(tampered, publicKeyRaw)).toThrow(InvalidAlgorithmError);
  });

  it('rejects alg: "RS256"', () => {
    const { publicKeyRaw, privateKeyRaw } = makeEd25519Keypair();
    const jws = sign(
      canonicalize(buildManifest(makeMinimalInput())),
      privateKeyRaw,
    );
    const tampered = tamperHeader(jws, { alg: "RS256" });
    expect(() => verify(tampered, publicKeyRaw)).toThrow(InvalidAlgorithmError);
  });

  it("rejects alg: undefined", () => {
    const { publicKeyRaw, privateKeyRaw } = makeEd25519Keypair();
    const jws = sign(
      canonicalize(buildManifest(makeMinimalInput())),
      privateKeyRaw,
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

  it('rejects alg: "ES256"', () => {
    const { publicKeyRaw, privateKeyRaw } = makeEd25519Keypair();
    const jws = sign(
      canonicalize(buildManifest(makeMinimalInput())),
      privateKeyRaw,
    );
    const tampered = tamperHeader(jws, { alg: "ES256" });
    expect(() => verify(tampered, publicKeyRaw)).toThrow(InvalidAlgorithmError);
  });

  it("rejects alg: null", () => {
    const { publicKeyRaw, privateKeyRaw } = makeEd25519Keypair();
    const jws = sign(
      canonicalize(buildManifest(makeMinimalInput())),
      privateKeyRaw,
    );
    const tampered = tamperHeader(jws, { alg: null });
    expect(() => verify(tampered, publicKeyRaw)).toThrow(InvalidAlgorithmError);
  });

  it("rejects wrong typ", () => {
    const { publicKeyRaw, privateKeyRaw } = makeEd25519Keypair();
    const jws = sign(
      canonicalize(buildManifest(makeMinimalInput())),
      privateKeyRaw,
    );
    const tampered = tamperHeader(jws, { typ: "wrong-typ" });
    expect(() => verify(tampered, publicKeyRaw)).toThrow(InvalidTypError);
  });

  it("keeps control characters of an unverified alg and typ out of the error message", () => {
    const { publicKeyRaw, privateKeyRaw } = makeEd25519Keypair();
    const jws = sign(canonicalize(buildManifest(makeMinimalInput())), privateKeyRaw);
    const hostile = "\u001b[31mred\nline";

    for (const overrides of [{ alg: hostile }, { typ: hostile }]) {
      let message = "";
      try {
        verify(tamperHeader(jws, overrides), publicKeyRaw);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain("Invalid JWS");
      expect([...message].filter((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)).toEqual([]);
    }
  });
});

describe("verify — payload tampering", () => {
  it("rejects tampered payload", () => {
    const { publicKeyRaw, privateKeyRaw } = makeEd25519Keypair();
    const manifest = buildManifest(makeMinimalInput());
    const jws = sign(canonicalize(manifest), privateKeyRaw);
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
    const jws = sign(canonicalize(manifest), privateKeyRaw);
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
