import { describe, expect, it } from "vitest";
import {
  HEX_IV_LENGTH,
  HEX_AUTH_TAG_LENGTH,
  HEX_SALT_LENGTH,
  HEX_HASH_LENGTH,
  hexIv,
  hexAuthTag,
  hexSalt,
  hexHash,
  encryptedFieldSchema,
  bulkIdsSchema,
  MAX_BULK_IDS,
  EXPIRY_PERIODS,
  EMERGENCY_WAIT_DAYS,
  HEX_COLOR_REGEX,
  PASSWORD_LENGTH_DEFAULT,
  PASSWORD_LENGTH_MAX,
  CIPHERTEXT_MAX,
  HISTORY_BLOB_MAX,
  NOTIFICATION_TITLE_MAX,
  ENTRY_NAME_MAX,
} from "@/lib/validations/common";

// ─── Crypto hex length constants ─────────────────────────────

describe("Crypto hex length constants", () => {
  it("HEX_IV_LENGTH is 24 (12 bytes as hex)", () => {
    expect(HEX_IV_LENGTH).toBe(24);
  });

  it("HEX_AUTH_TAG_LENGTH is 32 (16 bytes as hex)", () => {
    expect(HEX_AUTH_TAG_LENGTH).toBe(32);
  });

  it("HEX_SALT_LENGTH is 64 (32 bytes as hex)", () => {
    expect(HEX_SALT_LENGTH).toBe(64);
  });

  it("HEX_HASH_LENGTH is 64 (32 bytes as hex, SHA-256)", () => {
    expect(HEX_HASH_LENGTH).toBe(64);
  });
});

// ─── Hex schema validators ────────────────────────────────────

describe("hexIv schema", () => {
  const valid = "a".repeat(HEX_IV_LENGTH);

  it("accepts a valid hex string of correct length", () => {
    expect(hexIv.safeParse(valid).success).toBe(true);
  });

  it("rejects a hex string that is too short", () => {
    expect(hexIv.safeParse("a".repeat(HEX_IV_LENGTH - 1)).success).toBe(false);
  });

  it("rejects a hex string that is too long", () => {
    expect(hexIv.safeParse("a".repeat(HEX_IV_LENGTH + 1)).success).toBe(false);
  });

  it("rejects non-hex characters", () => {
    expect(hexIv.safeParse("z".repeat(HEX_IV_LENGTH)).success).toBe(false);
  });

  it("accepts mixed-case hex", () => {
    const mixedCase = "aAbBcCdD".repeat(HEX_IV_LENGTH / 8);
    expect(hexIv.safeParse(mixedCase).success).toBe(true);
  });
});

describe("hexAuthTag schema", () => {
  const valid = "f".repeat(HEX_AUTH_TAG_LENGTH);

  it("accepts a valid hex string of correct length", () => {
    expect(hexAuthTag.safeParse(valid).success).toBe(true);
  });

  it("rejects wrong length", () => {
    expect(hexAuthTag.safeParse("f".repeat(HEX_AUTH_TAG_LENGTH - 2)).success).toBe(false);
  });
});

describe("hexSalt schema", () => {
  const valid = "0".repeat(HEX_SALT_LENGTH);

  it("accepts a valid hex string of correct length", () => {
    expect(hexSalt.safeParse(valid).success).toBe(true);
  });

  it("rejects wrong length", () => {
    expect(hexSalt.safeParse("0".repeat(HEX_SALT_LENGTH + 1)).success).toBe(false);
  });
});

describe("hexHash schema", () => {
  const valid = "deadbeef".repeat(8); // 64 chars

  it("accepts a valid hex string of correct length", () => {
    expect(hexHash.safeParse(valid).success).toBe(true);
  });

  it("rejects wrong length", () => {
    expect(hexHash.safeParse("dead".repeat(8)).success).toBe(false); // 32 chars
  });
});

// ─── encryptedFieldSchema ────────────────────────────────────

