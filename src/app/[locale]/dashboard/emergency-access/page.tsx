"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { useSession } from "next-auth/react";
import { HeartPulse, Users, Shield, ChevronDown } from "lucide-react";
import { CreateGrantDialog } from "@/components/emergency-access/create-grant-dialog";
import { GrantCard } from "@/components/emergency-access/grant-card";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { SectionCardHeader } from "@/components/settings/account/section-card-header";
import type { EaStatusValue } from "@/lib/constants";
import { API_PATH, EA_STATUS } from "@/lib/constants";
import { fetchApi } from "@/lib/url-helpers";

interface Grant {
  id: string;
  ownerId: string;
  granteeId: string | null;
  granteeEmail: string;
  status: EaStatusValue;
  waitDays: number;
  token?: string;
  requestedAt: string | null;
  waitExpiresAt: string | null;
  createdAt: string;
  owner: { id: string; name: string | null; email: string | null };
  grantee: { id: string; name: string | null; email: string | null } | null;
}

export default function EmergencyAccessPage() {
  const t = useTranslations("EmergencyAccess");
  const { data: session } = useSession();
  const [grants, setGrants] = useState<Grant[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInactiveOwner, setShowInactiveOwner] = useState(false);
  const [showInactiveGrantee, setShowInactiveGrantee] = useState(false);

  const fetchGrants = useCallback(async () => {
    try {
      const res = await fetchApi(API_PATH.EMERGENCY_ACCESS);
      if (res.ok) {
        setGrants(await res.json());
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchGrants();
  }, [fetchGrants]);

  if (!session?.user?.id) return null;
  const userId = session.user.id;

  const isTerminal = (s: EaStatusValue) =>
    s === EA_STATUS.REVOKED || s === EA_STATUS.REJECTED;

  const ownerGrants = grants.filter((g) => g.ownerId === userId);
  const granteeGrants = grants.filter((g) => g.ownerId !== userId);

  const activeOwner = ownerGrants.filter((g) => !isTerminal(g.status));
  const inactiveOwner = ownerGrants.filter((g) => isTerminal(g.status));
  const activeGrantee = granteeGrants.filter((g) => !isTerminal(g.status));
  const inactiveGrantee = granteeGrants.filter((g) => isTerminal(g.status));

  return (
    <div className="flex-1 overflow-auto p-4 md:p-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <Card className="rounded-xl border bg-gradient-to-b from-muted/30 to-background p-4">
          <div className="flex items-center gap-3">
            <HeartPulse className="h-6 w-6" />
            <div>
              <h1 className="text-2xl font-bold">{t("title")}</h1>
              <p className="text-sm text-muted-foreground">{t("description")}</p>
            </div>
          </div>
        </Card>

        <Card>
          <SectionCardHeader
            icon={Users}
            title={t("trustedContacts")}
            description={t("trustedContactsDesc")}
            action={<CreateGrantDialog onCreated={fetchGrants} />}
          />
          <CardContent className="space-y-4">
            {loading ? (
              <div className="py-8 text-center text-muted-foreground">...</div>
            ) : ownerGrants.length === 0 ? (
              <div className="rounded-lg border border-dashed p-8 text-center">
                <p className="text-muted-foreground">{t("noGrants")}</p>
                <p className="text-xs text-muted-foreground">{t("noGrantsDesc")}</p>
              </div>
            ) : (
              <div className="space-y-2">
                {activeOwner.length === 0 && inactiveOwner.length > 0 && (
                  <div className="rounded-lg border border-dashed p-8 text-center">
                    <p className="text-muted-foreground">{t("noGrants")}</p>
                    <p className="text-xs text-muted-foreground">{t("noGrantsDesc")}</p>
                  </div>
                )}
                {activeOwner.map((grant) => (
                  <GrantCard
                    key={grant.id}
                    grant={grant}
                    currentUserId={userId}
                    onRefresh={fetchGrants}
                  />
                ))}
                {inactiveOwner.length > 0 && (
                  <div>
                    <button
                      type="button"
                      onClick={() => setShowInactiveOwner((v) => !v)}
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <ChevronDown
                        className={`h-3 w-3 transition-transform ${showInactiveOwner ? "rotate-0" : "-rotate-90"}`}
                      />
                      {t("inactiveGrants", { count: String(inactiveOwner.length) })}
                    </button>
                    {showInactiveOwner && (
                      <div className="mt-2 space-y-2">
                        {inactiveOwner.map((grant) => (
                          <GrantCard
                            key={grant.id}
                            grant={grant}
                            currentUserId={userId}
                            onRefresh={fetchGrants}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <SectionCardHeader
            icon={Shield}
            title={t("trustedByOthers")}
            description={t("trustedByOthersDesc")}
          />
          <CardContent className="space-y-4">
            {loading ? (
              <div className="py-8 text-center text-muted-foreground">...</div>
            ) : granteeGrants.length === 0 ? (
              <div className="rounded-lg border border-dashed p-8 text-center">
                <p className="text-muted-foreground">{t("noTrustedBy")}</p>
              </div>
            ) : (
              <div className="space-y-2">
                {activeGrantee.length === 0 && inactiveGrantee.length > 0 && (
                  <div className="rounded-lg border border-dashed p-8 text-center">
                    <p className="text-muted-foreground">{t("noTrustedBy")}</p>
                  </div>
                )}
                {activeGrantee.map((grant) => (
                  <GrantCard
                    key={grant.id}
                    grant={grant}
                    currentUserId={userId}
                    onRefresh={fetchGrants}
                  />
                ))}
                {inactiveGrantee.length > 0 && (
                  <div>
                    <button
                      type="button"
                      onClick={() => setShowInactiveGrantee((v) => !v)}
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <ChevronDown
                        className={`h-3 w-3 transition-transform ${showInactiveGrantee ? "rotate-0" : "-rotate-90"}`}
                      />
                      {t("inactiveGrants", { count: String(inactiveGrantee.length) })}
                    </button>
                    {showInactiveGrantee && (
                      <div className="mt-2 space-y-2">
                        {inactiveGrantee.map((grant) => (
                          <GrantCard
                            key={grant.id}
                            grant={grant}
                            currentUserId={userId}
                            onRefresh={fetchGrants}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
