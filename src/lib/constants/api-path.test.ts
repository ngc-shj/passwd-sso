import { describe, expect, it } from "vitest";
import { API_PATH, apiPath } from "@/lib/constants";

describe("API_PATH", () => {
  it("keeps core paths stable", () => {
    expect(API_PATH.EXTENSION_TOKEN).toBe("/api/extension/token");
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
});
