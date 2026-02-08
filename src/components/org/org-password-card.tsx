"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MoreHorizontal, Copy, ExternalLink, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";

interface OrgPasswordCardProps {
  entry: {
    id: string;
    title: string;
    username: string | null;
    urlHost: string | null;
    createdBy: { id: string; name: string | null; image: string | null };
    updatedAt: string;
  };
  orgId: string;
  canEdit: boolean;
  canDelete: boolean;
  onClick: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

export function OrgPasswordCard({
  entry,
  canEdit,
  canDelete,
  onClick,
  onEdit,
  onDelete,
}: OrgPasswordCardProps) {
  const t = useTranslations("Org");

  const copyUsername = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (entry.username) {
      await navigator.clipboard.writeText(entry.username);
      toast.success("Copied!");
    }
  };

  return (
    <div
      className="flex items-center gap-3 rounded-lg border p-3 cursor-pointer hover:bg-muted/50 transition-colors"
      onClick={onClick}
    >
      {/* Favicon placeholder */}
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted text-sm font-medium">
        {entry.title.charAt(0).toUpperCase()}
      </div>

      <div className="flex-1 min-w-0">
        <p className="font-medium truncate">{entry.title}</p>
        <p className="text-sm text-muted-foreground truncate">
          {entry.username || "\u00A0"}
        </p>
        {entry.urlHost && (
          <p className="text-xs text-muted-foreground truncate">
            {entry.urlHost}
          </p>
        )}
      </div>

      <div className="flex items-center gap-1">
        {entry.username && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={copyUsername}
            title={t("createdBy", { name: entry.createdBy.name ?? "" })}
          >
            <Copy className="h-4 w-4" />
          </Button>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {entry.urlHost && (
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  window.open(`https://${entry.urlHost}`, "_blank");
                }}
              >
                <ExternalLink className="h-4 w-4 mr-2" />
                URL
              </DropdownMenuItem>
            )}
            {canEdit && (
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit();
                }}
              >
                <Pencil className="h-4 w-4 mr-2" />
                {t("settings")}
              </DropdownMenuItem>
            )}
            {canDelete && (
              <DropdownMenuItem
                className="text-destructive"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete();
                }}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                {t("removeMember")}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
