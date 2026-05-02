"use client";

import { useEffect, useState, useRef, useCallback } from "react";
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

interface TenantMemberResult {
  userId: string;
  name: string | null;
  email: string | null;
  image: string | null;
}

interface Props {
  teamId: string;
  onSuccess: () => void;
}

export function TeamAddFromTenantSection({ teamId, onSuccess }: Props) {
  const t = useTranslations("Team");
  const [addSearch, setAddSearch] = useState("");
  const [addRole, setAddRole] = useState<string>(TEAM_ROLE.MEMBER);
  const [adding, setAdding] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<TenantMemberResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

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
      fetchApi(
        `${apiPath.teamMembersSearch(teamId)}?q=${encodeURIComponent(addSearch.trim())}`,
        { signal: controller.signal },
      )
        .then((r) => r.json())
        .then((d) => {
          if (!controller.signal.aborted) {
            setSearchResults(Array.isArray(d) ? d : []);
            setSearchLoading(false);
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setSearchResults([]);
            setSearchLoading(false);
          }
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      abortRef.current?.abort();
    };
  }, [addSearch, teamId]);

  const handleAddMember = useCallback(async (userId: string) => {
    setAdding(userId);
    try {
      const res = await fetchApi(apiPath.teamMembers(teamId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, role: addRole }),
      });
      if (res.status === 409) {
        const data = await res.json();
        toast.error(
          data.error === "SCIM_MANAGED_MEMBER"
            ? t("scimManagedCannotAdd")
            : t("alreadyMember"),
        );
        setAdding(null);
        return;
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
  }, [teamId, addRole, t, onSuccess]);

  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-sm font-medium">{t("addFromTenantLabel")}</h3>
        <p className="text-xs text-muted-foreground mt-0.5">{t("addFromTenantDesc")}</p>
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
  );
}
