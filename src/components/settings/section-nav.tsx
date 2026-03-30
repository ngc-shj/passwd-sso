"use client";

import { usePathname } from "next/navigation";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { stripLocalePrefix } from "@/i18n/locale-utils";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

interface SectionNavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

interface SectionNavProps {
  items: SectionNavItem[];
}

export function SectionNav({ items }: SectionNavProps) {
  const cleanPath = stripLocalePrefix(usePathname());

  return (
    <>
      {/* Desktop: vertical nav */}
      <nav className="hidden md:flex w-48 shrink-0 flex-col gap-1">
        {items.map((item) => {
          const isActive = cleanPath.startsWith(item.href);
          return (
            <Button
              key={item.href}
              variant={isActive ? "secondary" : "ghost"}
              className="w-full justify-start gap-2"
              asChild
            >
              <Link href={item.href}>
                <item.icon className="h-4 w-4" />
                {item.label}
              </Link>
            </Button>
          );
        })}
      </nav>
      {/* Mobile: horizontal scroll pills */}
      <nav className="flex md:hidden gap-2 overflow-x-auto pb-2 -mx-1 px-1">
        {items.map((item) => {
          const isActive = cleanPath.startsWith(item.href);
          return (
            <Button
              key={item.href}
              variant={isActive ? "secondary" : "outline"}
              size="sm"
              className="shrink-0 gap-1.5"
              asChild
            >
              <Link href={item.href}>
                <item.icon className="h-3.5 w-3.5" />
                {item.label}
              </Link>
            </Button>
          );
        })}
      </nav>
    </>
  );
}
