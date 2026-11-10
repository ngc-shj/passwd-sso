"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Fingerprint, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { fetchApi } from "@/lib/url-helpers";
import { apiPath } from "@/lib/constants";
import { formatDateTime } from "@/lib/format/format-datetime";
import { handleStepUpError } from "@/lib/http/handle-step-up-error";
import { useInlineReauth } from "@/hooks/auth/use-inline-reauth";
import { RecentSessionRequiredDialog } from "@/components/auth/recent-session-required-dialog";
import { PasskeyReauthDialog } from "@/components/auth/passkey-reauth-dialog";

interface MemberPasskey {
  id: string;
  nickname: string | null;
  deviceType: string;
  registeredDevice: string | null;
  registeredInTenant: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

interface LinkedAccount {
  id: string;
  provider: string;
  linkedHere: boolean;
}

// The footholds a member created, as GET lists them (member-containment.ts);
// a kind the admin may not contain is absent.
interface CreatedFootholds {
  scimTokens?: { id: string; description: string | null; createdAt: string }[];
  serviceAccounts?: { id: string; name: string }[];
  serviceAccountTokens?: { id: string; name: string; serviceAccount: { name: string } }[];
  mcpClients?: { id: string; name: string }[];
  breakglassGrants?: { id: string; reason: string; expiresAt: string }[];
  emergencyAccessGrants?: { id: string; granteeEmail: string; status: string; hasEscrow: boolean }[];
}

type FootholdKind = keyof CreatedFootholds;

// The display order, the server's write order, and the body key per kind.
const FOOTHOLD_KINDS = [
  ["scimTokens", "scimTokenIds", "containmentKindScimTokens"],
  ["serviceAccounts", "serviceAccountIds", "containmentKindServiceAccounts"],
  ["serviceAccountTokens", "serviceAccountTokenIds", "containmentKindServiceAccountTokens"],
  ["mcpClients", "mcpClientIds", "containmentKindMcpClients"],
  ["breakglassGrants", "breakglassGrantIds", "containmentKindBreakglassGrants"],
  ["emergencyAccessGrants", "emergencyAccessGrantIds", "containmentKindEmergencyAccessGrants"],
] as const satisfies readonly (readonly [FootholdKind, string, string])[];

/** A selectable row: its kind ("accounts" or a foothold kind), id and label. */
interface ContainmentItem {
  kind: "accounts" | FootholdKind;
  id: string;
  label: string;
  detail?: string;
}

const itemKey = (item: Pick<ContainmentItem, "kind" | "id">) => `${item.kind}:${item.id}`;

// Each kind's short name, for the warning naming kinds with skipped rows.
const CONTAINMENT_KIND_NAME = {
  accounts: "containmentNameAccounts",
  scimTokens: "containmentNameScimTokens",
  serviceAccounts: "containmentNameServiceAccounts",
  serviceAccountTokens: "containmentNameServiceAccountTokens",
  mcpClients: "containmentNameMcpClients",
  breakglassGrants: "containmentNameBreakglassGrants",
  emergencyAccessGrants: "containmentNameEmergencyAccessGrants",
} as const satisfies Record<ContainmentItem["kind"], string>;

/** Per kind the request named, as DELETE answers it (member-containment.ts). */
type ContainedCounts = Partial<Record<ContainmentItem["kind"], { revoked: number; skipped: number }>>;

interface TenantMemberPasskeysDialogProps {
  userId: string;
  memberName: string;
  disabled?: boolean;
}

// A tenant admin's view of a member's passkeys, to revoke a compromised one, or
// all of them when the account may be compromised (#974). Revoking also signs
// the member out everywhere (passkeys are user-global). Revoke-all also lists
// the member's linked accounts and the footholds they created; the ones the
// admin ticks are unlinked or revoked in the same step (#1016). Nothing ticked
// sends no body.
export function TenantMemberPasskeysDialog({ userId, memberName, disabled }: TenantMemberPasskeysDialogProps) {
  const t = useTranslations("TenantAdmin");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [passkeys, setPasskeys] = useState<MemberPasskey[] | null>(null);
  const [linkedAccounts, setLinkedAccounts] = useState<LinkedAccount[]>([]);
  const [footholds, setFootholds] = useState<CreatedFootholds>({});
  // Ticked rows, by itemKey: none by default.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [loadFailed, setLoadFailed] = useState(false);
  // The passkey to revoke, or "all" of them.
  const [target, setTarget] = useState<MemberPasskey | "all" | null>(null);
  const [revoking, setRevoking] = useState(false);

  // `keepSelection`: after a failed revoke, keep what the admin ticked that is
  // still listed, so a retry does not silently drop it.
  const load = useCallback(async ({ keepSelection = false }: { keepSelection?: boolean } = {}) => {
    setLoadFailed(false);
    try {
      const res = await fetchApi(apiPath.tenantMemberPasskeys(userId));
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as {
        passkeys: MemberPasskey[];
        linkedAccounts?: LinkedAccount[];
        createdFootholds?: CreatedFootholds;
      };
      setPasskeys(body.passkeys);
      setLinkedAccounts(body.linkedAccounts ?? []);
      setFootholds(body.createdFootholds ?? {});
      const listed = new Set([
        ...(body.linkedAccounts ?? []).map((a) => itemKey({ kind: "accounts", id: a.id })),
        ...FOOTHOLD_KINDS.flatMap(([kind]) =>
          ((body.createdFootholds ?? {})[kind] ?? []).map((r) => itemKey({ kind, id: r.id })),
        ),
      ]);
      setSelected((prev) => (keepSelection ? new Set([...prev].filter((key) => listed.has(key))) : new Set()));
    } catch {
      setLoadFailed(true);
    }
  }, [userId]);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setPasskeys(null);
      void load();
    }
  };

  // Inline step-up reauth, as the clear-lockout button: the confirm dialog
  // stays open through a stale session and the hook re-runs the revoke.
  const revokeRetryRef = useRef<() => Promise<void>>(async () => {});
  const inlineReauth = useInlineReauth(() => revokeRetryRef.current());

  const revokeAll = target === "all";

  const accountItems: ContainmentItem[] = linkedAccounts.map((a) => ({
    kind: "accounts",
    id: a.id,
    label: a.provider,
    detail: a.linkedHere ? undefined : t("containmentLinkedAccountOtherTenant"),
  }));
  const footholdItems = (kind: FootholdKind): ContainmentItem[] => {
    switch (kind) {
      case "scimTokens":
        return (footholds.scimTokens ?? []).map((r) => ({
          kind,
          id: r.id,
          label: r.description ?? t("containmentScimTokenUnnamed"),
          detail: formatDateTime(r.createdAt, locale),
        }));
      case "serviceAccounts":
        return (footholds.serviceAccounts ?? []).map((r) => ({ kind, id: r.id, label: r.name }));
      case "serviceAccountTokens":
        return (footholds.serviceAccountTokens ?? []).map((r) => ({
          kind,
          id: r.id,
          label: r.name,
          detail: r.serviceAccount.name,
        }));
      case "mcpClients":
        return (footholds.mcpClients ?? []).map((r) => ({ kind, id: r.id, label: r.name }));
      case "breakglassGrants":
        return (footholds.breakglassGrants ?? []).map((r) => ({
          kind,
          id: r.id,
          label: r.reason,
          detail: t("containmentExpires", { date: formatDateTime(r.expiresAt, locale) }),
        }));
      case "emergencyAccessGrants":
        return (footholds.emergencyAccessGrants ?? []).map((r) => ({
          kind,
          id: r.id,
          label: r.granteeEmail,
          detail: r.hasEscrow ? t("containmentEscrowed") : undefined,
        }));
    }
  };
  const footholdSections = FOOTHOLD_KINDS.map(([kind, , heading]) => ({ kind, heading, items: footholdItems(kind) })).filter(
    (section) => section.items.length > 0,
  );
  const chosen = [...accountItems, ...footholdSections.flatMap((section) => section.items)].filter((item) =>
    selected.has(itemKey(item)),
  );
  const chosenKinds = new Set(chosen.map((item) => item.kind));

  const toggle = (item: ContainmentItem, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(itemKey(item));
      else next.delete(itemKey(item));
      return next;
    });
  };

  // Exactly the ticked ids, per kind; null when nothing is ticked.
  const containmentBody = () => {
    if (chosen.length === 0) return null;
    const ids = (kind: ContainmentItem["kind"]) => chosen.filter((item) => item.kind === kind).map((item) => item.id);
    const revoke = Object.fromEntries(
      FOOTHOLD_KINDS.map(([kind, key]) => [key, ids(kind)] as const).filter(([, list]) => list.length > 0),
    );
    const unlinkAccountIds = ids("accounts");
    return {
      ...(unlinkAccountIds.length > 0 ? { unlinkAccountIds } : {}),
      ...(Object.keys(revoke).length > 0 ? { revoke } : {}),
    };
  };

  // Ticked rows the server did not change (no longer live, or not the
  // member's): name their kinds, so the admin does not take them as contained.
  const warnSkipped = (body: { contained?: ContainedCounts } | null) => {
    const kinds = (Object.keys(CONTAINMENT_KIND_NAME) as ContainmentItem["kind"][]).filter(
      (kind) => (body?.contained?.[kind]?.skipped ?? 0) > 0,
    );
    if (kinds.length === 0) return;
    const names = new Intl.ListFormat(locale, { type: "conjunction" }).format(kinds.map((kind) => t(CONTAINMENT_KIND_NAME[kind])));
    toast.warning(t("containmentSkipped", { kinds: names }), { duration: Infinity });
  };

  const handleRevoke = async () => {
    if (!target) return;
    setRevoking(true);
    const failed = revokeAll ? t("revokeAllPasskeysFailed") : t("revokePasskeyFailed");
    const body = target === "all" ? containmentBody() : null;
    try {
      const res =
        target === "all"
          ? // @stepup id:tenant-member-passkeys-delete-all
            await fetchApi(
              apiPath.tenantMemberPasskeys(userId),
              body
                ? { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
                : { method: "DELETE" },
            )
          : // @stepup id:tenant-member-passkey-delete
            await fetchApi(apiPath.tenantMemberPasskeyById(userId, target.id), { method: "DELETE" });
      if (res.ok) {
        // Neutral: revoke-all succeeds for a member with no passkeys too.
        toast.success(revokeAll ? t("revokeAllPasskeysDone", { name: memberName }) : t("revokePasskeySuccess"));
        if (revokeAll) warnSkipped(await res.json().catch(() => null));
        setTarget(null);
        await load();
        return;
      }
      if (await handleStepUpError(res, inlineReauth.triggerOnStaleError)) return;
      toast.error(failed);
      // The passkeys may be gone already (a concurrent revoke answers 404).
      setTarget(null);
      await load({ keepSelection: true });
    } catch {
      toast.error(failed);
    } finally {
      setRevoking(false);
    }
  };

  useEffect(() => {
    revokeRetryRef.current = () => handleRevoke();
  });

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8" disabled={disabled} title={t("memberPasskeysTitle")}>
          <Fingerprint className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("memberPasskeysTitle")}</DialogTitle>
          <DialogDescription>{t("memberPasskeysDescription", { name: memberName })}</DialogDescription>
        </DialogHeader>
        {loadFailed ? (
          <p className="text-sm text-destructive">{t("memberPasskeysLoadFailed")}</p>
        ) : passkeys === null ? (
          <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
        ) : (
          <div className="max-h-[60vh] min-w-0 space-y-2 overflow-y-auto">
            {passkeys.length === 0 && <p className="text-sm text-muted-foreground">{t("memberPasskeysEmpty")}</p>}
            {passkeys.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-2 rounded-md border p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{p.nickname ?? p.registeredDevice ?? p.deviceType}</p>
                  {!p.registeredInTenant && (
                    <p className="text-xs text-muted-foreground">{t("memberPasskeyOtherTenant")}</p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {t("memberPasskeyLastUsed", {
                      date: p.lastUsedAt ? formatDateTime(p.lastUsedAt, locale) : t("memberPasskeyNeverUsed"),
                    })}
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={() => setTarget(p)}>
                  {t("revokePasskey")}
                </Button>
              </div>
            ))}
            {accountItems.length > 0 && (
              <ContainmentSection heading={t("containmentLinkedAccounts")} items={accountItems} selected={selected} onToggle={toggle} />
            )}
            {footholdSections.length > 0 && (
              <p className="pt-2 text-sm font-medium">{t("containmentFootholds", { name: memberName })}</p>
            )}
            {footholdSections.map((section) => (
              <ContainmentSection
                key={section.kind}
                heading={t(section.heading)}
                items={section.items}
                selected={selected}
                onToggle={toggle}
              />
            ))}
            <p className="text-xs text-muted-foreground">{t("containmentDeactivateNote")}</p>
            <p className="text-xs text-muted-foreground">{t("containmentScope")}</p>
            <div className="flex justify-end pt-2">
              <Button variant="destructive" size="sm" onClick={() => setTarget("all")}>
                {t("revokeAllPasskeys")}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>

      <AlertDialog open={!!target} onOpenChange={(o) => !o && setTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{revokeAll ? t("revokeAllPasskeysTitle") : t("revokePasskeyTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {revokeAll
                ? t("revokeAllPasskeysDescription", { name: memberName })
                : t("revokePasskeyDescription", { name: memberName })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {revokeAll && chosen.length > 0 && (
            <div className="min-w-0 space-y-2 text-sm">
              <p className="font-medium">{t("containmentChosen")}</p>
              <ul className="list-disc space-y-1 pl-5" data-testid="containment-chosen">
                {chosen.map((item) => (
                  <li key={itemKey(item)} className="break-all">
                    {item.label}
                  </li>
                ))}
              </ul>
              {chosenKinds.has("accounts") && <p className="text-destructive">{t("containmentUnlinkWarning", { name: memberName })}</p>}
              {(chosenKinds.has("serviceAccounts") || chosenKinds.has("mcpClients")) && (
                <p className="text-destructive">{t("containmentIntegrationsWarning")}</p>
              )}
              {chosenKinds.has("emergencyAccessGrants") && (
                <p className="text-destructive">{t("containmentEmergencyWarning")}</p>
              )}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <Button variant="destructive" onClick={handleRevoke} disabled={revoking}>
              {revoking && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {revokeAll ? t("revokeAllPasskeys") : t("revokePasskey")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <RecentSessionRequiredDialog {...inlineReauth.recentSessionDialogProps} cancelLabel={t("cancel")} />
      <PasskeyReauthDialog {...inlineReauth.reauthDialogProps} cancelLabel={t("cancel")} />
    </Dialog>
  );
}

function ContainmentSection({
  heading,
  items,
  selected,
  onToggle,
}: {
  heading: string;
  items: ContainmentItem[];
  selected: ReadonlySet<string>;
  onToggle: (item: ContainmentItem, checked: boolean) => void;
}) {
  return (
    <fieldset className="min-w-0 space-y-1 rounded-md border p-3">
      <legend className="px-1 text-xs font-medium text-muted-foreground">{heading}</legend>
      {items.map((item) => {
        const id = `containment-${itemKey(item)}`;
        return (
          <div key={itemKey(item)} className="flex min-w-0 items-start gap-2">
            <Checkbox
              id={id}
              checked={selected.has(itemKey(item))}
              onCheckedChange={(checked) => onToggle(item, checked === true)}
              className="mt-0.5"
            />
            <Label htmlFor={id} className="block min-w-0 font-normal leading-snug">
              <span className="break-all">{item.label}</span>
              {item.detail && <span className="block text-xs text-muted-foreground">{item.detail}</span>}
            </Label>
          </div>
        );
      })}
    </fieldset>
  );
}