describe("encryptedFieldSchema", () => {
  const validIv = "a".repeat(HEX_IV_LENGTH);
  const validAuthTag = "b".repeat(HEX_AUTH_TAG_LENGTH);

  it("accepts a valid encrypted field object", () => {
    const result = encryptedFieldSchema.safeParse({
      ciphertext: "deadbeef",
      iv: validIv,
      authTag: validAuthTag,
    });
    expect(result.success).toBe(true);
  });

  it("rejects when ciphertext is missing", () => {
    const result = encryptedFieldSchema.safeParse({
      iv: validIv,
      authTag: validAuthTag,
    });
    expect(result.success).toBe(false);
  });

  it("rejects when iv is missing", () => {
    const result = encryptedFieldSchema.safeParse({
      ciphertext: "deadbeef",
      authTag: validAuthTag,
    });
    expect(result.success).toBe(false);
  });

  it("rejects when authTag is missing", () => {
    const result = encryptedFieldSchema.safeParse({
      ciphertext: "deadbeef",
      iv: validIv,
    });
    expect(result.success).toBe(false);
  });

  it("rejects ciphertext that exceeds CIPHERTEXT_MAX", () => {
    const result = encryptedFieldSchema.safeParse({
      ciphertext: "x".repeat(CIPHERTEXT_MAX + 1),
      iv: validIv,
      authTag: validAuthTag,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-hex iv", () => {
    const result = encryptedFieldSchema.safeParse({
      ciphertext: "deadbeef",
      iv: "z".repeat(HEX_IV_LENGTH), // 'z' is not valid hex
      authTag: validAuthTag,
    });
    expect(result.success).toBe(false);
  });

  it("accepts ciphertext exactly at CIPHERTEXT_MAX length", () => {
    const result = encryptedFieldSchema.safeParse({
      ciphertext: "x".repeat(CIPHERTEXT_MAX),
      iv: validIv,
      authTag: validAuthTag,
    });
    expect(result.success).toBe(true);
  });
});

// ─── bulkIdsSchema ───────────────────────────────────────────

describe("bulkIdsSchema", () => {
  it("accepts a valid list of IDs", () => {
    const result = bulkIdsSchema.safeParse({
      ids: [
        "00000000-0000-4000-a000-000000000001",
        "00000000-0000-4000-a000-000000000002",
        "00000000-0000-4000-a000-000000000003",
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ids).toEqual([
        "00000000-0000-4000-a000-000000000001",
        "00000000-0000-4000-a000-000000000002",
        "00000000-0000-4000-a000-000000000003",
      ]);
    }
  });

  it("deduplicates repeated IDs", () => {
    const result = bulkIdsSchema.safeParse({
      ids: [
        "00000000-0000-4000-a000-000000000001",
        "00000000-0000-4000-a000-000000000001",
        "00000000-0000-4000-a000-000000000002",
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ids).toEqual([
        "00000000-0000-4000-a000-000000000001",
        "00000000-0000-4000-a000-000000000002",
      ]);
    }
  });

  it("rejects empty array", () => {
    const result = bulkIdsSchema.safeParse({ ids: [] });
    expect(result.success).toBe(false);
  });

  it(`rejects more than MAX_BULK_IDS (${MAX_BULK_IDS}) unique IDs`, () => {
    const ids = Array.from(
      { length: MAX_BULK_IDS + 1 },
      (_, i) => `00000000-0000-4000-a000-${String(i).padStart(12, "0")}`,
    );
    const result = bulkIdsSchema.safeParse({ ids });
    expect(result.success).toBe(false);
  });

  it(`accepts exactly MAX_BULK_IDS (${MAX_BULK_IDS}) unique IDs`, () => {
    const ids = Array.from(
      { length: MAX_BULK_IDS },
      (_, i) => `00000000-0000-4000-a000-${String(i).padStart(12, "0")}`,
    );
    const result = bulkIdsSchema.safeParse({ ids });
    expect(result.success).toBe(true);
  });

  it("deduplicates before capping at MAX_BULK_IDS", () => {
    // Provide MAX_BULK_IDS + 5 entries but only 2 unique — should pass after dedup
    const sameId = "00000000-0000-4000-a000-000000000001";
    const otherId = "00000000-0000-4000-a000-000000000002";
    const ids = [
      ...Array.from({ length: MAX_BULK_IDS + 5 }, () => sameId),
      otherId,
    ];
    const result = bulkIdsSchema.safeParse({ ids });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ids).toHaveLength(2);
    }
  });
});

// ─── EXPIRY_PERIODS ──────────────────────────────────────────

describe("EXPIRY_PERIODS", () => {
  it("has exactly 4 items", () => {
    expect(EXPIRY_PERIODS).toHaveLength(4);
  });

  it('contains "1h", "1d", "7d", "30d" in order', () => {
    expect(EXPIRY_PERIODS).toEqual(["1h", "1d", "7d", "30d"]);
  });
});

// ─── EMERGENCY_WAIT_DAYS ─────────────────────────────────────

describe("EMERGENCY_WAIT_DAYS", () => {
  it("contains exactly [7, 14, 30]", () => {
    expect(EMERGENCY_WAIT_DAYS).toEqual([7, 14, 30]);
  });
});

// ─── HEX_COLOR_REGEX ─────────────────────────────────────────

describe("HEX_COLOR_REGEX", () => {
  it("matches a valid lowercase hex color", () => {
    expect(HEX_COLOR_REGEX.test("#1a2b3c")).toBe(true);
  });

  it("matches a valid uppercase hex color", () => {
    expect(HEX_COLOR_REGEX.test("#AABBCC")).toBe(true);
  });

  it("matches a mixed-case hex color", () => {
    expect(HEX_COLOR_REGEX.test("#aAbBcC")).toBe(true);
  });

  it("rejects color without leading #", () => {
    expect(HEX_COLOR_REGEX.test("aabbcc")).toBe(false);
  });

  it("rejects 3-digit shorthand hex", () => {
    expect(HEX_COLOR_REGEX.test("#abc")).toBe(false);
  });

  it("rejects color with invalid characters", () => {
    expect(HEX_COLOR_REGEX.test("#zzzzzz")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(HEX_COLOR_REGEX.test("")).toBe(false);
  });
});

// ─── Relational constant integrity ───────────────────────────

describe("Constant relationships", () => {
  it("PASSWORD_LENGTH_DEFAULT is less than PASSWORD_LENGTH_MAX", () => {
    expect(PASSWORD_LENGTH_DEFAULT).toBeLessThan(PASSWORD_LENGTH_MAX);
  });

  it("CIPHERTEXT_MAX is less than HISTORY_BLOB_MAX", () => {
    expect(CIPHERTEXT_MAX).toBeLessThan(HISTORY_BLOB_MAX);
  });

  it("NOTIFICATION_TITLE_MAX equals ENTRY_NAME_MAX (both 200)", () => {
    expect(NOTIFICATION_TITLE_MAX).toBe(200);
    expect(ENTRY_NAME_MAX).toBe(200);
    expect(NOTIFICATION_TITLE_MAX).toBe(ENTRY_NAME_MAX);
  });
});
