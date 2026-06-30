"use client";

import { useEffect, useState, useRef } from "react";
import { useTranslations } from "next-intl";
import { MemberInfo } from "@/components/member-info";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, UserPlus, Search } from "lucide-react";
import { toast } from "sonner";
import { TEAM_ROLE, apiPath } from "@/lib/constants";
import { fetchApi } from "@/lib/url-helpers";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { readApiErrorBody } from "@/lib/http/read-api-error-body";
import { RecentSessionRequiredDialog } from "@/components/auth/recent-session-required-dialog";
import { PasskeyReauthDialog } from "@/components/auth/passkey-reauth-dialog";
import { useInlineReauth } from "@/hooks/auth/use-inline-reauth";

interface TenantMemberResult {
  userId: string;
  name: string | null;
  email: string | null;
  image: string | null;
}

interface Props {
  teamId: string;
  onSuccess: () => void;
  teamTenantName?: string | null;
}

export function TeamAddFromTenantSection({ teamId, onSuccess, teamTenantName }: Props) {
  const t = useTranslations("Team");
  const [addSearch, setAddSearch] = useState("");
  const [addRole, setAddRole] = useState<string>(TEAM_ROLE.MEMBER);
  const [adding, setAdding] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<TenantMemberResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Inline step-up reauth — adding a tenant member is server-side
  // step-up-gated. The retry target remembers which user the admin was adding
  // so the post-reauth retry replays the same add.
  const [reauthAddUserId, setReauthAddUserId] = useState<string | null>(null);
  const inlineReauth = useInlineReauth(async () => {
    const userId = reauthAddUserId;
    setReauthAddUserId(null);
    if (userId) await handleAddMember(userId);
  });

  // Debounced tenant member search
  useEffect(() => {
    if (!addSearch.trim()) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    const timer = setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      (async () => {
        try {
          const res = await fetchApi(
            `${apiPath.teamMembersSearch(teamId)}?q=${encodeURIComponent(addSearch.trim())}`,
            { signal: controller.signal },
          );
          if (!res.ok) throw new Error(`${res.status}`);
          const d = await res.json();
          if (!controller.signal.aborted) {
            setSearchResults(Array.isArray(d) ? d : []);
            setSearchLoading(false);
          }
        } catch {
          if (!controller.signal.aborted) {
            setSearchResults([]);
            setSearchLoading(false);
          }
        }
      })();
    }, 300);
    return () => {
      clearTimeout(timer);
      abortRef.current?.abort();
    };
  }, [addSearch, teamId]);

  const handleAddMember = async (userId: string) => {
    setAdding(userId);
    try {
      const res = await fetchApi(apiPath.teamMembers(teamId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, role: addRole }),
      });
      if (res.status === 409) {
        const body = await readApiErrorBody(res);
        toast.error(
          body?.error === API_ERROR.SCIM_MANAGED_MEMBER
            ? t("scimManagedCannotAdd")
            : t("alreadyMember"),
        );
        setAdding(null);
        return;
      }
      if (res.status === 403) {
        const body = await readApiErrorBody(res);
        if (body?.error === API_ERROR.SESSION_STEP_UP_REQUIRED) {
          setReauthAddUserId(userId);
          await inlineReauth.triggerOnStaleError();
          setAdding(null);
          return;
        }
      }
      if (!res.ok) throw new Error("Failed");
      toast.success(t("memberAdded"));
      setAddSearch("");
      setSearchResults([]);
      onSuccess();
    } catch {
      toast.error(t("addMemberFailed"));
    } finally {
      setAdding(null);
    }
  };

  return (
    <>
    <section className="space-y-4">
      <div>
        <h3 className="text-sm font-medium">{t("addFromTenantLabel")}</h3>
        <p className="text-xs text-muted-foreground mt-0.5">{t("addFromTenantDesc")}</p>
        {teamTenantName && (
          <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
            {t("addFromTenantCrossTenantNote", { tenantName: teamTenantName })}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-3 md:flex-row md:items-end">
        <div className="flex-1 space-y-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder={t("searchTenantMembers")}
              value={addSearch}
              onChange={(e) => setAddSearch(e.target.value)}
              className="pl-9"
            />
          </div>
        </div>
        <div className="space-y-2 md:w-32">
          <Select value={addRole} onValueChange={setAddRole}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={TEAM_ROLE.ADMIN}>{t("roleAdmin")}</SelectItem>
              <SelectItem value={TEAM_ROLE.MEMBER}>{t("roleMember")}</SelectItem>
              <SelectItem value={TEAM_ROLE.VIEWER}>{t("roleViewer")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      {addSearch.trim() && (
        <div className="max-h-64 space-y-2 overflow-y-auto">
          {searchLoading ? (
            <div className="flex justify-center py-4">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : searchResults.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              {t("noTenantMembersFound")}
            </p>
          ) : (
            searchResults.map((u) => (
              <div
                key={u.userId}
                className="flex items-center gap-3 rounded-xl border bg-card/80 p-3 transition-colors hover:bg-accent/30 dark:hover:bg-accent/50"
              >
                <MemberInfo
                  name={u.name}
                  email={u.email}
                  image={u.image}
                />
                <Button
                  size="sm"
                  onClick={() => handleAddMember(u.userId)}
                  disabled={adding === u.userId}
                >
                  {adding === u.userId ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <UserPlus className="h-4 w-4 mr-1" />
                  )}
                  {t("addButton")}
                </Button>
              </div>
            ))
          )}
        </div>
      )}
    </section>

      <RecentSessionRequiredDialog
        {...inlineReauth.recentSessionDialogProps}
        cancelLabel={t("cancel")}
      />
      <PasskeyReauthDialog
        {...inlineReauth.reauthDialogProps}
        onOpenChange={(open) => {
          inlineReauth.reauthDialogProps.onOpenChange(open);
          if (!open) setReauthAddUserId(null);
        }}
        cancelLabel={t("cancel")}
      />
    </>
  );
}
