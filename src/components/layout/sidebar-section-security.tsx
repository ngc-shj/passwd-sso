"use client";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { ExportDialog } from "@/components/passwords/export-dialog";
import { ImportDialog } from "@/components/passwords/import-dialog";
import { ORG_ROLE } from "@/lib/constants";
import {
  Building2,
  ChevronDown,
  ChevronRight,
  Download,
  FolderOpen,
  HeartPulse,
  Link as LinkIcon,
  ScrollText,
  Settings,
  Shield,
  Upload,
} from "lucide-react";

interface SecurityOrg {
  id: string;
  name: string;
  role: string;
}

interface SecuritySectionProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  t: (key: string) => string;
  isWatchtower: boolean;
  isShareLinks: boolean;
  isEmergencyAccess: boolean;
  isPersonalAuditLog: boolean;
  activeAuditOrgId: string | null;
  orgs: SecurityOrg[];
  onNavigate: () => void;
}

export function SecuritySection({
  isOpen,
  onOpenChange,
  t,
  isWatchtower,
  isShareLinks,
  isEmergencyAccess,
  isPersonalAuditLog,
  activeAuditOrgId,
  orgs,
  onNavigate,
}: SecuritySectionProps) {
  return (
    <Collapsible open={isOpen} onOpenChange={onOpenChange}>
      <CollapsibleSectionHeader isOpen={isOpen}>{t("security")}</CollapsibleSectionHeader>
      <CollapsibleContent>
        <div className="space-y-1">
          <Button
            variant={isWatchtower ? "secondary" : "ghost"}
            className="w-full justify-start gap-2"
            asChild
          >
            <Link href="/dashboard/watchtower" onClick={onNavigate}>
              <Shield className="h-4 w-4" />
              {t("watchtower")}
            </Link>
          </Button>
          <Button
            variant={isShareLinks ? "secondary" : "ghost"}
            className="w-full justify-start gap-2"
            asChild
          >
            <Link href="/dashboard/share-links" onClick={onNavigate}>
              <LinkIcon className="h-4 w-4" />
              {t("shareLinks")}
            </Link>
          </Button>
          <Button
            variant={isEmergencyAccess ? "secondary" : "ghost"}
            className="w-full justify-start gap-2"
            asChild
          >
            <Link href="/dashboard/emergency-access" onClick={onNavigate}>
              <HeartPulse className="h-4 w-4" />
              {t("emergencyAccess")}
            </Link>
          </Button>
          <SectionLabel icon={<ScrollText className="h-3 w-3" />}>{t("auditLog")}</SectionLabel>
          <div className="ml-4 space-y-1">
            <Button
              variant={isPersonalAuditLog ? "secondary" : "ghost"}
              className="w-full justify-start gap-2"
              asChild
            >
              <Link href="/dashboard/audit-logs" onClick={onNavigate}>
                <FolderOpen className="h-4 w-4" />
                {t("auditLogPersonal")}
              </Link>
            </Button>
            {orgs
              .filter((org) => org.role === ORG_ROLE.OWNER || org.role === ORG_ROLE.ADMIN)
              .map((org) => (
                <Button
                  key={org.id}
                  variant={activeAuditOrgId === org.id ? "secondary" : "ghost"}
                  className="w-full justify-start gap-2"
                  asChild
                >
                  <Link href={`/dashboard/orgs/${org.id}/audit-logs`} onClick={onNavigate}>
                    <Building2 className="h-4 w-4" />
                    <span className="truncate">{org.name}</span>
                  </Link>
                </Button>
              ))}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

interface UtilitiesSectionProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  t: (key: string) => string;
  tOrg: (key: string) => string;
  selectedOrg: SecurityOrg | null;
  onImportComplete: () => void;
  onNavigate: () => void;
}

export function UtilitiesSection({
  isOpen,
  onOpenChange,
  t,
  tOrg,
  selectedOrg,
  onImportComplete,
  onNavigate,
}: UtilitiesSectionProps) {
  return (
    <Collapsible open={isOpen} onOpenChange={onOpenChange}>
      <CollapsibleSectionHeader isOpen={isOpen}>{t("utilities")}</CollapsibleSectionHeader>
      <CollapsibleContent>
        <div className="space-y-1">
          {selectedOrg &&
            (selectedOrg.role === ORG_ROLE.OWNER || selectedOrg.role === ORG_ROLE.ADMIN) && (
            <Button variant="ghost" className="w-full justify-start gap-2" asChild>
              <Link href={`/dashboard/orgs/${selectedOrg.id}/settings`} onClick={onNavigate}>
                <Settings className="h-4 w-4" />
                {tOrg("orgSettings")}
              </Link>
            </Button>
          )}
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
            onComplete={onImportComplete}
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function CollapsibleSectionHeader({
  children,
  icon,
  isOpen,
}: {
  children: React.ReactNode;
  icon?: React.ReactNode;
  isOpen: boolean;
}) {
  return (
    <CollapsibleTrigger asChild>
      <button type="button" className="w-full px-3 py-1 text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center justify-between gap-1 hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm">
        <span className="flex items-center gap-1">
          {icon}
          {children}
        </span>
        {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      </button>
    </CollapsibleTrigger>
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
