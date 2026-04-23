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
import { EntrySectionCard } from "@/components/passwords/entry/entry-form-ui";
import { FolderOpen } from "lucide-react";
import type { FolderLike } from "@/components/passwords/shared/folder-like";

interface EntryFolderSelectSectionProps {
  folders: FolderLike[];
  value: string | null;
  onChange: (next: string | null) => void;
  sectionCardClass?: string;
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

/** Flatten folders into tree order: parent always before children. */
function flattenFolderTree(folders: FolderLike[]): FolderLike[] {
  const childrenMap = new Map<string | null, FolderLike[]>();
  for (const f of folders) {
    const key = f.parentId ?? null;
    let list = childrenMap.get(key);
    if (!list) {
      list = [];
      childrenMap.set(key, list);
    }
    list.push(f);
  }
  const result: FolderLike[] = [];
  function walk(parentId: string | null) {
    const children = childrenMap.get(parentId);
    if (!children) return;
    for (const child of children) {
      result.push(child);
      walk(child.id);
    }
  }
  walk(null);
  if (result.length < folders.length) {
    const seen = new Set(result.map((f) => f.id));
    for (const f of folders) {
      if (!seen.has(f.id)) result.push(f);
    }
  }
  return result;
}

export function EntryFolderSelectSection({
  folders,
  value,
  onChange,
  sectionCardClass = "",
}: EntryFolderSelectSectionProps) {
  const t = useTranslations("PasswordForm");

  const sortedFolders = flattenFolderTree(folders);

  return (
    <EntrySectionCard className={sectionCardClass}>
      <div className="space-y-1">
        <Label className="flex items-center gap-2">
          <FolderOpen className="h-3.5 w-3.5" />
          {t("folder")}
        </Label>
        <p className="text-xs text-muted-foreground">{t("folderHint")}</p>
      </div>
      {folders.length === 0 ? (
        <p className="text-sm text-amber-600">{t("noFoldersYet")}</p>
      ) : (
        <Select
          value={value ?? "__none__"}
          onValueChange={(next) => onChange(next === "__none__" ? null : next)}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">{t("noFolder")}</SelectItem>
            {sortedFolders.map((folder) => (
              <SelectItem key={folder.id} value={folder.id}>
                {withIndent(folder, sortedFolders)}
                {folder.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </EntrySectionCard>
  );
}
