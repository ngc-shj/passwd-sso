"use client";

import { useCallback, useEffect, useRef } from "react";
import type { OrgPasswordFormEditData, OrgPasswordFormProps } from "@/components/org/org-password-form-types";
import type { OrgPasswordFormLifecycleSetters } from "@/hooks/use-org-password-form-state";
import {
  applyOrgEditDataToForm,
  resetOrgFormForClose,
} from "@/hooks/org-password-form-lifecycle-actions";

export interface OrgPasswordFormLifecycleArgs {
  open: OrgPasswordFormProps["open"];
  editData?: OrgPasswordFormProps["editData"];
  onOpenChange: OrgPasswordFormProps["onOpenChange"];
  setters: OrgPasswordFormLifecycleSetters;
}

export function useOrgPasswordFormLifecycle({
  open,
  editData,
  onOpenChange,
  setters,
}: OrgPasswordFormLifecycleArgs) {
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
