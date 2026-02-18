"use client";

import { useTranslations } from "next-intl";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EntrySectionCard } from "@/components/passwords/entry-form-ui";
import { FolderOpen } from "lucide-react";

interface FolderLike {
  id: string;
  name: string;
  parentId: string | null;
}

interface EntryFolderSelectSectionProps {
  folders: FolderLike[];
  value: string | null;
  onChange: (next: string | null) => void;
}

function withIndent(folder: FolderLike, folders: FolderLike[]): string {
  let depth = 0;
  let current: FolderLike | undefined = folder;
  while (current?.parentId) {
    depth += 1;
    current = folders.find((f) => f.id === current?.parentId);
  }
  return depth > 0 ? "\u00A0\u00A0".repeat(depth) + "└ " : "";
}

export function EntryFolderSelectSection({
  folders,
  value,
  onChange,
}: EntryFolderSelectSectionProps) {
  const t = useTranslations("PasswordForm");

  if (folders.length === 0) return null;

  return (
    <EntrySectionCard>
      <div className="space-y-1">
        <Label className="flex items-center gap-2">
          <FolderOpen className="h-3.5 w-3.5" />
          {t("folder")}
        </Label>
        <p className="text-xs text-muted-foreground">{t("folderHint")}</p>
      </div>
      <Select
        value={value ?? "__none__"}
        onValueChange={(next) => onChange(next === "__none__" ? null : next)}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__">{t("noFolder")}</SelectItem>
          {folders.map((folder) => (
            <SelectItem key={folder.id} value={folder.id}>
              {withIndent(folder, folders)}
              {folder.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </EntrySectionCard>
  );
}

