"use client";

import { useTranslations } from "next-intl";
import { HeartPulse } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { SectionCardHeader } from "@/components/settings/account/section-card-header";
import { Button } from "@/components/ui/button";

export default function EmergencyAccessSettingsPage() {
  const tSettings = useTranslations("Settings");
  const tEa = useTranslations("EmergencyAccess");

  return (
    <Card>
      <SectionCardHeader
        icon={HeartPulse}
        title={tEa("title")}
        description={tSettings("emergencyAccess.description")}
      />
      <CardContent>
        <Button asChild size="sm">
          <Link href="/dashboard/emergency-access">
            <HeartPulse className="h-4 w-4 mr-2" />
            {tSettings("emergencyAccess.openButton")}
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
