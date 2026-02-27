"use client";

import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { TEAM_ROLE } from "@/lib/constants";
import { CollapsibleSectionHeader } from "@/components/layout/sidebar-shared";
import {
  Download,
  HeartPulse,
  Monitor,
  Settings,
  Shield,
  Upload,
} from "lucide-react";

interface SecurityTeam {
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
  tTeam: (key: string) => string;
  selectedTeam?: SecurityTeam | null;
  onNavigate: () => void;
}

export function UtilitiesSection({
  isOpen,
  onOpenChange,
  t,
  tTeam,
  selectedTeam,
  onNavigate,
}: UtilitiesSectionProps) {
  const scopedTeam = selectedTeam ?? null;
  const exportHref = scopedTeam
    ? `/dashboard/teams/${scopedTeam.id}/export`
    : "/dashboard/export";
  const importHref = scopedTeam
    ? `/dashboard/teams/${scopedTeam.id}/import`
    : "/dashboard/import";

  return (
    <Collapsible open={isOpen} onOpenChange={onOpenChange}>
      <CollapsibleSectionHeader isOpen={isOpen}>{t("utilities")}</CollapsibleSectionHeader>
      <CollapsibleContent>
        <div className="space-y-1">
          {scopedTeam &&
            (scopedTeam.role === TEAM_ROLE.OWNER || scopedTeam.role === TEAM_ROLE.ADMIN) ? (
            <Button variant="ghost" className="w-full justify-start gap-2" asChild>
              <Link href={`/dashboard/teams/${scopedTeam.id}/settings`} onClick={onNavigate}>
                <Settings className="h-4 w-4" />
                {tTeam("teamSettings")}
              </Link>
            </Button>
          ) : !scopedTeam && (
            <>
              <Button variant="ghost" className="w-full justify-start gap-2" asChild>
                <Link href="/dashboard/settings" onClick={onNavigate}>
                  <Monitor className="h-4 w-4" />
                  {t("settings")}
                </Link>
              </Button>
              <Button variant="ghost" className="w-full justify-start gap-2" asChild>
                <Link href="/dashboard/teams" onClick={onNavigate}>
                  <Settings className="h-4 w-4" />
                  {tTeam("teamSettings")}
                </Link>
              </Button>
            </>
          )}
          <Button variant="ghost" className="w-full justify-start gap-2" asChild>
            <Link href={exportHref} onClick={onNavigate}>
              <Download className="h-4 w-4" />
              {t("export")}
            </Link>
          </Button>
          <Button variant="ghost" className="w-full justify-start gap-2" asChild>
            <Link href={importHref} onClick={onNavigate}>
              <Upload className="h-4 w-4" />
              {t("import")}
            </Link>
          </Button>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
