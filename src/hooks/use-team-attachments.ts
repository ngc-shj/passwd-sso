"use client";

import { useEffect, useState } from "react";
import { apiPath } from "@/lib/constants";
import type { TeamAttachmentMeta } from "@/components/team/team-attachment-section";

export function useTeamAttachments(open: boolean, teamId: string, entryId?: string) {
  const [attachments, setAttachments] = useState<TeamAttachmentMeta[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !entryId) return;

    const url = apiPath.teamPasswordAttachments(teamId, entryId);
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        return res.json();
      })
      .then((loaded: TeamAttachmentMeta[]) => {
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

