"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import { FolderOpen, Shield, Tag, Star, Archive, Trash2, Download, Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import { getTagColorClass } from "@/lib/dynamic-styles";
import { ExportDialog } from "@/components/passwords/export-dialog";
import { ImportDialog } from "@/components/passwords/import-dialog";

interface TagItem {
  id: string;
  name: string;
  color: string | null;
  passwordCount: number;
}

export type SidebarView = "all" | "favorites" | "archive" | "trash" | string;

interface SidebarProps {
  selectedView: SidebarView;
  onViewSelect: (view: SidebarView) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImportComplete?: () => void;
  refreshKey?: number;
}

export function Sidebar({
  selectedView,
  onViewSelect,
  open,
  onOpenChange,
  onImportComplete,
  refreshKey,
}: SidebarProps) {
  const t = useTranslations("Dashboard");
  const [tags, setTags] = useState<TagItem[]>([]);

  useEffect(() => {
    fetch("/api/tags")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch tags");
        return res.json();
      })
      .then((data) => {
        if (Array.isArray(data)) setTags(data);
      })
      .catch(() => {});
  }, [refreshKey]);

  const content = (
    <nav className="space-y-1 p-4">
      <Button
        variant={selectedView === "all" ? "secondary" : "ghost"}
        className="w-full justify-start gap-2"
        onClick={() => {
          onViewSelect("all");
          onOpenChange(false);
        }}
      >
        <FolderOpen className="h-4 w-4" />
        {t("allPasswords")}
      </Button>
      <Button
        variant={selectedView === "favorites" ? "secondary" : "ghost"}
        className="w-full justify-start gap-2"
        onClick={() => {
          onViewSelect("favorites");
          onOpenChange(false);
        }}
      >
        <Star className="h-4 w-4" />
        {t("favorites")}
      </Button>
      <Separator className="my-2" />
      <Button
        variant="ghost"
        className="w-full justify-start gap-2"
        asChild
      >
        <Link href="/dashboard/watchtower" onClick={() => onOpenChange(false)}>
          <Shield className="h-4 w-4" />
          {t("watchtower")}
        </Link>
      </Button>
      {tags.filter((t) => t.passwordCount > 0).length > 0 && (
        <>
          <Separator className="my-2" />
          <p className="px-3 py-1 text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1">
            <Tag className="h-3 w-3" />
            {t("tags")}
          </p>
          {tags.filter((t) => t.passwordCount > 0).map((tag) => {
            const colorClass = getTagColorClass(tag.color);
            return (
              <Button
                key={tag.id}
                variant={selectedView === tag.id ? "secondary" : "ghost"}
                className="w-full justify-start gap-2"
                onClick={() => {
                  onViewSelect(tag.id);
                  onOpenChange(false);
                }}
              >
                <Badge
                  variant="outline"
                  className={cn(
                    "h-3 w-3 rounded-full p-0",
                    colorClass && "tag-color-bg",
                    colorClass
                  )}
                />
                {tag.name}
                <span className="ml-auto text-xs text-muted-foreground">
                  {tag.passwordCount}
                </span>
              </Button>
            );
          })}
        </>
      )}
      <Separator className="my-2" />
      <ExportDialog
        trigger={
          <Button variant="ghost" className="w-full justify-start gap-2">
            <Download className="h-4 w-4" />
            {t("export")}
          </Button>
        }
      />
      <ImportDialog
        trigger={
          <Button variant="ghost" className="w-full justify-start gap-2">
            <Upload className="h-4 w-4" />
            {t("import")}
          </Button>
        }
        onComplete={() => onImportComplete?.()}
      />
      <Button
        variant={selectedView === "archive" ? "secondary" : "ghost"}
        className="w-full justify-start gap-2"
        onClick={() => {
          onViewSelect("archive");
          onOpenChange(false);
        }}
      >
        <Archive className="h-4 w-4" />
        {t("archive")}
      </Button>
      <Button
        variant={selectedView === "trash" ? "secondary" : "ghost"}
        className="w-full justify-start gap-2"
        onClick={() => {
          onViewSelect("trash");
          onOpenChange(false);
        }}
      >
        <Trash2 className="h-4 w-4" />
        {t("trash")}
      </Button>
    </nav>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden md:block w-56 border-r bg-background shrink-0">
        {content}
      </aside>

      {/* Mobile sidebar (sheet) */}
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="left" className="w-56 p-0">
          {content}
        </SheetContent>
      </Sheet>
    </>
  );
}
