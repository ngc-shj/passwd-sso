"use client";

import { useEffect, useState } from "react";
import { apiPath } from "@/lib/constants";
import type { OrgAttachmentMeta } from "@/components/org/org-attachment-section";

export function useOrgAttachments(open: boolean, teamId: string, entryId?: string) {
  const [attachments, setAttachments] = useState<OrgAttachmentMeta[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !entryId) return;

    const url = apiPath.teamPasswordAttachments(teamId, entryId);
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        return res.json();
      })
      .then((loaded: OrgAttachmentMeta[]) => {
        setAttachments(loaded);
        setFetchError(null);
      })
      .catch((e: unknown) => {
        setAttachments([]);
        setFetchError(`Failed to load ${url}: ${e instanceof Error ? e.message : "unknown"}`);
      });
  }, [open, teamId, entryId]);

  return { attachments, setAttachments, fetchError };
}
