"use client";

import { useCallback, useEffect, useState } from "react";
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

export function useSidebarData(pathname: string) {
  const [tags, setTags] = useState<SidebarTagItem[]>([]);
  const [folders, setFolders] = useState<SidebarFolderItem[]>([]);
  const [orgs, setOrgs] = useState<SidebarOrgItem[]>([]);
  const [orgTagGroups, setOrgTagGroups] = useState<SidebarOrgTagGroup[]>([]);
  const [orgFolderGroups, setOrgFolderGroups] = useState<SidebarOrgFolderGroup[]>([]);

  const refreshData = useCallback(() => {
    fetch(API_PATH.TAGS)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch tags");
        return res.json();
      })
      .then((data) => {
        if (Array.isArray(data)) setTags(data);
      })
      .catch(() => {});

    fetch(API_PATH.FOLDERS)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch folders");
        return res.json();
      })
      .then((data) => {
        if (Array.isArray(data)) setFolders(data);
      })
      .catch(() => {});

    fetch(API_PATH.ORGS)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch orgs");
        return res.json();
      })
      .then(async (data) => {
        if (!Array.isArray(data)) return;
        setOrgs(data);

        const tagGroups: SidebarOrgTagGroup[] = [];
        const folderGroups: SidebarOrgFolderGroup[] = [];
        await Promise.all(
          data.map(async (org: SidebarOrgItem) => {
            const [tagsRes, foldersRes] = await Promise.all([
              fetch(apiPath.orgTags(org.id)).catch(() => null),
              fetch(apiPath.orgFolders(org.id)).catch(() => null),
            ]);
            if (tagsRes?.ok) {
              const orgTags = await tagsRes.json();
              if (Array.isArray(orgTags) && orgTags.length > 0) {
                tagGroups.push({ orgId: org.id, orgName: org.name, tags: orgTags });
              }
            }
            if (foldersRes?.ok) {
              const orgFolders = await foldersRes.json();
              if (Array.isArray(orgFolders)) {
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
          })
        );
        setOrgTagGroups(tagGroups);
        setOrgFolderGroups(folderGroups);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshData();
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
    refreshData,
    notifyDataChanged,
  };
}
