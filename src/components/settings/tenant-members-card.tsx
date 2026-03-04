"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { Loader2, Users } from "lucide-react";
import { fetchApi } from "@/lib/url-helpers";
import { API_PATH } from "@/lib/constants";
import { useTenantRole } from "@/hooks/use-tenant-role";
import { TenantVaultResetButton } from "./tenant-vault-reset-button";
import { TenantResetHistoryDialog } from "./tenant-reset-history-dialog";

interface TenantMember {
  id: string;
  userId: string;
  role: string;
  deactivatedAt: string | null;
  name: string | null;
  email: string | null;
  image: string | null;
  pendingResets: number;
}

const ROLE_LABEL: Record<string, string> = {
  OWNER: "roleOwner",
  ADMIN: "roleAdmin",
  MEMBER: "roleMember",
};

const ROLE_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  OWNER: "default",
  ADMIN: "secondary",
  MEMBER: "outline",
};

function initials(name: string | null, email: string | null): string {
  if (name) {
    return name
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase();
  }
  return (email?.[0] ?? "?").toUpperCase();
}

/** ROLE_LEVEL mirrors tenant-auth.ts hierarchy. */
const ROLE_LEVEL: Record<string, number> = {
  OWNER: 30,
  ADMIN: 20,
  MEMBER: 10,
};

export function TenantMembersCard() {
  const t = useTranslations("TenantAdmin");
  const { role: myRole, isAdmin, loading: roleLoading } = useTenantRole();
  const [members, setMembers] = useState<TenantMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  useEffect(() => {
    fetchApi(API_PATH.AUTH_SESSION)
      .then((r) => r.json())
      .then((d) => setCurrentUserId(d?.user?.id ?? null))
      .catch(() => {});
  }, []);

  const fetchMembers = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetchApi(API_PATH.TENANT_MEMBERS);
      if (!r.ok) throw new Error();
      const d = await r.json();
      if (Array.isArray(d)) setMembers(d);
    } catch {
      setMembers([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAdmin) {
      fetchMembers();
    } else {
      setLoading(false);
    }
  }, [isAdmin, fetchMembers]);

  if (roleLoading || loading) {
    return (
      <Card>
        <CardContent className="flex justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (!isAdmin) return null;

  const myLevel = ROLE_LEVEL[myRole ?? ""] ?? 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5" />
          <div>
            <CardTitle>{t("membersTitle")}</CardTitle>
            <CardDescription>{t("membersDescription")}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {members.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            {t("noMembers")}
          </p>
        ) : (
          <div className="space-y-2">
            {members.map((m) => {
              const isDeactivated = !!m.deactivatedAt;
              const isSelf = m.userId === currentUserId;
              const targetLevel = ROLE_LEVEL[m.role] ?? 0;
              const canReset =
                !isSelf && !isDeactivated && myLevel > targetLevel;

              return (
                <div
                  key={m.id}
                  className={`flex items-center justify-between rounded-md border p-3 ${
                    isDeactivated ? "opacity-50" : ""
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <Avatar className="h-8 w-8">
                      <AvatarImage src={m.image ?? undefined} />
                      <AvatarFallback className="text-xs">
                        {initials(m.name, m.email)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">
                          {m.name ?? m.email ?? "—"}
                        </span>
                        <Badge variant={ROLE_VARIANT[m.role] ?? "outline"}>
                          {t(ROLE_LABEL[m.role] ?? "roleMember")}
                        </Badge>
                        {isDeactivated && (
                          <Badge variant="outline" className="text-muted-foreground">
                            {t("deactivated")}
                          </Badge>
                        )}
                      </div>
                      {m.email && m.name && (
                        <p className="text-xs text-muted-foreground truncate">
                          {m.email}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1">
                    <TenantResetHistoryDialog
                      userId={m.userId}
                      memberName={m.name ?? m.email ?? "—"}
                      pendingResets={m.pendingResets}
                      onRevoke={fetchMembers}
                    />
                    <TenantVaultResetButton
                      userId={m.userId}
                      memberName={m.name ?? m.email ?? "—"}
                      disabled={!canReset}
                      onSuccess={fetchMembers}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
