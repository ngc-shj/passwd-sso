import { describe, expect, it } from "vitest";

// ─── team.ts ─────────────────────────────────────────────────
import {
  createTeamSchema,
  teamMemberKeySchema,
  createTeamE2ESchema,
  createTeamE2EPasswordSchema,
  updateTeamE2EPasswordSchema,
  updateTeamSchema,
  upsertTeamPolicySchema,
  inviteSchema,
  addMemberSchema,
  updateMemberRoleSchema,
  updateTenantMemberRoleSchema,
  createTeamTagSchema,
  updateTeamTagSchema,
  invitationAcceptSchema,
  slugRegex,
} from "@/lib/validations/team";

// ─── share.ts ────────────────────────────────────────────────
import {
  createShareLinkSchema,
  verifyShareAccessSchema,
} from "@/lib/validations/share";

// ─── entry.ts ────────────────────────────────────────────────
import {
  entryTypeSchema,
  generatePasswordSchema,
  generatePassphraseSchema,
  createE2EPasswordSchema,
  updateE2EPasswordSchema,
  generateRequestSchema,
  historyReencryptSchema,
  teamHistoryReencryptSchema,
} from "@/lib/validations/entry";

// ─── send.ts ─────────────────────────────────────────────────
import {
  createSendTextSchema,
  createSendFileMetaSchema,
  isValidSendFilename,
} from "@/lib/validations/send";

// ─── emergency-access.ts ─────────────────────────────────────
import {
  createEmergencyGrantSchema,
  acceptEmergencyGrantSchema,
  rejectEmergencyGrantSchema,
  confirmEmergencyGrantSchema,
  acceptEmergencyGrantByIdSchema,
  revokeEmergencyGrantSchema,
} from "@/lib/validations/emergency-access";

// ─── folder.ts ───────────────────────────────────────────────
import {
  createFolderSchema,
  updateFolderSchema,
} from "@/lib/validations/folder";

// ─── tag.ts ──────────────────────────────────────────────────
import {
  createTagSchema,
  updateTagSchema,
} from "@/lib/validations/tag";

// ─── api-key.ts ──────────────────────────────────────────────
import {
  apiKeyCreateSchema,
} from "@/lib/validations/api-key";

// ─── Shared test helpers ─────────────────────────────────────

// 24-char hex string (IV: 12 bytes)
const HEX_IV = "a".repeat(24);
// 32-char hex string (auth tag: 16 bytes)
const HEX_AUTH_TAG = "b".repeat(32);
// 64-char hex string (salt: 32 bytes)
const HEX_SALT = "c".repeat(64);
// 64-char hex string (SHA-256 hash)
const HEX_HASH = "d".repeat(64);

const validEncryptedField = {
  ciphertext: "deadbeef01234567",
  iv: HEX_IV,
  authTag: HEX_AUTH_TAG,
};

// Valid UUID v4 for optional relational IDs
const VALID_UUID = "00000000-0000-4000-a000-000000000001";

// ═══════════════════════════════════════════════════════════════
// team.ts
// ═══════════════════════════════════════════════════════════════

describe("slugRegex", () => {
  it("accepts a valid slug", () => {
    expect(slugRegex.test("my-team")).toBe(true);
    expect(slugRegex.test("myteam")).toBe(true);
    expect(slugRegex.test("team-01")).toBe(true);
  });

  it("rejects slug starting with a hyphen", () => {
    expect(slugRegex.test("-team")).toBe(false);
  });

  it("rejects slug ending with a hyphen", () => {
    expect(slugRegex.test("team-")).toBe(false);
  });

  it("rejects slug with uppercase letters", () => {
    expect(slugRegex.test("MyTeam")).toBe(false);
  });

  it("rejects slug with special characters", () => {
    expect(slugRegex.test("team_name")).toBe(false);
  });
});

