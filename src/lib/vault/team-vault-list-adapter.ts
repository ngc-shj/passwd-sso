"use client";

import { useEffect, useMemo, useRef } from "react";
import { useTranslations } from "next-intl";
import { useTeamVault } from "@/lib/team/team-vault-context";
import { decryptData } from "@/lib/crypto/crypto-client";
import { buildTeamEntryAAD, VAULT_TYPE } from "@/lib/crypto/crypto-aad";
import { buildTeamGetDetail } from "@/lib/vault/build-team-get-detail";
import { fetchApi } from "@/lib/url-helpers";
import { throwIfStepUp } from "@/lib/http/handle-step-up-error";
import { apiPath, ENTRY_TYPE, TEAM_ROLE } from "@/lib/constants";
import type { EntryTypeValue } from "@/lib/constants";
import { notifyTeamDataChanged } from "@/lib/events";
import type { VaultListAdapter, EntryListViewKind, EntryListQuery } from "@/lib/vault/vault-list-adapter";
import type { BulkScope } from "@/hooks/bulk/use-bulk-action";
import type { TeamDisplayEntry } from "@/types/team-display-entry";

/** Per-entry key material carried on each team row, used to derive its ItemKey. */
type GetEntryDecryptionKey = (
  teamId: string,
  entryId: string,
  entry: {
    itemKeyVersion?: number;
    encryptedItemKey?: string;
    itemKeyIv?: string;
    itemKeyAuthTag?: string;
    teamKeyVersion: number;
  },
) => Promise<CryptoKey>;

/**
 * C6 — decryptTeamOverview
 *
 * The SINGLE site that derives the team OVERVIEW-scope AAD and maps a raw server
 * entry → TeamDisplayEntry (INV-C6.2 / S1). Consolidates the three previously
 * identical decrypt sites (team page, TeamArchivedList, TeamTrashList).
 *
 * Decrypt-failure policy (F6): returns a "(decryption failed)" PLACEHOLDER entry
 * (NOT skip), so the row count stays stable and the key-distribution problem
 * remains visible — preserving today's team behavior.
 */
export async function decryptTeamOverview(
  teamId: string,
  rawEntry: Record<string, unknown>,
  deps: { getEntryDecryptionKey: GetEntryDecryptionKey },
): Promise<TeamDisplayEntry> {
  const entryId = rawEntry.id as string;
  const entryType = (rawEntry.entryType ?? ENTRY_TYPE.LOGIN) as EntryTypeValue;

  // Common metadata present on both success and failure paths.
  const base = {
    id: entryId,
    entryType,
    requireReprompt: (rawEntry.requireReprompt as boolean) ?? false,
    expiresAt: (rawEntry.expiresAt as string | null) ?? null,
    isFavorite: (rawEntry.isFavorite as boolean) ?? false,
    isArchived: (rawEntry.isArchived as boolean) ?? false,
    tags: (rawEntry.tags ?? []) as TeamDisplayEntry["tags"],
    createdBy: rawEntry.createdBy as TeamDisplayEntry["createdBy"],
    updatedBy: rawEntry.updatedBy as TeamDisplayEntry["updatedBy"],
    createdAt: rawEntry.createdAt as string,
    updatedAt: rawEntry.updatedAt as string,
    // INV-C1.5: deletedAt present only for trash rows.
    ...(rawEntry.deletedAt != null ? { deletedAt: rawEntry.deletedAt as string } : {}),
  };

  try {
    const itemKeyVersion = (rawEntry.itemKeyVersion as number) ?? 0;
    const decryptKey = await deps.getEntryDecryptionKey(teamId, entryId, {
      itemKeyVersion,
      encryptedItemKey: rawEntry.encryptedItemKey as string | undefined,
      itemKeyIv: rawEntry.itemKeyIv as string | undefined,
      itemKeyAuthTag: rawEntry.itemKeyAuthTag as string | undefined,
      teamKeyVersion: (rawEntry.teamKeyVersion as number) ?? 1,
    });
    // INV-C6.2: the ONLY team "overview"-scope AAD derivation site.
    const aad = buildTeamEntryAAD(teamId, entryId, VAULT_TYPE.OVERVIEW, itemKeyVersion);
    const overview = JSON.parse(
      await decryptData(
        {
          ciphertext: rawEntry.encryptedOverview as string,
          iv: rawEntry.overviewIv as string,
          authTag: rawEntry.overviewAuthTag as string,
        },
        decryptKey,
        aad,
      ),
    );

    return {
      ...base,
      title: overview.title ?? "",
      username: overview.username ?? null,
      urlHost: overview.urlHost ?? null,
      snippet: overview.snippet ?? null,
      brand: overview.brand ?? null,
      lastFour: overview.lastFour ?? null,
      cardholderName: overview.cardholderName ?? null,
      fullName: overview.fullName ?? null,
      idNumberLast4: overview.idNumberLast4 ?? null,
      relyingPartyId: overview.relyingPartyId ?? null,
      bankName: overview.bankName ?? null,
      accountNumberLast4: overview.accountNumberLast4 ?? null,
      softwareName: overview.softwareName ?? null,
      licensee: overview.licensee ?? null,
      keyType: overview.keyType ?? null,
      fingerprint: overview.fingerprint ?? null,
    };
  } catch {
    // F6: placeholder, do NOT skip.
    return {
      ...base,
      title: "(decryption failed)",
      username: null,
      urlHost: null,
      snippet: null,
      brand: null,
      lastFour: null,
      cardholderName: null,
      fullName: null,
      idNumberLast4: null,
      relyingPartyId: null,
      bankName: null,
      accountNumberLast4: null,
      softwareName: null,
      licensee: null,
      keyType: null,
      fingerprint: null,
    };
  }
}

