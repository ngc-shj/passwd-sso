"use client";

import { useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Copy, Check } from "lucide-react";

interface CopyButtonProps {
  getValue: () => Promise<string> | string;
  label?: string;
  /** Accessible name for the icon-only button (WCAG 4.1.2). Defaults to the copy/copied label. */
  ariaLabel?: string;
  /**
   * Name of the field being copied. When set (and no explicit ariaLabel), the
   * accessible name AND tooltip become "Copy {fieldLabel}" so the user knows WHAT
   * lands on the clipboard — instead of a generic "Copy". Pass the same label text
   * shown next to the value.
   */
  fieldLabel?: string;
  variant?: "ghost" | "outline" | "default";
  size?: "icon" | "sm" | "default";
  className?: string;
  tabIndex?: number;
}

import { CLIPBOARD_CLEAR_SECONDS } from "@/lib/constants";
import { MS_PER_SECOND } from "@/lib/constants/time";
import { COPY_OUTCOME, copySecretToClipboard } from "@/lib/clipboard/copy-secret";
import { reportCopyOutcome } from "@/lib/clipboard/report-copy-outcome";

export function CopyButton({
  getValue,
  label,
  ariaLabel,
  fieldLabel,
  variant = "ghost",
  size = "icon",
  className,
  tabIndex,
}: CopyButtonProps) {
  const t = useTranslations("CopyButton");
  const [copied, setCopied] = useState(false);

  // Precedence: explicit ariaLabel > field-named ("Copy {field}") > generic "Copy".
  // After a copy, both the accessible name and the tooltip announce "Copied".
  const idleLabel = ariaLabel ?? (fieldLabel ? t("copyNamed", { name: fieldLabel }) : t("copy"));
  const stateLabel = copied
    ? t("copied", { seconds: CLIPBOARD_CLEAR_SECONDS })
    : idleLabel;

  const handleCopy = useCallback(async () => {
    const outcome = await copySecretToClipboard(getValue);

    // The checkmark is entered ONLY on OK. Previously a copy of an empty value
    // wrote "" successfully and showed the check, telling the user something had
    // been copied when nothing had.
    if (outcome === COPY_OUTCOME.OK) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2 * MS_PER_SECOND);
    }

    reportCopyOutcome(outcome, { tCopy: t });
  }, [getValue, t]);

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={variant}
            size={size}
            onClick={handleCopy}
            className={className}
            tabIndex={tabIndex}
            aria-label={label ? undefined : stateLabel}
          >
            {copied ? (
              <Check className="h-4 w-4 text-green-500" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
            {label && <span className="ml-1">{label}</span>}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {stateLabel}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
