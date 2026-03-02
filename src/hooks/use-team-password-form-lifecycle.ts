"use client";

import { useCallback, useEffect, useRef } from "react";
import type { TeamPasswordFormEditData, TeamPasswordFormProps } from "@/components/team/team-password-form-types";
import type { TeamPasswordFormLifecycleSetters } from "@/hooks/use-team-password-form-state";
import type { TeamTagData } from "@/components/team/team-tag-input";
import {
  applyTeamEditDataToForm,
  resetTeamFormForClose,
} from "@/hooks/team-password-form-lifecycle-actions";

export interface TeamPasswordFormLifecycleArgs {
  open: TeamPasswordFormProps["open"];
  editData?: TeamPasswordFormProps["editData"];
  onOpenChange: TeamPasswordFormProps["onOpenChange"];
  setters: TeamPasswordFormLifecycleSetters;
  defaults?: { defaultFolderId?: string | null; defaultTags?: TeamTagData[] };
}

export function useTeamPasswordFormLifecycle({
  open,
  editData,
  onOpenChange,
  setters,
  defaults,
}: TeamPasswordFormLifecycleArgs) {
  const settersRef = useRef(setters);

  useEffect(() => {
    settersRef.current = setters;
  }, [setters]);

  const applyEditData = useCallback((data: TeamPasswordFormEditData) => {
    applyTeamEditDataToForm(data, settersRef.current);
  }, []);

  const resetForm = useCallback(() => {
    resetTeamFormForClose(settersRef.current);
  }, []);

  const applyDefaults = useCallback(() => {
    if (defaults?.defaultFolderId != null) {
      settersRef.current.setTeamFolderId(defaults.defaultFolderId);
    }
    if (defaults?.defaultTags && defaults.defaultTags.length > 0) {
      settersRef.current.setSelectedTags(defaults.defaultTags);
    }
  }, [defaults]);

  useEffect(() => {
    if (open && editData) {
      applyEditData(editData);
    } else if (open) {
      applyDefaults();
    }
  }, [open, editData, applyEditData, applyDefaults]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        resetForm();
      } else if (editData) {
        applyEditData(editData);
      } else {
        applyDefaults();
      }
      onOpenChange(nextOpen);
    },
    [applyDefaults, applyEditData, editData, onOpenChange, resetForm],
  );

  return { handleOpenChange };
}
