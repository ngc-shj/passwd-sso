"use client";

import { useState } from "react";
import { API_PATH, apiPath } from "@/lib/constants";
import { showSidebarCrudError } from "@/hooks/sidebar-crud-error";
import type { SidebarFolderItem, SidebarTeamFolderGroup } from "@/hooks/use-sidebar-data";

interface UseSidebarFolderCrudParams {
  folders: SidebarFolderItem[];
  teamFolderGroups: SidebarTeamFolderGroup[];
  refreshData: () => void;
  tErrors: (key: string) => string;
}

interface FolderSubmitPayload {
  name: string;
  parentId: string | null;
}

export function useSidebarFolderCrud({
  folders,
  teamFolderGroups,
  refreshData,
  tErrors,
}: UseSidebarFolderCrudParams) {
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [editingFolder, setEditingFolder] = useState<SidebarFolderItem | null>(null);
  const [deletingFolder, setDeletingFolder] = useState<SidebarFolderItem | null>(null);
  const [folderTeamId, setFolderTeamId] = useState<string | null>(null);

  const handleFolderCreate = (teamId?: string) => {
    setFolderTeamId(teamId ?? null);
    setEditingFolder(null);
    setFolderDialogOpen(true);
  };

  const handleFolderEdit = (folder: SidebarFolderItem, teamId?: string) => {
    setFolderTeamId(teamId ?? null);
    setEditingFolder(folder);
    setFolderDialogOpen(true);
  };

  const handleFolderDeleteClick = (folder: SidebarFolderItem, teamId?: string) => {
    setFolderTeamId(teamId ?? null);
    setDeletingFolder(folder);
  };

  const clearDeletingFolder = () => {
    setDeletingFolder(null);
  };

  const handleFolderSubmit = async (data: FolderSubmitPayload) => {
    const isTeam = folderTeamId !== null;
    const url = editingFolder
      ? isTeam
        ? apiPath.teamFolderById(folderTeamId, editingFolder.id)
        : apiPath.folderById(editingFolder.id)
      : isTeam
        ? apiPath.teamFolders(folderTeamId)
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
    const url = folderTeamId
      ? apiPath.teamFolderById(folderTeamId, deletingFolder.id)
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

  const dialogFolders = folderTeamId
    ? teamFolderGroups.find((g) => g.teamId === folderTeamId)?.folders ?? []
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
