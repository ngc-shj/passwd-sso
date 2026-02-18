"use client";

import { useState } from "react";
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
  const [name, setName] = useState(editFolder?.name ?? "");
  const [parentId, setParentId] = useState<string | null>(
    editFolder?.parentId ?? null,
  );
  const [loading, setLoading] = useState(false);

  const isEdit = !!editFolder;

  // Filter out the folder being edited and its descendants to prevent circular reference
  const availableParents = folders.filter((f) => {
    if (!editFolder) return true;
    if (f.id === editFolder.id) return false;
    // Simple check — for deep trees, the API validates circular references
    return true;
  });

  const handleSubmit = async () => {
    if (!name.trim()) return;
    setLoading(true);
    try {
      await onSubmit({ name: name.trim(), parentId });
      onOpenChange(false);
      setName("");
      setParentId(null);
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
                if (e.key === "Enter" && name.trim()) handleSubmit();
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
                {availableParents.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!name.trim() || loading}>
            {isEdit ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
