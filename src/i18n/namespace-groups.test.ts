import { describe, expect, it } from "vitest";
import { NAMESPACES } from "./messages";
import {
  NS_GLOBAL,
  NS_VAULT,
  NS_DASHBOARD_ALL,
  NS_PUBLIC_SHARE,
  NS_RECOVERY,
  NS_VAULT_RESET,
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
    // Only Metadata, Recovery, and VaultReset are intentionally excluded
    const excluded = new Set(["Metadata", "Recovery", "VaultReset"]);
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
});
