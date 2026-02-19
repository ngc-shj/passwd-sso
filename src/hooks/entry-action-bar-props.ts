"use client";

import type { ComponentProps } from "react";
import { EntryActionBar } from "@/components/passwords/entry-form-ui";

type EntryActionBarProps = ComponentProps<typeof EntryActionBar>;

interface BuildEntryActionBarPropsArgs {
  hasChanges: boolean;
  submitting: boolean;
  submitDisabled?: boolean;
  saveLabel: string;
  cancelLabel: string;
  statusUnsavedLabel: string;
  statusSavedLabel: string;
  onCancel: () => void;
}

export function buildEntryActionBarProps({
  hasChanges,
  submitting,
  submitDisabled = false,
  saveLabel,
  cancelLabel,
  statusUnsavedLabel,
  statusSavedLabel,
  onCancel,
}: BuildEntryActionBarPropsArgs): EntryActionBarProps {
  return {
    hasChanges,
    submitting,
    submitDisabled,
    saveLabel,
    cancelLabel,
    statusUnsavedLabel,
    statusSavedLabel,
    onCancel,
  };
}
