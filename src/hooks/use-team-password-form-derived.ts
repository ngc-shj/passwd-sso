"use client";

import { useMemo } from "react";
import type { TeamPasswordFormProps } from "@/components/team/team-password-form-types";
import type { TeamEntryKindState } from "@/components/team/team-entry-kind";
import type { TeamEntryFieldValues } from "@/hooks/use-team-password-form-state";
import type { EntryTypeValue } from "@/lib/constants";
import {
  buildBaselineSnapshot,
  buildCurrentSnapshot,
  buildTeamSubmitDisabled,
} from "@/hooks/team-password-form-derived-helpers";

export type TeamPasswordFormDerivedArgs = {
  effectiveEntryType: EntryTypeValue;
  editData?: TeamPasswordFormProps["editData"];
  entryKindState: TeamEntryKindState;
  entryValues: TeamEntryFieldValues;
  cardNumberValid: boolean;
};

export function useTeamPasswordFormDerived({
  effectiveEntryType,
  editData,
  entryKindState,
  entryValues,
  cardNumberValid,
}: TeamPasswordFormDerivedArgs) {
  const { isLoginEntry, isNote, isCreditCard, isIdentity, isPasskey } = entryKindState;

  const baselineSnapshot = useMemo(
    () =>
      buildBaselineSnapshot({
        effectiveEntryType,
        editData,
        entryKindState,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [effectiveEntryType, editData, isLoginEntry, isNote, isCreditCard, isIdentity, isPasskey],
  );

  const entryValuesKey = JSON.stringify(entryValues);
  const currentSnapshot = useMemo(
    () =>
      buildCurrentSnapshot({
        effectiveEntryType,
        entryKindState,
        entryValues,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [effectiveEntryType, isLoginEntry, isNote, isCreditCard, isIdentity, isPasskey, entryValuesKey],
  );

  const hasChanges = currentSnapshot !== baselineSnapshot;
  const submitDisabled = buildTeamSubmitDisabled({ entryKindState, entryValues, cardNumberValid });

  return { hasChanges, submitDisabled };
}
