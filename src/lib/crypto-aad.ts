/**
 * AAD (Additional Authenticated Data) builders for AES-256-GCM encryption.
 *
 * AAD binds ciphertext to its context (entry ID, user ID, team ID, etc.)
 * so that ciphertext cannot be transplanted between entries or users.
 *
 * Binary format (length-prefixed, big-endian):
 *   [scope: 2 bytes ASCII] [aadVersion: 1 byte u8] [nFields: 1 byte u8]
 *   [field_len: 2 bytes BE u16] [field: N bytes UTF-8] ...
 *
 * Scopes:
 *   "PV" — Personal Vault entry  (userId, entryId)
 *   "OV" — Team Vault entry       (teamId, entryId, vaultType)
 *   "AT" — Attachment             (entryId, attachmentId)
 */

const AAD_VERSION = 1;

// Scope constants (2 ASCII bytes each)
const SCOPE_PERSONAL = "PV";
const SCOPE_TEAM = "OV";
const SCOPE_ATTACHMENT = "AT";

/**
 * Encode fields into the length-prefixed binary AAD format.
 *
 * @param scope - 2-char ASCII scope identifier
 * @param expectedFieldCount - expected number of fields for this scope
 * @param fields - string values to encode
 */
function buildAADBytes(
  scope: string,
  expectedFieldCount: number,
  fields: string[]
): Uint8Array {
  if (scope.length !== 2) {
    throw new Error(`AAD scope must be exactly 2 ASCII chars, got "${scope}"`);
  }
  if (fields.length !== expectedFieldCount) {
    throw new Error(
      `AAD scope "${scope}" expects ${expectedFieldCount} fields, got ${fields.length}`
    );
  }

  const encoder = new TextEncoder();

  // Pre-encode all fields to calculate total size
  const encodedFields = fields.map((f) => encoder.encode(f));

  // Header: scope(2) + aadVersion(1) + nFields(1) = 4 bytes
  // Each field: length(2) + data(N)
  const headerSize = 4;
  const fieldsSize = encodedFields.reduce(
    (sum, ef) => sum + 2 + ef.length,
    0
  );
  const totalSize = headerSize + fieldsSize;

  const buf = new ArrayBuffer(totalSize);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  let offset = 0;

  // Scope: 2 ASCII bytes
  bytes[offset] = scope.charCodeAt(0);
  bytes[offset + 1] = scope.charCodeAt(1);
  offset += 2;

  // AAD version: 1 byte
  view.setUint8(offset, AAD_VERSION);
  offset += 1;

  // Number of fields: 1 byte
  view.setUint8(offset, fields.length);
  offset += 1;

  // Fields: [length: 2B BE u16] [data: N bytes UTF-8]
  for (const encoded of encodedFields) {
    if (encoded.length > 0xffff) {
      throw new Error(`AAD field too long: ${encoded.length} bytes (max 65535)`);
    }
    view.setUint16(offset, encoded.length, false); // explicit big-endian
    offset += 2;
    bytes.set(encoded, offset);
    offset += encoded.length;
  }

  return bytes;
}

/**
 * Build AAD for Personal Vault entry encryption.
 *
 * Binds ciphertext to specific user + entry.
 * Used for both encryptedBlob and encryptedOverview.
 */
export function buildPersonalEntryAAD(
  userId: string,
  entryId: string
): Uint8Array {
  return buildAADBytes(SCOPE_PERSONAL, 2, [userId, entryId]);
}

/**
 * Build AAD for Team Vault entry encryption.
 *
 * Binds ciphertext to specific team + entry + vault type.
 * vaultType distinguishes "blob" vs "overview" to prevent cross-field replay.
 */
export function buildTeamEntryAAD(
  teamId: string,
  entryId: string,
  vaultType: "blob" | "overview" = "blob"
): Uint8Array {
  return buildAADBytes(SCOPE_TEAM, 3, [teamId, entryId, vaultType]);
}

/**
 * Build AAD for attachment encryption.
 *
 * Binds ciphertext to parent entry + specific attachment.
 */
export function buildAttachmentAAD(
  entryId: string,
  attachmentId: string
): Uint8Array {
  return buildAADBytes(SCOPE_ATTACHMENT, 2, [entryId, attachmentId]);
}

// Re-export AAD_VERSION for tests and schema references
export { AAD_VERSION };
