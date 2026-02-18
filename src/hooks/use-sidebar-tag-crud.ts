"use client";

import { useState } from "react";
import { toast } from "sonner";
import { apiErrorToI18nKey } from "@/lib/api-error-codes";
import { API_PATH, apiPath } from "@/lib/constants";

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

  const showApiError = async (res: Response) => {
    try {
      const json = await res.json();
      const i18nKey = apiErrorToI18nKey(json.error);
      toast.error(tErrors(i18nKey));
    } catch {
      toast.error(tErrors("unknownError"));
    }
  };

  const handleTagSubmit = async (data: TagSubmitPayload) => {
    if (!editingTag) return;

    const url = tagOrgId
      ? `${apiPath.orgTags(tagOrgId)}/${editingTag.id}`
      : `${API_PATH.TAGS}/${editingTag.id}`;

    const res = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });

    if (!res.ok) {
      await showApiError(res);
      throw new Error("API error");
    }

    setTagDialogOpen(false);
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
      await showApiError(res);
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
    handleTagEdit,
    handleTagDeleteClick,
    handleTagSubmit,
    handleTagDelete,
    clearDeletingTag,
  };
}
