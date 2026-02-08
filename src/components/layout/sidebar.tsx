"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import { FolderOpen, Shield, Tag, Star, Archive, Trash2, Download, Upload, Building2, Settings } from "lucide-react";
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

interface OrgItem {
  id: string;
  name: string;
  slug: string;
  role: string;
}

interface SidebarProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function Sidebar({ open, onOpenChange }: SidebarProps) {
  const t = useTranslations("Dashboard");
  const tOrg = useTranslations("Org");
  const [tags, setTags] = useState<TagItem[]>([]);
  const [orgs, setOrgs] = useState<OrgItem[]>([]);

  const pathname = usePathname();

  // Strip locale prefix for route matching
  const cleanPath = pathname.replace(/^\/(ja|en)/, "");

  // Active state detection (all path-based)
  const isVaultAll = cleanPath === "/dashboard";
  const isVaultFavorites = cleanPath === "/dashboard/favorites";
  const isVaultArchive = cleanPath === "/dashboard/archive";
  const isVaultTrash = cleanPath === "/dashboard/trash";
  const isWatchtower = cleanPath === "/dashboard/watchtower";
  const tagMatch = cleanPath.match(/^\/dashboard\/tags\/([^/]+)/);
  const activeTagId = tagMatch ? tagMatch[1] : null;
  const orgMatch = cleanPath.match(/^\/dashboard\/orgs\/([^/]+)/);
  const activeOrgId = orgMatch ? orgMatch[1] : null;
  const isOrgsManage = cleanPath === "/dashboard/orgs";

  const fetchData = () => {
    fetch("/api/tags")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch tags");
        return res.json();
      })
      .then((data) => {
        if (Array.isArray(data)) setTags(data);
      })
      .catch(() => {});

    fetch("/api/orgs")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch orgs");
        return res.json();
      })
      .then((data) => {
        if (Array.isArray(data)) setOrgs(data);
      })
      .catch(() => {});
  };

  // Fetch data on mount and when pathname changes
  useEffect(() => {
    fetchData();
  }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  // Listen for data-changed events (import, create, etc.)
  useEffect(() => {
    const handler = () => fetchData();
    window.addEventListener("vault-data-changed", handler);
    window.addEventListener("org-data-changed", handler);
    return () => {
      window.removeEventListener("vault-data-changed", handler);
      window.removeEventListener("org-data-changed", handler);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleImportComplete = () => {
    window.dispatchEvent(new CustomEvent("vault-data-changed"));
  };

  const content = (
    <nav className="space-y-4 p-4">
      <div>
        <SectionLabel>{t("vault")}</SectionLabel>
        <div className="space-y-1">
          <Button
            variant={isVaultAll ? "secondary" : "ghost"}
            className="w-full justify-start gap-2"
            asChild
          >
            <Link href="/dashboard" onClick={() => onOpenChange(false)}>
              <FolderOpen className="h-4 w-4" />
              {t("allPasswords")}
            </Link>
          </Button>
          <Button
            variant={isVaultFavorites ? "secondary" : "ghost"}
            className="w-full justify-start gap-2"
            asChild
          >
            <Link href="/dashboard/favorites" onClick={() => onOpenChange(false)}>
              <Star className="h-4 w-4" />
              {t("favorites")}
            </Link>
          </Button>
          <Button
            variant={isVaultArchive ? "secondary" : "ghost"}
            className="w-full justify-start gap-2"
            asChild
          >
            <Link href="/dashboard/archive" onClick={() => onOpenChange(false)}>
              <Archive className="h-4 w-4" />
              {t("archive")}
            </Link>
          </Button>
          <Button
            variant={isVaultTrash ? "secondary" : "ghost"}
            className="w-full justify-start gap-2"
            asChild
          >
            <Link href="/dashboard/trash" onClick={() => onOpenChange(false)}>
              <Trash2 className="h-4 w-4" />
              {t("trash")}
            </Link>
          </Button>
        </div>
      </div>

      <Separator />

      <div>
        <SectionLabel>{t("security")}</SectionLabel>
        <div className="space-y-1">
          <Button
            variant={isWatchtower ? "secondary" : "ghost"}
            className="w-full justify-start gap-2"
            asChild
          >
            <Link href="/dashboard/watchtower" onClick={() => onOpenChange(false)}>
              <Shield className="h-4 w-4" />
              {t("watchtower")}
            </Link>
          </Button>
        </div>
      </div>

      <Separator />

      <div>
        <SectionLabel icon={<Building2 className="h-3 w-3" />}>
          {tOrg("organizations")}
        </SectionLabel>
        <div className="space-y-1">
          {orgs.map((org) => (
            <Button
              key={org.id}
              variant={activeOrgId === org.id ? "secondary" : "ghost"}
              className="w-full justify-start gap-2"
              asChild
            >
              <Link
                href={`/dashboard/orgs/${org.id}`}
                onClick={() => onOpenChange(false)}
              >
                <Building2 className="h-4 w-4" />
                <span className="truncate">{org.name}</span>
              </Link>
            </Button>
          ))}
          <Button
            variant={isOrgsManage ? "secondary" : "ghost"}
            className="w-full justify-start gap-2"
            asChild
          >
            <Link href="/dashboard/orgs" onClick={() => onOpenChange(false)}>
              <Settings className="h-4 w-4" />
              {tOrg("manage")}
            </Link>
          </Button>
        </div>
      </div>

      {tags.filter((t) => t.passwordCount > 0).length > 0 && (
        <>
          <Separator />
          <div>
            <SectionLabel icon={<Tag className="h-3 w-3" />}>
              {t("organize")}
            </SectionLabel>
            <div className="space-y-1">
              {tags.filter((t) => t.passwordCount > 0).map((tag) => {
                const colorClass = getTagColorClass(tag.color);
                return (
                  <Button
                    key={tag.id}
                    variant={activeTagId === tag.id ? "secondary" : "ghost"}
                    className="w-full justify-start gap-2"
                    asChild
                  >
                    <Link
                      href={`/dashboard/tags/${tag.id}`}
                      onClick={() => onOpenChange(false)}
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
                    </Link>
                  </Button>
                );
              })}
            </div>
          </div>
        </>
      )}

      <Separator />

      <div>
        <SectionLabel>{t("utilities")}</SectionLabel>
        <div className="space-y-1">
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
            onComplete={handleImportComplete}
          />
        </div>
      </div>
    </nav>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden md:block w-56 border-r bg-background shrink-0 overflow-auto">
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

function SectionLabel({
  children,
  icon,
}: {
  children: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <p className="px-3 py-1 text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1">
      {icon}
      {children}
    </p>
  );
}
