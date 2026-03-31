"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Card, CardContent } from "@/components/ui/card";
import { SectionCardHeader } from "@/components/settings/section-card-header";
import { Badge } from "@/components/ui/badge";
import { MemberInfo } from "@/components/member-info";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Loader2, Search, Users } from "lucide-react";
import { toast } from "sonner";
import { fetchApi } from "@/lib/url-helpers";
import { filterMembers } from "@/lib/filter-members";
import { API_PATH, apiPath } from "@/lib/constants";
import { useTenantRole } from "@/hooks/use-tenant-role";
import { TenantVaultResetButton } from "./tenant-vault-reset-button";
import { TenantResetHistoryDialog } from "./tenant-reset-history-dialog";

interface TenantMember {
  id: string;
  userId: string;
  role: string;
  deactivatedAt: string | null;
  scimManaged: boolean;
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

/** ROLE_LEVEL mirrors tenant-auth.ts hierarchy. */
const ROLE_LEVEL: Record<string, number> = {
  OWNER: 30,
  ADMIN: 20,
  MEMBER: 10,
};

export function TenantMembersCard() {
  const t = useTranslations("TenantAdmin");
  const { role: myRole, isAdmin, loading: roleLoading } = useTenantRole();
  const isOwner = myRole === "OWNER";
  const [members, setMembers] = useState<TenantMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

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

  const handleChangeRole = useCallback(async (userId: string, newRole: string) => {
    try {
      const res = await fetchApi(apiPath.tenantMemberById(userId), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: newRole }),
      });
      if (!res.ok) {
        if (res.status === 409) {
          toast.error(t("scimManagedRoleError"));
        } else {
          toast.error(t("roleChangeFailed"));
        }
        return;
      }
      toast.success(t("roleChanged"));
      fetchMembers();
    } catch {
      toast.error(t("roleChangeFailed"));
    }
  }, [t, fetchMembers]);

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
  const filteredMembers = filterMembers(members, searchQuery);

  return (
    <Card>
      <SectionCardHeader icon={Users} title={t("membersTitle")} description={t("membersDescription")} />
      <CardContent>
        {members.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            {t("noMembers")}
          </p>
        ) : (
          <>
            <div className="relative mb-3">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder={t("searchMembers")}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            {filteredMembers.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                {t("noMatchingMembers")}
              </p>
            ) : (
          <div className="max-h-96 space-y-2 overflow-y-auto">
            {filteredMembers.map((m) => {
              const isDeactivated = !!m.deactivatedAt;
              const isSelf = m.userId === currentUserId;
              const targetLevel = ROLE_LEVEL[m.role] ?? 0;
              const canReset =
                !isSelf && !isDeactivated && myLevel > targetLevel;
              const canChangeRole =
                isOwner && !isSelf && !isDeactivated && m.role !== "OWNER" && !m.scimManaged;

              return (
                <div
                  key={m.id}
                  className={`flex items-center justify-between rounded-md border p-3 ${
                    isDeactivated ? "opacity-50" : ""
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <MemberInfo
                      name={m.name}
                      email={m.email}
                      image={m.image}
                      nameExtra={
                        <>
                          {!canChangeRole && (
                            <Badge variant={ROLE_VARIANT[m.role] ?? "outline"}>
                              {t(ROLE_LABEL[m.role] ?? "roleMember")}
                            </Badge>
                          )}
                          {isDeactivated && (
                            <Badge variant="outline" className="text-muted-foreground">
                              {t("deactivated")}
                            </Badge>
                          )}
                        </>
                      }
                    />
                  </div>

                  <div className="flex items-center gap-1">
                    {canChangeRole && (
                      <Select value={m.role} onValueChange={(v) => handleChangeRole(m.userId, v)}>
                        <SelectTrigger className="w-28 h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="ADMIN">{t("roleAdmin")}</SelectItem>
                          <SelectItem value="MEMBER">{t("roleMember")}</SelectItem>
                        </SelectContent>
                      </Select>
                    )}
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
          </>
        )}
      </CardContent>
    </Card>
  );
}
