"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { useSession } from "next-auth/react";
import { HeartPulse, Users, Shield } from "lucide-react";
import { CreateGrantDialog } from "@/components/emergency-access/create-grant-dialog";
import { GrantCard } from "@/components/emergency-access/grant-card";
import type { EaStatusValue } from "@/lib/constants";
import { API_PATH } from "@/lib/constants";

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

  const fetchGrants = useCallback(async () => {
    try {
      const res = await fetch(API_PATH.EMERGENCY_ACCESS);
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

  const ownerGrants = grants.filter((g) => g.ownerId === userId);
  const granteeGrants = grants.filter((g) => g.ownerId !== userId);

  return (
    <div className="mx-auto max-w-3xl space-y-8 p-4">
      <div className="flex items-center gap-3">
        <HeartPulse className="h-6 w-6" />
        <div>
          <h1 className="text-2xl font-bold">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </div>
      </div>

      {/* Owner section: People I trust */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            <h2 className="text-lg font-semibold">{t("trustedContacts")}</h2>
          </div>
          <CreateGrantDialog onCreated={fetchGrants} />
        </div>
        <p className="text-sm text-muted-foreground">{t("trustedContactsDesc")}</p>

        {loading ? (
          <div className="py-8 text-center text-muted-foreground">...</div>
        ) : ownerGrants.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center">
            <p className="text-muted-foreground">{t("noGrants")}</p>
            <p className="text-xs text-muted-foreground">{t("noGrantsDesc")}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {ownerGrants.map((grant) => (
              <GrantCard
                key={grant.id}
                grant={grant}
                currentUserId={userId}
                onRefresh={fetchGrants}
              />
            ))}
          </div>
        )}
      </section>

      {/* Grantee section: People who trust me */}
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5" />
          <h2 className="text-lg font-semibold">{t("trustedByOthers")}</h2>
        </div>
        <p className="text-sm text-muted-foreground">{t("trustedByOthersDesc")}</p>

        {loading ? (
          <div className="py-8 text-center text-muted-foreground">...</div>
        ) : granteeGrants.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center">
            <p className="text-muted-foreground">{t("noTrustedBy")}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {granteeGrants.map((grant) => (
              <GrantCard
                key={grant.id}
                grant={grant}
                currentUserId={userId}
                onRefresh={fetchGrants}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