describe("createTeamSchema", () => {
  const valid = { name: "Engineering", slug: "engineering" };

  it("accepts valid input", () => {
    expect(createTeamSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects empty name", () => {
    expect(createTeamSchema.safeParse({ ...valid, name: "" }).success).toBe(false);
  });

  it("rejects name exceeding 100 chars", () => {
    expect(createTeamSchema.safeParse({ ...valid, name: "a".repeat(101) }).success).toBe(false);
  });

  it("rejects slug shorter than 2 chars", () => {
    expect(createTeamSchema.safeParse({ ...valid, slug: "a" }).success).toBe(false);
  });

  it("rejects slug exceeding 50 chars", () => {
    expect(createTeamSchema.safeParse({ ...valid, slug: "a".repeat(51) }).success).toBe(false);
  });

  it("rejects slug with invalid characters", () => {
    expect(createTeamSchema.safeParse({ ...valid, slug: "my_team" }).success).toBe(false);
  });

  it("accepts optional description", () => {
    expect(createTeamSchema.safeParse({ ...valid, description: "A team" }).success).toBe(true);
  });

  it("rejects description exceeding 500 chars", () => {
    expect(createTeamSchema.safeParse({ ...valid, description: "x".repeat(501) }).success).toBe(false);
  });
});

describe("teamMemberKeySchema", () => {
  const valid = {
    encryptedTeamKey: "encryptedkeydata",
    teamKeyIv: HEX_IV,
    teamKeyAuthTag: HEX_AUTH_TAG,
    ephemeralPublicKey: "ephemeralPubKeyBase64",
    hkdfSalt: HEX_SALT,
    keyVersion: 1,
    wrapVersion: 1,
  };

  it("accepts valid input", () => {
    expect(teamMemberKeySchema.safeParse(valid).success).toBe(true);
  });

  it("rejects missing encryptedTeamKey", () => {
    const { encryptedTeamKey: _, ...rest } = valid;
    expect(teamMemberKeySchema.safeParse(rest).success).toBe(false);
  });

  it("rejects keyVersion below 1", () => {
    expect(teamMemberKeySchema.safeParse({ ...valid, keyVersion: 0 }).success).toBe(false);
  });

  it("rejects wrapVersion other than 1", () => {
    expect(teamMemberKeySchema.safeParse({ ...valid, wrapVersion: 2 }).success).toBe(false);
  });

  it("rejects invalid teamKeyIv (wrong length)", () => {
    expect(teamMemberKeySchema.safeParse({ ...valid, teamKeyIv: "short" }).success).toBe(false);
  });
});

describe("createTeamE2ESchema", () => {
  const valid = {
    id: VALID_UUID,
    name: "Engineering",
    slug: "engineering",
    teamMemberKey: {
      encryptedTeamKey: "encryptedkeydata",
      teamKeyIv: HEX_IV,
      teamKeyAuthTag: HEX_AUTH_TAG,
      ephemeralPublicKey: "ephemeralPubKeyBase64",
      hkdfSalt: HEX_SALT,
      keyVersion: 1,
      wrapVersion: 1,
    },
  };

  it("accepts valid input with UUID v4 id", () => {
    expect(createTeamE2ESchema.safeParse(valid).success).toBe(true);
  });

  it("rejects missing id (id is required)", () => {
    const { id: _, ...rest } = valid;
    expect(createTeamE2ESchema.safeParse(rest).success).toBe(false);
  });

  it("rejects CUID v1 format for id (id must be UUID v4)", () => {
    expect(createTeamE2ESchema.safeParse({ ...valid, id: "tz4a98xxat96iws9zmbrgj3a" }).success).toBe(false);
  });

  it("rejects invalid UUID id", () => {
    expect(createTeamE2ESchema.safeParse({ ...valid, id: "not-a-uuid" }).success).toBe(false);
  });

  it("rejects missing teamMemberKey", () => {
    const { teamMemberKey: _, ...rest } = valid;
    expect(createTeamE2ESchema.safeParse(rest).success).toBe(false);
  });
});

describe("createTeamE2EPasswordSchema", () => {
  const valid = {
    id: VALID_UUID,
    encryptedBlob: validEncryptedField,
    encryptedOverview: validEncryptedField,
    aadVersion: 1,
    teamKeyVersion: 1,
    itemKeyVersion: 0,
  };

  it("accepts valid input with UUID v4 id and itemKeyVersion=0 and no encryptedItemKey", () => {
    expect(createTeamE2EPasswordSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects missing id (id is required)", () => {
    const { id: _, ...rest } = valid;
    expect(createTeamE2EPasswordSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects CUID v1 format for id (id must be UUID v4)", () => {
    expect(createTeamE2EPasswordSchema.safeParse({ ...valid, id: "tz4a98xxat96iws9zmbrgj3a" }).success).toBe(false);
  });

  it("accepts itemKeyVersion>=1 with encryptedItemKey present", () => {
    const result = createTeamE2EPasswordSchema.safeParse({
      ...valid,
      itemKeyVersion: 1,
      encryptedItemKey: validEncryptedField,
    });
    expect(result.success).toBe(true);
  });

  it("rejects itemKeyVersion>=1 without encryptedItemKey", () => {
    expect(createTeamE2EPasswordSchema.safeParse({
      ...valid,
      itemKeyVersion: 1,
    }).success).toBe(false);
  });

  it("rejects itemKeyVersion=0 with encryptedItemKey present", () => {
    expect(createTeamE2EPasswordSchema.safeParse({
      ...valid,
      itemKeyVersion: 0,
      encryptedItemKey: validEncryptedField,
    }).success).toBe(false);
  });

  it("rejects missing encryptedBlob", () => {
    const { encryptedBlob: _, ...rest } = valid;
    expect(createTeamE2EPasswordSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects aadVersion below 1", () => {
    expect(createTeamE2EPasswordSchema.safeParse({ ...valid, aadVersion: 0 }).success).toBe(false);
  });

  it("accepts optional tagIds as UUID array", () => {
    expect(createTeamE2EPasswordSchema.safeParse({ ...valid, tagIds: [VALID_UUID] }).success).toBe(true);
  });
});

describe("updateTeamE2EPasswordSchema", () => {
  it("accepts empty object (all optional)", () => {
    expect(updateTeamE2EPasswordSchema.safeParse({}).success).toBe(true);
  });

  it("accepts full blob update when all four fields are present", () => {
    const result = updateTeamE2EPasswordSchema.safeParse({
      encryptedBlob: validEncryptedField,
      encryptedOverview: validEncryptedField,
      aadVersion: 1,
      teamKeyVersion: 1,
    });
    expect(result.success).toBe(true);
  });

  it("rejects partial blob update (blob without overview)", () => {
    expect(updateTeamE2EPasswordSchema.safeParse({
      encryptedBlob: validEncryptedField,
      aadVersion: 1,
      teamKeyVersion: 1,
    }).success).toBe(false);
  });

  it("rejects encryptedItemKey when itemKeyVersion is 0", () => {
    expect(updateTeamE2EPasswordSchema.safeParse({
      itemKeyVersion: 0,
      encryptedItemKey: validEncryptedField,
    }).success).toBe(false);
  });

  it("accepts itemKeyVersion>=1 without encryptedItemKey (reuse existing)", () => {
    expect(updateTeamE2EPasswordSchema.safeParse({
      itemKeyVersion: 1,
    }).success).toBe(true);
  });

  it("accepts metadata-only update (isArchived)", () => {
    expect(updateTeamE2EPasswordSchema.safeParse({ isArchived: true }).success).toBe(true);
  });
});

describe("updateTeamSchema", () => {
  it("accepts empty object (all optional)", () => {
    expect(updateTeamSchema.safeParse({}).success).toBe(true);
  });

  it("accepts valid name update", () => {
    expect(updateTeamSchema.safeParse({ name: "New Name" }).success).toBe(true);
  });

  it("rejects name that is empty string (min 1 when provided)", () => {
    expect(updateTeamSchema.safeParse({ name: "" }).success).toBe(false);
  });

  it("accepts empty string description (clear case)", () => {
    expect(updateTeamSchema.safeParse({ description: "" }).success).toBe(true);
  });

  it("rejects description exceeding 500 chars", () => {
    expect(updateTeamSchema.safeParse({ description: "x".repeat(501) }).success).toBe(false);
  });
});

describe("upsertTeamPolicySchema", () => {
  const valid = {
    minPasswordLength: 12,
    requireUppercase: true,
    requireLowercase: true,
    requireNumbers: true,
    requireSymbols: false,
    maxSessionDurationMinutes: 60,
    requireRepromptForAll: false,
    allowExport: true,
    allowSharing: true,
    requireSharePassword: false,
  };

  it("accepts valid input", () => {
    expect(upsertTeamPolicySchema.safeParse(valid).success).toBe(true);
  });

  it("accepts empty object using defaults", () => {
    expect(upsertTeamPolicySchema.safeParse({}).success).toBe(true);
  });

  it("rejects minPasswordLength below 0", () => {
    expect(upsertTeamPolicySchema.safeParse({ ...valid, minPasswordLength: -1 }).success).toBe(false);
  });

  it("rejects minPasswordLength above 128", () => {
    expect(upsertTeamPolicySchema.safeParse({ ...valid, minPasswordLength: 129 }).success).toBe(false);
  });

  it("rejects maxSessionDurationMinutes below 5", () => {
    expect(upsertTeamPolicySchema.safeParse({ ...valid, maxSessionDurationMinutes: 4 }).success).toBe(false);
  });

  it("accepts null maxSessionDurationMinutes (no limit)", () => {
    expect(upsertTeamPolicySchema.safeParse({ ...valid, maxSessionDurationMinutes: null }).success).toBe(true);
  });
});

describe("inviteSchema", () => {
  it("accepts valid email and role", () => {
    expect(inviteSchema.safeParse({ email: "user@example.com", role: "MEMBER" }).success).toBe(true);
  });

  it("rejects invalid email", () => {
    expect(inviteSchema.safeParse({ email: "not-an-email", role: "MEMBER" }).success).toBe(false);
  });

  it("rejects OWNER role (not an invite role)", () => {
    expect(inviteSchema.safeParse({ email: "user@example.com", role: "OWNER" }).success).toBe(false);
  });

  it("defaults role to MEMBER when omitted", () => {
    const result = inviteSchema.safeParse({ email: "user@example.com" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.role).toBe("MEMBER");
  });
});

describe("addMemberSchema", () => {
  it("accepts valid userId and role", () => {
    expect(addMemberSchema.safeParse({ userId: VALID_UUID, role: "ADMIN" }).success).toBe(true);
  });

  it("rejects non-UUID userId", () => {
    expect(addMemberSchema.safeParse({ userId: "not-a-uuid", role: "MEMBER" }).success).toBe(false);
  });

  it("rejects OWNER role (not an invite role)", () => {
    expect(addMemberSchema.safeParse({ userId: VALID_UUID, role: "OWNER" }).success).toBe(false);
  });
});

describe("updateMemberRoleSchema", () => {
  it("accepts OWNER role", () => {
    expect(updateMemberRoleSchema.safeParse({ role: "OWNER" }).success).toBe(true);
  });

  it("accepts VIEWER role", () => {
    expect(updateMemberRoleSchema.safeParse({ role: "VIEWER" }).success).toBe(true);
  });

  it("rejects invalid role value", () => {
    expect(updateMemberRoleSchema.safeParse({ role: "SUPERUSER" }).success).toBe(false);
  });
});

describe("updateTenantMemberRoleSchema", () => {
  it("accepts ADMIN role", () => {
    expect(updateTenantMemberRoleSchema.safeParse({ role: "ADMIN" }).success).toBe(true);
  });

  it("rejects invalid role", () => {
    expect(updateTenantMemberRoleSchema.safeParse({ role: "VIEWER" }).success).toBe(false);
  });
});

describe("createTeamTagSchema", () => {
  it("accepts valid name only", () => {
    expect(createTeamTagSchema.safeParse({ name: "backend" }).success).toBe(true);
  });

  it("accepts valid name with color", () => {
    expect(createTeamTagSchema.safeParse({ name: "backend", color: "#ff0000" }).success).toBe(true);
  });

  it("accepts empty string color", () => {
    expect(createTeamTagSchema.safeParse({ name: "backend", color: "" }).success).toBe(true);
  });

  it("rejects invalid color format", () => {
    expect(createTeamTagSchema.safeParse({ name: "backend", color: "red" }).success).toBe(false);
  });

  it("rejects empty name", () => {
    expect(createTeamTagSchema.safeParse({ name: "" }).success).toBe(false);
  });

  it("rejects name exceeding 50 chars", () => {
    expect(createTeamTagSchema.safeParse({ name: "x".repeat(51) }).success).toBe(false);
  });
});

describe("updateTeamTagSchema", () => {
  it("accepts empty object (all optional)", () => {
    expect(updateTeamTagSchema.safeParse({}).success).toBe(true);
  });

  it("accepts partial update with name", () => {
    expect(updateTeamTagSchema.safeParse({ name: "frontend" }).success).toBe(true);
  });

  it("accepts null color (clear color)", () => {
    expect(updateTeamTagSchema.safeParse({ color: null }).success).toBe(true);
  });
});

describe("invitationAcceptSchema", () => {
  it("accepts a non-empty token", () => {
    expect(invitationAcceptSchema.safeParse({ token: "abc123" }).success).toBe(true);
  });

  it("rejects empty token", () => {
    expect(invitationAcceptSchema.safeParse({ token: "" }).success).toBe(false);
  });

  it("rejects missing token", () => {
    expect(invitationAcceptSchema.safeParse({}).success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// share.ts
// ═══════════════════════════════════════════════════════════════

describe("createShareLinkSchema", () => {
  const personalBase = {
    passwordEntryId: "00000000-0000-4000-a000-000000000050",
    data: { title: "My Login" },
    expiresIn: "7d" as const,
  };

  const teamBase = {
    teamPasswordEntryId: "00000000-0000-4000-a000-000000000051",
    encryptedShareData: validEncryptedField,
    entryType: "LOGIN" as const,
    expiresIn: "1d" as const,
  };

  it("accepts valid personal entry share", () => {
    expect(createShareLinkSchema.safeParse(personalBase).success).toBe(true);
  });

  it("accepts valid team entry share", () => {
    expect(createShareLinkSchema.safeParse(teamBase).success).toBe(true);
  });

  it("rejects when both passwordEntryId and teamPasswordEntryId are provided", () => {
    expect(createShareLinkSchema.safeParse({
      ...personalBase,
      teamPasswordEntryId: "00000000-0000-4000-a000-000000000051",
    }).success).toBe(false);
  });

  it("rejects when neither passwordEntryId nor teamPasswordEntryId is provided", () => {
    expect(createShareLinkSchema.safeParse({
      data: { title: "My Login" },
      expiresIn: "7d",
    }).success).toBe(false);
  });

  it("rejects personal entry share without data", () => {
    const { data: _, ...withoutData } = personalBase;
    expect(createShareLinkSchema.safeParse(withoutData).success).toBe(false);
  });

  it("rejects team entry share without encryptedShareData", () => {
    const { encryptedShareData: _, ...rest } = teamBase;
    expect(createShareLinkSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects team entry share without entryType", () => {
    const { entryType: _, ...rest } = teamBase;
    expect(createShareLinkSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects team entry share with plaintext data field", () => {
    expect(createShareLinkSchema.safeParse({
      ...teamBase,
      data: { title: "leaked" },
    }).success).toBe(false);
  });

  it("rejects invalid expiresIn value", () => {
    expect(createShareLinkSchema.safeParse({ ...personalBase, expiresIn: "2d" }).success).toBe(false);
  });

  it("accepts optional maxViews within range", () => {
    expect(createShareLinkSchema.safeParse({ ...personalBase, maxViews: 10 }).success).toBe(true);
  });

  it("rejects maxViews of 0 (below min=1)", () => {
    expect(createShareLinkSchema.safeParse({ ...personalBase, maxViews: 0 }).success).toBe(false);
  });

  it("rejects maxViews above 100", () => {
    expect(createShareLinkSchema.safeParse({ ...personalBase, maxViews: 101 }).success).toBe(false);
  });
});

describe("verifyShareAccessSchema", () => {
  it("accepts valid token and password", () => {
    expect(verifyShareAccessSchema.safeParse({
      token: HEX_HASH,
      password: "correct-horse",
    }).success).toBe(true);
  });

  it("rejects invalid token (not hex hash)", () => {
    expect(verifyShareAccessSchema.safeParse({
      token: "not-hex",
      password: "correct-horse",
    }).success).toBe(false);
  });

  it("rejects empty password", () => {
    expect(verifyShareAccessSchema.safeParse({
      token: HEX_HASH,
      password: "",
    }).success).toBe(false);
  });

  it("rejects password exceeding max length (43)", () => {
    expect(verifyShareAccessSchema.safeParse({
      token: HEX_HASH,
      password: "x".repeat(44),
    }).success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// entry.ts
// ═══════════════════════════════════════════════════════════════

describe("entryTypeSchema", () => {
  it("accepts LOGIN", () => {
    expect(entryTypeSchema.safeParse("LOGIN").success).toBe(true);
  });

  it("accepts SSH_KEY", () => {
    expect(entryTypeSchema.safeParse("SSH_KEY").success).toBe(true);
  });

  it("rejects invalid entry type", () => {
    expect(entryTypeSchema.safeParse("UNKNOWN").success).toBe(false);
  });
});

describe("generatePasswordSchema", () => {
  it("accepts defaults (no input)", () => {
    expect(generatePasswordSchema.safeParse({}).success).toBe(true);
  });

  it("accepts valid explicit input", () => {
    expect(generatePasswordSchema.safeParse({
      length: 20,
      uppercase: true,
      lowercase: true,
      numbers: false,
      symbols: "!@#",
      excludeAmbiguous: true,
      includeChars: "",
      excludeChars: "lI",
    }).success).toBe(true);
  });

  it("rejects length below 8", () => {
    expect(generatePasswordSchema.safeParse({ length: 7 }).success).toBe(false);
  });

  it("rejects length above 128", () => {
    expect(generatePasswordSchema.safeParse({ length: 129 }).success).toBe(false);
  });

  it("rejects non-ASCII symbols", () => {
    expect(generatePasswordSchema.safeParse({ symbols: "★" }).success).toBe(false);
  });
});

describe("generatePassphraseSchema", () => {
  it("accepts defaults", () => {
    expect(generatePassphraseSchema.safeParse({}).success).toBe(true);
  });

  it("accepts valid wordCount=5 with custom separator", () => {
    expect(generatePassphraseSchema.safeParse({ wordCount: 5, separator: "_" }).success).toBe(true);
  });

  it("rejects wordCount below 3", () => {
    expect(generatePassphraseSchema.safeParse({ wordCount: 2 }).success).toBe(false);
  });

  it("rejects wordCount above 10", () => {
    expect(generatePassphraseSchema.safeParse({ wordCount: 11 }).success).toBe(false);
  });

  it("rejects separator exceeding 5 chars", () => {
    expect(generatePassphraseSchema.safeParse({ separator: "------" }).success).toBe(false);
  });
});

describe("createE2EPasswordSchema", () => {
  const valid = {
    id: VALID_UUID,
    encryptedBlob: validEncryptedField,
    encryptedOverview: validEncryptedField,
    keyVersion: 1,
    aadVersion: 1,
  };

  it("accepts valid input with aadVersion=1 and id", () => {
    expect(createE2EPasswordSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts aadVersion=0 without id", () => {
    const { id: _, ...rest } = valid;
    expect(createE2EPasswordSchema.safeParse({ ...rest, aadVersion: 0 }).success).toBe(true);
  });

  it("rejects aadVersion=1 without id", () => {
    const { id: _, ...rest } = valid;
    expect(createE2EPasswordSchema.safeParse({ ...rest, aadVersion: 1 }).success).toBe(false);
  });

  it("rejects keyVersion below 1", () => {
    expect(createE2EPasswordSchema.safeParse({ ...valid, keyVersion: 0 }).success).toBe(false);
  });

  it("rejects missing encryptedBlob", () => {
    const { encryptedBlob: _, ...rest } = valid;
    expect(createE2EPasswordSchema.safeParse(rest).success).toBe(false);
  });

  it("accepts optional folderId as UUID", () => {
    expect(createE2EPasswordSchema.safeParse({ ...valid, folderId: VALID_UUID }).success).toBe(true);
  });

  it("accepts null folderId", () => {
    expect(createE2EPasswordSchema.safeParse({ ...valid, folderId: null }).success).toBe(true);
  });
});

describe("updateE2EPasswordSchema", () => {
  it("accepts empty object (all optional)", () => {
    expect(updateE2EPasswordSchema.safeParse({}).success).toBe(true);
  });

  it("accepts partial update with isFavorite", () => {
    expect(updateE2EPasswordSchema.safeParse({ isFavorite: true }).success).toBe(true);
  });

  it("rejects keyVersion below 1 when provided", () => {
    expect(updateE2EPasswordSchema.safeParse({ keyVersion: 0 }).success).toBe(false);
  });

  it("accepts valid entryType", () => {
    expect(updateE2EPasswordSchema.safeParse({ entryType: "CREDIT_CARD" }).success).toBe(true);
  });
});

describe("generateRequestSchema", () => {
  it("accepts explicit mode=password", () => {
    expect(generateRequestSchema.safeParse({ mode: "password", length: 16 }).success).toBe(true);
  });

  it("accepts explicit mode=passphrase", () => {
    expect(generateRequestSchema.safeParse({ mode: "passphrase", wordCount: 4 }).success).toBe(true);
  });

  it("adds mode=password when mode is absent (legacy fallback)", () => {
    const result = generateRequestSchema.safeParse({ length: 20 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.mode).toBe("password");
  });

  it("rejects unknown mode", () => {
    expect(generateRequestSchema.safeParse({ mode: "diceware" }).success).toBe(false);
  });
});

describe("historyReencryptSchema", () => {
  const valid = {
    encryptedBlob: "blobdata",
    blobIv: HEX_IV,
    blobAuthTag: HEX_AUTH_TAG,
    keyVersion: 2,
    oldBlobHash: HEX_HASH,
  };

  it("accepts valid input", () => {
    expect(historyReencryptSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects empty encryptedBlob", () => {
    expect(historyReencryptSchema.safeParse({ ...valid, encryptedBlob: "" }).success).toBe(false);
  });

  it("rejects blobIv with wrong length", () => {
    expect(historyReencryptSchema.safeParse({ ...valid, blobIv: "short" }).success).toBe(false);
  });

  it("rejects blobAuthTag with wrong length", () => {
    expect(historyReencryptSchema.safeParse({ ...valid, blobAuthTag: "short" }).success).toBe(false);
  });

  it("rejects oldBlobHash with wrong length", () => {
    expect(historyReencryptSchema.safeParse({ ...valid, oldBlobHash: "badhash" }).success).toBe(false);
  });
});

describe("teamHistoryReencryptSchema", () => {
  const valid = {
    encryptedBlob: "blobdata",
    blobIv: HEX_IV,
    blobAuthTag: HEX_AUTH_TAG,
    teamKeyVersion: 2,
    oldBlobHash: HEX_HASH,
  };

  it("accepts valid input without item key fields", () => {
    expect(teamHistoryReencryptSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts valid input with optional item key fields", () => {
    expect(teamHistoryReencryptSchema.safeParse({
      ...valid,
      itemKeyVersion: 1,
      encryptedItemKey: "itemkeydata",
      itemKeyIv: HEX_IV,
      itemKeyAuthTag: HEX_AUTH_TAG,
    }).success).toBe(true);
  });

  it("rejects missing blobIv", () => {
    const { blobIv: _, ...rest } = valid;
    expect(teamHistoryReencryptSchema.safeParse(rest).success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// send.ts
// ═══════════════════════════════════════════════════════════════

describe("isValidSendFilename", () => {
  it("accepts a normal filename", () => {
    expect(isValidSendFilename("report.pdf")).toBe(true);
  });

  it("accepts a filename with CJK characters", () => {
    expect(isValidSendFilename("レポート.txt")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isValidSendFilename("")).toBe(false);
  });

  it("rejects filename with leading dot (hidden file)", () => {
    expect(isValidSendFilename(".hidden")).toBe(false);
  });

  it("rejects filename with trailing dot", () => {
    expect(isValidSendFilename("file.")).toBe(false);
  });

  it("rejects filename with path separator", () => {
    expect(isValidSendFilename("path/to/file.txt")).toBe(false);
  });

  it("rejects filename with leading/trailing whitespace", () => {
    expect(isValidSendFilename(" file.txt")).toBe(false);
    expect(isValidSendFilename("file.txt ")).toBe(false);
  });

  it("rejects Windows reserved name CON", () => {
    expect(isValidSendFilename("CON")).toBe(false);
  });

  it("rejects Windows reserved name NUL", () => {
    expect(isValidSendFilename("NUL.txt")).toBe(false);
  });
});

describe("createSendTextSchema", () => {
  const valid = {
    name: "My Send",
    text: "Hello world",
    expiresIn: "7d" as const,
  };

  it("accepts valid input", () => {
    expect(createSendTextSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects empty name", () => {
    expect(createSendTextSchema.safeParse({ ...valid, name: "" }).success).toBe(false);
  });

  it("rejects name exceeding 200 chars", () => {
    expect(createSendTextSchema.safeParse({ ...valid, name: "x".repeat(201) }).success).toBe(false);
  });

  it("rejects empty text", () => {
    expect(createSendTextSchema.safeParse({ ...valid, text: "" }).success).toBe(false);
  });

  it("rejects invalid expiresIn", () => {
    expect(createSendTextSchema.safeParse({ ...valid, expiresIn: "2d" }).success).toBe(false);
  });

  it("accepts optional maxViews within range", () => {
    expect(createSendTextSchema.safeParse({ ...valid, maxViews: 5 }).success).toBe(true);
  });

  it("rejects maxViews of 0", () => {
    expect(createSendTextSchema.safeParse({ ...valid, maxViews: 0 }).success).toBe(false);
  });
});

describe("createSendFileMetaSchema", () => {
  const valid = {
    name: "My File Send",
    expiresIn: "30d" as const,
  };

  it("accepts valid input", () => {
    expect(createSendFileMetaSchema.safeParse(valid).success).toBe(true);
  });

  it("coerces string maxViews to number", () => {
    const result = createSendFileMetaSchema.safeParse({ ...valid, maxViews: "5" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.maxViews).toBe(5);
  });

  it("transforms requirePassword string 'true' to boolean true", () => {
    const result = createSendFileMetaSchema.safeParse({ ...valid, requirePassword: "true" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.requirePassword).toBe(true);
  });

  it("transforms requirePassword string 'false' to boolean false", () => {
    const result = createSendFileMetaSchema.safeParse({ ...valid, requirePassword: "false" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.requirePassword).toBe(false);
  });

  it("rejects empty name", () => {
    expect(createSendFileMetaSchema.safeParse({ ...valid, name: "" }).success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// emergency-access.ts
// ═══════════════════════════════════════════════════════════════

describe("createEmergencyGrantSchema", () => {
  it("accepts valid email and waitDays=7", () => {
    expect(createEmergencyGrantSchema.safeParse({
      granteeEmail: "grantee@example.com",
      waitDays: 7,
    }).success).toBe(true);
  });

  it("accepts waitDays=14", () => {
    expect(createEmergencyGrantSchema.safeParse({
      granteeEmail: "grantee@example.com",
      waitDays: 14,
    }).success).toBe(true);
  });

  it("accepts waitDays=30", () => {
    expect(createEmergencyGrantSchema.safeParse({
      granteeEmail: "grantee@example.com",
      waitDays: 30,
    }).success).toBe(true);
  });

  it("rejects invalid waitDays value (e.g. 10)", () => {
    expect(createEmergencyGrantSchema.safeParse({
      granteeEmail: "grantee@example.com",
      waitDays: 10,
    }).success).toBe(false);
  });

  it("rejects invalid email", () => {
    expect(createEmergencyGrantSchema.safeParse({
      granteeEmail: "not-an-email",
      waitDays: 7,
    }).success).toBe(false);
  });

  it("rejects missing waitDays", () => {
    expect(createEmergencyGrantSchema.safeParse({
      granteeEmail: "grantee@example.com",
    }).success).toBe(false);
  });
});

describe("acceptEmergencyGrantSchema", () => {
  const valid = {
    token: "valid-token-string",
    granteePublicKey: "publicKeyBase64Encoded==",
    encryptedPrivateKey: {
      ciphertext: "encrypteddata",
      iv: HEX_IV,
      authTag: HEX_AUTH_TAG,
    },
  };

  it("accepts valid input", () => {
    expect(acceptEmergencyGrantSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects empty token", () => {
    expect(acceptEmergencyGrantSchema.safeParse({ ...valid, token: "" }).success).toBe(false);
  });

  it("rejects token exceeding 128 chars", () => {
    expect(acceptEmergencyGrantSchema.safeParse({ ...valid, token: "x".repeat(129) }).success).toBe(false);
  });

  it("rejects missing granteePublicKey", () => {
    const { granteePublicKey: _, ...rest } = valid;
    expect(acceptEmergencyGrantSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects encryptedPrivateKey with wrong IV length", () => {
    expect(acceptEmergencyGrantSchema.safeParse({
      ...valid,
      encryptedPrivateKey: { ...valid.encryptedPrivateKey, iv: "short" },
    }).success).toBe(false);
  });

  it("rejects encryptedPrivateKey with wrong authTag length", () => {
    expect(acceptEmergencyGrantSchema.safeParse({
      ...valid,
      encryptedPrivateKey: { ...valid.encryptedPrivateKey, authTag: "short" },
    }).success).toBe(false);
  });
});

describe("rejectEmergencyGrantSchema", () => {
  it("accepts valid token", () => {
    expect(rejectEmergencyGrantSchema.safeParse({ token: "abc123" }).success).toBe(true);
  });

  it("rejects empty token", () => {
    expect(rejectEmergencyGrantSchema.safeParse({ token: "" }).success).toBe(false);
  });

  it("rejects token exceeding 128 chars", () => {
    expect(rejectEmergencyGrantSchema.safeParse({ token: "x".repeat(129) }).success).toBe(false);
  });
});

describe("confirmEmergencyGrantSchema", () => {
  const valid = {
    ownerEphemeralPublicKey: "ownerEphPubKey",
    encryptedSecretKey: "encryptedSecKey",
    secretKeyIv: HEX_IV,
    secretKeyAuthTag: HEX_AUTH_TAG,
    hkdfSalt: HEX_SALT,
    wrapVersion: 1,
  };

  it("accepts valid input with wrapVersion=1", () => {
    expect(confirmEmergencyGrantSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects unsupported wrapVersion=2", () => {
    expect(confirmEmergencyGrantSchema.safeParse({ ...valid, wrapVersion: 2 }).success).toBe(false);
  });

  it("rejects wrapVersion=0", () => {
    expect(confirmEmergencyGrantSchema.safeParse({ ...valid, wrapVersion: 0 }).success).toBe(false);
  });

  it("rejects invalid hkdfSalt (wrong length)", () => {
    expect(confirmEmergencyGrantSchema.safeParse({ ...valid, hkdfSalt: "short" }).success).toBe(false);
  });

  it("rejects invalid secretKeyIv", () => {
    expect(confirmEmergencyGrantSchema.safeParse({ ...valid, secretKeyIv: "short" }).success).toBe(false);
  });

  it("accepts optional keyVersion", () => {
    expect(confirmEmergencyGrantSchema.safeParse({ ...valid, keyVersion: 3 }).success).toBe(true);
  });
});

describe("acceptEmergencyGrantByIdSchema", () => {
  const valid = {
    granteePublicKey: "publicKeyBase64Encoded==",
    encryptedPrivateKey: {
      ciphertext: "encrypteddata",
      iv: HEX_IV,
      authTag: HEX_AUTH_TAG,
    },
  };

  it("accepts valid input", () => {
    expect(acceptEmergencyGrantByIdSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects missing granteePublicKey", () => {
    const { granteePublicKey: _, ...rest } = valid;
    expect(acceptEmergencyGrantByIdSchema.safeParse(rest).success).toBe(false);
  });
});

describe("revokeEmergencyGrantSchema", () => {
  it("defaults permanent to true", () => {
    const result = revokeEmergencyGrantSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.permanent).toBe(true);
  });

  it("accepts permanent=false", () => {
    const result = revokeEmergencyGrantSchema.safeParse({ permanent: false });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.permanent).toBe(false);
  });

  it("rejects non-boolean permanent", () => {
    expect(revokeEmergencyGrantSchema.safeParse({ permanent: "yes" }).success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// folder.ts
// ═══════════════════════════════════════════════════════════════

describe("createFolderSchema", () => {
  it("accepts valid name only", () => {
    expect(createFolderSchema.safeParse({ name: "Work" }).success).toBe(true);
  });

  it("accepts name with optional parentId and sortOrder", () => {
    expect(createFolderSchema.safeParse({
      name: "Work",
      parentId: VALID_UUID,
      sortOrder: 0,
    }).success).toBe(true);
  });

  it("rejects empty name", () => {
    expect(createFolderSchema.safeParse({ name: "" }).success).toBe(false);
  });

  it("rejects name exceeding 100 chars", () => {
    expect(createFolderSchema.safeParse({ name: "x".repeat(101) }).success).toBe(false);
  });

  it("rejects negative sortOrder", () => {
    expect(createFolderSchema.safeParse({ name: "Work", sortOrder: -1 }).success).toBe(false);
  });

  it("accepts null parentId (root folder)", () => {
    expect(createFolderSchema.safeParse({ name: "Work", parentId: null }).success).toBe(true);
  });

  it("rejects non-UUID parentId", () => {
    expect(createFolderSchema.safeParse({ name: "Work", parentId: "invalid" }).success).toBe(false);
  });
});

describe("updateFolderSchema", () => {
  it("accepts empty object (all optional)", () => {
    expect(updateFolderSchema.safeParse({}).success).toBe(true);
  });

  it("accepts name-only update", () => {
    expect(updateFolderSchema.safeParse({ name: "Personal" }).success).toBe(true);
  });

  it("accepts sortOrder-only update", () => {
    expect(updateFolderSchema.safeParse({ sortOrder: 5 }).success).toBe(true);
  });

  it("rejects name exceeding 100 chars", () => {
    expect(updateFolderSchema.safeParse({ name: "x".repeat(101) }).success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// tag.ts
// ═══════════════════════════════════════════════════════════════

describe("createTagSchema", () => {
  it("accepts name only", () => {
    expect(createTagSchema.safeParse({ name: "personal" }).success).toBe(true);
  });

  it("accepts name with valid hex color", () => {
    expect(createTagSchema.safeParse({ name: "personal", color: "#aabbcc" }).success).toBe(true);
  });

  it("accepts empty string color", () => {
    expect(createTagSchema.safeParse({ name: "personal", color: "" }).success).toBe(true);
  });

  it("accepts null color (transforms to undefined)", () => {
    expect(createTagSchema.safeParse({ name: "personal", color: null }).success).toBe(true);
  });

  it("rejects invalid color (not hex)", () => {
    expect(createTagSchema.safeParse({ name: "personal", color: "blue" }).success).toBe(false);
  });

  it("rejects empty name", () => {
    expect(createTagSchema.safeParse({ name: "" }).success).toBe(false);
  });

  it("rejects name exceeding 50 chars", () => {
    expect(createTagSchema.safeParse({ name: "x".repeat(51) }).success).toBe(false);
  });

  it("accepts optional UUID parentId", () => {
    expect(createTagSchema.safeParse({ name: "personal", parentId: VALID_UUID }).success).toBe(true);
  });
});

describe("updateTagSchema", () => {
  it("accepts empty object (all optional)", () => {
    expect(updateTagSchema.safeParse({}).success).toBe(true);
  });

  it("accepts name-only update", () => {
    expect(updateTagSchema.safeParse({ name: "work" }).success).toBe(true);
  });

  it("accepts null color", () => {
    expect(updateTagSchema.safeParse({ color: null }).success).toBe(true);
  });

  it("accepts empty string color", () => {
    expect(updateTagSchema.safeParse({ color: "" }).success).toBe(true);
  });

  it("rejects invalid color", () => {
    expect(updateTagSchema.safeParse({ color: "#gggggg" }).success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// api-key.ts
// ═══════════════════════════════════════════════════════════════

describe("apiKeyCreateSchema", () => {
  function futureDate(daysFromNow: number): string {
    const d = new Date();
    d.setDate(d.getDate() + daysFromNow);
    return d.toISOString();
  }

  const valid = {
    name: "My API Key",
    scope: ["passwords:read"],
    expiresAt: futureDate(30),
  };

  it("accepts valid input", () => {
    expect(apiKeyCreateSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts all valid scopes", () => {
    expect(apiKeyCreateSchema.safeParse({
      ...valid,
      scope: ["passwords:read", "passwords:write", "tags:read", "vault:status"],
    }).success).toBe(true);
  });

  it("rejects empty name", () => {
    expect(apiKeyCreateSchema.safeParse({ ...valid, name: "" }).success).toBe(false);
  });

  it("rejects name exceeding 100 chars", () => {
    expect(apiKeyCreateSchema.safeParse({ ...valid, name: "x".repeat(101) }).success).toBe(false);
  });

  it("rejects empty scope array", () => {
    expect(apiKeyCreateSchema.safeParse({ ...valid, scope: [] }).success).toBe(false);
  });

  it("rejects invalid scope value", () => {
    expect(apiKeyCreateSchema.safeParse({ ...valid, scope: ["vault:unlock"] }).success).toBe(false);
  });

  it("rejects past expiry date", () => {
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 1);
    expect(apiKeyCreateSchema.safeParse({ ...valid, expiresAt: pastDate.toISOString() }).success).toBe(false);
  });

  it("rejects expiry beyond 365 days", () => {
    expect(apiKeyCreateSchema.safeParse({ ...valid, expiresAt: futureDate(366) }).success).toBe(false);
  });

  it("accepts expiry exactly at 365 days", () => {
    // Use 364 days to avoid millisecond boundary issues
    expect(apiKeyCreateSchema.safeParse({ ...valid, expiresAt: futureDate(364) }).success).toBe(true);
  });

  it("coerces date string to Date object", () => {
    const result = apiKeyCreateSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.expiresAt).toBeInstanceOf(Date);
  });
});
