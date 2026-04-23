"use client";

import { useEffect } from "react";
import { useLocalStorage } from "@/hooks/use-local-storage";

export type SidebarSection =
  | "categories"
  | "folders"
  | "tags"
  | "security"
  | "settingsNav"
  | "tools";

const COLLAPSE_DEFAULTS: Record<SidebarSection, boolean> = {
  categories: true,
  folders: true,
  tags: true,
  security: false,
  settingsNav: true,
  tools: true,
};

interface UseSidebarSectionsStateParams {
  routeKey: string;
  selectedTypeFilter: string | null;
  selectedTagId: string | null;
  selectedFolderId: string | null;
  isWatchtower: boolean;
  isShareLinks: boolean;
  isEmergencyAccess: boolean;
  isPersonalAuditLog: boolean;
  isSettingsActive: boolean;
  isExportActive: boolean;
  isImportActive: boolean;
  isAdminActive?: boolean;
}

export function useSidebarSectionsState({
  routeKey,
  selectedTypeFilter,
  selectedTagId,
  selectedFolderId,
  isWatchtower,
  isShareLinks,
  isEmergencyAccess,
  isPersonalAuditLog,
  isSettingsActive,
  isExportActive,
  isImportActive,
  isAdminActive,
}: UseSidebarSectionsStateParams) {
  const [collapsed, setCollapsed] = useLocalStorage<Record<SidebarSection, boolean>>(
    "sidebar-collapsed",
    COLLAPSE_DEFAULTS,
  );

  const isOpen = (key: SidebarSection) => !collapsed[key];

  const toggleSection =
    (key: SidebarSection) =>
    (open: boolean): void => {
      setCollapsed((prev) => ({ ...prev, [key]: !open }));
    };

  useEffect(() => {
    const toOpen: SidebarSection[] = [];
    if (selectedTypeFilter !== null) toOpen.push("categories");
    if (selectedFolderId !== null) toOpen.push("folders");
    if (selectedTagId !== null) toOpen.push("tags");
    if (isWatchtower || isShareLinks || isEmergencyAccess || isPersonalAuditLog) toOpen.push("security");
    if (isSettingsActive && !isAdminActive) toOpen.push("settingsNav");
    if (isExportActive || isImportActive) toOpen.push("tools");

    if (toOpen.length === 0) return;

    setCollapsed((prev) => {
      const next = { ...prev };
      for (const key of toOpen) next[key] = false;
      return next;
    });
  }, [
    routeKey,
    selectedTypeFilter,
    selectedTagId,
    selectedFolderId,
    isWatchtower,
    isShareLinks,
    isEmergencyAccess,
    isPersonalAuditLog,
    isSettingsActive,
    isExportActive,
    isImportActive,
    isAdminActive,
    setCollapsed,
  ]);

  return { isOpen, toggleSection };
}
