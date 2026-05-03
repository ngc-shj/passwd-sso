import { describe, expect, it } from "vitest";
import {
  slugRegex,
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
  bulkTeamImportSchema,
} from "@/lib/validations/team";
import {
  NAME_MAX_LENGTH,
  SLUG_MIN_LENGTH,
  SLUG_MAX_LENGTH,
  DESCRIPTION_MAX_LENGTH,
  TAG_NAME_MAX_LENGTH,
  POLICY_MIN_PW_LENGTH_MAX,
  SESSION_IDLE_TIMEOUT_MIN,
  SESSION_IDLE_TIMEOUT_MAX,
  SESSION_ABSOLUTE_TIMEOUT_MIN,
  SESSION_ABSOLUTE_TIMEOUT_MAX,
  PASSWORD_HISTORY_COUNT_MAX,
  MAX_CIDRS,
  ENCRYPTED_TEAM_KEY_MAX,
  EPHEMERAL_PUBLIC_KEY_MAX,
  FILENAME_MAX_LENGTH,
  HEX_IV_LENGTH,
  HEX_AUTH_TAG_LENGTH,
  HEX_SALT_LENGTH,
} from "@/lib/validations/common";
import {
  TEAM_ROLE,
  TEAM_ROLE_VALUES,
  TEAM_INVITE_ROLE_VALUES,
  TENANT_ROLE_VALUES,
} from "@/lib/constants";
import { BULK_IMPORT_MAX_ENTRIES } from "@/lib/validations/entry";

const VALID_UUID = "00000000-0000-4000-a000-000000000001";
const VALID_UUID_2 = "00000000-0000-4000-a000-000000000002";
const HEX_IV = "a".repeat(HEX_IV_LENGTH);
const HEX_AUTH_TAG = "b".repeat(HEX_AUTH_TAG_LENGTH);
const HEX_SALT = "c".repeat(HEX_SALT_LENGTH);

const validEncryptedField = (): {
  ciphertext: string;
  iv: string;
  authTag: string;
} => ({
  ciphertext: "deadbeef",
  iv: HEX_IV,
  authTag: HEX_AUTH_TAG,
});

// ─── slugRegex ──────────────────────────────────────────────

describe("slugRegex", () => {
  it("accepts lowercase alphanumeric slugs", () => {
    expect(slugRegex.test("team")).toBe(true);
    expect(slugRegex.test("team-1")).toBe(true);
    expect(slugRegex.test("a1")).toBe(true);
  });

  it("rejects slug starting with hyphen", () => {
    expect(slugRegex.test("-team")).toBe(false);
  });

  it("rejects slug ending with hyphen", () => {
    expect(slugRegex.test("team-")).toBe(false);
  });

  it("rejects uppercase characters", () => {
    expect(slugRegex.test("Team")).toBe(false);
  });

  it("rejects underscores", () => {
    expect(slugRegex.test("my_team")).toBe(false);
  });
});

// ─── createTeamSchema ───────────────────────────────────────

