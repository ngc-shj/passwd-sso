"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ORG_ROLE, API_PATH, apiPath } from "@/lib/constants";

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

export interface SidebarOrgItem {
  id: string;
  name: string;
  slug: string;
  role: string;
}

export interface SidebarOrgTagGroup {
  orgId: string;
  orgName: string;
  tags: { id: string; name: string; color: string | null; count: number }[];
}

export interface SidebarOrgFolderGroup {
  orgId: string;
  orgName: string;
  orgRole: string;
  folders: SidebarFolderItem[];
}

export interface SidebarOrganizeTagItem {
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
  const [orgs, setOrgs] = useState<SidebarOrgItem[]>([]);
  const [orgTagGroups, setOrgTagGroups] = useState<SidebarOrgTagGroup[]>([]);
  const [orgFolderGroups, setOrgFolderGroups] = useState<SidebarOrgFolderGroup[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);
  const refreshSeqRef = useRef(0);

  const refreshData = useCallback(async () => {
    const seq = ++refreshSeqRef.current;
    const errors: string[] = [];
    const reportError = (message: string) => {
      errors.push(message);
    };

    const [nextTags, nextFolders, nextOrgs] = await Promise.all([
      fetchArray<SidebarTagItem>(API_PATH.TAGS, reportError),
      fetchArray<SidebarFolderItem>(API_PATH.FOLDERS, reportError),
      fetchArray<SidebarOrgItem>(API_PATH.ORGS, reportError),
    ]);

    if (seq !== refreshSeqRef.current) return;

    if (nextTags) setTags(nextTags);
    if (nextFolders) setFolders(nextFolders);

    if (!nextOrgs) {
      setOrgs([]);
      setOrgTagGroups([]);
      setOrgFolderGroups([]);
      setLastError(errors[0] ?? `Failed to fetch ${API_PATH.ORGS}`);
      return;
    }

    setOrgs(nextOrgs);

    const orgDetails = await Promise.all(
      nextOrgs.map(async (org) => {
        const [orgTags, orgFolders] = await Promise.all([
          fetchArray<{ id: string; name: string; color: string | null; count: number }>(
            apiPath.orgTags(org.id),
            reportError,
          ),
          fetchArray<SidebarFolderItem>(apiPath.orgFolders(org.id), reportError),
        ]);
        return { org, orgTags, orgFolders };
      })
    );

    if (seq !== refreshSeqRef.current) return;

    const tagGroups: SidebarOrgTagGroup[] = [];
    const folderGroups: SidebarOrgFolderGroup[] = [];
    for (const { org, orgTags, orgFolders } of orgDetails) {
      if (orgTags && orgTags.length > 0) {
        tagGroups.push({ orgId: org.id, orgName: org.name, tags: orgTags });
      }
      if (orgFolders) {
        const canManage = org.role === ORG_ROLE.OWNER || org.role === ORG_ROLE.ADMIN;
        if (orgFolders.length > 0 || canManage) {
          folderGroups.push({
            orgId: org.id,
            orgName: org.name,
            orgRole: org.role,
            folders: orgFolders,
          });
        }
      }
    }
    setOrgTagGroups(tagGroups);
    setOrgFolderGroups(folderGroups);
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
    window.addEventListener("org-data-changed", handler);
    return () => {
      window.removeEventListener("vault-data-changed", handler);
      window.removeEventListener("org-data-changed", handler);
    };
  }, [refreshData]);

  const notifyDataChanged = () => {
    window.dispatchEvent(new CustomEvent("vault-data-changed"));
  };

  return {
    tags,
    folders,
    orgs,
    orgTagGroups,
    orgFolderGroups,
    lastError,
    refreshData,
    notifyDataChanged,
  };
}
