import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import {
  HEX_IV_LENGTH,
  HEX_AUTH_TAG_LENGTH,
  HEX_SALT_LENGTH,
  HEX_HASH_LENGTH,
  SEND_NAME_MAX_LENGTH,
  NAME_MAX_LENGTH,
  FILENAME_MAX_LENGTH,
  WEBHOOK_URL_MAX_LENGTH,
  WEBAUTHN_NICKNAME_MAX_LENGTH,
  SCIM_TOKEN_DESC_MAX_LENGTH,
  ENTRY_NAME_MAX,
  BREAKGLASS_INCIDENT_REF_MAX,
} from "@/lib/validations/common";

// Read the Prisma schema once at module load time
const schema = readFileSync(
  resolve(__dirname, "../../../prisma/schema.prisma"),
  "utf-8"
);

/**
 * Extracts the VarChar length for a given model.field from the Prisma schema.
 * Returns null if the field is not found or does not have a @db.VarChar annotation.
 */
function getVarCharLength(modelName: string, fieldName: string): number | null {
  // Match the model block (everything between `model Name {` and the closing `}`)
  const modelRegex = new RegExp(
    `model\\s+${modelName}\\s+\\{([^}]+(?:\\{[^}]*\\}[^}]*)*)\\}`,
    "s"
  );
  const modelMatch = schema.match(modelRegex);
  if (!modelMatch) return null;

  const modelBody = modelMatch[1];

  // Match the field line that contains the fieldName and @db.VarChar(N)
  // Field names in Prisma are camelCase and appear at the start of a line (after whitespace)
  const fieldRegex = new RegExp(
    `^\\s+${fieldName}\\s+\\S.*?@db\\.VarChar\\((\\d+)\\)`,
    "m"
  );
  const fieldMatch = modelBody.match(fieldRegex);
  if (!fieldMatch) return null;

  return parseInt(fieldMatch[1], 10);
}

/**
 * Extracts all fields matching a given suffix pattern from all models.
 * Returns an array of { model, field, length } tuples.
 */
function getAllFieldsBySuffix(suffix: string): Array<{ model: string; field: string; length: number }> {
  const results: Array<{ model: string; field: string; length: number }> = [];

  // Match all model blocks
  const modelBlockRegex = /model\s+(\w+)\s+\{([^}]+(?:\{[^}]*\}[^}]*)*)\}/gs;
  let modelMatch: RegExpExecArray | null;

  while ((modelMatch = modelBlockRegex.exec(schema)) !== null) {
    const modelName = modelMatch[1];
    const modelBody = modelMatch[2];

    // Match field lines ending with the given suffix that have @db.VarChar(N)
    const fieldRegex = new RegExp(
      `^\\s+(\\w*${suffix})\\s+\\S.*?@db\\.VarChar\\((\\d+)\\)`,
      "gm"
    );
    let fieldMatch: RegExpExecArray | null;

    while ((fieldMatch = fieldRegex.exec(modelBody)) !== null) {
      results.push({
        model: modelName,
        field: fieldMatch[1],
        length: parseInt(fieldMatch[2], 10),
      });
    }
  }

  return results;
}

// ─── Tests ──────────────────────────────────────────────────

describe("Prisma schema and TypeScript constant sync", () => {
  describe("Crypto hex fields (pattern-based)", () => {
    it("all *Iv fields should have VarChar(HEX_IV_LENGTH)", () => {
      const ivFields = getAllFieldsBySuffix("Iv");
      expect(ivFields.length).toBeGreaterThan(0);

      for (const { model, field, length } of ivFields) {
        expect(
          length,
          `${model}.${field} should be VarChar(${HEX_IV_LENGTH}), got VarChar(${length})`
        ).toBe(HEX_IV_LENGTH);
      }
    });

    it("all *AuthTag fields should have VarChar(HEX_AUTH_TAG_LENGTH)", () => {
      const authTagFields = getAllFieldsBySuffix("AuthTag");
      expect(authTagFields.length).toBeGreaterThan(0);

      for (const { model, field, length } of authTagFields) {
        expect(
          length,
          `${model}.${field} should be VarChar(${HEX_AUTH_TAG_LENGTH}), got VarChar(${length})`
        ).toBe(HEX_AUTH_TAG_LENGTH);
      }
    });

    it("all *Salt fields should have VarChar(HEX_SALT_LENGTH)", () => {
      const saltFields = getAllFieldsBySuffix("Salt");
      expect(saltFields.length).toBeGreaterThan(0);

      for (const { model, field, length } of saltFields) {
        expect(
          length,
          `${model}.${field} should be VarChar(${HEX_SALT_LENGTH}), got VarChar(${length})`
        ).toBe(HEX_SALT_LENGTH);
      }
    });

    it("all *Hash / tokenHash fields should have VarChar(HEX_HASH_LENGTH)", () => {
      const hashFields = getAllFieldsBySuffix("Hash").filter(
        // accessPasswordHash is a HMAC-peppered SHA-256 stored as hex(32 bytes) + HMAC overhead;
        // it intentionally uses VarChar(128) rather than VarChar(64)
        ({ field }) => field !== "accessPasswordHash"
      );
      expect(hashFields.length).toBeGreaterThan(0);

      for (const { model, field, length } of hashFields) {
        expect(
          length,
          `${model}.${field} should be VarChar(${HEX_HASH_LENGTH}), got VarChar(${length})`
        ).toBe(HEX_HASH_LENGTH);
      }
    });
  });

  describe("Named field mappings", () => {
    it.each([
      ["PasswordShare", "sendName", SEND_NAME_MAX_LENGTH],
      ["Folder", "name", NAME_MAX_LENGTH],
      ["TeamFolder", "name", NAME_MAX_LENGTH],
      ["Attachment", "filename", FILENAME_MAX_LENGTH],
      ["PasswordShare", "sendFilename", FILENAME_MAX_LENGTH],
      ["TeamWebhook", "url", WEBHOOK_URL_MAX_LENGTH],
      ["TenantWebhook", "url", WEBHOOK_URL_MAX_LENGTH],
      ["WebAuthnCredential", "nickname", WEBAUTHN_NICKNAME_MAX_LENGTH],
      ["ScimToken", "description", SCIM_TOKEN_DESC_MAX_LENGTH],
      ["ApiKey", "name", NAME_MAX_LENGTH],
      ["Notification", "title", ENTRY_NAME_MAX],
      ["PersonalLogAccessGrant", "incidentRef", BREAKGLASS_INCIDENT_REF_MAX],
    ] as const)(
      "%s.%s should have VarChar(%i)",
      (model, field, expectedLength) => {
        expect(getVarCharLength(model, field)).toBe(expectedLength);
      }
    );
  });
});
