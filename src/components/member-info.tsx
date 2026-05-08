"use client";

import { useTranslations } from "next-intl";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { Globe } from "lucide-react";

interface MemberInfoProps {
  name: string | null;
  email: string | null;
  image: string | null;
  isCurrentUser?: boolean;
  nameExtra?: React.ReactNode;
  tenantName?: string | null;
  viewerTenantName?: string | null;
  teamTenantName?: string | null;
  children?: React.ReactNode;
}

export function MemberInfo({
  name,
  email,
  image,
  isCurrentUser,
  nameExtra,
  tenantName,
  viewerTenantName,
  teamTenantName,
  children,
}: MemberInfoProps) {
  const t = useTranslations("Team");
  const comparisonTenantName = viewerTenantName ?? teamTenantName;

  return (
    <>
      <Avatar className="h-8 w-8">
        <AvatarImage src={image ?? undefined} />
        <AvatarFallback>
          {(name ?? email ?? "?").charAt(0).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium truncate">
            {name ?? email}
            {isCurrentUser && (
              <span className="text-muted-foreground ml-1">{t("you")}</span>
            )}
          </p>
          {nameExtra}
        </div>
        {name && email && (
          <p className="text-xs text-muted-foreground truncate">{email}</p>
        )}
        {children}
        {tenantName && comparisonTenantName && tenantName !== comparisonTenantName && (
          <p className="text-xs text-amber-600 dark:text-amber-400 truncate flex items-center gap-1">
            <Globe className="h-3 w-3 shrink-0" />
            {tenantName}
          </p>
        )}
      </div>
    </>
  );
}
