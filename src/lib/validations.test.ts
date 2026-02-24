import { describe, it, expect } from "vitest";
import {
  entryTypeSchema,
  createE2EPasswordSchema,
  updateE2EPasswordSchema,
  createShareLinkSchema,
  orgMemberKeySchema,
} from "./validations";
import { ENTRY_TYPE } from "@/lib/constants";

describe("entryTypeSchema", () => {
  it.each([
    ENTRY_TYPE.LOGIN,
    ENTRY_TYPE.SECURE_NOTE,
    ENTRY_TYPE.CREDIT_CARD,
    ENTRY_TYPE.IDENTITY,
    ENTRY_TYPE.PASSKEY,
  ])(
    "accepts %s",
    (type) => {
      expect(entryTypeSchema.parse(type)).toBe(type);
    },
  );

  it("rejects invalid entry type", () => {
    expect(() => entryTypeSchema.parse("INVALID")).toThrow();
  });
});

describe("createE2EPasswordSchema", () => {
  const validEncrypted = {
    ciphertext: "data",
    iv: "a".repeat(24),
    authTag: "b".repeat(32),
  };

  const validBase = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    encryptedBlob: validEncrypted,
    encryptedOverview: validEncrypted,
    keyVersion: 1,
  };

  it("defaults entryType to LOGIN", () => {
    const result = createE2EPasswordSchema.parse(validBase);
    expect(result.entryType).toBe(ENTRY_TYPE.LOGIN);
  });

  it("accepts PASSKEY entryType", () => {
    const result = createE2EPasswordSchema.parse({
      ...validBase,
      entryType: ENTRY_TYPE.PASSKEY,
    });
    expect(result.entryType).toBe(ENTRY_TYPE.PASSKEY);
  });

  it("rejects invalid entryType", () => {
    expect(() =>
      createE2EPasswordSchema.parse({ ...validBase, entryType: "UNKNOWN" }),
    ).toThrow();
  });

  it("accepts client-generated UUID id", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    const result = createE2EPasswordSchema.parse({ ...validBase, id });
    expect(result.id).toBe(id);
  });

  it("rejects non-UUID id", () => {
    expect(() =>
      createE2EPasswordSchema.parse({ ...validBase, id: "not-a-uuid" }),
    ).toThrow();
  });

  it("id is optional when aadVersion=0", () => {
    const result = createE2EPasswordSchema.parse({ ...validBase, id: undefined, aadVersion: 0 });
    expect(result.id).toBeUndefined();
  });

  it("id is required when aadVersion defaults to 1", () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { id: _, ...baseWithoutId } = validBase;
    expect(() => createE2EPasswordSchema.parse(baseWithoutId)).toThrow(
      "id is required when aadVersion >= 1"
    );
  });

  it("defaults aadVersion to 1", () => {
    const result = createE2EPasswordSchema.parse(validBase);
    expect(result.aadVersion).toBe(1);
  });

  it("accepts aadVersion=1 with id", () => {
    const result = createE2EPasswordSchema.parse({
      ...validBase,
      aadVersion: 1,
      id: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(result.aadVersion).toBe(1);
    expect(result.id).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("rejects aadVersion=1 without id", () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { id: _, ...baseWithoutId } = validBase;
    expect(() =>
      createE2EPasswordSchema.parse({ ...baseWithoutId, aadVersion: 1 }),
    ).toThrow("id is required when aadVersion >= 1");
  });

  it("rejects aadVersion=2 (out of range)", () => {
    expect(() =>
      createE2EPasswordSchema.parse({ ...validBase, aadVersion: 2 }),
    ).toThrow();
  });

  it("rejects negative aadVersion", () => {
    expect(() =>
      createE2EPasswordSchema.parse({ ...validBase, aadVersion: -1 }),
    ).toThrow();
  });
});

describe("updateE2EPasswordSchema", () => {
  it("accepts PASSKEY entryType", () => {
    const result = updateE2EPasswordSchema.parse({ entryType: ENTRY_TYPE.PASSKEY });
    expect(result.entryType).toBe(ENTRY_TYPE.PASSKEY);
  });

  it("allows partial update without entryType", () => {
    const result = updateE2EPasswordSchema.parse({ isFavorite: true });
    expect(result.entryType).toBeUndefined();
    expect(result.isFavorite).toBe(true);
  });

  it("accepts aadVersion=1 in update", () => {
    const result = updateE2EPasswordSchema.parse({ aadVersion: 1 });
    expect(result.aadVersion).toBe(1);
  });

  it("aadVersion is optional in update", () => {
    const result = updateE2EPasswordSchema.parse({ isFavorite: false });
    expect(result.aadVersion).toBeUndefined();
  });

  it("rejects aadVersion=2 in update", () => {
    expect(() =>
      updateE2EPasswordSchema.parse({ aadVersion: 2 }),
    ).toThrow();
  });
});

describe("createShareLinkSchema – passkey fields", () => {
  const baseShare = {
    passwordEntryId: "cm000000000000000000000aa",
    expiresIn: "1d" as const,
  };

  it("accepts share data with passkey fields", () => {
    const result = createShareLinkSchema.parse({
      ...baseShare,
      data: {
        title: "My Passkey",
        relyingPartyId: "example.com",
        relyingPartyName: "Example",
        credentialId: "credential-abc-123",
        creationDate: "2025-01-01",
        deviceInfo: "YubiKey 5",
      },
    });
    expect(result.data?.relyingPartyId).toBe("example.com");
    expect(result.data?.credentialId).toBe("credential-abc-123");
    expect(result.data?.deviceInfo).toBe("YubiKey 5");
  });

  it("accepts share data with only title (minimal passkey)", () => {
    const result = createShareLinkSchema.parse({
      ...baseShare,
      data: { title: "Minimal Passkey" },
    });
    expect(result.data?.title).toBe("Minimal Passkey");
    expect(result.data?.relyingPartyId).toBeUndefined();
  });

  it("rejects relyingPartyId exceeding max length", () => {
    expect(() =>
      createShareLinkSchema.parse({
        ...baseShare,
        data: {
          title: "Test",
          relyingPartyId: "x".repeat(201),
        },
      }),
    ).toThrow();
  });

  it("rejects credentialId exceeding max length", () => {
    expect(() =>
      createShareLinkSchema.parse({
        ...baseShare,
        data: {
          title: "Test",
          credentialId: "x".repeat(501),
        },
      }),
    ).toThrow();
  });
});

describe("orgMemberKeySchema", () => {
  const validKey = {
    encryptedOrgKey: "enc-key-data",
    orgKeyIv: "a".repeat(24),
    orgKeyAuthTag: "b".repeat(32),
    ephemeralPublicKey: '{"kty":"EC"}',
    hkdfSalt: "c".repeat(64),
    keyVersion: 1,
  };

  it("accepts valid org member key", () => {
    expect(orgMemberKeySchema.safeParse(validKey).success).toBe(true);
  });

  it("rejects encryptedOrgKey exceeding max length (1000)", () => {
    const result = orgMemberKeySchema.safeParse({
      ...validKey,
      encryptedOrgKey: "x".repeat(1001),
    });
    expect(result.success).toBe(false);
  });

  it("accepts encryptedOrgKey at max length (1000)", () => {
    const result = orgMemberKeySchema.safeParse({
      ...validKey,
      encryptedOrgKey: "x".repeat(1000),
    });
    expect(result.success).toBe(true);
  });

  it("rejects ephemeralPublicKey exceeding max length (500)", () => {
    const result = orgMemberKeySchema.safeParse({
      ...validKey,
      ephemeralPublicKey: "x".repeat(501),
    });
    expect(result.success).toBe(false);
  });

  it("accepts ephemeralPublicKey at max length (500)", () => {
    const result = orgMemberKeySchema.safeParse({
      ...validKey,
      ephemeralPublicKey: "x".repeat(500),
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid orgKeyIv format", () => {
    const result = orgMemberKeySchema.safeParse({
      ...validKey,
      orgKeyIv: "not-hex-24",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid hkdfSalt format", () => {
    const result = orgMemberKeySchema.safeParse({
      ...validKey,
      hkdfSalt: "not-hex-64",
    });
    expect(result.success).toBe(false);
  });

  it("defaults wrapVersion to 1 when omitted", () => {
    const result = orgMemberKeySchema.safeParse(validKey);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.wrapVersion).toBe(1);
    }
  });

  it("accepts wrapVersion=1", () => {
    const result = orgMemberKeySchema.safeParse({ ...validKey, wrapVersion: 1 });
    expect(result.success).toBe(true);
  });

  it("rejects wrapVersion=2 (unsupported)", () => {
    const result = orgMemberKeySchema.safeParse({ ...validKey, wrapVersion: 2 });
    expect(result.success).toBe(false);
  });
});
