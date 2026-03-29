"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Download, Loader2 } from "lucide-react";

interface AuditDownloadButtonProps {
  downloading: boolean;
  onDownload: (format: "jsonl" | "csv") => void;
  exportAllowed?: boolean;
}

export function AuditDownloadButton({
  downloading,
  onDownload,
  exportAllowed = true,
}: AuditDownloadButtonProps) {
  const td = useTranslations("AuditDownload");

  if (!exportAllowed) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0}>
              <Button variant="outline" size="sm" disabled>
                <Download className="h-4 w-4 mr-2" />
                {td("download")}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            <p>{td("exportDisabled")}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={downloading}>
          {downloading ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Download className="h-4 w-4 mr-2" />
          )}
          {downloading ? td("downloading") : td("download")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onDownload("csv")}>
          {td("formatCsv")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onDownload("jsonl")}>
          {td("formatJsonl")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
