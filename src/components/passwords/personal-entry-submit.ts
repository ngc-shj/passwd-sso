import { toast } from "sonner";
import { savePersonalEntry } from "@/lib/personal-entry-save";
import { handlePersonalSaveFeedback } from "@/components/passwords/personal-save-feedback";
import type { EntryTypeValue } from "@/lib/constants";
import type { PasswordFormTranslator } from "@/lib/translation-types";

interface RouterLike {
  push: (href: string) => void;
  refresh: () => void;
}

interface ExecutePersonalEntrySubmitArgs {
  mode: "create" | "edit";
  initialId?: string;
  encryptionKey: CryptoKey;
  userId?: string;
  fullBlob: string;
  overviewBlob: string;
  tagIds: string[];
  entryType?: EntryTypeValue;
  requireReprompt?: boolean;
  folderId?: string | null;
  setSubmitting: (value: boolean) => void;
  t: PasswordFormTranslator;
  router: RouterLike;
  onSaved?: () => void;
}

export async function executePersonalEntrySubmit({
  mode,
  initialId,
  encryptionKey,
  userId,
  fullBlob,
  overviewBlob,
  tagIds,
  entryType,
  requireReprompt,
  folderId,
  setSubmitting,
  t,
  router,
  onSaved,
}: ExecutePersonalEntrySubmitArgs): Promise<void> {
  setSubmitting(true);

  try {
    const res = await savePersonalEntry({
      mode,
      initialId,
      encryptionKey,
      userId,
      fullBlob,
      overviewBlob,
      tagIds,
      entryType,
      requireReprompt,
      folderId,
    });
    handlePersonalSaveFeedback({ res, mode, t, router, onSaved });
  } catch {
    toast.error(t("networkError"));
  } finally {
    setSubmitting(false);
  }
}
