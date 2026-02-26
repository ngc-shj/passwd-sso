"use client";

import { useEffect, useMemo } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { stripLocalePrefix } from "@/i18n/locale-utils";
import { useLocalStorage } from "@/hooks/use-local-storage";

export type TeamScopedVaultContext = {
  type: "org";
  teamId: string;
  teamName?: string;
  teamRole?: string;
  // Compatibility aliases
  orgId: string;
  orgName?: string;
  orgRole?: string;
};

export type VaultContext =
  | { type: "personal" }
  | TeamScopedVaultContext;

export type TeamVaultContext = VaultContext;

interface TeamContextItem {
  id: string;
  name: string;
  role: string;
}

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

function createTeamScopedContext(team: TeamContextItem): TeamScopedVaultContext {
  return {
    type: "org",
    teamId: team.id,
    teamName: team.name,
    teamRole: team.role,
    orgId: team.id,
    orgName: team.name,
    orgRole: team.role,
  };
}

export function useVaultContext(teams: TeamContextItem[]): VaultContext {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const cleanPath = stripLocalePrefix(pathname);
  const [lastContext, setLastContext] = useLocalStorage<string>("vault-context", "personal");

  const resolved = useMemo<VaultContext>(() => {
    if (cleanPath === "/dashboard/share-links") {
      const shareTeamId = searchParams.get("team") ?? searchParams.get("org");
      if (shareTeamId) {
        const team = teams.find((item) => item.id === shareTeamId);
        if (team) {
          return createTeamScopedContext(team);
        }
      }
    }

    const teamMatch = cleanPath.match(/^\/dashboard\/(?:teams|orgs)\/([^/]+)/);
    if (teamMatch) {
      const team = teams.find((item) => item.id === teamMatch[1]);
      if (team) {
        return createTeamScopedContext(team);
      }
    }

    if (isPersonalVaultPath(cleanPath)) {
      return { type: "personal" };
    }

    if (isCrossVaultPath(cleanPath) && lastContext !== "personal") {
      const team = teams.find((item) => item.id === lastContext);
      if (team) {
        return createTeamScopedContext(team);
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

export const useTeamVaultContext = useVaultContext;
