import { type Dispatch, type SetStateAction, useCallback } from "react";
import { fetchApi } from "@/lib/url-helpers";
import { apiPath } from "@/lib/constants/auth/api-path";
import { notifyTeamDataChanged } from "@/lib/events";

export interface UseTeamEntryMutationsOptions<T extends { id: string }> {
  teamId: string;
  setEntries: Dispatch<SetStateAction<T[]>>;
  refetchEntries: () => void;
}

export interface UseTeamEntryMutationsReturn {
  toggleArchive: (id: string, currentArchived: boolean) => Promise<void>;
  deleteEntry: (id: string) => Promise<void>;
  /** Notify sidebar after a dialog save (refetch + dispatch). */
  handleSaved: () => void;
}

/**
 * Centralizes team entry mutation handlers with automatic sidebar notification.
 *
 * Each mutation: optimistic update → API call → rollback on error → notifyTeamDataChanged().
 * The event dispatch always fires (success and error) to keep sidebar counts in sync.
 */
export function useTeamEntryMutations<T extends { id: string }>({
  teamId,
  setEntries,
  refetchEntries,
}: UseTeamEntryMutationsOptions<T>): UseTeamEntryMutationsReturn {
  const toggleArchive = useCallback(
    async (id: string, currentArchived: boolean) => {
      setEntries((prev) => prev.filter((e) => e.id !== id));
      try {
        const res = await fetchApi(apiPath.teamPasswordById(teamId, id), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isArchived: !currentArchived }),
        });
        if (!res.ok) refetchEntries();
      } catch {
        refetchEntries();
      } finally {
        notifyTeamDataChanged();
      }
    },
    [teamId, setEntries, refetchEntries],
  );

  const deleteEntry = useCallback(
    async (id: string) => {
      setEntries((prev) => prev.filter((e) => e.id !== id));
      try {
        const res = await fetchApi(apiPath.teamPasswordById(teamId, id), {
          method: "DELETE",
        });
        if (!res.ok) refetchEntries();
      } catch {
        refetchEntries();
      } finally {
        notifyTeamDataChanged();
      }
    },
    [teamId, setEntries, refetchEntries],
  );

  const handleSaved = useCallback(() => {
    refetchEntries();
    notifyTeamDataChanged();
  }, [refetchEntries]);

  return { toggleArchive, deleteEntry, handleSaved };
}
