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
 *   "PV" — Personal Vault entry  (userId, entryId, vaultType)
 *   "PH" — Personal Vault history (userId, entryId, historyId)
 *   "OV" — Team Vault entry       (teamId, entryId, vaultType, itemKeyVersion)
 *   "AT" — Attachment             (entryId, attachmentId)
 *   "IK" — ItemKey wrapping       (teamId, entryId, teamKeyVersion)
 *   "AW" — Attachment CEK Wrap (entryId, attachmentId, cekKeyVersion, cekWrapAadVersion)
 */

const AAD_VERSION = 1;

// Scope constants (2 ASCII bytes each)
const SCOPE_PERSONAL = "PV";
const SCOPE_PERSONAL_HISTORY = "PH";
const SCOPE_TEAM = "OV";
const SCOPE_ATTACHMENT = "AT";
const SCOPE_ITEM_KEY = "IK";
const SCOPE_ATTACHMENT_WRAP = "AW";

/**
 * Vault entry sub-blob selector used by Personal (PV) and Team (OV) AAD
 * scopes. Bound into AAD to prevent cross-field replay (an attacker who
 * can write DB cannot swap the overview ciphertext into the blob column).
 *
 * Const-object + derived type pattern (matches AUDIT_ACTION) so callers
 * can `pass VAULT_TYPE.BLOB` instead of bare string literals.
 */
export const VAULT_TYPE = {
  BLOB: "blob",
  OVERVIEW: "overview",
} as const;
export type VaultType = (typeof VAULT_TYPE)[keyof typeof VAULT_TYPE];

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
 * Binds ciphertext to specific user + entry + vault type.
 * vaultType distinguishes "blob" vs "overview" to prevent cross-field replay
 * (mirrors buildTeamEntryAAD).
 *
 * BREAKING (pre-1.0): personal entry data encrypted with the 2-field AAD
 * cannot be decrypted with this 3-field shape.
 */
export function buildPersonalEntryAAD(
  userId: string,
  entryId: string,
  vaultType: VaultType
): Uint8Array {
  return buildAADBytes(SCOPE_PERSONAL, 3, [userId, entryId, vaultType]);
}

/**
 * Build AAD for Personal Vault history record encryption.
 *
 * Binds ciphertext to specific user + parent entry + history record id.
 * historyId binding prevents version rollback (replacing a current entry
 * decrypt with an older history row's ciphertext).
 */
export function buildPersonalHistoryAAD(
  userId: string,
  entryId: string,
  historyId: string
): Uint8Array {
  return buildAADBytes(SCOPE_PERSONAL_HISTORY, 3, [userId, entryId, historyId]);
}

/**
 * Build AAD for Team Vault entry encryption.
 *
 * Binds ciphertext to specific team + entry + vault type + itemKeyVersion.
 * vaultType distinguishes "blob" vs "overview" to prevent cross-field replay.
 * itemKeyVersion prevents version mismatch (0=TeamKey direct, >=1=ItemKey).
 */
export function buildTeamEntryAAD(
  teamId: string,
  entryId: string,
  vaultType: VaultType = VAULT_TYPE.BLOB,
  itemKeyVersion: number = 0
): Uint8Array {
  return buildAADBytes(SCOPE_TEAM, 4, [
    teamId,
    entryId,
    vaultType,
    String(itemKeyVersion),
  ]);
}

/**
 * Build AAD for ItemKey wrapping (AES-GCM wrap of per-entry ItemKey with TeamKey).
 *
 * Prevents cross-entry transplant of encrypted ItemKey blobs.
 */
export function buildItemKeyWrapAAD(
  teamId: string,
  entryId: string,
  teamKeyVersion: number
): Uint8Array {
  return buildAADBytes(SCOPE_ITEM_KEY, 3, [
    teamId,
    entryId,
    String(teamKeyVersion),
  ]);
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

/**
 * Build AAD for attachment CEK (Content Encryption Key) wrapping.
 *
 * Binds the wrapped CEK to its specific attachment, entry, key version, and
 * AAD version — prevents cross-attachment transplant of CEK blobs (mode-2).
 */
export function buildAttachmentCekWrapAAD(
  entryId: string,
  attachmentId: string,
  cekKeyVersion: number,
  cekWrapAadVersion: number,
): Uint8Array {
  return buildAADBytes(SCOPE_ATTACHMENT_WRAP, 4, [
    entryId,
    attachmentId,
    String(cekKeyVersion),
    String(cekWrapAadVersion),
  ]);
}

export const MIN_ACCEPTED_CEK_WRAP_AAD_VERSION = 1;

// Current CEK wrap AAD format version emitted by all client wrap operations.
// When a future format upgrade lands, bump this AND update the floor (after a
// back-window). SSoT for the emit value — keeps upload, rewrap, and migrate
// paths in lockstep.
export const CURRENT_CEK_WRAP_AAD_VERSION = 1;

// Re-export for tests, schema references, and reuse by other AAD builders
export { AAD_VERSION, buildAADBytes };
