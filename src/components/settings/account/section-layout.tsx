"use client";

import { Card } from "@/components/ui/card";
import { SectionNav } from "@/components/settings/account/section-nav";
import type { LucideIcon } from "lucide-react";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

interface SectionLayoutProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  navItems?: NavItem[];
  children: React.ReactNode;
  headerExtra?: React.ReactNode;
}

/**
 * Shared base layout for settings/admin section pages.
 * Used by personal settings, tenant admin, and team admin pages.
 *
 * - Header card: icon + title + description (+ optional headerExtra)
 * - Optional SectionNav: left nav on desktop, horizontal pills on mobile
 * - Content area below or beside SectionNav
 */
export function SectionLayout({
  icon: Icon,
  title,
  description,
  navItems,
  children,
  headerExtra,
}: SectionLayoutProps) {
  return (
    <div className="flex-1 overflow-auto p-4 md:p-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <Card className="rounded-xl border bg-gradient-to-b from-muted/30 to-background p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <Icon className="h-6 w-6 shrink-0" />
              <div className="min-w-0">
                <h1 className="text-2xl font-bold">{title}</h1>
                {description && (
                  <p className="text-sm text-muted-foreground">{description}</p>
                )}
              </div>
            </div>
            {headerExtra}
          </div>
        </Card>
        {navItems && navItems.length > 0 ? (
          <div className="flex flex-col md:flex-row gap-6">
            <SectionNav items={navItems} />
            <div className="flex-1 space-y-4">{children}</div>
          </div>
        ) : (
          <div className="space-y-4">{children}</div>
        )}
      </div>
    </div>
  );
}
