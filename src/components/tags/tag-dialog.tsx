"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { buildTagTree, flattenTagTree, type FlatTag } from "@/lib/tag-tree";
import { TAG_NAME_MAX_LENGTH } from "@/lib/validations";

export interface TagDialogTag {
  id: string;
  name: string;
  color: string | null;
  parentId?: string | null;
}

interface TagDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editTag: TagDialogTag | null;
  allTags?: FlatTag[];
  onSubmit: (data: { name: string; color: string | null; parentId?: string | null }) => Promise<void>;
}

const ROOT_VALUE = "__root__";

export function TagDialog({ open, onOpenChange, editTag, allTags = [], onSubmit }: TagDialogProps) {
  const t = useTranslations("Dashboard");
  const tTag = useTranslations("Tag");
  const tCommon = useTranslations("Common");
  const [name, setName] = useState("");
  const [color, setColor] = useState("#4f46e5");
  const [colorChanged, setColorChanged] = useState(false);
  const [parentId, setParentId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const isEdit = !!editTag;

  useEffect(() => {
    if (!open) return;
    setName(editTag?.name ?? "");
    setColor(editTag?.color ?? "#4f46e5");
    setColorChanged(false);
    setParentId(editTag?.parentId ?? null);
  }, [open, editTag]);

  // Build parent options: exclude self and descendants for edit, limit depth
  const parentOptions = (() => {
    const tree = buildTagTree(allTags);
    const flat = flattenTagTree(tree);

    // Collect IDs to exclude (self + descendants)
    const excludeIds = new Set<string>();
    if (editTag) {
      excludeIds.add(editTag.id);
      for (const t of flat) {
        let cur: string | null = t.parentId ?? null;
        while (cur) {
          if (cur === editTag.id) {
            excludeIds.add(t.id);
            break;
          }
          const parent = allTags.find((p) => p.id === cur);
          cur = parent?.parentId ?? null;
        }
      }
    }

    // Only show tags at depth < 2 as potential parents (max depth 3)
    return flat.filter((t) => !excludeIds.has(t.id) && t.depth < 2);
  })();

  const handleSubmit = async () => {
    if (!name.trim()) return;
    const normalizedColor =
      !colorChanged && editTag?.color === null
        ? null
        : /^#[0-9a-fA-F]{6}$/.test(color)
          ? color
          : null;

    setLoading(true);
    try {
      await onSubmit({ name: name.trim(), color: normalizedColor, parentId });
      onOpenChange(false);
    } catch {
      // Error already handled by caller (e.g. toast in sidebar).
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? t("editTag") : t("createTag")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="tag-name">{t("tagName")}</Label>
            <Input
              id="tag-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={TAG_NAME_MAX_LENGTH}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing && name.trim()) {
                  handleSubmit();
                }
              }}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="tag-color">{t("tagColor")}</Label>
            <Input
              id="tag-color"
              type="color"
              value={/^#[0-9a-fA-F]{6}$/.test(color) ? color : "#4f46e5"}
              onChange={(e) => {
                setColor(e.target.value);
                setColorChanged(true);
              }}
              className="h-10 w-24 p-1"
            />
          </div>

          {allTags.length > 0 && (
            <div className="space-y-2">
              <Label>{tTag("parentTag")}</Label>
              <Select
                value={parentId ?? ROOT_VALUE}
                onValueChange={(v) => setParentId(v === ROOT_VALUE ? null : v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ROOT_VALUE}>{tTag("noParent")}</SelectItem>
                  {parentOptions.map((opt) => (
                    <SelectItem key={opt.id} value={opt.id}>
                      <span style={{ paddingLeft: `${opt.depth * 12}px` }}>{opt.name}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
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
