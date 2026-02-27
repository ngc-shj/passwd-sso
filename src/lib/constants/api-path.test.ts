import { describe, expect, it } from "vitest";
import { API_PATH, apiPath } from "@/lib/constants";

describe("API_PATH", () => {
  it("keeps core paths stable", () => {
    expect(API_PATH.API_ROOT).toBe("/api");
    expect(API_PATH.AUTH_SESSION).toBe("/api/auth/session");
    expect(API_PATH.EXTENSION_TOKEN).toBe("/api/extension/token");
    expect(API_PATH.EXTENSION_TOKEN_REFRESH).toBe(
      "/api/extension/token/refresh"
    );
    expect(API_PATH.PASSWORDS).toBe("/api/passwords");
    expect(API_PATH.PASSWORDS_BULK_TRASH).toBe("/api/passwords/bulk-trash");
    expect(API_PATH.PASSWORDS_BULK_ARCHIVE).toBe("/api/passwords/bulk-archive");
    expect(API_PATH.PASSWORDS_BULK_RESTORE).toBe("/api/passwords/bulk-restore");
    expect(API_PATH.PASSWORDS_EMPTY_TRASH).toBe("/api/passwords/empty-trash");
    expect(API_PATH.PASSWORDS_GENERATE).toBe("/api/passwords/generate");
    expect(API_PATH.TAGS).toBe("/api/tags");
    expect(API_PATH.TEAMS).toBe("/api/teams");
    expect(API_PATH.TEAMS_ARCHIVED).toBe("/api/teams/archived");
    expect(API_PATH.TEAMS_FAVORITES).toBe("/api/teams/favorites");
    expect(API_PATH.TEAMS_TRASH).toBe("/api/teams/trash");
    expect(API_PATH.TEAMS_INVITATIONS_ACCEPT).toBe("/api/teams/invitations/accept");
    expect(API_PATH.AUDIT_LOGS).toBe("/api/audit-logs");
    expect(API_PATH.SHARE_LINKS).toBe("/api/share-links");
    expect(API_PATH.SHARE_LINKS_MINE).toBe("/api/share-links/mine");
    expect(API_PATH.AUDIT_LOGS_IMPORT).toBe("/api/audit-logs/import");
    expect(API_PATH.AUDIT_LOGS_EXPORT).toBe("/api/audit-logs/export");
    expect(API_PATH.VAULT_STATUS).toBe("/api/vault/status");
    expect(API_PATH.VAULT_SETUP).toBe("/api/vault/setup");
    expect(API_PATH.VAULT_UNLOCK_DATA).toBe("/api/vault/unlock/data");
    expect(API_PATH.VAULT_UNLOCK).toBe("/api/vault/unlock");
    expect(API_PATH.VAULT_CHANGE_PASSPHRASE).toBe(
      "/api/vault/change-passphrase"
    );
    expect(API_PATH.EMERGENCY_ACCESS).toBe("/api/emergency-access");
    expect(API_PATH.EMERGENCY_ACCESS_ACCEPT).toBe("/api/emergency-access/accept");
    expect(API_PATH.EMERGENCY_ACCESS_REJECT).toBe("/api/emergency-access/reject");
    expect(API_PATH.EMERGENCY_PENDING_CONFIRMATIONS).toBe(
      "/api/emergency-access/pending-confirmations"
    );
    expect(API_PATH.WATCHTOWER_START).toBe("/api/watchtower/start");
    expect(API_PATH.WATCHTOWER_HIBP).toBe("/api/watchtower/hibp");
    expect(API_PATH.CSP_REPORT).toBe("/api/csp-report");
    expect(API_PATH.HEALTH_LIVE).toBe("/api/health/live");
    expect(API_PATH.HEALTH_READY).toBe("/api/health/ready");
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
    expect(apiPath.passwordsBulkTrash()).toBe("/api/passwords/bulk-trash");
    expect(apiPath.passwordsBulkArchive()).toBe("/api/passwords/bulk-archive");
    expect(apiPath.passwordsBulkRestore()).toBe("/api/passwords/bulk-restore");
    expect(apiPath.passwordsEmptyTrash()).toBe("/api/passwords/empty-trash");
    expect(apiPath.passwordRestore("pw-1")).toBe("/api/passwords/pw-1/restore");
    expect(apiPath.passwordAttachments("pw-1")).toBe(
      "/api/passwords/pw-1/attachments"
    );
    expect(apiPath.passwordAttachmentById("pw-1", "att-1")).toBe(
      "/api/passwords/pw-1/attachments/att-1"
    );
  });

  it("builds team and emergency paths", () => {
    expect(apiPath.teamById("team-1")).toBe("/api/teams/team-1");
    expect(apiPath.teamMembers("team-1")).toBe("/api/teams/team-1/members");
    expect(apiPath.teamMemberById("team-1", "mem-1")).toBe(
      "/api/teams/team-1/members/mem-1"
    );
    expect(apiPath.teamInvitations("team-1")).toBe("/api/teams/team-1/invitations");
    expect(apiPath.teamInvitationById("team-1", "inv-1")).toBe(
      "/api/teams/team-1/invitations/inv-1"
    );
    expect(apiPath.teamPasswords("team-1")).toBe("/api/teams/team-1/passwords");
    expect(apiPath.teamPasswordById("team-1", "pw-1")).toBe(
      "/api/teams/team-1/passwords/pw-1"
    );
    expect(apiPath.teamPasswordFavorite("team-1", "pw-1")).toBe(
      "/api/teams/team-1/passwords/pw-1/favorite"
    );
    expect(apiPath.teamPasswordRestore("team-1", "pw-1")).toBe(
      "/api/teams/team-1/passwords/pw-1/restore"
    );
    expect(apiPath.teamPasswordAttachments("team-1", "pw-1")).toBe(
      "/api/teams/team-1/passwords/pw-1/attachments"
    );
    expect(apiPath.teamPasswordAttachmentById("team-1", "pw-1", "att-1")).toBe(
      "/api/teams/team-1/passwords/pw-1/attachments/att-1"
    );
    expect(apiPath.teamTags("team-1")).toBe("/api/teams/team-1/tags");
    expect(apiPath.teamAuditLogs("team-1")).toBe("/api/teams/team-1/audit-logs");
    expect(apiPath.emergencyGrantById("gr-1")).toBe("/api/emergency-access/gr-1");
    expect(apiPath.emergencyGrantAction("gr-1", "approve")).toBe(
      "/api/emergency-access/gr-1/approve"
    );
    expect(apiPath.emergencyGrantVault("gr-1")).toBe(
      "/api/emergency-access/gr-1/vault"
    );
    expect(apiPath.emergencyGrantVaultEntries("gr-1")).toBe(
      "/api/emergency-access/gr-1/vault/entries"
    );
  });
});
