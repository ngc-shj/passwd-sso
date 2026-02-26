"use client";

import { useMemo } from "react";
import type { OrgPasswordFormProps } from "@/components/team/team-password-form-types";
import type { OrgEntryKindState } from "@/components/team/team-entry-kind";
import type { OrgEntryFieldValues } from "@/hooks/use-org-password-form-state";
import type { EntryTypeValue } from "@/lib/constants";
import {
  buildBaselineSnapshot,
  buildCurrentSnapshot,
  buildOrgSubmitDisabled,
} from "@/hooks/org-password-form-derived-helpers";

export type OrgPasswordFormDerivedArgs = {
  effectiveEntryType: EntryTypeValue;
  editData?: OrgPasswordFormProps["editData"];
  entryKindState: OrgEntryKindState;
  entryValues: OrgEntryFieldValues;
  cardNumberValid: boolean;
};

export function useOrgPasswordFormDerived({
  effectiveEntryType,
  editData,
  entryKindState,
  entryValues,
  cardNumberValid,
}: OrgPasswordFormDerivedArgs) {
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
  const submitDisabled = buildOrgSubmitDisabled({ entryKindState, entryValues, cardNumberValid });

  return { hasChanges, submitDisabled };
}
