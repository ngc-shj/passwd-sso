import { describe, expect, it } from "vitest";
import { API_PATH, apiPath } from "@/lib/constants";

describe("API_PATH", () => {
  it("keeps core paths stable", () => {
    expect(API_PATH.EXTENSION_TOKEN).toBe("/api/extension/token");
    expect(API_PATH.PASSWORDS).toBe("/api/passwords");
    expect(API_PATH.PASSWORDS_GENERATE).toBe("/api/passwords/generate");
    expect(API_PATH.SHARE_LINKS).toBe("/api/share-links");
    expect(API_PATH.SHARE_LINKS_MINE).toBe("/api/share-links/mine");
    expect(API_PATH.AUDIT_LOGS_EXPORT).toBe("/api/audit-logs/export");
    expect(API_PATH.VAULT_STATUS).toBe("/api/vault/status");
    expect(API_PATH.VAULT_SETUP).toBe("/api/vault/setup");
    expect(API_PATH.VAULT_UNLOCK_DATA).toBe("/api/vault/unlock/data");
    expect(API_PATH.VAULT_UNLOCK).toBe("/api/vault/unlock");
    expect(API_PATH.VAULT_CHANGE_PASSPHRASE).toBe(
      "/api/vault/change-passphrase"
    );
    expect(API_PATH.EMERGENCY_PENDING_CONFIRMATIONS).toBe(
      "/api/emergency-access/pending-confirmations"
    );
  });

  it("builds emergency confirm path", () => {
    expect(apiPath.emergencyConfirm("grant-1")).toBe(
      "/api/emergency-access/grant-1/confirm"
    );
  });

  it("builds share link paths", () => {
    expect(apiPath.shareLinkById("share-1")).toBe("/api/share-links/share-1");
    expect(apiPath.shareLinkAccessLogs("share-1")).toBe(
      "/api/share-links/share-1/access-logs"
    );
  });

  it("builds password paths", () => {
    expect(apiPath.passwordById("pw-1")).toBe("/api/passwords/pw-1");
    expect(apiPath.passwordRestore("pw-1")).toBe("/api/passwords/pw-1/restore");
    expect(apiPath.passwordAttachments("pw-1")).toBe(
      "/api/passwords/pw-1/attachments"
    );
    expect(apiPath.passwordAttachmentById("pw-1", "att-1")).toBe(
      "/api/passwords/pw-1/attachments/att-1"
    );
  });
});
