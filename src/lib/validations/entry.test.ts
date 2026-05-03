import { describe, expect, it } from "vitest";
import {
  entryTypeSchema,
  generatePasswordSchema,
  generatePassphraseSchema,
  createE2EPasswordSchema,
  updateE2EPasswordSchema,
  generateRequestSchema,
  historyReencryptSchema,
  teamHistoryReencryptSchema,
  bulkImportSchema,
  BULK_IMPORT_MAX_ENTRIES,
} from "@/lib/validations/entry";
import {
  PASSWORD_LENGTH_MIN,
  PASSWORD_LENGTH_MAX,
  PASSPHRASE_WORD_COUNT_MIN,
  PASSPHRASE_WORD_COUNT_MAX,
  PASSPHRASE_SEPARATOR_MAX,
  CHARS_FIELD_MAX,
  HISTORY_BLOB_MAX,
  FILENAME_MAX_LENGTH,
  HEX_IV_LENGTH,
  HEX_AUTH_TAG_LENGTH,
} from "@/lib/validations/common";
import { ENTRY_TYPE_VALUES } from "@/lib/constants";

const HEX_IV = "a".repeat(HEX_IV_LENGTH);
const HEX_AUTH_TAG = "b".repeat(HEX_AUTH_TAG_LENGTH);
const HEX_HASH = "d".repeat(64);
const VALID_UUID = "00000000-0000-4000-a000-000000000001";

const validEncryptedField = (): {
  ciphertext: string;
  iv: string;
  authTag: string;
} => ({
  ciphertext: "deadbeef",
  iv: HEX_IV,
  authTag: HEX_AUTH_TAG,
});

// ─── entryTypeSchema ─────────────────────────────────────────

describe("entryTypeSchema", () => {
  it("accepts every documented entry type", () => {
    for (const v of ENTRY_TYPE_VALUES) {
      expect(entryTypeSchema.safeParse(v).success).toBe(true);
    }
  });

  it("rejects an unknown entry type", () => {
    expect(entryTypeSchema.safeParse("UNKNOWN").success).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(entryTypeSchema.safeParse(0).success).toBe(false);
  });
});

// ─── generatePasswordSchema ─────────────────────────────────

describe("generatePasswordSchema", () => {
  it("accepts an empty object (all defaults applied)", () => {
    const result = generatePasswordSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.length).toBeGreaterThan(0);
      expect(result.data.uppercase).toBe(true);
      expect(result.data.symbols).toBe("");
    }
  });

  it("accepts length at lower bound", () => {
    const result = generatePasswordSchema.safeParse({ length: PASSWORD_LENGTH_MIN });
    expect(result.success).toBe(true);
  });

  it(`rejects length below min (${PASSWORD_LENGTH_MIN - 1})`, () => {
    const result = generatePasswordSchema.safeParse({
      length: PASSWORD_LENGTH_MIN - 1,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "length");
      expect(issue?.code).toBe("too_small");
    }
  });

  it(`rejects length above max (${PASSWORD_LENGTH_MAX + 1})`, () => {
    const result = generatePasswordSchema.safeParse({
      length: PASSWORD_LENGTH_MAX + 1,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "length");
      expect(issue?.code).toBe("too_big");
    }
  });

  it("rejects non-integer length", () => {
    const result = generatePasswordSchema.safeParse({ length: 16.5 });
    expect(result.success).toBe(false);
  });

  it("rejects non-ASCII characters in symbols field", () => {
    const result = generatePasswordSchema.safeParse({ symbols: "あ" });
    expect(result.success).toBe(false);
  });

  it(`rejects symbols at max+1 length (${CHARS_FIELD_MAX + 1})`, () => {
    const result = generatePasswordSchema.safeParse({
      symbols: "!".repeat(CHARS_FIELD_MAX + 1),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "symbols");
      expect(issue?.code).toBe("too_big");
    }
  });

  it(`rejects includeChars at max+1 length (${CHARS_FIELD_MAX + 1})`, () => {
    const result = generatePasswordSchema.safeParse({
      includeChars: "x".repeat(CHARS_FIELD_MAX + 1),
    });
    expect(result.success).toBe(false);
  });

  it("rejects when uppercase is a string (type mismatch)", () => {
    const result = generatePasswordSchema.safeParse({ uppercase: "true" });
    expect(result.success).toBe(false);
  });
});

// ─── generatePassphraseSchema ───────────────────────────────

