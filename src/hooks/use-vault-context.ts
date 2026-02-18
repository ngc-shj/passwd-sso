"use client";

import { useEffect, useMemo } from "react";
import { usePathname } from "next/navigation";
import { stripLocalePrefix } from "@/i18n/locale-utils";
import { useLocalStorage } from "@/hooks/use-local-storage";

export type VaultContext =
  | { type: "personal" }
  | { type: "org"; orgId: string; orgName?: string; orgRole?: string };

interface OrgContextItem {
  id: string;
  name: string;
  role: string;
}

const CROSS_VAULT_PATHS = [
  "/dashboard/watchtower",
  "/dashboard/share-links",
  "/dashboard/emergency-access",
  "/dashboard/orgs",
] as const;

function isPersonalVaultPath(path: string): boolean {
  if (path === "/dashboard") return true;
  return [
    "/dashboard/favorites",
    "/dashboard/archive",
    "/dashboard/trash",
    "/dashboard/tags",
    "/dashboard/folders",
    "/dashboard/audit-logs",
  ].some((prefix) => path === prefix || path.startsWith(prefix + "/"));
}

function isCrossVaultPath(path: string): boolean {
  return CROSS_VAULT_PATHS.some((prefix) => path === prefix || path.startsWith(prefix + "/"));
}

export function useVaultContext(orgs: OrgContextItem[]): VaultContext {
  const pathname = usePathname();
  const cleanPath = stripLocalePrefix(pathname);
  const [lastContext, setLastContext] = useLocalStorage<string>("vault-context", "personal");

  const resolved = useMemo<VaultContext>(() => {
    const orgMatch = cleanPath.match(/^\/dashboard\/orgs\/([^/]+)/);
    if (orgMatch) {
      const org = orgs.find((item) => item.id === orgMatch[1]);
      if (org) {
        return { type: "org", orgId: org.id, orgName: org.name, orgRole: org.role };
      }
    }

    if (isPersonalVaultPath(cleanPath)) {
      return { type: "personal" };
    }

    if (isCrossVaultPath(cleanPath) && lastContext !== "personal") {
      const org = orgs.find((item) => item.id === lastContext);
      if (org) {
        return { type: "org", orgId: org.id, orgName: org.name, orgRole: org.role };
      }
    }

    return { type: "personal" };
  }, [cleanPath, lastContext, orgs]);

  useEffect(() => {
    if (resolved.type === "org" && lastContext !== resolved.orgId) {
      setLastContext(resolved.orgId);
      return;
    }
    if (resolved.type === "personal" && isPersonalVaultPath(cleanPath) && lastContext !== "personal") {
      setLastContext("personal");
    }
  }, [cleanPath, lastContext, resolved, setLastContext]);

  return resolved;
}
