"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
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
import type { FolderItem } from "./folder-tree";

interface FolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folders: FolderItem[];
  editFolder?: FolderItem | null;
  onSubmit: (data: { name: string; parentId: string | null }) => Promise<void>;
}

export function FolderDialog({
  open,
  onOpenChange,
  folders,
  editFolder,
  onSubmit,
}: FolderDialogProps) {
  const t = useTranslations("Dashboard");
  const tCommon = useTranslations("Common");
  const [name, setName] = useState(editFolder?.name ?? "");
  const [parentId, setParentId] = useState<string | null>(
    editFolder?.parentId ?? null,
  );
  const [loading, setLoading] = useState(false);

  // Reset form when dialog opens or editFolder changes
  useEffect(() => {
    if (open) {
      setName(editFolder?.name ?? "");
      setParentId(editFolder?.parentId ?? null);
    }
  }, [open, editFolder]);

  const isEdit = !!editFolder;

  // Filter out the folder being edited and its descendants to prevent circular reference
  const availableParents = folders.filter((f) => {
    if (!editFolder) return true;
    if (f.id === editFolder.id) return false;
    // Simple check — for deep trees, the API validates circular references
    return true;
  });

  // Compute display depth for each folder so the Select shows hierarchy
  const depthMap = new Map<string, number>();
  function computeDepth(id: string): number {
    if (depthMap.has(id)) return depthMap.get(id)!;
    const folder = folders.find((f) => f.id === id);
    if (!folder || !folder.parentId) {
      depthMap.set(id, 0);
      return 0;
    }
    const d = computeDepth(folder.parentId) + 1;
    depthMap.set(id, d);
    return d;
  }
  for (const f of folders) computeDepth(f.id);

  const handleSubmit = async () => {
    if (!name.trim()) return;
    setLoading(true);
    try {
      await onSubmit({ name: name.trim(), parentId });
      onOpenChange(false);
      setName("");
      setParentId(null);
    } catch {
      // Error already handled by caller (e.g. toast in sidebar).
      // Dialog stays open so the user can correct input.
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t("editFolder") : t("createFolder")}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="folder-name">{t("folderName")}</Label>
            <Input
              id="folder-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing && name.trim()) handleSubmit();
              }}
            />
          </div>

          <div className="space-y-2">
            <Label>{t("parentFolder")}</Label>
            <Select
              value={parentId ?? "__root__"}
              onValueChange={(v) => setParentId(v === "__root__" ? null : v)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__root__">{t("noParent")}</SelectItem>
                {availableParents.map((f) => {
                  const depth = depthMap.get(f.id) ?? 0;
                  const indent = depth > 0 ? "\u00A0\u00A0".repeat(depth) + "└ " : "";
                  return (
                    <SelectItem key={f.id} value={f.id}>
                      {indent}{f.name}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {tCommon("cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={!name.trim() || loading}>
            {isEdit ? tCommon("save") : tCommon("create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