describe("createTeamSchema", () => {
  const valid = { name: "Engineering", slug: "engineering" };

  it("accepts valid input", () => {
    expect(createTeamSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects when name is missing", () => {
    const { name: _, ...rest } = valid;
    expect(createTeamSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects when slug is missing", () => {
    const { slug: _, ...rest } = valid;
    expect(createTeamSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects empty name", () => {
    expect(
      createTeamSchema.safeParse({ ...valid, name: "" }).success,
    ).toBe(false);
  });

  it(`rejects name at max+1 length (${NAME_MAX_LENGTH + 1})`, () => {
    const result = createTeamSchema.safeParse({
      ...valid,
      name: "n".repeat(NAME_MAX_LENGTH + 1),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "name");
      expect(issue?.code).toBe("too_big");
    }
  });

  it(`rejects slug below min length (${SLUG_MIN_LENGTH - 1})`, () => {
    const result = createTeamSchema.safeParse({ ...valid, slug: "a" });
    expect(result.success).toBe(false);
  });

  it(`rejects slug at max+1 length (${SLUG_MAX_LENGTH + 1})`, () => {
    const result = createTeamSchema.safeParse({
      ...valid,
      slug: "a".repeat(SLUG_MAX_LENGTH + 1),
    });
    expect(result.success).toBe(false);
  });

  it("rejects slug failing the regex", () => {
    const result = createTeamSchema.safeParse({ ...valid, slug: "Bad_Slug" });
    expect(result.success).toBe(false);
  });

  it(`rejects description at max+1 length (${DESCRIPTION_MAX_LENGTH + 1})`, () => {
    const result = createTeamSchema.safeParse({
      ...valid,
      description: "d".repeat(DESCRIPTION_MAX_LENGTH + 1),
    });
    expect(result.success).toBe(false);
  });
});

// ─── teamMemberKeySchema ────────────────────────────────────

describe("teamMemberKeySchema", () => {
  const valid = (): {
    encryptedTeamKey: string;
    teamKeyIv: string;
    teamKeyAuthTag: string;
    ephemeralPublicKey: string;
    hkdfSalt: string;
    keyVersion: number;
    wrapVersion: number;
  } => ({
    encryptedTeamKey: "encrypted",
    teamKeyIv: HEX_IV,
    teamKeyAuthTag: HEX_AUTH_TAG,
    ephemeralPublicKey: "epheKey",
    hkdfSalt: HEX_SALT,
    keyVersion: 1,
    wrapVersion: 1,
  });

  it("accepts valid input", () => {
    expect(teamMemberKeySchema.safeParse(valid()).success).toBe(true);
  });

  it("defaults wrapVersion to 1 when omitted", () => {
    const { wrapVersion: _, ...rest } = valid();
    const result = teamMemberKeySchema.safeParse(rest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.wrapVersion).toBe(1);
    }
  });

  it("rejects missing encryptedTeamKey", () => {
    const { encryptedTeamKey: _, ...rest } = valid();
    expect(teamMemberKeySchema.safeParse(rest).success).toBe(false);
  });

  it("rejects empty encryptedTeamKey", () => {
    expect(
      teamMemberKeySchema.safeParse({ ...valid(), encryptedTeamKey: "" })
        .success,
    ).toBe(false);
  });

  it(`rejects encryptedTeamKey at max+1 length (${ENCRYPTED_TEAM_KEY_MAX + 1})`, () => {
    const result = teamMemberKeySchema.safeParse({
      ...valid(),
      encryptedTeamKey: "x".repeat(ENCRYPTED_TEAM_KEY_MAX + 1),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (i) => i.path[0] === "encryptedTeamKey",
      );
      expect(issue?.code).toBe("too_big");
    }
  });

  it(`rejects ephemeralPublicKey at max+1 length (${EPHEMERAL_PUBLIC_KEY_MAX + 1})`, () => {
    const result = teamMemberKeySchema.safeParse({
      ...valid(),
      ephemeralPublicKey: "y".repeat(EPHEMERAL_PUBLIC_KEY_MAX + 1),
    });
    expect(result.success).toBe(false);
  });

  it("rejects keyVersion below 1", () => {
    const result = teamMemberKeySchema.safeParse({ ...valid(), keyVersion: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects wrapVersion above max (2)", () => {
    const result = teamMemberKeySchema.safeParse({
      ...valid(),
      wrapVersion: 2,
    });
    expect(result.success).toBe(false);
  });

  it("rejects malformed teamKeyIv", () => {
    expect(
      teamMemberKeySchema.safeParse({ ...valid(), teamKeyIv: "abc" }).success,
    ).toBe(false);
  });
});

// ─── createTeamE2ESchema ────────────────────────────────────

describe("createTeamE2ESchema", () => {
  const valid = (): Record<string, unknown> => ({
    id: VALID_UUID,
    name: "Engineering",
    slug: "engineering",
    teamMemberKey: {
      encryptedTeamKey: "encrypted",
      teamKeyIv: HEX_IV,
      teamKeyAuthTag: HEX_AUTH_TAG,
      ephemeralPublicKey: "epheKey",
      hkdfSalt: HEX_SALT,
      keyVersion: 1,
      wrapVersion: 1,
    },
  });

  it("accepts valid input", () => {
    expect(createTeamE2ESchema.safeParse(valid()).success).toBe(true);
  });

  it("rejects missing id", () => {
    const { id: _, ...rest } = valid();
    expect(createTeamE2ESchema.safeParse(rest).success).toBe(false);
  });

  it("rejects missing teamMemberKey", () => {
    const { teamMemberKey: _, ...rest } = valid();
    expect(createTeamE2ESchema.safeParse(rest).success).toBe(false);
  });

  it("rejects non-UUID id", () => {
    expect(
      createTeamE2ESchema.safeParse({ ...valid(), id: "not-a-uuid" }).success,
    ).toBe(false);
  });
});

// ─── createTeamE2EPasswordSchema ────────────────────────────

describe("createTeamE2EPasswordSchema", () => {
  const valid = (): Record<string, unknown> => ({
    id: VALID_UUID,
    encryptedBlob: validEncryptedField(),
    encryptedOverview: validEncryptedField(),
    aadVersion: 1,
    teamKeyVersion: 1,
    itemKeyVersion: 0,
  });

  it("accepts valid minimal input", () => {
    expect(createTeamE2EPasswordSchema.safeParse(valid()).success).toBe(true);
  });

  it("accepts itemKeyVersion>=1 with encryptedItemKey present", () => {
    const result = createTeamE2EPasswordSchema.safeParse({
      ...valid(),
      itemKeyVersion: 1,
      encryptedItemKey: validEncryptedField(),
    });
    expect(result.success).toBe(true);
  });

  it("rejects itemKeyVersion>=1 without encryptedItemKey", () => {
    const result = createTeamE2EPasswordSchema.safeParse({
      ...valid(),
      itemKeyVersion: 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects itemKeyVersion=0 with encryptedItemKey present", () => {
    const result = createTeamE2EPasswordSchema.safeParse({
      ...valid(),
      itemKeyVersion: 0,
      encryptedItemKey: validEncryptedField(),
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing id", () => {
    const { id: _, ...rest } = valid();
    expect(createTeamE2EPasswordSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects missing encryptedBlob", () => {
    const { encryptedBlob: _, ...rest } = valid();
    expect(createTeamE2EPasswordSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects aadVersion below 1", () => {
    const result = createTeamE2EPasswordSchema.safeParse({
      ...valid(),
      aadVersion: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects teamKeyVersion below 1", () => {
    const result = createTeamE2EPasswordSchema.safeParse({
      ...valid(),
      teamKeyVersion: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-UUID inside tagIds array", () => {
    const result = createTeamE2EPasswordSchema.safeParse({
      ...valid(),
      tagIds: ["bad"],
    });
    expect(result.success).toBe(false);
  });

  it("accepts teamFolderId=null", () => {
    const result = createTeamE2EPasswordSchema.safeParse({
      ...valid(),
      teamFolderId: null,
    });
    expect(result.success).toBe(true);
  });
});

// ─── updateTeamE2EPasswordSchema ────────────────────────────

describe("updateTeamE2EPasswordSchema", () => {
  it("accepts an empty object (metadata-only with all fields absent)", () => {
    expect(updateTeamE2EPasswordSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a full encrypted-blob update (all four E2E fields present)", () => {
    const result = updateTeamE2EPasswordSchema.safeParse({
      encryptedBlob: validEncryptedField(),
      encryptedOverview: validEncryptedField(),
      aadVersion: 1,
      teamKeyVersion: 1,
    });
    expect(result.success).toBe(true);
  });

  it("rejects partial encrypted-blob update (some present, some absent)", () => {
    const result = updateTeamE2EPasswordSchema.safeParse({
      encryptedBlob: validEncryptedField(),
      // encryptedOverview, aadVersion, teamKeyVersion missing
    });
    expect(result.success).toBe(false);
  });

  it("rejects encryptedItemKey when itemKeyVersion is absent", () => {
    const result = updateTeamE2EPasswordSchema.safeParse({
      encryptedItemKey: validEncryptedField(),
    });
    expect(result.success).toBe(false);
  });

  it("rejects encryptedItemKey when itemKeyVersion=0", () => {
    const result = updateTeamE2EPasswordSchema.safeParse({
      itemKeyVersion: 0,
      encryptedItemKey: validEncryptedField(),
    });
    expect(result.success).toBe(false);
  });

  it("accepts itemKeyVersion>=1 without encryptedItemKey (reuse existing)", () => {
    const result = updateTeamE2EPasswordSchema.safeParse({ itemKeyVersion: 1 });
    expect(result.success).toBe(true);
  });

  it("rejects expiresAt without offset", () => {
    const result = updateTeamE2EPasswordSchema.safeParse({
      expiresAt: "2026-01-01T10:00:00",
    });
    expect(result.success).toBe(false);
  });
});

// ─── updateTeamSchema ───────────────────────────────────────

describe("updateTeamSchema", () => {
  it("accepts an empty object", () => {
    expect(updateTeamSchema.safeParse({}).success).toBe(true);
  });

  it("accepts description='' literal", () => {
    expect(updateTeamSchema.safeParse({ description: "" }).success).toBe(true);
  });

  it("rejects empty name when present", () => {
    expect(updateTeamSchema.safeParse({ name: "" }).success).toBe(false);
  });

  it(`rejects name at max+1 length (${NAME_MAX_LENGTH + 1})`, () => {
    expect(
      updateTeamSchema.safeParse({ name: "n".repeat(NAME_MAX_LENGTH + 1) })
        .success,
    ).toBe(false);
  });

  it(`rejects description at max+1 length (${DESCRIPTION_MAX_LENGTH + 1})`, () => {
    expect(
      updateTeamSchema.safeParse({
        description: "d".repeat(DESCRIPTION_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });
});

// ─── upsertTeamPolicySchema ─────────────────────────────────

describe("upsertTeamPolicySchema", () => {
  it("accepts an empty object (all defaults applied)", () => {
    const result = upsertTeamPolicySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.minPasswordLength).toBe(0);
      expect(result.data.allowExport).toBe(true);
      expect(result.data.allowSharing).toBe(true);
      expect(result.data.teamAllowedCidrs).toEqual([]);
    }
  });

  it(`rejects minPasswordLength at max+1 (${POLICY_MIN_PW_LENGTH_MAX + 1})`, () => {
    const result = upsertTeamPolicySchema.safeParse({
      minPasswordLength: POLICY_MIN_PW_LENGTH_MAX + 1,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (i) => i.path[0] === "minPasswordLength",
      );
      expect(issue?.code).toBe("too_big");
    }
  });

  it("rejects minPasswordLength below 0", () => {
    const result = upsertTeamPolicySchema.safeParse({ minPasswordLength: -1 });
    expect(result.success).toBe(false);
  });

  it(`rejects sessionIdleTimeoutMinutes below min (${SESSION_IDLE_TIMEOUT_MIN - 1})`, () => {
    const result = upsertTeamPolicySchema.safeParse({
      sessionIdleTimeoutMinutes: SESSION_IDLE_TIMEOUT_MIN - 1,
    });
    expect(result.success).toBe(false);
  });

  it(`rejects sessionIdleTimeoutMinutes above max+1 (${SESSION_IDLE_TIMEOUT_MAX + 1})`, () => {
    const result = upsertTeamPolicySchema.safeParse({
      sessionIdleTimeoutMinutes: SESSION_IDLE_TIMEOUT_MAX + 1,
    });
    expect(result.success).toBe(false);
  });

  it(`rejects sessionAbsoluteTimeoutMinutes above max+1 (${SESSION_ABSOLUTE_TIMEOUT_MAX + 1})`, () => {
    const result = upsertTeamPolicySchema.safeParse({
      sessionAbsoluteTimeoutMinutes: SESSION_ABSOLUTE_TIMEOUT_MAX + 1,
    });
    expect(result.success).toBe(false);
  });

  it("accepts sessionIdleTimeoutMinutes=null (inherit tenant)", () => {
    const result = upsertTeamPolicySchema.safeParse({
      sessionIdleTimeoutMinutes: null,
      sessionAbsoluteTimeoutMinutes: null,
    });
    expect(result.success).toBe(true);
  });

  it(`rejects passwordHistoryCount above max+1 (${PASSWORD_HISTORY_COUNT_MAX + 1})`, () => {
    const result = upsertTeamPolicySchema.safeParse({
      passwordHistoryCount: PASSWORD_HISTORY_COUNT_MAX + 1,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (i) => i.path[0] === "passwordHistoryCount",
      );
      expect(issue?.code).toBe("too_big");
    }
  });

  it(`rejects teamAllowedCidrs length above max+1 (${MAX_CIDRS + 1})`, () => {
    const result = upsertTeamPolicySchema.safeParse({
      teamAllowedCidrs: Array.from(
        { length: MAX_CIDRS + 1 },
        (_, i) => `10.0.${i}.0/24`,
      ),
    });
    expect(result.success).toBe(false);
  });

  it("rejects requireUppercase as a string (type mismatch)", () => {
    const result = upsertTeamPolicySchema.safeParse({
      requireUppercase: "true",
    });
    expect(result.success).toBe(false);
  });

  it(`rejects sessionAbsoluteTimeoutMinutes below min (${SESSION_ABSOLUTE_TIMEOUT_MIN - 1})`, () => {
    const result = upsertTeamPolicySchema.safeParse({
      sessionAbsoluteTimeoutMinutes: SESSION_ABSOLUTE_TIMEOUT_MIN - 1,
    });
    expect(result.success).toBe(false);
  });
});

// ─── inviteSchema ───────────────────────────────────────────

describe("inviteSchema", () => {
  it("accepts a valid email and defaults role to MEMBER", () => {
    const result = inviteSchema.safeParse({ email: "alice@example.com" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.role).toBe(TEAM_ROLE.MEMBER);
    }
  });

  it("accepts every invite role", () => {
    for (const role of TEAM_INVITE_ROLE_VALUES) {
      const result = inviteSchema.safeParse({ email: "a@b.com", role });
      expect(result.success).toBe(true);
    }
  });

  it("rejects OWNER role (not in invite enum)", () => {
    const result = inviteSchema.safeParse({
      email: "a@b.com",
      role: TEAM_ROLE.OWNER,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid email", () => {
    const result = inviteSchema.safeParse({ email: "not-an-email" });
    expect(result.success).toBe(false);
  });

  it("rejects when email is missing", () => {
    expect(inviteSchema.safeParse({}).success).toBe(false);
  });
});

// ─── addMemberSchema ────────────────────────────────────────

describe("addMemberSchema", () => {
  const valid = { userId: VALID_UUID };

  it("accepts a valid user UUID", () => {
    const result = addMemberSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.role).toBe(TEAM_ROLE.MEMBER);
    }
  });

  it("rejects non-UUID userId", () => {
    expect(
      addMemberSchema.safeParse({ userId: "not-a-uuid" }).success,
    ).toBe(false);
  });

  it("rejects when userId is missing", () => {
    expect(addMemberSchema.safeParse({}).success).toBe(false);
  });

  it("rejects OWNER role (not in invite enum)", () => {
    const result = addMemberSchema.safeParse({
      ...valid,
      role: TEAM_ROLE.OWNER,
    });
    expect(result.success).toBe(false);
  });
});

// ─── updateMemberRoleSchema ─────────────────────────────────

describe("updateMemberRoleSchema", () => {
  it("accepts every team role (incl. OWNER)", () => {
    for (const role of TEAM_ROLE_VALUES) {
      expect(updateMemberRoleSchema.safeParse({ role }).success).toBe(true);
    }
  });

  it("rejects unknown role", () => {
    expect(
      updateMemberRoleSchema.safeParse({ role: "GOD" }).success,
    ).toBe(false);
  });

  it("rejects when role is missing", () => {
    expect(updateMemberRoleSchema.safeParse({}).success).toBe(false);
  });
});

// ─── updateTenantMemberRoleSchema ───────────────────────────

describe("updateTenantMemberRoleSchema", () => {
  it("accepts every tenant role", () => {
    for (const role of TENANT_ROLE_VALUES) {
      expect(updateTenantMemberRoleSchema.safeParse({ role }).success).toBe(
        true,
      );
    }
  });

  it("rejects unknown role", () => {
    expect(
      updateTenantMemberRoleSchema.safeParse({ role: "BAD" }).success,
    ).toBe(false);
  });

  it("rejects when role is missing", () => {
    expect(updateTenantMemberRoleSchema.safeParse({}).success).toBe(false);
  });
});

// ─── createTeamTagSchema ────────────────────────────────────

describe("createTeamTagSchema", () => {
  it("accepts valid minimal input", () => {
    expect(createTeamTagSchema.safeParse({ name: "tag" }).success).toBe(true);
  });

  it("accepts color=null and color=''", () => {
    expect(
      createTeamTagSchema.safeParse({ name: "x", color: null }).success,
    ).toBe(true);
    expect(
      createTeamTagSchema.safeParse({ name: "x", color: "" }).success,
    ).toBe(true);
  });

  it("rejects when name is missing", () => {
    expect(createTeamTagSchema.safeParse({}).success).toBe(false);
  });

  it(`rejects name at max+1 length (${TAG_NAME_MAX_LENGTH + 1})`, () => {
    const result = createTeamTagSchema.safeParse({
      name: "n".repeat(TAG_NAME_MAX_LENGTH + 1),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "name");
      expect(issue?.code).toBe("too_big");
    }
  });

  it("rejects malformed color", () => {
    const result = createTeamTagSchema.safeParse({
      name: "x",
      color: "#zzz",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-UUID parentId", () => {
    expect(
      createTeamTagSchema.safeParse({ name: "x", parentId: "abc" }).success,
    ).toBe(false);
  });

  it("accepts UUID parentId", () => {
    expect(
      createTeamTagSchema.safeParse({ name: "x", parentId: VALID_UUID_2 })
        .success,
    ).toBe(true);
  });
});

// ─── updateTeamTagSchema ────────────────────────────────────

describe("updateTeamTagSchema", () => {
  it("accepts an empty object", () => {
    expect(updateTeamTagSchema.safeParse({}).success).toBe(true);
  });

  it("rejects empty name when present", () => {
    expect(updateTeamTagSchema.safeParse({ name: "" }).success).toBe(false);
  });

  it(`rejects name at max+1 length (${TAG_NAME_MAX_LENGTH + 1})`, () => {
    expect(
      updateTeamTagSchema.safeParse({
        name: "n".repeat(TAG_NAME_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });
});

// ─── invitationAcceptSchema ─────────────────────────────────

describe("invitationAcceptSchema", () => {
  it("accepts a valid token", () => {
    expect(invitationAcceptSchema.safeParse({ token: "tok" }).success).toBe(
      true,
    );
  });

  it("rejects empty token", () => {
    expect(invitationAcceptSchema.safeParse({ token: "" }).success).toBe(false);
  });

  it("rejects when token is missing", () => {
    expect(invitationAcceptSchema.safeParse({}).success).toBe(false);
  });

  it("rejects when token is a number", () => {
    expect(invitationAcceptSchema.safeParse({ token: 1 }).success).toBe(false);
  });
});

// ─── bulkTeamImportSchema ───────────────────────────────────

describe("bulkTeamImportSchema", () => {
  const buildEntry = (): Record<string, unknown> => ({
    id: VALID_UUID,
    encryptedBlob: validEncryptedField(),
    encryptedOverview: validEncryptedField(),
    aadVersion: 1,
    teamKeyVersion: 1,
    itemKeyVersion: 0,
  });

  it("accepts a single-entry import", () => {
    expect(
      bulkTeamImportSchema.safeParse({ entries: [buildEntry()] }).success,
    ).toBe(true);
  });

  it("rejects empty entries array", () => {
    expect(bulkTeamImportSchema.safeParse({ entries: [] }).success).toBe(false);
  });

  it(`rejects entries above max+1 (${BULK_IMPORT_MAX_ENTRIES + 1})`, () => {
    const entries = Array.from(
      { length: BULK_IMPORT_MAX_ENTRIES + 1 },
      buildEntry,
    );
    const result = bulkTeamImportSchema.safeParse({ entries });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "entries");
      expect(issue?.code).toBe("too_big");
    }
  });

  it(`rejects sourceFilename at max+1 length (${FILENAME_MAX_LENGTH + 1})`, () => {
    const result = bulkTeamImportSchema.safeParse({
      entries: [buildEntry()],
      sourceFilename: "x".repeat(FILENAME_MAX_LENGTH + 1),
    });
    expect(result.success).toBe(false);
  });

  it("rejects when entries is missing", () => {
    expect(bulkTeamImportSchema.safeParse({}).success).toBe(false);
  });
});