describe("generatePassphraseSchema", () => {
  it("accepts an empty object (defaults)", () => {
    expect(generatePassphraseSchema.safeParse({}).success).toBe(true);
  });

  it(`rejects wordCount below min (${PASSPHRASE_WORD_COUNT_MIN - 1})`, () => {
    const result = generatePassphraseSchema.safeParse({
      wordCount: PASSPHRASE_WORD_COUNT_MIN - 1,
    });
    expect(result.success).toBe(false);
  });

  it(`rejects wordCount above max (${PASSPHRASE_WORD_COUNT_MAX + 1})`, () => {
    const result = generatePassphraseSchema.safeParse({
      wordCount: PASSPHRASE_WORD_COUNT_MAX + 1,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "wordCount");
      expect(issue?.code).toBe("too_big");
    }
  });

  it(`rejects separator at max+1 length (${PASSPHRASE_SEPARATOR_MAX + 1})`, () => {
    const result = generatePassphraseSchema.safeParse({
      separator: "-".repeat(PASSPHRASE_SEPARATOR_MAX + 1),
    });
    expect(result.success).toBe(false);
  });

  it("rejects when capitalize is null", () => {
    const result = generatePassphraseSchema.safeParse({ capitalize: null });
    expect(result.success).toBe(false);
  });
});

// ─── createE2EPasswordSchema ────────────────────────────────

