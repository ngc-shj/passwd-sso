"use client";

import { useTranslations } from "next-intl";
import { ShieldX, ShieldAlert, Clock, Eye, LinkIcon } from "lucide-react";
import { Card } from "@/components/ui/card";

const ICONS: Record<string, React.ReactNode> = {
  notFound: <LinkIcon className="h-10 w-10 text-muted-foreground" />,
  expired: <Clock className="h-10 w-10 text-muted-foreground" />,
  revoked: <ShieldX className="h-10 w-10 text-muted-foreground" />,
  maxViews: <Eye className="h-10 w-10 text-muted-foreground" />,
  rateLimited: <ShieldAlert className="h-10 w-10 text-muted-foreground" />,
};

export function ShareError({ reason }: { reason: string }) {
  const t = useTranslations("Share");

  const titleKey = `error_${reason}_title` as never;
  const descKey = `error_${reason}_desc` as never;

  return (
    <div className="min-h-screen bg-gradient-to-b from-muted/30 to-background p-4">
      <div className="mx-auto flex max-w-md items-center justify-center py-16">
      <Card className="w-full space-y-4 rounded-xl border p-8 text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border bg-muted/30">
          {ICONS[reason] ?? ICONS.notFound}
        </div>
        <h1 className="text-xl font-semibold tracking-tight">{t(titleKey)}</h1>
        <p className="text-sm text-muted-foreground">{t(descKey)}</p>
      </Card>
      </div>
    </div>
  );
}
