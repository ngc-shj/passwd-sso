import { describe, it, expect } from "vitest";
import {
  entryTypeSchema,
  createE2EPasswordSchema,
  updateE2EPasswordSchema,
  updateTeamE2EPasswordSchema,
  createShareLinkSchema,
  teamMemberKeySchema,
  generatePasswordSchema,
  slugRegex,
  createTeamSchema,
  createTagSchema,
  SLUG_MAX_LENGTH,
  TAG_NAME_MAX_LENGTH,
  CHARS_FIELD_MAX,
} from "./validations";
import { ENTRY_TYPE } from "@/lib/constants";
import {
  HEX_IV_LENGTH,
  HEX_AUTH_TAG_LENGTH,
  HEX_SALT_LENGTH,
  ENCRYPTED_TEAM_KEY_MAX,
  EPHEMERAL_PUBLIC_KEY_MAX,
} from "@/lib/validations/common";

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
    iv: "a".repeat(HEX_IV_LENGTH),
    authTag: "b".repeat(HEX_AUTH_TAG_LENGTH),
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

describe("teamMemberKeySchema", () => {
  const validKey = {
    encryptedTeamKey: "enc-key-data",
    teamKeyIv: "a".repeat(HEX_IV_LENGTH),
    teamKeyAuthTag: "b".repeat(HEX_AUTH_TAG_LENGTH),
    ephemeralPublicKey: '{"kty":"EC"}',
    hkdfSalt: "c".repeat(HEX_SALT_LENGTH),
    keyVersion: 1,
  };

  it("accepts valid team member key", () => {
    expect(teamMemberKeySchema.safeParse(validKey).success).toBe(true);
  });

  it("rejects encryptedTeamKey exceeding max length (1000)", () => {
    const result = teamMemberKeySchema.safeParse({
      ...validKey,
      encryptedTeamKey: "x".repeat(ENCRYPTED_TEAM_KEY_MAX + 1),
    });
    expect(result.success).toBe(false);
  });

  it("accepts encryptedTeamKey at max length (1000)", () => {
    const result = teamMemberKeySchema.safeParse({
      ...validKey,
      encryptedTeamKey: "x".repeat(ENCRYPTED_TEAM_KEY_MAX),
    });
    expect(result.success).toBe(true);
  });

  it("rejects ephemeralPublicKey exceeding max length (500)", () => {
    const result = teamMemberKeySchema.safeParse({
      ...validKey,
      ephemeralPublicKey: "x".repeat(EPHEMERAL_PUBLIC_KEY_MAX + 1),
    });
    expect(result.success).toBe(false);
  });

  it("accepts ephemeralPublicKey at max length (500)", () => {
    const result = teamMemberKeySchema.safeParse({
      ...validKey,
      ephemeralPublicKey: "x".repeat(EPHEMERAL_PUBLIC_KEY_MAX),
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid teamKeyIv format", () => {
    const result = teamMemberKeySchema.safeParse({
      ...validKey,
      teamKeyIv: "not-hex-24",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid hkdfSalt format", () => {
    const result = teamMemberKeySchema.safeParse({
      ...validKey,
      hkdfSalt: "not-hex-64",
    });
    expect(result.success).toBe(false);
  });

  it("defaults wrapVersion to 1 when omitted", () => {
    const result = teamMemberKeySchema.safeParse(validKey);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.wrapVersion).toBe(1);
    }
  });

  it("accepts wrapVersion=1", () => {
    const result = teamMemberKeySchema.safeParse({ ...validKey, wrapVersion: 1 });
    expect(result.success).toBe(true);
  });

  it("rejects wrapVersion=2 (unsupported)", () => {
    const result = teamMemberKeySchema.safeParse({ ...validKey, wrapVersion: 2 });
    expect(result.success).toBe(false);
  });
});

describe("generatePasswordSchema", () => {
  it("accepts ASCII printable includeChars", () => {
    const result = generatePasswordSchema.safeParse({ includeChars: "!@#$%^&*()" });
    expect(result.success).toBe(true);
    expect(result.data!.includeChars).toBe("!@#$%^&*()");
  });

  it("rejects control characters in includeChars", () => {
    expect(generatePasswordSchema.safeParse({ includeChars: "abc\x00" }).success).toBe(false);
    expect(generatePasswordSchema.safeParse({ includeChars: "abc\x1F" }).success).toBe(false);
  });

  it("rejects emoji/surrogate pairs in includeChars", () => {
    expect(generatePasswordSchema.safeParse({ includeChars: "abc\u{1F600}" }).success).toBe(false);
  });

  it("applies same ASCII constraint to excludeChars", () => {
    expect(generatePasswordSchema.safeParse({ excludeChars: "abc" }).success).toBe(true);
    expect(generatePasswordSchema.safeParse({ excludeChars: "abc\x00" }).success).toBe(false);
  });

  it("rejects symbols exceeding max length", () => {
    const longString = "!".repeat(CHARS_FIELD_MAX + 1);
    expect(generatePasswordSchema.safeParse({ symbols: longString }).success).toBe(false);
  });

  it("rejects non-ASCII symbols", () => {
    expect(generatePasswordSchema.safeParse({ symbols: "abc\u{1F600}" }).success).toBe(false);
  });

  it("rejects emoji in excludeChars", () => {
    expect(generatePasswordSchema.safeParse({ excludeChars: "abc\u{1F600}" }).success).toBe(false);
  });

  it("rejects includeChars exceeding max length", () => {
    expect(generatePasswordSchema.safeParse({ includeChars: "a".repeat(CHARS_FIELD_MAX + 1) }).success).toBe(false);
  });

  it("accepts includeChars at max length", () => {
    expect(generatePasswordSchema.safeParse({ includeChars: "a".repeat(CHARS_FIELD_MAX) }).success).toBe(true);
  });

  it("rejects excludeChars exceeding max length", () => {
    expect(generatePasswordSchema.safeParse({ excludeChars: "a".repeat(CHARS_FIELD_MAX + 1) }).success).toBe(false);
  });

  it("rejects DEL character (0x7F) in includeChars", () => {
    expect(generatePasswordSchema.safeParse({ includeChars: "abc\x7F" }).success).toBe(false);
  });

  it("accepts space character (0x20) in includeChars", () => {
    expect(generatePasswordSchema.safeParse({ includeChars: " abc" }).success).toBe(true);
  });

  it("defaults includeChars and excludeChars to empty string when omitted", () => {
    const result = generatePasswordSchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.data!.includeChars).toBe("");
    expect(result.data!.excludeChars).toBe("");
  });
});

describe("updateTeamE2EPasswordSchema itemKeyVersion/encryptedItemKey refine", () => {
  const encField = { ciphertext: "a".repeat(10), iv: "a".repeat(HEX_IV_LENGTH), authTag: "b".repeat(HEX_AUTH_TAG_LENGTH) };

  it("accepts metadata-only update without itemKeyVersion", () => {
    const result = updateTeamE2EPasswordSchema.safeParse({ isArchived: true });
    expect(result.success).toBe(true);
  });

  it("accepts itemKeyVersion=0 without encryptedItemKey", () => {
    const result = updateTeamE2EPasswordSchema.safeParse({
      encryptedBlob: encField,
      encryptedOverview: encField,
      aadVersion: 1,
      teamKeyVersion: 1,
      itemKeyVersion: 0,
    });
    expect(result.success).toBe(true);
  });

  it("accepts itemKeyVersion=1 with encryptedItemKey", () => {
    const result = updateTeamE2EPasswordSchema.safeParse({
      encryptedBlob: encField,
      encryptedOverview: encField,
      aadVersion: 1,
      teamKeyVersion: 1,
      itemKeyVersion: 1,
      encryptedItemKey: encField,
    });
    expect(result.success).toBe(true);
  });

  it("allows itemKeyVersion>=1 without encryptedItemKey (reuse existing)", () => {
    const result = updateTeamE2EPasswordSchema.safeParse({
      encryptedBlob: encField,
      encryptedOverview: encField,
      aadVersion: 1,
      teamKeyVersion: 1,
      itemKeyVersion: 1,
    });
    expect(result.success).toBe(true);
  });

  it("rejects itemKeyVersion=0 with encryptedItemKey", () => {
    const result = updateTeamE2EPasswordSchema.safeParse({
      encryptedBlob: encField,
      encryptedOverview: encField,
      aadVersion: 1,
      teamKeyVersion: 1,
      itemKeyVersion: 0,
      encryptedItemKey: encField,
    });
    expect(result.success).toBe(false);
  });

  it("rejects encryptedItemKey when itemKeyVersion is omitted", () => {
    const result = updateTeamE2EPasswordSchema.safeParse({
      encryptedBlob: encField,
      encryptedOverview: encField,
      aadVersion: 1,
      teamKeyVersion: 1,
      encryptedItemKey: encField,
    });
    expect(result.success).toBe(false);
  });
});

// ─── slugRegex ──────────────────────────────────────────────

describe("slugRegex", () => {
  it.each(["ab", "my-team", "team123", "a1"])("accepts valid slug %s", (slug) => {
    expect(slugRegex.test(slug)).toBe(true);
  });

  it.each(["a", "-ab", "ab-", "AB", "my team", ""])(
    "rejects invalid slug %s",
    (slug) => {
      expect(slugRegex.test(slug)).toBe(false);
    },
  );
});

// ─── createTeamSchema ───────────────────────────────────────

describe("createTeamSchema", () => {
  const valid = { name: "My Team", slug: "my-team" };

  it("accepts valid input", () => {
    expect(createTeamSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts 2-char slug", () => {
    expect(createTeamSchema.safeParse({ ...valid, slug: "ab" }).success).toBe(true);
  });

  it("rejects 1-char slug", () => {
    expect(createTeamSchema.safeParse({ ...valid, slug: "a" }).success).toBe(false);
  });

  it("rejects slug starting with hyphen", () => {
    expect(createTeamSchema.safeParse({ ...valid, slug: "-ab" }).success).toBe(false);
  });

  it("rejects slug ending with hyphen", () => {
    expect(createTeamSchema.safeParse({ ...valid, slug: "ab-" }).success).toBe(false);
  });

  it("rejects uppercase slug", () => {
    expect(createTeamSchema.safeParse({ ...valid, slug: "AB" }).success).toBe(false);
  });

  it("rejects slug exceeding max length", () => {
    expect(
      createTeamSchema.safeParse({ ...valid, slug: "a".repeat(SLUG_MAX_LENGTH + 1) }).success,
    ).toBe(false);
  });

  it("accepts slug at max length", () => {
    const slug = "a".repeat(SLUG_MAX_LENGTH - 1) + "b";
    expect(createTeamSchema.safeParse({ ...valid, slug }).success).toBe(true);
  });

  it("rejects empty name", () => {
    expect(createTeamSchema.safeParse({ ...valid, name: "" }).success).toBe(false);
  });
});

// ─── createTagSchema ────────────────────────────────────────

describe("createTagSchema", () => {
  it("accepts valid tag name", () => {
    expect(createTagSchema.safeParse({ name: "work" }).success).toBe(true);
  });

  it("rejects empty tag name", () => {
    expect(createTagSchema.safeParse({ name: "" }).success).toBe(false);
  });

  it("accepts tag name at max length", () => {
    expect(createTagSchema.safeParse({ name: "a".repeat(TAG_NAME_MAX_LENGTH) }).success).toBe(true);
  });

  it("rejects tag name exceeding max length", () => {
    expect(createTagSchema.safeParse({ name: "a".repeat(TAG_NAME_MAX_LENGTH + 1) }).success).toBe(false);
  });

  it("accepts valid hex color", () => {
    expect(createTagSchema.safeParse({ name: "t", color: "#4f46e5" }).success).toBe(true);
  });

  it("rejects invalid color", () => {
    expect(createTagSchema.safeParse({ name: "t", color: "red" }).success).toBe(false);
  });

  it("accepts empty string color (clears color)", () => {
    expect(createTagSchema.safeParse({ name: "t", color: "" }).success).toBe(true);
  });
});
