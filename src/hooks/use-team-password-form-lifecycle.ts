"use client";

import { useCallback, useEffect, useRef } from "react";
import type { TeamPasswordFormEditData, TeamPasswordFormProps } from "@/components/team/team-password-form-types";
import type { TeamPasswordFormLifecycleSetters } from "@/hooks/use-team-password-form-state";
import {
  applyOrgEditDataToForm,
  resetOrgFormForClose,
} from "@/hooks/team-password-form-lifecycle-actions";

export interface TeamPasswordFormLifecycleArgs {
  open: TeamPasswordFormProps["open"];
  editData?: TeamPasswordFormProps["editData"];
  onOpenChange: TeamPasswordFormProps["onOpenChange"];
  setters: TeamPasswordFormLifecycleSetters;
}

export function useTeamPasswordFormLifecycle({
  open,
  editData,
  onOpenChange,
  setters,
}: TeamPasswordFormLifecycleArgs) {
  const settersRef = useRef(setters);

  useEffect(() => {
    settersRef.current = setters;
  }, [setters]);

  const applyEditData = useCallback((data: TeamPasswordFormEditData) => {
    applyOrgEditDataToForm(data, settersRef.current);
  }, []);

  const resetForm = useCallback(() => {
    resetOrgFormForClose(settersRef.current);
  }, []);

  useEffect(() => {
    if (open && editData) {
      applyEditData(editData);
    }
  }, [open, editData, applyEditData]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        resetForm();
      } else if (editData) {
        applyEditData(editData);
      }
      onOpenChange(nextOpen);
    },
    [applyEditData, editData, onOpenChange, resetForm],
  );

  return { handleOpenChange };
}
