import { describe, expect, it } from "vitest";
import { NAMESPACES } from "./messages";
import {
  NS_GLOBAL,
  NS_VAULT,
  NS_DASHBOARD_ALL,
  NS_PUBLIC_SHARE,
  NS_RECOVERY,
  NS_VAULT_RESET,
  NS_PRIVACY_POLICY,
  NS_ADMIN_ALL,
} from "./namespace-groups";

describe("namespace-groups", () => {
  it("NS_DASHBOARD_ALL is a superset of NS_GLOBAL", () => {
    for (const ns of NS_GLOBAL) {
      expect(NS_DASHBOARD_ALL).toContain(ns);
    }
  });

  it("NS_DASHBOARD_ALL is a superset of NS_VAULT", () => {
    for (const ns of NS_VAULT) {
      expect(NS_DASHBOARD_ALL).toContain(ns);
    }
  });

  it("every entry in NS_DASHBOARD_ALL belongs to NAMESPACES", () => {
    for (const ns of NS_DASHBOARD_ALL) {
      expect(NAMESPACES).toContain(ns);
    }
  });

  it("every entry in NS_PUBLIC_SHARE belongs to NAMESPACES", () => {
    for (const ns of NS_PUBLIC_SHARE) {
      expect(NAMESPACES).toContain(ns);
    }
  });

  it("NS_DASHBOARD_ALL covers all namespaces except page-specific ones", () => {
    // Page-specific namespaces intentionally excluded from NS_DASHBOARD_ALL
    const excluded = new Set(["Metadata", "Recovery", "VaultReset", "PrivacyPolicy", "McpConsent", "AdminConsole", "AuditDeliveryTarget"]);
    const uncovered = NAMESPACES.filter(
      (ns) => !NS_DASHBOARD_ALL.includes(ns) && !excluded.has(ns),
    );
    expect(uncovered).toEqual([]);
  });

  it("NS_RECOVERY is a superset of NS_GLOBAL and includes Recovery + Vault", () => {
    for (const ns of NS_GLOBAL) {
      expect(NS_RECOVERY).toContain(ns);
    }
    expect(NS_RECOVERY).toContain("Recovery");
    expect(NS_RECOVERY).toContain("Vault");
  });

  it("NS_VAULT_RESET is a superset of NS_GLOBAL and includes VaultReset", () => {
    for (const ns of NS_GLOBAL) {
      expect(NS_VAULT_RESET).toContain(ns);
    }
    expect(NS_VAULT_RESET).toContain("VaultReset");
  });

  it("every entry in NS_GLOBAL belongs to NAMESPACES", () => {
    for (const ns of NS_GLOBAL) {
      expect(NAMESPACES).toContain(ns);
    }
  });

  it("every entry in NS_VAULT belongs to NAMESPACES", () => {
    for (const ns of NS_VAULT) {
      expect(NAMESPACES).toContain(ns);
    }
  });

  it("every entry in NS_RECOVERY belongs to NAMESPACES", () => {
    for (const ns of NS_RECOVERY) {
      expect(NAMESPACES).toContain(ns);
    }
  });

  it("every entry in NS_VAULT_RESET belongs to NAMESPACES", () => {
    for (const ns of NS_VAULT_RESET) {
      expect(NAMESPACES).toContain(ns);
    }
  });

  it("NS_DASHBOARD_ALL has no duplicate entries", () => {
    expect(NS_DASHBOARD_ALL.length).toBe(new Set(NS_DASHBOARD_ALL).size);
  });

  it("NS_RECOVERY has no duplicate entries", () => {
    expect(NS_RECOVERY.length).toBe(new Set(NS_RECOVERY).size);
  });

  it("NS_VAULT_RESET has no duplicate entries", () => {
    expect(NS_VAULT_RESET.length).toBe(new Set(NS_VAULT_RESET).size);
  });

  it("NS_PRIVACY_POLICY is a superset of NS_GLOBAL and includes PrivacyPolicy", () => {
    for (const ns of NS_GLOBAL) {
      expect(NS_PRIVACY_POLICY).toContain(ns);
    }
    expect(NS_PRIVACY_POLICY).toContain("PrivacyPolicy");
  });

  it("every entry in NS_PRIVACY_POLICY belongs to NAMESPACES", () => {
    for (const ns of NS_PRIVACY_POLICY) {
      expect(NAMESPACES).toContain(ns);
    }
  });

  it("NS_PRIVACY_POLICY has no duplicate entries", () => {
    expect(NS_PRIVACY_POLICY.length).toBe(new Set(NS_PRIVACY_POLICY).size);
  });

  it("NS_ADMIN_ALL is a superset of NS_GLOBAL", () => {
    for (const ns of NS_GLOBAL) {
      expect(NS_ADMIN_ALL).toContain(ns);
    }
  });

  it("every entry in NS_ADMIN_ALL belongs to NAMESPACES", () => {
    for (const ns of NS_ADMIN_ALL) {
      expect(NAMESPACES).toContain(ns);
    }
  });

  it("NS_ADMIN_ALL has no duplicate entries", () => {
    expect(NS_ADMIN_ALL.length).toBe(new Set(NS_ADMIN_ALL).size);
  });

  it("NS_ADMIN_ALL includes AdminConsole namespace", () => {
    expect(NS_ADMIN_ALL).toContain("AdminConsole");
  });
});
