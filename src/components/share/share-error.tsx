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
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <Card className="max-w-md w-full p-8 text-center space-y-4">
        <div className="flex justify-center">{ICONS[reason] ?? ICONS.notFound}</div>
        <h1 className="text-xl font-semibold">{t(titleKey)}</h1>
        <p className="text-sm text-muted-foreground">{t(descKey)}</p>
      </Card>
    </div>
  );
}
