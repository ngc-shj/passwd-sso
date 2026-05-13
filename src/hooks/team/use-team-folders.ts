"use client";

import { useEffect, useState } from "react";
import { apiPath } from "@/lib/constants";
import { fetchApi } from "@/lib/url-helpers";
import type { TeamFolderItem } from "@/components/team/forms/team-entry-form-types";

export function useTeamFolders(open: boolean, teamId: string) {
  const [folders, setFolders] = useState<TeamFolderItem[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;

    const url = apiPath.teamFolders(teamId);
    (async () => {
      try {
        const res = await fetchApi(url);
        if (!res.ok) throw new Error(`${res.status}`);
        const data = await res.json();
        if (Array.isArray(data)) {
          setFolders(data);
          setFetchError(null);
        }
      } catch (e: unknown) {
        setFetchError(
          `Failed to load ${url}: ${e instanceof Error ? e.message : "unknown"}`,
        );
      }
    })();
  }, [open, teamId]);

  return { folders, fetchError };
}
