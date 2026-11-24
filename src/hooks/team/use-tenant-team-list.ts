"use client";

import { useEffect, useState } from "react";
import { API_PATH } from "@/lib/constants";
import { fetchApi } from "@/lib/url-helpers";
import { notifyTeamDataChanged } from "@/lib/events";

export interface TeamListItem {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  role: string;
  createdAt: string;
  memberCount: number;
  tenantName?: string;
  isCrossTenant?: boolean;
}

export function useTenantTeamList() {
  const [teams, setTeams] = useState<TeamListItem[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchTeams = () => {
    void (async () => {
      try {
        const res = await fetchApi(API_PATH.TEAMS);
        if (!res.ok) return;
        const data = await res.json();
        if (Array.isArray(data)) setTeams(data);
      } catch {
        // best-effort — leave teams empty
      } finally {
        setLoading(false);
      }
    })();
  };

  const handleCreated = () => {
    setLoading(true);
    fetchTeams();
    notifyTeamDataChanged();
  };

  useEffect(() => {
    fetchTeams();
  }, []);

  return { teams, loading, handleCreated };
}
