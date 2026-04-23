"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { CopyButton } from "../copy-button";
import { SecureNoteMarkdown } from "../secure-note-markdown";
import type { InlineDetailData } from "@/types/entry";
import type { RequireVerificationFn } from "@/hooks/vault/use-reveal-timeout";
import type { CreateGuardedGetterFn } from "./types";

interface SectionProps {
  data: InlineDetailData;
  requireVerification: RequireVerificationFn;
  createGuardedGetter: CreateGuardedGetterFn;
}

export function SecureNoteSection({ data }: SectionProps) {
  const t = useTranslations("PasswordDetail");
  const [showMarkdownView, setShowMarkdownView] = useState(
    data.isMarkdown === true,
  );

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <label className="text-sm text-muted-foreground">{t("content")}</label>
        {data.isMarkdown && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => setShowMarkdownView((v) => !v)}
          >
            {showMarkdownView ? t("showSource") : t("showMarkdown")}
          </Button>
        )}
      </div>
      <div className="flex items-start gap-2">
        <div className="flex-1 max-h-96 overflow-y-auto rounded-lg border bg-muted/30 p-3 text-sm">
          {showMarkdownView ? (
            <SecureNoteMarkdown content={data.content ?? ""} />
          ) : (
            <p className="font-mono whitespace-pre-wrap">{data.content}</p>
          )}
        </div>
        <CopyButton getValue={() => data.content ?? ""} />
      </div>
    </div>
  );
}
