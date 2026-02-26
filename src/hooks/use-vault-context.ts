"use client";

import { useEffect, useMemo } from "react";
import { usePathname, useSearchParams } from "next/navigation";
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
type TeamContextItem = OrgContextItem;

const CROSS_VAULT_PATHS = [
  "/dashboard/watchtower",
  "/dashboard/share-links",
  "/dashboard/emergency-access",
  "/dashboard/teams",
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

export function useVaultContext(teams: TeamContextItem[]): VaultContext {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const cleanPath = stripLocalePrefix(pathname);
  const [lastContext, setLastContext] = useLocalStorage<string>("vault-context", "personal");

  const resolved = useMemo<VaultContext>(() => {
    if (cleanPath === "/dashboard/share-links") {
      const shareOrgId = searchParams.get("org");
      if (shareOrgId) {
        const org = teams.find((item) => item.id === shareOrgId);
        if (org) {
          return { type: "org", orgId: org.id, orgName: org.name, orgRole: org.role };
        }
      }
    }

    const orgMatch = cleanPath.match(/^\/dashboard\/(?:teams|orgs)\/([^/]+)/);
    if (orgMatch) {
      const org = teams.find((item) => item.id === orgMatch[1]);
      if (org) {
        return { type: "org", orgId: org.id, orgName: org.name, orgRole: org.role };
      }
    }

    if (isPersonalVaultPath(cleanPath)) {
      return { type: "personal" };
    }

    if (isCrossVaultPath(cleanPath) && lastContext !== "personal") {
      const org = teams.find((item) => item.id === lastContext);
      if (org) {
        return { type: "org", orgId: org.id, orgName: org.name, orgRole: org.role };
      }
    }

    return { type: "personal" };
  }, [cleanPath, lastContext, teams, searchParams]);

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
