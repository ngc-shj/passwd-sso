/**
 * Helpers to map between the validation-schema shape
 * `{ ciphertext, iv, authTag }` and Prisma flat DB columns
 * (`encryptedBlob`/`blobIv`/`blobAuthTag`, `encryptedOverview`/`overviewIv`/`overviewAuthTag`).
 *
 * Prevents field-name typos when spreading encrypted values into Prisma writes.
 */

export interface EncryptedField {
  ciphertext: string;
  iv: string;
  authTag: string;
}

/** Convert an encrypted field to Prisma columns for the entry body blob. */
export function toBlobColumns(f: EncryptedField) {
  return {
    encryptedBlob: f.ciphertext,
    blobIv: f.iv,
    blobAuthTag: f.authTag,
  };
}

/** Convert an encrypted field to Prisma columns for the entry overview blob. */
export function toOverviewColumns(f: EncryptedField) {
  return {
    encryptedOverview: f.ciphertext,
    overviewIv: f.iv,
    overviewAuthTag: f.authTag,
  };
}
