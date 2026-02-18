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
  variant?: "ghost" | "outline" | "default";
  size?: "icon" | "sm" | "default";
}

const CLIPBOARD_CLEAR_DELAY = 30_000; // 30 seconds

export function CopyButton({
  getValue,
  label,
  variant = "ghost",
  size = "icon",
}: CopyButtonProps) {
  const t = useTranslations("CopyButton");
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      const value = await getValue();
      await navigator.clipboard.writeText(value);
      setCopied(true);

      // Auto-clear clipboard after 30 seconds if content still matches
      const copiedValue = value;
      setTimeout(async () => {
        try {
          const current = await navigator.clipboard.readText();
          if (current === copiedValue) {
            await navigator.clipboard.writeText("");
          }
        } catch {
          // readText requires clipboard-read permission or page focus;
          // silently skip if unavailable
        }
      }, CLIPBOARD_CLEAR_DELAY);

      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access denied
    }
  }, [getValue]);

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant={variant} size={size} onClick={handleCopy}>
            {copied ? (
              <Check className="h-4 w-4 text-green-500" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
            {label && <span className="ml-1">{label}</span>}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {copied ? t("copied") : t("copy")}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
