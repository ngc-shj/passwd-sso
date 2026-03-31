import {
  CardAction,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

interface SectionCardHeaderProps {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
}

/**
 * Standardised CardHeader for admin/settings card components.
 *
 * Renders icon + title on one line, description below, and an optional
 * action element (button, dialog trigger, etc.) aligned to the top-right
 * via the shadcn CardAction slot.
 */
export function SectionCardHeader({
  icon: Icon,
  title,
  description,
  action,
}: SectionCardHeaderProps) {
  return (
    <CardHeader>
      <div className="flex items-center gap-2">
        <Icon className="h-5 w-5" />
        <CardTitle>{title}</CardTitle>
      </div>
      <CardDescription>{description}</CardDescription>
      {action && <CardAction>{action}</CardAction>}
    </CardHeader>
  );
}
