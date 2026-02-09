"use client";

import { useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import { FolderOpen, Shield, Tag, Star, Archive, Trash2, Download, Upload, Building2, Settings, KeyRound, FileText, CreditCard, IdCard, ScrollText, Link as LinkIcon } from "lucide-react";
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

interface OrgTagGroup {
  orgId: string;
  orgName: string;
  tags: { id: string; name: string; color: string | null; count: number }[];
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
  const [orgTagGroups, setOrgTagGroups] = useState<OrgTagGroup[]>([]);

  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Strip locale prefix for route matching
  const cleanPath = pathname.replace(/^\/(ja|en)/, "");

  // Active state detection (all path-based)
  const activeTypeFilter = cleanPath === "/dashboard" ? searchParams.get("type") : null;
  const isVaultAll = cleanPath === "/dashboard" && !activeTypeFilter;
  const isVaultFavorites = cleanPath === "/dashboard/favorites";
  const isVaultArchive = cleanPath === "/dashboard/archive";
  const isVaultTrash = cleanPath === "/dashboard/trash";
  const isWatchtower = cleanPath === "/dashboard/watchtower";
  const isAuditLog = cleanPath === "/dashboard/audit-logs" || cleanPath.endsWith("/audit-logs");
  const isPersonalAuditLog = cleanPath === "/dashboard/audit-logs";
  const auditOrgMatch = cleanPath.match(/^\/dashboard\/orgs\/([^/]+)\/audit-logs$/);
  const activeAuditOrgId = auditOrgMatch ? auditOrgMatch[1] : null;
  const tagMatch = cleanPath.match(/^\/dashboard\/tags\/([^/]+)/);
  const activeTagId = tagMatch ? tagMatch[1] : null;
  const orgMatch = cleanPath.match(/^\/dashboard\/orgs\/([^/]+)/);
  const activeOrgId = orgMatch && !isAuditLog ? orgMatch[1] : null;
  const activeOrgTagId = activeOrgId ? searchParams.get("tag") : null;
  const activeOrgTypeFilter = activeOrgId ? searchParams.get("type") : null;
  const isOrgsManage = cleanPath === "/dashboard/orgs";
  const isShareLinks = cleanPath === "/dashboard/share-links";

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
      .then(async (data) => {
        if (!Array.isArray(data)) return;
        setOrgs(data);

        // Fetch tags for all orgs in parallel
        const groups: OrgTagGroup[] = [];
        await Promise.all(
          data.map(async (org: OrgItem) => {
            try {
              const res = await fetch(`/api/orgs/${org.id}/tags`);
              if (!res.ok) return;
              const tags = await res.json();
              if (Array.isArray(tags) && tags.length > 0) {
                groups.push({ orgId: org.id, orgName: org.name, tags });
              }
            } catch { /* ignore */ }
          })
        );
        setOrgTagGroups(groups);
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

      <div>
        <SectionLabel>{t("categories")}</SectionLabel>
        <div className="space-y-1">
          <Button
            variant={activeTypeFilter === "LOGIN" ? "secondary" : "ghost"}
            className="w-full justify-start gap-2"
            asChild
          >
            <Link href="/dashboard?type=LOGIN" onClick={() => onOpenChange(false)}>
              <KeyRound className="h-4 w-4" />
              {t("catLogin")}
            </Link>
          </Button>
          <Button
            variant={activeTypeFilter === "SECURE_NOTE" ? "secondary" : "ghost"}
            className="w-full justify-start gap-2"
            asChild
          >
            <Link href="/dashboard?type=SECURE_NOTE" onClick={() => onOpenChange(false)}>
              <FileText className="h-4 w-4" />
              {t("catSecureNote")}
            </Link>
          </Button>
          <Button
            variant={activeTypeFilter === "CREDIT_CARD" ? "secondary" : "ghost"}
            className="w-full justify-start gap-2"
            asChild
          >
            <Link href="/dashboard?type=CREDIT_CARD" onClick={() => onOpenChange(false)}>
              <CreditCard className="h-4 w-4" />
              {t("catCreditCard")}
            </Link>
          </Button>
          <Button
            variant={activeTypeFilter === "IDENTITY" ? "secondary" : "ghost"}
            className="w-full justify-start gap-2"
            asChild
          >
            <Link href="/dashboard?type=IDENTITY" onClick={() => onOpenChange(false)}>
              <IdCard className="h-4 w-4" />
              {t("catIdentity")}
            </Link>
          </Button>
        </div>
      </div>

      <div>
        <SectionLabel icon={<Building2 className="h-3 w-3" />}>
          {tOrg("organizations")}
        </SectionLabel>
        <div className="space-y-1">
          {orgs.map((org) => (
            <div key={org.id}>
              <Button
                variant={activeOrgId === org.id && !activeOrgTypeFilter ? "secondary" : "ghost"}
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
              {activeOrgId === org.id && (
                <div className="ml-6 space-y-0.5">
                  <Button
                    variant={activeOrgTypeFilter === "LOGIN" ? "secondary" : "ghost"}
                    size="sm"
                    className="w-full justify-start gap-2 h-8"
                    asChild
                  >
                    <Link href={`/dashboard/orgs/${org.id}?type=LOGIN`} onClick={() => onOpenChange(false)}>
                      <KeyRound className="h-3.5 w-3.5" />
                      {t("catLogin")}
                    </Link>
                  </Button>
                  <Button
                    variant={activeOrgTypeFilter === "SECURE_NOTE" ? "secondary" : "ghost"}
                    size="sm"
                    className="w-full justify-start gap-2 h-8"
                    asChild
                  >
                    <Link href={`/dashboard/orgs/${org.id}?type=SECURE_NOTE`} onClick={() => onOpenChange(false)}>
                      <FileText className="h-3.5 w-3.5" />
                      {t("catSecureNote")}
                    </Link>
                  </Button>
                  <Button
                    variant={activeOrgTypeFilter === "CREDIT_CARD" ? "secondary" : "ghost"}
                    size="sm"
                    className="w-full justify-start gap-2 h-8"
                    asChild
                  >
                    <Link href={`/dashboard/orgs/${org.id}?type=CREDIT_CARD`} onClick={() => onOpenChange(false)}>
                      <CreditCard className="h-3.5 w-3.5" />
                      {t("catCreditCard")}
                    </Link>
                  </Button>
                  <Button
                    variant={activeOrgTypeFilter === "IDENTITY" ? "secondary" : "ghost"}
                    size="sm"
                    className="w-full justify-start gap-2 h-8"
                    asChild
                  >
                    <Link href={`/dashboard/orgs/${org.id}?type=IDENTITY`} onClick={() => onOpenChange(false)}>
                      <IdCard className="h-3.5 w-3.5" />
                      {t("catIdentity")}
                    </Link>
                  </Button>
                </div>
              )}
            </div>
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


      {(tags.filter((tg) => tg.passwordCount > 0).length > 0 || orgTagGroups.length > 0) && (
        <>
          <Separator />
          <div>
            <SectionLabel icon={<Tag className="h-3 w-3" />}>
              {t("organize")}
            </SectionLabel>
            <div className="space-y-1">
              {tags.filter((tg) => tg.passwordCount > 0).map((tag) => {
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

          {orgTagGroups.map((group) => (
            <div key={group.orgId}>
              <SectionLabel icon={<Building2 className="h-3 w-3" />}>
                {group.orgName}
              </SectionLabel>
              <div className="space-y-1">
                {group.tags.map((tag) => {
                  const colorClass = getTagColorClass(tag.color);
                  return (
                    <Button
                      key={tag.id}
                      variant={activeOrgTagId === tag.id ? "secondary" : "ghost"}
                      className="w-full justify-start gap-2"
                      asChild
                    >
                      <Link
                        href={`/dashboard/orgs/${group.orgId}?tag=${tag.id}`}
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
                          {tag.count}
                        </span>
                      </Link>
                    </Button>
                  );
                })}
              </div>
            </div>
          ))}
        </>
      )}

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
          <Button
            variant={isShareLinks ? "secondary" : "ghost"}
            className="w-full justify-start gap-2"
            asChild
          >
            <Link href="/dashboard/share-links" onClick={() => onOpenChange(false)}>
              <LinkIcon className="h-4 w-4" />
              {t("shareLinks")}
            </Link>
          </Button>
          <SectionLabel icon={<ScrollText className="h-3 w-3" />}>
            {t("auditLog")}
          </SectionLabel>
          <div className="space-y-1">
            <Button
              variant={isPersonalAuditLog ? "secondary" : "ghost"}
              className="w-full justify-start gap-2"
              asChild
            >
              <Link href="/dashboard/audit-logs" onClick={() => onOpenChange(false)}>
                <FolderOpen className="h-4 w-4" />
                {t("auditLogPersonal")}
              </Link>
            </Button>
            {orgs.filter((org) => org.role === "OWNER" || org.role === "ADMIN").map((org) => (
              <Button
                key={org.id}
                variant={activeAuditOrgId === org.id ? "secondary" : "ghost"}
                className="w-full justify-start gap-2"
                asChild
              >
                <Link
                  href={`/dashboard/orgs/${org.id}/audit-logs`}
                  onClick={() => onOpenChange(false)}
                >
                  <Building2 className="h-4 w-4" />
                  <span className="truncate">{org.name}</span>
                </Link>
              </Button>
            ))}
          </div>
        </div>
      </div>

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
