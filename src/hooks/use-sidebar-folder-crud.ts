"use client";

import { useState } from "react";
import { API_PATH, apiPath } from "@/lib/constants";
import { showSidebarCrudError } from "@/hooks/use-sidebar-crud-error";
import type { SidebarFolderItem, SidebarOrgFolderGroup } from "@/hooks/use-sidebar-data";

interface UseSidebarFolderCrudParams {
  folders: SidebarFolderItem[];
  orgFolderGroups: SidebarOrgFolderGroup[];
  refreshData: () => void;
  tErrors: (key: string) => string;
}

interface FolderSubmitPayload {
  name: string;
  parentId: string | null;
}

export function useSidebarFolderCrud({
  folders,
  orgFolderGroups,
  refreshData,
  tErrors,
}: UseSidebarFolderCrudParams) {
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [editingFolder, setEditingFolder] = useState<SidebarFolderItem | null>(null);
  const [deletingFolder, setDeletingFolder] = useState<SidebarFolderItem | null>(null);
  const [folderOrgId, setFolderOrgId] = useState<string | null>(null);

  const handleFolderCreate = (orgId?: string) => {
    setFolderOrgId(orgId ?? null);
    setEditingFolder(null);
    setFolderDialogOpen(true);
  };

  const handleFolderEdit = (folder: SidebarFolderItem, orgId?: string) => {
    setFolderOrgId(orgId ?? null);
    setEditingFolder(folder);
    setFolderDialogOpen(true);
  };

  const handleFolderDeleteClick = (folder: SidebarFolderItem, orgId?: string) => {
    setFolderOrgId(orgId ?? null);
    setDeletingFolder(folder);
  };

  const clearDeletingFolder = () => {
    setDeletingFolder(null);
  };

  const handleFolderSubmit = async (data: FolderSubmitPayload) => {
    const isOrg = folderOrgId !== null;
    const url = editingFolder
      ? isOrg
        ? apiPath.orgFolderById(folderOrgId, editingFolder.id)
        : apiPath.folderById(editingFolder.id)
      : isOrg
        ? apiPath.orgFolders(folderOrgId)
        : API_PATH.FOLDERS;
    const method = editingFolder ? "PUT" : "POST";

    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      await showSidebarCrudError(res, tErrors);
      throw new Error("API error");
    }
    refreshData();
  };

  const handleFolderDelete = async () => {
    if (!deletingFolder) return;
    const url = folderOrgId
      ? apiPath.orgFolderById(folderOrgId, deletingFolder.id)
      : apiPath.folderById(deletingFolder.id);
    const res = await fetch(url, { method: "DELETE" });
    if (!res.ok) {
      await showSidebarCrudError(res, tErrors);
      setDeletingFolder(null);
      return;
    }
    setDeletingFolder(null);
    refreshData();
  };

  const dialogFolders = folderOrgId
    ? orgFolderGroups.find((g) => g.orgId === folderOrgId)?.folders ?? []
    : folders;

  return {
    folderDialogOpen,
    setFolderDialogOpen,
    editingFolder,
    deletingFolder,
    dialogFolders,
    handleFolderCreate,
    handleFolderEdit,
    handleFolderDeleteClick,
    handleFolderSubmit,
    handleFolderDelete,
    clearDeletingFolder,
  };
}
