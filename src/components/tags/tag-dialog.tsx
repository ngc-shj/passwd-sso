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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface TagDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editTag: { id: string; name: string; color: string | null } | null;
  onSubmit: (data: { name: string; color: string | null }) => Promise<void>;
}

export function TagDialog({ open, onOpenChange, editTag, onSubmit }: TagDialogProps) {
  const t = useTranslations("Dashboard");
  const tCommon = useTranslations("Common");
  const [name, setName] = useState("");
  const [color, setColor] = useState("#4f46e5");
  const [colorChanged, setColorChanged] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(editTag?.name ?? "");
    setColor(editTag?.color ?? "#4f46e5");
    setColorChanged(false);
  }, [open, editTag]);

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
      await onSubmit({ name: name.trim(), color: normalizedColor });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("editTag")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="tag-name">{t("tagName")}</Label>
            <Input
              id="tag-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={50}
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
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {tCommon("cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={!name.trim() || loading}>
            {tCommon("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
