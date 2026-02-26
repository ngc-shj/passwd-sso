"use client";

import { useState } from "react";
import { API_PATH, apiPath } from "@/lib/constants";
import { showSidebarCrudError } from "@/hooks/sidebar-crud-error";

interface SidebarTagItem {
  id: string;
  name: string;
  color: string | null;
}

interface TagSubmitPayload {
  name: string;
  color: string | null;
}

interface UseSidebarTagCrudParams {
  refreshData: () => void;
  tErrors: (key: string) => string;
}

export function useSidebarTagCrud({ refreshData, tErrors }: UseSidebarTagCrudParams) {
  const [tagDialogOpen, setTagDialogOpen] = useState(false);
  const [editingTag, setEditingTag] = useState<SidebarTagItem | null>(null);
  const [deletingTag, setDeletingTag] = useState<SidebarTagItem | null>(null);
  const [tagTeamId, setTagTeamId] = useState<string | null>(null);

  const handleTagCreate = (teamId?: string) => {
    setTagTeamId(teamId ?? null);
    setEditingTag(null);
    setTagDialogOpen(true);
  };

  const handleTagEdit = (tag: SidebarTagItem, teamId?: string) => {
    setTagTeamId(teamId ?? null);
    setEditingTag(tag);
    setTagDialogOpen(true);
  };

  const handleTagDeleteClick = (tag: SidebarTagItem, teamId?: string) => {
    setTagTeamId(teamId ?? null);
    setDeletingTag(tag);
  };

  const clearDeletingTag = () => {
    setDeletingTag(null);
  };

  const handleTagSubmit = async (data: TagSubmitPayload) => {
    const isEdit = !!editingTag;
    const url = isEdit
      ? (tagTeamId ? `${apiPath.teamTags(tagTeamId)}/${editingTag.id}` : `${API_PATH.TAGS}/${editingTag.id}`)
      : (tagTeamId ? apiPath.teamTags(tagTeamId) : API_PATH.TAGS);
    const method = isEdit ? "PUT" : "POST";

    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      await showSidebarCrudError(res, tErrors);
      throw new Error("API error");
    }

    setEditingTag(null);
    refreshData();
  };

  const handleTagDelete = async () => {
    if (!deletingTag) return;

    const url = tagTeamId
      ? `${apiPath.teamTags(tagTeamId)}/${deletingTag.id}`
      : `${API_PATH.TAGS}/${deletingTag.id}`;

    const res = await fetch(url, { method: "DELETE" });
    if (!res.ok) {
      await showSidebarCrudError(res, tErrors);
      setDeletingTag(null);
      return;
    }

    setDeletingTag(null);
    refreshData();
  };

  return {
    tagDialogOpen,
    setTagDialogOpen,
    editingTag,
    deletingTag,
    handleTagCreate,
    handleTagEdit,
    handleTagDeleteClick,
    handleTagSubmit,
    handleTagDelete,
    clearDeletingTag,
  };
}
