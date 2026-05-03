import { describe, expect, it } from "vitest";
import {
  createShareLinkSchema,
  verifyShareAccessSchema,
} from "@/lib/validations/share";
import {
  SHARE_ACCESS_PASSWORD_MAX,
  ENTRY_NAME_MAX,
  ENTRY_URL_MAX,
  ENTRY_NOTES_MAX,
  HEX_HASH_LENGTH,
  HEX_IV_LENGTH,
  HEX_AUTH_TAG_LENGTH,
} from "@/lib/validations/common";
import {
  ENTRY_TYPE,
  SHARE_PERMISSION_VALUES,
} from "@/lib/constants";

const VALID_UUID = "00000000-0000-4000-a000-000000000001";
const TEAM_UUID = "00000000-0000-4000-a000-000000000002";
const HEX_IV = "a".repeat(HEX_IV_LENGTH);
const HEX_AUTH_TAG = "b".repeat(HEX_AUTH_TAG_LENGTH);
const HEX_HASH = "d".repeat(HEX_HASH_LENGTH);

const validEncryptedField = (): {
  ciphertext: string;
  iv: string;
  authTag: string;
} => ({
  ciphertext: "deadbeef",
  iv: HEX_IV,
  authTag: HEX_AUTH_TAG,
});

// ─── createShareLinkSchema (personal entry path) ────────────

describe("createShareLinkSchema (personal)", () => {
  const valid = (): Record<string, unknown> => ({
    passwordEntryId: VALID_UUID,
    data: { title: "GitHub" },
    expiresIn: "1d",
  });

  it("accepts valid personal-entry input with data block", () => {
    expect(createShareLinkSchema.safeParse(valid()).success).toBe(true);
  });

  it("rejects when both passwordEntryId and teamPasswordEntryId are present", () => {
    const result = createShareLinkSchema.safeParse({
      ...valid(),
      teamPasswordEntryId: TEAM_UUID,
    });
    expect(result.success).toBe(false);
  });

  it("rejects when neither passwordEntryId nor teamPasswordEntryId is present", () => {
    const { passwordEntryId: _, ...rest } = valid();
    const result = createShareLinkSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects personal entry without data block", () => {
    const { data: _, ...rest } = valid();
    const result = createShareLinkSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects empty data.title", () => {
    const result = createShareLinkSchema.safeParse({
      ...valid(),
      data: { title: "" },
    });
    expect(result.success).toBe(false);
  });

  it(`rejects data.title at max+1 length (${ENTRY_NAME_MAX + 1})`, () => {
    const result = createShareLinkSchema.safeParse({
      ...valid(),
      data: { title: "x".repeat(ENTRY_NAME_MAX + 1) },
    });
    expect(result.success).toBe(false);
  });

  it(`rejects data.url at max+1 length (${ENTRY_URL_MAX + 1})`, () => {
    const result = createShareLinkSchema.safeParse({
      ...valid(),
      data: { title: "T", url: "u".repeat(ENTRY_URL_MAX + 1) },
    });
    expect(result.success).toBe(false);
  });

  it(`rejects data.notes at max+1 length (${ENTRY_NOTES_MAX + 1})`, () => {
    const result = createShareLinkSchema.safeParse({
      ...valid(),
      data: { title: "T", notes: "n".repeat(ENTRY_NOTES_MAX + 1) },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unsupported expiresIn value", () => {
    const result = createShareLinkSchema.safeParse({
      ...valid(),
      expiresIn: "999d",
    });
    expect(result.success).toBe(false);
  });

  it("rejects maxViews above max+1 (101)", () => {
    const result = createShareLinkSchema.safeParse({
      ...valid(),
      maxViews: 101,
    });
    expect(result.success).toBe(false);
  });

  it("rejects maxViews below min (0)", () => {
    const result = createShareLinkSchema.safeParse({
      ...valid(),
      maxViews: 0,
    });
    expect(result.success).toBe(false);
  });

  it("accepts permissions array containing each supported value", () => {
    const result = createShareLinkSchema.safeParse({
      ...valid(),
      permissions: [...SHARE_PERMISSION_VALUES],
    });
    expect(result.success).toBe(true);
  });

  it("rejects permissions containing an unknown value", () => {
    const result = createShareLinkSchema.safeParse({
      ...valid(),
      permissions: ["NOT_A_PERMISSION"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-UUID passwordEntryId", () => {
    const result = createShareLinkSchema.safeParse({
      ...valid(),
      passwordEntryId: "bad-uuid",
    });
    expect(result.success).toBe(false);
  });
});

// ─── createShareLinkSchema (team entry path) ────────────────

describe("createShareLinkSchema (team)", () => {
  const valid = (): Record<string, unknown> => ({
    teamPasswordEntryId: TEAM_UUID,
    encryptedShareData: validEncryptedField(),
    entryType: ENTRY_TYPE.LOGIN,
    expiresIn: "7d",
  });

  it("accepts valid team-entry input", () => {
    expect(createShareLinkSchema.safeParse(valid()).success).toBe(true);
  });

  it("rejects team entry without encryptedShareData", () => {
    const { encryptedShareData: _, ...rest } = valid();
    expect(createShareLinkSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects team entry without entryType", () => {
    const { entryType: _, ...rest } = valid();
    expect(createShareLinkSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects team entry that also includes a data block", () => {
    const result = createShareLinkSchema.safeParse({
      ...valid(),
      data: { title: "Should not be here" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects when entryType is unknown", () => {
    const result = createShareLinkSchema.safeParse({
      ...valid(),
      entryType: "FOO",
    });
    expect(result.success).toBe(false);
  });
});

// ─── verifyShareAccessSchema ────────────────────────────────

describe("verifyShareAccessSchema", () => {
  const valid = { token: HEX_HASH, password: "secret" };

  it("accepts valid input", () => {
    expect(verifyShareAccessSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects when token is missing", () => {
    const { token: _, ...rest } = valid;
    expect(verifyShareAccessSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects when password is missing", () => {
    const { password: _, ...rest } = valid;
    expect(verifyShareAccessSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects token with non-hex characters", () => {
    const result = verifyShareAccessSchema.safeParse({
      ...valid,
      token: "z".repeat(HEX_HASH_LENGTH),
    });
    expect(result.success).toBe(false);
  });

  it("rejects token with wrong length", () => {
    const result = verifyShareAccessSchema.safeParse({
      ...valid,
      token: "a".repeat(HEX_HASH_LENGTH - 1),
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty password", () => {
    const result = verifyShareAccessSchema.safeParse({ ...valid, password: "" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "password");
      expect(issue?.code).toBe("too_small");
    }
  });

  it(`rejects password at max+1 length (${SHARE_ACCESS_PASSWORD_MAX + 1})`, () => {
    const result = verifyShareAccessSchema.safeParse({
      ...valid,
      password: "p".repeat(SHARE_ACCESS_PASSWORD_MAX + 1),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "password");
      expect(issue?.code).toBe("too_big");
    }
  });

  it("rejects when password is a number", () => {
    const result = verifyShareAccessSchema.safeParse({
      ...valid,
      password: 42,
    });
    expect(result.success).toBe(false);
  });
});
