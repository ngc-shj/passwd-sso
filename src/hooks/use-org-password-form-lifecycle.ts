"use client";

import { useCallback, useEffect, useRef } from "react";
import {
  applyOrgEditDataToForm,
  resetOrgFormForClose,
  type OrgPasswordFormSetters,
} from "@/components/org/org-password-form-state";
import type { OrgPasswordFormEditData } from "@/components/org/org-password-form-types";

interface UseOrgPasswordFormLifecycleArgs {
  open: boolean;
  editData?: OrgPasswordFormEditData | null;
  onOpenChange: (open: boolean) => void;
  setters: OrgPasswordFormSetters;
}

export function useOrgPasswordFormLifecycle({
  open,
  editData,
  onOpenChange,
  setters,
}: UseOrgPasswordFormLifecycleArgs) {
  const settersRef = useRef(setters);

  useEffect(() => {
    settersRef.current = setters;
  }, [setters]);

  const applyEditData = useCallback((data: OrgPasswordFormEditData) => {
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
