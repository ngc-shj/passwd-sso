"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { TEAM_ROLE, apiPath } from "@/lib/constants";
import { fetchApi } from "@/lib/url-helpers";
import { notifyTeamDataChanged } from "@/lib/events";
import { useFormDirty } from "@/hooks/form/use-form-dirty";
import { useBeforeUnloadGuard } from "@/hooks/form/use-before-unload-guard";

export interface TeamInfo {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  role: string;
}

/** Load a team's name/description and save edits back to it. */
export function useTeamProfileForm(teamId: string) {
  const t = useTranslations("Team");

  const [team, setTeam] = useState<TeamInfo | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [prevTeamId, setPrevTeamId] = useState(teamId);
  if (teamId !== prevTeamId) {
    setPrevTeamId(teamId);
    setTeam(null);
    setLoadError(false);
  }
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [initialGeneral, setInitialGeneral] = useState<Record<string, unknown> | null>(null);

  const currentGeneral = useMemo(() => ({ name, description }), [name, description]);
  const hasChanges = useFormDirty(currentGeneral, initialGeneral);
  useBeforeUnloadGuard(hasChanges);

  const fetchTeam = useCallback(() => {
    void (async () => {
      try {
        const res = await fetchApi(apiPath.teamById(teamId));
        if (!res.ok) throw new Error("Forbidden");
        const d = await res.json();
        const desc = d.description ?? "";
        setTeam(d);
        setName(d.name);
        setDescription(desc);
        setInitialGeneral({ name: d.name, description: desc });
        setLoadError(false);
      } catch {
        setTeam(null);
        setLoadError(true);
      }
    })();
  }, [teamId]);

  useEffect(() => {
    fetchTeam();
  }, [fetchTeam]);

  const isOwner = team?.role === TEAM_ROLE.OWNER;
  const isAdmin = team?.role === TEAM_ROLE.ADMIN || isOwner;

  const handleUpdateTeam = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const res = await fetchApi(apiPath.teamById(teamId), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), description: description.trim() }),
      });
      if (res.status === 400) {
        toast.error(t("validationError"));
        setSaving(false);
        return;
      }
      if (!res.ok) throw new Error("Failed");
      toast.success(t("updated"));
      setInitialGeneral({ ...currentGeneral });
      notifyTeamDataChanged();
      fetchTeam();
    } catch {
      toast.error(t("updateFailed"));
    } finally {
      setSaving(false);
    }
  };

  return {
    team,
    loadError,
    isAdmin,
    name,
    setName,
    description,
    setDescription,
    saving,
    hasChanges,
    handleUpdateTeam,
  };
}
