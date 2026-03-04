/**
 * AAD (Additional Authenticated Data) builders for AES-256-GCM encryption.
 * Ported from src/lib/crypto-aad.ts for CLI compatibility.
 */

const AAD_VERSION = 1;
const SCOPE_PERSONAL = "PV";

function buildAADBytes(
  scope: string,
  expectedFieldCount: number,
  fields: string[],
): Uint8Array {
  if (scope.length !== 2) {
    throw new Error(`AAD scope must be exactly 2 ASCII chars, got "${scope}"`);
  }
  if (fields.length !== expectedFieldCount) {
    throw new Error(
      `AAD scope "${scope}" expects ${expectedFieldCount} fields, got ${fields.length}`,
    );
  }

  const encoder = new TextEncoder();
  const encodedFields = fields.map((f) => encoder.encode(f));

  const headerSize = 4;
  const fieldsSize = encodedFields.reduce((sum, ef) => sum + 2 + ef.length, 0);
  const totalSize = headerSize + fieldsSize;

  const buf = new ArrayBuffer(totalSize);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  let offset = 0;

  bytes[offset] = scope.charCodeAt(0);
  bytes[offset + 1] = scope.charCodeAt(1);
  offset += 2;

  view.setUint8(offset, AAD_VERSION);
  offset += 1;

  view.setUint8(offset, fields.length);
  offset += 1;

  for (const encoded of encodedFields) {
    if (encoded.length > 0xffff) {
      throw new Error(`AAD field too long: ${encoded.length} bytes (max 65535)`);
    }
    view.setUint16(offset, encoded.length, false);
    offset += 2;
    bytes.set(encoded, offset);
    offset += encoded.length;
  }

  return bytes;
}

export function buildPersonalEntryAAD(
  userId: string,
  entryId: string,
): Uint8Array {
  return buildAADBytes(SCOPE_PERSONAL, 2, [userId, entryId]);
}
