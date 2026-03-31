"use client";

import { Building2, Menu } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";

interface AdminHeaderProps {
  onMenuToggle: () => void;
}

export function AdminHeader({ onMenuToggle }: AdminHeaderProps) {
  const t = useTranslations("AdminConsole");

  return (
    <header className="sticky top-0 z-50 border-b bg-muted/50 backdrop-blur supports-[backdrop-filter]:bg-muted/60">
      <div className="flex h-14 items-center gap-4 px-4">
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          onClick={onMenuToggle}
        >
          <Menu className="h-5 w-5" />
        </Button>

        <Link
          href="/dashboard"
          className="text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          ← {t("backToVault")}
        </Link>

        <div className="flex-1" />

        <div className="flex items-center gap-2 font-semibold">
          <Building2 className="h-5 w-5" />
          <span>{t("title")}</span>
        </div>
      </div>
    </header>
  );
}
