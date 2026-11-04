import { describe, expect, it } from "vitest";
import { ATTACHMENT_ENCRYPTION_MODE } from "./attachment-encryption-mode";

describe("ATTACHMENT_ENCRYPTION_MODE", () => {
  it("keeps the wire values stored in attachments.encryption_mode", () => {
    expect(ATTACHMENT_ENCRYPTION_MODE).toEqual({ VAULT_KEY: 0, ITEM_KEY: 1, CEK_WRAPPED: 2 });
  });
});
