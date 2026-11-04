/**
 * How an attachment body is keyed (`attachments.encryption_mode`), for
 * personal and team attachments alike.
 */
export const ATTACHMENT_ENCRYPTION_MODE = {
  /**
   * Legacy: the body under the owner's key at `keyVersion` — the personal
   * vault key, or the team key.
   */
  VAULT_KEY: 0,
  /** Legacy, team only: the body under the entry's ItemKey (wrap found by trial). */
  ITEM_KEY: 1,
  /**
   * The body under a random CEK, wrapped by the vault key (personal) or by
   * the entry ItemKey's CEK-wrap key (team). Every new upload and migrate.
   */
  CEK_WRAPPED: 2,
} as const;

export type AttachmentEncryptionMode =
  (typeof ATTACHMENT_ENCRYPTION_MODE)[keyof typeof ATTACHMENT_ENCRYPTION_MODE];
