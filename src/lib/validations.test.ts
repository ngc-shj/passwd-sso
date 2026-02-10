import { describe, it, expect } from "vitest";
import {
  entryTypeSchema,
  createE2EPasswordSchema,
  updateE2EPasswordSchema,
  createShareLinkSchema,
} from "./validations";

describe("entryTypeSchema", () => {
  it.each(["LOGIN", "SECURE_NOTE", "CREDIT_CARD", "IDENTITY", "PASSKEY"])(
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
    encryptedBlob: validEncrypted,
    encryptedOverview: validEncrypted,
    keyVersion: 1,
  };

  it("defaults entryType to LOGIN", () => {
    const result = createE2EPasswordSchema.parse(validBase);
    expect(result.entryType).toBe("LOGIN");
  });

  it("accepts PASSKEY entryType", () => {
    const result = createE2EPasswordSchema.parse({
      ...validBase,
      entryType: "PASSKEY",
    });
    expect(result.entryType).toBe("PASSKEY");
  });

  it("rejects invalid entryType", () => {
    expect(() =>
      createE2EPasswordSchema.parse({ ...validBase, entryType: "UNKNOWN" }),
    ).toThrow();
  });
});

describe("updateE2EPasswordSchema", () => {
  it("accepts PASSKEY entryType", () => {
    const result = updateE2EPasswordSchema.parse({ entryType: "PASSKEY" });
    expect(result.entryType).toBe("PASSKEY");
  });

  it("allows partial update without entryType", () => {
    const result = updateE2EPasswordSchema.parse({ isFavorite: true });
    expect(result.entryType).toBeUndefined();
    expect(result.isFavorite).toBe(true);
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
