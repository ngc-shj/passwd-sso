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
  const [tagOrgId, setTagOrgId] = useState<string | null>(null);

  const handleTagCreate = (orgId?: string) => {
    setTagOrgId(orgId ?? null);
    setEditingTag(null);
    setTagDialogOpen(true);
  };

  const handleTagEdit = (tag: SidebarTagItem, orgId?: string) => {
    setTagOrgId(orgId ?? null);
    setEditingTag(tag);
    setTagDialogOpen(true);
  };

  const handleTagDeleteClick = (tag: SidebarTagItem, orgId?: string) => {
    setTagOrgId(orgId ?? null);
    setDeletingTag(tag);
  };

  const clearDeletingTag = () => {
    setDeletingTag(null);
  };

  const handleTagSubmit = async (data: TagSubmitPayload) => {
    const isEdit = !!editingTag;
    const url = isEdit
      ? (tagOrgId ? `${apiPath.orgTags(tagOrgId)}/${editingTag.id}` : `${API_PATH.TAGS}/${editingTag.id}`)
      : (tagOrgId ? apiPath.orgTags(tagOrgId) : API_PATH.TAGS);
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

    const url = tagOrgId
      ? `${apiPath.orgTags(tagOrgId)}/${deletingTag.id}`
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