describe("createE2EPasswordSchema", () => {
  const valid = (): {
    id: string;
    encryptedBlob: { ciphertext: string; iv: string; authTag: string };
    encryptedOverview: { ciphertext: string; iv: string; authTag: string };
    keyVersion: number;
  } => ({
    id: VALID_UUID,
    encryptedBlob: validEncryptedField(),
    encryptedOverview: validEncryptedField(),
    keyVersion: 1,
  });

  it("accepts valid input", () => {
    expect(createE2EPasswordSchema.safeParse(valid()).success).toBe(true);
  });

  it("rejects missing encryptedBlob", () => {
    const { encryptedBlob: _, ...rest } = valid();
    expect(createE2EPasswordSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects missing encryptedOverview", () => {
    const { encryptedOverview: _, ...rest } = valid();
    expect(createE2EPasswordSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects missing keyVersion", () => {
    const { keyVersion: _, ...rest } = valid();
    expect(createE2EPasswordSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects keyVersion below 1", () => {
    const result = createE2EPasswordSchema.safeParse({ ...valid(), keyVersion: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects when id is missing and aadVersion>=1", () => {
    const { id: _, ...rest } = valid();
    const result = createE2EPasswordSchema.safeParse({ ...rest, aadVersion: 1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "id")).toBe(true);
    }
  });

  it("rejects aadVersion above max (2)", () => {
    const result = createE2EPasswordSchema.safeParse({ ...valid(), aadVersion: 2 });
    expect(result.success).toBe(false);
  });

  it("rejects non-UUID id", () => {
    const result = createE2EPasswordSchema.safeParse({ ...valid(), id: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  it("rejects non-UUID inside tagIds array", () => {
    const result = createE2EPasswordSchema.safeParse({
      ...valid(),
      tagIds: ["bad-uuid"],
    });
    expect(result.success).toBe(false);
  });

  it("accepts folderId=null", () => {
    expect(createE2EPasswordSchema.safeParse({ ...valid(), folderId: null }).success).toBe(true);
  });

  it("rejects expiresAt without offset", () => {
    const result = createE2EPasswordSchema.safeParse({
      ...valid(),
      expiresAt: "2026-05-03T10:00:00",
    });
    expect(result.success).toBe(false);
  });
});

// ─── updateE2EPasswordSchema ────────────────────────────────

describe("updateE2EPasswordSchema", () => {
  it("accepts an empty object (all fields optional)", () => {
    expect(updateE2EPasswordSchema.safeParse({}).success).toBe(true);
  });

  it("accepts isFavorite=true", () => {
    const result = updateE2EPasswordSchema.safeParse({ isFavorite: true });
    expect(result.success).toBe(true);
  });

  it("rejects non-UUID folderId", () => {
    const result = updateE2EPasswordSchema.safeParse({ folderId: "bad" });
    expect(result.success).toBe(false);
  });

  it("rejects keyVersion below 1", () => {
    const result = updateE2EPasswordSchema.safeParse({ keyVersion: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects aadVersion above max (2)", () => {
    const result = updateE2EPasswordSchema.safeParse({ aadVersion: 2 });
    expect(result.success).toBe(false);
  });
});

// ─── generateRequestSchema ──────────────────────────────────

describe("generateRequestSchema", () => {
  it("falls back to mode='password' when omitted (legacy preprocessor)", () => {
    const result = generateRequestSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe("password");
    }
  });

  it("accepts an explicit password mode", () => {
    const result = generateRequestSchema.safeParse({ mode: "password", length: 20 });
    expect(result.success).toBe(true);
  });

  it("accepts an explicit passphrase mode", () => {
    const result = generateRequestSchema.safeParse({
      mode: "passphrase",
      wordCount: 5,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown mode", () => {
    const result = generateRequestSchema.safeParse({ mode: "unknown" });
    expect(result.success).toBe(false);
  });
});

// ─── historyReencryptSchema ─────────────────────────────────

describe("historyReencryptSchema", () => {
  const valid = (): {
    encryptedBlob: string;
    blobIv: string;
    blobAuthTag: string;
    keyVersion: number;
    oldBlobHash: string;
  } => ({
    encryptedBlob: "data",
    blobIv: HEX_IV,
    blobAuthTag: HEX_AUTH_TAG,
    keyVersion: 1,
    oldBlobHash: HEX_HASH,
  });

  it("accepts valid input", () => {
    expect(historyReencryptSchema.safeParse(valid()).success).toBe(true);
  });

  it("rejects missing encryptedBlob", () => {
    const { encryptedBlob: _, ...rest } = valid();
    expect(historyReencryptSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects empty encryptedBlob", () => {
    const result = historyReencryptSchema.safeParse({ ...valid(), encryptedBlob: "" });
    expect(result.success).toBe(false);
  });

  it(`rejects encryptedBlob at max+1 (${HISTORY_BLOB_MAX + 1})`, () => {
    const result = historyReencryptSchema.safeParse({
      ...valid(),
      encryptedBlob: "x".repeat(HISTORY_BLOB_MAX + 1),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "encryptedBlob");
      expect(issue?.code).toBe("too_big");
    }
  });

  it("rejects oldBlobHash with wrong length", () => {
    const result = historyReencryptSchema.safeParse({
      ...valid(),
      oldBlobHash: "d".repeat(63),
    });
    expect(result.success).toBe(false);
  });

  it("rejects when keyVersion is a string", () => {
    const result = historyReencryptSchema.safeParse({ ...valid(), keyVersion: "1" });
    expect(result.success).toBe(false);
  });
});

// ─── teamHistoryReencryptSchema ─────────────────────────────

describe("teamHistoryReencryptSchema", () => {
  const valid = (): {
    encryptedBlob: string;
    blobIv: string;
    blobAuthTag: string;
    teamKeyVersion: number;
    oldBlobHash: string;
  } => ({
    encryptedBlob: "data",
    blobIv: HEX_IV,
    blobAuthTag: HEX_AUTH_TAG,
    teamKeyVersion: 1,
    oldBlobHash: HEX_HASH,
  });

  it("accepts valid minimal input", () => {
    expect(teamHistoryReencryptSchema.safeParse(valid()).success).toBe(true);
  });

  it("accepts optional itemKey fields", () => {
    const result = teamHistoryReencryptSchema.safeParse({
      ...valid(),
      itemKeyVersion: 1,
      encryptedItemKey: "enc",
      itemKeyIv: HEX_IV,
      itemKeyAuthTag: HEX_AUTH_TAG,
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing teamKeyVersion", () => {
    const { teamKeyVersion: _, ...rest } = valid();
    expect(teamHistoryReencryptSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects malformed itemKeyIv length", () => {
    const result = teamHistoryReencryptSchema.safeParse({
      ...valid(),
      itemKeyIv: "abc",
    });
    expect(result.success).toBe(false);
  });
});

// ─── bulkImportSchema ───────────────────────────────────────

describe("bulkImportSchema", () => {
  const buildEntry = (): {
    id: string;
    encryptedBlob: { ciphertext: string; iv: string; authTag: string };
    encryptedOverview: { ciphertext: string; iv: string; authTag: string };
    keyVersion: number;
  } => ({
    id: VALID_UUID,
    encryptedBlob: validEncryptedField(),
    encryptedOverview: validEncryptedField(),
    keyVersion: 1,
  });

  it("accepts a single-entry import", () => {
    expect(
      bulkImportSchema.safeParse({ entries: [buildEntry()] }).success,
    ).toBe(true);
  });

  it("rejects empty entries array", () => {
    const result = bulkImportSchema.safeParse({ entries: [] });
    expect(result.success).toBe(false);
  });

  it(`rejects entries above max+1 (${BULK_IMPORT_MAX_ENTRIES + 1})`, () => {
    const entries = Array.from({ length: BULK_IMPORT_MAX_ENTRIES + 1 }, () =>
      buildEntry(),
    );
    const result = bulkImportSchema.safeParse({ entries });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "entries");
      expect(issue?.code).toBe("too_big");
    }
  });

  it(`rejects sourceFilename at max+1 (${FILENAME_MAX_LENGTH + 1})`, () => {
    const result = bulkImportSchema.safeParse({
      entries: [buildEntry()],
      sourceFilename: "x".repeat(FILENAME_MAX_LENGTH + 1),
    });
    expect(result.success).toBe(false);
  });

  it("rejects when entries is missing", () => {
    expect(bulkImportSchema.safeParse({}).success).toBe(false);
  });
});
