"use client";

import { EntryCustomFieldsTotpSection } from "@/components/passwords/entry/entry-custom-fields-totp-section";
import { EntryRepromptSection } from "@/components/passwords/entry/entry-reprompt-section";
import { EntryTravelSafeSection } from "@/components/passwords/entry/entry-travel-safe-section";
import { EntryExpirationSection } from "@/components/passwords/entry/entry-expiration-section";
import { EntryTagsAndFolderSection } from "@/components/passwords/entry/entry-tags-and-folder-section";
import {
  EntryActionBar,
  EntrySectionCard,
  ENTRY_DIALOG_FLAT_SECTION_CLASS,
} from "@/components/passwords/entry/entry-form-ui";
import { EntryLoginMainFields } from "@/components/passwords/entry/entry-login-main-fields";
import { preventIMESubmit } from "@/lib/ime-guard";
import type { PersonalLoginFormProps } from "@/components/passwords/personal/personal-login-form-types";
import { usePersonalLoginFormModel } from "@/hooks/personal/use-personal-login-form-model";
import { buildPersonalFormSectionsProps } from "@/hooks/personal/personal-form-sections-props";
import { useBeforeUnloadGuard } from "@/hooks/form/use-before-unload-guard";
import { ArrowLeft, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useTranslations } from "next-intl";

export function PersonalLoginForm({ mode, initialData, variant = "page", onSaved, onCancel, defaultFolderId, defaultTags }: PersonalLoginFormProps) {
  const tGen = useTranslations("PasswordGenerator");
  const {
    t,
    tc,
    ttm,
    formState,
    folders,
    hasChanges,
    loginMainFieldsProps,
    policyViolations,
    policyBlocked,
    handleSubmit,
    handleCancel,
    handleBack,
  } = usePersonalLoginFormModel({
    mode,
    initialData,
    variant,
    onSaved,
    onCancel,
    defaultFolderId,
    defaultTags,
  });
  const { values, setters } = formState;
  const isDialogVariant = variant === "dialog";
  useBeforeUnloadGuard(!isDialogVariant && hasChanges);
  const dialogSectionClass = isDialogVariant ? ENTRY_DIALOG_FLAT_SECTION_CLASS : "";
  const submitDisabled = !values.title.trim() || !values.password || policyBlocked;
  const {
    tagsAndFolderProps,
    customFieldsTotpProps,
    repromptSectionProps,
    travelSafeSectionProps,
    expirationSectionProps,
    actionBarProps,
  } = buildPersonalFormSectionsProps({
    tagsTitle: t("tags"),
    tagsHint: t("tagsHint"),
    folders,
    sectionCardClass: dialogSectionClass,
    repromptTitle: t("requireReprompt"),
    repromptDescription: t("requireRepromptHelp"),
    travelSafeTitle: ttm("travelSafe"),
    travelSafeDescription: ttm("travelSafeDescription"),
    expirationTitle: t("expirationTitle"),
    expirationDescription: t("expirationDescription"),
    hasChanges,
    submitting: values.submitting,
    submitDisabled,
    saveLabel: mode === "create" ? tc("save") : tc("update"),
    cancelLabel: tc("cancel"),
    statusUnsavedLabel: t("statusUnsaved"),
    statusSavedLabel: t("statusSaved"),
    onCancel: handleCancel,
    values,
    setters,
  });

  const loginMainFields = (
    <EntryLoginMainFields {...loginMainFieldsProps} />
  );

  const formContent = (
    <form onSubmit={handleSubmit} onKeyDown={preventIMESubmit} className="space-y-5">
      {isDialogVariant ? (
        loginMainFields
      ) : (
        <EntrySectionCard className="space-y-4 bg-gradient-to-b from-muted/30 to-background hover:bg-transparent">
          {loginMainFields}
        </EntrySectionCard>
      )}

      <EntryTagsAndFolderSection {...tagsAndFolderProps} />

      <EntryCustomFieldsTotpSection {...customFieldsTotpProps} />

      <EntryRepromptSection {...repromptSectionProps} />

      <EntryTravelSafeSection {...travelSafeSectionProps} />

      <EntryExpirationSection {...expirationSectionProps} />

      {policyViolations.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2">
          <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
          <p className="text-xs text-amber-700 dark:text-amber-300">
            {tGen("policyWarning")}:{" "}
            {policyViolations.map((v) =>
              v.key === "policyMinLength"
                ? tGen("policyMinLength", { min: v.min })
                : tGen(v.key),
            ).join(", ")}
          </p>
        </div>
      )}

      <EntryActionBar {...actionBarProps} />
    </form>
  );

  if (variant === "dialog") {
    return formContent;
  }

  return (
    <div className="flex-1 overflow-auto p-4 md:p-6">
      <div className="mx-auto max-w-4xl space-y-4">
        <Button variant="ghost" className="mb-4 gap-2" onClick={handleBack}>
          <ArrowLeft className="h-4 w-4" />
          {tc("back")}
        </Button>

        <Card className="rounded-xl border">
          <CardHeader>
            <CardTitle>
              {mode === "create" ? t("newPassword") : t("editPassword")}
            </CardTitle>
          </CardHeader>
          <CardContent>{formContent}</CardContent>
        </Card>
      </div>
    </div>
  );
}
