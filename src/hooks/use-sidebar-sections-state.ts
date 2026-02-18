"use client";

import { useEffect } from "react";
import { useLocalStorage } from "@/hooks/use-local-storage";

export type SidebarSection =
  | "categories"
  | "organize"
  | "security"
  | "utilities";

const COLLAPSE_DEFAULTS: Record<SidebarSection, boolean> = {
  categories: true,
  organize: true,
  security: false,
  utilities: true,
};

interface UseSidebarSectionsStateParams {
  routeKey: string;
  selectedTypeFilter: string | null;
  selectedTagId: string | null;
  selectedFolderId: string | null;
  isWatchtower: boolean;
  isShareLinks: boolean;
  isEmergencyAccess: boolean;
  isAuditLog: boolean;
}

export function useSidebarSectionsState({
  routeKey,
  selectedTypeFilter,
  selectedTagId,
  selectedFolderId,
  isWatchtower,
  isShareLinks,
  isEmergencyAccess,
  isAuditLog,
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
    if (selectedTagId !== null || selectedFolderId !== null) toOpen.push("organize");
    if (isWatchtower || isShareLinks || isEmergencyAccess || isAuditLog) toOpen.push("security");

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
    isAuditLog,
    setCollapsed,
  ]);

  return { isOpen, toggleSection };
}
