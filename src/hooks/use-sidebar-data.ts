"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { TEAM_ROLE, API_PATH, apiPath } from "@/lib/constants";

export interface SidebarTagItem {
  id: string;
  name: string;
  color: string | null;
  passwordCount: number;
}

export interface SidebarFolderItem {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  entryCount: number;
}

export interface SidebarTeamItem {
  id: string;
  name: string;
  slug: string;
  role: string;
  tenantName: string;
  isCrossTenant: boolean;
}

export interface SidebarTeamTagGroup {
  teamId: string;
  teamName: string;
  tags: { id: string; name: string; color: string | null; count: number }[];
}

export interface SidebarTeamFolderGroup {
  teamId: string;
  teamName: string;
  teamRole: string;
  folders: SidebarFolderItem[];
}

export interface SidebarTeamTagItem {
  id: string;
  name: string;
  color: string | null;
  count: number;
}

async function fetchArray<T>(
  url: string,
  onError?: (message: string) => void,
): Promise<T[] | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      onError?.(`Failed to fetch ${url}: ${res.status}`);
      return null;
    }
    const data = await res.json();
    if (!Array.isArray(data)) {
      onError?.(`Invalid response from ${url}: expected array`);
      return null;
    }
    return data as T[];
  } catch (error) {
    onError?.(
      `Request error for ${url}: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    return null;
  }
}

export function useSidebarData(pathname: string) {
  const [tags, setTags] = useState<SidebarTagItem[]>([]);
  const [folders, setFolders] = useState<SidebarFolderItem[]>([]);
  const [teams, setTeams] = useState<SidebarTeamItem[]>([]);
  const [teamTagGroups, setTeamTagGroups] = useState<SidebarTeamTagGroup[]>([]);
  const [teamFolderGroups, setTeamFolderGroups] = useState<SidebarTeamFolderGroup[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);
  const refreshSeqRef = useRef(0);

  const refreshData = useCallback(async () => {
    const seq = ++refreshSeqRef.current;
    const errors: string[] = [];
    const reportError = (message: string) => {
      errors.push(message);
    };

    const [nextTags, nextFolders, nextTeams] = await Promise.all([
      fetchArray<SidebarTagItem>(API_PATH.TAGS, reportError),
      fetchArray<SidebarFolderItem>(API_PATH.FOLDERS, reportError),
      fetchArray<SidebarTeamItem>(API_PATH.TEAMS, reportError),
    ]);

    if (seq !== refreshSeqRef.current) return;

    if (nextTags) setTags(nextTags);
    if (nextFolders) setFolders(nextFolders);

    if (!nextTeams) {
      setTeams([]);
      setTeamTagGroups([]);
      setTeamFolderGroups([]);
      setLastError(errors[0] ?? `Failed to fetch ${API_PATH.TEAMS}`);
      return;
    }

    setTeams(nextTeams);

    const teamDetails = await Promise.all(
      nextTeams.map(async (team) => {
        const [teamTags, teamFolders] = await Promise.all([
          fetchArray<{ id: string; name: string; color: string | null; count: number }>(
            apiPath.teamTags(team.id),
            reportError,
          ),
          fetchArray<SidebarFolderItem>(apiPath.teamFolders(team.id), reportError),
        ]);
        return { team, teamTags, teamFolders };
      })
    );

    if (seq !== refreshSeqRef.current) return;

    const tagGroups: SidebarTeamTagGroup[] = [];
    const folderGroups: SidebarTeamFolderGroup[] = [];
    for (const { team, teamTags, teamFolders } of teamDetails) {
      if (teamTags && teamTags.length > 0) {
        tagGroups.push({ teamId: team.id, teamName: team.name, tags: teamTags });
      }
      if (teamFolders) {
        const canManage = team.role === TEAM_ROLE.OWNER || team.role === TEAM_ROLE.ADMIN;
        if (teamFolders.length > 0 || canManage) {
          folderGroups.push({
            teamId: team.id,
            teamName: team.name,
            teamRole: team.role,
            folders: teamFolders,
          });
        }
      }
    }
    setTeamTagGroups(tagGroups);
    setTeamFolderGroups(folderGroups);
    setLastError(errors[0] ?? null);
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void refreshData();
    });
  }, [pathname, refreshData]);

  useEffect(() => {
    const handler = () => refreshData();
    window.addEventListener("vault-data-changed", handler);
    window.addEventListener("team-data-changed", handler);
    return () => {
      window.removeEventListener("vault-data-changed", handler);
      window.removeEventListener("team-data-changed", handler);
    };
  }, [refreshData]);

  const notifyDataChanged = () => {
    window.dispatchEvent(new CustomEvent("vault-data-changed"));
    window.dispatchEvent(new CustomEvent("team-data-changed"));
  };

  const notifyTeamDataChanged = notifyDataChanged;

  return {
    tags,
    folders,
    teams,
    teamTagGroups,
    teamFolderGroups,
    lastError,
    refreshData,
    notifyDataChanged,
    notifyTeamDataChanged,
  };
}
