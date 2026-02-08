"use client";

import { useState, useCallback } from "react";
import { useTranslations, useLocale } from "next-intl";

import { Button } from "@/components/ui/button";
import { CopyButton } from "./copy-button";
import { Favicon } from "./favicon";
import { TOTPField, type TOTPEntry } from "./totp-field";
import {
  Edit,
  Eye,
  EyeOff,
  History,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

interface PasswordHistoryEntry {
  password: string;
  changedAt: string;
}

type CustomFieldType = "text" | "hidden" | "url";

interface CustomField {
  label: string;
  value: string;
  type: CustomFieldType;
}

export interface InlineDetailData {
  id: string;
  password: string;
  url: string | null;
  urlHost: string | null;
  notes: string | null;
  customFields: CustomField[];
  passwordHistory: PasswordHistoryEntry[];
  totp?: TOTPEntry;
  createdAt: string;
  updatedAt: string;
}

interface PasswordDetailInlineProps {
  data: InlineDetailData;
  onEdit: () => void;
}

const REVEAL_TIMEOUT = 30_000;

export function PasswordDetailInline({ data, onEdit }: PasswordDetailInlineProps) {
  const t = useTranslations("PasswordDetail");
  const tc = useTranslations("Common");
  const locale = useLocale();
  const [showPassword, setShowPassword] = useState(false);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [revealedHistory, setRevealedHistory] = useState<Set<number>>(
    new Set()
  );
  const [revealedFields, setRevealedFields] = useState<Set<number>>(
    new Set()
  );

  const handleReveal = useCallback(() => {
    setShowPassword(true);
    setTimeout(() => setShowPassword(false), REVEAL_TIMEOUT);
  }, []);

  return (
    <div className="space-y-4 border-t pt-4 px-4 pb-4">
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
            onClick={showPassword ? () => setShowPassword(false) : handleReveal}
          >
            {showPassword ? (
              <EyeOff className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
          </Button>
          <CopyButton getValue={() => data.password} />
        </div>
        {showPassword && (
          <p className="text-xs text-muted-foreground">{t("autoHide")}</p>
        )}
      </div>

      {/* TOTP */}
      {data.totp && <TOTPField mode="display" totp={data.totp} />}

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
          <p className="text-sm whitespace-pre-wrap rounded-md bg-muted p-3">
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
              {field.type === "url" ? (
                <a
                  href={field.value}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-blue-600 hover:underline"
                >
                  {field.value}
                </a>
              ) : field.type === "hidden" ? (
                <>
                  <span className="font-mono text-sm">
                    {revealedFields.has(idx) ? field.value : "••••••••••••"}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() =>
                      setRevealedFields((prev) => {
                        const next = new Set(prev);
                        if (next.has(idx)) next.delete(idx);
                        else next.add(idx);
                        return next;
                      })
                    }
                  >
                    {revealedFields.has(idx) ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </Button>
                </>
              ) : (
                <span className="text-sm">{field.value}</span>
              )}
              <CopyButton getValue={() => field.value} />
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
                  className="flex items-center gap-2 rounded-md bg-muted p-2"
                >
                  <div className="flex-1 min-w-0">
                    <span className="font-mono text-xs">
                      {revealedHistory.has(idx)
                        ? entry.password
                        : "••••••••••••"}
                    </span>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {new Date(entry.changedAt).toLocaleString(
                        locale === "ja" ? "ja-JP" : "en-US"
                      )}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    onClick={() => {
                      setRevealedHistory((prev) => {
                        const next = new Set(prev);
                        if (next.has(idx)) next.delete(idx);
                        else next.add(idx);
                        return next;
                      });
                    }}
                  >
                    {revealedHistory.has(idx) ? (
                      <EyeOff className="h-3.5 w-3.5" />
                    ) : (
                      <Eye className="h-3.5 w-3.5" />
                    )}
                  </Button>
                  <CopyButton getValue={() => entry.password} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Timestamps + Edit */}
      <div className="flex items-center justify-between pt-2">
        <div className="text-xs text-muted-foreground">
          <p>
            {t("created")}:{" "}
            {new Date(data.createdAt).toLocaleString(
              locale === "ja" ? "ja-JP" : "en-US"
            )}
          </p>
          <p>
            {t("updated")}:{" "}
            {new Date(data.updatedAt).toLocaleString(
              locale === "ja" ? "ja-JP" : "en-US"
            )}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onEdit}>
          <Edit className="h-4 w-4 mr-1" />
          {tc("edit")}
        </Button>
      </div>
    </div>
  );
}