/**
 * C6 — useTeamVaultListAdapter
 *
 * Returns a VaultListAdapter<TeamDisplayEntry> for a team vault, reproducing the
 * team page + TeamArchivedList + TeamTrashList data layer (F-R1/F-R2).
 *
 * Availability: the team page gates on its own key probe (banner XOR list), so the
 * adapter reports ready:true — EntryListView only mounts once the key is available.
 * Permissions (page.tsx:303-306 verbatim): canCreate/canEdit = OWNER|ADMIN|MEMBER,
 * canDelete = OWNER|ADMIN, canShare = canEdit; VIEWER all-false.
 * Favorites are KEPT for team (deviation from the locked plan, user-approved):
 * supportsFavorite = true, setFavorite hits teamPasswordFavorite.
 */
export function useTeamVaultListAdapter(teamId: string, role: string): VaultListAdapter<TeamDisplayEntry> {
  const { getTeamEncryptionKey, getEntryDecryptionKey } = useTeamVault();
  const t = useTranslations("Team");

  // getTeamEncryptionKey / getEntryDecryptionKey are session-derived and change
  // identity on every next-auth re-render. Hold them in refs so the adapter memo
  // stays stable (depends only on teamId/role/t) and does not re-fetch the whole
  // list on every background session refresh.
  const getTeamKeyRef = useRef(getTeamEncryptionKey);
  const getEntryKeyRef = useRef(getEntryDecryptionKey);
  useEffect(() => {
    getTeamKeyRef.current = getTeamEncryptionKey;
    getEntryKeyRef.current = getEntryDecryptionKey;
  });

  return useMemo(() => {
    const canEdit =
      role === TEAM_ROLE.OWNER || role === TEAM_ROLE.ADMIN || role === TEAM_ROLE.MEMBER;
    const canDelete = role === TEAM_ROLE.OWNER || role === TEAM_ROLE.ADMIN;

    const adapter: VaultListAdapter<TeamDisplayEntry> = {
      kind: "team",
      teamId,
      availability: { ready: true },
      permissions: {
        canCreate: canEdit,
        canEdit,
        canDelete,
        canShare: canEdit,
      },
      supportsFavorite: true,

      async fetchOverviewEntries(
        view: EntryListViewKind,
        query: EntryListQuery,
        signal: AbortSignal,
      ): Promise<TeamDisplayEntry[]> {
        const teamKey = await getTeamKeyRef.current(teamId);
        if (!teamKey) return [];

        const params = new URLSearchParams();
        if (query.tagId) params.set("tag", query.tagId);
        if (query.folderId) params.set("folder", query.folderId);
        if (query.entryType) params.set("type", query.entryType);
        if (view === "favorites") params.set("favorites", "true");
        if (view === "archive") params.set("archived", "true");
        if (view === "trash") params.set("trash", "true");

        const qs = params.toString();
        const url = `${apiPath.teamPasswords(teamId)}${qs ? `?${qs}` : ""}`;
        const res = await fetchApi(url, { signal });
        if (!res.ok) return [];

        const data = await res.json();
        if (!Array.isArray(data)) return [];
        // F6: decrypt-failure → placeholder (do NOT skip), so decrypt in parallel.
        return Promise.all(
          data.map((rawEntry) =>
            decryptTeamOverview(teamId, rawEntry, { getEntryDecryptionKey: getEntryKeyRef.current }),
          ),
        );
      },

      buildGetDetail(entry: TeamDisplayEntry) {
        const getDetail = buildTeamGetDetail(
          teamId,
          { id: entry.id, entryType: entry.entryType },
          { getEntryDecryptionKey: getEntryKeyRef.current },
        );
        return () => getDetail();
      },

      // Accordion PasswordCard "created by" label (INV-C6.1 — team-specific).
      createdByLabel(entry: TeamDisplayEntry) {
        const by = entry.createdBy;
        if (!by?.name) return undefined;
        return t("createdBy", { name: by.email ? `${by.name} (${by.email})` : by.name });
      },

      // INV-C1.4: network-only mutations; view owns optimistic removal + notify.

      async setFavorite(entry: TeamDisplayEntry, _next: boolean): Promise<void> {
        const res = await fetchApi(apiPath.teamPasswordFavorite(teamId, entry.id), {
          method: "POST",
        });
        if (!res.ok) throw new Error("setFavorite failed");
      },

      async setArchived(entry: TeamDisplayEntry, next: boolean): Promise<void> {
        const res = await fetchApi(apiPath.teamPasswordById(teamId, entry.id), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isArchived: next }),
        });
        if (!res.ok) throw new Error("setArchived failed");
      },

      async softDelete(entry: TeamDisplayEntry): Promise<void> {
        const res = await fetchApi(apiPath.teamPasswordById(teamId, entry.id), { method: "DELETE" });
        if (!res.ok) throw new Error("softDelete failed");
      },

      async restore(entry: TeamDisplayEntry): Promise<void> {
        const res = await fetchApi(apiPath.teamPasswordRestore(teamId, entry.id), { method: "POST" });
        if (!res.ok) throw new Error("restore failed");
      },

      async deletePermanently(entry: TeamDisplayEntry): Promise<void> {
        // @stepup id:team-password-id-delete-permanent
        const res = await fetchApi(`${apiPath.teamPasswordById(teamId, entry.id)}?permanent=true`, {
          method: "DELETE",
        });
        await throwIfStepUp(res);
        if (!res.ok) throw new Error("deletePermanently failed");
      },

      async emptyTrash(): Promise<void> {
        // @stepup id:team-password-empty-trash
        const res = await fetchApi(apiPath.teamPasswordsEmptyTrash(teamId), { method: "POST" });
        await throwIfStepUp(res);
        if (!res.ok) throw new Error("emptyTrash failed");
      },

      notifyDataChanged() {
        notifyTeamDataChanged();
      },

      bulkScope(_view: EntryListViewKind): BulkScope {
        return { type: "team", teamId };
      },
    };
    return adapter;
  }, [teamId, role, t]);
}
