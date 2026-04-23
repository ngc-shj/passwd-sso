"use client";

import { useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Eye, EyeOff, History, ChevronDown, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CopyButton } from "../copy-button";
import { Favicon } from "../favicon";
import { TOTPField } from "../totp-field";
import { useRevealTimeout, useRevealSet } from "@/hooks/use-reveal-timeout";
import type { RequireVerificationFn } from "@/hooks/use-reveal-timeout";
import { CUSTOM_FIELD_TYPE } from "@/lib/constants";
import { formatDateTime, formatDate } from "@/lib/format/format-datetime";
import type { InlineDetailData } from "@/types/entry";
import type { CreateGuardedGetterFn } from "./types";

interface SectionProps {
  data: InlineDetailData;
  requireVerification: RequireVerificationFn;
  createGuardedGetter: CreateGuardedGetterFn;
}

export function LoginSection({ data, requireVerification, createGuardedGetter }: SectionProps) {
  const t = useTranslations("PasswordDetail");
  const tc = useTranslations("Common");
  const locale = useLocale();

  const [historyExpanded, setHistoryExpanded] = useState(false);

  const { revealed: showPassword, handleReveal, hide: hidePassword } =
    useRevealTimeout(requireVerification, data.id, data.requireReprompt ?? false);

  const { isRevealed: isHistoryRevealed, handleRevealIndex: handleRevealHistoryIndex } =
    useRevealSet(requireVerification, data.id, data.requireReprompt ?? false);

  const { isRevealed: isFieldRevealed, handleRevealIndex: handleRevealFieldIndex } =
    useRevealSet(requireVerification, data.id, data.requireReprompt ?? false);

  return (
    <>
      {/* Password */}
      <div className="space-y-1">
        <label className="text-sm text-muted-foreground">{t("password")}</label>
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm">
            {showPassword ? data.password : "••••••••••••"}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={showPassword ? hidePassword : handleReveal}
          >
            {showPassword ? (
              <EyeOff className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
          </Button>
          <CopyButton
            getValue={createGuardedGetter(
              data.id,
              data.requireReprompt ?? false,
              () => data.password,
            )}
          />
        </div>
        {showPassword && (
          <p className="text-xs text-muted-foreground">{t("autoHide")}</p>
        )}
      </div>

      {/* TOTP */}
      {data.totp && (
        <TOTPField
          mode="display"
          totp={data.totp}
          wrapCopyGetter={(getter) =>
            createGuardedGetter(data.id, data.requireReprompt ?? false, getter)
          }
        />
      )}

      {/* URL */}
      {data.url && (
        <div className="space-y-1">
          <label className="text-sm text-muted-foreground flex items-center gap-1">
            <Favicon host={data.urlHost} size={12} className="shrink-0" /> {t("url")}
          </label>
          <div className="flex items-center gap-2">
            <a
              href={data.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-blue-600 hover:underline"
            >
              {data.url}
            </a>
            <CopyButton getValue={() => data.url!} />
          </div>
        </div>
      )}

      {/* Notes */}
      {data.notes && (
        <div className="space-y-1">
          <label className="text-sm text-muted-foreground">{t("notes")}</label>
          <p className="rounded-lg border bg-muted/30 p-3 text-sm whitespace-pre-wrap">
            {data.notes}
          </p>
        </div>
      )}

      {/* Custom Fields */}
      {data.customFields.length > 0 &&
        data.customFields.map((field, idx) => (
          <div key={idx} className="space-y-1">
            <label className="text-sm text-muted-foreground">
              {field.label}
            </label>
            <div className="flex items-center gap-2">
              {field.type === CUSTOM_FIELD_TYPE.URL ? (
                <a
                  href={field.value}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-blue-600 hover:underline"
                >
                  {field.value}
                </a>
              ) : field.type === CUSTOM_FIELD_TYPE.HIDDEN ? (
                <>
                  <span className="font-mono text-sm">
                    {isFieldRevealed(idx) ? field.value : "••••••••••••"}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => handleRevealFieldIndex(idx)}
                  >
                    {isFieldRevealed(idx) ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </Button>
                </>
              ) : field.type === CUSTOM_FIELD_TYPE.BOOLEAN ? (
                <span className="text-sm">
                  {field.value === "true" ? tc("yes") : tc("no")}
                </span>
              ) : field.type === CUSTOM_FIELD_TYPE.DATE ? (
                <span className="text-sm">
                  {field.value ? formatDate(field.value, locale) : field.value}
                </span>
              ) : field.type === CUSTOM_FIELD_TYPE.MONTH_YEAR ? (
                <span className="text-sm">
                  {field.value}
                </span>
              ) : (
                <span className="text-sm">{field.value}</span>
              )}
              {field.type !== CUSTOM_FIELD_TYPE.BOOLEAN && (
              <CopyButton
                getValue={
                  field.type === CUSTOM_FIELD_TYPE.HIDDEN
                    ? createGuardedGetter(
                        data.id,
                        data.requireReprompt ?? false,
                        () => field.value,
                      )
                    : () => Promise.resolve(field.value)
                }
              />
              )}
            </div>
          </div>
        ))}

      {/* Password History */}
      {data.passwordHistory.length > 0 && (
        <div className="space-y-1">
          <button
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setHistoryExpanded(!historyExpanded)}
          >
            {historyExpanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            <History className="h-3 w-3" />
            {t("passwordHistory")} ({data.passwordHistory.length})
          </button>
          {historyExpanded && (
            <div className="space-y-2 pl-5 pt-1">
              {data.passwordHistory.map((entry, idx) => (
                <div
                  key={idx}
                  className="flex items-center gap-2 rounded-lg border bg-muted/30 p-2"
                >
                  <div className="flex-1 min-w-0">
                    <span className="font-mono text-xs">
                      {isHistoryRevealed(idx)
                        ? entry.password
                        : "••••••••••••"}
                    </span>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {formatDateTime(entry.changedAt, locale)}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    onClick={() => handleRevealHistoryIndex(idx)}
                  >
                    {isHistoryRevealed(idx) ? (
                      <EyeOff className="h-3.5 w-3.5" />
                    ) : (
                      <Eye className="h-3.5 w-3.5" />
                    )}
                  </Button>
                  <CopyButton
                    getValue={createGuardedGetter(
                      data.id,
                      data.requireReprompt ?? false,
                      () => entry.password,
                    )}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}
