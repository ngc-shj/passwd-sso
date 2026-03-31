"use client";

import { usePathname } from "next/navigation";
import { Link } from "@/i18n/navigation";
import { stripLocalePrefix } from "@/i18n/locale-utils";
import { ChevronDown } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface SectionNavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  children?: SectionNavItem[];
}

interface SectionNavProps {
  items: SectionNavItem[];
}

export function SectionNav({ items }: SectionNavProps) {
  const cleanPath = stripLocalePrefix(usePathname());

  return (
    <>
      {/* Desktop: vertical nav */}
      <nav className="hidden md:flex w-48 shrink-0 flex-col gap-0.5">
        {items.map((item) => {
          if (item.children?.length) {
            const isGroupActive = cleanPath.startsWith(item.href);
            return (
              <div key={item.href}>
                {/* Group header — not clickable, visual separator */}
                <div
                  className={cn(
                    "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium",
                    isGroupActive
                      ? "text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  <item.icon className="h-4 w-4 shrink-0" />
                  <span className="flex-1">{item.label}</span>
                  <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
                </div>
                {/* Child items */}
                <div className="ml-3 border-l pl-3 space-y-0.5">
                  {item.children.map((child) => {
                    const isActive = cleanPath.startsWith(child.href);
                    return (
                      <Button
                        key={child.href}
                        variant={isActive ? "secondary" : "ghost"}
                        size="sm"
                        className="w-full justify-start gap-2 h-8"
                        asChild
                      >
                        <Link href={child.href}>
                          <child.icon className="h-3.5 w-3.5" />
                          {child.label}
                        </Link>
                      </Button>
                    );
                  })}
                </div>
              </div>
            );
          }

          // Leaf item (no children)
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

      {/* Mobile: horizontal scroll pills — flatten tree */}
      <nav className="flex md:hidden gap-1.5 overflow-x-auto pb-2 -mx-1 px-1">
        {items.flatMap((item) => {
          if (item.children?.length) {
            return item.children.map((child) => {
              const isActive = cleanPath.startsWith(child.href);
              return (
                <Button
                  key={child.href}
                  variant={isActive ? "secondary" : "outline"}
                  size="sm"
                  className="shrink-0 gap-1.5"
                  asChild
                >
                  <Link href={child.href}>
                    <child.icon className="h-3.5 w-3.5" />
                    {child.label}
                  </Link>
                </Button>
              );
            });
          }
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
