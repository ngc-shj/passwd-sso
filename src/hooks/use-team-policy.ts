"use client";

import { useEffect, useState } from "react";
import { apiPath } from "@/lib/constants";

export interface TeamPolicyClient {
  minPasswordLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireNumbers: boolean;
  requireSymbols: boolean;
  requireRepromptForAll: boolean;
  allowExport: boolean;
  allowSharing: boolean;
}

const DEFAULT_POLICY: TeamPolicyClient = {
  minPasswordLength: 0,
  requireUppercase: false,
  requireLowercase: false,
  requireNumbers: false,
  requireSymbols: false,
  requireRepromptForAll: false,
  allowExport: true,
  allowSharing: true,
};

export function useTeamPolicy(open: boolean, teamId: string) {
  const [policy, setPolicy] = useState<TeamPolicyClient>(DEFAULT_POLICY);

  useEffect(() => {
    if (!open) return;

    fetch(apiPath.teamPolicy(teamId))
      .then((res) => {
        if (!res.ok) return;
        return res.json();
      })
      .then((data) => {
        if (data) setPolicy(data as TeamPolicyClient);
      })
      .catch(() => {
        // silently fallback to defaults
      });
  }, [open, teamId]);

  return { policy };
}
