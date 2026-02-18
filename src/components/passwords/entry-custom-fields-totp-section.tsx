"use client";

import type { Dispatch, SetStateAction } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EntrySectionCard } from "@/components/passwords/entry-form-ui";
import { TOTPField, type TOTPEntry } from "@/components/passwords/totp-field";
import { CUSTOM_FIELD_TYPE } from "@/lib/constants";
import type { CustomFieldType } from "@/lib/constants";
import { Plus, Rows3, ShieldCheck, X } from "lucide-react";

interface CustomFieldLike {
  label: string;
  value: string;
  type: CustomFieldType;
}

interface EntryCustomFieldsTotpSectionProps {
  customFields: CustomFieldLike[];
  setCustomFields: Dispatch<SetStateAction<CustomFieldLike[]>>;
  totp: TOTPEntry | null;
  onTotpChange: (value: TOTPEntry | null) => void;
  showTotpInput: boolean;
  setShowTotpInput: (show: boolean) => void;
}

export function EntryCustomFieldsTotpSection({
  customFields,
  setCustomFields,
  totp,
  onTotpChange,
  showTotpInput,
  setShowTotpInput,
}: EntryCustomFieldsTotpSectionProps) {
  const t = useTranslations("PasswordForm");

  return (
    <>
      <EntrySectionCard>
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <Label className="flex items-center gap-2">
              <Rows3 className="h-3.5 w-3.5" />
              {t("customFields")}
            </Label>
            <p className="text-xs text-muted-foreground">{t("customFieldsHint")}</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={() =>
              setCustomFields((prev) => [
                ...prev,
                { label: "", value: "", type: CUSTOM_FIELD_TYPE.TEXT },
              ])
            }
          >
            <Plus className="h-3 w-3" />
            {t("addField")}
          </Button>
        </div>
        {customFields.map((field, idx) => (
          <div key={idx} className="flex items-start gap-2 rounded-lg border p-2">
            <div className="flex-1 space-y-2">
              <div className="flex gap-2">
                <Input
                  value={field.label}
                  onChange={(e) =>
                    setCustomFields((prev) =>
                      prev.map((f, i) =>
                        i === idx ? { ...f, label: e.target.value } : f
                      )
                    )
                  }
                  placeholder={t("fieldLabel")}
                  className="h-8 text-sm"
                />
                <Select
                  value={field.type}
                  onValueChange={(v: CustomFieldType) =>
                    setCustomFields((prev) =>
                      prev.map((f, i) => (i === idx ? { ...f, type: v } : f))
                    )
                  }
                >
                  <SelectTrigger className="h-8 w-28 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={CUSTOM_FIELD_TYPE.TEXT}>
                      {t("fieldText")}
                    </SelectItem>
                    <SelectItem value={CUSTOM_FIELD_TYPE.HIDDEN}>
                      {t("fieldHidden")}
                    </SelectItem>
                    <SelectItem value={CUSTOM_FIELD_TYPE.URL}>
                      {t("fieldUrl")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Input
                type={
                  field.type === CUSTOM_FIELD_TYPE.HIDDEN
                    ? "password"
                    : field.type === CUSTOM_FIELD_TYPE.URL
                      ? "url"
                      : "text"
                }
                value={field.value}
                onChange={(e) =>
                  setCustomFields((prev) =>
                    prev.map((f, i) =>
                      i === idx ? { ...f, value: e.target.value } : f
                    )
                  )
                }
                placeholder={t("fieldValue")}
                className="h-8 text-sm"
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
              onClick={() =>
                setCustomFields((prev) => prev.filter((_, i) => i !== idx))
              }
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
      </EntrySectionCard>

      <EntrySectionCard>
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <Label className="flex items-center gap-1">
              <ShieldCheck className="h-3.5 w-3.5" />
              {t("totp")}
            </Label>
            <p className="text-xs text-muted-foreground">{t("totpHint")}</p>
          </div>
          {!showTotpInput && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1 text-xs"
              onClick={() => setShowTotpInput(true)}
            >
              <Plus className="h-3 w-3" />
              {t("addTotp")}
            </Button>
          )}
        </div>
        {showTotpInput && (
          <TOTPField
            mode="input"
            totp={totp}
            onChange={onTotpChange}
            onRemove={() => setShowTotpInput(false)}
          />
        )}
      </EntrySectionCard>
    </>
  );
}
