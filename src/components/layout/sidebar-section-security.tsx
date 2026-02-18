"use client";

import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { ExportDialog } from "@/components/passwords/export-dialog";
import { ImportDialog } from "@/components/passwords/import-dialog";
import { ORG_ROLE } from "@/lib/constants";
import { CollapsibleSectionHeader } from "@/components/layout/sidebar-shared";
import {
  Download,
  HeartPulse,
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
  isEmergencyAccess: boolean;
  onNavigate: () => void;
}

export function SecuritySection({
  isOpen,
  onOpenChange,
  t,
  isWatchtower,
  isEmergencyAccess,
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
            variant={isEmergencyAccess ? "secondary" : "ghost"}
            className="w-full justify-start gap-2"
            asChild
          >
            <Link href="/dashboard/emergency-access" onClick={onNavigate}>
              <HeartPulse className="h-4 w-4" />
              {t("emergencyAccess")}
            </Link>
          </Button>
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
